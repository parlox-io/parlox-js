// @parlox/server: report AI fetchers, crawlers, confirmed orders and UCP calls from the merchant's server.
//
//   Next.js:  import { withParlox } from "@parlox/server/next"
//   Express:  import { parlox } from "@parlox/server/express"
//   Hono:  import { parlox } from "@parlox/server/hono"
//   Vercel Routing Middleware (a Vite app or a static site):  import { withParlox } from "@parlox/server/vercel"
//   Remix, SvelteKit, Astro, Deno, other Web-standard servers:  import { parloxFetch } from "@parlox/server/fetch"
//   Anything else, confirmed orders and UCP reports:  import { createParlox } from "@parlox/server"

export { createParlox, flush, AUTOMATION_HINT, DEFAULT_ENDPOINT, VERIFY_PATH } from "./core.js";
export type { Parlox, ParloxServerOptions, RequestInfo, Order, UcpReport, UcpContext, UcpCode, UcpOp, UcpCheckoutStatus } from "./core.js";
