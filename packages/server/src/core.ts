// @parlox/server core: what the merchant's server reports to Parlox, and nothing else.
//
// AI fetchers and crawlers never run JavaScript, so only the server sees them. For each page request that looks
// automated, the server reports one small event, with a hard timeout: it never delays or fails the merchant's response.
// Where the platform keeps work alive after the response (waitUntil: Next.js middleware, Vercel, Cloudflare Workers),
// the event is sent at once and handed to it, at most 64 at a time in the process. On a long-running server (Express,
// Hono on Node or Bun) events wait in a bounded queue and go in batches, one request at a time (queue.ts). Either way a
// crawler flood never becomes a flood of outbound connections from the merchant's server. Requests from people are
// filtered out here and never sent.
//
// The client address is sent only for requests whose user agent names a bot (so Parlox can check the claim against
// the vendor's published ranges and discard it), and only from a source the merchant trusts: a header their own proxy
// or CDN sets, named in configuration. A header any client can send (X-Forwarded-For as received) is never read.
// Everything else about a visitor is reduced to a one-way, daily-rotating hash that only groups one crawler's requests.
//
// Runs anywhere with the Web platform APIs: Node 20+, Vercel and Next.js (edge or Node), Cloudflare Workers, Deno, Bun.

import { DeliveryQueue, flushAll, MAX_BATCH_BYTES, MAX_RETRY_WAIT_MS, MAX_TIMER_MS } from "./queue.js";
import { env, receivedByCloudflare, stopsAfterResponse, vercelWaitUntil, type WaitUntil } from "./platform.js";

export const DEFAULT_ENDPOINT = "https://gateway.parlox.io";
export const VERIFY_PATH = "/.well-known/parlox-verify";

/** The request, reduced to what Parlox reads. Adapters build this from their framework's request object. */
export interface RequestInfo {
  method: string;
  /** Path only, no query string. */
  path: string;
  /** The Host the request was made to (for Web Bot Auth, which signs it). */
  host: string | null;
  header(name: string): string | null;
  /** Response status, when known (reported after the response). */
  status?: number;
  /** The client address from a source the adapter trusts; undefined when there is none. Sent (for self-declared bots only). */
  clientIp?: string;
  /**
   * Best-effort address used only inside the one-way daily hash that groups one crawler's requests into a visit, when no
   * trusted address exists (the connection's address, or the first X-Forwarded-For entry). Never sent. A client can
   * change it, which only splits or merges its own requests.
   */
  groupingAddress?: string;
}

