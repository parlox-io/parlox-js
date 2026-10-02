import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { hostStepFor, scanApps } from "../dist/apps.js";
import { handoffOf } from "../dist/host-step.js";
import { detectHost } from "../dist/hosts.js";
import { integrationOf } from "../dist/integrations/registry.js";
import { runNames } from "../dist/names.js";
import { handoffLines } from "../dist/ui/handoff.js";
import { fixture, read } from "./helpers.mjs";

// A Vite build in or under an app's folder is checked by the same guard on every host, Cloudflare Workers included:
// that an app deploys only as a Worker, where the key is a runtime secret the build does not see, cannot be read from
// its files (Workers Builds and other Git-connected hosts leave none). On Workers the hand-off still says where the key
// goes: a runtime secret, not a build variable. The Vite configurations below are shapes the guard reads; none is
// ever built.

const RUNTIME_SECRET = "Add PARLOX_SECRET_KEY as a runtime secret under Settings → Variables & Secrets, not as a build variable.";
const BASIC = "import { Hono } from 'hono'\n\nconst app = new Hono()\n\napp.get('/', (c) => c.text('Hello Hono!'))\n\nexport default app\n";
const WRANGLER = '{\n  "name": "shop",\n  "main": "src/index.ts",\n  "compatibility_date": "2025-08-03"\n}\n';
const SAFE_REACT = "import { defineConfig } from 'vite'\nimport react from '@vitejs/plugin-react'\n\nexport default defineConfig({\n  plugins: [react()],\n})\n";
// loadEnv with the "" prefix, under define: the build's whole environment in the browser code.
const COPY_ALL = "import { defineConfig, loadEnv } from 'vite'\n\nexport default defineConfig(({ mode }) => {\n  const env = loadEnv(mode, process.cwd(), '')\n  return { define: { 'process.env': env } }\n})\n";

/** A Hono app on Workers (wrangler's config only, no other host or runtime), with `vite` its Vite config or none. */
const workers = (vite = null, extra = {}) => fixture({
  "package.json": JSON.stringify({
    name: "shop", type: "module",
    scripts: vite ? { dev: "wrangler dev", build: "vite build", deploy: "wrangler deploy" } : { dev: "wrangler dev", deploy: "wrangler deploy --minify" },
    dependencies: { hono: "^4.13.12" },
    devDependencies: { wrangler: "^4.110.0", ...(vite ? { vite: "^8.1.4", "@vitejs/plugin-react": "^6.1.1" } : {}) },
  }),
  "package-lock.json": "{}", "wrangler.jsonc": WRANGLER, "src/index.ts": BASIC, ...(vite ? { "vite.config.ts": vite } : {}), ...extra,
});
const unitOf = (dir) => { const [u] = scanApps(dir).units; assert.ok(u, `no app in ${dir}`); return u; };
/** What the report and the hand-off say for the app's server part, on the host the run detects. */
const said = (u) => {
  const host = detectHost(u.dir, u.root);
  const report = integrationOf(u.server).hostNotes(u.server, host, { browser: false, server: true, unitHasBrowser: !!u.browser });
  const handoff = handoffLines(handoffOf({ dashboard: "https://app.parlox.io", siteId: "s", verifyToken: "vt", names: runNames([u], u.dir) }, u, host, { secretDone: false, tokenDone: false, finished: false }));
  return { host, report, handoff };
};

test("plain Workers with no Vite build: unchanged, the server part is planned and the report and the hand-off say the key is a runtime secret", () => {
  const u = unitOf(workers());
  assert.equal(u.server?.integration, "hono", u.warnings.join("\n"));
  assert.equal(u.withheld, null);
  assert.deepEqual(u.warnings, []);
  const { host, report, handoff } = said(u);
  assert.equal(host.id, "cloudflare");
  assert.equal(hostStepFor(u, host), true);
  assert.ok(report.includes(RUNTIME_SECRET), report.join("\n"));
  assert.ok(handoff.includes(RUNTIME_SECRET), handoff.join("\n"));
});

