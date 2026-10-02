import { test } from "node:test";
import assert from "node:assert/strict";
import { detectHost } from "../dist/hosts.js";
import { express } from "../dist/integrations/express.js";
import { hono } from "../dist/integrations/hono.js";
import { fixture } from "./helpers.mjs";

// On a server that keeps running between requests, @parlox/server queues reports, and a stop on a signal loses what
// waits unless the app flushes it in its shutdown code (the SDK installs no signal handlers). The report for an Express
// or Hono server part there says so in one line, pointing to the snippet in @parlox/server's README.

const README = "https://github.com/parlox-io/parlox-js/tree/main/packages/server#shutdown-long-running-servers";
const role = { browser: false, server: true, unitHasBrowser: true };
const SERVER = "import express from 'express'\nconst app = express()\napp.listen(3000)\n";
const HONO_NODE = "import { serve } from '@hono/node-server'\nimport { Hono } from 'hono'\nconst app = new Hono()\nserve({ fetch: app.fetch, port: 3000 })\n";
const HONO_WORKER = "import { Hono } from 'hono'\nconst app = new Hono()\nexport default app\n";
const expressApp = (extra) => fixture({ "package.json": JSON.stringify({ name: "shop", type: "module", scripts: { start: "node server.js" }, dependencies: { express: "^5.1.0" } }), "package-lock.json": "{}", "server.js": SERVER, ...extra });
const honoApp = (extra, deps = { hono: "^4.13.11", "@hono/node-server": "^2.1.3" }, code = HONO_NODE) => fixture({ "package.json": JSON.stringify({ name: "shop", type: "module", scripts: { dev: "tsx watch src/index.ts" }, dependencies: deps }), "package-lock.json": "{}", "src/index.ts": code, ...extra });
const notes = (integration, dir) => integration.hostNotes(integration.detect(dir, dir), detectHost(dir, dir), role);
const shutdownLines = (lines) => lines.filter((l) => l.includes(README));

test("Express and Hono on a long-running host: one report line points to the shutdown snippet", () => {
  for (const [file, where] of [["fly.toml", "on Fly.io"], ["render.yaml", "on Render"], ["railway.json", "on Railway"], ["Dockerfile", "in a Docker container"]]) {
    for (const [label, integration, dir] of [["Express", express, expressApp({ [file]: "" })], ["Hono", hono, honoApp({ [file]: "" })]]) {
      const lines = shutdownLines(notes(integration, dir));
      assert.equal(lines.length, 1, `${label} ${file}: ${notes(integration, dir).join("\n")}`);
      assert.ok(lines[0].startsWith(`This server keeps running between requests ${where}`), `${label} ${file}: ${lines[0]}`);
      assert.match(lines[0], /await parlox\.flush\(\)/, `${label} ${file}`);
    }
  }
});

test("no line on Vercel, Netlify or Cloudflare, nor where no host file says where the server runs", () => {
  for (const [label, integration, dir] of [
    ["Express, host not detected", express, expressApp({})],
    ["Hono on Node.js, host not detected", hono, honoApp({})],
    ["Express on Vercel", express, expressApp({ ".vercel/project.json": "{}" })],
    ["Express on Netlify", express, expressApp({ "netlify.toml": "" })],
    ["Express on wrangler", express, expressApp({ "wrangler.toml": 'name = "shop"\nmain = "server.js"\n' })],
    ["Hono on Workers", hono, honoApp({ "wrangler.toml": 'name = "shop"\nmain = "src/index.ts"\n' }, { hono: "^4.13.11" }, HONO_WORKER)],
    ["Hono on Vercel", hono, honoApp({ "vercel.json": "{}" }, { hono: "^4.13.11" }, HONO_WORKER)],
    ["Hono on AWS Lambda", hono, honoApp({}, { hono: "^4.13.11", "@hono/aws-lambda": "^1.0.0" }, HONO_WORKER)],
  ]) assert.deepEqual(shutdownLines(notes(integration, dir)), [], label);
});
