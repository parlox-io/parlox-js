// The delivery queue, run against the built package (dist/), the way a merchant's server loads it.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { createParlox as createCore } from "../dist/esm/index.js";
import { parlox as expressAdapter } from "../dist/esm/express.js";
import { checkLogLines, tracked } from "../test-support/log-lines.mjs";

// The SDK says an empty secretKey, and a key Parlox refuses, once per instance in the server's log (warnings.test.mjs
// checks those lines); these tests refuse a key on purpose, so the lines are recorded instead of printed, and the last
// test checks them: each one the SDK means to write, at most once per instance (test-support/log-lines.mjs).
const createParlox = tracked(createCore);
const expressParlox = tracked(expressAdapter);

const SECRET = "sk_" + "a".repeat(64);
const BOT = { "user-agent": "curl/8.4.0" };
const bot = (path) => ({ method: "GET", path, host: "shop.example.com", header: (n) => BOT[n.toLowerCase()] ?? null });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, what, ms = 10_000) {
  const end = Date.now() + ms;
  while (!check()) { if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await wait(5); }
}
const listen = (srv, port = 0) => new Promise((r) => srv.listen(port, "127.0.0.1", r));

// A stand-in gateway: records each request's body, arrival time and size, counts how many requests are open at once,
// and answers as scripted: `answers` are the next responses in order ({ status, headers, delayMs }), then `status`.
// The answer is chosen when the request arrives. Like the real gateway (bodyLimit 256 KB), a larger body gets 413.
const BODY_LIMIT = 256 * 1024;
let server, endpoint;
const gw = { bodies: [], times: [], sizes: [], answered: [], answers: [], open: 0, maxOpen: 0, delayMs: 0, status: 200, held: null };
before(async () => {
  server = http.createServer((req, res) => {
    gw.open++; gw.maxOpen = Math.max(gw.maxOpen, gw.open);
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      const raw = Buffer.concat(chunks);
      gw.times.push(Date.now()); gw.sizes.push(raw.length);
      const answer = raw.length > BODY_LIMIT ? { status: 413 } : gw.answers.shift() ?? { status: gw.status };
      gw.answered.push(answer.status);
      if (answer.status !== 413) gw.bodies.push(JSON.parse(raw.toString("utf8")));
      if (gw.held) await gw.held;
      if (gw.delayMs) await wait(gw.delayMs);
      if (answer.delayMs) await wait(answer.delayMs);
      gw.open--;
      res.writeHead(answer.status, { "content-type": "application/json", ...answer.headers }).end("{}");
    });
  });
  await listen(server);
  endpoint = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.closeAllConnections?.(); server.close(); });
// `open` is left as it is: it counts requests really open, and each test waits for its own to finish.
const reset = () => {
  Object.assign(gw, { bodies: [], times: [], sizes: [], answered: [], answers: [], maxOpen: 0, delayMs: 0, status: 200, held: null });
};
const hold = () => { let release; gw.held = new Promise((r) => (release = r)); return () => { gw.held = null; release(); }; };
const events = () => gw.bodies.flatMap((b) => b.events);
const droppedSum = () => gw.bodies.reduce((n, b) => n + (b.meta?.dropped ?? 0), 0);
const make = (over = {}) => createParlox({ secretKey: SECRET, endpoint, ipHeader: null, ...over });

test("queue: 19 events wait; the 20th sends one batch of 20, with no meta when nothing was dropped", async () => {
  reset();
  const p = make({ flushIntervalMs: 60_000 });
  for (let i = 0; i < 19; i++) p.enqueue(bot(`/p/${i}`));
  await until(() => p.pending === 19, "19 queued");
  await wait(50);
  assert.equal(gw.bodies.length, 0, "nothing is sent below flushAt");
  p.enqueue(bot("/p/19"));
  await until(() => gw.bodies.length === 1, "the batch");
  assert.deepEqual(gw.bodies[0].events.map((e) => e.path), Array.from({ length: 20 }, (_, i) => `/p/${i}`), "in arrival order");
  assert.equal(gw.bodies[0].meta, undefined);
});

test("queue: fewer than flushAt are sent when the interval passes", async () => {
  reset();
  const p = make({ flushIntervalMs: 100 });
  for (let i = 0; i < 3; i++) p.enqueue(bot(`/i/${i}`));
  await until(() => gw.bodies.length === 1, "the interval flush", 3000);
  assert.deepEqual(gw.bodies[0].events.map((e) => e.path), ["/i/0", "/i/1", "/i/2"]);
});

test("queue: at most 100 events per request, whatever maxBatchSize asks for", async () => {
  reset();
  const p = make({ flushAt: 1000, maxBatchSize: 500, flushIntervalMs: 60_000 });
  for (let i = 0; i < 250; i++) p.enqueue(bot(`/b/${i}`));
  await p.flush();
  assert.deepEqual(gw.bodies.map((b) => b.events.length), [100, 100, 50]);
});

test("queue: one request in flight at a time", async () => {
  reset(); gw.delayMs = 30;
  const p = make({ flushAt: 1, flushIntervalMs: 60_000 });
  for (let i = 0; i < 300; i++) p.enqueue(bot(`/c/${i}`));
  await until(() => events().length === 300, "all 300 sent");
  assert.equal(gw.maxOpen, 1);
});

