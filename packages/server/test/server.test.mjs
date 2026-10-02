// Tests for @parlox/server, run against the built package (dist/), the way a merchant's app loads it.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createRequire } from "node:module";
import { createParlox as createCore } from "../dist/esm/index.js";
import { withParlox as nextAdapter } from "../dist/esm/next.js";
import { parlox as expressAdapter } from "../dist/esm/express.js";
import { parloxFetch as fetchAdapter } from "../dist/esm/fetch.js";
import { checkLogLines, tracked } from "../test-support/log-lines.mjs";

// The SDK says an empty secretKey, and a key Parlox refuses, once per instance in the server's log (warnings.test.mjs
// checks those lines); these tests give an empty key on purpose, so the lines are recorded instead of printed, and the
// last test checks them: each one the SDK means to write, at most once per instance (test-support/log-lines.mjs).
const createParlox = tracked(createCore);
const withParlox = tracked(nextAdapter, 1);
const expressParlox = tracked(expressAdapter);
const parloxFetch = tracked(fetchAdapter);

// A stand-in gateway that records what it receives. `hang` makes it never answer (for timeout tests).
let gateway, endpoint, received = [], hang = false;
before(async () => {
  gateway = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      received.push({ path: req.url, auth: req.headers.authorization, body: body ? JSON.parse(body) : null });
      if (hang) return; // never answers
      res.writeHead(200, { "content-type": "application/json" }).end('{"accepted":1}');
    });
  });
  await new Promise((r) => gateway.listen(0, "127.0.0.1", r));
  endpoint = `http://127.0.0.1:${gateway.address().port}`;
});
after(() => { gateway.closeAllConnections?.(); gateway.close(); });
const reset = () => { received = []; hang = false; };

