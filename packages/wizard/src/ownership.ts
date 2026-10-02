import { hostStepFor, type AppUnit } from "./apps.js";
import { readInside } from "./fs-safe.js";
import type { Host } from "./hosts.js";
import type { Plan } from "./plan-core.js";
import { GUIDE } from "./workspace.js";

// What the report says about proving the domain is the merchant's. The gateway accepts three proofs (the install guide
// lists them): its fetcher finds the pinned tag with the site's key in the homepage's HTML; the site answers
// /.well-known/parlox-verify with the verification code; or a DNS record. The report says ownership is
// confirmed after the deploy only when something this run added, or found already there, gives one of the first two:
// - a server part with a host step (the middleware or adapter answers the check once PARLOX_VERIFY_TOKEN is set);
// - the ownership file, planned or already there with this site's code (wherever it is planned: a static site's own
//   server part, or a Vite app's file when its server part is withheld);
// - a tag the server sends in its HTML (Express pages, a Hono layout): an inference that the homepage carries it, said
//   as such. A tag added in JavaScript (the Vite entry, the React component) is not in the HTML the gateway reads.
// Otherwise it says how to prove it: the DNS record, or the server part by hand.

const VERIFY_FILE = /(?:^|\/)\.well-known\/parlox-verify$/;
const TAG_KINDS = new Set(["express-pages", "hono-layout"]);

type Proof = "answers" | "tag" | null;

/** The ownership file's text proves the site: the code alone, or "parlox-verify=<code>" (whitespace ignored). */
const proves = (text: string | null | undefined, token: string) => typeof text === "string" && (text.trim() === token || text.trim() === `parlox-verify=${token}`);

function proofOf(u: AppUnit, plan: Plan, host: Host, token: string): Proof {
  const serverFile = u.server?.parts.server?.file ?? null;
  const serverByHand = plan.manual.some((m) => m.part === "server" || (serverFile !== null && m.file === serverFile));
  if (u.server && hostStepFor(u, host) && !serverByHand) return "answers";
  if (plan.changes.some((c) => VERIFY_FILE.test(c.path) && proves(c.after, token))) return "answers";
  for (const d of u.detections) {
    const s = d.parts.server;
    if (s?.kind !== "verify-file" || !s.file || plan.changes.some((c) => c.path === s.file)) continue;
    let text: string | null = null;
    try { text = readInside(u.dir, s.file); } catch { text = null; }
    if (proves(text, token)) return "answers";
  }
  const browser = u.browser?.parts.browser;
  if (browser && TAG_KINDS.has(browser.kind) && (plan.changes.some((c) => /browser/.test(c.purpose ?? "")) || !plan.manual.some((m) => m.part === "browser"))) return "tag";
  return null;
}

/** The report's line on ownership of `domain`, from each app's own plan (its paths unprefixed). */
export function ownershipLine(planned: Array<{ unit: AppUnit; plan: Plan }>, hostOf: (u: AppUnit) => Host, token: string, domain: string): string {
  const proofs = planned.map(({ unit, plan }) => proofOf(unit, plan, hostOf(unit), token));
  if (proofs.includes("answers")) return `Ownership of ${domain}: confirmed after you deploy (the dashboard checks it when you open the site).`;
  if (proofs.includes("tag")) return `Ownership of ${domain}: confirmed after you deploy, if your homepage carries the tag (the dashboard checks it when you open the site).`;
  return `Ownership of ${domain}: nothing the wizard added can prove it yet. Prove it with the DNS record the dashboard lists for the site, or add the server part by hand (it answers the ownership check; see ${GUIDE}).`;
}
