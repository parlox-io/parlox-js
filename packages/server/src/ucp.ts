// UCP reports: what the merchant's own UCP server answered an agent platform, posted to Parlox by ucp() (core.ts). An
// agent that shops through UCP (the Universal Commerce Protocol) never loads a page, so this report is the only place
// its visit exists.
//
// Each field is bounded here the way the Parlox gateway bounds a UCP report before it stores it: the same types,
// lengths and allowed characters, numbers rounded and clamped to the same ranges, lists cut to the same number of
// entries before their entries are checked. A value the gateway would drop is left out here instead, and only the
// fields it reads are sent, so the SDK sends no more than Parlox keeps, and Parlox keeps what it would have kept of the
// raw report. Two additions protect what the gateway cannot: the search query, free text an agent typed, has its
// emails and runs of four or more digits masked; and free text is never cut inside a character.

/**
 * The operations Parlox records: the Parlox gateway's list (UCP_OPS in its src/analytics/ucp.ts). Keep the two the
 * same; a report with any other op is not sent.
 */
const UCP_OPS = [
  "discovery", "catalog_search", "catalog_lookup", "catalog_product",
  "checkout_create", "checkout_get", "checkout_update", "checkout_complete", "checkout_cancel",
  "order_get", "order_update", "handoff_opened", "handoff_linked", "handoff_completed",
] as const;
export type UcpOp = (typeof UCP_OPS)[number];

/** A checkout's status as UCP names it (the gateway's CHECKOUT_STATUSES); any other value is left out. */
const CHECKOUT_STATUSES = ["incomplete", "requires_escalation", "ready_for_complete", "complete_in_progress", "completed", "canceled"] as const;
export type UcpCheckoutStatus = (typeof CHECKOUT_STATUSES)[number];

/** One message your UCP answer carried. */
export interface UcpCode {
  /** The message's type, such as "error" or "warning" (lower-case letters and _; at most 12 characters kept). */
  type?: string | null;
  /** Its code (letters, digits, _ . and -; at most 60 characters kept). A message without a valid code is left out. */
  code: string;
  /** Its severity, such as "recoverable" (lower-case letters and _; at most 30 characters kept). */
  severity?: string | null;
  /** The JSONPath it points at, such as "$.line_items[0]" (at most 80 characters kept). */
  path?: string | null;
}

/** What your UCP server answered one call. Only `op` is required. A value outside the bounds given is left out. */
export interface UcpReport {
  /** The UCP operation (see UcpOp). Any other value sends nothing and is told to onError. */
  op: UcpOp;
  /** The HTTP status your UCP server answered (rounded, and clamped to 100–599). */
  http_status?: number | null;
  /** Milliseconds your UCP server took to answer (rounded, and clamped to 0–600000). */
  ms?: number | null;
  /** The checkout session's id: letters, digits and _ : / . - (at most 100 characters kept). One checkout is one visit. */
  checkout_id?: string | null;
  /** The order's id once the checkout created one: the same characters (at most 64 kept). */
  order_id?: string | null;
  /** The checkout's status, as your UCP server answered it. */
  checkout_status?: UcpCheckoutStatus | null;
  /** The messages your answer carried, such as out_of_stock: the first 10 are read. */
  codes?: UcpCode[] | null;
  /** The checkout's total in the smallest currency unit, such as cents (rounded, and clamped to 0–100000000000). */
  total_cents?: number | null;
  /** Units in the checkout (rounded, and clamped to 0–10000). */
  items?: number | null;
  /** Ids of the items in the checkout: the first 10 are read; the characters of checkout_id, at most 100 kept each. */
  item_ids?: string[] | null;
  /** Discount codes applied: the first 5 are read; upper-case letters, digits, _ and - (at most 30 kept each). */
  discount_codes?: string[] | null;
  /** The fulfillment option selected: letters, digits and _ : . - (at most 60 characters kept). */
  fulfillment?: string | null;
  /** The agent's catalog search query. Emails and runs of 4 or more digits are masked first; at most 200 characters kept. */
  query?: string | null;
  /** How many results that search returned (rounded, and clamped to 0–1000000). */
  results?: number | null;
  /** The platform's host name, from the profile URL in its UCP-Agent header: lower-case a-z, 0-9, . and - (at most 253). */
  platform?: string | null;
}

