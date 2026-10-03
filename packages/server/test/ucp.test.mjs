// ucp(): reports from the merchant's own UCP server, one request each. Run against the built package (dist/), the way
// a merchant's server loads it.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { createRequire } from "node:module";
import { createParlox } from "../dist/esm/index.js";
import { parloxFetch } from "../dist/esm/fetch.js";

// A stand-in gateway. Each request gets the next scripted answer ({ status, body, until }), else 200 {"accepted":1}. An
// answer with `until` waits for that promise; while `held` is set every answer waits for it.
let server, endpoint, answers = [], arrived = [], held = null;
before(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      arrived.push({ method: req.method, path: req.url, auth: req.headers.authorization, type: req.headers["content-type"], body: JSON.parse(body) });
      const a = answers.shift() ?? { status: 200, body: '{"accepted":1}' };
      if (a.until) await a.until;
      if (held) await held;
      res.writeHead(a.status, { "content-type": "application/json" }).end(a.body);
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  endpoint = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.closeAllConnections?.(); server.close(); });
const reset = () => { answers = []; arrived = []; held = null; };
const hold = () => { let release; held = new Promise((r) => (release = r)); return () => { held = null; release(); }; };

const SECRET = "sk_" + "b".repeat(64);
const ORDERS_KEY = "sk_" + "d".repeat(64);
const FETCH_KEY_ERROR = "This key can only send crawler reports. To record orders or UCP reports, create a send key in the dashboard (Settings → Keys).";
const EMPTY = "secretKey was given but is empty: set PARLOX_ORDERS_KEY (or the variable you pass) — Parlox did not fall back to PARLOX_SECRET_KEY";
const OPS = ["discovery", "catalog_search", "catalog_lookup", "catalog_product", "checkout_create", "checkout_get", "checkout_update", "checkout_complete", "checkout_cancel", "order_get", "order_update", "handoff_opened", "handoff_linked", "handoff_completed"];
const STATUSES = ["incomplete", "requires_escalation", "ready_for_complete", "complete_in_progress", "completed", "canceled"];
const UNKNOWN_OP = `ucp: op must be one of ${OPS.join(", ")}; this report was not sent`;
const BUSY = (n) => `ucp: ${n} UCP reports are already being sent; this one was not sent (retry it)`;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, what, ms = 5000) { const end = Date.now() + ms; while (!check()) { if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await wait(5); } }
const messages = (errors) => errors.map((e) => (e instanceof Error ? e.message : String(e)));
const warnings = (warn) => warn.mock.calls.map((c) => c.arguments.map(String).join(" "));
const make = (errors = [], over = {}) => createParlox({ secretKey: SECRET, endpoint, ipHeader: null, onError: (e) => errors.push(e), ...over });

/** Runs `fn` with these environment variables set (undefined: unset), then puts them back as they were. */
async function withEnv(vars, fn) {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { return await fn(); }
  finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
}

/** The one event ucp(report, context) sends, as the gateway receives it. */
async function sent(report, context) {
  reset();
  const errors = [];
  const result = await make(errors).ucp(report, context);
  assert.deepEqual(result, { ok: true, status: 200 }, messages(errors).join("\n"));
  assert.equal(arrived.length, 1);
  assert.equal(arrived[0].body.events.length, 1);
  return arrived[0].body.events[0];
}

// ── The request ──

