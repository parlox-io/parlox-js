# Parlox SDKs

Parlox shows merchants which AI agents visit their store, what they read, where they get stuck and whether they buy. This repository holds the two packages merchants install. They are built, tested and published from here, and every published version carries an npm provenance attestation that links it to the commit and workflow run that produced it.

| Package | Runs | Install |
|---|---|---|
| [`@parlox/browser`](packages/browser) | On the store's pages: page views, behaviour, clicks, commerce events; replays of visits by automated browsers (people are never recorded) | `npm install @parlox/browser` |
| [`@parlox/server`](packages/server) | On the store's server (Next.js, Express, Hono, Workers): AI fetchers and crawlers that never run JavaScript, and confirmed orders | `npm install @parlox/server` |

Stores without a build step use the hosted tag instead, served by Parlox as immutable releases pinned with an integrity hash; it is built from `packages/browser` and ships inside the npm package under `dist/tag/`.

## Principles for code that runs on a merchant's site

- Never sets cookies; never reads what visitors type (field names only); strips capability tokens from URLs; reduces referrers to their origin.
- Every hook is wrapped so it cannot throw into the host page; wrapped platform functions keep their behaviour and return values.
- The server part never changes framework settings, reads a client address only from a header a proxy the merchant controls sets, and gives up after two seconds without delaying a response.
- Small, readable, no runtime dependencies except the recorder's (`@rrweb/record`, loaded only for automated browsers).

## Development

```bash
npm ci
npm test            # builds and tests both packages
npm run check-types # @arethetypeswrong/cli on both packages
```

Node 22.14 or later.

## Releasing

Bump `version` in the package's `package.json`, merge to `main`, then push a tag `browser-v<version>` or `server-v<version>`. The Release workflow builds and tests with a read-only token, and after a maintainer approves the `npm` environment, publishes that exact tarball through npm trusted publishing (no npm token exists). Versions are immutable: a change to what runs on merchants' pages always gets a new version.

## Security

See [SECURITY.md](SECURITY.md). MIT licensed.
