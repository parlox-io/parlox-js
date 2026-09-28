// @parlox/server/next: Next.js middleware (middleware.ts, or proxy.ts in Next.js 16).
//
//   // middleware.ts
//   import { withParlox } from "@parlox/server/next";
//   export default withParlox();                     // or withParlox(yourMiddleware)
//   export const config = { matcher: ["/((?!_next/static|_next/image|api/|favicon.ico|.*\\.(?:png|jpe?g|gif|svg|webp|avif|ico|css|js|map|woff2?)$).*)"] };
//   (pages, robots.txt, llms.txt, sitemaps and /.well-known/parlox-verify run it; static assets and API routes do not)
//
// Reads PARLOX_SECRET_KEY and PARLOX_VERIFY_TOKEN from the environment. The report is handed to the platform's
// waitUntil, so the page is never delayed, and it gives up after two seconds. No import from "next" is needed at
// runtime; the types below are the parts of NextRequest this uses.

import { createParlox, firstValue, type Parlox, type ParloxServerOptions } from "./core.js";

export interface NextRequestLike {
  method: string;
  headers: { get(name: string): string | null };
  nextUrl: { pathname: string; hostname: string };
}
export interface NextFetchEventLike { waitUntil(promise: Promise<unknown>): void }
type Middleware<R> = (req: NextRequestLike, event: NextFetchEventLike) => R;

export interface NextOptions extends ParloxServerOptions {
  /** Custom source of the client address; overrides ipHeader. */
  clientIp?: (req: NextRequestLike) => string | undefined;
  /**
   * Which requests the wrapped middleware runs for. Default: every request the matcher sends; it is never skipped, so
   * an auth or locale middleware keeps guarding every route it guarded before. Pass a function to keep it off paths it
   * should not see, for example (p) => !/\.(txt|xml)$/.test(p) for robots.txt and sitemaps.
   */
  runWrapped?: (pathname: string) => boolean;
}

function info(parlox: Parlox, req: NextRequestLike, options: NextOptions) {
  return {
    method: req.method,
    path: req.nextUrl.pathname,
    host: req.nextUrl.hostname || null,
    header: (n: string) => req.headers.get(n),
    clientIp: options.clientIp ? options.clientIp(req) : parlox.ipHeader ? firstValue(req.headers.get(parlox.ipHeader)) : undefined,
    groupingAddress: firstValue(req.headers.get("x-forwarded-for")) ?? firstValue(req.headers.get("x-real-ip")),
  };
}

/**
 * Wraps a Next.js middleware (or none) with Parlox: answers the ownership check, reports automated page requests in
 * the background, then runs the wrapped middleware and returns its result unchanged.
 */
export function withParlox<R>(middleware?: Middleware<R>, options: NextOptions = {}): Middleware<R | Response | undefined> {
  const parlox = createParlox(options);
  return (req, event) => {
    try {
      const answer = parlox.verifyAnswer({ method: req.method, path: req.nextUrl.pathname });
      if (answer !== null) return new Response(answer, { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
      const r = info(parlox, req, options);
      if (parlox.shouldReport(r)) {
        const p = parlox.report(r);
        if (event && typeof event.waitUntil === "function") event.waitUntil(p);
      }
    } catch { /* Parlox must never break the site */ }
    if (!middleware) return undefined;
    return !options.runWrapped || options.runWrapped(req.nextUrl.pathname) ? middleware(req, event) : undefined;
  };
}

/** A ready-made middleware with no wrapped middleware: export default parloxMiddleware. */
export const parloxMiddleware = withParlox();
