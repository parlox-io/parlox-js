import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "../dist/cli.js";
import { BROWSER_VERSION } from "../dist/versions.js";
import { scanApps } from "../dist/apps.js";
import { ownershipLine } from "../dist/ownership.js";
import { startFakeAuth, startFakeGateway } from "./fake-servers.mjs";
import { fixture } from "./helpers.mjs";

// A server part withheld because a Vite build could reach its key: the wizard never says Parlox is installed where it
// added nothing, never says "already installed" where Parlox's parts are not there, and says ownership is confirmed
// after the deploy only when something in the plan can prove it (a server part, the ownership file, or a tag in the
// HTML the gateway reads); otherwise it says how to prove it.

const SITE = { id: "11111111-1111-1111-1111-111111111111", name: "Shop", domain: "shop.example.com", public_key: "pk_" + "a1".repeat(12), verified: false };
// A Vite config with a plugin of its own: the wizard cannot prove what it does, so the key is withheld.
const UNPROVEN = "import { defineConfig } from 'vite'\nexport default defineConfig({\n  publicDir: false,\n  plugins: [{ name: 'mine', config: () => ({}) }],\n})\n";
const CONFIRMED = "Ownership of shop.example.com: confirmed after you deploy (the dashboard checks it when you open the site).";

async function env(t) {
  const auth = await startFakeAuth({ decide: "approve" });
  const gw = await startFakeGateway({ sites: [{ ...SITE }], keys: [] });
  t.after(() => { auth.close(); gw.close(); });
  const config = { gateway: gw.url, supabaseUrl: auth.url, clientId: "wiz", apiKey: "k", ports: [53952, 53953], dashboard: "https://app.parlox.io" };
  return async (dir) => {
    const out = [], reports = [];
    const ui = { info: (m) => out.push(m), warn: (m) => out.push(`WARN ${m}`), confirm: async () => true, select: async (_m, o) => o[0].value, text: async () => "", report: (lines, title) => reports.push({ lines, title }) };
    const code = await main(["--yes", "--allow-no-git", "--site", "shop.example.com", "--skip-check"], { cwd: dir, config, ui, open: (u) => { if (!u.includes("newKey")) fetch(u).catch(() => {}); }, run: () => ({ status: 0, stdout: "", stderr: "" }) });
    return { code, out, report: reports.at(-1) };
  };
}

// An Express API whose client folder is a Vue app on Vite.
const vueClient = () => fixture({
  "package.json": JSON.stringify({ name: "api", scripts: { build: "npm run build --prefix client", start: "node server/index.js" }, dependencies: { express: "^5.1.0" } }),
  "package-lock.json": "{}", "render.yaml": "",
  "server/index.js": "const express = require('express');\nconst app = express();\napp.listen(3000);\n",
  "client/package.json": JSON.stringify({ name: "client", scripts: { build: "vite build" }, dependencies: { vue: "^3.5.0" }, devDependencies: { vite: "^8.3.0" } }),
  "client/vite.config.js": UNPROVEN, "client/index.html": '<div id="app"></div>\n',
});

test("an Express API with a Vue client on Vite, its server part withheld: nothing is said to be installed, now or on a second run", async (t) => {
  const start = await env(t);
  const dir = vueClient();
  const [u] = scanApps(dir).units;
  assert.equal(u.server, null);
  assert.equal(u.withheld?.detection.integration, "express", "the withheld part is recorded on the app");
  for (const run of [1, 2]) {
    const r = await start(dir);
    assert.equal(r.code, 0, r.out.join("\n"));
    assert.ok(r.out.includes("Nothing to change."), `run ${run}: ${r.out.join("\n")}`);
    assert.equal(r.out.some((m) => m.includes("already installed")), false, r.out.join("\n"));
    assert.equal(r.report.title, "Nothing was added to your code");
    assert.equal(r.report.lines.includes(CONFIRMED), false, r.report.lines.join("\n"));
    assert.ok(r.report.lines.some((l) => l.startsWith("Ownership of shop.example.com: nothing the wizard added can prove it yet.") && l.includes("DNS record")), r.report.lines.join("\n"));
    assert.ok(r.report.lines.some((l) => l.startsWith("Express: no server part was added.")), r.report.lines.join("\n"));
    assert.equal(r.report.lines.some((l) => /^Next: deploy/.test(l)), false, r.report.lines.join("\n"));
  }
});

