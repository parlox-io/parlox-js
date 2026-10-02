import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "../dist/cli.js";
import { scanApps, planUnit, unplanUnit } from "../dist/apps.js";
import { applyPlan } from "../dist/plan-core.js";
import { readInside } from "../dist/fs-safe.js";
import { unplanEnv } from "../dist/envfiles.js";
import { express } from "../dist/integrations/express.js";
import { hono } from "../dist/integrations/hono.js";
import { viteReact } from "../dist/integrations/vite-react.js";
import { nextjs } from "../dist/integrations/nextjs.js";
import { BROWSER_VERSION, SERVER_VERSION } from "../dist/versions.js";
import { startFakeAuth, startFakeGateway } from "./fake-servers.mjs";
import { fixture, pkg as nextPkg, read } from "./helpers.mjs";

// Uninstall must not break the merchant's own order code: @parlox/server stays when the app's own code still imports
// it once the wizard's lines are gone, and a PARLOX_SECRET_KEY line stays in the env file (the wizard cannot tell
// whether --local-key wrote it or it is the merchant's own key for orders). PARLOX_VERIFY_TOKEN goes, as before.

const PK = "pk_" + "a1".repeat(12);
const KEY = `PARLOX_SECRET_KEY=sk_parlox_${"d".repeat(64)}`;
const git = { isRepo: () => false, dirty: () => [], isTracked: () => false, isIgnored: () => false };
const reader = (dir) => (rel) => (existsSync(join(dir, rel)) ? readFileSync(join(dir, rel), "utf8") : null);
const host = { id: "render", label: "Render", where: "", docs: null, vercelDir: null };
const ORDERS = "import { createParlox } from '@parlox/server'\n\nconst parlox = createParlox()\nexport const recordOrder = (o) => parlox.purchase(o)\n";

/** The app as the wizard installs it: its plan applied, and the packages it adds declared. */
function installed(files) {
  const dir = fixture({ "package-lock.json": "{}", ...files });
  const [u] = scanApps(dir).units;
  applyPlan(dir, planUnit(u, { publicKey: PK, verifyToken: "vt_fake", host }, { read: reader(dir), git }));
  const p = JSON.parse(read(dir, "package.json"));
  p.dependencies = { ...p.dependencies, "@parlox/browser": BROWSER_VERSION, "@parlox/server": SERVER_VERSION };
  writeFileSync(join(dir, "package.json"), JSON.stringify(p));
  return dir;
}
const unplan = (dir) => { const [u] = scanApps(dir).units; return unplanUnit(u, { read: reader(dir), git }); };
const removes = (plan) => plan.install?.args.filter((a) => a.startsWith("@parlox/")) ?? [];

const expressApp = (extra = {}) => installed({
  "package.json": JSON.stringify({ name: "api", type: "module", scripts: { dev: "node server.js" }, dependencies: { express: "^5.1.0", dotenv: "^17.0.0" } }),
  ".env": "PORT=3000\n", "server.js": "import 'dotenv/config'\nimport express from 'express'\n\nconst app = express()\napp.listen(3000)\n", ...extra,
});

test("Express: the app's own purchase() code keeps @parlox/server, and the review says which file and how to remove it later", () => {
  const dir = expressApp({ "src/orders.js": ORDERS });
  const plan = unplan(dir);
  assert.deepEqual(removes(plan), [], JSON.stringify(plan.install));
  assert.ok(plan.warnings.some((w) => w.startsWith("@parlox/server stays installed: src/orders.js imports @parlox/server, an import the wizard did not write") && w.endsWith("remove it yourself: npm uninstall @parlox/server")), plan.warnings.join("\n"));
  assert.ok(plan.changes.some((c) => c.path === "server.js"), "the wizard's own line still goes");
  // Without such code the package goes, as before.
  assert.deepEqual(removes(unplan(expressApp())), ["@parlox/server"]);
  // An import beside the wizard's own, in the server file itself, counts too.
  const same = expressApp();
  writeFileSync(join(same, "server.js"), read(same, "server.js").replace("import express from 'express'\n", "import express from 'express'\nimport { flush } from '@parlox/server'\n"));
  assert.ok(unplan(same).warnings.some((w) => w.startsWith("@parlox/server stays installed: server.js imports @parlox/server")), unplan(same).warnings.join("\n"));
});

