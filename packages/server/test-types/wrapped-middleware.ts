// Compiled with tsc --noEmit (strict) by npm test: a middleware typed with Next's own request type must wrap.
import { withParlox } from "../src/next.js";

interface NextRequest { method: string; headers: Headers; nextUrl: URL; cookies: { get(name: string): { value: string } | undefined } }
interface NextFetchEvent { waitUntil(p: Promise<unknown>): void; sourcePage: string }

function middleware(req: NextRequest, _event: NextFetchEvent): Response | undefined {
  return req.cookies.get("blocked") ? new Response("no", { status: 403 }) : undefined;
}

export const wrapped = withParlox(middleware);
const out: Response | undefined = wrapped({} as NextRequest, { waitUntil() {}, sourcePage: "/" });
void out;
export const bare = withParlox();