test("ucp: one request of its own to /v1/s with the key: { events: [{ ucp: report, ...context }] }, resolving { ok, status }", async () => {
  const report = {
    op: "checkout_complete", http_status: 200, ms: 87, checkout_id: "chk_123", order_id: "ord_9", checkout_status: "completed",
    codes: [{ type: "warning", code: "final_sale", severity: "advisory", path: "$.line_items[1]" }],
    total_cents: 12_998, items: 2, item_ids: ["tent-2p", "stove-mini"], discount_codes: ["SPRING10"], fulfillment: "standard",
    query: "two person tent", results: 4, platform: "agent.example.com",
  };
  const context = { ua: "AgentPlatform/1.0", ip: "203.0.113.9", ip_hash: "ab".repeat(32), sid: "0123456789abcdef", path: "/checkout-sessions/chk_123/complete" };
  reset();
  const errors = [];
  assert.deepEqual(await make(errors).ucp(report, context), { ok: true, status: 200 });
  assert.deepEqual(messages(errors), []);
  assert.equal(arrived.length, 1);
  const [r] = arrived;
  assert.equal(r.method, "POST");
  assert.equal(r.path, "/v1/s");
  assert.equal(r.auth, `Bearer ${SECRET}`);
  assert.equal(r.type, "application/json");
  assert.deepEqual(r.body, { events: [{ ucp: report, ...context }] });
});

test("ucp: without a context only the report is sent, and the address only when the caller passes it", async () => {
  assert.deepEqual(await sent({ op: "catalog_search", query: "tents", results: 4 }), { ucp: { op: "catalog_search", query: "tents", results: 4 } });
  assert.deepEqual(await sent({ op: "discovery" }, { ua: "AgentPlatform/1.0" }), { ucp: { op: "discovery" }, ua: "AgentPlatform/1.0" });
  assert.deepEqual(await sent({ op: "discovery", http_status: null, checkout_id: null }, { ip: undefined, sid: null }), { ucp: { op: "discovery" } }, "null and undefined are left out");
});

test("ucp: Parlox's answer is what resolves; a failure is told to onError; it never rejects", async () => {
  reset();
  answers = [{ status: 500, body: "{}" }];
  const errors = [];
  assert.deepEqual(await make(errors).ucp({ op: "discovery" }), { ok: false, status: 500 });
  assert.deepEqual(messages(errors), ["Parlox answered HTTP 500"]);
  // A report whose getter throws is told to onError too.
  const report = { op: "discovery", get http_status() { throw new Error("boom"); } };
  const more = [];
  assert.deepEqual(await make(more).ucp(report), { ok: false, status: 0 });
  assert.deepEqual(messages(more), ["boom"]);
});

test("ucp: the fetch adapter and the CommonJS build expose it beside purchase()", async () => {
  reset();
  const viaFetch = parloxFetch({ secretKey: SECRET, endpoint, ipHeader: null });
  assert.equal(typeof viaFetch.purchase, "function");
  assert.deepEqual(await viaFetch.ucp({ op: "discovery" }, { ua: "AgentPlatform/1.0" }), { ok: true, status: 200 });
  const { createParlox: createParloxCjs } = createRequire(import.meta.url)("../dist/cjs/index.cjs");
  const { parloxFetch: parloxFetchCjs } = createRequire(import.meta.url)("../dist/cjs/fetch.cjs");
  assert.deepEqual(await createParloxCjs({ secretKey: SECRET, endpoint, ipHeader: null }).ucp({ op: "catalog_lookup" }), { ok: true, status: 200 });
  assert.deepEqual(await parloxFetchCjs({ secretKey: SECRET, endpoint, ipHeader: null }).ucp({ op: "catalog_product" }), { ok: true, status: 200 });
  assert.deepEqual(arrived.map((a) => a.body), [
    { events: [{ ucp: { op: "discovery" }, ua: "AgentPlatform/1.0" }] },
    { events: [{ ucp: { op: "catalog_lookup" } }] },
    { events: [{ ucp: { op: "catalog_product" } }] },
  ]);
});

// ── Bounds: each field the way Parlox keeps it ──

