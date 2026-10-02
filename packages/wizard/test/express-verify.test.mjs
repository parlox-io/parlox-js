import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { planUnit, scanApps, unplanUnit } from "../dist/apps.js";
import { applyPlan } from "../dist/plan-core.js";
import { verifyFolders, servesDotFolders } from "../dist/integrations/express-static.js";
import { readInside } from "../dist/fs-safe.js";
import { ownershipLine } from "../dist/ownership.js";
import { fixture } from "./helpers.mjs";

// Vite React and Express in one folder, the server part withheld (the Vite build could reach the key): Express 4 serves
// a file inside a dot-folder (send 0.x), Express 5 does not (send 1.x). So the ownership file goes in Vite's public
// folder only on Express 4, and only when the server file proves that Express serves that folder (or the build output
// Vite copies it into) at the site's root, with nothing before it that could answer the request first.

const PK = "pk_" + "a1".repeat(12);
const VERIFY = "public/.well-known/parlox-verify";
const host = { id: "render", label: "Render", where: "", docs: null, vercelDir: null };
const git = { isRepo: () => false, dirty: () => [], isTracked: () => false, isIgnored: () => false };
// A plugin of the app's own: the wizard cannot prove what it does, so the server part is withheld.
const UNPROVEN = "import { defineConfig } from 'vite'\nexport default defineConfig({\n  plugins: [{ name: 'mine', config: () => ({}) }],\n})\n";
const SERVER = (before = "", use = "app.use(express.static('dist'))") => `import express from 'express'\n\nconst app = express()\n${before}${use}\napp.listen(3000)\n`;
const app = ({ express = "^4.21.2", server = SERVER(), config = UNPROVEN, extra = {} } = {}) => fixture({
  "package.json": JSON.stringify({ name: "shop", type: "module", scripts: { dev: "vite", build: "vite build", start: "node server.js" }, dependencies: { express, react: "^19.2.8", "react-dom": "^19.2.8" }, devDependencies: { vite: "^8.3.0" } }),
  "package-lock.json": "{}", "render.yaml": "", "vite.config.js": config,
  "index.html": '<!doctype html>\n<html>\n  <body>\n    <div id="root"></div>\n    <script type="module" src="/src/main.jsx"></script>\n  </body>\n</html>\n',
  "src/main.jsx": "import { createRoot } from 'react-dom/client'\nimport App from './App.jsx'\n\ncreateRoot(document.getElementById('root')).render(<App />)\n",
  "server.js": server, ...extra,
});
const planOf = (dir) => {
  const [u] = scanApps(dir).units;
  return { u, plan: planUnit(u, { publicKey: PK, verifyToken: "vt_fake", host }, { read: (f) => readInside(dir, f), git }) };
};
const plansFile = (dir) => planOf(dir).plan.changes.some((c) => c.path === VERIFY);

test("Express 4 serving Vite's build output: the server part is withheld, and the ownership file goes in Vite's public folder", () => {
  const dir = app();
  const { u, plan } = planOf(dir);
  assert.equal(u.server, null, "withheld");
  assert.equal(u.withheld?.detection.integration, "express");
  const file = plan.changes.find((c) => c.path === VERIFY);
  assert.deepEqual(file, { path: VERIFY, before: null, after: "vt_fake\n", purpose: "ownership proof" });
  assert.equal(ownershipLine([{ unit: u, plan }], () => host, "vt_fake", "shop.example.com"), "Ownership of shop.example.com: confirmed after you deploy (the dashboard checks it when you open the site).");
  assert.ok(u.warnings.includes("Express: the ownership file goes in public/.well-known/parlox-verify: Express 4 serves dist/ (express.static in server.js), where Vite copies the public folder when it builds."), u.warnings.join("\n"));
  // Uninstall takes it out again, and the folders it was put in.
  applyPlan(dir, plan);
  assert.equal(readInside(dir, VERIFY), "vt_fake\n");
  const [after] = scanApps(dir).units;
  const removal = unplanUnit(after, { read: (f) => readInside(dir, f), git });
  assert.ok(removal.changes.some((c) => c.path === VERIFY && c.after === null), JSON.stringify(removal.changes.map((c) => c.path)));
  // Express serving the public folder itself.
  const pub = app({ server: SERVER("", "app.use(express.static(path.join(__dirname, 'public')))").replace("import express from 'express'\n", "import express from 'express'\nimport path from 'node:path'\n") });
  assert.ok(plansFile(pub));
  assert.ok(planOf(pub).u.warnings.some((w) => w.startsWith("Express: the ownership file goes in public/.well-known/parlox-verify: Express 4 serves public/ (express.static in server.js).")), planOf(pub).u.warnings.join("\n"));
  // require(), a mount at "/", options of literals, Express's body parsers and other routes before it.
  const cjs = app({ server: "const express = require('express')\nconst app = express()\napp.set('trust proxy', 1)\napp.use(express.json())\napp.get('/api/health', (req, res) => res.send('ok'))\napp.post('/.well-known/parlox-verify', (req, res) => res.end())\napp.use('/api', (req, res, next) => next())\napp.use('/', express.static('dist', { maxAge: '1d', index: ['index.html'], dotfiles: 'allow' }))\napp.listen(3000)\n" });
  assert.ok(plansFile(cjs));
});