const SECRET = "sk_" + "a".repeat(64);
const HUMAN = { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36", "sec-fetch-mode": "navigate", "accept-language": "en-US" };
const CHATGPT = { "user-agent": "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot", accept: "text/html" };
const req = (headers, over = {}) => ({ method: "GET", path: "/products/tent", host: "shop.example.com", header: (n) => headers[n.toLowerCase()] ?? null, ...over });

test("people are never reported; automated page requests are", () => {
  const p = createParlox({ secretKey: SECRET, endpoint, ipHeader: null });
  assert.equal(p.shouldReport(req(HUMAN)), false);
  assert.equal(p.shouldReport(req(CHATGPT)), true);
  assert.equal(p.shouldReport(req({ "user-agent": "curl/8.4.0" })), true);
  assert.equal(p.shouldReport(req({})), true, "no user agent at all is automated");
});

test("assets, non-GET, Parlox's own checker and the verify path are skipped", () => {
  const p = createParlox({ secretKey: SECRET, endpoint, ipHeader: null });
  assert.equal(p.shouldReport(req(CHATGPT, { path: "/logo.png" })), false);
  assert.equal(p.shouldReport(req(CHATGPT, { path: "/_next/static/chunk.js" })), false);
  assert.equal(p.shouldReport(req(CHATGPT, { method: "POST" })), false);
  assert.equal(p.shouldReport(req({ ...CHATGPT, "x-parlox-audit": "1" })), false);
  assert.equal(p.shouldReport(req(CHATGPT, { path: "/.well-known/parlox-verify" })), false);
});

test("without a secret key nothing is sent and the app is told once", async () => {
  reset();
  const errors = [];
  const p = createParlox({ secretKey: undefined, endpoint, ipHeader: null, onError: (e) => errors.push(e) });
  assert.equal(p.shouldReport(req(CHATGPT)), false);
  await p.report(req(CHATGPT));
  const r = await p.purchase({ order_id: "1", value_cents: 100, currency: "USD" });
  assert.equal(r.ok, false);
  assert.equal(received.length, 0);
});

test("a report carries the bearer key and the request's shape, never a person's address", async () => {
  reset();
  const p = createParlox({ secretKey: SECRET, endpoint, ipHeader: "cf-connecting-ip" });
  await p.report({ ...req({ ...CHATGPT, "cf-connecting-ip": "20.171.207.1", "x-forwarded-for": "6.6.6.6" }), clientIp: "20.171.207.1", status: 200 });
  assert.equal(received.length, 1);
  const { auth, body, path } = received[0];
  assert.equal(path, "/v1/s");
  assert.equal(auth, `Bearer ${SECRET}`);
  const e = body.events[0];
  assert.equal(e.path, "/products/tent");
  assert.equal(e.status, 200);
  assert.equal(e.ip, "20.171.207.1", "a self-declared bot's address is sent for range verification");
  assert.match(e.ip_hash, /^[a-f0-9]{64}$/);
  assert.equal(e.host, "shop.example.com");

  reset();
  // Automated by headers (no sec-fetch-mode) but the UA does not declare a bot: the address stays on the server.
  await p.report({ ...req({ "user-agent": "Mozilla/5.0 Chrome/140", "accept-language": "en" }), clientIp: "1.2.3.4" });
  assert.equal(received[0].body.events[0].ip, undefined);
});

test("reports give up after the timeout and never reject", async () => {
  reset(); hang = true;
  const errors = [];
  const p = createParlox({ secretKey: SECRET, endpoint, ipHeader: null, timeoutMs: 300, onError: (e) => errors.push(e) });
  const t0 = Date.now();
  await p.report(req(CHATGPT));
  const ms = Date.now() - t0;
  assert.ok(ms < 1500, `took ${ms} ms`);
  assert.equal(errors.length, 1);
  hang = false;
});

test("an unreachable gateway is an error passed to onError, not an exception", async () => {
  const errors = [];
  const p = createParlox({ secretKey: SECRET, endpoint: "http://127.0.0.1:1", ipHeader: null, onError: (e) => errors.push(e) });
  await p.report(req(CHATGPT));
  assert.equal(errors.length, 1);
});

test("the client address comes only from the configured header", () => {
  const onVercel = (() => { process.env.VERCEL = "1"; try { return createParlox({ secretKey: SECRET, endpoint }); } finally { delete process.env.VERCEL; } })();
  assert.equal(onVercel.ipHeader, "x-real-ip");
  assert.equal(createParlox({ secretKey: SECRET, endpoint }).ipHeader, null, "no platform, no configuration: no address");
  assert.equal(createParlox({ secretKey: SECRET, endpoint, ipHeader: "CF-Connecting-IP" }).ipHeader, "cf-connecting-ip");
});

test("purchase validates the order and posts it as a server-confirmed purchase", async () => {
  reset();
  const errors = [];
  const p = createParlox({ secretKey: SECRET, endpoint, ipHeader: null, onError: (e) => errors.push(e) });
  assert.equal((await p.purchase({ order_id: "1001", value_cents: 49.9, currency: "USD" })).ok, false, "fractional cents are refused");
  assert.equal((await p.purchase({ order_id: "1001", value_cents: 4990, currency: "usd" })).ok, false, "currency must be ISO upper case");
  assert.equal(received.length, 0);
  const r = await p.purchase({ sid: "0123456789abcdef01234567", order_id: "1001", value_cents: 4990, currency: "USD", items: 2 });
  assert.equal(r.ok, true);
  assert.deepEqual(received[0].body.events[0], { event: "purchase", sid: "0123456789abcdef01234567", order_id: "1001", value_cents: 4990, currency: "USD", items: 2 });
  reset();
  await p.purchase({ sid: "not-a-session", order_id: "1002", value_cents: 100, currency: "EUR" });
  assert.equal(received[0].body.events[0].sid, undefined, "a malformed session id is dropped, the order still posts");
});

// ── Next.js adapter ──
const nextReq = (headers, path = "/products/tent", method = "GET") => ({ method, headers: new Headers(headers), nextUrl: { pathname: path, hostname: "shop.example.com" } });

test("next: answers the ownership check, reports through waitUntil, and returns the wrapped middleware's result", async () => {
  reset();
  const waited = [];
  const event = { waitUntil: (p) => waited.push(p) };
  const inner = () => "inner-result";
  const mw = withParlox(inner, { secretKey: SECRET, verifyToken: "tok_123", endpoint, ipHeader: null });

  const verify = mw(nextReq(HUMAN, "/.well-known/parlox-verify"), event);
  assert.ok(verify instanceof Response);
  assert.equal(await verify.text(), "tok_123");

  assert.equal(mw(nextReq(HUMAN), event), "inner-result");
  assert.equal(waited.length, 0, "a person's request schedules nothing");

  assert.equal(mw(nextReq(CHATGPT), event), "inner-result");
  assert.equal(waited.length, 1);
  await Promise.all(waited);
  assert.equal(received.length, 1);
});

test("next: a Parlox failure never breaks the site", () => {
  const mw = withParlox(() => "ok", { secretKey: SECRET, endpoint, clientIp: () => { throw new Error("boom"); } });
  assert.equal(mw(nextReq(CHATGPT), { waitUntil() {} }), "ok");
});

// ── Express / Connect adapter, over a real HTTP server ──
test("express: reports after the response finishes, answers the verify path, leaves people alone", async () => {
  reset();
  const mw = expressParlox({ secretKey: SECRET, verifyToken: "tok_abc", endpoint, ipHeader: "x-real-ip", flushAt: 1 });
  const app = http.createServer((rq, rs) => mw(rq, rs, () => { rs.statusCode = 200; rs.end("<html>page</html>"); }));
  await new Promise((r) => app.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${app.address().port}`;
  try {
    const v = await fetch(`${base}/.well-known/parlox-verify`, { headers: HUMAN });
    assert.equal(await v.text(), "tok_abc");

    await (await fetch(`${base}/products/tent`, { headers: HUMAN })).text();
    await (await fetch(`${base}/products/tent?x=1`, { headers: { ...CHATGPT, "x-real-ip": "20.171.207.1", "x-forwarded-for": "9.9.9.9" } })).text();
    for (let i = 0; i < 50 && received.length < 1; i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(received.length, 1, "only the bot's request was reported");
    const e = received[0].body.events[0];
    assert.equal(e.path, "/products/tent", "path without the query string");
    assert.equal(e.status, 200);
    assert.equal(e.ip, "20.171.207.1", "from the configured header, not X-Forwarded-For");
  } finally { app.closeAllConnections?.(); app.close(); }
});

// ── Web-standard adapter ──
test("fetch: handle answers the verify path; observe reports bots through waitUntil", async () => {
  reset();
  const p = parloxFetch({ secretKey: SECRET, verifyToken: "tok_w", endpoint, ipHeader: null });
  const early = p.handle(new Request("https://shop.example.com/.well-known/parlox-verify"));
  assert.equal(await early.text(), "tok_w");
  assert.equal(p.handle(new Request("https://shop.example.com/")), null);
  const waited = [];
  p.observe(new Request("https://shop.example.com/", { headers: HUMAN }), 200, (x) => waited.push(x));
  p.observe(new Request("https://shop.example.com/p/1", { headers: CHATGPT }), 200, (x) => waited.push(x));
  assert.equal(waited.length, 1);
  await Promise.all(waited);
  assert.equal(received[0].body.events[0].path, "/p/1");
});

// ── CommonJS ──
test("the CommonJS build loads with require()", () => {
  const require = createRequire(import.meta.url);
  const core = require("../dist/cjs/index.cjs");
  const ex = require("../dist/cjs/express.cjs");
  const nx = require("../dist/cjs/next.cjs");
  const fx = require("../dist/cjs/fetch.cjs");
  assert.equal(typeof core.createParlox, "function");
  assert.equal(typeof ex.parlox, "function");
  assert.equal(typeof nx.withParlox, "function");
  assert.equal(typeof fx.parloxFetch, "function");
});

test("what agents read is reported: robots.txt, llms.txt, sitemaps, product JSON; API routes only when asked", () => {
  const p = createParlox({ secretKey: SECRET, endpoint, ipHeader: null });
  for (const path of ["/robots.txt", "/llms.txt", "/sitemap.xml", "/products/tent.json"]) {
    assert.equal(p.shouldReport(req(CHATGPT, { path })), true, path);
  }
  assert.equal(p.shouldReport(req({ "user-agent": "UptimeRobot/2.0" }, { path: "/api/health" })), false, "monitors on API routes are not visits");
  assert.equal(createParlox({ secretKey: SECRET, endpoint, ipHeader: null, includeApi: true }).shouldReport(req(CHATGPT, { path: "/api/search" })), true);
  for (const path of ["/_next/image", "/fonts/a.woff2", "/logo.svg"]) assert.equal(p.shouldReport(req(CHATGPT, { path })), false, path);
});

test("without a trusted address, different clients still get different grouping hashes (the address itself is never sent)", async () => {
  reset();
  const p = createParlox({ secretKey: SECRET, endpoint, ipHeader: null });
  await p.report({ ...req({ "user-agent": "curl/8" }), groupingAddress: "203.0.113.1" });
  await p.report({ ...req({ "user-agent": "curl/8" }), groupingAddress: "203.0.113.2" });
  const [a, b] = received.map((r) => r.body.events[0]);
  assert.notEqual(a.ip_hash, b.ip_hash);
  assert.equal(a.ip, undefined);
  assert.ok(!JSON.stringify(received).includes("203.0.113"));
});

test("next: a wrapped middleware is never skipped by default (auth keeps guarding dotted routes); runWrapped can narrow it", async () => {
  reset();
  const seen = [];
  const auth = (r) => { seen.push(r.nextUrl.pathname); return "wrapped"; };
  const mw = withParlox(auth, { secretKey: SECRET, endpoint, ipHeader: null });
  const waited = [];
  const ev = { waitUntil: (p) => waited.push(p) };
  assert.equal(mw(nextReq(CHATGPT, "/users/john.doe"), ev), "wrapped");
  assert.equal(mw(nextReq(CHATGPT, "/admin/export.csv"), ev), "wrapped");
  const narrowed = withParlox(auth, { secretKey: SECRET, endpoint, ipHeader: null, runWrapped: (p) => !/.(txt|xml)$/.test(p) });
  assert.equal(narrowed(nextReq(CHATGPT, "/robots.txt"), ev), undefined);
  assert.equal(narrowed(nextReq(CHATGPT, "/products/tent"), ev), "wrapped");
  assert.deepEqual(seen, ["/users/john.doe", "/admin/export.csv", "/products/tent"]);
  await Promise.all(waited);
  assert.deepEqual(received.map((r) => r.body.events[0].path).sort(), ["/admin/export.csv", "/products/tent", "/robots.txt", "/users/john.doe"]);
});

// Last, after every test above: what the SDK wrote to the log while they ran.
test("the log lines these tests provoked are the SDK's own, each said at most once per instance", () => {
  checkLogLines();
});