/** Each case: [given, sent] (undefined: left out). */
const REPORT_CASES = {
  http_status: [[201, 201], [99, 100], [600, 599], [201.6, 202], ["200", undefined], [NaN, undefined], [Infinity, undefined]],
  ms: [[42, 42], [-5, 0], [700_000, 600_000], [12.4, 12], ["12", undefined]],
  checkout_id: [["chk_1:a/b.c-d", "chk_1:a/b.c-d"], ["c".repeat(150), "c".repeat(100)], ["has space", undefined], ["chk\n1", undefined], ["", undefined], [5, undefined]],
  order_id: [["ord_1", "ord_1"], ["o".repeat(80), "o".repeat(64)], ["ord#1", undefined]],
  checkout_status: [...STATUSES.map((s) => [s, s]), ["Completed", undefined], ["done", undefined], ["x".repeat(40), undefined]],
  total_cents: [[4990, 4990], [-1, 0], [2e11, 1e11], [49.5, 50]],
  items: [[2, 2], [20_000, 10_000], [-3, 0]],
  results: [[12, 12], [2e6, 1e6], [-1, 0]],
  fulfillment: [["std-ship_1:a.b", "std-ship_1:a.b"], ["f".repeat(70), "f".repeat(60)], ["std ship", undefined], ["std/ship", undefined]],
  query: [["tents", "tents"], ["q".repeat(300), "q".repeat(200)], ["", undefined], [42, undefined],
    // A cut never splits a character, and a lone half of one becomes U+FFFD (neither can be stored as text).
    ["a".repeat(199) + "😀", "a".repeat(199)], ["\uD800tent", "\uFFFDtent"]],
  platform: [["agent.example.com", "agent.example.com"], ["Agent.Example.com", undefined], ["a".repeat(300), "a".repeat(253)], ["agent.example.com:443", undefined]],
  item_ids: [
    [["sku_1", "sku 2", 3, "i".repeat(120), ...Array(10).fill("x")], ["sku_1", "i".repeat(100), "x", "x", "x", "x", "x", "x"]],
    [["bad id"], []], [[], []], ["sku_1", undefined],
  ],
  discount_codes: [[["SAVE10", "summer10", "VIP_1-A", "D".repeat(40), "A", "B"], ["SAVE10", "VIP_1-A", "D".repeat(30), "A"]], ["SAVE10", undefined]],
  codes: [
    [[
      { type: "error", code: "out_of_stock", severity: "recoverable", path: "$.line_items[0]" },
      null,
      "x",
      { code: "bad code" },
      { type: "Warning", code: "c".repeat(70), severity: "Requires Buyer Input", path: "p".repeat(100) },
      { type: "info_message_long", code: "x.y-z_1", severity: null, path: "" },
      ...Array.from({ length: 6 }, () => ({ code: "k" })),
    ], [
      { type: "error", code: "out_of_stock", severity: "recoverable", path: "$.line_items[0]" },
      { code: "c".repeat(60), path: "p".repeat(80) },
      { type: "info_message", code: "x.y-z_1" },
      { code: "k" }, { code: "k" }, { code: "k" }, { code: "k" },
    ]],
    [[{ code: "bad code" }], undefined], [[], undefined], [{ code: "x" }, undefined],
  ],
};

for (const [field, cases] of Object.entries(REPORT_CASES)) {
  test(`ucp bounds: ${field}`, async () => {
    for (const [given, expected] of cases) {
      const { ucp } = await sent({ op: "checkout_get", [field]: given });
      assert.deepEqual(ucp, expected === undefined ? { op: "checkout_get" } : { op: "checkout_get", [field]: expected }, `${field}: ${JSON.stringify(given)?.slice(0, 80)}`);
    }
  });
}

test("ucp bounds: fields Parlox does not read are not sent", async () => {
  const { ucp, ...context } = await sent(
    { op: "checkout_update", escalated: true, buyer_email: "jane@example.com", buyer: { name: "Jane" }, phone: "5551234567" },
    { referer: "https://example.com", email: "jane@example.com", ua: "AgentPlatform/1.0" },
  );
  assert.deepEqual(ucp, { op: "checkout_update" });
  assert.deepEqual(context, { ua: "AgentPlatform/1.0" });
});

