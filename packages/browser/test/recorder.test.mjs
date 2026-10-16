// The agent-visit recorder on a page (happy-dom), against the built package and the real rrweb it ships with: what a
// recording may say about the page, and that the recording still rebuilds into a page the replay can draw.
// Text-node masking is not exercised here: under happy-dom rrweb reads every text node as empty, so the checks below
// that a secret is absent cover attributes, addresses, values and meta events, not text.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { createRequire } from "node:module";
import { gunzipSync } from "node:zlib";

const require = createRequire(import.meta.url);
const CJS = require.resolve("../dist/cjs/recorder.cjs");
const RRWEB = createRequire(CJS).resolve("@rrweb/record");
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

const PAGE = "https://shop.example.com/account/reset/123/abcdefABCDEF1234567890?key=wc_order_PAGESECRET&utm_source=chatgpt.com";
const HEAD = `<meta name="csrf-token" content="csrf-META-SECRET"><meta name="shopify-checkout-api-token" content="SHOP-META-SECRET">
  <link rel="stylesheet" href="https://fonts.example.com/css2?family=Inter&key=FONTSECRET">`;
const BODY = `
  <a id="order" href="/orders/abcdef1234567890ABCDEF12?key=wc_order_LINKSECRET&utm_source=chatgpt.com#top">Your order</a>
  <a href="mailto:jane.doe@example.com">Email us</a>
  <a href="tel:+15551234567">Call us</a>
  <a href="data:text/csv;base64,SmFuZSBEb2U=" download="addresses.csv">Download</a>
  <form action="/checkouts/cn/Z2NwLWV1cm9wZS13ZXN0NDpxYz12Y2E?token=FORMSECRET">
    <input type="hidden" id="csrf" name="authenticity_token" value="csrf-HIDDEN-SECRET">
    <input type="file" name="upload">
    <input type="text" name="q" placeholder="jane.doe@example.com">
    <button formaction="/account/reset/123/abcdefABCDEF1234567890?x=FORMACTIONSECRET">Reset</button>
  </form>
  <img id="pic" src="https://cdn.example.com/u/photo.jpg?X-Amz-Signature=SIGSECRET" srcset="data:image/png;base64,iVBORw0KGgo= 1x, /img/a.jpg?sig=SRCSETSECRET 2x" alt="Jane Doe at the beach" title="Signed in as jane.doe@example.com">
  <svg><use href="#icon-cart"></use><use href="/sprite.svg?v=SPRITESECRET#icon-bag"></use></svg>
  <video poster="/poster.jpg?token=POSTERSECRET&width=640"></video>
  <img id="hero" src="/_next/image?url=%2Fimages%2Fhero.jpg%3Fsig%3DNEXTSECRET&w=640&q=75" srcset="/_next/image?url=%2Fimages%2Fhero.jpg&w=1080&q=75 2x">
  <img id="tent" src="//shop.example.com/cdn/shop/files/tent.jpg?v=1697041234&width=533&token=CDNSECRET">
  <a id="sized" href="/collections/tents?width=533&v=2">Tents</a>
  <!-- customer: Jane Doe, jane.doe@example.com -->
  <button id="pay" aria-label="Pay now">Pay</button>`;

// No stylesheet or script is fetched from the network.
const SETTINGS = { disableCSSFileLoading: true, disableJavaScriptFileLoading: true, handleDisabledFileLoadingAsSuccess: true };

