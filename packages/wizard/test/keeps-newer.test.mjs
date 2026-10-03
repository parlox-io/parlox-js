import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { express } from "../dist/integrations/express.js";
import { hono } from "../dist/integrations/hono.js";
import { viteReact } from "../dist/integrations/vite-react.js";
import { detectApp, installPlan } from "../dist/integrations/nextjs.js";
import { vercelHost } from "../dist/hosts.js";
import { main } from "../dist/cli.js";
import { BROWSER_VERSION, SERVER_VERSION, VERCEL_FUNCTIONS_VERSION } from "../dist/versions.js";
import { startFakeAuth, startFakeGateway } from "./fake-servers.mjs";
import { fixture, pkg, read } from "./helpers.mjs";

// Every integration that adds a Parlox package follows one rule: it never replaces a newer one the app's package.json
// already declares, nor one it cannot compare; an older one is upgraded to the version the wizard was tested with.

const PK = "pk_" + "a1".repeat(12);
const S = "@parlox/server";
const B = "@parlox/browser";
const git = { isRepo: () => false, dirty: () => [], isTracked: () => false, isIgnored: () => false };
const reader = (dir) => (rel) => (existsSync(join(dir, rel)) ? readFileSync(join(dir, rel), "utf8") : null);
const newer = (name, spec, pinned) => `${name} ${spec} is already in package.json, newer than the version this wizard was tested with (${pinned}), so the wizard keeps it.`;
const otherMajor = (name, spec, pinned) => `${name} ${spec} is already in package.json, a different major version from the one this wizard was tested with (${pinned}), so the wizard did not change it.`;
const cannotCompare = (name, spec, pinned) => `${name} is already in package.json as ${JSON.stringify(spec)}, which the wizard cannot compare with the version it was tested with (${pinned}), so the wizard did not change it.`;
const input = (dir, versions, extra = {}) => ({ publicKey: PK, verifyToken: "vt", host: { id: "unknown" }, versions, parts: { browser: false, server: true }, read: reader(dir), git, ...extra });
const args = (plan) => plan.install?.args ?? null;

const expressApp = (deps) => fixture({
  "package.json": JSON.stringify({ name: "api", type: "module", scripts: { start: "node server.js" }, dependencies: { express: "^5.1.0", ...deps } }),
  "package-lock.json": "{}", "server.js": "import express from 'express'\n\nconst app = express()\napp.listen(3000)\n",
});
const honoApp = (deps) => fixture({
  "package.json": JSON.stringify({ name: "api", type: "module", scripts: { dev: "tsx watch src/index.ts" }, dependencies: { "@hono/node-server": "^2.1.3", hono: "^4.13.11", ...deps } }),
  "package-lock.json": "{}", "src/index.ts": "import { serve } from '@hono/node-server'\nimport { Hono } from 'hono'\n\nconst app = new Hono()\n\nserve({ fetch: app.fetch, port: 3000 })\n",
});
const VITE_MAIN = "import { StrictMode } from 'react'\nimport { createRoot } from 'react-dom/client'\nimport App from './App.tsx'\n\ncreateRoot(document.getElementById('root')!).render(\n  <StrictMode>\n    <App />\n  </StrictMode>,\n)\n";
const VITE_HTML = `<!doctype html>\n<html lang="en">\n  <head>\n    <title>shop</title>\n  </head>\n  <body>\n    <div id="root"></div>\n    <script type="module" src="/src/main.tsx"></script>\n  </body>\n</html>\n`;
const viteApp = (deps) => fixture({
  "package.json": JSON.stringify({ name: "shop", type: "module", dependencies: { react: "^19.2.8", "react-dom": "^19.2.8", ...deps }, devDependencies: { vite: "^8.3.0", "@vitejs/plugin-react": "^6.1.1" } }),
  "package-lock.json": "{}", "tsconfig.json": "{}", "index.html": VITE_HTML, "src/main.tsx": VITE_MAIN, "vercel.json": "{}",
});
const LAYOUT = "export default function RootLayout({ children }) {\n  return (\n    <html>\n      <body>{children}</body>\n    </html>\n  );\n}\n";
const nextApp = (deps) => fixture({ "package.json": pkg({ next: "16.0.1", react: "19.0.0", ...deps }), "package-lock.json": "{}", "tsconfig.json": "{}", "app/layout.tsx": LAYOUT });

