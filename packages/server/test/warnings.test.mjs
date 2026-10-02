// What the SDK says in the server's log by itself, once per instance: a secretKey given empty (it never falls back to
// PARLOX_SECRET_KEY), and the first order or crawler report Parlox refuses with 401 or 403. Run against the built
// package (dist/), the way a merchant's server loads it.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { Hono } from "hono";
import { createParlox } from "../dist/esm/index.js";
import { parlox as honoParlox } from "../dist/esm/hono.js";

// A stand-in gateway. Each request gets the next scripted answer ({ status, body }), else 200 {"accepted":1}.
let server, endpoint, answers = [], arrived = [];
before(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      arrived.push({ auth: req.headers.authorization, body: JSON.parse(body) });
      const a = answers.shift() ?? { status: 200, body: '{"accepted":1}' };
      res.writeHead(a.status, { "content-type": "application/json" }).end(a.body);
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  endpoint = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.closeAllConnections?.(); server.close(); });
const reset = () => { answers = []; arrived = []; };

const SECRET = "sk_" + "e".repeat(64);
const ORDER = { order_id: "1001", value_cents: 4990, currency: "USD" };
const BOT = { method: "GET", path: "/p/1", host: "shop.example.com", header: (n) => (n === "user-agent" ? "curl/8" : null) };
const EMPTY = "secretKey was given but is empty: set PARLOX_ORDERS_KEY (or the variable you pass) — Parlox did not fall back to PARLOX_SECRET_KEY";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, what, ms = 5000) { const end = Date.now() + ms; while (!check()) { if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await wait(5); } }
const warnings = (warn) => warn.mock.calls.map((c) => c.arguments.map(String).join(" "));
const messages = (errors) => errors.map((e) => (e instanceof Error ? e.message : String(e)));