export interface ParloxServerOptions {
  /**
   * The site's secret key. Without this option, process.env.PARLOX_SECRET_KEY. When the option is given it is used
   * alone, even when its value is undefined or empty: `createParlox({ secretKey: process.env.PARLOX_ORDERS_KEY })` with
   * that variable unset never falls back to PARLOX_SECRET_KEY; it sends nothing and says so once in the log
   * (console.warn) and to onError. Without a key the reporter does nothing.
   */
  secretKey?: string;
  /** Answer for GET /.well-known/parlox-verify (ownership proof). Default: process.env.PARLOX_VERIFY_TOKEN. */
  verifyToken?: string;
  /**
   * Header that carries the client address, set by a proxy or CDN you control (Cloudflare: "cf-connecting-ip",
   * nginx: "x-real-ip"). Default: process.env.PARLOX_IP_HEADER, else "x-real-ip" on Vercel, else, in the Hono and fetch
   * adapters, "cf-connecting-ip" for a request that carries Cloudflare's `cf` object (each platform sets its own), else
   * none: no address is sent. null turns it off. On self-hosted workerd, name the header your proxy sets.
   */
  ipHeader?: string | null;
  /** Milliseconds before a report sent on its own (serverless, edge, purchases) is abandoned: a whole number from 1
   * (0, a negative number or one that is not finite is the default). Default 2000. */
  timeoutMs?: number;
  /** Long-running servers: send a batch once this many events wait, at most maxBatchSize. Default 20. */
  flushAt?: number;
  /** Long-running servers: send what waits at least this often, in milliseconds. Default 10000. */
  flushIntervalMs?: number;
  /** Long-running servers: events per request, at most 100 (the gateway's limit). Default 100. */
  maxBatchSize?: number;
  /** Long-running servers: bytes per request body, at most 200000 (the gateway accepts 256 KB). Default 200000. */
  maxBatchBytes?: number;
  /** Long-running servers: events kept waiting; when full, the oldest is dropped and counted. Default 1000. */
  maxQueueSize?: number;
  /** Long-running servers: milliseconds before a batch request is abandoned. Default 10000. */
  batchTimeoutMs?: number;
  /**
   * Long-running servers: further attempts for a batch Parlox provably did not store (it answered 429, or the
   * connection never reached it). Any other failure is not retried. Default 3; 0 turns retries off.
   */
  retryCount?: number;
  /** Long-running servers: milliseconds between those attempts when Parlox names no Retry-After, at most 60000. Default 3000. */
  retryDelayMs?: number;
  /**
   * Purchases posted at the same time in this process (every instance together), at most; beyond it purchase()
   * resolves { ok: false, status: 0 } at once. Default 10. Each instance compares the number in flight in the process
   * with its own limit, so an instance given a higher limit can take that number past a lower one; an instance with the
   * lower limit then refuses until the number is back under its own.
   */
  maxPurchasesInFlight?: number;
  /** The Parlox gateway. Only for testing against another deployment. */
  endpoint?: string;
  /** Report GET requests under /api/ too (off by default: monitors, cron jobs and internal fetches live there). */
  includeApi?: boolean;
  /**
   * Called with any reporting failure (network, timeout, rejected key, a purchase refused at the cap). For an order
   * Parlox refuses, the error says why: "Parlox refused the order (HTTP 403): <Parlox's reason>". Reports never throw.
   * A key Parlox refuses (401 or 403) is also said in the log (console.warn), once per instance for orders and once for
   * crawler reports, so an app that passes no onError sees it too.
   */
  onError?: (error: unknown) => void;
}

export interface Order {
  /** Parlox session id from the browser (parlox.sessionId() / sessionId() from @parlox/browser), sent with the checkout. */
  sid?: string | null;
  order_id: string;
  /** Order total in the smallest currency unit (cents). */
  value_cents: number;
  /** ISO 4217, e.g. "USD". */
  currency: string;
  items?: number;
}

export interface Parlox {
  /** Whether this request would be reported (automated, a page, not Parlox's own checker). */
  shouldReport(req: RequestInfo): boolean;
  /**
   * Reports the request at once if it should be; resolves when sent or abandoned; never rejects. At most 64 are sent
   * at once in the process; beyond that the report is counted as dropped instead, and the count goes with this
   * instance's next request.
   */
  report(req: RequestInfo): Promise<void>;
  /** Queues the request's report for the next batch (a long-running server). Never throws. */
  enqueue(req: RequestInfo): void;
  /**
   * Reports the request by the path the platform allows: handed to waitUntil when there is one (the one passed, else
   * Vercel's request context); sent at once where the platform may stop or freeze the code soon after a response
   * (AWS Lambda, Cloudflare Workers, Deno Deploy, Azure Functions: see platform.ts; on AWS Lambda the request usually
   * goes out only during the instance's next invocation); otherwise queued for the next batch. Never throws.
   */
  deliver(req: RequestInfo, waitUntil?: WaitUntil): void;
  /**
   * Sends the reports this instance has queued so far, keeping the process running until done. Gives up after
   * timeoutMs (default 30000): none of them is retried after that, and those not sent by then are counted as delivery
   * not confirmed. Resolves when sent or abandoned; never rejects.
   */
  flush(timeoutMs?: number): Promise<void>;
  /** Events waiting in this instance's queue. */
  readonly pending: number;
  /** Reports this instance dropped (its queue was full, or 64 were already being sent at once) or whose delivery was not
   * confirmed, not yet reported to Parlox. */
  readonly dropped: number;
  /** The body to answer with for the ownership check, or null when this is not that request (or no token is set). */
  verifyAnswer(req: Pick<RequestInfo, "method" | "path">): string | null;
  /** Posts a confirmed order (the purchase of record). Resolves to whether Parlox accepted it, with the HTTP status;
   * never rejects. Needs a key with send access (a "Crawler reports only" key gets 403, and onError says so). */
  purchase(order: Order): Promise<{ ok: boolean; status: number }>;
  /** The header named for the client address (the ipHeader option, PARLOX_IP_HEADER, or Vercel's x-real-ip), if any
   * (for adapters). Cloudflare's cf-connecting-ip is not in it: that one depends on the request (ipHeaderFor). */
  readonly ipHeader: string | null;
}

