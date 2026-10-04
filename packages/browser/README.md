# @parlox/browser

Parlox agent analytics for storefronts: which AI agents visit, what they read, where they get stuck and whether they buy. This package is the browser part; [`@parlox/server`](https://www.npmjs.com/package/@parlox/server) is the server part.

```bash
npm install @parlox/browser
```

The easiest install is the wizard, run in your project: `npx parlox init` (Next.js, Vite React, Express and Hono). It adds the browser part (this package, or for Express and Hono the hosted tag built from it) and `@parlox/server`, showing every change first.

## React and Next.js

Render once, in the root layout (App Router or Pages Router). It renders nothing and starts after hydration.

```tsx
import { ParloxAnalytics } from "@parlox/browser/react";

<ParloxAnalytics publicKey="pk_..." />
```

## Anything else

```ts
import { init, track } from "@parlox/browser";

init({ publicKey: "pk_..." });
track("add_to_cart", { item_id: "sku-1", value: 49.9, currency: "USD", items: 1 });
```

| Option | Default | |
|---|---|---|
| `publicKey` | required | The site's public key from the Parlox dashboard. Safe in the browser. |
| `consent` | `"granted"` | `"required"`: nothing runs, is stored or is sent until `consent(true)`. |
| `recordAgents` | `true` | Record agent visits as a masked DOM replay. People are never recorded. |

`track(name, props)` takes GA4 ecommerce names (`view_item`, `add_to_cart`, `remove_from_cart`, `view_cart`, `begin_checkout`, `add_shipping_info`, `add_payment_info`, `purchase`, `search`) and only `item_id`, `value` (major units), `currency`, `items`, `order_id`, `step`. `consent(granted)` grants or withdraws. `sessionId()` returns the visit id to send with a checkout, so your server can post the confirmed order with `@parlox/server`.

## What it does on your page, and what it never does

- Counts page views and a summary of how the page was used (pointer movement, scrolling, clicks, time), and records what was clicked: a control's label (emails, phone numbers and digit runs masked), tag, id, classes, link path.
- Reads your GA4 `dataLayer` and your store's cart API responses (Shopify `/cart/add.js`, WooCommerce) for commerce events. Wrapped functions (`fetch`, `XMLHttpRequest.open`, `dataLayer.push`, `history.pushState`) keep their behaviour and return values.
- Never sets cookies. Never reads what visitors type (field names only). Strips capability tokens (checkout, order, reset links) from URLs and reduces the referrer to its origin.
- Every listener and hook is wrapped: it cannot throw into your page. Safe to import during server-side rendering.
- For automated browsers only, it loads the recorder (a separate chunk your bundler builds; a person's browser never loads it). Recordings mask every input and all text except button and link labels. Mark areas with `data-plx-unmask` (text may appear), `data-plx-mask` (mask a label too) or `data-plx-block` (leave out entirely).
- Sends data only to `https://gateway.parlox.io`. With a Content-Security-Policy, allow it in `connect-src`.

No build step? Use the pinned script tag from the Parlox dashboard instead: the same code, served as an immutable release with an integrity hash.

Install guide: https://gateway.parlox.io/install.md
