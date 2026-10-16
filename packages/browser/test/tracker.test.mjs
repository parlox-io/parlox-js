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

// Clicks each element, waits for the dead-click verdict, leaves the page, and returns the click records in order.
async function clicks(mod, beacons, elements) {
  mod.init({ publicKey: KEY, endpoint: ENDPOINT, recordAgents: false });
  for (const el of elements) el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  await tick(1100);
  window.dispatchEvent(new Event("pagehide"));
  await tick();
  return beacons.flatMap((b) => b.body.events || []).filter((e) => e.ev === "click").map((e) => e.props);
}

const ADDRESS = "<p>Jane Doe</p><p>12 Main Street</p><p>Springfield</p><p>IL</p><p>United States</p><p>Phone</p>";

test("a container-sized control (a saved-address card, an account tile) sends no name from its text, and says it was withheld", async () => {
  const { mod, beacons } = await page();
  document.body.innerHTML = `
    <button id="card"><strong>Jane Doe</strong><span>12 Main Street</span><span>Springfield</span><span>IL</span><span>United States</span><span>Default</span></button>
    <a id="tile" href="/account"><img alt="Jane Doe" src="/avatar.png"><span>Jane Doe</span><span>jane.doe@example.com</span><span>Orders</span><span>Addresses</span><span>Sign out</span></a>
    <div id="pick" role="button" title="Use this address">${ADDRESS}</div>`;
  const got = await clicks(mod, beacons, ["card", "tile", "pick"].map((id) => document.getElementById(id)));
  assert.equal(got.length, 3);
  for (const c of got) {
    assert.equal(c.aname_withheld, true);
    assert.ok(!("aname" in c), "a withheld name is not replaced by a lesser one (the title)");
  }
  assert.equal(got[0].text, ""); assert.equal(got[1].text, "");
  assert.equal(got[2].text, "Use this address", "the label still takes the title the author gave, as in 1.0.3");
  const all = JSON.stringify(beacons);
  assert.ok(!all.includes("Jane") && !all.includes("Main Street") && !all.includes("jane.doe"), "no part of the card's text leaves");
  assert.equal(got[1].href, "/account", "the control is still identified by its link path and DOM path");
});

test("a control with no name at all sends an empty name, not a withheld one", async () => {
  const { mod, beacons } = await page();
  document.body.innerHTML = `<button id="x"><svg><path d="M0"/><path d="M1"/><path d="M2"/><circle r="1"/><rect width="1"/><path d="M3"/></svg></button>`;
  const [c] = await clicks(mod, beacons, [document.getElementById("x")]);
  assert.equal(c.aname, "");
  assert.ok(!("aname_withheld" in c));
});

test("a checkbox or radio is named by a short label with no digit, else by a plain value (as its name only), else withheld", async () => {
  const { mod, beacons } = await page();
  document.body.innerHTML = `
    <label for="m">M</label><input type="radio" id="m" name="size" value="1">
    <label><input type="radio" id="xl" name="size" value="2"><span>XL</span></label>
    <input type="radio" id="blue" name="color" value="3"><label for="blue">Blue</label>
    <label><input type="radio" id="heather" name="color" value="4"> Charcoal Heather</label>
    <input type="checkbox" id="gift" name="gift" aria-label="Gift wrap">
    <label for="s10">Size 10</label><input type="radio" id="s10" name="shoe" value="size-10">
    <label><input type="radio" id="tent" name="tent" value="2p"> 2-person (5 lb 3 oz)</label>
    <label for="a7">Jane Doe, 12 Main Street</label><input type="radio" id="a7" name="address" value="addr_7">
    <label><input type="radio" id="a8" name="address" value="address-10234">${ADDRESS}</label>
    <input type="radio" id="home" name="address" title="Deliver to 12 Main Street" value="home">
    <label for="gid">Jane Doe, 12 Main Street</label><input type="radio" id="gid" name="address" value="gid://shopify/MailingAddress/123">
    <span id="a9-text">Jane Doe, 14 Elm Road</span><input type="radio" id="a9" name="address" value="Z2NwLWV1cm9wZS13ZXN0NDpxYz12Y2E" aria-labelledby="a9-text">
    <label for="mail">Jane Doe, 12 Main Street</label><input type="radio" id="mail" name="address" value="jane@example.com">
    <label for="run">Jane Doe, 12 Main Street</label><input type="radio" id="run" name="address" value="abcdefghij0123456789x">
    <label for="sp">Jane Doe, 12 Main Street</label><input type="radio" id="sp" name="address" value="Jane Doe">
    <input type="radio" id="aria" name="address" aria-label="Jane Doe, 12 Main Street, Springfield, IL">
    <label><input type="checkbox" id="card" name="card"><span>Visa</span><span>ending</span><span>4242</span><span>Jane Doe</span><span>12/29</span></label>
    <input type="radio" id="bare" name="bare" value="opt_1">`;
  const ids = ["m", "xl", "blue", "heather", "gift", "s10", "tent", "a7", "a8", "home", "gid", "a9", "mail", "run", "sp", "aria", "card", "bare"];
  const got = Object.fromEntries((await clicks(mod, beacons, ids.map((id) => document.getElementById(id)))).map((c, i) => [ids[i], c]));
  for (const [id, name] of Object.entries({ m: "M", xl: "XL", blue: "Blue", heather: "Charcoal Heather", gift: "Gift wrap" })) {
    assert.equal(got[id].text, name, id); assert.equal(got[id].aname, name, id);
    assert.ok(!("aname_withheld" in got[id]) && !("aname_source" in got[id]), id);
  }
  for (const [id, value] of Object.entries({ s10: "size-10", tent: "2p", a7: "addr_7", a8: "address-#", home: "home" })) {
    assert.equal(got[id].aname, value, id); assert.equal(got[id].aname_source, "value", id);
    assert.equal(got[id].text, "", `${id}: a value is not a label the page shows, so it is not sent as one`);
  }
  for (const id of ["gid", "a9", "mail", "run", "sp", "aria", "card"]) {
    assert.equal(got[id].text, "", id); assert.equal(got[id].aname_withheld, true, id);
    assert.ok(!("aname" in got[id]) && !("aname_source" in got[id]), id);
  }
  assert.equal(got.bare.aname, "", "no label: nothing was withheld, and the value is not used");
  assert.ok(!("aname_withheld" in got.bare) && !("aname_source" in got.bare));
  const all = JSON.stringify(beacons);
  assert.ok(!all.includes("Jane") && !all.includes("Main Street") && !all.includes("gid:") && !all.includes("jane@"), "no address leaves, by label, aria-label, title, aria-labelledby or value");
  assert.equal(got.a7.attrs.name, "address", "the field's name is still recorded");
});

