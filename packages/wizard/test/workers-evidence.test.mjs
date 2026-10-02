import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { hostStepFor, scanApps } from "../dist/apps.js";
import { main } from "../dist/cli.js";
import { WORKER_LOCAL_SKIP } from "../dist/envfiles.js";
import { detectHost, onlyCloudflare, otherHostFile } from "../dist/hosts.js";
import { express } from "../dist/integrations/express.js";
import { integrationOf } from "../dist/integrations/registry.js";
import { HANDOFF_TITLE } from "../dist/ui/handoff.js";
import { startFakeAuth, startFakeGateway } from "./fake-servers.mjs";
import { fixture } from "./helpers.mjs";

// Cloudflare counts only when nothing contradicts it: the cloudflare-workers target, the host the run names and the
// Workers notes all follow the same evidence. Where another runtime (Bun, Deno, srvx) or another host's file says
// otherwise, that evidence decides; where nothing decides, the result is unknown. A Vite build beside the app is checked
// whatever the evidence says. The Vite configurations below are shapes the guard reads; none is ever built.

const RUNTIME_SECRET = "Add PARLOX_SECRET_KEY as a runtime secret under Settings → Variables & Secrets, not as a build variable.";
// create-hono's basic app (its bun and cloudflare-workers templates both end in `export default app`).
const BASIC = "import { Hono } from 'hono'\n\nconst app = new Hono()\n\napp.get('/', (c) => {\n  return c.text('Hello Hono!')\n})\n\nexport default app\n";
const NODE = "import { serve } from '@hono/node-server'\nimport { Hono } from 'hono'\nconst app = new Hono()\napp.get('/', (c) => c.text('hi'))\nserve({ fetch: app.fetch, port: 3000 })\n";
// loadEnv with the "" prefix, under define: the build's whole environment in the browser code.
const ALL_ENV = "import { defineConfig, loadEnv } from 'vite'\nexport default defineConfig(({ mode }) => {\n  const env = loadEnv(mode, process.cwd(), '')\n  return { define: { 'process.env': env } }\n})\n";
const WRANGLER = 'name = "shop"\nmain = "src/index.ts"\ncompatibility_date = "2025-01-01"\n';

/** A Hono app with wrangler's config and a Vite build beside it. */
const app = ({ deps = {}, dev = {}, scripts = {}, code = BASIC, lock = { "package-lock.json": "{}" }, extra = {} } = {}) => ({
  "package.json": JSON.stringify({ name: "shop", type: "module", scripts: { dev: "wrangler dev", build: "vite build", ...scripts }, dependencies: { hono: "^4.13.11", ...deps }, devDependencies: { vite: "^8.1.4", wrangler: "^4.110.0", ...dev } }),
  ...lock, "wrangler.toml": WRANGLER, "src/index.ts": code, "vite.config.ts": ALL_ENV, ...extra,
});
const unitOf = (dir) => { const [u] = scanApps(dir).units; assert.ok(u, `no app in ${dir}`); return u; };
const target = (u) => (u.server ?? u.withheld.detection).data.target;
const withheld = (u, label) => {
  assert.equal(u.server, null, `${label}: ${u.warnings.join("\n")}`);
  assert.match(u.withheld?.exposure.why ?? "", /passes environment values to the browser code through define/, label);
  assert.match(u.warnings[0] ?? "", /^Hono: no server part was added\. /, label);
  assert.equal(integrationOf(u.withheld.detection).handoffNotes(u.withheld.detection, detectHost(u.dir, u.root)).includes(RUNTIME_SECRET), false, label);
};

// ---- Bun, Deno and srvx are evidence against Workers ----

test("create-hono's Bun template beside wrangler.toml, with bun.lock and a Procfile: the Bun target, the Vite build checked, the server part withheld", () => {
  // The template's package.json and app (`bun run --hot`, @types/bun, `export default app`), with Vite to build.
  const bun = { scripts: { dev: "bun run --hot src/index.ts" }, dev: { "@types/bun": "latest" }, lock: { "bun.lock": "{}" } };
  const u = unitOf(fixture(app({ ...bun, extra: { Procfile: "web: bun src/index.ts\n" } })));
  withheld(u, "Bun template, bun.lock, Procfile");
  assert.equal(target(u), "bun");
  assert.equal(u.withheld.detection.packageManager, "bun");
  // The Bun evidence alone, with no other host's file: the same.
  const alone = unitOf(fixture(app(bun)));
  withheld(alone, "Bun template, no other host's file");
  assert.equal(target(alone), "bun");
});

