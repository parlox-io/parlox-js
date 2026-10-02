import { test } from "node:test";
import assert from "node:assert/strict";
import { hostStepFor, scanApps } from "../dist/apps.js";
import { handoffOf } from "../dist/host-step.js";
import { detectHost } from "../dist/hosts.js";
import { integrationOf } from "../dist/integrations/registry.js";
import { runNames } from "../dist/names.js";
import { handoffLines } from "../dist/ui/handoff.js";
import { join } from "node:path";
import { fixture } from "./helpers.mjs";

// A Vite build beside the app is checked as for any server, on Cloudflare Workers too. The runtime-secret sentence (where
// the key goes on Workers) is said only for an app every file says deploys there: wrangler's config, no Vercel link in
// the app folder or at the workspace root, and no other host's file beside it. The configurations below are shapes the
// guard reads; none is ever built.

const RUNTIME_SECRET = "Add PARLOX_SECRET_KEY as a runtime secret under Settings → Variables & Secrets, not as a build variable.";
const HONO_APP = "import { Hono } from 'hono'\nconst app = new Hono()\napp.get('/', (c) => c.text('hi'))\nexport default app\n";
// loadEnv with the "" prefix, under define: the build's whole environment in the browser code.
const ALL_ENV = "import { defineConfig, loadEnv } from 'vite'\nexport default defineConfig(({ mode }) => {\n  const env = loadEnv(mode, process.cwd(), '')\n  return { define: { 'process.env': env } }\n})\n";
const SAFE = "import { defineConfig } from 'vite'\nexport default defineConfig({})\n";
const VERCEL_LINK = JSON.stringify({ projectId: "prj_1", orgId: "team_1", projectName: "shop" });
const files = (config, extra = {}) => ({
  "package.json": JSON.stringify({ name: "shop", type: "module", scripts: { dev: "vite", build: "vite build" }, dependencies: { hono: "^4.13.11" }, devDependencies: { vite: "^8.1.4", wrangler: "^4.110.0" } }),
  "package-lock.json": "{}",
  "wrangler.toml": 'name = "shop"\nmain = "src/index.ts"\ncompatibility_date = "2025-01-01"\n',
  "src/index.ts": HONO_APP,
  "vite.config.ts": config,
  ...extra,
});
const unitOf = (dir) => { const [u] = scanApps(dir).units; assert.ok(u, `no app in ${dir}`); return u; };
/** What the report and the hand-off say for the app's server part, on the host the run detects. */
const said = (u) => {
  const host = detectHost(u.dir, u.root);
  const report = integrationOf(u.server).hostNotes(u.server, host, { browser: false, server: true, unitHasBrowser: false });
  const handoff = handoffLines(handoffOf({ dashboard: "https://app.parlox.io", siteId: "s", verifyToken: "vt", names: runNames([u], u.dir) }, u, host, { secretDone: false, tokenDone: false, finished: false }));
  return { host, text: [...report, ...handoff] };
};
const withheld = (u, label) => {
  assert.equal(u.server, null, label);
  assert.match(u.withheld?.exposure.why ?? "", /passes environment values to the browser code through define/, label);
  assert.match(u.warnings[0] ?? "", /^Hono: no server part was added\. /, label);
  assert.equal(hostStepFor(u, detectHost(u.dir, u.root)), false, label);
};

test("Hono with wrangler.toml and a Vercel link: the Vite build is checked as on any host, so a config that copies the environment into the browser code withholds the server part", () => {
  const u = unitOf(fixture(files(ALL_ENV, { ".vercel/project.json": VERCEL_LINK })));
  assert.equal(detectHost(u.dir, u.root).id, "vercel");
  withheld(u, "a Vercel link in the app folder");
  // With a config the guard proves safe, the server part stays, and nothing says the key is a runtime secret.
  const safe = unitOf(fixture(files(SAFE, { ".vercel/project.json": VERCEL_LINK })));
  assert.equal(safe.server?.integration, "hono", safe.warnings.join("\n"));
  assert.equal(said(safe).text.includes(RUNTIME_SECRET), false, said(safe).text.join("\n"));
});