/** Sends the reports queued so far by every Parlox instance in this process, keeping the process running until done.
 * For apps that stop on a signal: await it in the shutdown handler (the SDK installs none of its own). Gives up after
 * timeoutMs (default 30000) and counts those not sent by then as delivery not confirmed. Never rejects. */
export const flush: (timeoutMs?: number) => Promise<void> = flushAll;

// Words that appear in the user agents of bots, crawlers, AI fetchers, HTTP libraries and headless browsers.
export const AUTOMATION_HINT = /bot|crawl|spider|gpt|claude|anthropic|meta-|perplexity|google-agent|fetch|python|curl|wget|axios|node|http|headless|scrap/i;
// Static assets only: robots.txt, llms.txt, sitemaps and product .json are what agents read, and are reported.
const ASSET = /\.(?:png|jpe?g|gif|svg|webp|avif|ico|css|js|mjs|map|woff2?|ttf|otf|eot|mp4|webm|mp3|wav)$/i;
const SKIP_PREFIX = /^\/(?:_next\/static\/|_next\/image|_vercel\/|__nextjs)/;
// API routes are skipped by default: health checks, uptime monitors, cron jobs and the site's own server-side fetches
// live there and would otherwise read as automated visits. includeApi: true reports them (an agent calling a store API).
const API_PREFIX = /^\/api(?:\/|$)/;

async function sha256Hex(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** A line in the server's log, for what an app that passes no onError must still see. Never throws. */
function say(message: string): void {
  try { console.warn(`@parlox/server: ${message}`); } catch { /* no console here */ }
}
const EMPTY_KEY = "secretKey was given but is empty: set PARLOX_ORDERS_KEY (or the variable you pass) — Parlox did not fall back to PARLOX_SECRET_KEY";
const NO_KEY = "PARLOX_SECRET_KEY is not set; nothing is reported";
const SAID_ONCE = " (said once per instance; onError receives every refusal)";

const cap = (v: string | null | undefined, n: number) => (typeof v === "string" && v ? v.slice(0, n) : null);
// A whole number from `min` (1 unless given) to `max`, or the default: a bad option never disables a bound.
const bound = (v: number | undefined, fallback: number, max = Number.MAX_SAFE_INTEGER, min = 1) =>
  typeof v === "number" && Number.isFinite(v) && v >= min ? Math.min(Math.floor(v), max) : fallback;

// Retry-After (RFC 9110, section 10.2.3): a whole number of seconds, or an HTTP date. Milliseconds, or undefined.
function retryAfterMs(value: string | null): number | undefined {
  const v = value?.trim();
  if (!v) return undefined;
  if (/^\d+$/.test(v)) return Number(v) * 1000;
  const at = Date.parse(v);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}

// What purchase() tells onError when Parlox refuses an order, and what the log says of the first refusal of the key
// (send, in createParlox): the gateway's own reason, from its JSON answer ({"error": "..."}). At most 1 KB of the
// answer is read (a longer one is not parsed at all); only the error text is used, at most 300 characters, on one
// line, with the key (or anything shaped like one) replaced by "[key]". In that order, so that no character inside a
// key can keep part of it out of the match:
// 1. invisible formatting characters (zero-width joiners and spaces, direction marks: Unicode's Cf) are deleted, not
//    spaced, so a key with one inside it is whole again;
// 2. the instance's key is replaced, also where control characters or spaces break it up, then anything shaped like a
//    key;
// 3. the control characters and line separators left, which could rewrite a log line, become spaces.
// Undefined when there is no such text.
const MAX_REASON_BYTES = 1024;
const MAX_REASON_CHARS = 300;
const FORMAT = /\p{Cf}+/gu;
const UNPRINTABLE = /[\p{Cc}\u2028\u2029]+/gu;
const KEY_SHAPED = /sk_[A-Za-z0-9_]{8,}/g;
/** The key, matched with any control characters or white space between its characters. */
const keyPattern = (key: string) => new RegExp(Array.from(key, (c) => c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[\\p{Cc}\\s]*"), "gu");
async function refusalReason(res: Response, secretKey: string): Promise<string | undefined> {
  const text = await readAtMost(res, MAX_REASON_BYTES);
  if (text === undefined) return undefined;
  let error: unknown;
  try { error = (JSON.parse(text) as { error?: unknown } | null)?.error; } catch { return undefined; }
  if (typeof error !== "string") return undefined;
  const line = error.replace(FORMAT, "").replace(keyPattern(secretKey), "[key]").replace(KEY_SHAPED, "[key]").replace(UNPRINTABLE, " ").replace(/\s+/g, " ").trim();
  if (!line) return undefined;
  const chars = Array.from(line); // code points, so a character is never cut in half
  return chars.length > MAX_REASON_CHARS ? `${chars.slice(0, MAX_REASON_CHARS).join("").trimEnd()}…` : line;
}

// The response body as text when it is at most maxBytes long; undefined when it is longer (reading stops there), absent
// or unreadable.
async function readAtMost(res: Response, maxBytes: number): Promise<string | undefined> {
  const reader = res.body?.getReader();
  if (!reader) return undefined;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { reader.cancel().catch(() => {}); return undefined; }
      chunks.push(value);
    }
  } catch { return undefined; }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) { bytes.set(c, at); at += c.byteLength; }
  return new TextDecoder().decode(bytes);
}