test("each sign of Bun beside wrangler makes the target Bun: bun-types, a start script that runs bun, Bun.serve( in the app file or in any other source file", () => {
  for (const [label, shape] of [
    ["bun-types", { dev: { "bun-types": "latest" } }],
    ["start: bun src/index.ts", { scripts: { start: "bun src/index.ts" } }],
    ["Bun.serve in the app file", { code: "import { Hono } from 'hono'\nconst app = new Hono()\nBun.serve({ fetch: app.fetch })\n" }],
    ["Bun.serve in another file", { extra: { "src/serve.ts": "import app from './index'\nBun.serve({ fetch: app.fetch, port: 3000 })\n" } }],
    ["globalThis.Bun.serve", { extra: { "src/serve.ts": "import app from './index'\nglobalThis.Bun.serve({ fetch: app.fetch })\n" } }],
    ["Bun.serve in a file that does not parse", { extra: { "src/serve.ts": "import app from './index'\nBun.serve({ fetch: app.fetch \n" } }],
  ]) {
    const u = unitOf(fixture(app(shape)));
    withheld(u, label);
    assert.equal(target(u), "bun", label);
  }
});

test("Deno.serve( beside wrangler, with no deno.json: Hono on Deno, declined as Deno is today", () => {
  for (const [label, files] of [
    ["the app file", app({ code: "import { Hono } from 'hono'\nconst app = new Hono()\nDeno.serve(app.fetch)\n" })],
    ["another file", app({ extra: { "src/main.ts": "import app from './index.ts'\nDeno.serve({ port: 8000 }, app.fetch)\n" } })],
  ]) {
    const scan = scanApps(fixture(files));
    assert.equal(scan.units.length, 0, label);
    assert.match(scan.problems[0]?.error.message ?? "", /^Hono on Deno is not covered by the wizard yet/, label);
  }
});

test("srvx beside wrangler (declared, or imported): the runtime is not known, so the Vite build is checked and the server part withheld", () => {
  for (const [label, shape] of [
    ["serve() from srvx", { deps: { srvx: "^0.8.7" }, code: "import { Hono } from 'hono'\nimport { serve } from 'srvx'\nconst app = new Hono()\nserve({ fetch: app.fetch })\n" }],
    ["declared only", { deps: { srvx: "^0.8.7" } }],
    ["imported only", { extra: { "src/serve.ts": "import { serve } from 'srvx'\nimport app from './index'\nserve({ fetch: app.fetch })\n" } }],
  ]) {
    const u = unitOf(fixture(app(shape)));
    withheld(u, label);
    assert.equal(target(u), "unknown", label);
  }
});

test("plain Workers (wrangler's config only, no other runtime): the Workers target and host; the copy-everything Vite build is withheld as on any host, and without it both the report and the hand-off say the key is a runtime secret", () => {
  const exposed = unitOf(fixture(app()));
  assert.equal(exposed.server, null, exposed.warnings.join("\n"));
  assert.equal(exposed.withheld.detection.data.target, "cloudflare-workers");
  assert.equal(detectHost(exposed.dir, exposed.root).id, "cloudflare");
  const files = app();
  delete files["vite.config.ts"];
  const u = unitOf(fixture({ ...files, "package.json": JSON.stringify({ name: "shop", type: "module", scripts: { dev: "wrangler dev" }, dependencies: { hono: "^4.13.11" }, devDependencies: { wrangler: "^4.110.0" } }) }));
  assert.equal(u.server?.integration, "hono", u.warnings.join("\n"));
  assert.equal(u.withheld, null);
  assert.equal(u.server.data.target, "cloudflare-workers");
  const host = detectHost(u.dir, u.root);
  assert.equal(host.id, "cloudflare");
  assert.ok(integrationOf(u.server).hostNotes(u.server, host, { browser: false, server: true, unitHasBrowser: false }).includes(RUNTIME_SECRET));
  assert.deepEqual(integrationOf(u.server).handoffNotes(u.server, host), [RUNTIME_SECRET]);
  assert.equal(hostStepFor(u, host), true);
});

// ---- The host follows the same evidence ----

const mono = (rootFiles, appFiles) => fixture({
  "package.json": JSON.stringify({ name: "mono", private: true, workspaces: ["apps/*"] }), "package-lock.json": "{}", ...rootFiles,
  ...Object.fromEntries(Object.entries(appFiles).filter(([f]) => f !== "package-lock.json").map(([f, c]) => [`apps/api/${f}`, c])),
});
const VERCEL_LINK = JSON.stringify({ projectId: "prj_1", orgId: "team_1", projectName: "shop" });