test("queue: when full, the oldest is dropped and the count rides on the next batch", async () => {
  reset();
  const release = hold();
  const p = make({ flushAt: 1, maxQueueSize: 10, flushIntervalMs: 60_000 });
  p.enqueue(bot("/first"));
  await until(() => gw.bodies.length === 1, "the first batch in flight");
  for (let i = 0; i < 15; i++) p.enqueue(bot(`/q/${i}`));
  await until(() => p.pending + p.dropped === 15, "all 15 queued or dropped");
  assert.equal(p.pending, 10);
  assert.equal(p.dropped, 5);
  release();
  await until(() => events().length === 11, "the rest");
  assert.deepEqual(gw.bodies[1].events.map((e) => e.path), Array.from({ length: 10 }, (_, i) => `/q/${i + 5}`), "the ten newest are kept");
  assert.deepEqual(gw.bodies[1].meta, { dropped: 5 });
  assert.equal(p.dropped, 0);
});

// The gateway is slow or refusing during the very flood that caused the drops: a batch that
// is not delivered keeps the count it carried and adds its own reports to it.
test("a batch carrying meta.dropped that fails keeps the count, plus its own reports, for the next batch", async () => {
  reset();
  const release = hold();
  const errors = [];
  const p = make({ flushAt: 1, maxQueueSize: 2, flushIntervalMs: 60_000, onError: (e) => errors.push(String(e)) });
  p.enqueue(bot("/a"));
  await until(() => gw.bodies.length === 1, "the first batch in flight");
  for (const path of ["/b", "/c", "/d"]) p.enqueue(bot(path));
  await until(() => p.pending + p.dropped === 3, "a full queue");
  gw.status = 503; // for requests arriving from now on; /a, already in, is answered 200
  release();
  await until(() => gw.bodies.length === 2, "the batch carrying the count");
  assert.deepEqual(gw.bodies[1].events.map((e) => e.path), ["/c", "/d"]);
  assert.deepEqual(gw.bodies[1].meta, { dropped: 1 });
  await until(() => p.dropped === 3, "the count restored after the failure, plus the batch's two reports");
  gw.status = 200;
  p.enqueue(bot("/e"));
  await until(() => gw.bodies.length === 3, "the next batch");
  assert.deepEqual(gw.bodies[2].meta, { dropped: 3 }, "the count survived the failed request");
  assert.deepEqual(gw.answered, [200, 503, 200], "a 503 is not retried");
  assert.ok(errors.some((e) => /503/.test(e)), errors.join("\n"));
});

test("a queue under a flood keeps at most maxQueueSize events, and every event is sent or counted", { timeout: 60_000 }, async () => {
  reset();
  const release = hold();
  const p = make({ flushAt: 1, flushIntervalMs: 60_000 });
  p.enqueue(bot("/held"));
  await until(() => gw.bodies.length === 1, "one batch in flight");
  for (let i = 0; i < 20_000; i++) p.enqueue(bot(`/f/${i}`));
  await until(() => p.pending + p.dropped === 20_000, "every event queued or dropped", 30_000);
  assert.equal(p.pending, 1000);
  assert.equal(p.dropped, 19_000);
  release();
  await p.flush();
  assert.equal(events().length + droppedSum(), 20_001);
});

// AWS Lambda has no waitUntil and freezes the process after the response.
test("on AWS Lambda each report is sent at once, never queued", async () => {
  reset();
  process.env.AWS_LAMBDA_FUNCTION_NAME = "shop";
  try {
    const p = make({ flushIntervalMs: 60_000 });
    p.deliver(bot("/lambda"));
    await until(() => gw.bodies.length === 1, "an immediate send", 3000);
    assert.equal(p.pending, 0);
  } finally { delete process.env.AWS_LAMBDA_FUNCTION_NAME; }
});

test("deliver: an explicit waitUntil, or Vercel's request context, gets the report; nothing is queued", async () => {
  reset();
  const waited = [];
  const p = make({ flushIntervalMs: 60_000 });
  p.deliver(bot("/explicit"), (x) => waited.push(x));
  const key = Symbol.for("@vercel/request-context");
  globalThis[key] = { get: () => ({ waitUntil: (x) => waited.push(x) }) };
  try { p.deliver(bot("/vercel")); } finally { delete globalThis[key]; }
  assert.equal(waited.length, 2);
  await Promise.all(waited);
  assert.deepEqual(events().map((e) => e.path).sort(), ["/explicit", "/vercel"]);
  assert.equal(p.pending, 0);
});

test("purchases are sent at once; beyond 10 in flight the call resolves { ok: false, status: 0 } and says why", async () => {
  reset();
  const release = hold();
  const errors = [];
  const p = make({ onError: (e) => errors.push(String(e)), timeoutMs: 5000 });
  const order = (i) => ({ order_id: `o${i}`, value_cents: 100, currency: "USD" });
  const first = Array.from({ length: 10 }, (_, i) => p.purchase(order(i)));
  await until(() => gw.bodies.length === 10, "ten purchases in flight");
  assert.deepEqual(await p.purchase(order(10)), { ok: false, status: 0 });
  assert.ok(errors.some((e) => /10 purchases/.test(e)), errors.join("\n"));
  release();
  assert.ok((await Promise.all(first)).every((r) => r.ok));
  assert.ok(gw.bodies.every((b) => b.events.length === 1 && b.events[0].event === "purchase"), "never batched");
});