/** Runs `fn` with these environment variables set (undefined: unset), then puts them back as they were. */
async function withEnv(vars, fn) {
  const before = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { return await fn(); }
  finally { for (const [k, v] of Object.entries(before)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
}

// ── An explicit secretKey ──

test("an explicit secretKey that is unset or empty is used alone: it never falls back to PARLOX_SECRET_KEY, says so once, and sends nothing", async (t) => {
  await withEnv({ PARLOX_SECRET_KEY: SECRET, PARLOX_ORDERS_KEY: undefined }, async () => {
    for (const given of [process.env.PARLOX_ORDERS_KEY, "", "  "]) {
      reset();
      const warn = t.mock.method(console, "warn", () => {});
      const errors = [];
      const orders = createParlox({ secretKey: given, endpoint, onError: (e) => errors.push(e) });
      assert.equal(orders.shouldReport(BOT), false, JSON.stringify(given));
      assert.deepEqual(await orders.purchase(ORDER), { ok: false, status: 0 });
      assert.deepEqual(await orders.purchase(ORDER), { ok: false, status: 0 });
      orders.enqueue(BOT);
      await orders.report(BOT);
      await orders.flush();
      assert.deepEqual(arrived, [], "nothing is sent, with either key");
      assert.deepEqual(warnings(warn), [`@parlox/server: ${EMPTY}`], "said once");
      assert.deepEqual(messages(errors), [EMPTY], "onError is told once too, in the same words");
      warn.mock.restore();
    }
  });
});

test("without a secretKey option, PARLOX_SECRET_KEY is read as before, with no warning", async (t) => {
  await withEnv({ PARLOX_SECRET_KEY: SECRET }, async () => {
    reset();
    const warn = t.mock.method(console, "warn", () => {});
    const p = createParlox({ endpoint });
    assert.deepEqual(await p.purchase(ORDER), { ok: true, status: 200 });
    assert.equal(arrived[0].auth, `Bearer ${SECRET}`);
    assert.deepEqual(warnings(warn), []);
  });
});

test("hono: an explicit secretKey wins over the Worker's binding even when it is empty; without one the binding, then process.env, is read", async (t) => {
  const CHATGPT = { "user-agent": "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot", accept: "text/html" };
  const OTHER = "sk_" + "f".repeat(64);
  const run = async (options, env) => {
    reset();
    const waited = [];
    const ctx = { waitUntil: (p) => waited.push(p), passThroughOnException() {}, props: {} };
    const app = new Hono().use(honoParlox({ endpoint, ipHeader: null, flushAt: 1, ...options }));
    app.get("/p/:id", (c) => c.text("product"));
    assert.equal(await (await app.request("/p/1", { headers: CHATGPT }, env, env ? ctx : undefined)).text(), "product");
    await Promise.all(waited);
    await app.request("/p/2", { headers: CHATGPT }, env, env ? ctx : undefined);
    await Promise.all(waited);
    return arrived.map((a) => a.auth);
  };
  t.mock.method(console, "warn", () => {});
  await withEnv({ PARLOX_SECRET_KEY: OTHER, PARLOX_ORDERS_KEY: undefined }, async () => {
    assert.deepEqual(await run({ secretKey: process.env.PARLOX_ORDERS_KEY }, { PARLOX_SECRET_KEY: SECRET }), [], "not the binding, not process.env");
    assert.deepEqual(await run({}, { PARLOX_SECRET_KEY: SECRET }), [`Bearer ${SECRET}`, `Bearer ${SECRET}`], "the binding");
    // On Node (no bindings, no execution context) the report waits in the queue, sent with process.env's key.
    reset();
    const app = new Hono().use(honoParlox({ endpoint, ipHeader: null, flushAt: 1 }));
    app.get("/p/:id", (c) => c.text("product"));
    await app.request("/p/3", { headers: CHATGPT });
    await until(() => arrived.length === 1, "the queued report");
    assert.equal(arrived[0].auth, `Bearer ${OTHER}`);
  });
});

// ── Refusals said in the log ──

test("purchase(): the first 401 or 403 is said once in the log with Parlox's reason, never the key; onError still gets every one", async (t) => {
  for (const status of [401, 403]) {
    reset();
    const warn = t.mock.method(console, "warn", () => {});
    const errors = [];
    const orders = createParlox({ secretKey: SECRET, endpoint, ipHeader: null, onError: (e) => errors.push(e) });
    const reason = `Invalid secret key ${SECRET}`;
    answers = [{ status, body: JSON.stringify({ error: reason }) }, { status, body: JSON.stringify({ error: reason }) }];
    assert.deepEqual(await orders.purchase(ORDER), { ok: false, status });
    assert.deepEqual(await orders.purchase(ORDER), { ok: false, status });
    const said = warnings(warn);
    assert.equal(said.length, 1, said.join("\n"));
    assert.match(said[0], new RegExp(`^@parlox/server: Parlox refused the order \\(HTTP ${status}\\): Invalid secret key \\[key\\]`));
    assert.equal(said[0].includes(SECRET.slice(3, 20)), false, "no part of the key");
    assert.deepEqual(messages(errors), [`Parlox refused the order (HTTP ${status}): Invalid secret key [key]`, `Parlox refused the order (HTTP ${status}): Invalid secret key [key]`]);
    warn.mock.restore();
  }
});

test("purchase(): other failures are not said in the log (onError has them)", async (t) => {
  reset();
  const warn = t.mock.method(console, "warn", () => {});
  answers = [{ status: 500, body: "{}" }, { status: 429, body: "{}" }];
  const errors = [];
  const orders = createParlox({ secretKey: SECRET, endpoint, ipHeader: null, onError: (e) => errors.push(e) });
  await orders.purchase(ORDER);
  await orders.purchase(ORDER);
  assert.deepEqual(warnings(warn), []);
  assert.equal(errors.length, 2);
});

test("crawler reports refused with 401 or 403: one line in the log per instance, never per request; onError keeps the short message", async (t) => {
  reset();
  const warn = t.mock.method(console, "warn", () => {});
  const refusal = { status: 401, body: JSON.stringify({ error: `Invalid secret key ${SECRET}` }) };
  answers = [refusal, refusal, refusal];
  const errors = [];
  const p = createParlox({ secretKey: SECRET, endpoint, ipHeader: null, onError: (e) => errors.push(e) });
  for (let i = 0; i < 3; i++) await p.report(BOT);
  const said = warnings(warn);
  assert.equal(said.length, 1, said.join("\n"));
  assert.match(said[0], /^@parlox\/server: Parlox refused a crawler report \(HTTP 401\): Invalid secret key \[key\]/);
  assert.equal(said[0].includes(SECRET.slice(3, 20)), false, "no part of the key");
  assert.deepEqual(messages(errors), ["Parlox answered HTTP 401", "Parlox answered HTTP 401", "Parlox answered HTTP 401"]);
  // A batch from the queue is a crawler report too: the same instance says nothing more.
  answers = [{ status: 403, body: JSON.stringify({ error: "Refused" }) }];
  p.enqueue(BOT);
  await p.flush();
  assert.equal(warnings(warn).length, 1);
  // Another instance says it once for itself.
  answers = [{ status: 403, body: JSON.stringify({ error: "Refused" }) }];
  const q = createParlox({ secretKey: SECRET, endpoint, ipHeader: null, flushAt: 1 });
  q.enqueue(BOT);
  await q.flush();
  assert.deepEqual(warnings(warn).slice(1), ["@parlox/server: Parlox refused a crawler report (HTTP 403): Refused (said once per instance; onError receives every refusal)"]);
});
