// The host hand-off in words, shared by every face (the plain face, the fallback in withDefaults, the full screen and
// the summary printed after it): one wording wherever it is shown. It loads nothing (the plain face must not load Ink).
import { scrub } from "./scrub.js";
import { printable } from "./text.js";
import type { Handoff } from "./types.js";

export const HANDOFF_TITLE = "Connect your host";

/** The hand-off's line about the secret key: the dashboard link when there is one; the Settings → Keys page when the
 * key is still to be set but there is no link; nothing when the secret key is not among the variables still to set
 * (it is already on the host), so a face never asks for a key that is not needed. */
export function keyLine(h: Handoff): string | null {
  if (h.url) return `Create the secret key here (shown once):\n  ${h.url}`;
  return h.variables.some((v) => v.startsWith("PARLOX_SECRET_KEY")) ? "Create the secret key in the dashboard: Settings → Keys (shown once)." : null;
}

/** The hand-off in two parts, each line scrubbed and printable: `what` (the variables and where to paste them) and
 * `links` (the key line and the host's docs), each link on a line of its own. A face that draws a box puts only `what`
 * in it: a box wraps at the window's width, and a link broken across lines cannot be copied whole. */
export function handoffParts(h: Handoff): { what: string[]; links: string[] } {
  const key = keyLine(h);
  const clean = (l: string) => printable(scrub(l));
  return {
    what: [`Set on ${h.host}:`, ...h.variables.map((v) => `  ${v}`), `Where to paste: ${h.where}`, ...(h.notes ?? [])].map(clean),
    links: [...(key ? key.split("\n") : []), ...(h.docs ? ["Docs:", `  ${h.docs}`] : [])].map(clean),
  };
}

/** The hand-off as lines, in order (without the title, which each face shows its own way). */
export function handoffLines(h: Handoff): string[] {
  const { what, links } = handoffParts(h);
  return [...what, ...links];
}