test("not proven, so no ownership file: Express 5, an old or open-ended Express 4 range, and anything in the file that could answer first", () => {
  assert.equal(plansFile(app({ express: "^5.1.0" })), false, "Express 5 ignores dot-folders by default");
  for (const express of ["4.9.0", "^4", "4.x", ">=4.21.0", "*"]) assert.equal(plansFile(app({ express })), false, express);
  const not = [
    ["a mount elsewhere", SERVER("", "app.use('/assets', express.static('dist'))")],
    ["dotfiles ignore", SERVER("", "app.use(express.static('dist', { dotfiles: 'ignore' }))")],
    ["options from code", SERVER("const opts = {}\n", "app.use(express.static('dist', opts))")],
    ["a function option", SERVER("", "app.use(express.static('dist', { setHeaders: (res) => res.set('x', '1') }))")],
    ["another folder", SERVER("", "app.use(express.static('build'))")],
    ["a computed folder", SERVER("", "app.use(express.static(process.env.STATIC_DIR))")],
    ["a middleware of its own first", SERVER("app.use((req, res, next) => next())\n")],
    ["a third-party middleware first", SERVER("app.use(cors())\n").replace("import express from 'express'\n", "import express from 'express'\nimport cors from 'cors'\n")],
    ["a catch-all route first", SERVER("app.get('*', (req, res) => res.sendFile('index.html'))\n")],
    ["a route at the ownership path first", SERVER("app.get('/.well-known/parlox-verify', (req, res) => res.send('x'))\n")],
    ["a route with a parameter first", SERVER("app.get('/:page/:file', (req, res) => res.end())\n")],
    ["a mount above the ownership path first", SERVER("app.use('/.well-known', (req, res) => res.end())\n")],
    ["the app handed to other code first", SERVER("routes(app)\n").replace("import express from 'express'\n", "import express from 'express'\nimport routes from './routes.js'\n")],
    ["static only in production", SERVER("", "if (process.env.NODE_ENV === 'production') app.use(express.static('dist'))")],
    ["a handler added inside a function", SERVER("function setup() { app.use((req, res) => res.end()) }\nsetup()\n")],
    ["a folder that answers 404 without passing the request on", SERVER("app.use(express.static('assets', { fallthrough: false }))\n")],
  ];
  for (const [label, server] of not) assert.equal(plansFile(app({ server })), false, label);
  // Vite's build that does not copy the public folder into its output.
  assert.equal(plansFile(app({ config: UNPROVEN.replace("plugins:", "build: { copyPublicDir: false },\n  plugins:") })), false, "copyPublicDir: false");
  // Vite's public folder turned off: there is no file to plan.
  assert.equal(plansFile(app({ config: UNPROVEN.replace("plugins:", "publicDir: false,\n  plugins:") })), false, "publicDir: false");
});

test("another static folder before it: passed over when it holds no ownership file, the end of the proof when it holds one", () => {
  const server = SERVER("app.use(express.static('assets'))\n");
  assert.ok(plansFile(app({ server, extra: { "assets/logo.svg": "<svg/>" } })));
  const shadow = app({ server, extra: { "assets/.well-known/parlox-verify": "another-code\n" } });
  assert.equal(plansFile(shadow), false);
});

test("the version check: installed Express decides; without it, a 4.x range from 4.10 on", () => {
  const ok = (express, installed) => {
    const dir = fixture({ "package.json": JSON.stringify({ dependencies: { express } }) });
    if (installed) { mkdirSync(join(dir, "node_modules/express"), { recursive: true }); writeFileSync(join(dir, "node_modules/express/package.json"), JSON.stringify({ name: "express", version: installed })); }
    return servesDotFolders(dir, { dependencies: { express } });
  };
  assert.equal(ok("^4.21.2"), true);
  assert.equal(ok("~4.18.0"), true);
  assert.equal(ok("4.10.0"), true);
  assert.equal(ok("4.9.0"), false);
  assert.equal(ok("^4.21.2", "5.1.0"), false, "the installed version decides");
  assert.equal(ok("^5.0.0", "4.21.2"), true, "the installed version decides");
  assert.equal(ok("^4.21.2", "4.9.1"), false);
  // The folders, in the order a request reaches them.
  assert.deepEqual(verifyFolders(fixture({ "package.json": "{}" }), { dependencies: { express: "^4.21.2" } }, "server.js", "import express from 'express'\nconst app = express()\napp.use(express.static('a'))\napp.use(express.static('b'))\n", "app", () => false), ["a", "b"]);
});
