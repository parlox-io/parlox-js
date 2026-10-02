// Defaults that depend on the platform or guard a bound: the client-address header on Cloudflare Workers, and
// timeoutMs. Run against the built package (dist/), the way a merchant's server loads it.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { Hono } from "hono";
import { createParlox } from "../dist/esm/index.js";
import { parlox as honoParlox } from "../dist/esm/hono.js";
import { parloxFetch } from "../dist/esm/fetch.js";

// A stand-in gateway that records each body and answers after `delayMs`.
let server, endpoint, received = [], delayMs = 0;
before(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      received.push(JSON.parse(body));
      setTimeout(() => res.writeHead(200, { "content-type": "application/json" }).end('{"accepted":1}'), delayMs);
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  endpoint = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.closeAllConnections?.(); server.close(); });

const SECRET = "sk_" + "d".repeat(64);
const CHATGPT = { "user-agent": "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot", accept: "text/html" };

/** Runs `fn` with these environment variables set (undefined: unset), then puts them back as they were. */
async function withEnv(vars, fn) {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { return await fn(); }
  finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
}
/** Runs `fn` with globalThis[name] replaced, as the Workers runtime defines navigator.userAgent. */
async function withGlobal(name, value, fn) {
  const saved = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  try { return await fn(); }
  finally { if (saved) Object.defineProperty(globalThis, name, saved); else delete globalThis[name]; }
}
const onWorkers = (fn) => withGlobal("navigator", { userAgent: "Cloudflare-Workers" }, fn);
const NO_PLATFORM = { PARLOX_IP_HEADER: undefined, VERCEL: undefined };

// ── The client address on Cloudflare Workers ──
// cf-connecting-ip is Cloudflare's own header only on Cloudflare's runtime, which gives each incoming request a `cf`
// object. Self-hosted workerd answers navigator.userAgent "Cloudflare-Workers" too, but its requests carry no `cf`, and
// there the header is whatever the client sent.

/** A bot's request for /p/1 with both address headers, carrying `cf` as Cloudflare's runtime gives it (absent: none). */
function botRequest(cf) {
  const r = new Request("https://shop.example.com/p/1", { headers: { ...CHATGPT, "cf-connecting-ip": "203.0.113.7", "x-client-ip": "198.51.100.9" } });
  if (cf !== undefined) Object.defineProperty(r, "cf", { value: cf, enumerable: true });
  return r;
}
const CF = { colo: "AMS", country: "NL", asn: 64496 };
/** The address a report carried (undefined: none), for one request through `run`, which hands its report to waitUntil. */
async function sentIp(run) {
  received = [];
  const waited = [];
  await run((p) => waited.push(p));
  await Promise.all(waited);
  assert.equal(received.length, 1, "one report");
  return received[0].events[0].ip;
}

test("createParlox names no client-address header on Workers by default (the request tells Cloudflare's runtime apart, not the user agent); ipHeader and PARLOX_IP_HEADER still win", async () => {
  await withEnv(NO_PLATFORM, async () => {
    await onWorkers(async () => {
      assert.equal(createParlox({ secretKey: SECRET }).ipHeader, null);
      assert.equal(createParlox({ secretKey: SECRET, ipHeader: "X-Real-IP" }).ipHeader, "x-real-ip");
      assert.equal(createParlox({ secretKey: SECRET, ipHeader: null }).ipHeader, null, "null still turns it off");
      await withEnv({ PARLOX_IP_HEADER: "x-client-ip" }, async () => {
        assert.equal(createParlox({ secretKey: SECRET }).ipHeader, "x-client-ip");
      });
    });
    assert.equal(createParlox({ secretKey: SECRET }).ipHeader, null);
  });
});

test("hono: cf-connecting-ip only for a request that carries Cloudflare's cf object; self-hosted workerd (the same user agent, no cf) sends no address; an explicit ipHeader or PARLOX_IP_HEADER still wins", async () => {
  await withEnv(NO_PLATFORM, async () => {
    await onWorkers(async () => {
      const send = (cf, env, options = {}) => sentIp(async (waitUntil) => {
        const app = new Hono().use(honoParlox({ endpoint, ...options }));
        app.get("/p/:id", (c) => c.text("product"));
        await app.fetch(botRequest(cf), env, { waitUntil, passThroughOnException() {}, props: {} });
      });
      const key = { PARLOX_SECRET_KEY: SECRET };
      assert.equal(await send(CF, key), "203.0.113.7", "Cloudflare's runtime");
      assert.equal(await send(undefined, key), undefined, "self-hosted workerd: no cf");
      for (const notAnObject of [null, "AMS", 1]) assert.equal(await send(notAnObject, key), undefined, JSON.stringify(notAnObject));
      assert.equal(await send(CF, { ...key, PARLOX_IP_HEADER: "x-client-ip" }), "198.51.100.9", "a binding names another header");
      assert.equal(await send(CF, key, { ipHeader: "X-Client-IP" }), "198.51.100.9", "the option names another header");
      assert.equal(await send(CF, key, { ipHeader: null }), undefined, "null turns it off");
      assert.equal(await send(undefined, key, { ipHeader: "cf-connecting-ip" }), "203.0.113.7", "named explicitly, it is read without cf");
      await withEnv({ PARLOX_IP_HEADER: "x-client-ip" }, async () => {
        assert.equal(await send(CF, key), "198.51.100.9", "PARLOX_IP_HEADER in process.env");
      });
    });
  });
});

test("fetch: the same rule for parloxFetch, from the Request it is given", async () => {
  await withEnv(NO_PLATFORM, async () => {
    await onWorkers(async () => {
      const send = (cf, options = {}) => sentIp(async (waitUntil) => parloxFetch({ secretKey: SECRET, endpoint, ...options }).observe(botRequest(cf), 200, waitUntil));
      assert.equal(await send(CF), "203.0.113.7");
      assert.equal(await send(undefined), undefined);
      assert.equal(await send(CF, { ipHeader: null }), undefined);
      assert.equal(await send(CF, { ipHeader: "x-client-ip" }), "198.51.100.9");
    });
  });
});

// ── timeoutMs ──

test("timeoutMs: 0, a negative number, NaN, Infinity or one past the timer limit falls back to the default; purchases and reports still go", async () => {
  delayMs = 50;
  try {
    for (const timeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1e12]) {
      received = [];
      const errors = [];
      const p = createParlox({ secretKey: SECRET, endpoint, ipHeader: null, timeoutMs, onError: (e) => errors.push(e) });
      assert.deepEqual(await p.purchase({ order_id: "1001", value_cents: 100, currency: "USD" }), { ok: true, status: 200 }, String(timeoutMs));
      await p.report({ method: "GET", path: "/p/1", host: "shop.example.com", header: (n) => (n === "user-agent" ? "curl/8" : null) });
      assert.equal(received.length, 2, String(timeoutMs));
      assert.deepEqual(errors, [], String(timeoutMs));
    }
  } finally { delayMs = 0; }
});
