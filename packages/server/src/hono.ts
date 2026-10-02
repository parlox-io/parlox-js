// @parlox/server/hono: middleware for Hono, on the runtimes Hono runs on.
//
//   import { parlox } from "@parlox/server/hono";
//   app.use(parlox());                                   // right after `const app = new Hono()`
//
// Answers the ownership check (GET and HEAD /.well-known/parlox-verify), lets the request through, then reports it if
// it looks automated. The report outlives the response through the runtime's waitUntil: c.executionCtx on Cloudflare
// Workers and Pages, the request context on Vercel. Without either, the core's rules apply (Parlox.deliver): sent at
// once where the platform may stop the code after a response (AWS Lambda, where it usually goes out only during the
// instance's next invocation: see platform.ts), else it waits in the batching queue (Node, Bun). Hono's executionCtx
// getter throws where there is none ("This context has no ExecutionContext"), so it is read inside try/catch, as Hono's
// own Sentry middleware (honojs/middleware, packages/sentry) does.
//
// PARLOX_SECRET_KEY, PARLOX_VERIFY_TOKEN and PARLOX_IP_HEADER are read from c.env first (Workers bindings), then from
// process.env; options passed here win over both (a secretKey option even when it is unset or empty). The client
// address is read from cf-connecting-ip for a request Cloudflare's own network delivered (c.req.raw.cf is an object)
// unless PARLOX_IP_HEADER or ipHeader names another header; self-hosted workerd gives no cf object, so there no header
// is read unless one is named. It never delays a response and never throws.

import { createParlox, firstValue, flush, ipHeaderFor, namedIpHeader, type Parlox, type ParloxServerOptions } from "./core.js";
import { vercelWaitUntil, type WaitUntil } from "./platform.js";

/** The parts of Hono's Context this reads. Hono's own Context is assignable to it, so no import from "hono" is needed. */
export interface HonoContextLike {
  req: { raw: Request };
  res: Response;
  env?: unknown;
  readonly executionCtx: { waitUntil(promise: Promise<unknown>): void };
}

export interface HonoOptions extends ParloxServerOptions {
  /** Custom source of the client address; overrides ipHeader. */
  clientIp?: (request: Request) => string | undefined;
}

const ENV_KEYS = ["PARLOX_SECRET_KEY", "PARLOX_VERIFY_TOKEN", "PARLOX_IP_HEADER"] as const;
type EnvKey = (typeof ENV_KEYS)[number];
// Distinct sets of bindings kept at once (a Worker's bindings are the same on every request; eight is room to spare).
const MAX_CORES = 8;

function bindingsOf(env: unknown): Partial<Record<EnvKey, string>> {
  const out: Partial<Record<EnvKey, string>> = {};
  if (!env || typeof env !== "object") return out;
  for (const k of ENV_KEYS) {
    const v = (env as Record<string, unknown>)[k];
    if (typeof v === "string" && v.trim()) out[k] = v.trim();
  }
  return out;
}

function waitUntilOf(c: HonoContextLike): WaitUntil | undefined {
  try {
    const ctx = c.executionCtx;
    if (ctx && typeof ctx.waitUntil === "function") return (promise) => ctx.waitUntil(promise);
  } catch { /* this runtime has no ExecutionContext (Node, Bun) */ }
  return vercelWaitUntil();
}

export function parlox(options: HonoOptions = {}) {
  // One core per distinct set of Parlox bindings, so the requests that share them share one queue and its bounds.
  // Without Parlox bindings (Node, Bun), a single core reads process.env.
  // Each core with the header named for the client address (undefined: none is named, so the request decides).
  const cores = new Map<string, { p: Parlox; named: string | null | undefined }>();
  const coreFor = (env: unknown): { p: Parlox; named: string | null | undefined } => {
    const b = bindingsOf(env);
    const key = ENV_KEYS.map((k) => b[k] ?? "").join("\u0000");
    let core = cores.get(key);
    if (!core) {
      if (cores.size >= MAX_CORES) cores.delete(cores.keys().next().value as string);
      const named = namedIpHeader(options.ipHeader !== undefined ? options.ipHeader : b.PARLOX_IP_HEADER);
      const p = createParlox({
        ...options,
        // A secretKey option is used alone, even unset or empty (core.ts); without one, the binding, then process.env.
        ...("secretKey" in options || !b.PARLOX_SECRET_KEY ? {} : { secretKey: b.PARLOX_SECRET_KEY }),
        verifyToken: options.verifyToken ?? b.PARLOX_VERIFY_TOKEN,
        ipHeader: named,
      });
      core = { p, named };
      cores.set(key, core);
    }
    return core;
  };

  return async function parloxMiddleware(c: HonoContextLike, next: () => Promise<void>): Promise<Response | void> {
    let p: Parlox | null = null;
    let named: string | null | undefined;
    let request: Request | null = null;
    let url: URL | null = null;
    try {
      request = c.req.raw;
      url = new URL(request.url);
      ({ p, named } = coreFor(c.env));
      const answer = p.verifyAnswer({ method: request.method, path: url.pathname });
      if (answer !== null) return new Response(request.method === "HEAD" ? null : answer, { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
    } catch { p = null; /* Parlox must never break the site */ }
    // The app's own errors are Hono's to handle: they are not caught here.
    await next();
    try {
      if (!p || !request || !url) return;
      const r = request;
      const ipHeader = options.clientIp ? null : ipHeaderFor(named, r);
      const info = {
        method: r.method, path: url.pathname, host: url.hostname || null, status: c.res.status,
        header: (n: string) => r.headers.get(n),
        clientIp: options.clientIp ? options.clientIp(r) : ipHeader ? firstValue(r.headers.get(ipHeader)) : undefined,
        groupingAddress: firstValue(r.headers.get("x-forwarded-for")) ?? firstValue(r.headers.get("x-real-ip")),
      };
      if (p.shouldReport(info)) p.deliver(info, waitUntilOf(c));
    } catch { /* Parlox must never break the site */ }
  };
}

/** Sends the reports queued so far (Node and Bun), for apps that stop on a signal:
 * `process.on("SIGTERM", () => parlox.flush().then(() => process.exit(0)))`. Gives up after timeoutMs (default 30000). */
parlox.flush = flush;

export { createParlox } from "./core.js";