test("the flush timer never keeps a process alive, and a best-effort flush runs before it exits", async () => {
  reset();
  const url = pathToFileURL(resolve(import.meta.dirname, "../dist/esm/index.js")).href;
  const script = `import { createParlox } from ${JSON.stringify(url)};
const p = createParlox({ secretKey: ${JSON.stringify(SECRET)}, endpoint: ${JSON.stringify(endpoint)}, ipHeader: null, flushIntervalMs: 600000 });
p.enqueue({ method: "GET", path: "/exit", host: "shop.example.com", header: (n) => (n === "user-agent" ? "curl/8" : null) });`;
  const t0 = Date.now();
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: "inherit" });
  const [code] = await once(child, "exit");
  assert.equal(code, 0);
  assert.ok(Date.now() - t0 < 8000, "exited long before the 10-minute interval");
  assert.deepEqual(events().map((e) => e.path), ["/exit"]);
});

test("the SDK installs no signal handlers, and at most one beforeExit listener", async () => {
  reset();
  const names = ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"];
  const signals = names.map((s) => process.listenerCount(s));
  const exits = process.listenerCount("beforeExit");
  for (let i = 0; i < 3; i++) { const p = make({ flushIntervalMs: 60_000 }); p.enqueue(bot(`/s/${i}`)); await p.flush(); }
  assert.deepEqual(names.map((s) => process.listenerCount(s)), signals);
  assert.ok(process.listenerCount("beforeExit") - exits <= 1);
});

// The queue's size is the bound on the memory a flood costs. It is watched through the registry every copy of the
// package shares (the Express adapter keeps its instance to itself); the gateway holds the first batch until the queue
// is full, so the bound is reached during the flood, not only approached.
test("flood: 10,000 bot requests to an Express-style server keep Parlox at one request at a time, and the queue at most at maxQueueSize", { timeout: 120_000 }, async () => {
  reset(); gw.delayMs = 20;
  const release = hold();
  const mw = expressParlox({ secretKey: SECRET, endpoint, ipHeader: null });
  let most = 0;
  const watch = () => {
    for (const q of globalThis[Symbol.for("@parlox/server/delivery-queues")]?.queues ?? []) most = Math.max(most, q.pending);
    if (most >= 1000) release();
  };
  const app = http.createServer((rq, rs) => mw(rq, rs, () => { watch(); rs.statusCode = 200; rs.end("ok"); }));
  await listen(app);
  const base = `http://127.0.0.1:${app.address().port}`;
  try {
    let next = 0;
    const worker = async () => { while (next < 10_000) { const i = next++; await (await fetch(`${base}/p/${i}`, { headers: BOT })).text(); } };
    await Promise.all(Array.from({ length: 50 }, worker));
    release();
    await expressParlox.flush();
    watch();
    assert.equal(most, 1000, "the queue filled to maxQueueSize and never held more");
    assert.equal(events().length + droppedSum(), 10_000, "every request was sent or counted as dropped");
    assert.ok(droppedSum() > 0, "the full queue dropped, and said so");
    assert.equal(gw.maxOpen, 1, "one outbound request at a time");
    assert.ok(gw.bodies.every((b) => b.events.length <= 100));
  } finally { release(); app.closeAllConnections?.(); app.close(); }
});

// ── The queue keeps sending after it goes idle ──

test("after a flush with nothing queued, flushAt events are still sent", async () => {
  reset();
  const p = make({ flushAt: 5, flushIntervalMs: 60_000 });
  await p.flush();
  for (let i = 0; i < 5; i++) p.enqueue(bot(`/idle/${i}`));
  await until(() => gw.bodies.length === 1, "the batch after an idle flush", 3000);
  assert.equal(gw.bodies[0].events.length, 5);
  assert.equal(p.pending, 0);
});

test("a burst, then an interval with nothing queued, then more events: all are sent", async () => {
  reset();
  const release = hold();
  const p = make({ flushAt: 5, flushIntervalMs: 100 });
  for (let i = 0; i < 5; i++) p.enqueue(bot(`/burst/${i}`));
  await until(() => gw.bodies.length === 1, "the burst in flight");
  p.enqueue(bot("/late")); // arrives while a batch is in flight
  await until(() => p.pending === 1, "one waiting");
  release();
  await until(() => gw.bodies.length === 2, "the late one");
  await wait(300); // the scenario itself: several flush intervals pass with nothing queued
  for (let i = 0; i < 5; i++) p.enqueue(bot(`/after/${i}`));
  await until(() => gw.bodies.length === 3, "the events after the quiet interval", 3000);
  assert.deepEqual(gw.bodies[2].events.map((e) => e.path), Array.from({ length: 5 }, (_, i) => `/after/${i}`));
});

// ── A batch has a byte cap ──

test("100 maximal events go in several requests, each at most 200,000 bytes, none refused with 413", async () => {
  reset();
  const errors = [];
  const p = make({ flushAt: 1000, flushIntervalMs: 60_000, onError: (e) => errors.push(String(e)) });
  // Every field at its length cap, with characters that take more than one byte in the body: "€" is 3 bytes in UTF-8,
  // "é" 2, and a control character or a quote is escaped by JSON (6 and 2 bytes).
  const maximal = (i) => {
    const h = {
      "user-agent": "curl/" + "\u0001".repeat(995), referer: "é".repeat(2000), accept: '"'.repeat(500),
      "accept-language": "€".repeat(200), "sec-fetch-mode": "€".repeat(40), "signature-agent": "€".repeat(200),
      "signature-input": "\\".repeat(1000), signature: "€".repeat(1000),
    };
    return { method: "GET", path: `/${i}/` + "€".repeat(2000), host: "€".repeat(253), header: (n) => h[n.toLowerCase()] ?? null };
  };
  for (let i = 0; i < 100; i++) p.enqueue(maximal(i));
  await p.flush();
  assert.ok(gw.sizes.length > 1, `several requests (${gw.sizes.length})`);
  assert.ok(gw.sizes.every((n) => n <= 200_000), `sizes: ${gw.sizes.join(", ")}`);
  assert.ok(gw.sizes.every((n) => n <= BODY_LIMIT));
  assert.ok(gw.sizes.slice(0, -1).every((n) => n > 150_000), "each batch but the last is filled close to the limit");
  assert.ok(!gw.answered.includes(413), `answers: ${gw.answered.join(", ")}`);
  assert.deepEqual(events().map((e) => Number(e.path.split("/")[1])), Array.from({ length: 100 }, (_, i) => i), "every event, in order");
  assert.equal(p.dropped, 0);
  assert.deepEqual(errors, []);
});