/** Each case: [given, sent] (undefined: left out). */
const CONTEXT_CASES = {
  ua: [["AgentPlatform/1.0", "AgentPlatform/1.0"], ["u".repeat(1500), "u".repeat(1000)], ["", undefined], [5, undefined]],
  ip: [["203.0.113.9", "203.0.113.9"], [" 203.0.113.9 ", "203.0.113.9"], ["2001:db8::1", "2001:db8::1"], ["::ffff:203.0.113.9", "::ffff:203.0.113.9"],
    ["not-an-ip", undefined], ["01.2.3.4", undefined], ["256.1.1.1", undefined], ["fe80::1%eth0", undefined], ["203.0.113.9, 10.0.0.1", undefined], ["", undefined], [5, undefined]],
  ip_hash: [["a".repeat(64), "a".repeat(64)], ["0123456789abcdef", "0123456789abcdef"], ["abc", undefined], ["A".repeat(64), undefined], ["a".repeat(65), undefined]],
  sid: [["0123456789abcdef", "0123456789abcdef"], ["f".repeat(32), "f".repeat(32)], ["xyz", undefined], ["0".repeat(33), undefined], ["0123456789ABCDEF", undefined]],
  path: [["/checkout-sessions/chk_1", "/checkout-sessions/chk_1"], ["/catalog/search?q=jane@example.com", "/catalog/search"], ["/p#frag", "/p"],
    ["/" + "p".repeat(2500), "/" + "p".repeat(1999)], ["?q=1", undefined], ["", undefined], [5, undefined]],
};

for (const [field, cases] of Object.entries(CONTEXT_CASES)) {
  test(`ucp bounds: context ${field}`, async () => {
    for (const [given, expected] of cases) {
      const event = await sent({ op: "catalog_search" }, { [field]: given });
      assert.deepEqual(event, expected === undefined ? { ucp: { op: "catalog_search" } } : { ucp: { op: "catalog_search" }, [field]: expected }, `${field}: ${JSON.stringify(given)?.slice(0, 80)}`);
    }
  });
}

test("ucp bounds: every address it sends is one Node's net.isIP accepts (Parlox's own check), and it drops what that check drops", async () => {
  // Hand-picked edge cases, then random ones built like addresses (some valid, most nearly so).
  const samples = ["::", "::1", "1::", "1:2:3:4:5:6:7:8", "1:2:3:4:5:6:7::", "::2:3:4:5:6:7:8", "1::2::3", "12345::1", "1:2:3:4:5:6:7:8:9",
    "::ffff:1.2.3.4", "::ffff:01.2.3.4", "1:2:3:4:5:6:1.2.3.4", "1:2:3:4:5:6:7:1.2.3.4", "0.0.0.0", "255.255.255.255", "1.2.3", "1.2.3.4.5", "2001:DB8::A"];
  let seed = 7;
  const rand = (n) => { seed = (seed * 48271) % 2147483647; return seed % n; }; // Park–Miller: exact in a double
  const hex = "0123456789abcdefABCDEF";
  const octet = () => (rand(8) === 0 ? "0" : "") + String(rand(300));
  const v4 = () => Array.from({ length: rand(3) === 0 ? 3 : 4 }, octet).join("."); // some with three parts
  for (let i = 0; i < 300; i++) samples.push(v4());
  for (let i = 0; i < 500; i++) {
    const groups = Array.from({ length: 1 + rand(9) }, () => Array.from({ length: rand(6) }, () => hex[rand(hex.length)]).join(""));
    samples.push(groups.join(":") + (rand(4) === 0 ? `:${v4()}` : ""));
  }
  const events = [];
  for (let i = 0; i < samples.length; i += 50) {
    reset();
    const p = make([], { maxUcpReportsInFlight: 50 });
    await Promise.all(samples.slice(i, i + 50).map((ip) => p.ucp({ op: "catalog_search" }, { ip })));
    events.push(...arrived.map((a) => a.body.events[0]));
  }
  assert.equal(events.length, samples.length);
  let accepted = 0;
  for (const e of events) {
    if (e.ip === undefined) continue;
    accepted++;
    assert.notEqual(net.isIP(e.ip), 0, e.ip);
  }
  const valid = samples.filter((s) => net.isIP(s) !== 0);
  assert.equal(accepted, valid.length, "every address net.isIP accepts (none here has a zone id) is sent");
  assert.ok(valid.length >= 100 && valid.length < samples.length - 100, `found ${valid.length} of ${samples.length}`);
});

