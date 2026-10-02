// Behaviour of @parlox/browser on a page (happy-dom), against the built package. Each test gets a fresh window and a
// fresh copy of the module, so nothing leaks between them. Real-browser checks (Chromium, Firefox, WebKit) are in the
// QA suite; these pin the rules that protect the merchant's page and its visitors.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { createRequire } from "node:module";

// The CommonJS build is one self-contained file, so clearing it from the require cache gives each test a truly fresh
// module (the ES build shares a chunk that Node's module cache would keep between tests).
const require = createRequire(import.meta.url);
const CJS = require.resolve("../dist/cjs/index.cjs");

const KEY = "pk_0123456789abcdef01234567";
const ENDPOINT = "https://gateway.test";
let storageDescriptor = null;

// Fresh page at `url`; window.fetch is stubbed before the tracker loads so every beacon is captured.
async function page(url = "https://shop.example.com/", { referrer = "", setup } = {}) {
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
  GlobalRegistrator.register({ url, width: 1280, height: 800 });
  // The registrator reuses globalThis as the window, so the previous test's page state is cleared by hand.
  delete window.__plxStarted; delete window.parlox; delete window.dataLayer;
  if (storageDescriptor) Object.defineProperty(window, "sessionStorage", storageDescriptor);
  storageDescriptor = Object.getOwnPropertyDescriptor(window, "sessionStorage");
  try { sessionStorage.clear(); } catch { /* blocked in one test */ }
  if (referrer) Object.defineProperty(document, "referrer", { value: referrer, configurable: true });
  const beacons = [];
  const pageFetches = [];
  window.fetch = async (input, init) => {
    const u = typeof input === "string" ? input : input.url;
    if (u.startsWith(ENDPOINT)) { beacons.push({ url: u, body: JSON.parse(init.body) }); return new Response(null, { status: 204 }); }
    pageFetches.push(u);
    return new Response(u.includes("/cart/add.js") ? JSON.stringify({ quantity: 2, product_id: 42, final_line_price: 9980 }) : "page-data", { status: 200 });
  };
  navigator.sendBeacon = (u, body) => { beacons.push({ url: u, body: JSON.parse(body), beacon: true }); return true; };
  if (setup) setup();
  delete require.cache[CJS];
  const mod = require(CJS);
  return { mod, beacons, pageFetches, events: () => beacons.flatMap((b) => b.body.events || []) };
}
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

afterEach(async () => { if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister(); });

test("a page view is sent at once, with the key, a tab session id and a URL stripped of tokens and private query", async () => {
  const { mod, beacons } = await page("https://shop.example.com/checkouts/cn/Z2NwLWV1cm9wZS13ZXN0NDpxYz12Y2E?key=secret&utm_source=chatgpt.com&email=a@b.co");
  mod.init({ publicKey: KEY, endpoint: ENDPOINT, recordAgents: false });
  await tick();
  assert.equal(beacons.length, 1);
  const b = beacons[0];
  assert.equal(b.url, `${ENDPOINT}/v1/b`);
  assert.equal(b.body.k, KEY);
  assert.match(b.body.sid, /^[a-f0-9]{24}$/);
  assert.equal(b.body.url, "https://shop.example.com/checkouts/cn/:token?utm_source=chatgpt.com");
  assert.equal(b.body.events[0].ev, "page_view");
});

test("the referrer leaves the page as an origin only (another site) or token-free (this site)", async () => {
  let p = await page("https://shop.example.com/", { referrer: "https://chatgpt.com/c/68d1f0aa-1111-2222-3333-444455556666?q=my+address" });
  p.mod.init({ publicKey: KEY, endpoint: ENDPOINT, recordAgents: false });
  await tick();
  assert.equal(p.beacons[0].body.ref, "https://chatgpt.com/");
  p = await page("https://shop.example.com/thanks", { referrer: "https://shop.example.com/account/reset/123/abcdefABCDEF1234567890?x=1" });
  p.mod.init({ publicKey: KEY, endpoint: ENDPOINT, recordAgents: false });
  await tick();
  assert.equal(p.beacons[0].body.ref, "https://shop.example.com/account/reset/:token");
});