// Starts the recorder on a fresh page, runs `act`, leaves the page, and returns every event the gateway was sent.
async function recording(act, { head = HEAD, body = BODY, before } = {}) {
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
  GlobalRegistrator.register({ url: PAGE, width: 1280, height: 800, settings: SETTINGS });
  // rrweb takes clean DOM prototypes from a blank frame when the page's own are not native code, and in happy-dom they
  // never are. happy-dom closes a removed frame's window, so a MutationObserver taken from it never reports. Here a
  // frame's window is the page's, which is what rrweb finds in a browser's blank frame: the same prototypes, untouched.
  Object.defineProperty(window.HTMLIFrameElement.prototype, "contentWindow", { get() { return window; }, configurable: true });
  document.head.innerHTML = head;
  document.body.innerHTML = body;
  if (before) before();
  const posts = [];
  window.fetch = async (u, init) => { posts.push({ u: String(u), init }); return new Response(null, { status: 204 }); };
  delete require.cache[CJS]; delete require.cache[RRWEB]; // a fresh recorder (it starts once per module) and rrweb
  const { startRecorder } = require(CJS);
  startRecorder({ k: "pk_test", sid: "s1", endpoint: "https://gateway.test/v1/r", pv: () => 1, url: () => "https://shop.example.com/account/reset/:token", active: () => true });
  if (act) await act();
  await tick(20);
  window.dispatchEvent(new Event("pagehide"));
  await tick(20);
  return posts.flatMap((p) => {
    const meta = JSON.parse(new URL(p.u).searchParams.get("m"));
    return JSON.parse(meta.gz ? gunzipSync(Buffer.from(p.init.body)).toString() : p.init.body);
  });
}
function elements(node, out = []) {
  if (node.type === 2) out.push(node);
  (node.childNodes || []).forEach((c) => elements(c, out));
  return out;
}
const SECRETS = ["SECRET", "wc_order", "jane.doe", "Jane", "15551234567", "SmFuZSBEb2U", "abcdef1234567890ABCDEF12", "abcdefABCDEF1234567890", "Z2NwLWV1cm9wZS13ZXN0NDpxYz12Y2E"];

afterEach(async () => { if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister(); });

test("a recording's page address, links, forms and resources follow the beacon's URL rule", async () => {
  const events = await recording();
  const meta = events.find((e) => e.type === 4), full = events.find((e) => e.type === 2);
  assert.ok(meta && full, "rrweb recorded the page (a Meta event and a full snapshot)");
  assert.equal(meta.data.href, "https://shop.example.com/account/reset/:token?utm_source=chatgpt.com");
  const els = elements(full.data.node);
  const attr = (tag, name) => els.filter((e) => e.tagName === tag).map((e) => e.attributes[name]).filter((v) => v !== undefined);
  assert.ok(attr("a", "href").includes("https://shop.example.com/orders/:token?utm_source=chatgpt.com"));
  assert.ok(attr("a", "href").includes("mailto:") && attr("a", "href").includes("tel:"), "mailto: and tel: keep only the scheme");
  assert.ok(attr("a", "href").includes("data:"), "a link's inline download keeps only the scheme");
  assert.deepEqual(attr("form", "action"), ["https://shop.example.com/checkouts/cn/:token"]);
  assert.deepEqual(attr("button", "formaction"), ["https://shop.example.com/account/reset/:token"]);
  const byId = (id) => els.find((e) => e.attributes.id === id).attributes;
  assert.equal(byId("pic").src, "https://cdn.example.com/u/photo.jpg");
  assert.equal(byId("pic").srcset, "data:image/png;base64,iVBORw0KGgo= 1x, https://shop.example.com/img/a.jpg 2x", "inline images stay; addresses lose their query");
  assert.equal(byId("hero").src, "https://shop.example.com/_next/image?url=%2Fimages%2Fhero.jpg&w=640&q=75", "Next.js images keep what the optimizer needs");
  assert.equal(byId("hero").srcset, "https://shop.example.com/_next/image?url=%2Fimages%2Fhero.jpg&w=1080&q=75 2x");
  assert.equal(byId("tent").src, "https://shop.example.com/cdn/shop/files/tent.jpg?v=1697041234&width=533", "sized CDN images keep their size and version");
  assert.equal(byId("sized").href, "https://shop.example.com/collections/tents", "a link keeps none of them");
  assert.deepEqual(attr("use", "href"), ["#icon-cart", "https://shop.example.com/sprite.svg#icon-bag"], "SVG icon references stay drawable");
  assert.deepEqual(attr("video", "poster"), ["https://shop.example.com/poster.jpg?width=640"]);
  const all = JSON.stringify(events);
  for (const s of SECRETS) assert.ok(!all.includes(s), `"${s}" is not in the recording`);
});