/** About the call itself. Every field is optional and sent only when given and valid. */
export interface UcpContext {
  /** The caller's User-Agent (at most 1000 characters kept). */
  ua?: string | null;
  /**
   * The caller's address, an IPv4 or IPv6 address. Pass it only when the caller is an agent platform's server (every
   * UCP call is): Parlox checks it against the vendor's published ranges and discards it. Never read from a request by
   * the SDK; sent only when you pass it.
   */
  ip?: string | null;
  /** A one-way hash (16 to 64 lower-case hex characters) that groups one caller's catalog calls, which carry no
   * checkout id: for example SHA-256 of the address and the day. */
  ip_hash?: string | null;
  /** The Parlox session id the buyer's browser sent back (sessionId() from @parlox/browser), for handoff_linked. */
  sid?: string | null;
  /** The path of the UCP call. Anything from ? or # on is left out (at most 2000 characters kept). */
  path?: string | null;
}

/** The message onError gets for a report whose op is not one Parlox records. */
const UNKNOWN_OP = `ucp: op must be one of ${UCP_OPS.join(", ")}; this report was not sent`;

const OPS: ReadonlySet<string> = new Set(UCP_OPS);
const STATUSES: ReadonlySet<string> = new Set(CHECKOUT_STATUSES);
const ID = /^[A-Za-z0-9_:\/.-]+$/;

// The gateway's own helpers: a non-empty string that matches (tested whole, then cut), and a finite number, rounded
// and clamped.
const str = (v: unknown, max: number, re: RegExp): string | undefined => (typeof v === "string" && v && re.test(v) ? v.slice(0, max) : undefined);
const int = (v: unknown, lo: number, hi: number): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(Math.max(Math.round(v), lo), hi) : undefined;
const list = (v: unknown, n: number, max: number, re: RegExp): string[] | undefined =>
  Array.isArray(v) ? v.slice(0, n).flatMap((x) => { const k = str(x, max, re); return k === undefined ? [] : [k]; }) : undefined;

// Free text, at most `max` UTF-16 code units (as the gateway counts them). A lone half of a surrogate pair is not a
// character, and Postgres refuses to store one in JSON, so the cut never leaves one at the end, and one anywhere else
// becomes U+FFFD (the replacement character, the same length).
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
function text(v: unknown, max: number): string | undefined {
  if (typeof v !== "string" || !v) return undefined;
  let t = v.slice(0, max);
  if (t.length === max && /[\uD800-\uDBFF]/.test(t[max - 1]) && /[\uDC00-\uDFFF]/.test(v[max] ?? "")) t = t.slice(0, -1);
  t = t.replace(LONE_SURROGATE, "\uFFFD");
  return t || undefined;
}

// The search query: emails and runs of four or more digits (any script's) become [email] and [number], before the
// 200-character cut, so an email across the cut is masked whole. At most QUERY_READ characters are read: the email
// pattern backtracks, so its cost grows with the square of the text's length, and the query is what an agent sent.
// When the query is longer, the word the cut falls in is dropped too, so that cut never leaves part of an email or a
// number to go out unmasked.
const EMAIL = /[\p{L}\p{M}\p{N}_.+-]+@[\p{L}\p{M}\p{N}_-]+\.[\p{L}\p{M}\p{N}_.-]+/gu;
const DIGITS = /\p{Nd}{4,}/gu;
const QUERY_READ = 1000;
function maskedQuery(v: unknown): string | undefined {
  if (typeof v !== "string" || !v) return undefined;
  let q = v;
  if (q.length > QUERY_READ) {
    q = q.slice(0, QUERY_READ);
    if (!/\s/u.test(v[QUERY_READ])) q = q.replace(/\S+$/u, "");
  }
  return text(q.replace(EMAIL, "[email]").replace(DIGITS, "[number]"), 200);
}