// ── Retry only what the gateway provably did not store ──

test("a 429, then success: the batch is delivered once and nothing is counted as dropped", async () => {
  reset();
  gw.answers = [{ status: 429 }];
  const p = make({ flushAt: 1000, flushIntervalMs: 60_000, retryDelayMs: 10 });
  for (let i = 0; i < 3; i++) p.enqueue(bot(`/r/${i}`));
  await p.flush();
  assert.deepEqual(gw.answered, [429, 200]);
  assert.deepEqual(gw.bodies[1].events, gw.bodies[0].events, "the same batch, sent again");
  assert.equal(p.dropped, 0);
  p.enqueue(bot("/r/next"));
  await p.flush();
  assert.equal(gw.bodies[2].meta, undefined, "no gap is reported");
});

test("four 429s: three retries, then the batch's reports ride on the next batch as dropped", async () => {
  reset();
  gw.answers = [429, 429, 429, 429].map((status) => ({ status }));
  const p = make({ flushAt: 1000, flushIntervalMs: 60_000, retryDelayMs: 10 });
  for (let i = 0; i < 3; i++) p.enqueue(bot(`/r4/${i}`));
  await p.flush();
  assert.deepEqual(gw.answered, [429, 429, 429, 429], "the first attempt and three retries, no more");
  assert.equal(p.dropped, 3);
  p.enqueue(bot("/r4/next"));
  await p.flush();
  assert.deepEqual(gw.bodies[4].meta, { dropped: 3 });
  assert.deepEqual(gw.bodies[4].events.map((e) => e.path), ["/r4/next"]);
  assert.equal(p.dropped, 0);
});