test("the same with netlify.toml instead of the Vercel link: withheld, and no runtime-secret sentence", () => {
  const u = unitOf(fixture(files(ALL_ENV, { "netlify.toml": "" })));
  assert.equal(detectHost(u.dir, u.root).id, "netlify");
  withheld(u, "netlify.toml");
  const safe = unitOf(fixture(files(SAFE, { "netlify.toml": "" })));
  assert.equal(safe.server?.integration, "hono", safe.warnings.join("\n"));
  const { host, text } = said(safe);
  assert.equal(host.id, "netlify");
  assert.equal(text.includes(RUNTIME_SECRET), false, text.join("\n"));
  assert.equal(text.some((l) => l.includes("runtime secret")), false, text.join("\n"));
});

test("a Vercel link at the workspace root, or another host's file beside wrangler's: withheld too", () => {
  const mono = fixture({
    "package.json": JSON.stringify({ name: "mono", private: true, workspaces: ["apps/*"] }), "package-lock.json": "{}", ".vercel/project.json": VERCEL_LINK,
    ...Object.fromEntries(Object.entries(files(ALL_ENV)).filter(([f]) => f !== "package-lock.json").map(([f, c]) => [`apps/shop/${f}`, c])),
  });
  const [inMono] = scanApps(mono).units;
  assert.equal(inMono?.rel, "apps/shop");
  withheld(inMono, "a Vercel link at the root");
  for (const other of ["render.yaml", "railway.json", "fly.toml", "Dockerfile", "vercel.json"]) {
    withheld(unitOf(fixture(files(ALL_ENV, { [other]: other.endsWith(".json") ? "{}" : "" }))), other);
  }
});

test("plain Workers (wrangler's config only): a config the guard proves safe keeps the server part, and both the report and the hand-off say the key is a runtime secret; the copy-everything config is withheld as on any host", () => {
  const u = unitOf(fixture(files(SAFE)));
  assert.equal(u.server?.integration, "hono", u.warnings.join("\n"));
  assert.equal(u.withheld, null);
  const { host, text } = said(u);
  assert.equal(host.id, "cloudflare");
  assert.equal(hostStepFor(u, host), true);
  assert.equal(text.filter((l) => l === RUNTIME_SECRET).length, 2, text.join("\n"));
  withheld(unitOf(fixture(files(ALL_ENV))), "plain Workers, the copy-everything config");
});

// ---- Contrary evidence anywhere up to the top of the repository, or in the code ----
// Each case keeps a wrangler config in the app folder and the copy-everything Vite config: each ends withheld, and the
// runtime the evidence names is the app's target.

const CDN_NOTE = "Pages a CDN serves from its cache never reach this server, so those crawler visits are not seen.";
const CLOUDFLARE_NOTE = "On Cloudflare the adapter reads PARLOX_SECRET_KEY and PARLOX_VERIFY_TOKEN from the Worker's variables (c.env).";
const SHUTDOWN = "This server keeps running between requests on Fly.io";
const NODE_APP = "import { Hono } from 'hono'\nimport { serve } from '@hono/node-server'\nconst app = new Hono()\napp.get('/', (c) => c.text('hi'))\nserve({ fetch: app.fetch, port: 3000 })\n";
const withDeps = (deps, config = ALL_ENV, extra = {}) => {
  const f = files(config, extra);
  const p = JSON.parse(f["package.json"]);
  return { ...f, "package.json": JSON.stringify({ ...p, dependencies: { ...p.dependencies, ...deps } }) };
};
/** The app at apps/shop of a workspace whose root holds `rootFiles`, run from the root. */
const inMonorepo = (rootFiles, appFiles = files(ALL_ENV)) => {
  const dir = fixture({
    "package.json": JSON.stringify({ name: "mono", private: true, workspaces: ["apps/*"] }), "package-lock.json": "{}", ...rootFiles,
    ...Object.fromEntries(Object.entries(appFiles).filter(([f]) => f !== "package-lock.json").map(([f, c]) => [`apps/shop/${f}`, c])),
  });
  const u = scanApps(dir).units.find((x) => x.rel === "apps/shop");
  assert.ok(u, `no app at apps/shop in ${dir}`);
  return u;
};
const target = (u) => (u.server ?? u.withheld.detection).data.target;

