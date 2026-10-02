// Reports sent at once (through waitUntil, by the Next.js and Vercel adapters, or where the platform may stop the code
// after a response): at most 64 in flight in the process. Run against the built package (dist/), in a process of its own
// (node --test runs each file apart), so the process-wide count starts at zero.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createParlox } from "../dist/esm/index.js";

const SECRET = "sk_" + "e".repeat(64);
const BOT = { "user-agent": "curl/8.4.0" };
const bot = (path) => ({ method: "GET", path, host: "shop.example.com", header: (n) => BOT[n.toLowerCase()] ?? null });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, what, ms = 10_000) {
  const end = Date.now() + ms;
  while (!check()) { if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await wait(5); }
}

// A stand-in gateway: records each body, counts the requests open at once, answers `status` (200 unless set), and
// holds every answer back while `held` is set.
let server, endpoint;
const gw = { bodies: [], open: 0, maxOpen: 0, status: 200, held: null };
before(async () => {
  server = http.createServer((req, res) => {
    gw.open++; gw.maxOpen = Math.max(gw.maxOpen, gw.open);
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      gw.bodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      const status = gw.status;
      if (gw.held) await gw.held;
      gw.open--;
      res.writeHead(status, { "content-type": "application/json" }).end("{}");
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  endpoint = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.closeAllConnections?.(); server.close(); });
const reset = () => Object.assign(gw, { bodies: [], maxOpen: 0, status: 200, held: null });
const hold = () => { let release; gw.held = new Promise((r) => (release = r)); return () => { gw.held = null; release(); }; };
const make = (over = {}) => createParlox({ secretKey: SECRET, endpoint, ipHeader: null, timeoutMs: 10_000, ...over });

// Each burst first fills the 64 slots and waits until those requests are at the gateway (their hashes done and their
// bodies written), so the reports over the bound are counted after them and their count waits for the next request.
test("a burst of 100 reports through waitUntil: at most 64 requests in flight; the other 36 are counted and go with the next request", async () => {
  reset();
  const release = hold();
  const waited = [];
  const p = make();
  try {
    for (let i = 0; i < 64; i++) p.deliver(bot(`/burst/${i}`), (x) => waited.push(x));
    await until(() => gw.bodies.length >= 64, "64 requests at the gateway");
    for (let i = 64; i < 100; i++) p.deliver(bot(`/burst/${i}`), (x) => waited.push(x));
    await wait(100);
    assert.equal(gw.bodies.length, 64, "no 65th request while 64 are in flight");
    assert.equal(gw.maxOpen, 64);
    assert.equal(p.dropped, 36);
    assert.ok(gw.bodies.every((b) => b.meta === undefined), "nothing was dropped before these were sent");
  } finally { release(); }
  await Promise.all(waited);
  p.deliver(bot("/next"), (x) => waited.push(x));
  await Promise.all(waited);
  assert.deepEqual(gw.bodies.at(-1).events.map((e) => e.path), ["/next"]);
  assert.deepEqual(gw.bodies.at(-1).meta, { dropped: 36 });
  assert.equal(p.dropped, 0);
});

test("the 64 are shared by every instance in the process (the Next.js and Vercel adapters call report()); each instance's count goes with its own next request", async () => {
  reset();
  const release = hold();
  const a = make();
  const b = make();
  const sent = [];
  try {
    for (let i = 0; i < 40; i++) sent.push(a.report(bot(`/a/${i}`)));
    for (let i = 0; i < 24; i++) sent.push(b.report(bot(`/b/${i}`)));
    await until(() => gw.bodies.length >= 64, "64 requests at the gateway");
    for (let i = 24; i < 40; i++) sent.push(b.report(bot(`/b/${i}`)));
    await wait(100);
    assert.equal(gw.bodies.length, 64);
    assert.deepEqual([a.dropped, b.dropped], [0, 16]);
  } finally { release(); }
  await Promise.all(sent);
  await a.report(bot("/a/next"));
  await b.report(bot("/b/next"));
  const body = (path) => gw.bodies.find((x) => x.events[0].path === path);
  assert.equal(body("/a/next").meta, undefined);
  assert.deepEqual(body("/b/next").meta, { dropped: 16 }, "b's count reaches Parlox with b's key");
  assert.deepEqual([a.dropped, b.dropped], [0, 0]);
});

test("a request carrying the count that is not delivered keeps the count for the one after it", async () => {
  reset();
  const release = hold();
  const p = make();
  const sent = [];
  try {
    for (let i = 0; i < 64; i++) sent.push(p.report(bot(`/c/${i}`)));
    await until(() => gw.bodies.length >= 64, "64 requests at the gateway");
    sent.push(p.report(bot("/c/64")), p.report(bot("/c/65")));
    assert.equal(p.dropped, 2);
  } finally { release(); }
  await Promise.all(sent);
  gw.status = 503;
  await p.report(bot("/c/refused"));
  assert.deepEqual(gw.bodies.at(-1).meta, { dropped: 2 });
  assert.equal(p.dropped, 2, "the count is back, waiting for the next request");
  gw.status = 200;
  await p.report(bot("/c/after"));
  assert.deepEqual(gw.bodies.at(-1).meta, { dropped: 2 });
  assert.equal(p.dropped, 0);
});

// Last in this file: a report sent at once without waitUntil cannot be awaited, so this test only waits for the
// gateway to have answered everything.
test("where the platform may stop the code after a response (Azure Functions here), the same bound applies", async () => {
  reset();
  const release = hold();
  process.env.FUNCTIONS_WORKER_RUNTIME = "node";
  try {
    const p = make();
    for (let i = 0; i < 64; i++) p.deliver(bot(`/azure/${i}`));
    await until(() => gw.bodies.length >= 64, "64 requests at the gateway");
    for (let i = 64; i < 70; i++) p.deliver(bot(`/azure/${i}`));
    await wait(100);
    assert.equal(gw.bodies.length, 64);
    assert.equal(p.pending, 0, "nothing is queued");
    assert.equal(p.dropped, 6);
  } finally {
    delete process.env.FUNCTIONS_WORKER_RUNTIME;
    release();
  }
  await until(() => gw.open === 0, "every request answered");
});