test("a control inside data-plx-mask or data-plx-block sends no name, and says it was withheld", async () => {
  const { mod, beacons } = await page();
  document.body.innerHTML = `
    <div data-plx-mask><button id="pm">Hi, Masked Name</button></div>
    <button id="pb" data-plx-block aria-label="Blocked Name">x</button>
    <div data-plx-mask><button id="none"><svg><path d="M0"/></svg></button></div>`;
  const got = await clicks(mod, beacons, ["pm", "pb", "none"].map((id) => document.getElementById(id)));
  for (const c of got.slice(0, 2)) { assert.equal(c.text, ""); assert.equal(c.aname_withheld, true); assert.ok(!("aname" in c)); }
  assert.equal(got[2].aname, "", "a control with no name has nothing to withhold");
  assert.ok(!JSON.stringify(beacons).includes("Masked Name") && !JSON.stringify(beacons).includes("Blocked Name"));
});

test("a label of more than 2 lines (a flat address on a button) is withheld; a 2-line label is kept", async () => {
  const { mod, beacons } = await page();
  document.body.innerHTML = `
    <button id="flat">Jane Doe<br>12 Main Street<br>Springfield IL 62704<br>United States</button>
    <a id="two" href="/new">New<br>arrivals</a>`;
  const got = await clicks(mod, beacons, ["flat", "two"].map((id) => document.getElementById(id)));
  assert.equal(got[0].text, ""); assert.equal(got[0].aname_withheld, true); assert.ok(!("aname" in got[0]));
  assert.ok(!JSON.stringify(beacons).includes("Main Street"));
  assert.match(got[1].text, /^New ?arrivals$/); assert.match(got[1].aname, /^New ?arrivals$/);
});

test("a click on a control with a very long label costs little (names are cut before they are masked)", async () => {
  const { mod, beacons } = await page();
  document.body.innerHTML = `<button id="a" aria-label="${"a".repeat(50000)}">x</button><button id="b">${"b".repeat(50000)}</button>`;
  mod.init({ publicKey: KEY, endpoint: ENDPOINT, recordAgents: false });
  for (const id of ["a", "b"]) {
    const t = performance.now();
    document.getElementById(id).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    assert.ok(performance.now() - t < 500, `${id}: ${Math.round(performance.now() - t)} ms`);
  }
  await tick(1100);
  window.dispatchEvent(new Event("pagehide"));
  await tick();
  const got = beacons.flatMap((b) => b.body.events || []).filter((e) => e.ev === "click").map((e) => e.props);
  assert.equal(got[0].aname, "a".repeat(60)); assert.equal(got[1].text, "b".repeat(60));
});

