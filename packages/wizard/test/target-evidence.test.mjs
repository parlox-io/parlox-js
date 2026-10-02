import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { scanApps, unitHost } from "../dist/apps.js";
import { detectHost, otherHostFile } from "../dist/hosts.js";
import { express } from "../dist/integrations/express.js";
import { hono } from "../dist/integrations/hono.js";
import { fixture } from "./helpers.mjs";

// What a Hono app with wrangler's config runs on, and the host the report names, follow every sign the files give: Hono's
// AWS Lambda adapter names Lambda before wrangler's config can name Workers; the packages of other platforms
// (@vercel/node, the vercel CLI, @netlify/functions, serverless-http) and other hosts' files (now.json, serverless.yml,
// app.yaml, a netlify/ folder) say it is not a Worker. These choose notes and hand-offs only: a Vite build is checked on
// every host.

const RUNTIME_SECRET = "Add PARLOX_SECRET_KEY as a runtime secret under Settings → Variables & Secrets, not as a build variable.";
const CLOUDFLARE_NOTE = "On Cloudflare the adapter reads PARLOX_SECRET_KEY and PARLOX_VERIFY_TOKEN from the Worker's variables (c.env).";
const CDN_NOTE = "Pages a CDN serves from its cache never reach this server, so those crawler visits are not seen.";
const LAMBDA_NOTE = /^On AWS Lambda each report is sent on its own, never queued/;
const BASIC = "import { Hono } from 'hono'\nconst app = new Hono()\napp.get('/', (c) => c.text('hi'))\nexport default app\n";
const LAMBDA = "import { Hono } from 'hono'\nimport { handle } from '@hono/aws-lambda'\nconst app = new Hono()\napp.get('/', (c) => c.text('hi'))\nexport const handler = handle(app)\n";
const WRANGLER = 'name = "shop"\nmain = "src/index.ts"\ncompatibility_date = "2025-01-01"\n';
/** A Hono app with wrangler's config and no Vite build, so the server part is planned and its notes are said. */
const app = ({ deps = {}, dev = {}, code = BASIC, extra = {} } = {}) => fixture({
  "package.json": JSON.stringify({ name: "shop", type: "module", scripts: { dev: "wrangler dev" }, dependencies: { hono: "^4.13.12", ...deps }, devDependencies: { wrangler: "^4.110.0", ...dev } }),
  "package-lock.json": "{}", "wrangler.toml": WRANGLER, "src/index.ts": code, ...extra,
});
const role = { browser: false, server: true, unitHasBrowser: false };
const unitOf = (dir) => { const [u] = scanApps(dir).units; assert.ok(u?.server, `no server part in ${dir}`); return u; };
/** The target, the host the run names, and the report's notes on that host. */
const read = (dir) => {
  const u = unitOf(dir);
  const host = unitHost(u);
  return { u, target: u.server.data.target, host: host.id, notes: hono.hostNotes(u.server, host, role), handoff: hono.handoffNotes(u.server, host) };
};
const notWorkers = (r, label) => {
  assert.equal(r.notes.includes(CLOUDFLARE_NOTE), false, `${label}: ${r.notes.join("\n")}`);
  assert.equal(r.notes.includes(RUNTIME_SECRET), false, `${label}: ${r.notes.join("\n")}`);
  assert.deepEqual(r.handoff, [], label);
  assert.ok(r.notes.includes(CDN_NOTE), `${label}: a cache can sit in front off Workers`);
  assert.notEqual(r.host, "cloudflare", label);
};

test("Hono's AWS Lambda adapter beside wrangler's config names AWS Lambda, declared or only imported: its notes, never the Workers ones", () => {
  for (const [label, shape] of [
    ["@hono/aws-lambda declared and imported", { deps: { "@hono/aws-lambda": "^1.0.0" }, code: LAMBDA }],
    ["@hono/aws-lambda declared only", { deps: { "@hono/aws-lambda": "^1.0.0" } }],
    ["@hono/aws-lambda imported only (hoisted)", { code: LAMBDA }],
    ["hono/aws-lambda imported", { code: LAMBDA.replace("'@hono/aws-lambda'", "'hono/aws-lambda'") }],
  ]) {
    const r = read(app(shape));
    assert.equal(r.target, "aws-lambda", label);
    assert.ok(r.notes.some((l) => LAMBDA_NOTE.test(l)), `${label}: ${r.notes.join("\n")}`);
    assert.deepEqual(r.u.server.localCheck, { skip: "an AWS Lambda function has no local server to check" }, label);
    assert.ok(r.u.server.facts[0][1].includes("AWS Lambda"), label);
    notWorkers(r, label);
  }
});