test("Vite React and Express in one folder with an unproven Vite config: the browser part is added, and ownership is not claimed", async (t) => {
  const start = await env(t);
  const dir = fixture({
    "package.json": JSON.stringify({ name: "shop", type: "module", scripts: { dev: "vite", build: "vite build", start: "node server.js" }, dependencies: { express: "^5.1.0", react: "^19.2.8", "react-dom": "^19.2.8" }, devDependencies: { vite: "^8.3.0" } }),
    "package-lock.json": "{}", "render.yaml": "", "vite.config.js": UNPROVEN,
    "index.html": '<!doctype html>\n<html>\n  <body>\n    <div id="root"></div>\n    <script type="module" src="/src/main.jsx"></script>\n  </body>\n</html>\n',
    "src/main.jsx": "import { createRoot } from 'react-dom/client'\nimport App from './App.jsx'\n\ncreateRoot(document.getElementById('root')).render(<App />)\n",
    "server.js": "import express from 'express'\n\nconst app = express()\napp.use(express.static('dist'))\napp.listen(3000)\n",
  });
  const r = await start(dir);
  assert.equal(r.code, 0, r.out.join("\n"));
  assert.ok(r.report.lines.some((l) => l.startsWith("Browser part: added to your code")), r.report.lines.join("\n"));
  assert.equal(r.report.lines.includes(CONFIRMED), false, r.report.lines.join("\n"));
  assert.ok(r.report.lines.some((l) => l.startsWith("Ownership of shop.example.com: nothing the wizard added can prove it yet.")), r.report.lines.join("\n"));
  // A second run, once the package is installed: the browser part is there; the server part is still not.
  const p = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ ...p, dependencies: { ...p.dependencies, "@parlox/browser": BROWSER_VERSION } }));
  const again = await start(dir);
  assert.ok(again.out.includes("Parlox's browser part is already in this app; no server part was added (see the note below). Nothing to change."), again.out.join("\n"));
  assert.equal(again.report.lines.includes(CONFIRMED), false);
});

test("what proves ownership: a server part, the ownership file in the plan or on disk, or a tag in the HTML the gateway reads", () => {
  const unit = (detections, server = null, browser = null) => ({ dir: "/nowhere", root: "/nowhere", rel: ".", detections, server, browser, warnings: [], withheld: null });
  const host = { id: "render", label: "Render", where: "", docs: null, vercelDir: null };
  const empty = { changes: [], install: null, manual: [], warnings: [] };
  const vite = { integration: "vite-react", dir: "/nowhere", root: "/nowhere", parts: { browser: { file: "src/main.jsx", kind: "vite-entry" }, server: { file: "public/.well-known/parlox-verify", kind: "verify-file" } }, facts: [], notes: [], envFile: null, localCheck: { skip: "x" }, data: { exposure: { why: "w", fix: "f" } } };
  const line = (units, plans) => ownershipLine(units.map((u, i) => ({ unit: u, plan: plans[i] })), () => host, "vt_fake", "shop.example.com");
  // The ownership file planned for an app whose server part is withheld (its Vite detection, not its server part).
  const planned = { ...empty, changes: [{ path: "public/.well-known/parlox-verify", before: null, after: "vt_fake\n", purpose: "ownership proof" }] };
  assert.equal(line([unit([vite], null, vite)], [planned]), CONFIRMED);
  // The browser part alone, in JavaScript: the gateway cannot see it in the page's HTML.
  assert.match(line([unit([vite], null, vite)], [empty]), /^Ownership of shop\.example\.com: nothing the wizard added can prove it yet\./);
  // A tag in a page the server sends: confirmed if the homepage carries it.
  const pages = { ...vite, integration: "express", parts: { browser: { file: "views/layout.ejs", kind: "express-pages" }, server: null } };
  assert.match(line([unit([pages], null, pages)], [{ ...empty, changes: [{ path: "views/layout.ejs", before: "a", after: "b", purpose: "browser part" }] }]), /^Ownership of shop\.example\.com: confirmed after you deploy, if your homepage carries the tag/);
});