// A connection that never reached the gateway, without freeing a port another process could take: the first fetch
// fails the way Node's fetch fails on a refused connection (TypeError "fetch failed", the socket error as its cause; an
// AggregateError of one error per address when a name has several), then the real fetch reaches the stand-in gateway.
for (const [shape, cause] of [
  ["connection refused", () => Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:9"), { code: "ECONNREFUSED", syscall: "connect" })],
  ["connection refused on every address", () => Object.assign(new AggregateError([
    Object.assign(new Error("connect ECONNREFUSED ::1:9"), { code: "ECONNREFUSED" }),
    Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:9"), { code: "ECONNREFUSED" }),
  ]), { code: "ECONNREFUSED" })],
  ["name not resolved", () => Object.assign(new Error("getaddrinfo ENOTFOUND gateway.parlox.io"), { code: "ENOTFOUND", syscall: "getaddrinfo" })],
]) {
  test(`${shape}, then the gateway is reached: the batch is delivered`, async () => {
    reset();
    const realFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (...args) => (++calls === 1 ? Promise.reject(new TypeError("fetch failed", { cause: cause() })) : realFetch(...args));
    const errors = [];
    try {
      const p = make({ flushAt: 1000, flushIntervalMs: 60_000, retryDelayMs: 10, onError: (e) => errors.push(e) });
      p.enqueue(bot("/unreached"));
      await p.flush();
      assert.equal(calls, 2, "one failed attempt, one retry");
      assert.equal(errors.length, 1);
      assert.deepEqual(gw.bodies.map((b) => b.events.map((e) => e.path)), [["/unreached"]]);
      assert.equal(gw.bodies[0].meta, undefined);
      assert.equal(p.dropped, 0);
    } finally { globalThis.fetch = realFetch; }
  });
}

test("while a batch waits for its retry, the queue keeps accepting, still bounded, with one request at a time", async () => {
  reset();
  gw.answers = [{ status: 429 }];
  const p = make({ flushAt: 1, maxQueueSize: 5, flushIntervalMs: 60_000, retryDelayMs: 500 });
  p.enqueue(bot("/first"));
  await until(() => gw.answered.length === 1, "the 429");
  for (let i = 0; i < 8; i++) p.enqueue(bot(`/meanwhile/${i}`));
  await until(() => p.pending + p.dropped === 8, "all eight queued or dropped");
  assert.equal(p.pending, 5);
  assert.equal(p.dropped, 3);
  assert.equal(gw.bodies.length, 1, "nothing else is sent while the batch waits for its retry");
  await p.flush();
  assert.deepEqual(gw.answered, [429, 200, 200]);
  assert.deepEqual(gw.bodies[1].events.map((e) => e.path), ["/first"]);
  assert.deepEqual(gw.bodies[2].events.map((e) => e.path), [3, 4, 5, 6, 7].map((i) => `/meanwhile/${i}`));
  assert.deepEqual(gw.bodies[2].meta, { dropped: 3 });
  assert.equal(gw.maxOpen, 1);
});

for (const [what, answer, over] of [
  ["a 503", { status: 503 }, {}],
  ["a timeout", { status: 200, delayMs: 1000 }, { batchTimeoutMs: 200 }],
  ["a 401", { status: 401 }, {}],
]) {
  test(`${what} is not retried (the gateway may have stored it); the batch's reports ride on the next batch as dropped`, async () => {
    reset();
    gw.answers = [answer];
    const errors = [];
    const p = make({ flushAt: 1000, flushIntervalMs: 60_000, retryDelayMs: 10, onError: (e) => errors.push(e), ...over });
    for (let i = 0; i < 3; i++) p.enqueue(bot(`/n/${i}`));
    await p.flush();
    assert.equal(gw.bodies.length, 1, "one attempt");
    assert.equal(p.dropped, 3);
    assert.equal(errors.length, 1, errors.join("\n"));
    p.enqueue(bot("/n/next"));
    await p.flush();
    assert.equal(gw.bodies.length, 2);
    assert.deepEqual(gw.bodies[1].meta, { dropped: 3 });
    assert.deepEqual(gw.bodies[1].events.map((e) => e.path), ["/n/next"]);
    await until(() => gw.open === 0, "the gateway done with every request (the timed-out one answers late)");
  });
}

// Real time with a margin (fake timers would freeze the stand-in gateway's HTTP waits).
test("Retry-After: 2 is honoured over retryDelayMs", async () => {
  reset();
  gw.answers = [{ status: 429, headers: { "retry-after": "2" } }];
  const p = make({ flushAt: 1000, flushIntervalMs: 60_000, retryDelayMs: 10 });
  p.enqueue(bot("/retry-after"));
  await p.flush();
  assert.deepEqual(gw.answered, [429, 200]);
  const gap = gw.times[1] - gw.times[0];
  assert.ok(gap >= 1900 && gap < 10_000, `the second attempt came ${gap} ms after the first`);
  assert.equal(p.dropped, 0);
});

// ── Retry timers and shutdown ──

test("flush() against a gateway answering 429 resolves within its bound and counts the batch as not delivered", async () => {
  reset();
  gw.status = 429;
  const p = make({ flushAt: 1000, flushIntervalMs: 60_000 }); // retries 3 s apart: the first would start after the bound
  for (let i = 0; i < 3; i++) p.enqueue(bot(`/b429/${i}`));
  const t0 = Date.now();
  await p.flush(1000);
  const ms = Date.now() - t0;
  assert.ok(ms < 1500, `resolved after ${ms} ms`);
  assert.equal(p.pending, 0);
  assert.equal(p.dropped, 3);
  assert.equal(gw.bodies.length, 1, "no retry that the bound would cut");
});

test("flush() resolves by its bound with a request in flight, and counts what it still waited for as not delivered", async () => {
  reset();
  const release = hold();
  const p = make({ flushAt: 1, flushIntervalMs: 60_000 });
  p.enqueue(bot("/slow"));
  await until(() => gw.bodies.length === 1, "a request in flight");
  p.enqueue(bot("/w1")); p.enqueue(bot("/w2"));
  await until(() => p.pending === 2, "two waiting");
  const t0 = Date.now();
  const flushed = p.flush(300);
  p.enqueue(bot("/late")); // queued after the call: not the flush's to wait for, or to give up
  await flushed;
  const ms = Date.now() - t0;
  assert.ok(ms >= 250 && ms < 2000, `resolved after ${ms} ms`);
  assert.equal(p.dropped, 2, "the two it waited for");
  assert.equal(p.pending, 1, "the report queued after the call still waits");
  release();
  await p.flush();
  assert.deepEqual(gw.bodies.map((b) => b.events.map((e) => e.path)), [["/slow"], ["/late"]]);
  assert.deepEqual(gw.bodies[1].meta, { dropped: 2 });
  assert.equal(p.dropped, 0);
});

test("flush() waits for the reports queued before it, not for the ones that keep arriving", async () => {
  reset(); gw.delayMs = 50;
  const p = make({ flushAt: 1, flushIntervalMs: 60_000 });
  for (let i = 0; i < 5; i++) p.enqueue(bot(`/before/${i}`));
  let streaming = true;
  const stream = (async () => { for (let i = 0; streaming; i++) { p.enqueue(bot(`/during/${i}`)); await wait(10); } })();
  const t0 = Date.now();
  await p.flush();
  const ms = Date.now() - t0;
  streaming = false;
  await stream;
  assert.ok(ms < 5000, `resolved after ${ms} ms, while reports kept arriving`);
  const sent = events().map((e) => e.path);
  for (let i = 0; i < 5; i++) assert.ok(sent.includes(`/before/${i}`), `/before/${i} was sent before flush() resolved`);
  assert.equal(p.dropped, 0);
  await p.flush();
});

test("a retry timer never keeps a process alive", async () => {
  reset();
  gw.answers = [{ status: 429 }];
  const url = pathToFileURL(resolve(import.meta.dirname, "../dist/esm/index.js")).href;
  // The retry would come 20 s after the 429, inside the exit flush's 30 s bound.
  const script = `import { createParlox } from ${JSON.stringify(url)};
const p = createParlox({ secretKey: ${JSON.stringify(SECRET)}, endpoint: ${JSON.stringify(endpoint)}, ipHeader: null, flushIntervalMs: 600000, retryDelayMs: 20000 });
p.enqueue({ method: "GET", path: "/exit-429", host: "shop.example.com", header: (n) => (n === "user-agent" ? "curl/8" : null) });`;
  const t0 = Date.now();
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: "inherit" });
  const [code] = await once(child, "exit");
  assert.equal(code, 0);
  assert.ok(Date.now() - t0 < 8000, "exited without waiting for the retry");
  assert.deepEqual(gw.answered, [429]);
});

