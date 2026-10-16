// The URL rule for everything that leaves the page: the tracker's beacons and the recorder's events. One module, so the
// two cannot drift; each bundle (the tag, the recorder, the npm chunks) carries its own copy, and the recorder never
// depends on the tracker that loaded it (tags cached from before versioned releases load the current recorder).

// Capability tokens live in paths on many platforms (Shopify /checkouts/cn/<token>, /orders/<token>,
// /account/reset/<id>/<token>, WooCommerce ?key=wc_order_...). They never leave the page: an address leaves as its
// origin and path, with token-shaped segments replaced by ":token", and campaign parameters only.
import { cut, trimEnd } from "./text.js";

const KEEP = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "ref", "gclid", "fbclid", "srsltid"];

function tokenPath(pathname: string): string {
  return pathname.replace(/\/account\/(reset|activate)\/.*/, "/account/$1/:token")
    .split("/").map((seg) => ((/^[A-Za-z0-9_]{20,}$/.test(seg) && /\d/.test(seg) && /[A-Za-z]/.test(seg)) || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg) ? ":token" : seg)).join("/");
}

export function safePath(href: string): string {
  let u: URL;
  try { u = new URL(href, location.href); } catch { return "/"; }
  const q: string[] = [];
  // Cut at 120 characters, an emoji counted as one (text.ts): a cut between the two halves of one would make
  // encodeURIComponent throw, and the tracker would never start.
  KEEP.forEach((k) => { const v = u.searchParams.get(k); if (v) q.push(k + "=" + encodeURIComponent(cut(v, 120))); });
  return u.origin + tokenPath(u.pathname) + (q.length ? "?" + q.join("&") : "");
}

// What a replay needs to draw an image or a stylesheet: the query parameters that size or version a file, each kept
// only when its value has that shape. Anything else in a resource's query is dropped: signatures (X-Amz-*, presigned
// URLs), tokens, a map's center and markers, emails. The gateway applies the same tables to the recordings it stores,
// and the README lists them (1.0.4), so both can be checked against one list.
type Check = (v: string) => boolean;
const num: Check = (v) => v.length <= 5 && /^\d*\.?\d*$/.test(v) && /\d/.test(v);
// Words and versions at most 19 characters: 20 letters and digits is the shape of a token (tokenPath).
const word: Check = (v) => /^[A-Za-z0-9,-]{1,19}$/.test(v);
const version: Check = (v) => /^[A-Za-z0-9.-]{1,19}$/.test(v);
export const RESOURCE_PARAMS: Record<string, Check> = {
  w: num, h: num, width: num, height: num, q: num, quality: num, dpr: num,
  fit: word, format: word, fm: word, auto: word, crop: word,
  v: version, ver: version, version,
};
// Next.js's image optimizer (/_next/image on the page's own origin): the source image and its width and quality.
export const NEXT_IMAGE_PARAMS: Record<string, Check> = { w: num, q: num };
// Google Fonts stylesheets (fonts.googleapis.com): the families and their display. Never `text`, which is page text.
export const GOOGLE_FONTS_PARAMS: Record<string, Check> = {
  family: (v) => /^[A-Za-z0-9 +:;,@.]{1,200}$/.test(v),
  display: (v) => /^[A-Za-z]{1,10}$/.test(v),
};

// The parameters of `u` that `table` allows, in the order they appear, each value encoded again.
function allowed(u: URL, table: Record<string, Check>, url?: (v: string) => string): string {
  const q: string[] = [];
  u.searchParams.forEach((v, k) => {
    if (url && k === "url") { const inner = url(v); if (inner) q.push("url=" + encodeURIComponent(inner)); }
    else if (Object.prototype.hasOwnProperty.call(table, k) && table[k](v)) q.push(k + "=" + encodeURIComponent(v));
  });
  return q.length ? "?" + q.join("&") : "";
}

