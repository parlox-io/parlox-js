// The SDK versions this wizard release was tested with. Installed exactly (no ^), so a later SDK release never
// arrives in a merchant's app through the wizard without a new, tested wizard release. A later version the app's
// package.json already declares is kept, never replaced by these (pins.ts).
export const BROWSER_VERSION = "1.0.3";
export const SERVER_VERSION = "1.2.0";
// Vercel's own package, for `next()` in the Routing Middleware the wizard writes for static sites on Vercel. Added only
// when the project does not already have it (then its own version is kept), and never removed by uninstall (the
// project may use it for more). 3.9.9 is the version the wizard was tested with.
export const VERCEL_FUNCTIONS_VERSION = "3.9.9";
// The pinned tag the dashboard's install panel gives for release 1.0.3 (the release BROWSER_VERSION installs), for pages
// the wizard edits directly: Express views and static HTML, Hono layouts. The browser runs exactly this file or nothing
// (Subresource Integrity). Pinned here with the wizard release and never fetched at run time; the e2e job checks the
// hash against the served file.
export const TAG_VERSION = "1.0.3";
export const TAG_URL = `https://gateway.parlox.io/sdk/${TAG_VERSION}/parlox.js`;
export const TAG_INTEGRITY = "sha384-naJsIFbLpeBsYg6qCN51Tt54BEFhO4MDhTMmrGP4Ja/nXjrfUziCot/3mHbhqCb+";