/**
 * Reports sent at once (handed to waitUntil, or sent where the platform may stop the code after a response) that may be
 * in flight in this process together; beyond it a report is not sent but counted, and the count goes with the
 * instance's next request (meta.dropped). Where one instance serves many requests at a time (Vercel's fluid compute,
 * Deno Deploy, Azure Functions), a crawler flood would otherwise open one outbound request per bot request. The number
 * is Sentry's: its transport keeps at most 64 requests in flight (DEFAULT_TRANSPORT_BUFFER_SIZE in @sentry/core,
 * transports/base.ts) and counts the events it drops beyond that ("queue_overflow") for a later report. PostHog's and
 * Segment's Node SDKs set no such bound on the sends they make at once.
 */
const MAX_REPORTS_IN_FLIGHT = 64;

// Requests in flight, counted for the whole process: shared by every instance, and by every copy of this package loaded
// in it (the ES module and CommonJS builds), like the delivery queues' registry. Purchases and reports sent at once
// have a count each.
const PURCHASES = Symbol.for("@parlox/server/purchases-in-flight");
const REPORTS = Symbol.for("@parlox/server/reports-in-flight");
function inFlight(key: symbol): { count: number } {
  const g = globalThis as unknown as Record<symbol, { count: number } | undefined>;
  return (g[key] ??= { count: 0 });
}

// Failures before any byte of the request was sent: the connection was refused, or the gateway's name did not resolve.
// Node's fetch reports them as the cause of its TypeError ("fetch failed"), as an AggregateError holding one error per
// address when the name has several. Any other failure may have reached the gateway.
const NEVER_REACHED = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"]);
function neverReached(err: unknown): boolean {
  const cause = (err as { cause?: unknown } | null | undefined)?.cause ?? err;
  const nested = (cause as { errors?: unknown } | null | undefined)?.errors;
  const failures: unknown[] = Array.isArray(nested) && nested.length ? nested : [cause];
  return failures.every((e) => NEVER_REACHED.has(String((e as { code?: unknown } | null | undefined)?.code)));
}

