// @parlox/server: report AI fetchers, crawlers and confirmed orders from the merchant's server.
//
//   Next.js:  import { withParlox } from "@parlox/server/next"
//   Express:  import { parlox } from "@parlox/server/express"
//   Hono, Remix, Workers, Bun:  import { parloxFetch } from "@parlox/server/fetch"
//   Anything else, and confirmed orders:  import { createParlox } from "@parlox/server"

export { createParlox, AUTOMATION_HINT, DEFAULT_ENDPOINT, VERIFY_PATH } from "./core.js";
export type { Parlox, ParloxServerOptions, RequestInfo, Order } from "./core.js";