test("Hono and Next.js: the app's own import keeps @parlox/server; Next.js still removes @parlox/browser", () => {
  const h = installed({
    "package.json": JSON.stringify({ name: "api", dependencies: { hono: "^4.9.0", "@hono/node-server": "^1.19.0" } }),
    "src/index.ts": "import { serve } from '@hono/node-server'\nimport { Hono } from 'hono'\n\nconst app = new Hono()\nserve(app)\n", "src/orders.ts": ORDERS,
  });
  assert.deepEqual(removes(unplan(h)), []);
  assert.ok(unplan(h).warnings.some((w) => w.startsWith("@parlox/server stays installed: src/orders.ts")));
  const layout = "export default function RootLayout({ children }) {\n  return (\n    <html>\n      <body>{children}</body>\n    </html>\n  );\n}\n";
  const n = installed({ "package.json": nextPkg(), "app/layout.tsx": layout, "app/api/orders/route.ts": ORDERS });
  const plan = unplan(n);
  assert.deepEqual(removes(plan), ["@parlox/browser"], JSON.stringify(plan.install));
  assert.ok(plan.warnings.some((w) => w.startsWith("@parlox/server stays installed: app/api/orders/route.ts")), plan.warnings.join("\n"));
});

test("Vite React on Vercel: an API route of the app's own keeps @parlox/server; @parlox/browser goes", () => {
  const dir = fixture({
    "package.json": JSON.stringify({ name: "shop", type: "module", dependencies: { react: "^19.2.8", "react-dom": "^19.2.8", "@parlox/browser": BROWSER_VERSION, "@parlox/server": SERVER_VERSION }, devDependencies: { vite: "^8.3.0" } }),
    "package-lock.json": "{}", "index.html": '<script type="module" src="/src/main.jsx"></script>\n', "src/main.jsx": "createRoot(document.getElementById('root')).render(<App />)\n",
    "api/orders.ts": ORDERS,
  });
  const d = viteReact.detect(dir, dir);
  const plan = viteReact.unplan(d, { read: reader(dir), git });
  assert.deepEqual(removes(plan), ["@parlox/browser"]);
  assert.ok(plan.warnings.some((w) => w.startsWith("@parlox/server stays installed: api/orders.ts")), plan.warnings.join("\n"));
});

test("a source file the scan does not read (over 1 MB, a link, a linked folder) keeps @parlox/server, and the review says which and why", { skip: process.platform === "win32" }, () => {
  // As the uninstall reads files (fs-safe.ts: a link is never followed, nothing over 1 MB is read).
  const safely = (dir) => { const [u] = scanApps(dir).units; return unplanUnit(u, { read: (f) => readInside(dir, f), git }); };
  const big = expressApp({ "src/catalog.js": `export const items = ${JSON.stringify("x".repeat(1_100_000))}\n` });
  const plan = safely(big);
  assert.deepEqual(removes(plan), [], JSON.stringify(plan.install));
  assert.ok(plan.warnings.includes("@parlox/server stays installed: the wizard did not read src/catalog.js (it is larger than 1000000 bytes), so it cannot tell whether your own code imports it. If nothing does, remove it yourself: npm uninstall @parlox/server"), plan.warnings.join("\n"));
  // A linked source file, and a linked folder of source files: the wizard never follows a link.
  const outside = fixture({ "orders.js": ORDERS, "shared/orders.js": ORDERS });
  const linked = expressApp();
  mkdirSync(join(linked, "src"));
  symlinkSync(join(outside, "orders.js"), join(linked, "src/orders.js"));
  assert.ok(safely(linked).warnings.includes("@parlox/server stays installed: the wizard did not read src/orders.js (it is a link, which the wizard never follows), so it cannot tell whether your own code imports it. If nothing does, remove it yourself: npm uninstall @parlox/server"), safely(linked).warnings.join("\n"));
  assert.deepEqual(removes(safely(linked)), []);
  const folder = expressApp();
  symlinkSync(join(outside, "shared"), join(folder, "shared"));
  assert.ok(safely(folder).warnings.some((w) => w.startsWith("@parlox/server stays installed: the wizard did not read shared/ (it is a link, which the wizard never follows)")), safely(folder).warnings.join("\n"));
  assert.deepEqual(removes(safely(folder)), []);
  // Two of them: the first is named, and how many more.
  const two = expressApp({ "src/a.js": `// ${"x".repeat(1_100_000)}\n`, "src/b.js": `// ${"x".repeat(1_100_000)}\n` });
  assert.ok(safely(two).warnings.some((w) => w.startsWith("@parlox/server stays installed: the wizard did not read src/a.js (it is larger than 1000000 bytes) and 1 other file, so it cannot tell")), safely(two).warnings.join("\n"));
  // A large file that is not source code, or a link outside the source the scan reads (a dot-folder, node_modules), changes nothing.
  const other = expressApp({ "data/catalog.json": JSON.stringify("x".repeat(1_100_000)) });
  symlinkSync(join(outside, "shared"), join(other, ".cache"));
  assert.deepEqual(removes(safely(other)), ["@parlox/server"], safely(other).warnings.join("\n"));
});

