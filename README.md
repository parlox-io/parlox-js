# Parlox SDKs

Parlox shows merchants which AI agents visit their store, what they read, where they get stuck and whether they buy. This repository holds what merchants install: the two SDK packages and the install wizard that adds them. They are built, tested and published from here, and every published version carries an npm provenance attestation that links it to the commit and workflow run that produced it.

**Fastest install:** run `npx parlox init` in your project. The wizard covers Next.js, Vite React, Express and Hono, and a repo with a frontend and a backend; it shows every change as a diff before it writes anything ([`packages/wizard`](packages/wizard)). For any other stack, the install guide is at https://gateway.parlox.io/install.md.

| Package | Runs | Install |
|---|---|---|
| [`parlox`](packages/wizard) | On the developer's machine, once: signs in, picks the site, adds the browser part and the server part to each app with one confirmation, and connects the host | `npx parlox init` |
| [`@parlox/browser`](packages/browser) | On the store's pages: page views, behaviour, clicks, commerce events; replays of visits by automated browsers (people are never recorded) | `npm install @parlox/browser` |
| [`@parlox/server`](packages/server) | On the store's server (Next.js, Express, Hono, Workers): AI fetchers and crawlers that never run JavaScript, and confirmed orders | `npm install @parlox/server` |

Stores without a build step use the hosted tag instead, served by Parlox as immutable releases pinned with an integrity hash; it is built from `packages/browser` and ships inside the npm package under `dist/tag/`. Stores on Google Tag Manager can import the template in [`gtm-template/`](gtm-template).

## Principles for code that runs on a merchant's site

- Never sets cookies; never reads what visitors type (field names only); strips capability tokens from URLs; reduces referrers to their origin.
- Every hook is wrapped so it cannot throw into the host page; wrapped platform functions keep their behaviour and return values.
- The server part never changes framework settings, reads a client address only from a header a proxy the merchant controls sets, and never delays a response: its reports wait in a bounded queue sent one request at a time, or, where the platform keeps work alive after the response, go at once (at most 64 at a time, each giving up after two seconds).
- Small, readable, no runtime dependencies except the recorder's (`@rrweb/record`, loaded only for automated browsers).

## Development

```bash
npm ci
npm test            # builds and tests the three packages
npm run check-types # @arethetypeswrong/cli on the two SDK packages
```

Node 22.14 or later.

## Releasing

Bump `version` in the package's `package.json`, merge to `main`, then push a tag `browser-v<version>`, `server-v<version>` or `parlox-v<version>` (the wizard). The Release workflow builds and tests with a read-only token, and after a maintainer approves the `npm` environment, publishes that exact tarball through npm trusted publishing (no npm token exists). The wizard's release is staged rather than published: a maintainer then approves it on npmjs.com (the package's Staged Packages, with two-factor authentication). Versions are immutable: a change to what runs on merchants' pages always gets a new version.

## Security

See [SECURITY.md](SECURITY.md). MIT licensed.