// Each server stack's plan, given the declared @parlox/server and the pinned version.
const SERVER_PLANS = {
  Express: (spec, pinned) => { const dir = expressApp({ [S]: spec }); return express.plan(express.detect(dir, dir), input(dir, { browser: BROWSER_VERSION, server: pinned })); },
  Hono: (spec, pinned) => { const dir = honoApp({ [S]: spec }); return hono.plan(hono.detect(dir, dir), input(dir, { browser: BROWSER_VERSION, server: pinned })); },
  "Vite on Vercel": (spec, pinned) => { const dir = viteApp({ [S]: spec, [B]: BROWSER_VERSION, "@vercel/functions": "3.9.9" }); return viteReact.plan(viteReact.detect(dir, dir), input(dir, { browser: BROWSER_VERSION, server: pinned }, { host: vercelHost(null), parts: { browser: true, server: true } })); },
  "Next.js": (spec, pinned) => { const dir = nextApp({ [S]: spec, [B]: BROWSER_VERSION }); return installPlan(detectApp(dir), { publicKey: PK, verifyToken: "vt", versions: { browser: BROWSER_VERSION, server: pinned } }, reader(dir), git); },
};

test("a newer @parlox/server is kept, and the plan says so: Express, Hono, Vite on Vercel, Next.js", () => {
  for (const [stack, plan] of Object.entries(SERVER_PLANS)) {
    const p = plan("1.2.0", "1.1.0");
    assert.equal(p.install, null, `${stack}: nothing to install`);
    assert.ok(p.warnings.includes(newer(S, "1.2.0", "1.1.0")), `${stack}: ${JSON.stringify(p.warnings)}`);
    assert.ok(p.changes.length > 0, `${stack}: the code is still added`);
  }
});

test("an older @parlox/server is upgraded to the pinned version, with nothing to say: Express, Hono, Vite on Vercel, Next.js", () => {
  for (const [stack, plan] of Object.entries(SERVER_PLANS)) {
    const p = plan("1.1.0", "1.2.0");
    assert.deepEqual(args(p), ["install", "--save-exact", "@parlox/server@1.2.0"], stack);
    assert.equal(p.warnings.some((w) => w.includes(S)), false, `${stack}: ${JSON.stringify(p.warnings)}`);
  }
});

test("the same rule for every spec, on each server stack: ^1.3.0 and a later prerelease kept, 1.0.1 and an earlier prerelease upgraded, workspace:* and 2.0.0 kept with a note", () => {
  for (const [stack, plan] of Object.entries(SERVER_PLANS)) {
    const cases = [
      ["^1.3.0", null, newer(S, "^1.3.0", "1.2.0")],
      ["1.3.0-beta.1", null, newer(S, "1.3.0-beta.1", "1.2.0")],
      ["1.0.1", "@parlox/server@1.2.0", null],
      ["1.2.0-rc.1", "@parlox/server@1.2.0", null],
      ["workspace:*", null, cannotCompare(S, "workspace:*", "1.2.0")],
      ["2.0.0", null, otherMajor(S, "2.0.0", "1.2.0")],
      ["1.2.0", null, null],
    ];
    for (const [spec, added, note] of cases) {
      const p = plan(spec, "1.2.0");
      assert.deepEqual(args(p), added ? ["install", "--save-exact", added] : null, `${stack}, ${spec}`);
      assert.deepEqual(p.warnings.filter((w) => w.startsWith(S)), note ? [note] : [], `${stack}, ${spec}`);
    }
  }
});

