// The hosted tag (<script async src="https://gateway.parlox.io/sdk/<version>/parlox.js" data-key="pk_...">), for sites
// without a build step: Shopify themes, tag managers, plain HTML. Same tracker as the npm module.
//
// The key comes from data-key, or from the script URL (?key=) for tag managers that cannot set attributes; consent
// mode from data-consent="required" (or ?consent=required). The recorder is loaded from this same release with the
// integrity hash computed at build time, so a merchant who pins this file with SRI pins the recorder too.

import { startTracker } from "./tracker.js";

declare const __SDK_VERSION__: string;
declare const __RECORDER_SRI__: string;

(function () {
  try {
    const el = document.currentScript as HTMLScriptElement | null;
    if (!el || !el.src) return;
    const src = new URL(el.src);
    const key = el.dataset.key || src.searchParams.get("key") || "";
    const consent = el.dataset.consent === "required" || src.searchParams.get("consent") === "required" ? "required" : "granted";
    const endpoint = src.origin;
    startTracker({
      publicKey: key,
      endpoint,
      consent,
      loadRecorder(cfg) {
        (window as unknown as { __plxRec?: unknown }).__plxRec = cfg;
        const s = document.createElement("script");
        s.async = true;
        s.src = `${endpoint}/sdk/${__SDK_VERSION__}/parlox-record.js`;
        s.integrity = __RECORDER_SRI__;
        s.crossOrigin = "anonymous";
        document.head.appendChild(s);
      },
    });
  } catch { /* never break the page */ }
})();