// ── The search query is masked ──

test("ucp: emails and runs of 4 or more digits in the query are masked before it is sent", async () => {
  const cases = [
    ["email me at john.doe+tag@example.co.uk or call 0123456789", "email me at [email] or call [number]"],
    ["card 4242 4242 4242 4242, size 10, zip 123", "card [number] [number] [number] [number], size 10, zip 123"],
    ["tent for josé.núñez@correo.es", "tent for [email]"],
    ["order １２３４５ or ٠١٢٣٤", "order [number] or [number]"],
    // Masked first, then cut: an email across the 200th character is masked whole, never cut in half.
    ["x".repeat(190) + " jane@example.com tents", "x".repeat(190) + " [email] t"],
    ["1234 ".repeat(60), "[number] ".repeat(60).slice(0, 200)],
  ];
  for (const [query, expected] of cases) {
    const { ucp } = await sent({ op: "catalog_search", query });
    assert.equal(ucp.query, expected, query.slice(0, 60));
  }
});

test("ucp: a very long query is read up to 1000 characters, and the word the cut falls in is dropped, so no part of an email or number goes out", async () => {
  // Past 1000 characters, an email that starts before the cut: its start must not be sent unmasked.
  const longEmail = "1".repeat(995) + " jane.doe@example.com";
  const { ucp: a } = await sent({ op: "catalog_search", query: longEmail });
  assert.equal(a.query, "[number] ");
  assert.doesNotMatch(a.query, /jane/);
  // A digit run cut at the same place is dropped whole rather than sent as three digits.
  const longDigits = "tents ".repeat(166) + "1234567890";
  const { ucp: b } = await sent({ op: "catalog_search", query: longDigits });
  assert.equal(b.query, "tents ".repeat(166).slice(0, 200));
  // Reading stops there, so a huge query costs no more than a long one.
  const started = Date.now();
  const { ucp: c } = await sent({ op: "catalog_search", query: "a".repeat(2_000_000) });
  assert.equal(c.query, undefined, "a single word longer than the read limit is left out whole");
  assert.ok(Date.now() - started < 2000, `${Date.now() - started} ms`);
});

// ── An unknown op ──

test("ucp: an op outside the list sends nothing and tells onError which ops there are", async () => {
  for (const report of [{ op: "checkout_finish" }, { op: "CHECKOUT_CREATE" }, { op: "checkout_create " }, {}, { op: 5 }, null, undefined, "checkout_create"]) {
    reset();
    const errors = [];
    assert.deepEqual(await make(errors).ucp(report), { ok: false, status: 0 }, JSON.stringify(report));
    assert.deepEqual(arrived, [], JSON.stringify(report));
    assert.deepEqual(messages(errors), [UNKNOWN_OP], JSON.stringify(report));
  }
  // Every op in the list is sent.
  for (const op of OPS) assert.equal((await sent({ op })).ucp.op, op);
});

// ── A key Parlox refuses ──

