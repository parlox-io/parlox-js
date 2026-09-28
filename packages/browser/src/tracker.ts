// The Parlox browser tracker: one implementation behind both the npm module (index.ts) and the hosted tag (tag.ts).
//
// Beacons per page view: `page_view` the instant the page loads (so the count is exact even if an automated browser is
// killed a second later); `engagement`, a per-page summary of behaviour, sent at 8 s and re-sent with the same event id
// when the page is left (agents are slow, so recording never stops early); and interaction events (field names only,
// never values) flushed every 5 s while the page is open. Commerce events come in three tiers and every event says
// which: `api` (the merchant's own code calls track), `datalayer` (the store's existing GA4 data layer), and raw `click`
// records (element text and selector, never interpreted). The session id lives in sessionStorage: scoped to the tab,
// 30-minute idle expiry, never a cookie.
//
// Rules for code that runs on a merchant's page: it reads no field values and no page text beyond the label of a real
// control; it masks emails, phone numbers and digit runs; it sends URLs with capability tokens replaced; it sets no
// cookies; every listener and every hook it installs is wrapped so it can never break the host page; wrapped platform
// functions (fetch, XMLHttpRequest.open, dataLayer.push, history) keep their behaviour and return values exactly.

export interface RecorderConfig {
  k: string; sid: string; endpoint: string; pv: () => number; url: () => string;
  /** False once the recording must stop for good (consent withdrawn, session forgotten). Absent in pre-1.0.1 tags. */
  active?: () => boolean;
}
export type RecorderLoader = (cfg: RecorderConfig) => void;

export interface TrackerOptions {
  /** The site's public key (pk_...). */
  publicKey: string;
  /** Gateway origin, e.g. https://gateway.parlox.io */
  endpoint: string;
  /** "required": nothing runs, is stored or is sent until consent(true). */
  consent?: "granted" | "required";
  /** How the agent-visit recorder is loaded (a dynamic import for npm, a script tag for the hosted tag); omit to never record. */
  loadRecorder?: RecorderLoader;
}

export interface CommerceProps { value?: number; currency?: string; items?: number; order_id?: string | number; item_id?: string | number; step?: string }

export interface ParloxApi {
  track(name: string, props?: CommerceProps): void;
  consent(granted: boolean): void;
  sessionId(): string;
}

type Queued = unknown[];
interface WindowParlox { q?: Queued[] | { push(args: Queued): void }; track?: unknown; consent?: unknown; sessionId?: unknown }

export const PUBLIC_KEY_RE = /^pk_[A-Za-z0-9_-]{3,64}$/;

/** Starts the tracker once per page; later calls return the running instance. Never throws. */
export function startTracker(opts: TrackerOptions): ParloxApi | null {
  const w = window as unknown as Window & { __plxStarted?: ParloxApi; parlox?: WindowParlox; dataLayer?: unknown[] };
  try {
    if (w.__plxStarted) return w.__plxStarted;
    if (!PUBLIC_KEY_RE.test(opts.publicKey)) return null;
    const api = run(opts, w);
    w.__plxStarted = api;
    return api;
  } catch {
    return null;
  }
}