// ── Purchases across instances, steady and slow traffic, an awaited flush(), short-lived platforms ──

test("every instance in the process shares the 10 purchase slots, the CommonJS build's too", async () => {
  reset();
  const release = hold();
  const errors = [];
  const a = make({ onError: (e) => errors.push(String(e)), timeoutMs: 5000 });
  const b = make({ onError: (e) => errors.push(String(e)), timeoutMs: 5000 });
  const { createParlox: createParloxCjs } = createRequire(import.meta.url)("../dist/cjs/index.cjs");
  const c = createParloxCjs({ secretKey: SECRET, endpoint, ipHeader: null, onError: (e) => errors.push(String(e)) });
  const order = (i) => ({ order_id: `s${i}`, value_cents: 100, currency: "USD" });
  const first = [...Array.from({ length: 5 }, (_, i) => a.purchase(order(i))), ...Array.from({ length: 5 }, (_, i) => b.purchase(order(5 + i)))];
  try {
    await until(() => gw.bodies.length === 10, "ten purchases in flight, five from each instance");
    // A purchase past the cap resolves at once; one that was sent instead would wait on the held gateway.
    for (const p of [a, b, c]) assert.deepEqual(await Promise.race([p.purchase(order(99)), wait(2000).then(() => "sent and waiting")]), { ok: false, status: 0 });
    assert.equal(errors.filter((e) => /10 purchases/.test(e)).length, 3, errors.join("\n"));
  } finally { release(); }
  assert.ok((await Promise.all(first)).every((r) => r.ok));
  assert.deepEqual(await c.purchase(order(100)), { ok: true, status: 200 }, "the slots are free again");
});

test("a steady trickle still goes in batches (one event every 30 ms, the gateway answering in 100 ms)", { timeout: 30_000 }, async () => {
  reset(); gw.delayMs = 100;
  const p = make();
  for (let i = 0; i < 100; i++) { p.enqueue(bot(`/t/${i}`)); await wait(30); }
  await p.flush();
  assert.equal(events().length, 100);
  assert.ok(gw.bodies.length <= 7, `100 events went in ${gw.bodies.length} requests: ${gw.bodies.map((b) => b.events.length).join(",")}`);
  assert.equal(gw.maxOpen, 1);
});

test("a slow trickle is sent on the interval, including events that arrive while a request is in flight", async () => {
  reset(); gw.delayMs = 100;
  const p = make({ flushIntervalMs: 150 });
  for (let i = 0; i < 3; i++) p.enqueue(bot(`/slow/${i}`));
  await until(() => gw.bodies.length === 1, "the interval batch in flight");
  p.enqueue(bot("/slow/3")); p.enqueue(bot("/slow/4")); // below flushAt, while the request is open
  await until(() => events().length === 5, "the later two, on the next interval", 3000);
  assert.deepEqual(gw.bodies.map((b) => b.events.map((e) => e.path)), [["/slow/0", "/slow/1", "/slow/2"], ["/slow/3", "/slow/4"]]);
  assert.equal(p.pending, 0);
});

// An awaited flush() keeps the process running until it ends (bounded by its own timeoutMs).
for (const [what, answers, over, expected] of [
  ["a 429, then 200: the batch is delivered", [429, 200], "", "dropped 0"],
  ["two 429s with one retry: the batch is counted", [429, 429], ", retryCount: 1", "dropped 1"],
]) {
  test(`a top-level await flush() after ${what}, and the process exits 0`, async () => {
    reset();
    gw.answers = answers.map((status) => ({ status }));
    const url = pathToFileURL(resolve(import.meta.dirname, "../dist/esm/index.js")).href;
    const script = `import { createParlox } from ${JSON.stringify(url)};
const p = createParlox({ secretKey: ${JSON.stringify(SECRET)}, endpoint: ${JSON.stringify(endpoint)}, ipHeader: null, flushAt: 1, retryDelayMs: 300${over} });
p.enqueue({ method: "GET", path: "/tla", host: "shop.example.com", header: (n) => (n === "user-agent" ? "curl/8" : null) });
await p.flush(10000);
console.log("dropped " + p.dropped);`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    const [code] = await once(child, "exit");
    assert.equal(code, 0);
    assert.equal(out.trim(), expected);
    assert.deepEqual(gw.answered, answers);
  });
}

test("a flush() awaited while a background retry already waits keeps the process running until the retry is delivered", async () => {
  reset();
  gw.answers = [{ status: 429 }];
  const url = pathToFileURL(resolve(import.meta.dirname, "../dist/esm/index.js")).href;
  // The retry wait starts with no flush waiting (so it holds nothing open); the flush comes 100 ms into it.
  const script = `import { createParlox } from ${JSON.stringify(url)};
let failed; const firstAttempt = new Promise((r) => (failed = r));
const p = createParlox({ secretKey: ${JSON.stringify(SECRET)}, endpoint: ${JSON.stringify(endpoint)}, ipHeader: null, flushAt: 1, retryDelayMs: 1000, onError: () => failed() });
p.enqueue({ method: "GET", path: "/bg", host: "shop.example.com", header: (n) => (n === "user-agent" ? "curl/8" : null) });
await firstAttempt;
await new Promise((r) => setTimeout(r, 100));
await p.flush(10000);
console.log("dropped " + p.dropped);`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "inherit"] });
  let out = "";
  child.stdout.on("data", (c) => (out += c));
  const [code] = await once(child, "exit");
  assert.equal(code, 0);
  assert.equal(out.trim(), "dropped 0");
  assert.deepEqual(gw.answered, [429, 200]);
});