test("ucp: a crawler-only key's 403 gives onError Parlox's reason every time, and the log says it once per instance", async (t) => {
  reset();
  const warn = t.mock.method(console, "warn", () => {});
  const refusal = { status: 403, body: JSON.stringify({ error: FETCH_KEY_ERROR }) };
  answers = [refusal, refusal];
  const errors = [];
  const p = make(errors);
  assert.deepEqual(await p.ucp({ op: "checkout_create" }), { ok: false, status: 403 });
  assert.deepEqual(await p.ucp({ op: "checkout_get" }), { ok: false, status: 403 });
  assert.deepEqual(messages(errors), [`Parlox refused the UCP report (HTTP 403): ${FETCH_KEY_ERROR}`, `Parlox refused the UCP report (HTTP 403): ${FETCH_KEY_ERROR}`]);
  assert.deepEqual(warnings(warn), [`@parlox/server: Parlox refused the UCP report (HTTP 403): ${FETCH_KEY_ERROR} (said once per instance; onError receives every refusal)`]);
  // An order refused by the same instance is said once for itself: the two lines are kept apart.
  answers = [refusal];
  await p.purchase({ order_id: "1001", value_cents: 100, currency: "USD" });
  assert.equal(warnings(warn).length, 2);
  assert.match(warnings(warn)[1], /^@parlox\/server: Parlox refused the order \(HTTP 403\)/);
});

test("ucp: a 401 is said the same way, and no part of the key appears", async (t) => {
  reset();
  const warn = t.mock.method(console, "warn", () => {});
  answers = [{ status: 401, body: JSON.stringify({ error: `Invalid secret key ${SECRET}` }) }];
  const errors = [];
  assert.deepEqual(await make(errors).ucp({ op: "discovery" }), { ok: false, status: 401 });
  assert.deepEqual(messages(errors), ["Parlox refused the UCP report (HTTP 401): Invalid secret key [key]"]);
  const said = warnings(warn);
  assert.equal(said.length, 1, said.join("\n"));
  assert.equal(said[0].includes(SECRET.slice(3, 20)), false);
});

// ── Never batched ──

test("ucp: its own request is never batched with queued crawler reports, never waits for the queue's request, and carries none of their dropped count", async () => {
  reset();
  const bot = (path) => ({ method: "GET", path, host: "shop.example.com", header: (n) => (n === "user-agent" ? "curl/8" : null) });
  let releaseBatch;
  answers = [{ status: 200, body: '{"accepted":2}', until: new Promise((r) => (releaseBatch = r)) }];
  const p = make([], { flushAt: 2, maxQueueSize: 2, flushIntervalMs: 60_000 });
  // The queue's first batch goes and is kept waiting; then its queue fills, and the oldest report is dropped.
  for (const path of ["/a", "/b"]) p.enqueue(bot(path));
  await until(() => arrived.length === 1, "the queue's first batch, in flight");
  for (const path of ["/c", "/d", "/e"]) p.enqueue(bot(path));
  await until(() => p.pending === 2 && p.dropped === 1, "two reports queued, one dropped");
  try {
    assert.deepEqual(await p.ucp({ op: "checkout_create", checkout_id: "chk_1" }), { ok: true, status: 200 }, "answered while the batch still waits");
    assert.deepEqual(arrived[1].body, { events: [{ ucp: { op: "checkout_create", checkout_id: "chk_1" } }] });
    assert.equal(p.pending, 2, "the queue is left as it was");
    assert.equal(p.dropped, 1);
  } finally { releaseBatch(); }
  await p.flush();
  assert.equal(arrived.length, 3);
  assert.deepEqual(arrived[0].body.events.map((e) => e.path), ["/a", "/b"]);
  assert.deepEqual(arrived[2].body.events.map((e) => e.path), ["/d", "/e"]);
  assert.deepEqual(arrived[2].body.meta, { dropped: 1 }, "the dropped count goes with the queue's next batch");
});

// ── The in-flight cap ──

