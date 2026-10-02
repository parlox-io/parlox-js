// The Hono and Vercel Routing Middleware adapters, against the built package, with a real Hono app.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createRequire } from "node:module";
import { Hono } from "hono";
import { parlox as honoParlox } from "../dist/esm/hono.js";
import { withParlox as vercelMiddleware } from "../dist/esm/vercel.js";

let gateway, endpoint, received = [];
before(async () => {
  gateway = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => { received.push({ auth: req.headers.authorization, ...JSON.parse(body) }); res.writeHead(200, { "content-type": "application/json" }).end("{}"); });
  });
  await new Promise((r) => gateway.listen(0, "127.0.0.1", r));
  endpoint = `http://127.0.0.1:${gateway.address().port}`;
});
after(() => { gateway.closeAllConnections?.(); gateway.close(); });
const reset = () => { received = []; };
// Paths received, so a late report from an earlier test is never counted by a later one.
const paths = () => received.flatMap((r) => r.events.map((e) => e.path));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, what, ms = 5000) { const end = Date.now() + ms; while (!check()) { if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await wait(5); } }

const SECRET = "sk_" + "b".repeat(64);
const HUMAN = { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36", "sec-fetch-mode": "navigate", "accept-language": "en-US" };
const CHATGPT = { "user-agent": "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot", accept: "text/html" };
const shop = (app) => { app.onError((_e, c) => c.text("app error", 500)); app.get("/", (c) => c.text("home")); app.get("/p/:id", (c) => c.text("product")); return app; };

// ── Hono ──
test("hono on Node: no execution context and no crash; the ownership check is answered; a bot goes through the queue", async () => {
  reset();
  const app = new Hono();
  app.use(honoParlox({ secretKey: SECRET, verifyToken: "tok_h", endpoint, ipHeader: null, flushAt: 1 }));
  shop(app);
  assert.equal(await (await app.request("/.well-known/parlox-verify")).text(), "tok_h");
  assert.equal(await (await app.request("/.well-known/parlox-verify", { method: "HEAD" })).text(), "");
  assert.equal((await app.request("/.well-known/parlox-verify", { method: "POST" })).status, 404, "only GET and HEAD are answered");
  assert.equal(await (await app.request("/", { headers: HUMAN })).text(), "home");
  assert.equal(await (await app.request("/p/1", { headers: CHATGPT })).text(), "product");
  await until(() => received.length === 1, "the queued report");
  assert.equal(received[0].events.length, 1);
  assert.equal(received[0].events[0].path, "/p/1");
  assert.equal(received[0].events[0].status, 200);
});

test("hono on Workers: the variables come from c.env and the report goes to executionCtx.waitUntil", async () => {
  reset();
  const app = shop(new Hono().use(honoParlox({ endpoint, ipHeader: null })));
  const env = { PARLOX_SECRET_KEY: SECRET, PARLOX_VERIFY_TOKEN: "tok_env", DB: {} };
  const waited = [];
  const ctx = { waitUntil: (p) => waited.push(p), passThroughOnException() {}, props: {} };
  assert.equal(await (await app.request("/.well-known/parlox-verify", {}, env, ctx)).text(), "tok_env");
  assert.equal(await (await app.request("/p/2", { headers: CHATGPT }, env, ctx)).text(), "product");
  assert.equal(waited.length, 1);
  await Promise.all(waited);
  assert.equal(received.length, 1);
  assert.equal(received[0].auth, `Bearer ${SECRET}`);
});

test("hono on Vercel (no execution context): the report goes to Vercel's request context", async () => {
  reset();
  const waited = [];
  const key = Symbol.for("@vercel/request-context");
  globalThis[key] = { get: () => ({ waitUntil: (p) => waited.push(p) }) };
  try {
    const app = shop(new Hono().use(honoParlox({ secretKey: SECRET, endpoint, ipHeader: null })));
    await app.request("/p/3", { headers: CHATGPT });
    assert.equal(waited.length, 1);
    await Promise.all(waited);
    assert.equal(received.length, 1);
  } finally { delete globalThis[key]; }
});

test("hono: a Parlox failure never breaks the app; an app error is not swallowed, and is reported with its status", async () => {
  const broken = new Hono().use(honoParlox({ secretKey: SECRET, endpoint, clientIp: () => { throw new Error("boom"); } }));
  shop(broken).get("/fail", () => { throw new Error("route failed"); });
  assert.equal(await (await broken.request("/p/4", { headers: CHATGPT })).text(), "product");
  const failedBroken = await broken.request("/fail", { headers: CHATGPT });
  assert.equal(failedBroken.status, 500);
  assert.equal(await failedBroken.text(), "app error");

  reset();
  const app = new Hono().use(honoParlox({ secretKey: SECRET, endpoint, ipHeader: null, flushAt: 1 }));
  shop(app).get("/fail", () => { throw new Error("route failed"); });
  const failed = await app.request("/fail", { headers: CHATGPT });
  assert.equal(failed.status, 500);
  assert.equal(await failed.text(), "app error");
  await until(() => paths().includes("/fail"), "the report of the failed route");
  const reported = received.flatMap((r) => r.events).filter((e) => e.path === "/fail");
  assert.equal(reported.length, 1);
  assert.equal(reported[0].status, 500, "the status Hono's error handler answered with");
});

test("hono: without a key nothing is sent and every request still passes", async () => {
  reset();
  const app = shop(new Hono().use(honoParlox({ endpoint, ipHeader: null, flushAt: 1 })));
  assert.equal(await (await app.request("/p/5", { headers: CHATGPT })).text(), "product");
  assert.equal((await app.request("/.well-known/parlox-verify")).status, 404);
  await wait(50);
  assert.equal(received.length, 0);
});

// ── Vercel Routing Middleware ──
const nextResponse = () => new Response(null, { headers: { "x-middleware-next": "1" } });

test("vercel: answers the ownership check, reports bots through context.waitUntil, and returns next()", async () => {
  reset();
  const mw = vercelMiddleware({ next: nextResponse, secretKey: SECRET, verifyToken: "tok_v", endpoint, ipHeader: null });
  const waited = [];
  const ctx = { waitUntil: (p) => waited.push(p) };
  assert.equal(await mw(new Request("https://shop.example.com/.well-known/parlox-verify"), ctx).text(), "tok_v");
  assert.equal(mw(new Request("https://shop.example.com/", { headers: HUMAN }), ctx).headers.get("x-middleware-next"), "1");
  assert.equal(waited.length, 0, "a person's request schedules nothing");
  assert.equal(mw(new Request("https://shop.example.com/p/1", { headers: CHATGPT }), ctx).headers.get("x-middleware-next"), "1");
  assert.equal(waited.length, 1);
  await Promise.all(waited);
  assert.equal(received[0].events[0].path, "/p/1");
});

test("vercel: an existing middleware is wrapped: it runs, and its response is returned", async () => {
  const seen = [];
  const existing = (request, context) => { seen.push([new URL(request.url).pathname, typeof context.waitUntil]); return new Response("from existing", { status: 401 }); };
  const mw = vercelMiddleware(existing, { next: nextResponse, secretKey: SECRET, verifyToken: "tok_v", endpoint, ipHeader: null });
  const ctx = { waitUntil: () => {} };
  const r = mw(new Request("https://shop.example.com/admin", { headers: CHATGPT }), ctx);
  assert.equal(r.status, 401);
  assert.equal(await r.text(), "from existing");
  assert.deepEqual(seen, [["/admin", "function"]]);
  assert.equal(await mw(new Request("https://shop.example.com/.well-known/parlox-verify"), ctx).text(), "tok_v", "the ownership check is answered before the wrapped middleware");
  assert.equal(seen.length, 1);
});

test("vercel: a wrapped middleware's own error propagates (Parlox does not hide it); the report was already handed off", async () => {
  const waited = [];
  const ctx = { waitUntil: (p) => waited.push(p) };
  const mw = vercelMiddleware(() => { throw new Error("auth down"); }, { next: nextResponse, secretKey: SECRET, endpoint, ipHeader: null });
  assert.throws(() => mw(new Request("https://shop.example.com/p/10", { headers: CHATGPT }), ctx), /auth down/);
  assert.equal(waited.length, 1);
  const amw = vercelMiddleware(async () => { throw new Error("async auth down"); }, { next: nextResponse, secretKey: SECRET, endpoint, ipHeader: null });
  await assert.rejects(amw(new Request("https://shop.example.com/p/11", { headers: CHATGPT }), ctx), /async auth down/);
  assert.equal(waited.length, 2);
  await Promise.all(waited);
});

test("vercel: the wrapped middleware's Response passes through as the same object (a redirect with its headers)", async () => {
  const waited = [];
  const ctx = { waitUntil: (p) => waited.push(p) };
  const redirect = new Response(null, { status: 307, headers: { location: "https://shop.example.com/login", "cache-control": "no-store", "x-shop": "1" } });
  const mw = vercelMiddleware(() => redirect, { next: nextResponse, secretKey: SECRET, endpoint, ipHeader: null });
  const r = mw(new Request("https://shop.example.com/p/12", { headers: CHATGPT }), ctx);
  assert.equal(r, redirect);
  assert.equal(r.status, 307);
  assert.deepEqual([...r.headers], [["cache-control", "no-store"], ["location", "https://shop.example.com/login"], ["x-shop", "1"]]);
  const pending = Promise.resolve(redirect);
  const amw = vercelMiddleware(() => pending, { next: nextResponse, secretKey: SECRET, endpoint, ipHeader: null });
  assert.equal(amw(new Request("https://shop.example.com/p/13", { headers: CHATGPT }), ctx), pending, "an async middleware's promise is returned as it is");
  await Promise.all(waited);
});

test("vercel: a Parlox failure never breaks the site", () => {
  const mw = vercelMiddleware({ next: nextResponse, secretKey: SECRET, endpoint, clientIp: () => { throw new Error("boom"); } });
  assert.equal(mw(new Request("https://shop.example.com/p/1", { headers: CHATGPT }), { waitUntil() {} }).headers.get("x-middleware-next"), "1");
});

test("the CommonJS builds of the new adapters load with require()", () => {
  const require = createRequire(import.meta.url);
  assert.equal(typeof require("../dist/cjs/hono.cjs").parlox, "function");
  assert.equal(typeof require("../dist/cjs/hono.cjs").parlox.flush, "function");
  assert.equal(typeof require("../dist/cjs/vercel.cjs").withParlox, "function");
});

// ── The details: the order of the variables and of the ways a report outlives the response ──
test("hono: variables come from c.env first, then process.env; options win over both", async () => {
  const saved = process.env.PARLOX_VERIFY_TOKEN;
  process.env.PARLOX_VERIFY_TOKEN = "tok_process";
  try {
    const app = shop(new Hono().use(honoParlox({ endpoint, ipHeader: null })));
    assert.equal(await (await app.request("/.well-known/parlox-verify")).text(), "tok_process", "no binding: process.env");
    assert.equal(await (await app.request("/.well-known/parlox-verify", {}, { PARLOX_VERIFY_TOKEN: "tok_env" })).text(), "tok_env", "a binding wins over process.env");
    const pinned = shop(new Hono().use(honoParlox({ verifyToken: "tok_option", endpoint, ipHeader: null })));
    assert.equal(await (await pinned.request("/.well-known/parlox-verify", {}, { PARLOX_VERIFY_TOKEN: "tok_env" })).text(), "tok_option", "an option wins over a binding");
  } finally {
    if (saved === undefined) delete process.env.PARLOX_VERIFY_TOKEN; else process.env.PARLOX_VERIFY_TOKEN = saved;
  }
});

test("hono: executionCtx.waitUntil is used before Vercel's request context", async () => {
  reset();
  const onVercel = [];
  const key = Symbol.for("@vercel/request-context");
  globalThis[key] = { get: () => ({ waitUntil: (p) => onVercel.push(p) }) };
  try {
    const app = shop(new Hono().use(honoParlox({ secretKey: SECRET, endpoint, ipHeader: null })));
    const waited = [];
    await app.request("/p/6", { headers: CHATGPT }, {}, { waitUntil: (p) => waited.push(p), passThroughOnException() {}, props: {} });
    assert.equal(waited.length, 1);
    assert.equal(onVercel.length, 0);
    await Promise.all(waited);
    assert.deepEqual(paths().filter((x) => x === "/p/6"), ["/p/6"]);
  } finally { delete globalThis[key]; }
});

test("vercel: without a context the report goes to Vercel's request context, and without either it is sent at once", async () => {
  reset();
  const mw = vercelMiddleware({ next: nextResponse, secretKey: SECRET, endpoint, ipHeader: null });
  const waited = [];
  const key = Symbol.for("@vercel/request-context");
  globalThis[key] = { get: () => ({ waitUntil: (p) => waited.push(p) }) };
  try {
    assert.equal(mw(new Request("https://shop.example.com/p/7", { headers: CHATGPT })).headers.get("x-middleware-next"), "1");
    assert.equal(waited.length, 1);
    await Promise.all(waited);
    assert.ok(paths().includes("/p/7"));
  } finally { delete globalThis[key]; }
  assert.equal(mw(new Request("https://shop.example.com/p/8", { headers: CHATGPT })).headers.get("x-middleware-next"), "1");
  await until(() => paths().includes("/p/8"), "the report sent at once");
});

test("vercel: HEAD gets an empty answer, other methods and a missing key go to next(), and nothing is sent without a key", async () => {
  reset();
  const mw = vercelMiddleware({ next: nextResponse, secretKey: SECRET, verifyToken: "tok_v", endpoint, ipHeader: null });
  const head = mw(new Request("https://shop.example.com/.well-known/parlox-verify", { method: "HEAD" }));
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
  assert.equal(mw(new Request("https://shop.example.com/.well-known/parlox-verify", { method: "POST" })).headers.get("x-middleware-next"), "1");
  const keyless = vercelMiddleware({ next: nextResponse, endpoint, ipHeader: null });
  const waited = [];
  assert.equal(keyless(new Request("https://shop.example.com/.well-known/parlox-verify"), { waitUntil: (p) => waited.push(p) }).headers.get("x-middleware-next"), "1");
  assert.equal(keyless(new Request("https://shop.example.com/p/9", { headers: CHATGPT }), { waitUntil: (p) => waited.push(p) }).headers.get("x-middleware-next"), "1");
  assert.equal(waited.length, 0);
  await wait(50);
  assert.ok(!paths().includes("/p/9"));
});