test("@vercel/node and the vercel CLI beside wrangler's config name Vercel; @netlify/functions and serverless-http name no runtime the wizard has notes for", () => {
  for (const [label, shape, target] of [
    ["@vercel/node", { deps: { "@vercel/node": "^5.3.0" } }, "vercel"],
    ["vercel as a devDependency", { dev: { vercel: "^48.0.0" } }, "vercel"],
    ["@netlify/functions", { deps: { "@netlify/functions": "^4.2.0" } }, "unknown"],
    ["serverless-http", { deps: { "serverless-http": "^3.2.0" } }, "unknown"],
    ["@vercel/node imported only", { code: `import type { VercelRequest } from '@vercel/node'\n${BASIC}` }, "vercel"],
    ["serverless-http imported only", { code: `import serverless from 'serverless-http'\n${BASIC}export const handler = serverless(app)\n` }, "unknown"],
  ]) {
    const r = read(app(shape));
    assert.equal(r.target, target, label);
    if (target === "vercel") assert.deepEqual(r.u.server.localCheck, { skip: "check it after you deploy" }, label);
    else assert.notDeepEqual(r.u.server.localCheck, { skip: "the wizard does not write the Worker's local variables; check it after you deploy" }, label);
    notWorkers(r, label);
  }
});

test("now.json, serverless.yml, serverless.yaml, app.yaml and a netlify/ folder are other hosts' files: beside wrangler's config, or above it, Cloudflare is not the host and the target is not Workers", () => {
  for (const [file, content, host, target] of [
    ["now.json", "{}", "vercel", "vercel"],
    ["serverless.yml", "service: shop\n", "unknown", "unknown"],
    ["serverless.yaml", "service: shop\n", "unknown", "unknown"],
    ["app.yaml", "runtime: nodejs22\n", "unknown", "unknown"],
    ["netlify/functions/api.ts", "export default async () => new Response('hi')\n", "netlify", "unknown"],
  ]) {
    const name = file.split("/")[0];
    const dir = app({ extra: { [file]: content } });
    assert.deepEqual(otherHostFile(dir, dir), { path: name, host }, file);
    assert.notEqual(detectHost(dir, dir).id, "cloudflare", file);
    const r = read(dir);
    assert.equal(r.target, target, file);
    notWorkers(r, file);
    // At the root of a monorepo, above the app.
    const root = fixture({ "package.json": JSON.stringify({ name: "mono", private: true, workspaces: ["apps/*"] }), "package-lock.json": "{}", [file]: content, "apps/api/package.json": JSON.stringify({ name: "api", type: "module", dependencies: { hono: "^4.13.12" }, devDependencies: { wrangler: "^4.110.0" } }), "apps/api/wrangler.toml": WRANGLER, "apps/api/src/index.ts": BASIC });
    assert.deepEqual(otherHostFile(join(root, "apps", "api"), root), { path: `../../${name}`, host }, `${file} at the root`);
    // Express under wrangler beside it is a Node server, with its .env.
    const exp = fixture({ "package.json": JSON.stringify({ name: "shop", type: "module", main: "server.js", scripts: { start: "node server.js" }, dependencies: { express: "^5.1.0", dotenv: "^16.4.0" } }), "package-lock.json": "{}", "wrangler.toml": 'name = "shop"\nmain = "server.js"\n', "server.js": "import 'dotenv/config'\nimport express from 'express'\nconst app = express()\napp.listen(3000)\n", [file]: content });
    assert.equal(express.detect(exp, exp).data.worker, false, `${file}: Express`);
  }
  // Names that only look like them are not.
  for (const file of ["now.json.bak", "serverless.yml.md", "app.yml", "netlify.md"]) {
    const dir = fixture({ "wrangler.toml": WRANGLER, [file]: "" });
    assert.equal(otherHostFile(dir, dir), null, file);
  }
});

// ---- A Vite React app with a leftover wrangler config ----

test("a Vite React app with wrangler's config beside vercel.json deploys on Vercel: the Vercel middleware is its server part; with wrangler's config alone, Cloudflare and the ownership file", () => {
  const site = (extra) => fixture({
    "package.json": JSON.stringify({ name: "shop", type: "module", scripts: { dev: "vite", build: "vite build" }, dependencies: { react: "^19.2.0", "react-dom": "^19.2.0" }, devDependencies: { vite: "^8.1.4", "@vitejs/plugin-react": "^6.1.1" } }),
    "package-lock.json": "{}",
    "index.html": '<!doctype html>\n<html>\n  <head><title>Shop</title></head>\n  <body>\n    <div id="root"></div>\n    <script type="module" src="/src/main.tsx"></script>\n  </body>\n</html>\n',
    "src/main.tsx": "import { createRoot } from 'react-dom/client'\nimport App from './App'\n\ncreateRoot(document.getElementById('root')!).render(<App />)\n",
    "src/App.tsx": "export default function App() {\n  return <h1>Shop</h1>\n}\n",
    "vite.config.ts": "import { defineConfig } from 'vite'\nimport react from '@vitejs/plugin-react'\n\nexport default defineConfig({\n  plugins: [react()],\n})\n",
    "wrangler.toml": 'name = "shop"\ncompatibility_date = "2025-01-01"\n\n[assets]\ndirectory = "./dist"\n',
    ...extra,
  });
  const onVercel = scanApps(site({ "vercel.json": "{}" })).units[0];
  assert.equal(onVercel.server?.parts.server?.kind, "vercel-edge", onVercel.warnings.join("\n"));
  assert.equal(unitHost(onVercel).id, "vercel");
  assert.equal(detectHost(onVercel.dir, onVercel.root).id, "vercel");
  const onCloudflare = scanApps(site({})).units[0];
  assert.equal(onCloudflare.server?.parts.server?.kind, "verify-file");
  assert.equal(unitHost(onCloudflare).id, "cloudflare");
});