test("hidden and file inputs keep their type with the value masked; token meta tags and comments are left out", async () => {
  const events = await recording();
  const full = events.find((e) => e.type === 2);
  assert.ok(full);
  const els = elements(full.data.node);
  const hidden = els.find((e) => e.tagName === "input" && e.attributes.type === "hidden");
  assert.ok(hidden, "the hidden input is still a hidden input in the recording");
  assert.match(hidden.attributes.value, /^\*+$/);
  assert.ok(!els.some((e) => e.tagName === "meta" && /csrf-token|shopify-checkout-api-token/.test(String(e.attributes.name))));
  const nodes = (n, out = []) => { out.push(n); (n.childNodes || []).forEach((c) => nodes(c, out)); return out; };
  assert.ok(!nodes(full.data.node).some((n) => n.type === 5), "comments are not recorded");
});

test("page text in attributes is masked like the text around it; a control's own label stays readable", async () => {
  const events = await recording();
  const els = elements(events.find((e) => e.type === 2).data.node);
  const img = els.find((e) => e.tagName === "img");
  assert.match(img.attributes.alt, /^[*\s]+$/);
  assert.match(img.attributes.title, /^[*\s]+$/);
  assert.match(els.find((e) => e.attributes.name === "q").attributes.placeholder, /^[*\s]+$/);
  assert.equal(els.find((e) => e.attributes.id === "pay").attributes["aria-label"], "Pay now");
});

test("changes after the first snapshot (added links, changed addresses and values) follow the same rules", async () => {
  const events = await recording(async () => {
    await tick(10);
    const a = document.createElement("a");
    a.setAttribute("href", "/orders/ZZZZZZ1234567890abcdefgh?key=wc_order_ADDSECRET");
    a.textContent = "late";
    document.body.appendChild(a);
    document.getElementById("pic").setAttribute("src", "/x.jpg?token=MUTSRCSECRET");
    document.getElementById("pic").setAttribute("title", "jane.doe@example.com");
    document.getElementById("order").setAttribute("href", "mailto:jane.doe@example.com");
    document.querySelector("link[rel=stylesheet]").setAttribute("href", "https://fonts.googleapis.com/css2?family=Inter&text=Jane%20Doe");
    const csrf = document.getElementById("csrf");
    csrf.value = "csrf-PROP-SECRET";
    csrf.setAttribute("value", "csrf-ATTR-SECRET");
  });
  const mutations = events.filter((e) => e.type === 3 && e.data.source === 0);
  assert.ok(mutations.length, "rrweb recorded the changes");
  const changed = mutations.flatMap((m) => m.data.attributes.map((a) => a.attributes));
  assert.ok(changed.some((a) => a.src === "https://shop.example.com/x.jpg"));
  assert.ok(changed.some((a) => a.href === "mailto:"));
  assert.ok(changed.some((a) => a.href === "https://fonts.googleapis.com/css2?family=Inter"), "a changed stylesheet link is a resource: its family stays, its text goes");
  const typed = events.filter((e) => e.type === 3 && e.data.source === 5);
  assert.ok(typed.length && typed.every((e) => /^\*+$/.test(e.data.text)), "the hidden field's new value is recorded, masked");
  const added = mutations.flatMap((m) => m.data.adds.map((a) => a.node)).filter((n) => n.tagName === "a");
  assert.deepEqual(added.map((n) => n.attributes.href), ["https://shop.example.com/orders/:token"]);
  const all = JSON.stringify(events);
  for (const s of [...SECRETS, "ZZZZZZ1234567890abcdefgh"]) assert.ok(!all.includes(s), `"${s}" is not in the recording`);
});

