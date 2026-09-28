# Parlox Google Tag Manager template

For stores that manage scripts through Google Tag Manager. In GTM: **Templates → Tag Templates → New → ⋮ → Import**, choose `parlox.tpl`, save. Then **Tags → New → Parlox agent analytics**, enter the site's public key (`pk_…`, from the Parlox dashboard), set the trigger to **All Pages** (or to your consent trigger), and publish the container.

The template loads `https://gateway.parlox.io/sdk/parlox.js?key=<your key>`, the latest release of the hosted tag, which is built from [`packages/browser`](../packages/browser). Its permission allows scripts only from `https://gateway.parlox.io/sdk/`, and the key is validated (`pk_` plus letters and digits) and URL-encoded. Tick **Consent required** to keep Parlox off until your consent tool calls `parlox.consent(true)`.

Stores with a build step should install `@parlox/browser` from npm instead; stores without one can also paste the pinned script tag from the dashboard, which carries an integrity hash (GTM's script injection cannot pin a hash).
