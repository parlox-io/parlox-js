// The agent-visit recorder. Loaded by the tracker only when the page's own signals say the browser is automated; a
// person's browser never runs it. It records the page's DOM and its changes (rrweb) with every input and all text
// masked (control labels and merchant-approved areas excepted), batches the events, compresses them, and posts them to
// the gateway in bounded chunks. Hard caps: 5 MB per visit, 40 chunks, 30 minutes.
//
// In the npm build the merchant's bundler includes this module and the tracker imports it lazily, so no code is
// fetched from Parlox at runtime; the hosted tag loads the same code as /sdk/<version>/parlox-record.js with an
// integrity hash.

import { record } from "@rrweb/record";
import type { RecorderConfig } from "./tracker.js";

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
  const CONTROL = 'button, a[href], [role="button"], [role="link"], summary';
  const star = (s: string) => s.replace(/\S/g, "*");
  const maskLabel = (s: string) => s.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[email]").replace(/\+?\d[\d\s().-]{7,}\d/g, "[number]").replace(/\d{4,}/g, "#");
  function maskText(text: string, el: HTMLElement | null): string {
    try {
      if (!el || el.closest("[data-plx-mask]")) return star(text);
      if (el.closest("[data-plx-unmask]")) return text;
      const control = el.closest(CONTROL);
      if (control && control.querySelectorAll("*").length <= 5 && text.length <= 80) return maskLabel(text);
    } catch { /* masked below */ }
    return star(text);
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
      emit(event) { if (!stopped && !inactive()) buffer.push(event); },
      maskAllInputs: true,
      maskTextSelector: "*",
      maskTextFn: maskText,
      blockSelector: "[data-plx-block], iframe",
      sampling: { mousemove: 50, mouseInteraction: true, scroll: 150, input: "last" },
      inlineStylesheet: true,
      collectFonts: false,
      recordCanvas: false,
      checkoutEveryNms: 60_000,
    });
  } catch { stopped = true; return; }

  setTimeout(() => flush(false), 700);   // the full snapshot, before the page can go away
  timer = setInterval(() => { if (Date.now() - started > MAX_MS) { flush(true); stop(); return; } flush(false); }, FLUSH_MS);
  addEventListener("pagehide", () => { flush(true); });
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flush(true); });
}