export function createParlox(options: ParloxServerOptions = {}): Parlox {
  // A secretKey option is used alone, whatever its value: the instance that posts orders, given its own variable,
  // must never send with PARLOX_SECRET_KEY (the middleware's crawler-reports-only key) when that variable is unset.
  // Only without the option is PARLOX_SECRET_KEY read. A blank value is no key.
  const explicitKey = "secretKey" in options;
  const secretKey = explicitKey ? (typeof options.secretKey === "string" && options.secretKey.trim()) || undefined : env("PARLOX_SECRET_KEY");
  if (explicitKey && !secretKey) say(EMPTY_KEY);
  const verifyToken = options.verifyToken ?? env("PARLOX_VERIFY_TOKEN");
  const ipHeader = namedIpHeader(options.ipHeader) ?? null;
  const timeoutMs = bound(options.timeoutMs, 2000, MAX_TIMER_MS);
  const batchTimeoutMs = bound(options.batchTimeoutMs, 10_000, MAX_TIMER_MS);
  const maxPurchases = bound(options.maxPurchasesInFlight, 10);
  const endpoint = (options.endpoint ?? DEFAULT_ENDPOINT).replace(/\/+$/, "");
  // The app's onError is told of every failure; if it throws, that must not break the site either.
  const onError = (error: unknown) => { try { options.onError?.(error); } catch { /* ignored */ } };
  const includeApi = options.includeApi === true;
  let warned = false;
  // Whether a refusal of the key (401 or 403) has been said in the log yet, for orders and for crawler reports.
  const refusalSaid = { order: false, report: false };
  // Whether the platform may stop the code soon after a response: read once, on the first report (it does not change
  // while the process runs).
  let stops: boolean | undefined;

  // Posts one request body ({"events":[...]}, written as JSON by the caller). For an order Parlox refuses, onError gets
  // the gateway's reason; reports, sent in far greater numbers, keep the status alone (only the first refusal of the
  // key is read, for its line in the log).
  async function send(body: string, timeout: number, kind: "report" | "order" = "report"): Promise<{ ok: boolean; status: number; retryable: boolean; retryAfterMs?: number }> {
    if (!secretKey) {
      if (!warned) { warned = true; onError(new Error(explicitKey ? EMPTY_KEY : NO_KEY)); }
      return { ok: false, status: 0, retryable: false };
    }
    try {
      const res = await fetch(`${endpoint}/v1/s`, {
        method: "POST",
        headers: { authorization: `Bearer ${secretKey}`, "content-type": "application/json" },
        body,
        signal: AbortSignal.timeout(timeout),
      });
      // A key Parlox refuses (401: not a key it knows; 403: not allowed this) fails every send that follows, so the
      // first refusal of each kind is said in the log too, with Parlox's reason: an app that passes no onError would
      // otherwise never see it. Once per instance, never a line per request.
      const keyRefused = res.status === 401 || res.status === 403;
      if (!res.ok && kind === "order") {
        const reason = await refusalReason(res, secretKey).catch(() => undefined);
        onError(new Error(reason ? `Parlox refused the order (HTTP ${res.status}): ${reason}` : `Parlox answered HTTP ${res.status}`));
        if (keyRefused && !refusalSaid.order) { refusalSaid.order = true; say(`Parlox refused the order (HTTP ${res.status})${reason ? `: ${reason}` : ""}${SAID_ONCE}`); }
      } else if (keyRefused && !refusalSaid.report) {
        // Read for this one line only; onError keeps the short message for reports.
        refusalSaid.report = true;
        const reason = await refusalReason(res, secretKey).catch(() => undefined);
        onError(new Error(`Parlox answered HTTP ${res.status}`));
        say(`Parlox refused a crawler report (HTTP ${res.status})${reason ? `: ${reason}` : ""}${SAID_ONCE}`);
      } else {
        // Drain the body so the connection can be reused; its content is not needed.
        await res.arrayBuffer().catch(() => {});
        if (!res.ok) onError(new Error(`Parlox answered HTTP ${res.status}`));
      }
      // A 429 comes from the gateway's rate limiter, which refuses before anything is stored.
      const limited = res.status === 429;
      return { ok: res.ok, status: res.status, retryable: limited, retryAfterMs: limited ? retryAfterMs(res.headers.get("retry-after")) : undefined };
    } catch (err) {
      onError(err);
      return { ok: false, status: 0, retryable: neverReached(err) };
    }
  }

  const maxQueueSize = bound(options.maxQueueSize, 1000);
  const maxBatchSize = bound(options.maxBatchSize, 100, 100);
  const queue = new DeliveryQueue(
    async (body) => {
      const { ok, retryable, retryAfterMs } = await send(body, batchTimeoutMs);
      return { ok, retryable, retryAfterMs };
    },
    {
      // flushAt is at most one full batch: a larger one would send one batch, then leave the rest (full batches
      // among them) for the interval. PostHog's core keeps the same invariant the other way round (its maxBatchSize
      // is raised to flushAt), which the gateway's 100-event limit rules out here. A queue smaller than flushAt sends
      // once it is full, rather than dropping while it waits for the interval.
      flushAt: Math.min(bound(options.flushAt, 20), maxBatchSize, maxQueueSize),
      flushIntervalMs: bound(options.flushIntervalMs, 10_000, MAX_TIMER_MS),
      maxBatchSize,
      maxBatchBytes: bound(options.maxBatchBytes, MAX_BATCH_BYTES, MAX_BATCH_BYTES),
      maxQueueSize,
      retryCount: bound(options.retryCount, 3, Number.MAX_SAFE_INTEGER, 0),
      retryDelayMs: bound(options.retryDelayMs, 3000, MAX_RETRY_WAIT_MS, 0),
    },
    onError,
  );

  function shouldReport(req: RequestInfo): boolean {
    if (!secretKey) return false;
    if (req.method !== "GET" && req.method !== "HEAD") return false;
    if (ASSET.test(req.path) || SKIP_PREFIX.test(req.path) || req.path === VERIFY_PATH) return false;
    if (!includeApi && API_PREFIX.test(req.path)) return false;
    if (req.header("x-parlox-audit")) return false; // Parlox's own page checks are not visits
    const ua = req.header("user-agent") ?? "";
    return !ua || AUTOMATION_HINT.test(ua) || !req.header("sec-fetch-mode") || !req.header("accept-language");
  }

  // The event for one request (the caller has checked shouldReport).
  async function eventOf(req: RequestInfo): Promise<Record<string, unknown>> {
    const ua = req.header("user-agent") ?? "";
    const declaresBot = AUTOMATION_HINT.test(ua);
    const ip = req.clientIp && req.clientIp.length <= 64 ? req.clientIp : undefined;
    const day = new Date().toISOString().slice(0, 10);
    const grouping = ip ?? (req.groupingAddress && req.groupingAddress.length <= 64 ? req.groupingAddress : "");
    const ip_hash = await sha256Hex(`${grouping}|${day}`);
    return {
      path: req.path.slice(0, 2000),
      method: req.method,
      status: typeof req.status === "number" ? req.status : undefined,
      ua: ua.slice(0, 1000),
      referer: cap(req.header("referer"), 2000),
      accept: cap(req.header("accept"), 500),
      accept_language: cap(req.header("accept-language"), 200),
      sec_fetch_mode: cap(req.header("sec-fetch-mode"), 40),
      ip_hash,
      ip: declaresBot ? ip : undefined,
      host: cap(req.host, 253),
      signature_agent: cap(req.header("signature-agent"), 200),
      signature_input: cap(req.header("signature-input"), 1000),
      signature: cap(req.header("signature"), 1000),
    };
  }

  async function report(req: RequestInfo): Promise<void> {
    try {
      if (!shouldReport(req)) return;
      const reports = inFlight(REPORTS);
      // Beyond the bound the report is counted instead (no onError: under a flood that would be one call per request).
      if (reports.count >= MAX_REPORTS_IN_FLIGHT) { queue.countDropped(1); return; }
      reports.count++;
      let carried = 0;
      try {
        const event = await eventOf(req);
        carried = queue.takeDropped();
        const { ok } = await send(JSON.stringify(carried ? { events: [event], meta: { dropped: carried } } : { events: [event] }), timeoutMs);
        if (ok) carried = 0;
      } finally {
        reports.count--;
        // Not delivered: the count it carried waits for the next request, as a failed batch's does.
        if (carried) queue.countDropped(carried);
      }
    } catch (err) {
      onError(err);
    }
  }

  function enqueue(req: RequestInfo): void {
    try {
      if (!shouldReport(req)) return;
      queue.add(eventOf(req));
    } catch (err) {
      onError(err);
    }
  }

  function deliver(req: RequestInfo, waitUntil?: WaitUntil): void {
    try {
      if (!shouldReport(req)) return;
      const keepAlive = waitUntil ?? vercelWaitUntil();
      if (keepAlive) keepAlive(report(req));
      else if ((stops ??= stopsAfterResponse())) void report(req);
      else enqueue(req);
    } catch (err) {
      onError(err);
    }
  }

  function verifyAnswer(req: Pick<RequestInfo, "method" | "path">): string | null {
    return verifyToken && req.path === VERIFY_PATH && (req.method === "GET" || req.method === "HEAD") ? verifyToken : null;
  }

  async function purchase(order: Order): Promise<{ ok: boolean; status: number }> {
    try {
      if (!order || typeof order.order_id !== "string" || !order.order_id) throw new Error("purchase: order_id is required");
      if (!Number.isInteger(order.value_cents) || order.value_cents < 0) throw new Error("purchase: value_cents must be a whole number of cents");
      if (typeof order.currency !== "string" || !/^[A-Z]{3}$/.test(order.currency)) throw new Error("purchase: currency must be a 3-letter ISO code such as USD");
      // Never batched and never dropped silently: at the cap the caller is told at once, so it can retry.
      const purchases = inFlight(PURCHASES);
      if (purchases.count >= maxPurchases) throw new Error(`purchase: ${maxPurchases} purchases are already being posted; this one was not sent (retry it)`);
      const sid = typeof order.sid === "string" && /^[a-f0-9]{16,32}$/.test(order.sid) ? order.sid : undefined;
      const event = { event: "purchase", sid, order_id: order.order_id.slice(0, 64), value_cents: order.value_cents, currency: order.currency, items: Number.isInteger(order.items) ? order.items : undefined };
      purchases.count++;
      try {
        const { ok, status } = await send(JSON.stringify({ events: [event] }), timeoutMs, "order");
        return { ok, status };
      } finally {
        purchases.count--;
      }
    } catch (err) {
      onError(err);
      return { ok: false, status: 0 };
    }
  }

  return {
    shouldReport, report, enqueue, deliver, verifyAnswer, purchase, ipHeader,
    flush: (timeoutMs?: number) => queue.flush(timeoutMs),
    get pending() { return queue.pending; },
    get dropped() { return queue.dropped; },
  };
}

