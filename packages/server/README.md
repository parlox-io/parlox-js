# @parlox/server

Parlox agent analytics for the merchant's server. AI fetchers and crawlers (ChatGPT, Claude, Perplexity, Google's agents...) never run JavaScript, so only your server sees them. This package reports them to Parlox, and posts confirmed orders. [`@parlox/browser`](https://www.npmjs.com/package/@parlox/browser) is the browser part.

```bash
npm install @parlox/server
```

Set `PARLOX_SECRET_KEY` in the environment (from the Parlox dashboard). Optional: `PARLOX_VERIFY_TOKEN` (answers `GET /.well-known/parlox-verify` to prove you own the domain) and `PARLOX_IP_HEADER` (below).

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

## Hono, Remix, SvelteKit, Astro, Cloudflare Workers, Deno, Bun

```ts
import { parloxFetch } from "@parlox/server/fetch";
const parlox = parloxFetch();

app.use(async (c, next) => {                       // Hono
  const early = parlox.handle(c.req.raw);
  if (early) return early;
  await next();
  parlox.observe(c.req.raw, c.res.status, (p) => c.executionCtx.waitUntil(p));
});
```

## Confirmed orders

The purchase of record comes from your server. Send the browser's `sessionId()` with the checkout, store it on the order, and post the order once it exists:

```ts
import { createParlox } from "@parlox/server";
const parlox = createParlox();
await parlox.purchase({ sid, order_id: "1001", value_cents: 9980, currency: "USD", items: 2 });
```

## What it sends, and what it never does

- For page requests that look automated (a bot user agent, or none of a browser's headers), one small event: path, method, status, user agent, a few request headers, and a one-way daily-rotating hash that groups one crawler's requests. Requests from people are filtered out on your server and never sent.
- The client address only for requests whose user agent names a bot (Parlox checks the claim against the vendor's published ranges and discards it), and only from a header a proxy you control sets: `x-real-ip` on Vercel automatically, otherwise the header named in `PARLOX_IP_HEADER` (Cloudflare: `cf-connecting-ip`). Without it, no address is sent. It never reads `X-Forwarded-For` as the client sent it and never changes your framework's proxy-trust settings.
- Reports run after the response, in the background (`waitUntil` where the platform has it), and give up after two seconds. They never delay or fail a response and never throw; pass `onError` to see failures.
- No runtime dependencies. Node 20+, edge runtimes, Workers, Deno, Bun.

| Option | Default |
|---|---|
| `secretKey` | `process.env.PARLOX_SECRET_KEY` |
| `verifyToken` | `process.env.PARLOX_VERIFY_TOKEN` |
| `ipHeader` | `process.env.PARLOX_IP_HEADER`, else `x-real-ip` on Vercel, else none |
| `clientIp(req)` | your own source of the client address (overrides `ipHeader`) |
| `timeoutMs` | `2000` |
| `includeApi` | `false`: GET requests under `/api/` (monitors, cron jobs, internal fetches) are not reported |
| `runWrapped(pathname)` | Next.js only: which requests the wrapped middleware runs for (default: every request the matcher sends; it is never skipped) |
| `onError(err)` | ignored |

Install guide: https://gateway.parlox.io/install.md
