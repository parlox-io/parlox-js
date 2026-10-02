// @parlox/server/vercel: Vercel Routing Middleware for a project Vercel builds without its own middleware (a Vite
// single-page app, a static site).
//
//   // middleware.ts, next to package.json
//   import { next } from "@vercel/functions";
//   import { withParlox } from "@parlox/server/vercel";
//   export default withParlox({ next });                 // or withParlox(yourMiddleware, { next })
//   export const config = { matcher: ["/((?!assets/|_vercel/|favicon\\.ico|.*\\.(?:png|jpe?g|gif|svg|webp|avif|ico|css|js|map|woff2?)$).*)"] };
//
// Answers the ownership check, reports automated page requests through context.waitUntil ("Prolongs the execution of
// the function"), then returns your middleware's response, or next() ("returns a Response that instructs the function
// to continue the middleware chain"). `next` is passed in, so this package keeps zero dependencies. Parlox's own work
// never throws and never delays a response; your middleware's response, and any error it throws, pass through as they are.

import { createParlox, firstValue, type ParloxServerOptions } from "./core.js";
import { vercelWaitUntil } from "./platform.js";

export interface VercelRequestContextLike { waitUntil(promise: Promise<unknown>): void }

export interface VercelOptions extends ParloxServerOptions {
  /** `next` from "@vercel/functions". */
  next: () => Response;
  /** Custom source of the client address; overrides ipHeader. */
  clientIp?: (request: Request) => string | undefined;
}

export function withParlox(options: VercelOptions): (request: Request, context?: VercelRequestContextLike) => Response;
// The wrapper takes the same parameters as the middleware it wraps: a context it requires stays required, and one it
// declares optional (or does not take) stays optional.
export function withParlox<A extends [context?: VercelRequestContextLike], R>(existing: (request: Request, ...context: A) => R, options: VercelOptions): (request: Request, ...context: A) => R | Response;
export function withParlox(a: VercelOptions | ((request: Request, context: any) => unknown), b?: VercelOptions): any {
  const existing = typeof a === "function" ? a : undefined;
  const options: VercelOptions = (typeof a === "function" ? b : a) ?? ({} as VercelOptions);
  const p = createParlox(options);
  return (request: Request, context?: VercelRequestContextLike) => {
    try {
      const url = new URL(request.url);
      const answer = p.verifyAnswer({ method: request.method, path: url.pathname });
      if (answer !== null) return new Response(request.method === "HEAD" ? null : answer, { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
      const info = {
        method: request.method, path: url.pathname, host: url.hostname || null,
        header: (n: string) => request.headers.get(n),
        clientIp: options.clientIp ? options.clientIp(request) : p.ipHeader ? firstValue(request.headers.get(p.ipHeader)) : undefined,
        groupingAddress: firstValue(request.headers.get("x-forwarded-for")) ?? firstValue(request.headers.get("x-real-ip")),
      };
      if (p.shouldReport(info)) {
        const waitUntil = context && typeof context.waitUntil === "function" ? (x: Promise<unknown>) => context.waitUntil(x) : vercelWaitUntil();
        // Routing Middleware always has a waitUntil. Without one the report still goes at once: a queue's timer would
        // not run in a function that is frozen after it answers.
        if (waitUntil) waitUntil(p.report(info));
        else void p.report(info);
      }
    } catch { /* Parlox must never break the site */ }
    return existing ? existing(request, context) : options.next?.();
  };
}