// Platforms that may stop or freeze the process soon after a response, with no waitUntil for this code.
const withEnv = async (name, value, fn) => { process.env[name] = value; try { await fn(); } finally { delete process.env[name]; } };
const withGlobal = async (name, value, fn) => {
  const before = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  try { await fn(); } finally { if (before) Object.defineProperty(globalThis, name, before); else delete globalThis[name]; }
};
for (const [platform, detect] of [
  ["Cloudflare Workers (navigator.userAgent)", (fn) => withGlobal("navigator", { userAgent: "Cloudflare-Workers" }, fn)],
  ["Deno Deploy (DENO_DEPLOYMENT_ID)", (fn) => withEnv("DENO_DEPLOYMENT_ID", "abc123", fn)],
  ["Deno Deploy, read through Deno.env", (fn) => withGlobal("Deno", { permissions: { querySync: () => ({ state: "granted" }) }, env: { get: (n) => (n === "DENO_DEPLOYMENT_ID" ? "abc123" : undefined) } }, fn)],
  ["Azure Functions (FUNCTIONS_WORKER_RUNTIME)", (fn) => withEnv("FUNCTIONS_WORKER_RUNTIME", "node", fn)],
]) {
  test(`on ${platform} each report is sent at once, never queued`, async () => {
    reset();
    const p = make({ flushIntervalMs: 60_000 });
    await detect(async () => {
      p.deliver(bot("/at-once"));
      await until(() => gw.bodies.length === 1, "an immediate send", 3000);
      assert.equal(p.pending, 0);
    });
  });
}

test("elsewhere (a long-running Node server) the report is queued", async () => {
  reset();
  const p = make({ flushIntervalMs: 60_000 });
  p.deliver(bot("/queued"));
  await until(() => p.pending === 1, "queued");
  assert.equal(gw.bodies.length, 0);
  await p.flush();
  assert.equal(gw.bodies.length, 1);
});

test("flush() gives up at once on a retry already waiting past its bound, and later reports carry the count", async () => {
  reset();
  gw.answers = [{ status: 429 }];
  const p = make({ flushAt: 2, retryDelayMs: 5000, flushIntervalMs: 60_000 });
  p.enqueue(bot("/a")); p.enqueue(bot("/b"));
  await until(() => gw.answered.length === 1, "the 429");
  await wait(50); // the batch is now waiting 5 s for its retry
  const t0 = Date.now();
  await p.flush(1000);
  const ms = Date.now() - t0;
  assert.ok(ms < 500, `resolved after ${ms} ms, without waiting for the bound`);
  assert.equal(p.dropped, 2);
  assert.equal(gw.bodies.length, 1, "the retry never started");
  p.enqueue(bot("/c"));
  await p.flush();
  assert.deepEqual(gw.bodies.map((b) => [b.events.map((e) => e.path), b.meta]), [[["/a", "/b"], undefined], [["/c"], { dropped: 2 }]]);
});

test("each event is serialized once; the batch body is built from those texts", async () => {
  reset();
  const realStringify = JSON.stringify;
  let perEvent = 0, perBody = 0;
  JSON.stringify = function (value, ...rest) {
    if (value && typeof value === "object" && "ip_hash" in value) perEvent++;
    if (value && typeof value === "object" && "events" in value) perBody++;
    return realStringify.call(this, value, ...rest);
  };
  try {
    const p = make({ flushAt: 1000, flushIntervalMs: 60_000 });
    const long = { "user-agent": "curl/" + "u".repeat(995), referer: "r".repeat(2000), signature: "s".repeat(1000), "signature-input": "i".repeat(1000) };
    for (let i = 0; i < 100; i++) p.enqueue({ method: "GET", path: `/${i}/` + "p".repeat(1990), host: "h", header: (n) => long[n] ?? null });
    await p.flush();
    assert.ok(gw.bodies.length > 1, "several batches, so some event did not fit and waited for the next one");
    assert.equal(events().length, 100);
    assert.equal(perEvent, 100, "one serialization per event, the one that did not fit included");
    assert.equal(perBody, 0, "no second serialization of the whole body");
  } finally { JSON.stringify = realStringify; }
});

test("a queue smaller than flushAt sends once it is full, instead of dropping while it waits for the interval", async () => {
  reset();
  const p = make({ maxQueueSize: 5, flushIntervalMs: 60_000 }); // flushAt stays at its default, 20
  for (let i = 0; i < 5; i++) p.enqueue(bot(`/small/${i}`));
  await until(() => gw.bodies.length === 1, "the full queue sent", 3000);
  assert.equal(events().length, 5);
  assert.equal(p.dropped, 0);
});

// ── flushAt is at most one full batch ──

test("flushAt above maxBatchSize: each full batch goes at once, not one per interval", async () => {
  reset();
  const p = make({ flushAt: 300, flushIntervalMs: 60_000 }); // maxBatchSize stays at 100
  for (let i = 0; i < 300; i++) p.enqueue(bot(`/full/${i}`));
  await until(() => events().length === 300, "three full batches, without waiting for the interval", 3000);
  assert.deepEqual(gw.bodies.map((b) => b.events.length), [100, 100, 100]);
  assert.equal(p.pending, 0);
});

// ── Deno: the environment is read only with permission, so a terminal never shows Deno's permission prompt ──

