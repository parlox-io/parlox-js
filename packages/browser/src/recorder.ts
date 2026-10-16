// The agent-visit recorder. Loaded by the tracker only when the page's own signals say the browser is automated; a
// person's browser never runs it. It records the page's DOM and its changes (rrweb) with every input and all text
// masked (control labels and merchant-approved areas excepted) and every address cut down as the tracker's are,
// batches the events, compresses them, and posts them to the gateway in bounded chunks. Hard caps: 5 MB per visit,
// 40 chunks, 30 minutes.
//
// In the npm build the merchant's bundler includes this module and the tracker imports it lazily, so no code is
// fetched from Parlox at runtime; the hosted tag loads the same code as /sdk/<version>/parlox-record.js with an
// integrity hash.

import { record } from "@rrweb/record";
import type { RecorderConfig } from "./tracker.js";
import { recordedSrcset, recordedUrl } from "./url.js";

let running = false;

/** Starts recording this page once; later calls do nothing. Never throws. */
export function startRecorder(cfg: RecorderConfig): void {
  if (running || typeof window === "undefined") return;
  running = true;

  const MAX_BYTES = 5 * 1024 * 1024, MAX_CHUNKS = 40, MAX_MS = 30 * 60_000, FLUSH_MS = 5000;
  let buffer: unknown[] = [];
  let sent = 0, chunks = 0, seq = 0, stopped = false;
  const started = Date.now();
  let stopRecord: (() => void) | undefined;

  // Private by default (FullStory's and PostHog's model): every text node is masked, because the choice to record
  // rests on the page's own signals and a person can be misjudged as an agent (a virtual machine or remote desktop
  // renders in software). Two things stay readable: the label of a real control (a button, or a link with little
  // inside it), with emails, phone numbers and long digit runs masked exactly as the snippet masks click labels, and
  // any area the merchant marks with data-plx-unmask. Inputs are always masked: a typed card number never leaves.
  const CONTROL = 'button, a[href], [role="button"], [role="link"], summary, input[type="submit" i], input[type="button" i], input[type="reset" i]';
  const star = (s: string) => s.replace(/\S/g, "*");
  const maskLabel = (s: string) => s.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[email]").replace(/\+?\d[\d\s().-]{7,}\d/g, "[number]").replace(/\d{4,}/g, "#");
  const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);
  // An area the merchant marked reaches into the shadow roots inside it (a web component's own markup).
  function marked(el: Element, sel: string): boolean {
    let n: Element | null = el;
    while (n) {
      if (n.closest(sel)) return true;
      const root = n.getRootNode() as ShadowRoot;
      n = root && root.host ? root.host : null;
    }
    return false;
  }
  // A control's own text stays readable when the control has little inside it (at most 5 elements), says at most 60
  // characters (as a click's label does) and spans at most 2 lines: a flat address on a button is 3 or 4.
  function readableControl(control: Element, text: string): boolean {
    if (text.length > 60 || control.querySelectorAll("*").length > 5) return false;
    if (control.getElementsByTagName("br").length >= 2) return false;
    return String((control as HTMLElement).innerText || "").split("\n").filter((l) => l.trim()).length <= 2;
  }
  function maskText(text: string, el: Element | null): string {
    try {
      if (!el || marked(el, "[data-plx-mask]")) return star(text);
      if (marked(el, "[data-plx-unmask]")) return text;
      const control = el.closest(CONTROL);
      if (control && readableControl(control, text)) return maskLabel(text);
    } catch { /* masked below */ }
    return star(text);
  }

  // rrweb masks text nodes and input values; attributes it records as the page has them. Before an event is kept, every
  // address in it follows the tracker's URL rule (url.ts), including the page's own address in the Meta event rrweb
  // sends with every full snapshot, and every attribute that is page text is masked like the text around it. Files the
  // replay draws (src, srcset, poster, and the href of a stylesheet, preload or icon link) keep the few query
  // parameters that size or version them (url.ts, resourceAddress); links, forms and the page's address keep none.
  // The lists match the gateway's, which cleans recordings again before it stores them.
  // Events are changed in place: rrweb is done with them once they are emitted.
  const URL_ATTRS: Record<string, 1> = { href: 1, src: 1, action: 1, formaction: 1, poster: 1, background: 1, "xlink:href": 1, rr_src: 1 };
  // Older address attributes: they keep what a link keeps.
  const OTHER_URL_ATTRS: Record<string, 1> = { cite: 1, longdesc: 1, manifest: 1, codebase: 1, lowsrc: 1, dynsrc: 1, icon: 1, archive: 1, classid: 1, profile: 1, data: 1 };
  const DRAWN_LINK = /(^|\s)(stylesheet|preload|icon)(\s|$)/i;
  const SRCSET_ATTRS: Record<string, 1> = { srcset: 1, imagesrcset: 1 };
  // Not needed to draw a page; each can carry a list of addresses or a whole document.
  const REMOVED_ATTRS: Record<string, 1> = { ping: 1, srcdoc: 1 };
  const TEXT_ATTRS: Record<string, 1> = { title: 1, alt: 1, placeholder: 1, label: 1, summary: 1, abbr: 1, "aria-label": 1, "aria-description": 1, "aria-valuetext": 1, "aria-placeholder": 1, "aria-roledescription": 1, "aria-braillelabel": 1, "aria-brailleroledescription": 1 };
  // A form value is masked whatever the field holds now: rrweb masks it only when the field is not empty, and a field
  // the server filled and the page emptied keeps the value in its attribute. A button input's value is its label.
  const VALUE_TAGS: Record<string, 1> = { input: 1, textarea: 1, select: 1, option: 1, button: 1 };
  type Attrs = Record<string, unknown>;
  interface SNode { type: number; id: number; tagName?: string; attributes?: Attrs; childNodes?: SNode[] }
  function nodeOf(id: number): Node | null { return record.mirror.getNode(id) as Node | null; }
  function elementOf(id: number): Element | null {
    const n = nodeOf(id);
    return n && n.nodeType === 1 ? (n as Element) : null;
  }
  // rrweb records a same-origin frame's document even when the frame is blocked; only this page is kept.
  function onPage(id: number): boolean {
    const n = nodeOf(id);
    return !!n && (n === document || n.ownerDocument === document);
  }
  function cleanAttrs(attrs: Attrs, tag: string, el: Element | null) {
    for (const name in attrs) {
      const v = attrs[name];
      if (typeof v !== "string") continue; // a removed attribute (null), a style change (an object), rrweb's own numbers
      const n = name.toLowerCase();
      if (has(REMOVED_ATTRS, n)) { delete attrs[name]; continue; }
      // A link's or a form's address is never drawn, so inline content there is reduced like any other scheme (and on
      // an element rrweb no longer knows, which never happens for an event it emits).
      const drawn = !!tag && !(n === "action" || n === "formaction" || tag === "a" || tag === "area" || tag === "base");
      const rel = tag === "link" ? String((el && el.getAttribute("rel")) || attrs.rel || "") : "";
      const resource = !!tag && (n === "src" || n === "poster" || (n === "href" && DRAWN_LINK.test(rel)));
      if (has(SRCSET_ATTRS, n)) attrs[name] = recordedSrcset(v);
      else if (has(URL_ATTRS, n) || (n === "data" && tag === "object")) attrs[name] = recordedUrl(v, tag, drawn, resource);
      else if (has(OTHER_URL_ATTRS, n)) attrs[name] = recordedUrl(v, tag, false);
      else if (n === "value" && has(VALUE_TAGS, tag)) {
        const type = String((el && el.getAttribute("type")) || attrs.type || "").toLowerCase();
        attrs[name] = tag === "input" && (type === "submit" || type === "button" || type === "reset") ? maskText(v, el) : "*".repeat(v.length);
      } else if (n === "content") {
        const meta = String((el && el.getAttribute("name")) || attrs.name || "").toLowerCase();
        // og:url, a refresh's address, tokens; the viewport and color-scheme draw the page, and say nothing of it.
        if (!(tag === "meta" && (meta === "viewport" || meta === "color-scheme"))) attrs[name] = star(v);
      } else if (n === "download") attrs[name] = star(v);
      else if (has(TEXT_ATTRS, n)) attrs[name] = maskText(v, el);
    }
  }
  function cleanNode(sn: SNode) {
    if (sn.type === 2 && sn.attributes) cleanAttrs(sn.attributes, String(sn.tagName || ""), elementOf(sn.id));
    if (sn.childNodes) sn.childNodes.forEach(cleanNode);
  }
  // rrweb's event types: 4 Meta, 2 FullSnapshot, 3 IncrementalSnapshot (source 0: DOM mutations, 5: a field's
  // value). Returns false when nothing of the event is kept.
  function clean(e: { type: number; data: any }): boolean {
    if (e.type === 4 && typeof e.data.href === "string") e.data.href = recordedUrl(e.data.href, "", false);
    else if (e.type === 2) cleanNode(e.data.node);
    else if (e.type === 3 && e.data.source === 0) {
      const d = e.data;
      if (d.isAttachIframe) return false;
      d.adds = (d.adds as Array<{ node: SNode }>).filter((a) => onPage(a.node.id));
      d.texts = (d.texts as Array<{ id: number }>).filter((t) => onPage(t.id));
      d.attributes = (d.attributes as Array<{ id: number }>).filter((a) => onPage(a.id));
      d.removes = (d.removes as Array<{ parentId: number }>).filter((r) => { const p = nodeOf(r.parentId); return !p || p === document || p.ownerDocument === document; });
      if (!d.adds.length && !d.texts.length && !d.attributes.length && !d.removes.length) return false;
      (d.adds as Array<{ node: SNode }>).forEach((a) => cleanNode(a.node));
      (d.attributes as Array<{ id: number; attributes: Attrs }>).forEach((a) => {
        const el = elementOf(a.id);
        cleanAttrs(a.attributes, el ? el.tagName.toLowerCase() : "", el);
      });
    } else if (e.type === 3 && e.data.source === 5) {
      // rrweb leaves a checkbox's or radio's value as written; every value is masked.
      if (!onPage(e.data.id)) return false;
      if (typeof e.data.text === "string") e.data.text = "*".repeat(e.data.text.length);
    }
    return true;
  }

  async function gzip(text: string): Promise<{ body: BodyInit; gz: boolean }> {
    try {
      if (typeof CompressionStream === "function") {
        const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
        return { body: await new Response(stream).arrayBuffer(), gz: true };
      }
    } catch { /* fall through */ }
    return { body: text, gz: false };
  }

  // A page can be gone within two seconds (a click that navigates), so the first flush follows the full snapshot
  // at once, and the exit flush sends raw JSON with keepalive rather than waiting on compression.
  // Consent withdrawn (or the visit forgotten) on the page: stop recording and send nothing more, including what is buffered.
  const inactive = () => { try { return !!cfg.active && !cfg.active(); } catch { return true; } };

  async function flush(final: boolean) {
    if (inactive()) { buffer = []; stop(); return; }
    if (buffer.length === 0 || stopped) return;
    const events = buffer; buffer = [];
    const text = JSON.stringify(events);
    if (sent + text.length > MAX_BYTES || chunks >= MAX_CHUNKS) { stop(); return; }
    const { body, gz } = final ? { body: text as BodyInit, gz: false } : await gzip(text);
    if (inactive()) { stop(); return; } // consent withdrawn while compressing: this chunk is never sent
    sent += text.length; chunks++;
    const meta = { k: cfg.k, sid: cfg.sid, pv: cfg.pv(), url: cfg.url(), seq: seq++, n: events.length, gz: gz ? 1 : 0 };
    const send = () => fetch(cfg.endpoint + "?m=" + encodeURIComponent(JSON.stringify(meta)), {
      method: "POST", body, keepalive: final && text.length < 60_000, mode: "cors", credentials: "omit",
      headers: gz ? { "content-type": "application/octet-stream" } : { "content-type": "application/json" },
    });
    // No answer, or not stored yet (503: the visit's first beacon is still being written, or the database is slow;
    // some automated browsers also drop requests around a navigation): up to three more tries, 2, 4 and 8 s apart,
    // while the page is still here.
    const attempt = (n: number) => send().then((r) => { if (!r.ok) throw new Error(String(r.status)); }).catch(() => {
      if (!final && n < 3) setTimeout(() => { if (!inactive()) attempt(n + 1); }, 2000 * 2 ** n);
    });
    await attempt(0);
  }

  let timer: ReturnType<typeof setInterval> | undefined;
  function stop() {
    if (timer) clearInterval(timer);
    if (stopped) return;
    stopped = true;
    try { stopRecord?.(); } catch { /* ignore */ }
  }

  try {
    stopRecord = record({
      emit(event) {
        if (stopped || inactive()) return;
        // An event that cannot be cleaned is never kept, and the recording ends there.
        try { if (!clean(event as { type: number; data: any })) return; } catch { stop(); return; }
        buffer.push(event);
      },
      // maskAllInputs: true would replace this list rather than add to it, so it is that list (rrweb 2.1.6) plus the
      // two input types it leaves readable: hidden fields (tokens and ids the page sets, never shown) and file fields
      // (the chosen file's name). They stay in the replay as hidden and file inputs, with their values masked. rrweb
      // looks each input's type up in this object; its type names only the types rrweb masks by default.
      maskInputOptions: { color: true, date: true, "datetime-local": true, email: true, month: true, number: true, range: true, search: true, tel: true, text: true, time: true, url: true, week: true, textarea: true, select: true, password: true, hidden: true, file: true } as Record<string, boolean>,
      maskTextSelector: "*",
      maskTextFn: maskText,
      blockSelector: "[data-plx-block], iframe",
      // rrweb's own exclusions: HTML comments (never masked as text) and the head's verification and token meta tags
      // (csrf-token, shopify-checkout-api-token, site verifications). None of them is drawn.
      // Social and http-equiv tags too: og:url and twitter:url hold the page's address, a refresh holds another.
      slimDOMOptions: { comment: true, headMetaVerification: true, headMetaSocial: true, headMetaHttpEquiv: true },
      sampling: { mousemove: 50, mouseInteraction: true, scroll: 150, input: "last" },
      inlineStylesheet: true,
      collectFonts: false,
      recordCanvas: false,
      checkoutEveryNms: 60_000,
    });
  } catch { stopped = true; return; }
  // The first snapshot is emitted inside record(): if it could not be cleaned, rrweb is stopped now that it can be.
  if (stopped) { try { stopRecord?.(); } catch { /* ignore */ } return; }

  setTimeout(() => flush(false), 700);   // the full snapshot, before the page can go away
  timer = setInterval(() => { if (Date.now() - started > MAX_MS) { flush(true); stop(); return; } flush(false); }, FLUSH_MS);
  addEventListener("pagehide", () => { flush(true); });
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flush(true); });
}
