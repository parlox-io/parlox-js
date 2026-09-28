// @parlox/browser: Parlox agent analytics for the merchant's own build (npm install @parlox/browser).
//
//   import { init, track } from "@parlox/browser";
//   init({ publicKey: "pk_..." });
//   track("add_to_cart", { item_id: "sku-1", value: 49.9, currency: "USD", items: 1 });
//
// Everything that runs on the page is in this package, pinned by the merchant's lockfile: nothing is fetched from
// Parlox at runtime. The agent-visit recorder is a lazy import, so it is a separate chunk the merchant's bundler
// builds and a person's browser never loads. Safe to import during server-side rendering: nothing runs until init()
// is called in a browser.

import { startTracker, PUBLIC_KEY_RE, type CommerceProps, type ParloxApi } from "./tracker.js";

export type { CommerceProps, ParloxApi } from "./tracker.js";

export const DEFAULT_ENDPOINT = "https://gateway.parlox.io";

export interface InitOptions {
  /** The site's public key from the Parlox dashboard (pk_...). Safe to ship to the browser. */
  publicKey: string;
  /** "required" keeps Parlox off (nothing stored or sent) until consent(true). Default "granted". */
  consent?: "granted" | "required";
  /** Record agent visits as a masked DOM replay. People are never recorded. Default true. */
  recordAgents?: boolean;
  /** The Parlox gateway. Only for testing against another deployment; must be https (http only for localhost). */
  endpoint?: string;
}

let instance: ParloxApi | null = null;
const pending: Array<["track", string, CommerceProps | undefined] | ["consent", boolean]> = [];

function validEndpoint(raw: string): string | null {
  try {
    const u = new URL(raw);
    const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
    if (u.protocol !== "https:" && !(local && u.protocol === "http:")) return null;
    return u.origin;
  } catch { return null; }
}

/**
 * Starts Parlox on this page. Call once, as early as possible, in the browser (in React, from an effect, or use
 * <ParloxAnalytics> from "@parlox/browser/react"). Returns null during server rendering or when the options are
 * invalid; it never throws.
 */
export function init(options: InitOptions): ParloxApi | null {
  if (typeof window === "undefined" || typeof document === "undefined") return null;
  if (instance) return instance;
  try {
    if (!options || typeof options.publicKey !== "string" || !PUBLIC_KEY_RE.test(options.publicKey)) {
      console.warn("[parlox] init: publicKey must be the site's public key (pk_...)");
      return null;
    }
    const endpoint = validEndpoint(options.endpoint ?? DEFAULT_ENDPOINT);
    if (!endpoint) { console.warn("[parlox] init: endpoint must be an https URL"); return null; }
    instance = startTracker({
      publicKey: options.publicKey,
      endpoint,
      consent: options.consent === "required" ? "required" : "granted",
      loadRecorder: options.recordAgents === false ? undefined : (cfg) => {
        import("./recorder.js").then((m) => m.startRecorder(cfg)).catch(() => { /* recording is optional */ });
      },
    });
    // Calls made before init, in order.
    for (const call of pending.splice(0)) {
      if (call[0] === "track") instance?.track(call[1], call[2]);
      else instance?.consent(call[1]);
    }
    return instance;
  } catch {
    return null;
  }
}

/** Records a commerce event (GA4 names: view_item, add_to_cart, begin_checkout, purchase, ...). Money in major units. */
export function track(name: string, props?: CommerceProps): void {
  if (instance) instance.track(name, props);
  else if (pending.length < 100) pending.push(["track", name, props]);
}

/** Grants (true) or withdraws (false) consent; withdrawing stops sending and forgets the tab's session. */
export function consent(granted: boolean): void {
  if (instance) instance.consent(granted);
  else if (pending.length < 100) pending.push(["consent", granted]);
}

/** The visit's session id, to send with a checkout so the server can post the confirmed order (see @parlox/server). */
export function sessionId(): string | null {
  return instance ? instance.sessionId() : null;
}