test("no cookie is ever set, and typed values never leave the page", async () => {
  const { mod, beacons } = await page();
  document.body.innerHTML = `<form id="f" action="/checkout"><input id="email" name="email" type="email"><input name="card" autocomplete="cc-number"><button type="submit">Pay 1234 5678</button></form>`;
  mod.init({ publicKey: KEY, endpoint: ENDPOINT, recordAgents: false });
  const email = document.getElementById("email");
  email.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
  email.value = "jane.doe@example.com";
  email.dispatchEvent(new Event("change", { bubbles: true }));
  document.querySelector("[name=card]").value = "4242424242424242";
  document.querySelector("button").dispatchEvent(new MouseEvent("click", { bubbles: true }));
  await tick(1100);
  window.dispatchEvent(new Event("pagehide"));
  await tick();
  const all = JSON.stringify(beacons);
  // Every field but the random ids: a random event or session id can contain "4242" by chance (one did, failing CI).
  const typed = JSON.stringify(beacons, (k, v) => (k === "eid" || k === "sid" ? undefined : v));
  assert.equal(document.cookie, "");
  assert.ok(!all.includes("jane.doe"), "a typed email is never sent");
  assert.ok(!all.includes("4242424242424242"), "a typed card number is never sent, anywhere");
  assert.ok(!typed.includes("4242"), "no part of a typed card number is sent");
  assert.ok(!all.includes("1234 5678"), "digit runs in labels are masked");
  assert.ok(all.includes('"field_focus"') && all.includes('"email"'), "the field's name is recorded");
});

test("track() records commerce with the tier it came from; unknown names and junk properties are dropped", async () => {
  const { mod, events } = await page();
  mod.init({ publicKey: KEY, endpoint: ENDPOINT, recordAgents: false });
  mod.track("add_to_cart", { item_id: "sku-1", value: 49.9, currency: "usd", items: 1, email: "x@y.z" });
  mod.track("steal_cookies", { value: 1 });
  await tick();
  const add = events().find((e) => e.ev === "add_to_cart");
  assert.deepEqual(add.props, { via: "api", value: 49.9, currency: "USD", items: 1, item_id: "sku-1" });
  assert.ok(!events().some((e) => e.ev === "steal_cookies"));
});

test("calls made before init are kept and replayed in order", async () => {
  const { mod, events } = await page();
  mod.track("view_item", { item_id: "a" });
  mod.init({ publicKey: KEY, endpoint: ENDPOINT, recordAgents: false });
  window.dispatchEvent(new Event("pagehide")); // view_item waits for the 5 s flush; leaving the page sends it now
  await tick();
  assert.ok(events().some((e) => e.ev === "view_item" && e.props.item_id === "a"));
});

test("the data layer keeps working exactly as before, and GA4 ecommerce events are read from it", async () => {
  const { mod, events } = await page("https://shop.example.com/", { setup: () => { window.dataLayer = [{ event: "view_item", ecommerce: { items: [{ item_id: "p1" }] } }]; } });
  const originalPush = window.dataLayer.push;
  mod.init({ publicKey: KEY, endpoint: ENDPOINT, recordAgents: false });
  assert.notEqual(window.dataLayer.push, originalPush);
  const r = window.dataLayer.push({ event: "add_to_cart", ecommerce: { value: "19.90", currency: "EUR", items: [{ item_id: "p1" }] } });
  assert.equal(r, 2, "push returns what Array.prototype.push returns");
  assert.equal(window.dataLayer.length, 2);
  await tick();
  const evs = events();
  assert.ok(evs.some((e) => e.ev === "view_item" && e.props.via === "datalayer"), "earlier pushes are read too");
  assert.ok(evs.some((e) => e.ev === "add_to_cart" && e.props.value === 19.9 && e.props.currency === "EUR"));
});