test("ucp: at most 10 in flight in the process (every instance, both builds); beyond that it resolves { ok: false, status: 0 } at once and says why", async () => {
  reset();
  const release = hold();
  const errors = [];
  const a = make(errors, { timeoutMs: 5000 });
  const b = make(errors, { timeoutMs: 5000 });
  const { createParlox: createParloxCjs } = createRequire(import.meta.url)("../dist/cjs/index.cjs");
  const c = createParloxCjs({ secretKey: SECRET, endpoint, ipHeader: null, timeoutMs: 5000, onError: (e) => errors.push(e) });
  const first = [...Array.from({ length: 5 }, () => a.ucp({ op: "catalog_search" })), ...Array.from({ length: 5 }, () => b.ucp({ op: "catalog_search" }))];
  let purchase;
  try {
    await until(() => arrived.length === 10, "ten UCP reports in flight");
    for (const p of [a, b, c]) assert.deepEqual(await Promise.race([p.ucp({ op: "discovery" }), wait(2000).then(() => "sent and waiting")]), { ok: false, status: 0 });
    assert.deepEqual(messages(errors), [BUSY(10), BUSY(10), BUSY(10)]);
    // Purchases have slots of their own: a UCP flood never holds back an order.
    purchase = a.purchase({ order_id: "1001", value_cents: 100, currency: "USD" });
    await until(() => arrived.length === 11, "the purchase, sent while ten UCP reports wait");
  } finally { release(); }
  assert.ok((await Promise.all(first)).every((r) => r.ok));
  assert.deepEqual(await purchase, { ok: true, status: 200 });
  assert.equal(arrived.length, 11, "the refused reports were not sent");
  assert.deepEqual(await c.ucp({ op: "discovery" }), { ok: true, status: 200 }, "the slots are free again");
});

test("ucp: maxUcpReportsInFlight sets the cap", async () => {
  reset();
  const release = hold();
  const errors = [];
  const p = make(errors, { maxUcpReportsInFlight: 2, timeoutMs: 5000 });
  const first = [p.ucp({ op: "catalog_search" }), p.ucp({ op: "catalog_search" })];
  try {
    await until(() => arrived.length === 2, "two in flight");
    assert.deepEqual(await p.ucp({ op: "catalog_search" }), { ok: false, status: 0 });
    assert.deepEqual(messages(errors), [BUSY(2)]);
  } finally { release(); }
  assert.ok((await Promise.all(first)).every((r) => r.ok));
});

// ── The key ──

test("ucp: the key comes from secretKey alone when the option is given; without the option, PARLOX_SECRET_KEY", async (t) => {
  await withEnv({ PARLOX_SECRET_KEY: SECRET, PARLOX_ORDERS_KEY: undefined }, async () => {
    reset();
    const warn = t.mock.method(console, "warn", () => {});
    const errors = [];
    const unset = createParlox({ secretKey: process.env.PARLOX_ORDERS_KEY, endpoint, onError: (e) => errors.push(e) });
    assert.deepEqual(await unset.ucp({ op: "checkout_create" }), { ok: false, status: 0 });
    assert.deepEqual(await unset.ucp({ op: "checkout_create" }), { ok: false, status: 0 });
    assert.deepEqual(arrived, [], "nothing is sent, with either key");
    assert.deepEqual(messages(errors), [EMPTY], "onError is told once");
    assert.deepEqual(warnings(warn), [`@parlox/server: ${EMPTY}`], "said once in the log");
    const own = createParlox({ secretKey: ORDERS_KEY, endpoint });
    assert.deepEqual(await own.ucp({ op: "checkout_create" }), { ok: true, status: 200 });
    assert.equal(arrived[0].auth, `Bearer ${ORDERS_KEY}`, "the option's key, not PARLOX_SECRET_KEY");
    const fromEnv = createParlox({ endpoint });
    assert.deepEqual(await fromEnv.ucp({ op: "checkout_create" }), { ok: true, status: 200 });
    assert.equal(arrived[1].auth, `Bearer ${SECRET}`);
  });
});