test("wrangler beside code that imports hono/vercel, with no Vercel link: withheld, on the Vercel target", () => {
  const inApp = unitOf(fixture(files(ALL_ENV, { "src/index.ts": "import { Hono } from 'hono'\nimport { handle } from 'hono/vercel'\nconst app = new Hono()\nexport const GET = handle(app)\nexport default app\n" })));
  withheld(inApp, "the app file imports hono/vercel");
  assert.equal(target(inApp), "vercel");
  // Vercel's function in api/ imports it; wrangler's main, src/index.ts, does not.
  const inApi = unitOf(fixture(files(ALL_ENV, { "api/index.ts": "import { handle } from 'hono/vercel'\nimport app from '../src/index'\nexport default handle(app)\n" })));
  withheld(inApi, "api/index.ts imports hono/vercel");
  assert.equal(target(inApi), "vercel");
});

test("wrangler beside @hono/node-server and serve(): withheld, on the Node.js target", () => {
  const u = unitOf(fixture(withDeps({ "@hono/node-server": "^2.1.3" }, ALL_ENV, { "src/index.ts": NODE_APP })));
  withheld(u, "@hono/node-server");
  assert.equal(target(u), "nodejs");
  // Imported without being declared (hoisted from a workspace root), or only in devDependencies: the same.
  withheld(unitOf(fixture(files(ALL_ENV, { "src/server.ts": NODE_APP }))), "imported, not declared");
  const dev = files(ALL_ENV);
  const devPkg = JSON.parse(dev["package.json"]);
  withheld(unitOf(fixture({ ...dev, "package.json": JSON.stringify({ ...devPkg, devDependencies: { ...devPkg.devDependencies, "@hono/node-server": "^2.1.3" } }) })), "a devDependency");
});

test("another runtime's module anywhere in the app's code names the target: Bun, AWS Lambda, Netlify; Deno and Lambda@Edge are declined", () => {
  for (const [module, runtime] of [["hono/bun", "bun"], ["hono/aws-lambda", "aws-lambda"], ["hono/netlify", "unknown"]]) {
    const u = unitOf(fixture(files(ALL_ENV, { "src/entry.ts": `import { Hono } from 'hono'\nimport * as runtime from '${module}'\nexport { runtime }\n` })));
    withheld(u, module);
    assert.equal(target(u), runtime, module);
  }
  for (const [module, why] of [["hono/deno", /Hono on Deno is not covered/], ["hono/lambda-edge", /Hono on Lambda@Edge is not covered/]]) {
    const scan = scanApps(fixture(files(ALL_ENV, { "src/entry.ts": `export * from '${module}'\n` })));
    assert.equal(scan.units.length, 0, module);
    assert.match(scan.problems[0]?.error.message ?? "", why, module);
  }
});

test("a host's file at the root of a monorepo, or a Vercel link in a folder between the app and the root: withheld", () => {
  withheld(inMonorepo({ "vercel.json": "{}" }), "a root vercel.json");
  withheld(inMonorepo({ "netlify.toml": "[build]\nbase = \"apps/shop\"\n" }), "a root netlify.toml");
  withheld(inMonorepo({ "apps/.vercel/project.json": VERCEL_LINK }), "apps/.vercel");
  withheld(inMonorepo({ ".vercel/repo.json": JSON.stringify({ orgId: "team_1", remoteName: "origin", projects: [{ id: "prj_1", name: "shop", directory: "apps/shop" }] }) }), "vercel link --repo at the root");
  withheld(inMonorepo({ "vercel.ts": "export const config = {}\n" }), "a root vercel.ts");
  // The top of the repository is above the workspace root: a file there counts too.
  const repo = fixture({ ".git/HEAD": "ref: refs/heads/main\n", "fly.toml": "", ...Object.fromEntries(Object.entries(files(ALL_ENV)).map(([f, c]) => [`shop/${f}`, c])) });
  withheld(unitOf(join(repo, "shop")), "fly.toml at the top of the repository");
});