test("@parlox/browser follows the same rule, in Next.js and in Vite React", () => {
  const browserPlans = {
    "Next.js": (spec, pinned) => { const dir = nextApp({ [B]: spec, [S]: SERVER_VERSION }); return installPlan(detectApp(dir), { publicKey: PK, verifyToken: "vt", versions: { browser: pinned, server: SERVER_VERSION } }, reader(dir), git); },
    "Vite React": (spec, pinned) => { const dir = viteApp({ [B]: spec }); return viteReact.plan(viteReact.detect(dir, dir), input(dir, { browser: pinned, server: SERVER_VERSION }, { host: vercelHost(null), parts: { browser: true, server: false } })); },
  };
  for (const [stack, plan] of Object.entries(browserPlans)) {
    const cases = [
      ["1.1.0", "1.0.3", null, newer(B, "1.1.0", "1.0.3")],
      ["1.0.3", "1.1.0", "@parlox/browser@1.1.0", null],
      ["^1.3.0", "1.2.0", null, newer(B, "^1.3.0", "1.2.0")],
      ["1.0.1", "1.2.0", "@parlox/browser@1.2.0", null],
      ["1.2.0-beta.2", "1.2.0", "@parlox/browser@1.2.0", null],
      ["workspace:*", "1.2.0", null, cannotCompare(B, "workspace:*", "1.2.0")],
      ["2.0.0", "1.2.0", null, otherMajor(B, "2.0.0", "1.2.0")],
    ];
    for (const [spec, pinned, added, note] of cases) {
      const p = plan(spec, pinned);
      assert.deepEqual(args(p), added ? ["install", "--save-exact", added] : null, `${stack}, ${spec} with ${pinned} pinned`);
      assert.deepEqual(p.warnings.filter((w) => w.startsWith(B)), note ? [note] : [], `${stack}, ${spec} with ${pinned} pinned`);
    }
  }
});

test("each package on its own: a newer @parlox/server kept beside an @parlox/browser still to add, in one command with the rest", () => {
  const dir = viteApp({ [S]: "^1.9.0" });
  const p = viteReact.plan(viteReact.detect(dir, dir), input(dir, { browser: "1.0.3", server: "1.2.0" }, { host: vercelHost(null), parts: { browser: true, server: true } }));
  assert.deepEqual(args(p), ["install", "--save-exact", "@parlox/browser@1.0.3", `@vercel/functions@${VERCEL_FUNCTIONS_VERSION}`]);
  assert.ok(p.warnings.includes(newer(S, "^1.9.0", "1.2.0")), JSON.stringify(p.warnings));
});

// The whole run, with this release's own pins: an app that already declares a newer @parlox/server gets the code, no
// package command, and the line saying why.
test("a run on a Next.js app that declares a newer @parlox/server: the files are written, no package is installed, the review and the report say so", async (t) => {
  const auth = await startFakeAuth({ decide: "approve" });
  const gw = await startFakeGateway({ sites: [{ id: "11111111-1111-1111-1111-111111111111", name: "Shop", domain: "shop.example.com", public_key: PK, verified: false }], keys: [] });
  t.after(() => { auth.close(); gw.close(); });
  const config = { gateway: gw.url, supabaseUrl: auth.url, clientId: "wiz", apiKey: "test-publishable-key", ports: [53982, 53983], dashboard: "https://app.parlox.io" };
  const [major, minor] = SERVER_VERSION.split(".");
  const later = `${major}.${Number(minor) + 1}.0`;
  const dir = fixture({ "package.json": pkg({ next: "16.0.1", react: "19.0.0", [B]: BROWSER_VERSION, [S]: later }), "package-lock.json": "{}", "app/layout.tsx": LAYOUT, ".gitignore": "node_modules\n.env*.local\n" });
  const G = ["-c", "user.email=t@t", "-c", "user.name=t"];
  execFileSync("git", [...G, "init", "-q"], { cwd: dir });
  execFileSync("git", [...G, "add", "-A"], { cwd: dir });
  execFileSync("git", [...G, "commit", "-qm", "init"], { cwd: dir });
  const out = [];
  const runs = [];
  const ui = { info: (m) => out.push(m), warn: (m) => out.push(`WARN ${m}`), confirm: async () => true, select: async (_m, o) => o[0].value, text: async () => "" };
  const run = (cmd, a) => { runs.push([cmd, ...a]); return { status: 0, stdout: "", stderr: "" }; };
  assert.equal(await main(["--yes", "--no-vercel", "--site", "shop.example.com", "--skip-check"], { cwd: dir, config, ui, open: (url) => { fetch(url).catch(() => {}); }, run }), 0);
  assert.match(read(dir, "app/layout.tsx"), /<ParloxAnalytics publicKey="pk_a1/);
  assert.deepEqual(runs, [], "no package command");
  assert.equal(JSON.parse(read(dir, "package.json")).dependencies[S], later, "package.json keeps its own version");
  const note = newer(S, later, SERVER_VERSION);
  assert.ok(out.includes(`WARN ${note}`), JSON.stringify(out));
  assert.ok(out.some((m) => m !== `WARN ${note}` && m.includes(note)), `the report says it again: ${JSON.stringify(out)}`);
});