function run(opts: TrackerOptions, w: Window & { parlox?: WindowParlox; dataLayer?: unknown[] }): ParloxApi {
  const key = opts.publicKey;
  let consentRequired = opts.consent === "required";
  let started = false;
  const endpoint = opts.endpoint.replace(/\/+$/, "") + "/v1/b";
  const recEndpoint = opts.endpoint.replace(/\/+$/, "") + "/v1/r";
  const IDLE_MS = 30 * 60 * 1000, MAX_EVENTS = 100, MAX_PAGE_EVENTS = 500;

  function on(target: EventTarget, type: string, fn: (e: any) => void, o?: AddEventListenerOptions) {
    target.addEventListener(type, (e) => { try { fn(e); } catch { /* never break the page */ } }, o);
  }

  // Capability tokens live in paths on many platforms (Shopify /checkouts/cn/<token>, /orders/<token>,
  // /account/reset/<id>/<token>, WooCommerce ?key=wc_order_...). They never leave the page.
  function safePath(href: string): string {
    let u: URL;
    try { u = new URL(href, location.href); } catch { return "/"; }
    const path = u.pathname.replace(/\/account\/(reset|activate)\/.*/, "/account/$1/:token")
      .split("/").map((seg) => ((/^[A-Za-z0-9_]{20,}$/.test(seg) && /\d/.test(seg) && /[A-Za-z]/.test(seg)) || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg) ? ":token" : seg)).join("/");
    const keep = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "ref", "gclid", "fbclid", "srsltid"];
    const q: string[] = [];
    keep.forEach((k) => { const v = u.searchParams.get(k); if (v) q.push(k + "=" + encodeURIComponent(v.slice(0, 120))); });
    return u.origin + path + (q.length ? "?" + q.join("&") : "");
  }
  // The referrer gets the same treatment: a reset link or checkout page the visitor came from carries its token in
  // the path or the query, and only the source matters here.
  function safeReferrer(): string | null {
    const r = document.referrer;
    if (!r) return null;
    try { const u = new URL(r); return u.origin === location.origin ? safePath(r) : u.origin + "/"; } catch { return null; }
  }

  function hex(n: number): string {
    const a = new Uint8Array(n);
    if (w.crypto && crypto.getRandomValues) crypto.getRandomValues(a); else for (let i = 0; i < n; i++) a[i] = Math.random() * 256;
    let s = ""; for (let j = 0; j < n; j++) s += ("0" + a[j].toString(16)).slice(-2); return s;
  }
  function eventId(): string { return w.crypto && typeof crypto.randomUUID === "function" ? crypto.randomUUID() : hex(16); }

  let sid = "", pv = 0;
  try {
    const saved = JSON.parse(sessionStorage.getItem("_plx") || "null");
    if (saved && saved.id && Date.now() - saved.t < IDLE_MS) { sid = saved.id; pv = saved.pv || 0; }
  } catch { /* storage unavailable */ }
  if (!sid) sid = hex(12);
  function touch() { if (!started) return; try { sessionStorage.setItem("_plx", JSON.stringify({ id: sid, t: Date.now(), pv })); } catch { /* storage unavailable */ } }

  let env: Record<string, unknown> | null = null, gpuInfo: { vendor: string; renderer: string } | null = null, hs: Record<string, boolean> | null = null;
  function collectEnv() {
    if (env) return;
    const nav = navigator as Navigator & { userAgentData?: { brands: Array<{ brand: string; version: string }> } };
    env = {
      ua_brands: nav.userAgentData ? nav.userAgentData.brands : null,
      cdc_artifacts: Object.keys(document).concat(Object.keys(w)).filter((k) => /^\$?cdc_|^__playwright|^__pw_|^__puppeteer/.test(k)),
      max_touch: navigator.maxTouchPoints || 0,
    };
    const anyW = w as any, anyD = document as any;
    hs = {
      webdriver: !!navigator.webdriver,
      phantom: !!anyW._phantom || !!anyW.__nightmare,
      selenium: !!anyD.__selenium_unwrapped || !!anyW.__webdriver_evaluate,
      chrome_headless: /HeadlessChrome/.test(navigator.userAgent),
      notification_denied: typeof Notification !== "undefined" && Notification.permission === "denied",
    };
    try {
      const gl = document.createElement("canvas").getContext("webgl");
      const ext = gl && gl.getExtension("WEBGL_debug_renderer_info");
      if (gl && ext) gpuInfo = { vendor: gl.getParameter(ext.UNMASKED_VENDOR_WEBGL), renderer: gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) };
    } catch { /* no WebGL */ }
  }

  // Outbox: some automated browsers drop requests made within a second of a navigation. Each beacon is stored in
  // sessionStorage until the gateway answers; unanswered ones are resent from the next page in this tab, marked as
  // retries so the gateway drops anything it already has. Bounded: 30 beacons, 10 minutes.
  const OUTBOX = "_plx_q", OUTBOX_MAX = 30, OUTBOX_TTL = 10 * 60 * 1000;
  interface OutItem { id: string; t: number; data: Record<string, unknown> & { attempt?: number } }
  function readOutbox(): OutItem[] { try { const q = JSON.parse(sessionStorage.getItem(OUTBOX) || "[]"); return Array.isArray(q) ? q : []; } catch { return []; } }
  function writeOutbox(q: OutItem[]) { try { sessionStorage.setItem(OUTBOX, JSON.stringify(q.slice(-OUTBOX_MAX))); } catch { /* storage unavailable */ } }
  function outboxRemove(id: string) { writeOutbox(readOutbox().filter((x) => x.id !== id)); }
  function deliver(item: OutItem, unloading: boolean) {
    const body = JSON.stringify(item.data);
    if (unloading) {
      // Leaving the page: the beacon API is the only thing allowed to outlive it; the outbox keeps a copy either way.
      try { if (navigator.sendBeacon && navigator.sendBeacon(endpoint, body)) return; } catch { /* fall through */ }
      try { fetchRaw(endpoint, { method: "POST", body, keepalive: true, mode: "no-cors" }); } catch { /* dropped */ }
      return;
    }
    try {
      fetchRaw(endpoint, { method: "POST", body, mode: "cors", credentials: "omit", headers: { "content-type": "text/plain" } })
        .then((r) => { if (r.ok || r.status === 204) outboxRemove(item.id); }, () => {});
    } catch { /* dropped; retried from the outbox */ }
  }
  function post(events: unknown[], extra?: Record<string, unknown>, unloading?: boolean) {
    const data: Record<string, unknown> = { k: key, sid, pv, url: page ? page.url : safePath(location.href), ref: safeReferrer(), env, gpu: gpuInfo, headless_signals: hs, events, attempt: 1 };
    if (extra) for (const k in extra) data[k] = extra[k];
    const item: OutItem = { id: eventId(), t: Date.now(), data };
    const q = readOutbox(); q.push(item); writeOutbox(q);
    deliver(item, !!unloading);
  }
  // Anything left from earlier pages (or earlier on this one) goes again, as a retry.
  function drainOutbox() {
    const now = Date.now(), keep: OutItem[] = [];
    readOutbox().forEach((item) => {
      if (!item || !item.data || now - (item.t || 0) > OUTBOX_TTL) return;
      if (now - (item.t || 0) < 1500) { keep.push(item); return; } // give the first attempt a moment to be answered
      item.data.attempt = (item.data.attempt || 1) + 1;
      if (item.data.attempt > 4) return;
      keep.push(item);
      deliver(item, false);
    });
    writeOutbox(keep);
  }

  interface Field { f: number; c: number; k: number; inv: number; ms: number }
  interface Delayed { props: Record<string, unknown>; timer: ReturnType<typeof setTimeout> | null; at: number }
  interface Page {
    url: string; started: number; closed: boolean; pending: unknown[]; engId: string; sent: number;
    c: { mousemoves: number; scrolls: number; clicks: number; keys: number; touches: number; first_input_ms: number | null; errors: number };
    lastActT: number; lastAct: string; lastErrT: number; errShownT: number;
    pathLen: number; firstX: number | null; firstY: number | null; lastX: number | null; lastY: number | null; lastMoveT: number | null; maxSpeed: number;
    dirChanges: number; lastDX: number; lastDY: number; scrollDeltas: number[]; lastScrollY: number;
    moveToClick: number | null; seen: Record<string, 1>; flags: Record<string, 1>; lastMutT: number; lastCommerceT: number; delayed: Delayed[];
    recent: Array<{ t: number; x: number; y: number }>; rageAt: number; fields: Record<string, Field>; focused: { k: string; t: number } | null; lastInputT: number;
  }
  let page: Page | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null, flusher: ReturnType<typeof setInterval> | null = null;
  let observer: MutationObserver | null = null, mutObs: MutationObserver | null = null, recLoaded = false;

  // The same evidence the gateway scores, judged on the page so the recorder is fetched only for automated browsers.
  // A person's browser never downloads it. Threshold matches the gateway's: 0.5.
  function agentScore(): number {
    const s: number[] = [];
    if (hs && (hs.webdriver || hs.selenium || hs.phantom || hs.chrome_headless)) s.push(0.9);
    if (env && Array.isArray(env.cdc_artifacts) && env.cdc_artifacts.length) s.push(0.9);
    const r = (gpuInfo && gpuInfo.renderer) || "";
    if (/SwiftShader|llvmpipe|Basic Render Driver|Mesa OffScreen/i.test(r)) s.push(0.8); else if (!r) s.push(0.3);
    const brands = ((env && env.ua_brands) || []) as Array<{ brand?: string }>;
    const names = brands.map((b) => (b && b.brand) || "").join("|");
    if (brands.length && /Chromium/.test(names) && !/Google Chrome|Microsoft Edge|Opera|Brave|Samsung/.test(names)) s.push(0.3);
    if (hs && hs.notification_denied) s.push(0.15);
    if (!s.length) return 0;
    s.sort((a, b) => b - a);
    let c = s[0]; for (let i = 1; i < s.length; i++) c += s[i] * 0.2 * (1 - c);
    return Math.min(c, 0.99);
  }
  function maybeRecord() {
    if (recLoaded || !opts.loadRecorder || agentScore() < 0.5) return;
    recLoaded = true;
    const recSid = sid;
    try { opts.loadRecorder({ k: key, sid, endpoint: recEndpoint, pv: () => pv, url: () => (page ? page.url : safePath(location.href)), active: () => started && sid === recSid }); } catch { /* recording is optional */ }
  }
  function startPage() {
    pv++; touch();
    page = { url: safePath(location.href), started: Date.now(), closed: false, pending: [], engId: eventId(), sent: 0,
      c: { mousemoves: 0, scrolls: 0, clicks: 0, keys: 0, touches: 0, first_input_ms: null, errors: 0 },
      lastActT: 0, lastAct: "", lastErrT: 0, errShownT: 0,
      pathLen: 0, firstX: null, firstY: null, lastX: null, lastY: null, lastMoveT: null, maxSpeed: 0,
      dirChanges: 0, lastDX: 0, lastDY: 0, scrollDeltas: [], lastScrollY: w.scrollY || 0,
      moveToClick: null, seen: {}, flags: {}, lastMutT: 0, lastCommerceT: 0, delayed: [], recent: [], rageAt: 0,
      fields: {}, focused: null, lastInputT: 0 };
    collectEnv();
    maybeRecord();
    let httpStatus: number | null = null;
    try { const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming & { responseStatus?: number }; if (nav && typeof nav.responseStatus === "number" && nav.responseStatus > 0) httpStatus = nav.responseStatus; } catch { /* unsupported */ }
    post([{ eid: eventId(), ev: "page_view", t: 0, props: httpStatus ? { http_status: httpStatus } : {} }]);
    if (timer) clearTimeout(timer);
    if (flusher) clearInterval(flusher);
    timer = setTimeout(() => { snapshot(false); }, 8000);
    flusher = setInterval(() => { flushPending(); drainOutbox(); }, 5000);
    scanDom();
    watchDom();
    watchMutations();
  }
  function add(ev: string, props?: Record<string, unknown>, at?: number) {
    if (!page || page.closed || page.pending.length >= MAX_EVENTS || page.sent >= MAX_PAGE_EVENTS) return;
    page.sent++;
    page.pending.push({ eid: eventId(), ev, t: (at || Date.now()) - page.started, props: props || {} });
    touch();
  }
  function engagement(p: Page): Record<string, unknown> {
    const c = p.c;
    const net = p.firstX === null ? 0 : Math.hypot((p.lastX as number) - p.firstX, (p.lastY as number) - (p.firstY as number));
    const eng: Record<string, unknown> = {
      dwell_ms: Date.now() - p.started,
      active_ms: p.lastInputT ? p.lastInputT - p.started : 0,
      mousemoves: c.mousemoves, scrolls: c.scrolls, clicks: c.clicks, keys: c.keys, touches: c.touches, first_input_ms: c.first_input_ms, errors: c.errors,
      path_len: Math.round(p.pathLen),
      straightness: p.pathLen > 0 ? Math.round(Math.min(1, net / p.pathLen) * 100) / 100 : null,
      max_speed: Math.round(p.maxSpeed * 100) / 100,
      dir_changes: p.dirChanges,
      move_to_click_ms: p.moveToClick,
      scroll_uniform: p.scrollDeltas.length >= 3 && p.scrollDeltas.every((d) => d === p.scrollDeltas[0]),
    };
    // Per-field friction (form-analytics style): times entered, changes, keystrokes, validation errors, ms focused.
    const fields: Record<string, Field> = {}; let any = false;
    for (const k in p.fields) { const st = p.fields[k]; fields[k] = { f: st.f, c: st.c, k: st.k, inv: st.inv, ms: st.ms }; any = true; }
    if (p.focused && fields[p.focused.k]) fields[p.focused.k].ms += focusedMs(Date.now());
    if (any) eng.fields = fields;
    return eng;
  }
  function flushPending() {
    if (!page || page.closed || page.pending.length === 0) return;
    const events = page.pending; page.pending = [];
    post(events);
  }
  // The engagement summary keeps its event id, so the 8 s snapshot and the final one are one row.
  function snapshot(final: boolean) {
    if (!page || page.closed) return;
    const eng = engagement(page);
    eng.final = !!final;
    const events = page.pending.concat([{ eid: page.engId, ev: "engagement", t: eng.dwell_ms, props: eng }]);
    page.pending = [];
    post(events, { behavior: eng }, !!final);
  }
  function closePage() {
    if (!page || page.closed) return;
    const p = page;
    p.delayed.forEach((d) => { if (d.timer) clearTimeout(d.timer); add("click", d.props, d.at); });
    p.delayed = [];
    if (mutObs) { mutObs.disconnect(); mutObs = null; }
    snapshot(true);
    p.closed = true;
    if (timer) { clearTimeout(timer); timer = null; }
    if (flusher) { clearInterval(flusher); flusher = null; }
    if (observer) { observer.disconnect(); observer = null; }
  }

  function mark(k: "mousemoves" | "scrolls" | "clicks" | "keys" | "touches") {
    if (!page) return; page.c[k]++; const now = Date.now(); page.lastInputT = now; if (page.c.first_input_ms === null) page.c.first_input_ms = now - page.started;
  }
  on(w, "mousemove", (e: MouseEvent) => {
    if (!page) return; mark("mousemoves");
    const now = Date.now();
    if (page.lastX !== null && page.lastY !== null) {
      const dx = e.clientX - page.lastX, dy = e.clientY - page.lastY, d = Math.hypot(dx, dy);
      page.pathLen += d;
      const dt = now - (page.lastMoveT || now);
      if (dt > 0) page.maxSpeed = Math.max(page.maxSpeed, d / dt);
      if (page.lastDX * dx + page.lastDY * dy < 0) page.dirChanges++;
      page.lastDX = dx; page.lastDY = dy;
    } else { page.firstX = e.clientX; page.firstY = e.clientY; }
    page.lastX = e.clientX; page.lastY = e.clientY; page.lastMoveT = now;
  }, { passive: true });
  on(w, "scroll", () => {
    if (!page) return; mark("scrolls");
    const y = w.scrollY || 0;
    if (page.scrollDeltas.length < 20) page.scrollDeltas.push(Math.round(Math.abs(y - page.lastScrollY)));
    page.lastScrollY = y;
  }, { passive: true });
  on(w, "keydown", () => { mark("keys"); if (page && page.focused && page.fields[page.focused.k]) page.fields[page.focused.k].k++; }, { passive: true });
  on(w, "touchstart", () => { mark("touches"); }, { passive: true });
  on(w, "click", (e: MouseEvent) => {
    if (!page) return; mark("clicks");
    const p = page;
    if (p.moveToClick === null) p.moveToClick = p.lastMoveT === null ? -1 : Date.now() - p.lastMoveT;
    // Autocapture, PostHog-style: record what was clicked (text, tag, id, classes, link path) and nothing about what
    // it means. Meaning is confirmed by the merchant (track), the platform, or the data layer.
    const now = Date.now();
    // Rage click (Clarity's definition): three or more clicks within a second inside a 30 px radius.
    p.recent = p.recent.filter((c) => now - c.t < 1000 && Math.hypot(c.x - e.clientX, c.y - e.clientY) < 30);
    p.recent.push({ t: now, x: e.clientX, y: e.clientY });
    const target = e.target as Element | null;
    const t = target && target.closest ? target.closest("button, a, input[type=submit], input[type=button], input[type=checkbox], input[type=radio], [role=button], [role=checkbox]") : null;
    if (p.recent.length >= 3 && now - p.rageAt > 2000) { p.rageAt = now; add("rage_click", t ? elementInfo(t) : bareInfo(target)); }
    if (!t) return;
    // Dead click (no DOM change, no navigation, no cart event within a second) is decided after the fact, so the
    // record is delayed; a navigation flushes it as a normal click in closePage().
    p.lastActT = now; p.lastAct = "click";
    const props = elementInfo(t), d: Delayed = { props, timer: null, at: now };
    d.timer = setTimeout(() => {
      try {
        p.delayed = p.delayed.filter((x) => x !== d);
        props.dead = !!(p === page && p.lastMutT < now && p.lastCommerceT < now && safePath(location.href) === p.url);
        if (p.lastErrT >= now) props.error = true;
        add("click", props, now); // the click keeps the moment it happened, not the moment its verdict was known
      } catch { /* never break the page */ }
    }, 1000);
    if (p.delayed.length < 20) p.delayed.push(d); else { clearTimeout(d.timer); add("click", props, now); }
  }, { passive: true, capture: true });

  // What was clicked: text (with emails and long numbers masked), tag, id, classes, link path, and a short DOM path
  // (PostHog/Heap style) so the same control can be recognised on stores without ids.
  function mask(s: unknown): string { return String(s).replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[email]").replace(/\+?\d[\d\s().-]{7,}\d/g, "[number]").replace(/\d{4,}/g, "#"); }
  // Text is taken only from real buttons and simple links (no child elements): container-sized "buttons" such as
  // account menus or saved-address tiles carry names and addresses, so they are identified by DOM path alone.
  function labelOf(t: Element): string {
    const el = t as HTMLElement & { value?: string; type?: string };
    const tag = el.tagName.toLowerCase(), type = String(el.type || "").toLowerCase();
    if (tag === "input") return type === "submit" || type === "button" ? String(el.value || "") : "";
    if (tag === "select" || tag === "textarea" || el.isContentEditable) return "";
    const aria = el.getAttribute("aria-label") || el.getAttribute("title") || "";
    if (aria) return aria;
    return el.querySelectorAll("*").length <= 5 ? String(el.innerText || "") : "";
  }
  function bareInfo(t: Element | null): Record<string, unknown> { return t && t.tagName ? { tag: t.tagName.toLowerCase(), dom: domPath(t) } : {}; }
  // The accessibility role and name are what a browser agent sees of a control (Playwright's getByRole, the
  // accessibility tree every agent framework reads), so they are the control's identity here too.
  const IMPLICIT_ROLE: Record<string, string> = { button: "button", a: "link", select: "combobox", textarea: "textbox", summary: "button", option: "option" };
  function accRole(t: Element): string {
    const r = t.getAttribute("role"); if (r) return String(r).split(/\s+/)[0].toLowerCase().slice(0, 20);
    const tag = t.tagName.toLowerCase();
    if (tag === "input") { const ty = String((t as HTMLInputElement).type || "text").toLowerCase(); return ty === "submit" || ty === "button" || ty === "image" ? "button" : ty === "checkbox" || ty === "radio" ? ty : ty === "search" ? "searchbox" : "textbox"; }
    if (tag === "a") return t.getAttribute("href") ? "link" : "generic";
    return IMPLICIT_ROLE[tag] || "generic";
  }
  function textOf(el: Element): string { return (el as HTMLElement).innerText || el.textContent || ""; }
  function accName(t: Element): string {
    try {
      const by = t.getAttribute("aria-labelledby");
      if (by) { const parts: string[] = []; by.split(/\s+/).forEach((id) => { const el = document.getElementById(id); if (el) parts.push(textOf(el)); }); if (parts.join(" ").trim()) return parts.join(" "); }
      const al = t.getAttribute("aria-label"); if (al) return al;
      const tag = t.tagName.toLowerCase();
      if (tag === "input" || tag === "select" || tag === "textarea") {
        if (t.id) { const lab = document.querySelector('label[for="' + t.id.replace(/["\\]/g, "") + '"]'); if (lab) return textOf(lab); }
        const wrap = t.closest("label"); if (wrap) return textOf(wrap);
        const inp = t as HTMLInputElement;
        if (tag === "input" && (inp.type === "submit" || inp.type === "button")) return String(inp.value || "");
        return t.getAttribute("placeholder") || t.getAttribute("title") || "";
      }
      const img = t.querySelector("img[alt], svg[aria-label]");
      let text = textOf(t).trim();
      if (!text && img) text = img.getAttribute("alt") || img.getAttribute("aria-label") || "";
      return text || t.getAttribute("title") || "";
    } catch { return ""; }
  }
  function ctrlAttrs(t: Element): Record<string, string> {
    const a: Record<string, string> = {};
    try {
      const name = t.getAttribute("name"); if (name) a.name = String(name).slice(0, 40);
      const type = t.getAttribute("type"); if (type) a.type = String(type).toLowerCase().slice(0, 20);
      const form = (t as HTMLInputElement).form || t.closest("form");
      if (form) { try { a.form = new URL(safePath(form.getAttribute("action") || location.href)).pathname.slice(0, 80); } catch { /* unparsable */ } const fr = form.getAttribute("role"); if (fr) a.form_role = String(fr).slice(0, 20); }
      const da = t.getAttribute("data-action") || t.getAttribute("data-hook"); if (da) a.data = String(da).slice(0, 40);
    } catch { /* partial */ }
    return a;
  }
  function domPath(el: Element): string {
    const parts: string[] = []; let n: Element | null = el, depth = 0;
    while (n && n.nodeType === 1 && n !== document.body && depth < 4) {
      const cur: Element = n;
      const tag = cur.tagName.toLowerCase(), cls = cur.className && typeof cur.className === "string" ? cur.className.split(/\s+/).filter(Boolean)[0] : "";
      let seg = tag + (cur.id ? "#" + cur.id : cls ? "." + cls : "");
      if (!cur.id && cur.parentElement) {
        const same = Array.prototype.filter.call(cur.parentElement.children, (c: Element) => c.tagName === cur.tagName) as Element[];
        if (same.length > 1) seg += ":nth-of-type(" + (same.indexOf(cur) + 1) + ")";
      }
      parts.unshift(seg); n = cur.parentElement; depth++;
    }
    return parts.join(">").slice(0, 120);
  }
  const CAPTCHA_BOX = '.g-recaptcha, .h-captcha, .cf-turnstile, [data-sitekey], #captcha, [class*="captcha" i]';
  function inCaptcha(t: Element | null): boolean { try { return !!(t && t.closest && t.closest(CAPTCHA_BOX)); } catch { return false; } }
  function elementInfo(t: Element): Record<string, unknown> {
    if (!t || !t.tagName) return {};
    const rawCls = (t as Element & { className: unknown }).className;
    const cls = rawCls && typeof rawCls === "object" ? ((rawCls as SVGAnimatedString).baseVal || "") : (rawCls || "");
    let href = "";
    try { const h = (t as HTMLAnchorElement).href; if (h) href = new URL(safePath(String(h))).pathname.slice(0, 80); } catch { /* unparsable */ }
    return {
      text: mask(labelOf(t)).replace(/\s+/g, " ").trim().slice(0, 60),
      tag: t.tagName.toLowerCase(), id: String(t.id || "").slice(0, 40),
      cls: String(cls).split(/\s+/).filter(Boolean).slice(0, 3).join(" ").slice(0, 60), href, dom: domPath(t),
      arole: accRole(t), aname: mask(accName(t)).replace(/\s+/g, " ").trim().slice(0, 80), attrs: ctrlAttrs(t),
      captcha: inCaptcha(t) || undefined,
    };
  }
  // Real CAPTCHA widgets live in iframes, so their clicks never reach this page. Focus moving into such an iframe is
  // the visible trace of an interaction with the widget.
  on(w, "blur", () => {
    const a = document.activeElement;
    if (page && a && a.tagName === "IFRAME" && inCaptcha(a)) add("click", { tag: "iframe", dom: domPath(a.closest(CAPTCHA_BOX) || a), captcha: true });
  });
  // A light, page-long observer whose only job is a timestamp of the last DOM change, for dead-click detection.
  function watchMutations() {
    if (typeof MutationObserver === "undefined") return;
    if (mutObs) mutObs.disconnect();
    const ERR_SEL = '[role="alert"], [aria-live="assertive"], [aria-invalid="true"], .error, .errors, .field-error, .form-error, .alert-danger, .invalid-feedback, .validation-error';
    function errorNode(n: Node): Element | null {
      if (!n || n.nodeType !== 1) return null;
      const el = n as Element;
      try { if (el.matches(ERR_SEL)) return el; const q = el.querySelector(ERR_SEL); if (q) return q; } catch { /* invalid */ }
      return null;
    }
    mutObs = new MutationObserver((list) => {
      try {
        if (!page) return;
        const now = Date.now(); page.lastMutT = now;
        // Within 2 s of a click or submit, a newly shown error element means the action was rejected on the page.
        if (!page.lastActT || now - page.lastActT > 2000 || now - page.errShownT < 2000) return;
        for (let i = 0; i < list.length; i++) {
          const m = list[i]; let hit: Element | null = null;
          if (m.type === "childList") { for (let j = 0; j < m.addedNodes.length && !hit; j++) hit = errorNode(m.addedNodes[j]); }
          else if (m.type === "attributes" && m.target) { const el = m.target as HTMLElement; try { if (el.matches(ERR_SEL) && !el.hidden && el.getAttribute("aria-hidden") !== "true") hit = el; } catch { /* invalid */ } }
          else if (m.type === "characterData" && m.target && m.target.parentElement) { const pe = m.target.parentElement; try { if (pe.matches(ERR_SEL) || pe.closest(ERR_SEL)) hit = pe.closest(ERR_SEL); } catch { /* invalid */ } }
          if (hit && (hit.textContent || "").trim()) { page.errShownT = now; add("error_shown", { after: page.lastAct, dom: domPath(hit) }); return; }
        }
      } catch { /* never break the page */ }
    });
    mutObs.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["class", "style", "hidden", "open", "aria-expanded", "aria-hidden", "aria-invalid", "role", "src"] });
  }

  // Zero-setup cart events from the store's own cart API. A successful call to Shopify's /cart/add.js or WooCommerce's
  // add-to-cart endpoint is a fact, not a guess; recorded with via 'platform_api'.
  const SHOPIFY_ADD = /\/cart\/add(\.js|\.json)?(\?|$)/, WOO_ADD = /wc-ajax=add_to_cart|\/wc\/store\/v1\/cart\/add-item/;
  function cartApiDone(url: string, status: number, body: string) {
    if (status < 200 || status >= 300) return;
    if (SHOPIFY_ADD.test(url)) {
      const p: CommerceProps = {};
      try {
        const j = JSON.parse(body), line = j && j.items ? j.items[0] : j;
        if (line) { p.items = line.quantity; p.item_id = line.product_id; if (typeof line.final_line_price === "number") p.value = line.final_line_price / 100; }
      } catch { /* not JSON */ }
      try { const s = (w as any).Shopify; p.currency = s && s.currency && s.currency.active; } catch { /* no Shopify global */ }
      commerce("add_to_cart", p, "platform_api");
    } else if (WOO_ADD.test(url)) commerce("add_to_cart", {}, "platform_api");
  }
  // The page's own fetch, captured before this script wraps it, is what the tracker uses for its beacons, so its
  // requests never pass through the wrapper (and never through wrappers other scripts add later).
  const fetchRaw: typeof fetch = w.fetch ? w.fetch.bind(w) : ((() => Promise.reject(new Error("no fetch"))) as unknown as typeof fetch);
  function watchCartApi() {
    if (w.fetch) {
      const origFetch = w.fetch;
      w.fetch = function (this: unknown, input: RequestInfo | URL, init?: RequestInit) {
        // eslint-disable-next-line prefer-rest-params
        const r = origFetch.apply(this, arguments as unknown as [RequestInfo | URL, RequestInit?]);
        try {
          const u = typeof input === "string" ? input : input instanceof URL ? input.href : (input && (input as Request).url) || "";
          if (SHOPIFY_ADD.test(u)) r.then((res) => { try { res.clone().text().then((txt) => { try { cartApiDone(u, res.status, txt); } catch { /* ignore */ } }, () => {}); } catch { /* ignore */ } }, () => {});
          else if (WOO_ADD.test(u)) r.then((res) => { try { cartApiDone(u, res.status, ""); } catch { /* ignore */ } }, () => {});
        } catch { /* never break the page */ }
        void init;
        return r;
      } as typeof fetch;
    }
    if (typeof XMLHttpRequest !== "undefined") {
      const origOpen = XMLHttpRequest.prototype.open;
      XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, _m: string, u: string | URL) {
        try {
          const url = String(u);
          if (SHOPIFY_ADD.test(url)) this.addEventListener("load", function (this: XMLHttpRequest) { try { cartApiDone(url, this.status, this.responseText); } catch { /* ignore */ } });
          else if (WOO_ADD.test(url)) this.addEventListener("load", function (this: XMLHttpRequest) { try { cartApiDone(url, this.status, ""); } catch { /* ignore */ } });
        } catch { /* never break the page */ }
        // eslint-disable-next-line prefer-rest-params
        return (origOpen as (...a: unknown[]) => void).apply(this, arguments as unknown as unknown[]);
      } as typeof XMLHttpRequest.prototype.open;
    }
  }
  // Each hook is optional: a page that froze fetch, XMLHttpRequest or history (some hardened sites do) loses that one
  // source of events, never the tracker, and never gets an exception.
  try { watchCartApi(); } catch { /* frozen platform objects */ }

  // ── Commerce events ──
  const COMMERCE: Record<string, 1> = { view_item: 1, add_to_cart: 1, remove_from_cart: 1, view_cart: 1, begin_checkout: 1, checkout_step: 1, add_shipping_info: 1, add_payment_info: 1, purchase: 1, search: 1 };
  function commerce(name: string, props: CommerceProps | undefined, via: string) {
    if (!COMMERCE[name]) return;
    const p: Record<string, unknown> = { via };
    if (props && typeof props === "object") {
      if (typeof props.value === "number" && isFinite(props.value)) p.value = props.value;
      if (typeof props.currency === "string") p.currency = props.currency.slice(0, 3).toUpperCase();
      if (typeof props.items === "number" && isFinite(props.items)) p.items = Math.round(props.items);
      if (props.order_id != null) p.order_id = String(props.order_id).slice(0, 64);
      if (props.item_id != null) p.item_id = String(props.item_id).slice(0, 64);
      if (typeof props.step === "string") p.step = props.step.slice(0, 20);
    }
    add(name, p);
    if (page) page.lastCommerceT = Date.now();
    if (name === "purchase" || name === "begin_checkout" || name === "add_to_cart") flushPending();
  }

  // Tier 1: the merchant's own code, through the returned API or window.parlox (which also works before load via the
  // stub in the install guide).
  const existing: WindowParlox = w.parlox && typeof w.parlox === "object" ? w.parlox : {};
  // Consent decisions in the stub's queue are read in full (a refusal must never be cut off by the cap); other calls
  // are kept up to 100.
  const stubQueue: Queued[] = Array.isArray(existing.q) ? existing.q : [];
  const stubConsent = stubQueue.filter((args) => Array.prototype.slice.call(args)[0] === "consent");
  let queued: Queued[] = stubQueue.filter((args) => Array.prototype.slice.call(args)[0] !== "consent").slice(0, 100);
  let withdrawn = false;
  const api: ParloxApi = {
    // Before the page opens (consent pending, first decision not made) calls wait, at most 100; after consent has been
    // withdrawn they are dropped, so nothing from a refused period is sent if consent is granted again later.
    track(name: string, props?: CommerceProps) { try { if (!started) { if (!withdrawn && queued.length < 100) queued.push(["track", name, props]); return; } commerce(String(name), props, "api"); } catch { /* never throw into the caller */ } },
    sessionId() { return sid; },
    consent(granted: boolean) {
      try {
        if (granted !== false) { consentRequired = false; withdrawn = false; begin(); return; }
        // Withdrawn: stop without sending, forget the tab's id and outbox. A new id is drawn, so a later consent(true)
        // starts a new visit rather than continuing the forgotten one, and a running recorder sees it is no longer
        // active and stops for good (it is not restarted on this page).
        consentRequired = true;
        // A refusal before tracking ever started is a decision, not a withdrawal: calls keep waiting for a later grant.
        const wasRunning = started;
        if (page && !page.closed) { page.closed = true; page.pending = []; if (timer) { clearTimeout(timer); timer = null; } if (flusher) { clearInterval(flusher); flusher = null; } if (mutObs) { mutObs.disconnect(); mutObs = null; } }
        try { sessionStorage.removeItem("_plx"); sessionStorage.removeItem(OUTBOX); } catch { /* storage unavailable */ }
        started = false;
        if (!wasRunning) return;
        sid = hex(12); pv = 0;
        withdrawn = true; queued = []; dlBacklog = null; // data-layer messages while withdrawn are dropped, not kept
      } catch { /* never throw into the caller */ }
    },
  };
  const globalApi = existing;
  globalApi.track = api.track;
  globalApi.sessionId = api.sessionId;
  globalApi.consent = api.consent;
  // Calls through the pre-load stub after load: a consent decision applies at once, anything else is a track call.
  globalApi.q = { push(args: Queued) { try { const a = Array.prototype.slice.call(args); if (a[0] === "consent") { api.consent(a[1] as boolean); return; } if (started) replay(a); else if (!withdrawn && queued.length < 100) queued.push(a); } catch { /* ignore */ } } };
  w.parlox = globalApi;

  // Tier 2: the store's Google data layer, GA4 ecommerce vocabulary (dataLayer.push({event, ecommerce}) and
  // gtag('event', name, params)). Observed the way a second GTM container does it: keep the previous push, call it,
  // return its result. Nothing is removed or reordered.
  function fromDataLayer(msg: any) {
    if (!msg || typeof msg !== "object") return;
    let name: string, params: any;
    if (typeof msg.event === "string") { name = msg.event; params = msg.ecommerce || {}; }
    else if (msg.length >= 2 && msg[0] === "event" && typeof msg[1] === "string") { name = msg[1]; params = msg[2] || {}; }
    else return;
    if (!COMMERCE[name] || typeof params !== "object") return;
    const items = Array.isArray(params.items) ? params.items : null;
    commerce(name, {
      value: typeof params.value === "string" ? parseFloat(params.value) : params.value, currency: params.currency,
      items: items ? items.length : undefined, order_id: params.transaction_id, item_id: items && items[0] ? items[0].item_id : undefined,
    }, "datalayer");
  }
  // Messages that arrive before the page is open (pushed before this script loaded, or while consent is pending)
  // wait here and are read once it opens; bounded, like the stub's queue.
  let dlBacklog: unknown[] | null = [];
  function readDataLayer(msg: unknown) {
    if (dlBacklog) { if (dlBacklog.length < 50) dlBacklog.push(msg); return; }
    try { fromDataLayer(msg); } catch { /* ignore */ }
  }
  function watchDataLayer() {
    const dl = (w.dataLayer = w.dataLayer || []);
    if (typeof dl.push !== "function") return;
    for (let i = 0; i < dl.length; i++) readDataLayer(dl[i]);
    const prev = dl.push;
    dl.push = function (this: unknown[]) {
      // eslint-disable-next-line prefer-rest-params
      const r = prev.apply(this, arguments as unknown as unknown[]);
      for (let j = 0; j < arguments.length; j++) readDataLayer(arguments[j]);
      return r;
    };
  }
  try { watchDataLayer(); } catch { /* a data layer we cannot wrap */ }

  function fieldInfo(f: HTMLInputElement): Record<string, unknown> {
    return { name: String(f.name || f.id || "").slice(0, 40), type: String(f.type || f.tagName || "").toLowerCase().slice(0, 20), ac: String(f.getAttribute("autocomplete") || "").slice(0, 30) };
  }
  function isField(f: any): f is HTMLInputElement { return !!(f && f.matches && f.matches("input, select, textarea") && !/^(hidden|submit|button|image|reset)$/.test(f.type || "")); }
  function fieldKey(f: HTMLInputElement): string { return String(f.name || f.id || f.type || "").slice(0, 40); }
  function fieldStat(f: HTMLInputElement): Field | null {
    if (!page) return null;
    const k = fieldKey(f);
    if (!page.fields[k]) { if (Object.keys(page.fields).length >= 30) return null; page.fields[k] = { f: 0, c: 0, k: 0, inv: 0, ms: 0 }; }
    return page.fields[k];
  }
  // Time in a field counts until the last input plus a moment, never the hours a tab sat idle with the cursor in it.
  function focusedMs(now: number): number { if (!page || !page.focused) return 0; const end = page.lastInputT ? Math.min(now, page.lastInputT + 5000) : now; return Math.max(0, end - page.focused.t); }
  function leaveField() {
    if (!page || !page.focused) return;
    const st = page.fields[page.focused.k]; if (st) st.ms += focusedMs(Date.now());
    page.focused = null;
  }
  on(w, "focusin", (e: FocusEvent) => {
    const f = e.target; if (!isField(f)) return;
    leaveField();
    const st = fieldStat(f); if (st && page) { st.f++; page.focused = { k: fieldKey(f), t: Date.now() }; }
    const k = "f:" + (f.name || f.id || f.type); if (page && !page.seen[k]) { page.seen[k] = 1; add("field_focus", fieldInfo(f)); }
  }, { passive: true });
  on(w, "focusout", (e: FocusEvent) => { if (isField(e.target)) leaveField(); }, { passive: true });
  on(w, "change", (e: Event) => {
    const f = e.target; if (!isField(f)) return;
    const st = fieldStat(f); if (st) st.c++;
    const k = "c:" + (f.name || f.id || f.type); if (page && !page.seen[k]) { page.seen[k] = 1; add("field_change", fieldInfo(f)); }
  }, { passive: true, capture: true });
  // Script errors: a count per page and a flag on the click that triggered one. Never the message.
  on(w, "error", () => { if (page) { page.c.errors++; page.lastErrT = Date.now(); } });
  on(w, "unhandledrejection", () => { if (page) { page.c.errors++; page.lastErrT = Date.now(); } });

  on(w, "submit", (e: SubmitEvent) => {
    if (page) { page.lastActT = Date.now(); page.lastAct = "submit"; }
    const f = e.target as HTMLFormElement; let action = "";
    try { action = new URL(safePath(f.getAttribute("action") || location.href)).pathname; } catch { /* unparsable */ }
    add("submit", { form: String((f.getAttribute && (f.getAttribute("id") || f.getAttribute("name"))) || "").slice(0, 40), action: action.slice(0, 80) });
  }, { passive: true, capture: true });
  on(w, "invalid", (e: Event) => {
    const f = e.target; if (!isField(f)) return;
    const v = f.validity as ValidityState & Record<string, boolean>; let reason = "unknown";
    ["valueMissing", "typeMismatch", "patternMismatch", "rangeUnderflow", "rangeOverflow", "tooShort", "tooLong", "stepMismatch", "badInput", "customError"]
      .some((r) => { if (v && v[r]) { reason = r; return true; } return false; });
    const info = fieldInfo(f); info.reason = reason;
    const st = fieldStat(f); if (st) st.inv++;
    add("invalid", info);
  }, { passive: true, capture: true });

  const CAPTCHA: Array<[RegExp, string]> = [[/recaptcha/i, "recaptcha"], [/hcaptcha/i, "hcaptcha"], [/turnstile|challenges\.cloudflare/i, "turnstile"], [/arkoselabs|funcaptcha/i, "arkose"]];
  const PAYMENT: Array<[RegExp, string]> = [[/js\.stripe\.com|checkout\.stripe/i, "stripe"], [/paypal\.com/i, "paypal"], [/adyen/i, "adyen"], [/braintree/i, "braintree"], [/checkout\.shopify|shopifycs/i, "shopify"], [/klarna/i, "klarna"]];
  function scanDom() {
    if (!page || page.closed) return;
    if (!page.flags.loadErr) {
      page.flags.loadErr = 1;
      try {
        const alertEl = document.querySelector('[role="alert"], .alert-danger, .form-error, .validation-error') as HTMLElement | null;
        if (alertEl && !alertEl.hidden && (alertEl.textContent || "").trim() && alertEl.getClientRects().length) add("error_shown", { after: "load", dom: domPath(alertEl) });
      } catch { /* ignore */ }
    }
    const frames = document.querySelectorAll("iframe[src], script[src]");
    const srcs = Array.prototype.map.call(frames, (f: HTMLIFrameElement) => f.src || "") as string[];
    if (!page.flags.captcha) {
      let hit: string | null = null;
      if (document.querySelector(".g-recaptcha, .h-captcha, .cf-turnstile, [data-sitekey]")) hit = "widget";
      CAPTCHA.forEach((p) => { if (!hit && srcs.some((s) => p[0].test(s))) hit = p[1]; });
      if (hit) { page.flags.captcha = 1; add("captcha_shown", { vendor: hit }); }
    }
    if (!page.flags.payment) {
      let prov: string | null = null;
      PAYMENT.forEach((p) => { if (!prov && srcs.some((s) => p[0].test(s))) prov = p[1]; });
      if (!prov && document.querySelector('input[autocomplete="cc-number"], input[name*="card" i][name*="number" i]')) prov = "form";
      if (prov) { page.flags.payment = 1; add("payment_form", { provider: prov }); }
    }
  }
  function watchDom() {
    if (typeof MutationObserver === "undefined") return;
    let last = 0;
    observer = new MutationObserver(() => { try { const n = Date.now(); if (n - last > 1000) { last = n; scanDom(); } } catch { /* ignore */ } });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    setTimeout(() => { if (observer) { observer.disconnect(); observer = null; } }, 30000);
  }

  // Single-page apps change the URL without reloading; treat each change as a new page view.
  function onRoute() { try { if (started && page && safePath(location.href) !== page.url) { closePage(); startPage(); } } catch { /* ignore */ } }
  (["pushState", "replaceState"] as const).forEach((m) => {
    try {
      const orig = history[m];
      if (typeof orig === "function") history[m] = function (this: History) {
        // eslint-disable-next-line prefer-rest-params
        const r = (orig as (...a: unknown[]) => void).apply(this, arguments as unknown as unknown[]);
        setTimeout(onRoute, 0);
        return r;
      } as History[typeof m];
    } catch { /* frozen history: route changes are then seen through popstate only */ }
  });
  on(w, "popstate", () => { setTimeout(onRoute, 0); });

  on(w, "pagehide", closePage);
  on(w, "pageshow", (e: PageTransitionEvent) => { if (e.persisted && started && page && page.closed) startPage(); });
  on(document, "visibilitychange", () => { if (document.visibilityState === "hidden") snapshot(true); });
  function begin() {
    if (started) return;
    started = true;
    startPage();
    setTimeout(drainOutbox, 1500);
    // Calls made before the script loaded (queued by the stub) and data-layer messages that arrived before the page
    // opened are replayed now, in that order.
    const q = queued; queued = [];
    q.forEach((args) => { try { replay(args); } catch { /* ignore */ } });
    const backlog = dlBacklog || []; dlBacklog = null;
    backlog.forEach((msg) => { try { fromDataLayer(msg); } catch { /* ignore */ } });
  }
  function replay(args: Queued) {
    let a = Array.prototype.slice.call(args);
    if (a[0] === "consent") return; // handled before begin()
    if (a[0] === "track") a = a.slice(1);
    api.track(a[0] as string, a[1] as CommerceProps | undefined);
  }
  // Consent decisions queued before the script loaded count, the last one winning.
  stubConsent.forEach((args) => { const a = Array.prototype.slice.call(args); consentRequired = a[1] === false; });
  if (!consentRequired) begin();
  return api;
}