test("an app with Express and Vite in one folder: the wizard's own server line is not the app's own code; the package goes", () => {
  const dir = installed({
    "package.json": JSON.stringify({ name: "shop", type: "module", scripts: { dev: "node server.js", build: "vite build" }, dependencies: { express: "^5.1.0", react: "^19.2.8", "react-dom": "^19.2.8" }, devDependencies: { vite: "^8.3.0", "@vitejs/plugin-react": "^6.1.1" } }),
    "index.html": '<script type="module" src="/src/main.jsx"></script>\n', "src/main.jsx": "createRoot(document.getElementById('root')).render(<App />)\n",
    "vite.config.js": "import { defineConfig } from 'vite'\nimport react from '@vitejs/plugin-react'\n\nexport default defineConfig({\n  plugins: [react()],\n})\n",
    "server.js": "import express from 'express'\n\nconst app = express()\napp.use(express.static('dist'))\napp.listen(3000)\n",
  });
  const [u] = scanApps(dir).units;
  assert.equal(u.server?.integration, "express", JSON.stringify(u.warnings));
  assert.match(read(dir, "server.js"), /@parlox\/server\/express/);
  const plan = unplan(dir);
  assert.deepEqual(removes(plan), ["@parlox/browser", "@parlox/server"], JSON.stringify(plan.install));
  assert.equal(plan.warnings.some((w) => w.includes("stays installed")), false, plan.warnings.join("\n"));
});

test("the env file: PARLOX_VERIFY_TOKEN goes, a PARLOX_SECRET_KEY line stays, and the review says how to remove a local key", () => {
  const plan = unplanEnv({ read: (r) => ({ ".env": `PORT=3000\nPARLOX_VERIFY_TOKEN=vt_fake\n${KEY}\n` })[r] ?? null, git }, ".env");
  assert.deepEqual(plan.changes.map((c) => c.after), [`PORT=3000\n${KEY}\n`]);
  assert.ok(plan.warnings.some((w) => w.startsWith("PARLOX_SECRET_KEY in .env was left: the wizard cannot tell whether --local-key wrote it or it is your own key") && w.includes('revoke the key named "wizard · local dev · …" in Settings → Keys')), JSON.stringify(plan.warnings));
  // Next.js's .env.local the same way.
  const layout = "export default function RootLayout({ children }) {\n  return (\n    <html>\n      <body>{children}</body>\n    </html>\n  );\n}\n";
  const n = installed({ "package.json": nextPkg(), "app/layout.tsx": layout });
  writeFileSync(join(n, ".env.local"), `${read(n, ".env.local")}${KEY}\n`);
  const back = unplan(n);
  applyPlan(n, back);
  assert.equal(read(n, ".env.local"), `${KEY}\n`);
  assert.ok(back.warnings.some((w) => w.startsWith("PARLOX_SECRET_KEY in .env.local was left")));
});

test("a full uninstall of an app with its own purchase() call: the package and the key line stay, and the report says why", async (t) => {
  const auth = await startFakeAuth({ decide: "approve" });
  const gw = await startFakeGateway({ sites: [], keys: [] });
  t.after(() => { auth.close(); gw.close(); });
  const dir = expressApp({ "src/orders.js": ORDERS, ".gitignore": "node_modules\n.env\n" });
  writeFileSync(join(dir, ".env"), `${read(dir, ".env")}${KEY}\n`);
  const G = ["-c", "user.email=t@t", "-c", "user.name=t"];
  execFileSync("git", [...G, "init", "-q"], { cwd: dir });
  execFileSync("git", [...G, "add", "-A"], { cwd: dir });
  execFileSync("git", [...G, "commit", "-qm", "installed"], { cwd: dir });
  const out = [], runs = [], reports = [];
  const ui = { info: (m) => out.push(m), warn: (m) => out.push(`WARN ${m}`), confirm: async () => true, select: async (_m, o) => o[0].value, text: async () => "", report: (lines) => reports.push(...lines) };
  const config = { gateway: gw.url, supabaseUrl: auth.url, clientId: "wiz", apiKey: "k", ports: [53912, 53913], dashboard: "https://app.parlox.io" };
  assert.equal(await main(["uninstall", "--yes"], { cwd: dir, config, ui, open: () => {}, run: (cmd, args) => { runs.push([cmd, ...args]); return { status: 0, stdout: "", stderr: "" }; } }), 0, out.join("\n"));
  assert.deepEqual(runs, [], "no package removal: @parlox/server is the only Parlox package declared and it stays");
  assert.equal(read(dir, ".env"), `PORT=3000\n${KEY}\n`);
  assert.doesNotMatch(read(dir, "server.js"), /parlox/);
  assert.ok(reports.some((l) => l.startsWith("@parlox/server stays installed: src/orders.js")), reports.join("\n"));
  assert.ok(reports.some((l) => l.startsWith("PARLOX_SECRET_KEY in .env was left")), reports.join("\n"));
  assert.equal(out.some((m) => m.includes("sk_parlox_")), false);
});
