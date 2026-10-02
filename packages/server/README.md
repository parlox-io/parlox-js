# @parlox/server

Parlox agent analytics for the merchant's server. AI fetchers and crawlers (ChatGPT, Claude, Perplexity, Google's agents...) never run JavaScript, so only your server sees them. This package reports them to Parlox, and posts confirmed orders. [`@parlox/browser`](https://www.npmjs.com/package/@parlox/browser) is the browser part.

```bash
npm install @parlox/server
```

The easiest install is the wizard, run in your project: `npx parlox init` (Next.js; Vite React, Express and Hono from parlox 1.1.0).

Set `PARLOX_SECRET_KEY` in the environment: the wizard does, or create a key in the Parlox dashboard (Settings → Keys). Crawler reports need no more than "Crawler reports only" access; orders use a key of their own ([below](#confirmed-orders)). Optional: `PARLOX_VERIFY_TOKEN` (answers `GET /.well-known/parlox-verify` to prove you own the domain) and `PARLOX_IP_HEADER` (below).

## Next.js

```ts
// middleware.ts (proxy.ts in Next.js 16)
import { withParlox } from "@parlox/server/next";

export default withParlox();            // or withParlox(yourMiddleware): its result is returned unchanged
// New install: pages, robots.txt, llms.txt, sitemaps and the ownership check; not static assets or API routes.
// Wrapping an existing middleware? Keep your own matcher (it decides where your middleware runs; Parlox reports what
// it sees). Include /api/ in it and pass includeApi: true to report agents calling your API.
export const config = { matcher: ["/((?!_next/static|_next/image|api/|favicon.ico|.*\\.(?:png|jpe?g|gif|svg|webp|avif|ico|css|js|map|woff2?)$).*)"] };
```

## Express (and any Connect-style server)

```js
import { parlox } from "@parlox/server/express";   // or require("@parlox/server/express")
app.use(parlox());                                 // before your routes
```

## Hono (Node, Bun, Cloudflare Workers and Pages, Vercel, AWS Lambda)

```ts
import { parlox } from "@parlox/server/hono";

const app = new Hono();
app.use(parlox());                                 // right after the app is created, before your routes
```

On Workers, set `PARLOX_SECRET_KEY` (a secret) and `PARLOX_VERIFY_TOKEN` as the Worker's variables: the Hono adapter reads them, and `PARLOX_IP_HEADER`, from `c.env` first, then `process.env`. The client address is read from `cf-connecting-ip`, which Cloudflare sets, for a request that carries Cloudflare's `cf` object (Cloudflare's own runtime gives one to every request it delivers), unless `PARLOX_IP_HEADER` names another header. On self-hosted workerd, set `ipHeader` (or `PARLOX_IP_HEADER`) to the header your proxy sets: it reports the same user agent as Cloudflare's runtime and gives no `cf` object unless its config reads one from a header, and there `cf-connecting-ip` is whatever the client sent. The report uses the runtime's `waitUntil` where there is one (Cloudflare Workers and Pages, Vercel), is sent at once on AWS Lambda (where it usually goes out only during the instance's next invocation, [below](#what-it-sends-and-what-it-never-does)), and waits in the batching queue on Node and Bun (`parlox.flush()` sends it before a shutdown: [below](#shutdown-long-running-servers)).

## Vercel Routing Middleware (a Vite app or a static site on Vercel)

```ts
// middleware.ts, next to package.json
import { next } from "@vercel/functions";
import { withParlox } from "@parlox/server/vercel";

export default withParlox({ next });              // or withParlox(yourMiddleware, { next })
export const config = { matcher: ["/((?!assets/|_vercel/|favicon\\.ico|.*\\.(?:png|jpe?g|gif|svg|webp|avif|ico|css|js|map|woff2?)$).*)"] };
```

`next` comes from Vercel's own `@vercel/functions` package and is passed in, so `@parlox/server` has no dependencies. The matcher keeps the middleware off static assets and Vercel's own `/_vercel/` paths. Routing Middleware "is priced using the fluid compute model" ([Vercel](https://vercel.com/docs/routing-middleware)).

## Remix, SvelteKit, Astro, Deno, other Web-standard servers

```ts
import { parloxFetch } from "@parlox/server/fetch";
const parlox = parloxFetch();

// before your handler:
const early = parlox.handle(request);
if (early) return early;
// after it, with the platform's waitUntil when it has one:
parlox.observe(request, response.status, waitUntil);
```

## Confirmed orders

The purchase of record comes from your server. Send the browser's `sessionId()` with the checkout, store it on the order, and post the order once it exists:

```ts
import { createParlox } from "@parlox/server";
const orders = createParlox({ secretKey: process.env.PARLOX_ORDERS_KEY });
await orders.purchase({ sid, order_id: "1001", value_cents: 9980, currency: "USD", items: 2 });
```

Orders have an instance and a variable of their own because the key the wizard sets in `PARLOX_SECRET_KEY` can only send crawler reports: Parlox refuses an order sent with it (HTTP 403, and `onError` gets the reason). Create a send key in the dashboard under Settings → Keys, with access "Send: crawler reports and orders", and set it as `PARLOX_ORDERS_KEY` only on the server that posts orders (never under a `VITE_` or `NEXT_PUBLIC_` name), leaving `PARLOX_SECRET_KEY` as it is. A `secretKey` you pass is used alone: if `PARLOX_ORDERS_KEY` is not set, that instance sends nothing and says so once in the log, and never falls back to `PARLOX_SECRET_KEY`.

## Shutdown (long-running servers)

On a server that keeps running between requests (Express, or Hono on Node or Bun, on Fly.io, Render, Railway, Heroku, Cloud Run, Kubernetes or your own machine), reports wait in a queue and go in batches. When the platform stops the server (a deploy, a restart, scaling down), it sends the process a signal first. Send what is queued in your shutdown code:

```js
import { parlox } from "@parlox/server/express";   // or "@parlox/server/hono"

process.on("SIGTERM", async () => { await parlox.flush(); process.exit(0); });
```

Fit it to the shutdown your app already has: if it already listens for the signal (to close its server or its database connections), add `await parlox.flush()` there, before it exits, rather than a second listener. The SDK installs no signal handler of its own, because a listener replaces Node's default exit for the whole app. `flush()` waits at most 30 seconds (`parlox.flush(ms)` sets another limit); give it less than the platform's grace period. Fly.io sends SIGINT unless `kill_signal` in fly.toml names another signal, and waits 5 seconds by default (`kill_timeout`) before it stops the process ([Fly.io](https://docs.fly.io/reference/configuration)): listen for that signal there, and use `parlox.flush(4000)`.

A hard kill (SIGKILL, or the grace period running out) loses what is queued, and with it the count of reports not yet delivered, so that gap does not show on the dashboard either.

## What it sends, and what it never does

- For page requests that look automated (a bot user agent, or none of a browser's headers), one small event: path, method, status, user agent, a few request headers, and a one-way daily-rotating hash that groups one crawler's requests. Requests from people are filtered out on your server and never sent.
- The client address only for requests whose user agent names a bot (Parlox checks the claim against the vendor's published ranges and discards it), and only from a header a proxy you control sets: `x-real-ip` on Vercel automatically, and, in the Hono and fetch adapters, `cf-connecting-ip` only for a request that carries Cloudflare's `cf` object (each platform sets its own), otherwise the header named in `PARLOX_IP_HEADER` (behind Cloudflare's proxy: `cf-connecting-ip`). Without it, no address is sent. It never reads `X-Forwarded-For` as the client sent it and never changes your framework's proxy-trust settings.
- Reports never delay or fail a response and never throw; pass `onError` to see failures. Where the platform keeps work alive after the response (Next.js middleware, Vercel, Cloudflare Workers), each report is sent at once through `waitUntil` and gives up after two seconds. At most 64 reports are sent at once in the whole process (every instance together; Sentry's JavaScript SDKs keep the same number of requests in flight by default); beyond that a report is not sent but counted, and the count goes with the instance's next request, so the dashboard shows the gap.
- On a long-running server (Express, Hono on Node or Bun), reports wait in a bounded queue and go in batches: at 20 reports or every 10 seconds, at most 100 reports and 200,000 bytes per request, one request to Parlox at a time, a 10-second limit. While a request is in flight new reports wait; the next batch goes at once only if 20 are waiting, otherwise on the interval. At most 1000 wait; when the queue is full the oldest is dropped. The number of reports dropped, or whose delivery was not confirmed, is sent with the next batch, so the dashboard shows the gap.
- The queue's timers never keep your process alive, and what is queued is sent when the process is about to exit on its own. The SDK installs no signal handlers: if your server stops on a signal, `await flush()` first (`import { flush } from "@parlox/server"`, or `parlox.flush()` from the Express or Hono adapter; the snippet is [above](#shutdown-long-running-servers)). It sends the reports queued so far and keeps the process running until they are sent, at most 30 seconds (`flush(ms)` sets another limit); those it could not send by then are counted as delivery not confirmed.
- Where the platform may stop or freeze your code soon after a response and no `waitUntil` is passed (AWS Lambda, Cloudflare Workers, Deno Deploy, Azure Functions, each recognised by a signal its own documentation defines), each report is sent at once, never queued. One can still be lost if the platform stops the code before it is sent. On AWS Lambda that is the usual case: the request to Parlox starts only after an asynchronous one-way hash, so after your handler has returned, and Lambda then freezes the instance. The report is usually delayed to the next invocation of the same warm instance, and lost when the instance is frozen and then recycled.
- A batch is sent again only when Parlox provably stored none of it: it answered `429` (its rate limit refuses before anything is stored), or the connection never reached it (refused, or the name did not resolve). Then up to 3 more attempts, 3 seconds apart, or after Parlox's `Retry-After` (at most 60 seconds). Any other failure (a timeout, a `5xx`, a dropped connection, a rejected key) is not retried, because Parlox may have stored the batch and a retry could count its reports twice; its reports are counted as delivery not confirmed.
- `purchase()` is never batched: each order is posted at once and the promise says whether Parlox accepted it. At most 10 are posted at the same time in the whole process (every instance together); beyond that the call resolves `{ ok: false, status: 0 }` at once (and `onError` says why), so your code can retry. Each instance compares the number in flight in the process with its own `maxPurchasesInFlight`: an instance given a higher limit can take that number past a lower one, and an instance with the lower limit then refuses until the number is back under its own. When Parlox refuses an order, the promise gives the status and `onError` gets Parlox's reason, for example `Parlox refused the order (HTTP 403): This key can only send crawler reports. …` (at most 300 characters, on one line, the key never included).
- A key Parlox refuses (HTTP 401 or 403) is also said in your server's log (`console.warn`), with Parlox's reason, the key never included: once per instance for orders and once for crawler reports, never a line per request, so an app that passes no `onError` still sees it.
- On Deno, environment variables are read only with `--allow-env` (for all of them, or naming each one), so a terminal never shows Deno's permission prompt for them: without it they count as unset, nothing is reported unless the key is passed as `secretKey`, and reports wait in the queue as on any long-running server.
- No runtime dependencies. Node 20+, edge runtimes, Workers, Deno, Bun.

| Option | Default |
|---|---|
| `secretKey` | `process.env.PARLOX_SECRET_KEY` (Hono: `c.env` first), read only when the option is not given: a `secretKey` that is unset or empty is used as it is (nothing is sent, and the log says so once) |
| `verifyToken` | `process.env.PARLOX_VERIFY_TOKEN` (Hono: `c.env` first) |
| `ipHeader` | `process.env.PARLOX_IP_HEADER` (Hono: `c.env` first), else `x-real-ip` on Vercel, else (Hono and fetch) `cf-connecting-ip` for a request that carries Cloudflare's `cf` object, else none (`null` turns it off) |
| `clientIp(req)` | your own source of the client address (overrides `ipHeader`) |
| `timeoutMs` | `2000` (reports sent on their own, and purchases; a whole number from 1, anything else is the default) |
| `flushAt` | `20`: long-running servers send a batch once this many reports wait (at most `maxBatchSize`) |
| `flushIntervalMs` | `10000`: and at least this often |
| `maxBatchSize` | `100` (the most the gateway accepts per request) |
| `maxBatchBytes` | `200000`, the most (the gateway accepts 256 KB per request) |
| `maxQueueSize` | `1000`: when full, the oldest is dropped and counted |
| `batchTimeoutMs` | `10000` |
| `retryCount` | `3`: further attempts for a batch Parlox provably did not store (`0` turns retries off) |
| `retryDelayMs` | `3000`, when Parlox names no `Retry-After` (at most `60000`) |
| `maxPurchasesInFlight` | `10`, for the whole process |
| `includeApi` | `false`: GET requests under `/api/` (monitors, cron jobs, internal fetches) are not reported |
| `runWrapped(pathname)` | Next.js only: which requests the wrapped middleware runs for (default: every request the matcher sends; it is never skipped) |
| `onError(err)` | ignored |

Install guide: https://gateway.parlox.io/install.md

## Changes

- 1.1.0: `@parlox/server/hono` and `@parlox/server/vercel`. Long-running servers (Express, Hono on Node or Bun) now send reports in bounded batches, one request at a time; a batch is sent again only when Parlox provably stored none of it, and the reports dropped from a full queue or whose delivery was not confirmed are counted and sent with the next batch; `flush()` sends what is queued. Where the platform may stop the code soon after a response (AWS Lambda, Cloudflare Workers, Deno Deploy, Azure Functions), each report is sent at once (on AWS Lambda usually during the instance's next invocation); at most 64 are sent at once in the process, and those beyond it are counted. `purchase()` allows at most 10 at the same time in the process, and `onError` gets Parlox's reason when it refuses an order. On Deno the environment is read only with permission (no prompt), and the queue's timers do not keep the process alive there either. A `secretKey` option is now used alone, even when it is unset or empty (1.0 read `PARLOX_SECRET_KEY` instead); a key Parlox refuses is said once in the log; the Hono and fetch adapters read the client address from `cf-connecting-ip` by default for a request Cloudflare's own network delivered (it carries the `cf` object); a `timeoutMs` that is not a whole number from 1 is the default. Includes 1.0.1.
- 1.0.1 (not published separately): `withParlox` accepts a middleware typed with Next.js's `NextRequest`.
  The type parameters of `withParlox` changed (the request type now comes first, then the event type, then the return type). Code that called `withParlox<R>()` with an explicit type argument should drop it; the types are inferred from the middleware passed in.
