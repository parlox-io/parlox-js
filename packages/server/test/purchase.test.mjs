// purchase(): what the app's onError is told when Parlox refuses an order, and how the shared purchase cap behaves
// with instances configured differently. Run against the built package (dist/), the way a merchant's server loads it.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createParlox as createCore } from "../dist/esm/index.js";
import { checkLogLines, tracked } from "../test-support/log-lines.mjs";

// The SDK says an empty secretKey, and a key Parlox refuses, once per instance in the server's log (warnings.test.mjs
// checks those lines); these tests refuse keys on purpose, so the lines are recorded instead of printed, and the last
// test checks them: each one the SDK means to write, at most once per instance (test-support/log-lines.mjs).
const createParlox = tracked(createCore);

// A stand-in gateway. Each request gets the next scripted answer ({ status, type, body }), else 200 {"accepted":1}.
// `held` keeps every answer back until released.
let server, endpoint, answers = [], held = null, arrived = 0;
before(async () => {
  server = http.createServer((req, res) => {
    req.resume();
    req.on("end", async () => {
      arrived++;
      const a = answers.shift() ?? { status: 200, body: '{"accepted":1}' };
      if (held) await held;
      res.writeHead(a.status, { "content-type": a.type ?? "application/json" }).end(a.body);
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  endpoint = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.closeAllConnections?.(); server.close(); });

const SECRET = "sk_" + "c".repeat(64);
const ORDER = { order_id: "1001", value_cents: 4990, currency: "USD" };
const FETCH_KEY_ERROR = "This key can only send crawler reports. To record orders, create a send key in the dashboard (Settings → Keys).";
const make = (errors, over = {}) => createParlox({ secretKey: SECRET, endpoint, ipHeader: null, onError: (e) => errors.push(e), ...over });

// Posts one order against the given answer; resolves to what purchase() returned and the messages onError was given.
async function refused(answer) {
  answers = [answer];
  const errors = [];
  const result = await make(errors).purchase(ORDER);
  return { result, messages: errors.map((e) => (e instanceof Error ? e.message : String(e))) };
}

test("purchase: a crawler-only key's 403 gives onError the gateway's reason", async () => {
  const { result, messages } = await refused({ status: 403, body: JSON.stringify({ error: FETCH_KEY_ERROR }) });
  assert.deepEqual(result, { ok: false, status: 403 });
  assert.deepEqual(messages, [`Parlox refused the order (HTTP 403): ${FETCH_KEY_ERROR}`]);
});

test("purchase: a 401 gives onError the gateway's reason", async () => {
  const { result, messages } = await refused({ status: 401, body: '{"error":"Invalid secret key"}' });
  assert.deepEqual(result, { ok: false, status: 401 });
  assert.deepEqual(messages, ["Parlox refused the order (HTTP 401): Invalid secret key"]);
});

test("purchase: a 500 without JSON keeps the status-only message", async () => {
  const { result, messages } = await refused({ status: 500, type: "text/plain", body: "Internal Server Error" });
  assert.deepEqual(result, { ok: false, status: 500 });
  assert.deepEqual(messages, ["Parlox answered HTTP 500"]);
});

test("purchase: an answer over 1 KB is not read past the bound, and keeps the status-only message", async () => {
  for (const body of [
    JSON.stringify({ error: "x".repeat(5000) }),
    JSON.stringify({ error: "Refused", padding: "p".repeat(2000) }),
  ]) {
    const { result, messages } = await refused({ status: 403, body });
    assert.deepEqual(result, { ok: false, status: 403 });
    assert.deepEqual(messages, ["Parlox answered HTTP 403"]);
  }
});

test("purchase: control and formatting characters are removed from the reason, which stays on one line", async () => {
  const error = "Key\u0000 revoked\r\nX-Injected: 1\u001b[31m red\u0085\u202e end\u2028";
  const { messages } = await refused({ status: 403, body: JSON.stringify({ error }) });
  assert.deepEqual(messages, ["Parlox refused the order (HTTP 403): Key revoked X-Injected: 1 [31m red end"]);
  assert.ok(!/[\p{Cc}\p{Cf}\u2028\u2029]/u.test(messages[0]));
});

test("purchase: a long reason is cut at 300 characters", async () => {
  const { messages } = await refused({ status: 403, body: JSON.stringify({ error: "é".repeat(400) }) });
  assert.equal(messages[0], `Parlox refused the order (HTTP 403): ${"é".repeat(300)}…`);
});

test("purchase: only the error text is passed on, never the rest of the answer or the key", async () => {
  const echoed = await refused({ status: 401, body: JSON.stringify({ error: `Invalid secret key ${SECRET} (sk_parlox_${"d".repeat(64)})`, detail: "internal detail" }) });
  assert.deepEqual(echoed.messages, ["Parlox refused the order (HTTP 401): Invalid secret key [key] ([key])"]);
  const notText = await refused({ status: 403, body: JSON.stringify({ error: { code: "fetch_scope" }, message: "internal detail" }) });
  assert.deepEqual(notText.messages, ["Parlox answered HTTP 403"]);
  const blank = await refused({ status: 403, body: JSON.stringify({ error: " \u0000 " }) });
  assert.deepEqual(blank.messages, ["Parlox answered HTTP 403"]);
});

test("purchase: a key echoed with an invisible or a line-break character inside it shows no part of it", async () => {
  const key = `sk_parlox_${"0123456789abcdef".repeat(4)}`;
  const parts = (text) => [key.slice(0, 20), key.slice(20, 40), key.slice(40), key.slice(-12)].filter((p) => text.includes(p));
  for (const inside of ["‍", "​", "﻿", " ", "\n", "\u0000"]) {
    for (const echoed of [`${key.slice(0, 30)}${inside}${key.slice(30)}`, `${key.slice(0, 11)}${inside}${key.slice(11, 50)}${inside}${key.slice(50)}`]) {
      answers = [{ status: 401, body: JSON.stringify({ error: `Invalid secret key ${echoed}.` }) }];
      const errors = [];
      await make(errors, { secretKey: key }).purchase(ORDER);
      const message = errors.map((e) => e.message).join("\n");
      assert.equal(message, "Parlox refused the order (HTTP 401): Invalid secret key [key].", JSON.stringify(inside));
      assert.deepEqual(parts(message), [], JSON.stringify(inside));
    }
  }
  // A key-shaped value that is not this instance's key: a zero-width joiner inside it does not leave its tail.
  const other = `sk_parlox_${"9".repeat(30)}‍${"8".repeat(34)}`;
  answers = [{ status: 403, body: JSON.stringify({ error: `Revoked: ${other}` }) }];
  const errors = [];
  await make(errors).purchase(ORDER);
  assert.deepEqual(errors.map((e) => e.message), ["Parlox refused the order (HTTP 403): Revoked: [key]"]);
});

test("crawler reports keep the short message: the reason is not read for them", async () => {
  answers = [{ status: 403, body: JSON.stringify({ error: FETCH_KEY_ERROR }) }];
  const errors = [];
  await make(errors).report({ method: "GET", path: "/p/1", host: "shop.example.com", header: (n) => (n === "user-agent" ? "curl/8" : null) });
  assert.deepEqual(errors.map((e) => e.message), ["Parlox answered HTTP 403"]);
});

// ── The purchase cap shared by every instance in the process ──

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, what, ms = 5000) {
  const end = Date.now() + ms;
  while (!check()) { if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await wait(5); }
}

// The documented rule: each instance compares the number in flight in the whole process with its own limit.
test("the purchase cap: each instance compares the process-wide count with its own maxPurchasesInFlight", async () => {
  let release;
  held = new Promise((r) => (release = r));
  arrived = 0;
  const errors = [];
  const low = make(errors, { maxPurchasesInFlight: 2 });
  const high = make(errors, { maxPurchasesInFlight: 4 });
  const order = (i) => ({ order_id: `cap${i}`, value_cents: 100, currency: "USD" });
  const posted = [];
  try {
    for (let i = 0; i < 3; i++) posted.push(high.purchase(order(i)));
    await until(() => arrived === 3, "three purchases in flight");
    assert.deepEqual(await low.purchase(order(3)), { ok: false, status: 0 }, "3 in flight: past low's own limit");
    posted.push(high.purchase(order(4)));
    await until(() => arrived === 4, "high's fourth, under its own limit");
    assert.deepEqual(await high.purchase(order(5)), { ok: false, status: 0 }, "4 in flight: high's own limit");
    assert.deepEqual(errors.map((e) => e.message), [
      "purchase: 2 purchases are already being posted; this one was not sent (retry it)",
      "purchase: 4 purchases are already being posted; this one was not sent (retry it)",
    ]);
  } finally { held = null; release(); }
  assert.ok((await Promise.all(posted)).every((r) => r.ok));
  assert.deepEqual(await low.purchase(order(6)), { ok: true, status: 200 }, "back under low's limit");
});

// Last, after every test above: what the SDK wrote to the log while they ran.
test("the log lines these tests provoked are the SDK's own, each said at most once per instance", () => {
  checkLogLines();
});
