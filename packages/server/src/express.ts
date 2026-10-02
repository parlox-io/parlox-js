// @parlox/server/express: middleware for Express, and any Connect-style server (Node's http, Fastify via
// @fastify/express or middie, Koa via koa-connect).
//
//   import { parlox } from "@parlox/server/express";    // or: const { parlox } = require("@parlox/server/express")
//   app.use(parlox());                                   // before your routes
//
// Reads PARLOX_SECRET_KEY, PARLOX_VERIFY_TOKEN and PARLOX_IP_HEADER from the environment. It never changes the app's
// settings (it does not touch Express's "trust proxy", so req.ip means what it meant before) and never delays a
// response. Reports go after the response has finished: in batches, at most one request to Parlox at a time (see flush
// below for shutdown), or through Vercel's waitUntil when the app runs on Vercel.

import { createParlox, firstValue, flush, type ParloxServerOptions } from "./core.js";
import { vercelWaitUntil } from "./platform.js";

interface NodeReq {
  method?: string;
  url?: string;
  path?: string;
  originalUrl?: string;
  hostname?: string;
  headers: Record<string, string | string[] | undefined>;
  socket?: { remoteAddress?: string };
  ip?: string;
  app?: { get?(setting: string): unknown };
}
interface NodeRes {
  statusCode: number;
  headersSent?: boolean;
  setHeader(name: string, value: string): unknown;
  end(body?: string): unknown;
  once(event: "finish", listener: () => void): unknown;
}
type Next = (err?: unknown) => void;

export interface ExpressOptions extends ParloxServerOptions {
  /** Custom source of the client address (for example your own trusted-proxy logic); overrides ipHeader. */
  clientIp?: (req: NodeReq) => string | undefined;
}

function header(req: NodeReq, name: string): string | null {
  const v = req.headers[name.toLowerCase()];
  return Array.isArray(v) ? v.join(", ") : v ?? null;
}

function pathOf(req: NodeReq): string {
  if (typeof req.path === "string") return req.path;
  try { return new URL(req.originalUrl ?? req.url ?? "/", "http://localhost").pathname; } catch { return "/"; }
}

export function parlox(options: ExpressOptions = {}) {
  const p = createParlox(options);
  return function parloxMiddleware(req: NodeReq, res: NodeRes, next: Next): void {
    try {
      const method = (req.method ?? "GET").toUpperCase();
      const path = pathOf(req);
      const answer = p.verifyAnswer({ method, path });
      if (answer !== null) {
        res.statusCode = 200;
        res.setHeader("content-type", "text/plain; charset=utf-8");
        res.setHeader("cache-control", "no-store");
        res.end(method === "HEAD" ? undefined : answer);
        return;
      }
      const info = {
        method, path,
        host: (typeof req.hostname === "string" ? req.hostname : header(req, "host")?.replace(/:\d+$/, "")) || null,
        header: (n: string) => header(req, n),
        clientIp: options.clientIp ? options.clientIp(req) : p.ipHeader ? firstValue(header(req, p.ipHeader)) : undefined,
        // Grouping only (hashed, never sent). When the app has configured Express's trust proxy, req.ip is the client
        // as the app itself trusts it. Otherwise the socket is often a proxy, so the first forwarded address is used
        // (a client that forges it only splits its own requests), then the socket.
        groupingAddress: (req.app?.get?.("trust proxy") ? req.ip : undefined) ?? firstValue(header(req, "x-forwarded-for")) ?? req.socket?.remoteAddress,
      };
      if (p.shouldReport(info)) {
        // Read here, inside the request: Vercel's request context belongs to it.
        const waitUntil = vercelWaitUntil();
        res.once("finish", () => { p.deliver({ ...info, status: res.statusCode }, waitUntil); });
      }
    } catch { /* Parlox must never break the site */ }
    next();
  };
}

/** Sends every queued report now, for apps that stop on a signal: `process.on("SIGTERM", () => parlox.flush().then(() => process.exit(0)))`. */
parlox.flush = flush;

export { createParlox } from "./core.js";