// The page's origin, read once while the page's address stays the same (a recording asks for it on every address).
let lastPage = "", lastOrigin = "";
function originOf(page: string): string {
  if (page !== lastPage) { lastOrigin = new URL(page).origin; lastPage = page; }
  return lastOrigin;
}

// The address of an image, video poster, stylesheet, icon or preload, as a recording keeps it: the token rule on the
// path, and the query reduced to the tables above. `page` is the address of the page it is on. Web addresses only
// (others are handled by recordedUrl); an address that cannot be read is "".
export function resourceAddress(href: string, page: string): string {
  let u: URL, origin: string;
  try { origin = originOf(page); u = new URL(href, page); } catch { return ""; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return "";
  if (u.origin === origin && u.pathname === "/_next/image") {
    // The source is a path on this site ("/images/hero.jpg"), its own path and query by the same rule, or an https
    // address on another site (remotePatterns), kept as a file is.
    return origin + u.pathname + allowed(u, NEXT_IMAGE_PARAMS, (v) => {
      if (/^https:\/\//i.test(v)) return resourceAddress(v, page);
      if (v[0] !== "/" || v[1] === "/" || v[1] === "\\") return "";
      let src: URL;
      try { src = new URL(v, origin); } catch { return ""; }
      return src.origin === origin ? tokenPath(src.pathname) + allowed(src, RESOURCE_PARAMS) : "";
    });
  }
  return u.origin + tokenPath(u.pathname) + allowed(u, u.hostname === "fonts.googleapis.com" ? GOOGLE_FONTS_PARAMS : RESOURCE_PARAMS);
}

// An address in a recorded page (a link, a form's action, an image, the page itself). Web addresses follow safePath, so
// a recorded page says no more than a beacon; a resource the replay draws (`resource`) follows resourceAddress. A
// reference inside the page ("#icon-cart", which SVG icons use) stays, and so does the fragment of an SVG <use>, which
// names an icon in a sprite file. Inline content (data:) stays where the replay draws it (images, stylesheets) and
// nowhere else: a link's data: can be a generated download. Every other scheme keeps only its name: mailto: and tel:
// carry the address or number, blob: and javascript: mean nothing off the page.
export function recordedUrl(value: string, tag: string, drawn: boolean, resource = false): string {
  const s = value.trim();
  if (!s || s[0] === "#") return value;
  let u: URL;
  try { u = new URL(s, location.href); } catch { return ""; }
  if (u.protocol === "http:" || u.protocol === "https:") return (resource ? resourceAddress(u.href, location.href) : safePath(u.href)) + (tag === "use" ? u.hash : "");
  if (u.protocol === "data:" && drawn) return s;
  return u.protocol;
}

// A srcset is a list of "address descriptor" candidates separated by commas; an inline data: address has a comma of its
// own, so candidates are split the way browsers do (an address ends at white space, or at a comma it ends with). Every
// candidate is an image the replay draws; at most 64 are kept (a page needs a handful).
// HTML's white space: space, tab, line feed, form feed, carriage return.
const space = (c: number) => c === 32 || c === 9 || c === 10 || c === 12 || c === 13;
export function recordedSrcset(value: string): string {
  const out: string[] = [];
  let i = 0;
  while (i < value.length) {
    while (i < value.length && (space(value.charCodeAt(i)) || value.charCodeAt(i) === 44)) i++;
    if (i >= value.length) break;
    let j = i;
    while (j < value.length && !space(value.charCodeAt(j))) j++;
    let url = value.slice(i, j), desc = "";
    i = j;
    if (url.charCodeAt(url.length - 1) === 44) url = trimEnd(url, 44);
    else { let k = i; while (k < value.length && value.charCodeAt(k) !== 44) k++; desc = value.slice(i, k).trim(); i = k; }
    const clean = recordedUrl(url, "img", true, true);
    if (clean) out.push(clean + (desc ? " " + desc : ""));
    if (out.length === 64) break;
  }
  return out.join(", ");
}