// Records reads of the variables Parlox looks at through process.env (Deno 2 has a global process too).
const WATCHED = /^(?:PARLOX_|AWS_LAMBDA_FUNCTION_NAME$|DENO_DEPLOYMENT_ID$|FUNCTIONS_WORKER_RUNTIME$|VERCEL$)/;
const spyOnProcessEnv = async (read, fn) => {
  const real = process.env;
  const spy = new Proxy(real, { get(t, k) { if (typeof k === "string" && WATCHED.test(k)) read.push(`process.env ${k}`); return Reflect.get(t, k); } });
  Object.defineProperty(process, "env", { value: spy, configurable: true, writable: true, enumerable: true });
  try { await fn(); } finally { Object.defineProperty(process, "env", { value: real, configurable: true, writable: true, enumerable: true }); }
};
const fakeDeno = (permissions, read, values = {}) => ({ permissions, env: { get: (n) => { read.push(`Deno.env ${n}`); return values[n]; } } });

for (const [answer, permissions] of [
  ["answers prompt", { querySync: () => ({ state: "prompt" }) }],
  ["answers denied", { querySync: () => ({ state: "denied" }) }],
  ["throws", { querySync: () => { throw new Error("not supported"); } }],
  ["does not exist", {}],
]) {
  test(`on Deno, when the permission query ${answer}, no variable is read (no prompt) and the report is queued`, async () => {
    reset();
    const read = [];
    await spyOnProcessEnv(read, () => withGlobal("Deno", fakeDeno(permissions, read, { DENO_DEPLOYMENT_ID: "abc123", PARLOX_SECRET_KEY: SECRET }), async () => {
      const p = make({ flushIntervalMs: 60_000 });
      p.deliver(bot("/deno"));
      await until(() => p.pending === 1, "queued, as on a long-running server");
      assert.equal(createParlox({ endpoint }).shouldReport(bot("/deno")), false, "without a readable key nothing is reported");
      await p.flush();
    }));
    assert.deepEqual(read, []);
    assert.deepEqual(events().map((e) => e.path), ["/deno"]);
  });
}

test("on Deno, a variable is read once its own permission is granted (--allow-env=NAME), and only that one", async () => {
  reset();
  const read = [];
  const asked = [];
  const permissions = { querySync: (d) => { asked.push(d); return { state: d.name === "env" && d.variable === "PARLOX_SECRET_KEY" ? "granted" : "prompt" }; } };
  await spyOnProcessEnv(read, () => withGlobal("Deno", fakeDeno(permissions, read, { DENO_DEPLOYMENT_ID: "abc123", PARLOX_SECRET_KEY: SECRET }), async () => {
    const p = createParlox({ endpoint, ipHeader: null, flushIntervalMs: 60_000 });
    assert.equal(p.shouldReport(bot("/granted")), true, "the key was read");
    p.deliver(bot("/granted"));
    await until(() => p.pending === 1, "queued: DENO_DEPLOYMENT_ID was not readable");
    await p.flush();
  }));
  assert.ok(read.length > 0 && read.every((r) => r.endsWith(" PARLOX_SECRET_KEY")), read.join(", "));
  assert.ok(asked.some((d) => d.variable === "DENO_DEPLOYMENT_ID"), "the platform check asked, and was refused");
  assert.equal(gw.bodies[0].events[0].path, "/granted");
});

// Deno's setTimeout returns a number, which only Deno.unrefTimer(id) unrefs. The child process gives the package exactly
// that, with a fetch of its own standing in for the network (Node's fetch needs Node's timer objects).
test("on Deno, whose timers are numbers, the flush timer never keeps the process alive either", async () => {
  const url = pathToFileURL(resolve(import.meta.dirname, "../dist/esm/index.js")).href;
  const script = `const realSet = globalThis.setTimeout, realClear = globalThis.clearTimeout;
const timers = new Map(); let next = 1;
globalThis.setTimeout = (fn, ms, ...args) => { const id = next++; timers.set(id, realSet(() => { timers.delete(id); fn(...args); }, ms)); return id; };
globalThis.clearTimeout = (id) => { if (typeof id === "number") { realClear(timers.get(id)); timers.delete(id); } else realClear(id); };
globalThis.Deno = { unrefTimer: (id) => timers.get(id)?.unref(), permissions: { querySync: () => ({ state: "granted" }) }, env: { get: () => undefined } };
globalThis.fetch = async (_url, init) => { console.log("sent " + JSON.parse(init.body).events.map((e) => e.path).join(",")); return new Response("{}"); };
const { createParlox } = await import(${JSON.stringify(url)});
const p = createParlox({ secretKey: ${JSON.stringify(SECRET)}, ipHeader: null, verifyToken: "t", flushIntervalMs: 600000 });
p.enqueue({ method: "GET", path: "/deno-exit", host: "shop.example.com", header: (n) => (n === "user-agent" ? "curl/8" : null) });`;
  const t0 = Date.now();
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "inherit"] });
  let out = "";
  child.stdout.on("data", (c) => (out += c));
  const stop = setTimeout(() => child.kill(), 8000);
  const [code] = await once(child, "exit");
  clearTimeout(stop);
  assert.equal(code, 0, "exited on its own, long before the 10-minute interval");
  assert.ok(Date.now() - t0 < 8000);
  assert.equal(out.trim(), "sent /deno-exit", "the exit flush sent the queued report");
});

// Last, after every test above: what the SDK wrote to the log while they ran.
test("the log lines these tests provoked are the SDK's own, each said at most once per instance", () => {
  checkLogLines();
});