test("the page's own fetch still returns the same response; a Shopify cart add is recorded as a platform fact", async () => {
  const { mod, events, pageFetches } = await page();
  mod.init({ publicKey: KEY, endpoint: ENDPOINT, recordAgents: false });
  const res = await window.fetch("/products.json");
  assert.equal(await res.text(), "page-data");
  const add = await window.fetch("/cart/add.js", { method: "POST" });
  assert.equal(add.status, 200);
  await tick(10);
  mod.track("purchase", {}); // flushes pending events
  await tick();
  assert.deepEqual(pageFetches, ["/products.json", "/cart/add.js"]);
  const a = events().find((e) => e.ev === "add_to_cart");
  assert.equal(a.props.via, "platform_api");
  assert.equal(a.props.items, 2);
  assert.equal(a.props.value, 99.8);
});

test("history.pushState keeps its behaviour and a route change is a new page view", async () => {
  const { mod, events } = await page();
  mod.init({ publicKey: KEY, endpoint: ENDPOINT, recordAgents: false });
  const r = history.pushState({ a: 1 }, "", "/collections/tents");
  assert.equal(r, undefined);
  assert.deepEqual(history.state, { a: 1 });
  await tick(5);
  const views = events().filter((e) => e.ev === "page_view");
  assert.equal(views.length, 2);
});

test("consent mode: nothing is stored or sent until consent(true); consent(false) stops and forgets the tab", async () => {
  const { mod, beacons } = await page();
  mod.init({ publicKey: KEY, endpoint: ENDPOINT, consent: "required", recordAgents: false });
  mod.track("add_to_cart", { value: 1 });
  await tick(20);
  assert.equal(beacons.length, 0);
  assert.equal(sessionStorage.getItem("_plx"), null);
  mod.consent(true);
  await tick();
  assert.ok(beacons.length >= 1);
  assert.ok(sessionStorage.getItem("_plx"));
  mod.consent(false);
  assert.equal(sessionStorage.getItem("_plx"), null);
  assert.equal(sessionStorage.getItem("_plx_q"), null);
});

test("an invalid key or endpoint does nothing (and says why in the console)", async () => {
  const { mod, beacons } = await page();
  const warn = console.warn; const warnings = []; console.warn = (m) => warnings.push(m);
  try {
    assert.equal(mod.init({ publicKey: 'pk_x"><script>' }), null);
    assert.equal(mod.init({ publicKey: KEY, endpoint: "http://evil.example" }), null);
  } finally { console.warn = warn; }
  await tick();
  assert.equal(beacons.length, 0);
  assert.equal(warnings.length, 2);
});

test("blocked storage (private mode, sandboxed frames) does not stop the tracker or break the page", async () => {
  const { mod, beacons } = await page("https://shop.example.com/", { setup: () => {
    Object.defineProperty(window, "sessionStorage", { get() { throw new DOMException("denied", "SecurityError"); }, configurable: true });
  } });
  assert.doesNotThrow(() => mod.init({ publicKey: KEY, endpoint: ENDPOINT, recordAgents: false }));
  await tick();
  assert.equal(beacons.length, 1);
});

test("a second init, or the hosted tag already on the page, does not start a second tracker", async () => {
  const { mod, beacons } = await page();
  const a = mod.init({ publicKey: KEY, endpoint: ENDPOINT, recordAgents: false });
  const b = mod.init({ publicKey: KEY, endpoint: ENDPOINT, recordAgents: false });
  assert.equal(a, b);
  await tick();
  assert.equal(beacons.filter((x) => x.body.events.some((e) => e.ev === "page_view")).length, 1);
});

test("leaving the page sends the final summary with sendBeacon", async () => {
  const { mod, beacons } = await page();
  mod.init({ publicKey: KEY, endpoint: ENDPOINT, recordAgents: false });
  await tick();
  window.dispatchEvent(new Event("pagehide"));
  const last = beacons[beacons.length - 1];
  assert.equal(last.beacon, true);
  assert.ok(last.body.events.some((e) => e.ev === "engagement" && e.props.final === true));
});