test("Workers with a safe Vite config (plugin-react, the default envPrefix): the Vite build is checked, and the server part is planned", () => {
  const u = unitOf(workers(SAFE_REACT));
  assert.equal(u.server?.integration, "hono", u.warnings.join("\n"));
  assert.equal(u.withheld, null);
  // The guard read the build: the note on what it could not see (the host's dashboard), and the key already set on the
  // host is one to check (cli.ts).
  assert.equal(u.viteBeside, true, "the Vite build was checked");
  assert.match(u.warnings[0] ?? "", /^Hono: the wizard read the build commands in package\.json, vercel\.json and netlify\.toml/);
  const { host, handoff } = said(u);
  assert.equal(hostStepFor(u, host), true);
  assert.ok(handoff.includes(RUNTIME_SECRET), "where the key goes on Workers: " + handoff.join("\n"));
});

test("Workers with the copy-everything Vite config (loadEnv with '' under define): withheld, as on every other host", () => {
  const u = unitOf(workers(COPY_ALL));
  assert.equal(u.server, null, u.warnings.join("\n"));
  assert.equal(u.withheld?.detection.integration, "hono");
  assert.equal(u.withheld.detection.data.target, "cloudflare-workers", "the target is still Workers: only the check changed");
  assert.match(u.withheld.exposure.why, /passes environment values to the browser code through define/);
  assert.match(u.warnings[0] ?? "", /^Hono: no server part was added\. /);
  assert.equal(hostStepFor(u, detectHost(u.dir, u.root)), false);
});

test("a Vite app below the Worker's folder is checked the same way", () => {
  const dir = workers(null, { "client/package.json": JSON.stringify({ name: "client", scripts: { build: "vite build" }, devDependencies: { vite: "^8.1.4" } }), "client/vite.config.ts": COPY_ALL });
  const u = unitOf(dir);
  assert.equal(u.server, null, u.warnings.join("\n"));
  assert.match(u.warnings[0] ?? "", /^Hono: no server part was added\. In client\/: /);
});

test("on Workers a Vite config the guard does not vouch for withholds the key, though it names no PARLOX variable", () => {
  const u = unitOf(workers("import { defineConfig, mergeConfig } from 'vite'\nimport base from './base'\nexport default mergeConfig(base, { define: { 'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV) } })\n"));
  assert.equal(u.server, null, u.warnings.join("\n"));
  assert.match(u.warnings[0] ?? "", /^Hono: no server part was added\. /);
});

test("the earlier leftover-wrangler shapes stay withheld beside the copy-everything config: another host's file, another runtime", () => {
  for (const [label, extra, deps] of [
    ["vercel.json", { "vercel.json": "{}" }, {}],
    ["netlify.toml", { "netlify.toml": "" }, {}],
    ["fly.toml", { "fly.toml": "" }, {}],
    ["a Procfile", { Procfile: "web: node dist/index.js\n" }, {}],
    ["a Dockerfile", { Dockerfile: "FROM node:22\n" }, {}],
    ["@hono/node-server", { "src/index.ts": "import { serve } from '@hono/node-server'\nimport { Hono } from 'hono'\nconst app = new Hono()\nserve({ fetch: app.fetch, port: 3000 })\n" }, { "@hono/node-server": "^2.1.3" }],
    ["Bun.serve", { "src/serve.ts": "import app from './index'\nBun.serve({ fetch: app.fetch })\n" }, {}],
    ["hono/vercel", { "src/index.ts": "import { Hono } from 'hono'\nimport { handle } from 'hono/vercel'\nconst app = new Hono()\nexport default handle(app)\n" }, {}],
  ]) {
    const dir = workers(COPY_ALL, extra);
    if (Object.keys(deps).length) {
      const p = JSON.parse(read(dir, "package.json"));
      writeFileSync(join(dir, "package.json"), JSON.stringify({ ...p, dependencies: { ...p.dependencies, ...deps } }));
    }
    const u = unitOf(dir);
    assert.equal(u.server, null, `${label}: ${u.warnings.join("\n")}`);
    assert.match(u.warnings[0] ?? "", /^Hono: no server part was added\. /, label);
  }
});


test("the README says the Vite check runs on every host, Cloudflare Workers included, and where the key goes on Workers", () => {
  const readme = readFileSync(fileURLToPath(new URL("../README.md", import.meta.url)), "utf8").replace(/\s+/g, " ");
  assert.ok(readme.includes("The same check runs on every host, Cloudflare Workers included: whether an app deploys only as a Worker, whose runtime secrets the build does not see, cannot be read from its files"), "the guard paragraph");
  assert.ok(readme.includes("add the key as a runtime secret (Settings → Variables & Secrets), not as a build variable"));
  assert.equal(readme.includes("only a Vite config that names Parlox itself holds it back"), false, "no Workers exemption");
});