/**
 * The header named for the client address: the ipHeader option (null or "" turns it off), else PARLOX_IP_HEADER, else
 * "x-real-ip" on Vercel, which sets it at its edge. undefined when nothing names one: then an adapter that sees the
 * request may use Cloudflare's (ipHeaderFor).
 */
export function namedIpHeader(option: string | null | undefined): string | null | undefined {
  if (option !== undefined) return option ? option.toLowerCase() : null;
  return env("PARLOX_IP_HEADER")?.toLowerCase() ?? (env("VERCEL") ? "x-real-ip" : undefined);
}

/**
 * The header to read one request's client address from: the one named (namedIpHeader; null: none), else
 * "cf-connecting-ip" for a request Cloudflare's own network delivered (it carries the `cf` object: platform.ts,
 * receivedByCloudflare), else none. CF-Connecting-IP "provides the client IP address connecting to Cloudflare" and is
 * added by Cloudflare itself (developers.cloudflare.com/fundamentals/reference/http-headers/, opened 2026-10-02).
 * Self-hosted workerd reports the same user agent as Cloudflare's runtime, but there the header is whatever the client
 * sent, so the runtime's name is not enough.
 */
export function ipHeaderFor(named: string | null | undefined, request: unknown): string | null {
  if (named !== undefined) return named;
  return receivedByCloudflare(request) ? "cf-connecting-ip" : null;
}

/** Reads a header value that may be a list ("a, b") and keeps its first entry. */
export function firstValue(v: string | null | undefined): string | undefined {
  const first = v?.split(",")[0]?.trim();
  return first || undefined;
}
