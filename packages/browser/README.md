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

- Counts page views and a summary of how the page was used (pointer movement, scrolling, clicks, time), and records what was clicked: tag, id, classes, link path, and the control's label and accessible name. Those two come from names the page's author gave the control (`aria-label`, `title`, `alt`, a field's `placeholder`) or from text, and text is read only from an element with at most 5 elements inside it and at most 2 lines (by line breaks or `<br>`): the control, or the element `aria-labelledby` points to. No other form field's `<label>` is read; a checkbox or radio has its own rule, given under 1.0.4 below. A control inside an area marked `data-plx-mask` or `data-plx-block` sends neither name. When a name is withheld by these rules, the click carries `aname_withheld: true` and no name. Emails, phone numbers and digit runs are masked, and each name is cut at 60 characters.
- Reads your GA4 `dataLayer` and your store's cart API responses (Shopify `/cart/add.js`, WooCommerce) for commerce events. Wrapped functions (`fetch`, `XMLHttpRequest.open`, `dataLayer.push`, `history.pushState`) keep their behaviour and return values.
- Never sets cookies. Never reads what visitors type (field names only). Sends a URL as its origin and path, with capability tokens (checkout, order, reset links) replaced and only campaign parameters (`utm_*`, `ref`, `gclid`, `fbclid`, `srsltid`) kept; reduces another site's referrer to its origin.
- Every listener and hook is wrapped: it cannot throw into your page. Safe to import during server-side rendering.
- For automated browsers only, it loads the recorder (a separate chunk your bundler builds; a person's browser never loads it). Recordings mask every input (hidden and file fields included) and every form value (the `value` of inputs, text areas, selects, options and buttons, whatever the field holds now; a submit, button or reset input's value is its label), and all text, including `title`, `alt`, `aria-label`, `placeholder`, `summary`, `abbr` and `download` attributes and `<meta>` content (the viewport's and `color-scheme`'s excepted), except the labels of buttons and simple links (at most 5 elements inside, 60 characters and 2 lines). Every address in a recording (the page's own, links, forms, images, stylesheets, and older address attributes such as `cite`) follows the URL rule above, except that files the replay draws (`src`, `srcset`, `poster`, and the `href` of a stylesheet, preload or icon link) keep the few query parameters that size or version them, listed under 1.0.4 below; an image or stylesheet that needs anything else in its query (a signed address, a map drawn from an address) does not load in the replay. `mailto:` and `tel:` links keep only the scheme. Left out: `ping` and `srcdoc` attributes; HTML comments; the `csrf-token` and checkout-token meta tags, and social (`og:`, `twitter:`) and `http-equiv` meta tags; the documents of same-origin frames, which rrweb would otherwise record even when blocked. Other attribute values are sent as the page has them: `data-*`, `id`, `class` and `name`, and addresses inside CSS (`style` attributes and stylesheets); mark markup that carries personal data in those `data-plx-block` to keep it on the page. Mark areas with `data-plx-unmask` (text may appear), `data-plx-mask` (mask a label too) or `data-plx-block` (leave out entirely); `data-plx-mask` and `data-plx-unmask` reach into the shadow roots inside them, as `data-plx-block` does.
- Sends data only to `https://gateway.parlox.io`. With a Content-Security-Policy, allow it in `connect-src`.

No build step? Use the pinned script tag from the Parlox dashboard instead: the same code, served as an immutable release with an integrity hash.

Install guide: https://gateway.parlox.io/install.md

## Changes

- 1.0.4: privacy fixes. The new fields on a click are `aname_withheld` and `aname_source`. The hosted tag of the same version has the same changes. Parlox's gateway, which stores what this package sends, applies the same address rule, and for names and recordings a rule that is the same or stricter.
  - Clicks: in 1.0.3 a click's accessible name was the element's whole text when it had no `aria-label`, however much was inside it, or the whole text of a form field's `<label>`, or of the element `aria-labelledby` points to, cut at 80 characters. Clicking a saved-address card, an account tile or a radio labelled with an address sent the name and address it showed, with only emails, phone numbers and digit runs masked; a control inside `data-plx-mask` sent its label. The label and accessible name now follow the rules above and below, and a click says when a name was withheld.
  - Recordings: 1.0.3 sent rrweb's events as rrweb made them. They held the page's full address, query included, with every full snapshot (a WooCommerce order key, a reset link's token); every address in the page as written (links, form actions, images, stylesheets, `cite`, `ping`, `mailto:` and `tel:` links); hidden inputs' values (CSRF and cart tokens), the file name in file inputs, and the `value` attribute of a field the server filled and the page emptied, and of radios, checkboxes, options and buttons; `title`, `alt`, `aria-label`, `placeholder` and `download` attributes as written; `<meta>` content (`og:url`, a refresh's address, tokens such as `_csrf`); HTML comments; the `csrf-token` and `shopify-checkout-api-token` meta tags; and the documents of same-origin frames, even blocked ones. 1.0.4 cleans each event before it is kept, as described above. An event that cannot be cleaned is dropped, and the recording stops there.
  - The query parameters a recorded file keeps (`src`, `srcset` candidates, `poster`, and the `href` of a link whose `rel` includes `stylesheet`, `preload` or `icon`). A parameter is kept only when its name is exactly one in the table and its decoded value matches, in the order it appears, encoded again with `encodeURIComponent`; everything else in the query is dropped. A `srcset` keeps its first 64 candidates. Links, form actions and the page's own address keep campaign parameters only (each value cut at 120 characters, an emoji counted as one).

    | Address | Parameter | Kept when the value is |
    |---|---|---|
    | Any file | `w`, `h`, `width`, `height`, `q`, `quality`, `dpr` | at least one digit, digits and at most one `.`, 5 characters at most |
    | Any file | `fit`, `format`, `fm`, `auto`, `crop` | letters, digits, `,` and `-`, 1 to 19 characters (20 letters and digits is a token's shape) |
    | Any file | `v`, `ver`, `version` | letters, digits, `.` and `-`, 1 to 19 characters (20 letters and digits is a token's shape) |
    | `/_next/image` on the page's own origin (this table instead of the first three rows) | `url` | a path on the same site (starts with one `/`, not `//` or `/\`), its path by the token rule and its query by the first three rows; or an `https://` address, kept as any file is |
    | | `w`, `q` | as above |
    | `fonts.googleapis.com` (this table instead of the first three rows) | `family` | letters, digits, spaces, `+`, `:`, `;`, `,`, `@` and `.`, 1 to 200 characters |
    | | `display` | letters, 1 to 10 characters |

    Every path keeps the token rule: segments shaped like a token become `:token`. `text` (Google Fonts) is never kept.

  - Clicks on a checkbox or radio: one name, from the first of its `aria-labelledby`, `aria-label`, `<label>` and `title` that it has (the browser's order).
    - That text is used when it is at most 24 characters after masking (emails, phone numbers and runs of 4 or more digits replaced, white space collapsed, ends trimmed) and contains no digit at all, a house number being in nearly every address, and, for `aria-labelledby` and the `<label>`, has at most 5 elements inside it and at most 2 lines. It is sent as both the label (`text`) and the accessible name (`aname`): "M", "XL", "Blue", "Charcoal Heather" and "Gift wrap" keep their names.
    - When that text fails, the input's own `value` attribute is used, when it is 1 to 24 characters of letters, digits, `-`, `_` and `.` only (no spaces) with no run of 20 or more letters and digits; runs of 4 or more digits are masked. It is sent as the accessible name only, with `aname_source: "value"`: the name is the input's value, not text the page shows, and is never to be presented as its label; `text` is empty. "Size 10" with `value="size-10"` is sent as `size-10`, an address with `value="addr_7"` as `addr_7`. The key is absent for every other name.
    - Otherwise neither is sent, and the click carries `aname_withheld: true` (an address with `value="gid://shopify/MailingAddress/123"`). A checkbox or radio with no name at all sends an empty name and no flag; its `value` is not used.
  - What 1.0.4 still sends, plainly:
    - A checkbox's or radio's label of at most 24 characters with no digit, such as a name: "Jane Doe".
    - The text of a button or link with at most 5 elements inside it and at most 2 lines, such as "Hi, Jane Doe", or a name and a street on two lines, with emails, phone numbers and runs of 4 or more digits masked; and the `aria-label` or `title` the page gives any control but a checkbox or radio, masked the same way.
    - In recordings: the same readable labels of buttons and simple links; `data-*`, `id`, `class` and `name` attribute values and addresses inside CSS, as the page has them.