// The replayer builds each node with rrweb-snapshot's builder. The <html> element is built here rather than the whole
// document, because happy-dom's document.open() leaves an <html> in place where a browser's leaves none.
test("the cleaned snapshot still builds into a page (rrweb-snapshot's builder, which the replayer uses)", async () => {
  const events = await recording();
  const full = events.find((e) => e.type === 2);
  const { buildNodeWithSN, createMirror, createCache } = require("rrweb-snapshot");
  const doc = document.implementation.createHTMLDocument("");
  const html = full.data.node.childNodes.find((n) => n.type === 2);
  const built = buildNodeWithSN(html, { doc, mirror: createMirror(), cache: createCache() });
  doc.removeChild(doc.documentElement);
  doc.appendChild(built);
  assert.equal(doc.querySelectorAll('input[type="hidden"]').length, 1, "the hidden input is drawn as a hidden input");
  assert.ok(doc.querySelector('use[href="#icon-cart"]'), "SVG icons still point at their symbols");
  assert.equal(doc.querySelector("img").getAttribute("src"), "https://cdn.example.com/u/photo.jpg");
  assert.equal(doc.querySelector("#order").getAttribute("href"), "https://shop.example.com/orders/:token?utm_source=chatgpt.com");
});

const HEAD2 = `<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark">
  <meta property="og:url" content="https://shop.example.com/account/reset/123/abcdefABCDEF1234567890?key=wc_order_OGSECRET">
  <meta name="twitter:url" content="https://shop.example.com/orders/abcdef1234567890ABCDEF12?key=TWSECRET">
  <meta http-equiv="refresh" content="900;url=/account/reset/123/abcdefABCDEF1234567890?r=REFRESHSECRET">
  <meta name="_csrf" content="SPRING-CSRF-SECRET"><meta name="csrf_token" content="UNDERSCORE-CSRF-SECRET">
  <meta name="description" content="Jane Doe's wishlist">`;
const BODY2 = `
  <form>
    <input type="email" id="em" name="email" value="jane.doe@prefill.example">
    <input type="text" id="addr" name="address1" value="12 Prefill Street">
    <select id="sel"><option id="opt" value="OPTIONSECRET" selected>One</option></select>
    <input type="radio" id="rv" name="addr" value="RADIOVALUESECRET">
    <input type="submit" id="sub" value="Pay now">
    <button id="bv" value="BUTTONVALUESECRET">b</button>
  </form>
  <a id="pg" href="/x" ping="https://track.example/p?t=PINGSECRET">p</a>
  <blockquote id="cq" cite="https://shop.example.com/orders/abcdef1234567890ABCDEF12?key=CITESECRET">q</blockquote>
  <a id="dl" download="Invoice-Jane-Doe-DOWNLOADSECRET.pdf" href="/inv.pdf">inv</a>
  <table id="tb" summary="SUMMARYSECRET"><tr><td id="td" abbr="ABBRSECRET">x</td></tr></table>
  <span id="brl" aria-braillelabel="BRAILLESECRET">b</span>
  <div id="ctor" constructor="keep-me"></div>
  <button id="short" title="Add the Ridgeline two-person tent to your cart">x</button>
  <button id="long" title="Add the Ridgeline two-person tent to your cart, and its footprint">x</button>
  <button id="lines" title="Home">Jane<br>12 Main<br>Spring</button>
  <div data-plx-mask><span id="host"></span></div>
  <img id="remote" src="/_next/image?url=https%3A%2F%2Fcdn.shopify.com%2Fs%2Ffiles%2F1%2Fp.jpg%3Fv%3D1%26sig%3DREMOTESECRET&w=640&q=75">`;
const SECRETS2 = ["SECRET", "prefill", "Jane", "abcdef1234567890ABCDEF12", "abcdefABCDEF1234567890", "Shadow Masked"];
const page2 = (act) => recording(act, { head: HEAD2, body: BODY2, before() {
  // A field filled by the server and emptied by the page keeps its value attribute; rrweb reads only the property.
  document.getElementById("em").value = ""; document.getElementById("addr").value = "";
  document.getElementById("host").attachShadow({ mode: "open" }).innerHTML = '<button id="shadowed" aria-label="Hi, Shadow Masked">s</button>';
} });