// An IPv4 or IPv6 address, as Node.js's net.isIP (the gateway's check) accepts it, without an IPv6 zone id (the
// patterns of Node's lib/internal/net.js). The edge runtimes this package runs on have no node:net.
const V4_SEG = "(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])";
const V4 = `(?:${V4_SEG}\\.){3}${V4_SEG}`;
const V6_SEG = "(?:[0-9a-fA-F]{1,4})";
const IP = new RegExp(
  `^(?:${V4}|` +
    `(?:${V6_SEG}:){7}(?:${V6_SEG}|:)|` +
    `(?:${V6_SEG}:){6}(?:${V4}|:${V6_SEG}|:)|` +
    `(?:${V6_SEG}:){5}(?::${V4}|(?::${V6_SEG}){1,2}|:)|` +
    `(?:${V6_SEG}:){4}(?:(?::${V6_SEG}){0,1}:${V4}|(?::${V6_SEG}){1,3}|:)|` +
    `(?:${V6_SEG}:){3}(?:(?::${V6_SEG}){0,2}:${V4}|(?::${V6_SEG}){1,4}|:)|` +
    `(?:${V6_SEG}:){2}(?:(?::${V6_SEG}){0,3}:${V4}|(?::${V6_SEG}){1,5}|:)|` +
    `(?:${V6_SEG}:){1}(?:(?::${V6_SEG}){0,4}:${V4}|(?::${V6_SEG}){1,6}|:)|` +
    `(?::(?:(?::${V6_SEG}){0,5}:${V4}|(?::${V6_SEG}){1,7}|:))` +
    `)$`,
);
const address = (v: unknown): string | undefined => {
  const ip = typeof v === "string" ? v.trim() : "";
  return ip.length <= 64 && IP.test(ip) ? ip : undefined;
};

// The path alone: a query string can hold what an agent searched for, unmasked.
const pathOnly = (v: unknown): string | undefined => (typeof v === "string" ? text(v.split(/[?#]/, 1)[0], 2000) : undefined);

/** Fields whose value is undefined are left out, so that nothing is sent for them. */
function defined(fields: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
}

function codesOf(v: unknown): Array<Record<string, unknown>> | undefined {
  if (!Array.isArray(v)) return undefined;
  const codes = v.slice(0, 10).flatMap((m) => {
    if (!m || typeof m !== "object") return [];
    const x = m as Record<string, unknown>;
    const code = str(x.code, 60, /^[A-Za-z0-9_.-]+$/);
    return code ? [defined({ type: str(x.type, 12, /^[a-z_]+$/), code, severity: str(x.severity, 30, /^[a-z_]+$/), path: text(x.path, 80) })] : [];
  });
  // None is what the gateway stores for none: an empty list is not sent.
  return codes.length ? codes : undefined;
}

/**
 * The event ucp() posts for one report: { ucp: <the report, bounded>, ...<the context, bounded> }. Throws (with
 * UNKNOWN_OP) when the report has no op Parlox records.
 */
export function ucpEvent(report: UcpReport, context?: UcpContext | null): Record<string, unknown> {
  const r = (report && typeof report === "object" ? report : {}) as Record<string, unknown>;
  const op = r.op;
  if (typeof op !== "string" || !OPS.has(op)) throw new Error(UNKNOWN_OP);
  const status = r.checkout_status;
  const ucp = defined({
    op,
    http_status: int(r.http_status, 100, 599),
    ms: int(r.ms, 0, 600_000),
    checkout_id: str(r.checkout_id, 100, ID),
    order_id: str(r.order_id, 64, ID),
    checkout_status: typeof status === "string" && STATUSES.has(status) ? status : undefined,
    codes: codesOf(r.codes),
    total_cents: int(r.total_cents, 0, 100_000_000_000),
    items: int(r.items, 0, 10_000),
    item_ids: list(r.item_ids, 10, 100, ID),
    discount_codes: list(r.discount_codes, 5, 30, /^[A-Z0-9_-]+$/),
    fulfillment: str(r.fulfillment, 60, /^[A-Za-z0-9_:.-]+$/),
    query: maskedQuery(r.query),
    results: int(r.results, 0, 1_000_000),
    platform: str(r.platform, 253, /^[a-z0-9.-]+$/),
  });
  const c = (context && typeof context === "object" ? context : {}) as Record<string, unknown>;
  return {
    ucp,
    ...defined({
      ua: text(c.ua, 1000),
      ip: address(c.ip),
      ip_hash: str(c.ip_hash, 64, /^[a-f0-9]{16,64}$/),
      sid: str(c.sid, 32, /^[a-f0-9]{16,32}$/),
      path: pathOnly(c.path),
    }),
  };
}