test("a page that froze fetch, XMLHttpRequest and history keeps working, and the tracker still counts it", async () => {
  const { mod, beacons } = await page("https://shop.example.com/", { setup: () => {
    Object.defineProperty(window, "fetch", { value: window.fetch, writable: false, configurable: true });
    Object.defineProperty(history, "pushState", { value: history.pushState, writable: false, configurable: true });
    Object.defineProperty(XMLHttpRequest.prototype, "open", { value: XMLHttpRequest.prototype.open, writable: false, configurable: true });
  } });
  let api;
  assert.doesNotThrow(() => { api = mod.init({ publicKey: KEY, endpoint: ENDPOINT, recordAgents: false }); });
  assert.ok(api, "the tracker started");
  await tick();
  assert.equal(beacons.length, 1);
  assert.doesNotThrow(() => history.pushState({}, "", "/x"));
  // Put the platform objects back for the tests that follow (the registrator reuses the window).
  Object.defineProperty(window, "fetch", { value: window.fetch, writable: true, configurable: true });
  Object.defineProperty(history, "pushState", { value: history.pushState, writable: true, configurable: true });
  Object.defineProperty(XMLHttpRequest.prototype, "open", { value: XMLHttpRequest.prototype.open, writable: true, configurable: true });
});

test("withdrawing consent forgets the session: a later consent(true) starts a new visit id", async () => {
  const { mod } = await page();
  mod.init({ publicKey: KEY, endpoint: ENDPOINT, recordAgents: false });
  const before = mod.sessionId();
  mod.consent(false);
  mod.consent(true);
  assert.notEqual(mod.sessionId(), before);
});

test("the CommonJS React entry and the main entry share one tracker", async () => {
  await page();
  const reactPath = require.resolve("../dist/cjs/react.cjs");
  delete require.cache[reactPath];
  const react = require(reactPath);
  const main = require(CJS);
  react.init({ publicKey: KEY, endpoint: ENDPOINT, recordAgents: false });
  assert.ok(main.sessionId(), "track()/sessionId() from the main entry see the tracker the React entry started");
  assert.equal(main.sessionId(), react.sessionId());
});

test("nothing tracked while consent is withdrawn is sent when consent is granted again", async () => {
  const { mod, events } = await page();
  mod.init({ publicKey: KEY, endpoint: ENDPOINT, recordAgents: false });
  mod.consent(false);
  mod.track("add_to_cart", { item_id: "refused-period", value: 1 });
  window.dataLayer.push({ event: "add_to_cart", ecommerce: { items: [{ item_id: "refused-dl" }] } });
  mod.consent(true);
  window.dispatchEvent(new Event("pagehide"));
  await tick();
  const all = JSON.stringify(events());
  assert.ok(!all.includes("refused-period") && !all.includes("refused-dl"));
});

test("a consent refusal queued after more than 100 stub calls is still honoured", async () => {
  const { mod, beacons } = await page("https://shop.example.com/", { setup: () => {
    const q = []; for (let i = 0; i < 120; i++) q.push(["track", "view_item", { item_id: "p" + i }]);
    q.push(["consent", false]);
    window.parlox = { q };
  } });
  mod.init({ publicKey: KEY, endpoint: ENDPOINT, recordAgents: false });
  await tick(20);
  assert.equal(beacons.length, 0, "the visitor refused: nothing is sent");
});

test("consent(false) before tracking ever started is a decision: queued calls wait and are sent after consent(true)", async () => {
  const { mod, events } = await page();
  mod.init({ publicKey: KEY, endpoint: ENDPOINT, consent: "required", recordAgents: false });
  mod.track("view_item", { item_id: "before-decision" });
  mod.consent(false);
  mod.track("add_to_cart", { item_id: "after-refusal", value: 1 });
  mod.consent(true);
  window.dispatchEvent(new Event("pagehide"));
  await tick();
  const all = JSON.stringify(events());
  assert.ok(all.includes("before-decision") && all.includes("after-refusal"));
});