test("meta content is masked (the viewport's and color-scheme's excepted); social and http-equiv meta tags are left out", async () => {
  const events = await page2();
  const els = elements(events.find((e) => e.type === 2).data.node);
  const metas = els.filter((e) => e.tagName === "meta").map((e) => e.attributes);
  assert.ok(!metas.some((m) => m.property || /^twitter:/.test(m.name || "") || m["http-equiv"]), "og:, twitter: and http-equiv tags are not recorded");
  for (const name of ["_csrf", "csrf_token", "description"]) assert.match(metas.find((m) => m.name === name).content, /^[*\s']+$/, name);
  assert.equal(metas.find((m) => m.name === "viewport").content, "width=device-width, initial-scale=1");
  assert.equal(metas.find((m) => m.name === "color-scheme").content, "light dark", "a dark-scheme page replays dark");
});

test("form values are masked whatever the field holds now; a submit input's value is its label", async () => {
  const events = await page2();
  const byId = (id) => elements(events.find((e) => e.type === 2).data.node).find((e) => e.attributes.id === id).attributes;
  for (const id of ["em", "addr", "opt", "rv", "bv"]) assert.match(byId(id).value, /^\*+$/, id);
  assert.equal(byId("sub").value, "Pay now");
});

test("attributes the gateway also cleans: ping and srcdoc removed, cite as a link, download and words masked", async () => {
  const events = await page2();
  const byId = (id) => elements(events.find((e) => e.type === 2).data.node).find((e) => e.attributes.id === id).attributes;
  assert.ok(!("ping" in byId("pg")));
  assert.equal(byId("cq").cite, "https://shop.example.com/orders/:token");
  assert.match(byId("dl").download, /^\*+$/);
  assert.match(byId("tb").summary, /^\*+$/); assert.match(byId("td").abbr, /^\*+$/); assert.match(byId("brl")["aria-braillelabel"], /^\*+$/);
  assert.equal(byId("ctor").constructor, "keep-me", "an attribute named like an Object property is left alone");
  assert.equal(byId("remote").src, "https://shop.example.com/_next/image?url=https%3A%2F%2Fcdn.shopify.com%2Fs%2Ffiles%2F1%2Fp.jpg%3Fv%3D1&w=640&q=75", "a remote source keeps what a file keeps");
});

test("a control's own text is readable up to 60 characters and 2 lines; data-plx-mask reaches into shadow roots", async () => {
  const events = await page2();
  const els = elements(events.find((e) => e.type === 2).data.node);
  const byId = (id) => els.find((e) => e.attributes.id === id);
  assert.equal(byId("short").attributes.title, "Add the Ridgeline two-person tent to your cart");
  assert.match(byId("long").attributes.title, /^[*\s,]+$/, "over 60 characters");
  assert.match(byId("lines").attributes.title, /^\*+$/, "a control of more than 2 lines");
  assert.ok(byId("shadowed"), "rrweb recorded the shadow root");
  assert.match(byId("shadowed").attributes["aria-label"], /^[*\s,]+$/);
  const all = JSON.stringify(events);
  for (const x of SECRETS2) assert.ok(!all.includes(x), `"${x}" is not in the recording`);
});

test("a checked radio's value is masked in the change rrweb records", async () => {
  const events = await page2(async () => { await tick(10); document.getElementById("rv").checked = true; });
  const typed = events.filter((e) => e.type === 3 && e.data.source === 5);
  assert.ok(typed.length, "rrweb recorded the change");
  assert.ok(typed.every((e) => /^\**$/.test(e.data.text)));
  assert.ok(!JSON.stringify(events).includes("RADIOVALUESECRET"));
});