test("wrangler beside fly.toml and @hono/node-server: withheld beside the Vite build; without one, the Node.js target with its notes and the shutdown line", () => {
  withheld(unitOf(fixture(withDeps({ "@hono/node-server": "^2.1.3" }, ALL_ENV, { "src/index.ts": NODE_APP, "fly.toml": "" }))), "fly.toml");
  const dir = fixture({ "package.json": JSON.stringify({ name: "shop", type: "module", dependencies: { hono: "^4.13.11", "@hono/node-server": "^2.1.3" } }), "package-lock.json": "{}", "wrangler.toml": 'name = "shop"\nmain = "src/index.ts"\n', "src/index.ts": NODE_APP, "fly.toml": "" });
  const u = unitOf(dir);
  assert.equal(u.server?.integration, "hono", u.warnings.join("\n"));
  assert.equal(u.server.data.target, "nodejs");
  assert.ok(u.server.facts.some(([k, v]) => k === "Found" && v.includes("Node.js")), JSON.stringify(u.server.facts));
  const { host, text } = said(u);
  assert.equal(host.id, "fly");
  assert.ok(text.includes(CDN_NOTE), text.join("\n"));
  assert.equal(text.filter((l) => l.startsWith(SHUTDOWN)).length, 1, text.join("\n"));
  assert.equal(text.includes(CLOUDFLARE_NOTE), false, text.join("\n"));
  assert.equal(text.some((l) => l.includes("runtime secret")), false, text.join("\n"));
  assert.notDeepEqual(u.server.localCheck, { skip: "the wizard does not write the Worker's local variables; check it after you deploy" });
});

test("an app too large to read every source file for another runtime's import: the Vite build is checked as everywhere, and the target follows the files read", () => {
  const many = Object.fromEntries(Array.from({ length: 210 }, (_, i) => [`src/routes/r${String(i).padStart(3, "0")}.ts`, "export const x = 1\n"]));
  const u = unitOf(fixture(files(ALL_ENV, many)));
  withheld(u, "past the scan's caps");
  assert.equal(target(u), "cloudflare-workers", "nothing read says otherwise");
  assert.equal(u.warnings.some((w) => /another runtime/.test(w)), false, u.warnings.join("\n"));
});

// ---- The runtime-secret sentence follows the Workers target ----

test("the runtime-secret sentence is said for the Workers target: for a Worker whose source files were not all read, never for a wrangler config beside render.yaml, or Express; for plain Workers whatever host object the notes get", () => {
  const many = Object.fromEntries(Array.from({ length: 210 }, (_, i) => [`src/routes/r${String(i).padStart(3, "0")}.ts`, "export const x = 1\n"]));
  // Where the key goes on the host the hand-off names: Cloudflare (the files read say Workers).
  const unread = unitOf(fixture(files(SAFE, many)));
  assert.equal(unread.server?.integration, "hono", unread.warnings.join("\n"));
  const u1 = said(unread);
  assert.equal(u1.host.id, "cloudflare");
  assert.equal(u1.text.filter((l) => l === RUNTIME_SECRET).length, 2, u1.text.join("\n"));
  // Beside render.yaml, wrangler's config does not make Cloudflare the host: render.yaml decides.
  for (const [label, extra, hostId] of [["render.yaml beside wrangler", { "render.yaml": "" }, "render"]]) {
    const u = unitOf(fixture(files(SAFE, extra)));
    assert.equal(u.server?.integration, "hono", `${label}: ${u.warnings.join("\n")}`);
    const { host, text } = said(u);
    assert.equal(host.id, hostId, label);
    assert.equal(text.some((l) => l.includes("runtime secret")), false, `${label}: ${text.join("\n")}`);
  }
  const exp = fixture({ "package.json": JSON.stringify({ name: "shop", type: "module", scripts: { start: "node server.js" }, dependencies: { express: "^5.1.0" } }), "package-lock.json": "{}", "wrangler.jsonc": '{\n  "name": "shop",\n  "main": "server.js"\n}\n', "server.js": "import express from 'express'\nconst app = express()\nexport default app\n" });
  const eu = unitOf(exp);
  const { host: eh, text: et } = said(eu);
  assert.equal(eh.id, "cloudflare");
  assert.equal(et.some((l) => l.includes("runtime secret")), false, et.join("\n"));
  const plain = unitOf(fixture(files(SAFE)));
  for (const host of [{ id: "unknown" }, detectHost(plain.dir, plain.root)]) {
    assert.ok(integrationOf(plain.server).hostNotes(plain.server, host, { browser: false, server: true, unitHasBrowser: false }).includes(RUNTIME_SECRET), host.id);
    assert.deepEqual(integrationOf(plain.server).handoffNotes(plain.server, host), [RUNTIME_SECRET], host.id);
  }
});