test("beside another host's file or link, wrangler's config (not Pages) does not make Cloudflare the host: the other host's file decides, else the host is not detected", () => {
  const one = (files) => { const d = fixture({ "wrangler.toml": WRANGLER, ...files }); return detectHost(d, d); };
  assert.equal(one({}).id, "cloudflare", "wrangler's config alone");
  assert.equal(one({ "vercel.json": "{}" }).id, "vercel");
  assert.equal(one({ "render.yaml": "" }).id, "render");
  assert.equal(one({ "railway.toml": "" }).id, "railway");
  assert.equal(one({ Dockerfile: "FROM node" }).id, "docker");
  assert.equal(one({ Procfile: "web: node server.js\n" }).id, "unknown");
  // A Pages config: Pages is Cloudflare whatever else is beside it (its target is Cloudflare Pages too).
  const pages = fixture({ "wrangler.toml": 'name = "shop"\npages_build_output_dir = "./dist"\n', "vercel.json": "{}" });
  assert.equal(detectHost(pages, pages).id, "cloudflare");
  // At the root of a monorepo, or above it up to the top of the repository.
  const mroot = (files) => { const d = mono(files, { "package.json": "{}", "wrangler.toml": WRANGLER }); return { root: d, host: detectHost(join(d, "apps", "api"), d) }; };
  assert.equal(mroot({ "vercel.json": "{}" }).host.id, "vercel");
  const linked = mroot({ ".vercel/project.json": VERCEL_LINK });
  assert.equal(linked.host.id, "vercel");
  assert.equal(linked.host.vercelDir, linked.root, "the root link");
  assert.equal(mroot({ ".vercel/repo.json": "{}" }).host.id, "unknown", "a link for `vercel link --repo`, which detectHost does not read");
  assert.equal(mroot({ "netlify.toml": "" }).host.id, "netlify");
  assert.equal(mroot({ "apps/.vercel/project.json": VERCEL_LINK }).host.id, "unknown", "a link in a folder between the app and the root");
});

test("the hand-off for a Hono app beside wrangler's config whose evidence names another host or runtime never says Workers & Pages nor names the key Cloudflare · production; on Render the report has the shutdown line", async (t) => {
  const auth = await startFakeAuth({ decide: "approve" });
  const gw = await startFakeGateway({ sites: [{ id: "11111111-1111-1111-1111-111111111111", name: "Shop", domain: "shop.example.com", public_key: "pk_" + "a1".repeat(12), verified: false }], keys: [] });
  t.after(() => { auth.close(); gw.close(); });
  const config = { gateway: gw.url, supabaseUrl: auth.url, clientId: "wiz", apiKey: "test-publishable-key", ports: [53972, 53973], dashboard: "https://app.parlox.io" };
  // No Vite build: the server part is planned, so the hand-off is shown.
  const hono = (code, deps = {}, extra = {}) => ({ "package.json": JSON.stringify({ name: "shop", type: "module", scripts: { dev: "wrangler dev" }, dependencies: { hono: "^4.13.11", ...deps }, devDependencies: { wrangler: "^4.110.0" } }), "package-lock.json": "{}", "wrangler.toml": WRANGLER, "src/index.ts": code, ...extra });
  const VERCEL_APP = "import { Hono } from 'hono'\nimport { handle } from 'hono/vercel'\nconst app = new Hono()\nexport default handle(app)\n";
  const cases = [
    ["wrangler + vercel.json", fixture(hono(BASIC, {}, { "vercel.json": "{}" })), "Vercel"],
    ["a root vercel.json", mono({ "vercel.json": "{}" }, hono(BASIC)), "Vercel"],
    ["a root .vercel/project.json", mono({ ".vercel/project.json": VERCEL_LINK }, hono(BASIC)), "Vercel"],
    ["render.yaml + @hono/node-server", fixture(hono(NODE, { "@hono/node-server": "^2.1.3" }, { "render.yaml": "" })), "Render"],
    ["an import of hono/vercel", fixture(hono(VERCEL_APP)), "your host"],
    ["@hono/node-server alone", fixture(hono(NODE, { "@hono/node-server": "^2.1.3" })), "your host"],
  ];
  for (const [label, dir, host] of cases) {
    const out = [];
    const ui = { info: (m) => out.push(m), warn: (m) => out.push(`WARN ${m}`), confirm: async () => true, select: async (_m, o) => o[0].value, text: async () => "", multiselect: async (_m, o) => o.map((x) => x.value) };
    // The browser follows the sign-in page (the fake server approves at once); the dashboard's key form is not opened.
    const deps = { cwd: dir, config, ui, open: (url) => { if (!url.includes("newKey")) fetch(url).catch(() => {}); }, run: () => ({ status: 0, stdout: "", stderr: "" }) };
    assert.equal(await main(["--yes", "--allow-no-git", "--no-vercel", "--site", "shop.example.com", "--skip-check"], deps), 0, `${label}: ${out.join("\n")}`);
    const text = out.join("\n");
    const shown = decodeURIComponent(text);
    assert.ok(text.includes(HANDOFF_TITLE), `${label}: ${text}`);
    assert.ok(text.includes(`Set on ${host}:`), `${label}: ${text}`);
    assert.equal(shown.includes("Workers & Pages"), false, `${label}: ${text}`);
    assert.equal(shown.includes("Cloudflare · production"), false, `${label}: ${text}`);
    assert.equal(shown.includes("runtime secret"), false, `${label}: ${text}`);
    assert.equal(shown.includes("This server keeps running between requests on Render"), host === "Render", `${label}: ${text}`);
  }
});

