// @parlox/server/fetch: for servers built on the Web-standard Request/Response (Hono, Remix, SvelteKit hooks, Astro
// middleware, Cloudflare Workers, Deno, Bun).
//
//   import { parloxFetch } from "@parlox/server/fetch";
//   const parlox = parloxFetch();
//   // Hono:
//   app.use(async (c, next) => {
//     const early = parlox.handle(c.req.raw); if (early) return early;
//     await next();
//     parlox.observe(c.req.raw, c.res.status, (p) => c.executionCtx.waitUntil(p));
//   });
//   Without waitUntil (Node or Bun), reports wait in the batching queue; Hono has its own adapter, @parlox/server/hono.

import { createParlox, firstValue, flush, ipHeaderFor, namedIpHeader, type ParloxServerOptions } from "./core.js";

export interface FetchOptions extends ParloxServerOptions {
  /** Custom source of the client address; overrides ipHeader. */
  clientIp?: (request: Request) => string | undefined;
}

export function parloxFetch(options: FetchOptions = {}) {
  // The header named for the client address; when none is, cf-connecting-ip for a request Cloudflare's own network
  // delivered (it carries the cf object), else none (core.ts, ipHeaderFor).
  const named = namedIpHeader(options.ipHeader);
  const p = createParlox(options);
  return {
    /** The ownership-check answer for this request, or null to continue. */
    handle(request: Request): Response | null {
      try {
        const answer = p.verifyAnswer({ method: request.method, path: new URL(request.url).pathname });
        return answer === null ? null : new Response(request.method === "HEAD" ? null : answer, { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
      } catch { return null; }
    },
    /**
     * Reports the request if it looks automated. Pass the platform's waitUntil so the report outlives the response on
     * serverless and edge runtimes; without it (a long-running server) the report waits in the batching queue.
     */
    observe(request: Request, status?: number, waitUntil?: (promise: Promise<unknown>) => void): void {
      try {
        const url = new URL(request.url);
        const ipHeader = options.clientIp ? null : ipHeaderFor(named, request);
        const info = {
          method: request.method, path: url.pathname, host: url.hostname || null, status,
          header: (n: string) => request.headers.get(n),
          clientIp: options.clientIp ? options.clientIp(request) : ipHeader ? firstValue(request.headers.get(ipHeader)) : undefined,
          groupingAddress: firstValue(request.headers.get("x-forwarded-for")) ?? firstValue(request.headers.get("x-real-ip")),
        };
        p.deliver(info, waitUntil);
      } catch { /* Parlox must never break the site */ }
    },
    purchase: p.purchase,
    flush,
  };
}

export { createParlox } from "./core.js";
