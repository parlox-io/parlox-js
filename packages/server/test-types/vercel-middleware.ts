// Compiled with tsc --noEmit (strict) by npm test: withParlox({ next }) and withParlox(existing, { next }), typed the
// way @vercel/functions types them.
import { withParlox } from "../src/vercel.js";

declare function next(init?: ResponseInit): Response;
interface RequestContext { waitUntil(promise: Promise<unknown>): void }

async function auth(request: Request, _context: RequestContext): Promise<Response> {
  return request.headers.get("authorization") ? next() : new Response("no", { status: 401 });
}

export const bare = withParlox({ next });
export const wrapped = withParlox(auth, { next });
const direct: Response = bare(new Request("https://shop.example.com/"), { waitUntil() {} });
const viaExisting: Promise<Response> | Response = wrapped(new Request("https://shop.example.com/"), { waitUntil() {} });
void direct; void viaExisting;

// A middleware whose context is optional, or that takes none, gives a wrapper that can be called without one.
function opt(request: Request, _context?: RequestContext): Response {
  return request.method === "GET" ? next() : new Response(null, { status: 405 });
}
function plain(_request: Request): Response { return next(); }
export const optional = withParlox(opt, { next });
export const contextless = withParlox(plain, { next });
const fromOptional: Response = optional(new Request("https://shop.example.com/"));
const fromPlain: Response = contextless(new Request("https://shop.example.com/"));
void fromOptional; void fromPlain;
// A middleware that requires its context still requires one.
// @ts-expect-error: auth takes a context, so the wrapper does too
void wrapped(new Request("https://shop.example.com/"));