// ---- Express: a leftover wrangler config beside another host's file ----

const EXPRESS = "import 'dotenv/config'\nimport express from 'express'\nconst app = express()\napp.get('/', (q, r) => r.send('x'))\napp.listen(3000)\n";
const expressApp = (extra = {}) => ({ "package.json": JSON.stringify({ name: "shop", type: "module", main: "server.js", scripts: { start: "node server.js" }, dependencies: { express: "^5.1.0", dotenv: "^16.4.0" } }), "package-lock.json": "{}", "server.js": EXPRESS, ...extra });
const role = { browser: false, server: true, unitHasBrowser: false };
const SHUTDOWN_FLY = "This server keeps running between requests on Fly.io";

test("Express with a leftover wrangler config beside fly.toml: a Node server, with its .env, the local check and the shutdown line", () => {
  const dir = fixture(expressApp({ "wrangler.toml": 'name = "shop"\nmain = "server.js"\n', "fly.toml": "" }));
  const d = express.detect(dir, dir);
  assert.equal(d.data.worker, false);
  assert.equal(d.envFile, ".env");
  assert.deepEqual(d.localCheck, { url: "http://localhost:3000", start: "npm start" });
  const host = detectHost(dir, dir);
  assert.equal(host.id, "fly");
  const notes = express.hostNotes(d, host, role);
  assert.equal(notes.filter((l) => l.startsWith(SHUTDOWN_FLY)).length, 1, notes.join("\n"));
});

test("Express under wrangler's config alone is still a Worker; a wrangler config at the workspace root (another app's) does not make it one", () => {
  const dir = fixture(expressApp({ "wrangler.toml": 'name = "shop"\nmain = "server.js"\n' }));
  const d = express.detect(dir, dir);
  assert.equal(d.data.worker, true);
  assert.equal(d.envFile, null);
  assert.deepEqual(d.localCheck, { skip: WORKER_LOCAL_SKIP });
  assert.equal(express.hostNotes(d, { id: "fly" }, role).some((l) => l.startsWith("This server keeps running")), false);
  const root = mono({ "wrangler.toml": WRANGLER }, expressApp());
  const m = express.detect(join(root, "apps", "api"), root);
  assert.equal(m.data.worker, false);
  assert.equal(m.envFile, ".env");
});

// ---- More host files ----

const MORE = ["Dockerfile.prod", "Dockerfile.dev", "Containerfile", "docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml", "Procfile", "nixpacks.toml"];

test("each of Dockerfile.*, Containerfile, the Compose files, Procfile and nixpacks.toml is another host's file: beside wrangler's config, or above it, the target is not Workers", () => {
  for (const file of MORE) {
    const dir = fixture(app({ extra: { [file]: "" } }));
    assert.deepEqual(otherHostFile(dir, dir)?.path, file, file);
    assert.equal(onlyCloudflare(dir, dir), false, file);
    withheld(unitOf(dir), file);
    assert.equal(target(unitOf(dir)), "unknown", file);
    const root = mono({ [file]: "" }, app());
    assert.equal(otherHostFile(join(root, "apps", "api"), root)?.path, `../../${file}`, `${file} at the root`);
    withheld(scanApps(root).units.find((u) => u.rel === "apps/api"), `${file} at the root`);
  }
  // A name that only starts like one is not one.
  for (const file of ["Dockerfile-notes.md", "Procfile.md", "compose.json"]) {
    const dir = fixture({ "wrangler.toml": WRANGLER, [file]: "" });
    assert.equal(otherHostFile(dir, dir), null, file);
  }
});

// ---- The README says why a $ in a .env file withholds the key ----

test("the README's guard paragraph says that a $ in a .env file Vite or Bun loads withholds the key, and why", () => {
  const readme = readFileSync(fileURLToPath(new URL("../README.md", import.meta.url)), "utf8").replace(/\s+/g, " ");
  assert.ok(readme.includes("A `$` in a `.env` file that Vite loads when it builds, or that Bun loads when Bun runs the build, also withholds the key: both expand `$NAME` there from the build's environment, so the file could copy the key into a `VITE_` variable, which Vite puts in the browser code."), "the guard paragraph");
});
