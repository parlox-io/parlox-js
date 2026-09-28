// @parlox/server core: what the merchant's server reports to Parlox, and nothing else.
//
// AI fetchers and crawlers never run JavaScript, so only the server sees them. For each page request that looks
// automated, the server reports one small event, fire-and-forget, with a hard timeout: it never delays or fails the
// merchant's response, and it never holds a connection (or a serverless invocation) open waiting on Parlox. Requests
// from people are filtered out here, on the merchant's server, and never sent.
//
// The client address is sent only for requests whose user agent names a bot (so Parlox can check the claim against
// the vendor's published ranges and discard it), and only from a source the merchant trusts: a header their own proxy
// or CDN sets, named in configuration. A header any client can send (X-Forwarded-For as received) is never read.
// Everything else about a visitor is reduced to a one-way, daily-rotating hash that only groups one crawler's requests.
//
// Runs anywhere with the Web platform APIs: Node 20+, Vercel and Next.js (edge or Node), Cloudflare Workers, Deno, Bun.

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
  /** The site's secret key. Default: process.env.PARLOX_SECRET_KEY. Without it the reporter does nothing. */
  secretKey?: string;
  /** Answer for GET /.well-known/parlox-verify (ownership proof). Default: process.env.PARLOX_VERIFY_TOKEN. */
  verifyToken?: string;
  /**
   * Header that carries the client address, set by a proxy or CDN you control (Cloudflare: "cf-connecting-ip",
   * nginx: "x-real-ip"). Default: process.env.PARLOX_IP_HEADER, else "x-real-ip" on Vercel (the platform sets it),
   * else none: no address is sent.
   */
  ipHeader?: string | null;
  /** Milliseconds before a report is abandoned. Default 2000. */
  timeoutMs?: number;
  /** The Parlox gateway. Only for testing against another deployment. */
  endpoint?: string;
  /** Report GET requests under /api/ too (off by default: monitors, cron jobs and internal fetches live there). */
  includeApi?: boolean;
  /** Called with any reporting failure (network, timeout, rejected key). Reports never throw. */
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
  /** Reports the request if it should be; resolves when sent or abandoned; never rejects. */
  report(req: RequestInfo): Promise<void>;
  /** The body to answer with for the ownership check, or null when this is not that request (or no token is set). */
  verifyAnswer(req: Pick<RequestInfo, "method" | "path">): string | null;
  /** Posts a confirmed order (the purchase of record). Resolves to whether Parlox accepted it; never rejects. */
  purchase(order: Order): Promise<{ ok: boolean; status: number }>;
  /** The header the client address is read from, if any (for adapters). */
  readonly ipHeader: string | null;
}

// Words that appear in the user agents of bots, crawlers, AI fetchers, HTTP libraries and headless browsers.
export const AUTOMATION_HINT = /bot|crawl|spider|gpt|claude|anthropic|meta-|perplexity|google-agent|fetch|python|curl|wget|axios|node|http|headless|scrap/i;
// Static assets only: robots.txt, llms.txt, sitemaps and product .json are what agents read, and are reported.
const ASSET = /\.(?:png|jpe?g|gif|svg|webp|avif|ico|css|js|mjs|map|woff2?|ttf|otf|eot|mp4|webm|mp3|wav)$/i;
const SKIP_PREFIX = /^\/(?:_next\/static\/|_next\/image|_vercel\/|__nextjs)/;
// API routes are skipped by default: health checks, uptime monitors, cron jobs and the site's own server-side fetches
// live there and would otherwise read as automated visits. includeApi: true reports them (an agent calling a store API).
const API_PREFIX = /^\/api(?:\/|$)/;

function env(name: string): string | undefined {
  try {
    const p = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
    const v = p?.env?.[name];
    return v && v.trim() ? v.trim() : undefined;
  } catch { return undefined; }
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

const cap = (v: string | null | undefined, n: number) => (typeof v === "string" && v ? v.slice(0, n) : null);

export function createParlox(options: ParloxServerOptions = {}): Parlox {
  const secretKey = options.secretKey ?? env("PARLOX_SECRET_KEY");
  const verifyToken = options.verifyToken ?? env("PARLOX_VERIFY_TOKEN");
  const ipHeader = options.ipHeader !== undefined ? (options.ipHeader ? options.ipHeader.toLowerCase() : null)
    : (env("PARLOX_IP_HEADER")?.toLowerCase() ?? (env("VERCEL") ? "x-real-ip" : null));
  const timeoutMs = options.timeoutMs ?? 2000;
  const endpoint = (options.endpoint ?? DEFAULT_ENDPOINT).replace(/\/+$/, "");
  const onError = options.onError ?? (() => {});
  const includeApi = options.includeApi === true;
  let warned = false;

  async function send(events: unknown[]): Promise<{ ok: boolean; status: number }> {
    if (!secretKey) {
      if (!warned) { warned = true; onError(new Error("PARLOX_SECRET_KEY is not set; nothing is reported")); }
      return { ok: false, status: 0 };
    }
    try {
      const res = await fetch(`${endpoint}/v1/s`, {
        method: "POST",
        headers: { authorization: `Bearer ${secretKey}`, "content-type": "application/json" },
        body: JSON.stringify({ events }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      // Drain the body so the connection can be reused; its content is not needed.
      await res.arrayBuffer().catch(() => {});
      if (!res.ok) onError(new Error(`Parlox answered HTTP ${res.status}`));
      return { ok: res.ok, status: res.status };
    } catch (err) {
      onError(err);
      return { ok: false, status: 0 };
    }
  }

  function shouldReport(req: RequestInfo): boolean {
    if (!secretKey) return false;
    if (req.method !== "GET" && req.method !== "HEAD") return false;
    if (ASSET.test(req.path) || SKIP_PREFIX.test(req.path) || req.path === VERIFY_PATH) return false;
    if (!includeApi && API_PREFIX.test(req.path)) return false;
    if (req.header("x-parlox-audit")) return false; // Parlox's own page checks are not visits
    const ua = req.header("user-agent") ?? "";
    return !ua || AUTOMATION_HINT.test(ua) || !req.header("sec-fetch-mode") || !req.header("accept-language");
  }

  async function report(req: RequestInfo): Promise<void> {
    try {
      if (!shouldReport(req)) return;
      const ua = req.header("user-agent") ?? "";
      const declaresBot = AUTOMATION_HINT.test(ua);
      const ip = req.clientIp && req.clientIp.length <= 64 ? req.clientIp : undefined;
      const day = new Date().toISOString().slice(0, 10);
      const grouping = ip ?? (req.groupingAddress && req.groupingAddress.length <= 64 ? req.groupingAddress : "");
      const ip_hash = await sha256Hex(`${grouping}|${day}`);
      await send([{
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
      }]);
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
      const sid = typeof order.sid === "string" && /^[a-f0-9]{16,32}$/.test(order.sid) ? order.sid : undefined;
      return await send([{ event: "purchase", sid, order_id: order.order_id.slice(0, 64), value_cents: order.value_cents, currency: order.currency, items: Number.isInteger(order.items) ? order.items : undefined }]);
    } catch (err) {
      onError(err);
      return { ok: false, status: 0 };
    }
  }

  return { shouldReport, report, verifyAnswer, purchase, ipHeader };
}

/** Reads a header value that may be a list ("a, b") and keeps its first entry. */
export function firstValue(v: string | null | undefined): string | undefined {
  const first = v?.split(",")[0]?.trim();
  return first || undefined;
}