test("an icon button keeps its aria-label and a simple link keeps its text", async () => {
  const { mod, beacons } = await page();
  document.body.innerHTML = `
    <button id="cart" aria-label="Open cart"><svg><path d="M0"/><path d="M1"/><path d="M2"/><circle r="1"/><rect width="1"/><path d="M3"/></svg></button>
    <a id="tents" href="/collections/tents">Tents</a>
    <a id="logo" href="/"><img alt="Northfield" src="/logo.png"></a>`;
  const got = await clicks(mod, beacons, ["cart", "tents", "logo"].map((id) => document.getElementById(id)));
  assert.equal(got[0].text, "Open cart"); assert.equal(got[0].aname, "Open cart");
  assert.equal(got[1].text, "Tents"); assert.equal(got[1].aname, "Tents");
  assert.equal(got[2].aname, "Northfield", "a simple link's image alt names it");
});

test("author-given names are masked and cut like labels; aria-labelledby pointing at an address block is withheld", async () => {
  const { mod, beacons } = await page();
  document.body.innerHTML = `
    <button id="call" aria-label="Call +1 (555) 123-4567 or write to help@shop.example.com about order 100234">Help</button>
    <button id="long" aria-label="${"Add the Ridgeline two-person tent ".repeat(4)}">Add</button>
    <div id="addr">${ADDRESS}</div>
    <h2 id="title">Ridgeline Tent</h2>
    <button id="use" aria-labelledby="addr">Use</button>
    <button id="add" aria-labelledby="title">Add</button>`;
  const got = await clicks(mod, beacons, ["call", "long", "use", "add"].map((id) => document.getElementById(id)));
  assert.equal(got[0].aname, "Call [number] or write to [email] about order #");
  assert.equal(got[0].text, "Call [number] or write to [email] about order #");
  assert.ok(got[1].aname.length <= 60 && got[1].text.length <= 60, "cut at 60 characters, like the label");
  assert.equal(got[2].aname_withheld, true, "the name an agent sees is the address: withheld, not replaced by the button's text");
  assert.ok(!("aname" in got[2]));
  assert.equal(got[3].aname, "Ridgeline Tent");
  assert.ok(!JSON.stringify(beacons).includes("Jane"));
});

test("white space is collapsed before the cut that precedes masking, so padding cannot push an email past it", async () => {
  const { mod, beacons } = await page();
  document.body.innerHTML = `<button id="pad" aria-label="${" ".repeat(290)}jane.doe@example.com">x</button>`;
  const [c] = await clicks(mod, beacons, [document.getElementById("pad")]);
  assert.equal(c.aname, "[email]");
  assert.ok(!JSON.stringify(beacons).includes("jane.doe"));
});

test("every cut keeps whole emoji and leaves no unpaired surrogate (a database that stores JSON refuses one)", async () => {
  const { mod, beacons } = await page();
  const e = "\u{1F600}";
  document.body.innerHTML = `
    <button id="${"i".repeat(39) + e + e}" class="${"c".repeat(59) + e + e}" aria-label="${"a".repeat(59) + e + e}">x</button>
    <button id="lone" aria-label="ab\uD800cd">y</button>`;
  const got = await clicks(mod, beacons, [document.querySelector("button"), document.getElementById("lone")]);
  assert.equal(got[0].aname, "a".repeat(59) + e);
  assert.equal(got[0].id, "i".repeat(39) + e);
  assert.equal(got[0].cls, "c".repeat(59) + e);
  assert.equal(got[1].aname, "ab\uFFFDcd");
  const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  for (const b of beacons) assert.ok(!lone.test(JSON.stringify(b.body.events)), "no beacon carries an unpaired surrogate");
});

test("a field named __proto__ cannot reach Object.prototype, and track() ignores Object's own names", async () => {
  const { mod, events } = await page();
  document.body.innerHTML = `<input id="p" name="__proto__"><input id="c" name="constructor">`;
  mod.init({ publicKey: KEY, endpoint: ENDPOINT, recordAgents: false });
  for (const id of ["p", "c"]) {
    const f = document.getElementById(id);
    f.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    f.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true }));
    f.dispatchEvent(new Event("change", { bubbles: true }));
    f.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
  }
  mod.track("constructor", { value: 1 }); mod.track("toString", {}); mod.track("__proto__", {});
  window.dispatchEvent(new Event("pagehide"));
  await tick();
  assert.ok(!Object.prototype.hasOwnProperty.call(Object.prototype, "f") && ({}).f === undefined, "Object.prototype is untouched");
  const eng = events().find((e) => e.ev === "engagement");
  assert.equal(eng.props.fields.__proto__.f, 1, "the field is still counted under its own name");
  assert.ok(!events().some((e) => ["constructor", "toString", "__proto__"].includes(e.ev)));
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
