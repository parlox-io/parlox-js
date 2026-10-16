import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { viteVue } from "../dist/integrations/vite-vue.js";
import { viteReact } from "../dist/integrations/vite-react.js";
import { isViteSpa, secretExposureOf, viteServerKind } from "../dist/integrations/vite-spa.js";
import { INTEGRATIONS } from "../dist/integrations/registry.js";
import { describeUnit, hostStepFor, planUnit, scanApps, unplanUnit } from "../dist/apps.js";
import { applyPlan } from "../dist/plan-core.js";
import { readInside } from "../dist/fs-safe.js";
import { vercelHost } from "../dist/hosts.js";
import { main } from "../dist/cli.js";
import { BROWSER_VERSION, SERVER_VERSION, VERCEL_FUNCTIONS_VERSION } from "../dist/versions.js";
import { startFakeAuth, startFakeGateway } from "./fake-servers.mjs";
import { fixture } from "./helpers.mjs";

// Vite Vue: vue and vite in package.json, no next. The browser part is init({ publicKey }) right after the imports of
// the entry index.html names (edits/vite-init.ts); everything about Vite itself (the Vercel middleware or the ownership
// file, the exposure checks, the notes, the uninstall) is Vite React's (integrations/vite-spa.ts).

const PK = "pk_" + "b2".repeat(12);
// As create-vite 9.2.1 writes them (template vue-ts): src/main.ts, index.html, vite.config.ts.
const MAIN_TS = "import { createApp } from 'vue'\nimport './style.css'\nimport App from './App.vue'\n\ncreateApp(App).mount('#app')\n";
const INDEX_HTML = '<!doctype html>\n<html lang="en">\n  <head>\n    <meta charset="UTF-8" />\n    <link rel="icon" type="image/svg+xml" href="/favicon.svg" />\n    <meta name="viewport" content="width=device-width, initial-scale=1.0" />\n    <title>vite-vue-ts</title>\n  </head>\n  <body>\n    <div id="app"></div>\n    <script type="module" src="/src/main.ts"></script>\n  </body>\n</html>\n';
const VUE_CONFIG = "import vue from '@vitejs/plugin-vue'\nimport { defineConfig } from 'vite'\n\n// https://vite.dev/config/\nexport default defineConfig({\n  plugins: [vue()],\n})\n";
const EXPOSING = "import vue from '@vitejs/plugin-vue'\nimport { defineConfig } from 'vite'\n\nexport default defineConfig({\n  plugins: [vue()],\n  envPrefix: ['VITE_', 'PARLOX_'],\n})\n";
const pkgJson = (extra = {}) => JSON.stringify({ name: "shop", private: true, type: "module", scripts: { dev: "vite", build: "vite build", preview: "vite preview" }, dependencies: { vue: "^3.5.42" }, devDependencies: { "@vitejs/plugin-vue": "^6.0.8", vite: "^8.3.0" }, ...extra });
/** A create-vite Vue app; a file given as undefined is left out. */
const app = (files = {}) => fixture(Object.fromEntries(Object.entries({ "package.json": pkgJson(), "package-lock.json": "{}", "tsconfig.json": "{}", "index.html": INDEX_HTML, "vite.config.ts": VUE_CONFIG, "src/main.ts": MAIN_TS, ...files }).filter(([, v]) => v !== undefined)));
const git = { isRepo: () => false, dirty: () => [], isTracked: () => false, isIgnored: () => false };
const reader = (dir) => (rel) => (existsSync(join(dir, rel)) ? readFileSync(join(dir, rel), "utf8") : null);
const OTHER = { id: "netlify", label: "Netlify", where: "Project configuration → Environment variables", docs: null, vercelDir: null };
const input = (dir, host, extra = {}) => ({ publicKey: PK, verifyToken: "vt_fake", host, versions: { browser: BROWSER_VERSION, server: SERVER_VERSION }, parts: { browser: true, server: true }, read: reader(dir), git, ...extra });
const self = (dir) => viteVue.detect(dir, dir);
const ROLE = { browser: true, server: true, unitHasBrowser: true };
const ADDED = `import App from './App.vue'\nimport { init } from '@parlox/browser'\ninit({ publicKey: '${PK}' })\n`;

test("registered right after Vite React; both are Vite single-page apps", () => {
  assert.deepEqual(INTEGRATIONS.map((i) => i.id), ["nextjs", "vite-react", "vite-vue", "express", "hono"]);
  assert.equal(viteVue.label, "Vite Vue");
  assert.deepEqual(["nextjs", "vite-react", "vite-vue", "express", "hono"].filter(isViteSpa), ["vite-react", "vite-vue"]);
});

test("detect: vue and vite without next; the entry from index.html's module script", () => {
  const d = self(app());
  assert.equal(d.integration, "vite-vue");
  assert.deepEqual(d.facts, [["Found", "Vite Vue · src/main.ts · TypeScript · npm"]]);
  assert.deepEqual(d.parts.browser, { file: "src/main.ts", kind: "vite-init" });
  assert.equal(d.parts.server.kind, "host-question", "no host file: the host is asked");
  assert.equal(d.envFile, null);
  assert.match(d.localCheck.skip, /only on Vercel/);
  assert.equal(self(app({ "vercel.json": "{}" })).parts.server.kind, "vercel-edge");
  assert.equal(self(app({ "netlify.toml": "" })).parts.server.kind, "verify-file");
  assert.deepEqual(self(app({ "tsconfig.json": undefined, "src/main.ts": undefined, "src/main.js": MAIN_TS, "index.html": INDEX_HTML.replace("main.ts", "main.js") })).facts, [["Found", "Vite Vue · src/main.js · JavaScript · npm"]]);
  // Not a Vite Vue app: no vite (Vue CLI builds with webpack), next, react without vue, nothing.
  const only = (deps) => self(fixture({ "package.json": JSON.stringify(deps) }));
  assert.equal(only({ dependencies: { vue: "^3.5.0" }, devDependencies: { "@vue/cli-service": "~5.0.0" } }), null, "Vue CLI");
  assert.equal(only({ dependencies: { vue: "^3.5.0", next: "16.0.1" }, devDependencies: { vite: "^8.3.0" } }), null);
  assert.equal(only({ dependencies: { react: "^19.2.0" }, devDependencies: { vite: "^8.3.0" } }), null);
  assert.equal(self(fixture({ "README.md": "" })), null);
  // Vite React does not take a Vue app, as before.
  assert.equal(viteReact.detect(app(), app()), null);
});

test("detect: Vue frameworks with their own server, entry or routing are declined with the guide; Vue's client-side libraries are not", () => {
  for (const [dep, name] of [["nuxt", "Nuxt"], ["nuxt3", "Nuxt"], ["nuxt-edge", "Nuxt"], ["nuxt-nightly", "Nuxt"], ["@tanstack/vue-start", "TanStack Start"], ["vike", "Vike"], ["vite-plugin-ssr", "Vike"], ["astro", "Astro"]]) {
    const dir = app({ "vercel.json": "{}", "package.json": pkgJson({ devDependencies: { vite: "^8.3.0", [dep]: "1.0.0" } }) });
    assert.throws(() => self(dir), (e) => e.code === "not-supported" && e.message === `${name} (${dep}) is a framework with its own server and routing, not a Vite Vue single-page app; the wizard does not cover it yet. See https://gateway.parlox.io/install.md`, dep);
    assert.equal(scanApps(dir).problems[0]?.error.message.includes(dep), true, dep);
  }
  for (const [dep, name] of [["vitepress", "VitePress"], ["vuepress", "VuePress"], ["vuepress-vite", "VuePress"], ["vite-ssg", "vite-ssg"], ["@quasar/app-vite", "Quasar CLI"], ["iles", "îles"], ["@slidev/cli", "Slidev"]]) {
    const dir = app({ "package.json": pkgJson({ devDependencies: { vite: "^8.3.0", [dep]: "1.0.0" } }) });
    assert.throws(() => self(dir), (e) => e.code === "not-supported" && e.message === `${name} (${dep}) builds the site from its own entry and routing, not a Vite Vue single-page app's index.html; the wizard does not cover it yet. See https://gateway.parlox.io/install.md`, dep);
  }
  // A Nuxt app need not declare vite itself (it comes with Nuxt): declined all the same.
  assert.throws(() => self(fixture({ "package.json": JSON.stringify({ dependencies: { nuxt: "^4.6.1", vue: "^3.5.0", "vue-router": "^4.6.0" } }) })), (e) => e.code === "not-supported" && e.message.startsWith("Nuxt (nuxt) is a framework"));
  for (const lib of ["vue-router", "pinia", "@vitejs/plugin-vue-jsx", "@quasar/vite-plugin", "@ionic/vue"]) {
    assert.equal(self(app({ "package.json": pkgJson({ dependencies: { vue: "^3.5.42", [lib]: "1.0.0" } }) }))?.integration, "vite-vue", lib);
  }
});

test("react and vue in one folder: Vite React's part as before, and Vite Vue's refusal said in the review, never a second Vite app", () => {
  const files = {
    "package.json": JSON.stringify({ name: "shop", type: "module", scripts: { build: "vite build" }, dependencies: { react: "^19.2.0", "react-dom": "^19.2.0", vue: "^3.5.42" }, devDependencies: { vite: "^8.3.0" } }),
    "package-lock.json": "{}", "index.html": '<div id="root"></div><script type="module" src="/src/main.jsx"></script>',
    "src/main.jsx": "import { createRoot } from 'react-dom/client'\nimport App from './App.jsx'\n\ncreateRoot(document.getElementById('root')).render(<App />)\n",
  };
  const dir = fixture(files);
  assert.throws(() => self(dir), (e) => e.code === "not-supported" && e.message === "This folder depends on both vue and react, so the wizard cannot tell which one renders the app, and adds no Vue browser part here (Vite React's part goes only into a createRoot(…).render(…) call). If Vue renders it, add the browser part by hand: see https://gateway.parlox.io/install.md");
  const [u] = scanApps(dir).units;
  assert.deepEqual(u.detections.map((d) => d.integration), ["vite-react"]);
  assert.equal(u.browser.integration, "vite-react");
  assert.ok(u.warnings.includes("Vite Vue: This folder depends on both vue and react, so the wizard cannot tell which one renders the app, and adds no Vue browser part here (Vite React's part goes only into a createRoot(…).render(…) call). If Vue renders it, add the browser part by hand: see https://gateway.parlox.io/install.md"), u.warnings.join("\n"));
  assert.equal(describeUnit(u), "./ · Vite React · browser part (server part if it deploys on Vercel)");
  // Without vite, neither is a Vite app, and nothing is said about either.
  const noVite = JSON.parse(files["package.json"]);
  delete noVite.devDependencies.vite;
  assert.deepEqual(scanApps(fixture({ ...files, "package.json": JSON.stringify(noVite) })).units, []);
});

test("off Vercel: the init lines and the ownership file; no server part, and the report says crawlers are not seen", () => {
  const dir = app({ "netlify.toml": "" });
  const d = self(dir);
  const plan = viteVue.plan(d, input(dir, OTHER));
  assert.deepEqual(plan.changes.map((c) => [c.path, c.purpose]), [["src/main.ts", "browser part"], ["public/.well-known/parlox-verify", "ownership proof"]]);
  assert.equal(plan.changes[0].after, MAIN_TS.replace("import App from './App.vue'\n", ADDED));
  assert.equal(plan.changes[1].after, "vt_fake\n");
  assert.deepEqual(plan.manual, []);
  assert.deepEqual(plan.install, { command: "npm", args: ["install", "--save-exact", `@parlox/browser@${BROWSER_VERSION}`] });
  assert.equal(viteVue.hostStep(d, OTHER), false);
  assert.match(viteVue.hostNotes(d, OTHER, ROLE).join("\n"), /^Crawlers that do not run JavaScript are not seen on this host: they never run the browser part, and the site has no server of its own\. Deploy on Vercel, or add a server, to see them\.$/);
  assert.deepEqual(d.notes, []);
});

test("on Vercel: the init lines and the Routing Middleware; @parlox/server and @vercel/functions are added", () => {
  const dir = app({ "vercel.json": "{}" });
  const d = self(dir);
  const host = vercelHost(null);
  assert.equal(viteServerKind(host, d.data), "vercel-edge");
  const plan = viteVue.plan(d, input(dir, host));
  assert.deepEqual(plan.changes.map((c) => c.path), ["src/main.ts", "middleware.ts"]);
  assert.deepEqual(plan.install.args, ["install", "--save-exact", `@parlox/browser@${BROWSER_VERSION}`, `@parlox/server@${SERVER_VERSION}`, `@vercel/functions@${VERCEL_FUNCTIONS_VERSION}`]);
  assert.equal(viteVue.hostStep(d, host), true);
  assert.match(viteVue.hostNotes(d, host, ROLE).join("\n"), /runs on every page request/);
  // A JavaScript app gets middleware.js.
  const js = app({ "vercel.json": "{}", "tsconfig.json": undefined });
  assert.deepEqual(viteVue.plan(self(js), input(js, host)).changes.map((c) => c.path), ["src/main.ts", "middleware.js"]);
  // The browser part alone (another integration's server in the same folder): no middleware, no server packages.
  const browserOnly = viteVue.plan(d, input(dir, host, { parts: { browser: true, server: false } }));
  assert.deepEqual(browserOnly.changes.map((c) => c.path), ["src/main.ts"]);
  assert.deepEqual(browserOnly.install.args, ["install", "--save-exact", `@parlox/browser@${BROWSER_VERSION}`]);
});

test("create-vite's vue-ts build (vue-tsc -b && vite build) is proven safe only where vue-tsc's tsconfig chain can be read", () => {
  const vueTs = {
    "vercel.json": "{}", "package.json": pkgJson({ scripts: { dev: "vite", build: "vue-tsc -b && vite build", preview: "vite preview" }, devDependencies: { "@vitejs/plugin-vue": "^6.0.8", "@vue/tsconfig": "^0.9.1", vite: "^8.3.0", "vue-tsc": "^3.3.11" } }),
    "tsconfig.json": JSON.stringify({ files: [], references: [{ path: "./tsconfig.app.json" }, { path: "./tsconfig.node.json" }] }),
    "tsconfig.app.json": JSON.stringify({ extends: "@vue/tsconfig/tsconfig.dom.json", compilerOptions: { types: ["vite/client"] }, include: ["src/**/*.ts", "src/**/*.vue"] }),
    "tsconfig.node.json": JSON.stringify({ compilerOptions: { noEmit: true }, include: ["vite.config.ts"] }),
  };
  const installed = { "node_modules/@vue/tsconfig/tsconfig.dom.json": JSON.stringify({ extends: "./tsconfig.json", compilerOptions: { lib: ["ES2022", "DOM"] } }), "node_modules/@vue/tsconfig/tsconfig.json": JSON.stringify({ compilerOptions: { noEmit: true, jsxImportSource: "vue" } }) };
  const host = vercelHost(null);
  const withDeps = app({ ...vueTs, ...installed });
  assert.equal(self(withDeps).parts.server.kind, "vercel-edge");
  assert.deepEqual(viteVue.plan(self(withDeps), input(withDeps, host)).changes.map((c) => c.path), ["src/main.ts", "middleware.ts"]);
  // Before an install (no node_modules), what vue-tsc loads cannot be read: the ownership file instead, and why.
  const fresh = app(vueTs);
  const d = self(fresh);
  assert.equal(d.parts.server.kind, "verify-file");
  assert.match(d.data.exposure.why, /^vue-tsc runs in the build, and the wizard cannot read tsconfig\.app\.json's extends "@vue\/tsconfig\/tsconfig\.dom\.json"/);
  assert.deepEqual(viteVue.plan(d, input(fresh, host)).changes.map((c) => c.path), ["src/main.ts", "public/.well-known/parlox-verify"]);
  assert.equal(viteVue.hostStep(d, host), false);
});

test("on Vercel, a Vite config that could bundle the secret key: the browser part and the ownership file only, no middleware, no host step, and the reason in the review", () => {
  const dir = app({ "vercel.json": "{}", "vite.config.ts": EXPOSING });
  const d = self(dir);
  const host = vercelHost(null);
  assert.equal(d.parts.server.kind, "verify-file");
  assert.equal(viteVue.hostStep(d, host), false);
  const plan = viteVue.plan(d, input(dir, host));
  assert.deepEqual(plan.changes.map((c) => c.path), ["src/main.ts", "public/.well-known/parlox-verify"]);
  assert.deepEqual(plan.install.args, ["install", "--save-exact", `@parlox/browser@${BROWSER_VERSION}`]);
  const warning = "Your Vite config lists PARLOX_ in envPrefix, so the secret key would be bundled into the browser code. Parlox set up the browser part only; remove PARLOX_ from envPrefix and run the wizard again to add the server part.";
  assert.deepEqual(plan.warnings, [warning]);
  assert.deepEqual(d.notes, [warning]);
  assert.deepEqual(secretExposureOf([d]), d.data.exposure);
});

test("uninstall: the entry, the middleware and the ownership file go back byte for byte; the packages the wizard adds are removed", () => {
  const dir = app({ "vercel.json": "{}" });
  const before = readFileSync(join(dir, "src/main.ts"), "utf8");
  applyPlan(dir, viteVue.plan(self(dir), input(dir, vercelHost(null))));
  applyPlan(dir, viteVue.plan(self(dir), input(dir, OTHER)));   // the ownership file too
  assert.equal(readFileSync(join(dir, "src/main.ts"), "utf8"), MAIN_TS.replace("import App from './App.vue'\n", ADDED));
  assert.equal(existsSync(join(dir, "middleware.ts")), true);
  const un = viteVue.unplan(self(dir), { read: reader(dir), git });
  assert.deepEqual(un.manual, []);
  applyPlan(dir, un);
  assert.equal(readFileSync(join(dir, "src/main.ts"), "utf8"), before);
  assert.equal(existsSync(join(dir, "middleware.ts")), false);
  assert.equal(existsSync(join(dir, "public/.well-known/parlox-verify")), false);
  const declared = app({ "package.json": pkgJson({ dependencies: { vue: "^3.5.42", "@parlox/browser": BROWSER_VERSION, "@parlox/server": SERVER_VERSION } }) });
  assert.deepEqual(viteVue.unplan(self(declared), { read: reader(declared), git }).install, { command: "npm", args: ["uninstall", "@parlox/browser", "@parlox/server"] });
  // Another use of the package left in the entry: named for the developer, since the package goes.
  const track = app({ "src/main.ts": MAIN_TS.replace("import App from './App.vue'\n", `${ADDED}import { track } from '@parlox/browser'\n`) });
  const t = viteVue.unplan(self(track), { read: reader(track), git });
  assert.deepEqual(t.changes.map((c) => [c.path, c.after]), [["src/main.ts", MAIN_TS.replace("import App from './App.vue'\n", "import App from './App.vue'\nimport { track } from '@parlox/browser'\n")]]);
  assert.deepEqual(t.manual.map((m) => [m.file, m.part, m.reason]), [["src/main.ts", "browser", "Line 4 still uses @parlox/browser, which the uninstall removes; remove that line by hand."]]);
  // No entry to look in, with the package declared: a step by hand that says what to look for.
  const lost = app({ "index.html": "<div id=app></div>\n", "package.json": pkgJson({ dependencies: { vue: "^3.5.42", "@parlox/browser": BROWSER_VERSION } }) });
  const l = viteVue.unplan(self(lost), { read: reader(lost), git });
  assert.deepEqual(l.manual.map((m) => [m.file, m.reason, m.snippet]), [["index.html", "index.html has no single <script type=\"module\" src=\"…\"> of the app's own. The wizard cannot find Parlox's init() call to take out.", "Remove `import { init } from \"@parlox/browser\"` and the init({ publicKey: … }) call by hand."]]);
});

test("the browser part is a step by hand, with the snippet, where the entry cannot be edited exactly or cannot be found", () => {
  const snippet = `import { init } from "@parlox/browser";\ninit({ publicKey: "${PK}" });`;
  const clash = app({ "netlify.toml": "", "src/main.ts": "import { createApp } from 'vue'\nimport { init } from './setup'\n\ninit()\ncreateApp({}).mount('#app')\n" });
  const c = viteVue.plan(self(clash), input(clash, OTHER));
  assert.deepEqual(c.changes.map((x) => x.path), ["public/.well-known/parlox-verify"]);
  assert.deepEqual(c.manual.map((m) => [m.file, m.part, m.snippet]), [["src/main.ts", "browser", snippet]]);
  assert.match(c.manual[0].reason, /^This file already has something named init/);
  assert.deepEqual(c.install.args, ["install", "--save-exact", `@parlox/browser@${BROWSER_VERSION}`], "the package still goes in, for the pasted lines");
  const none = app({ "netlify.toml": "", "index.html": "<div id=app></div>\n" });
  const n = viteVue.plan(self(none), input(none, OTHER));
  assert.deepEqual(n.manual.map((m) => [m.file, m.part, m.snippet]), [["index.html", "browser", snippet]]);
  assert.match(n.manual[0].reason, /has no single <script type="module"/);
});

test("an app that declares @parlox/browser without the wizard's lines in its entry: a step by hand, since Parlox may already start elsewhere with options of its own", () => {
  const declared = app({ "netlify.toml": "", "package.json": pkgJson({ dependencies: { vue: "^3.5.42", "@parlox/browser": BROWSER_VERSION } }) });
  const plan = viteVue.plan(self(declared), input(declared, OTHER));
  assert.deepEqual(plan.changes.map((c) => c.path), ["public/.well-known/parlox-verify"]);
  assert.deepEqual(plan.manual.map((m) => [m.file, m.part]), [["src/main.ts", "browser"]]);
  assert.equal(plan.manual[0].reason, `@parlox/browser is already in package.json, but src/main.ts does not start it the way the wizard writes it, so Parlox may already start elsewhere in this app with options of its own (consent: "required"): a second init() here would run first, and those options would not apply. If nothing starts Parlox yet, add the lines below.`);
  // With the wizard's lines already there: nothing to change.
  const installed = app({ "netlify.toml": "", "package.json": pkgJson({ dependencies: { vue: "^3.5.42", "@parlox/browser": BROWSER_VERSION } }), "src/main.ts": MAIN_TS.replace("import App from './App.vue'\n", ADDED) });
  const again = viteVue.plan(self(installed), input(installed, OTHER));
  assert.deepEqual(again.changes.map((c) => c.path), ["public/.well-known/parlox-verify"]);
  assert.deepEqual(again.manual, []);
  assert.equal(again.install, null);
});

// ---- A Vite Vue app beside an Express server in the same folder ----

const SERVER = "import express from 'express'\n\nconst app = express()\napp.use(express.static('dist'))\napp.listen(3000)\n";
const MAIN_JS = "import { createApp } from 'vue'\nimport App from './App.vue'\n\ncreateApp(App).mount('#app')\n";
const vueExpress = (config, express = "^5.1.0", extra = {}) => fixture({
  "package.json": JSON.stringify({ name: "shop", type: "module", scripts: { dev: "vite", build: "vite build", start: "node server.js" }, dependencies: { express, vue: "^3.5.42" }, devDependencies: { "@vitejs/plugin-vue": "^6.0.8", vite: "^8.3.0" } }),
  "package-lock.json": "{}", "render.yaml": "",
  "index.html": '<!doctype html>\n<html>\n  <head></head>\n  <body>\n    <div id="app"></div>\n    <script type="module" src="/src/main.js"></script>\n  </body>\n</html>\n',
  "src/main.js": MAIN_JS, "vite.config.js": config, "server.js": SERVER, ...extra,
});
const RENDER = { id: "render", label: "Render", where: "", docs: null, vercelDir: null };
const unitInput = { publicKey: PK, verifyToken: "vt_fake", host: RENDER };

test("Vite Vue and Express in one folder: the browser part in the Vue entry, the server part in the Express file", () => {
  const dir = vueExpress(VUE_CONFIG);
  const [u] = scanApps(dir).units;
  assert.equal(u.browser.integration, "vite-vue");
  assert.equal(u.server.integration, "express");
  assert.equal(describeUnit(u), "./ · Vite Vue + Express · browser and server parts");
  const plan = planUnit(u, unitInput, { read: reader(dir), git });
  assert.deepEqual(plan.changes.map((c) => c.path).sort(), ["server.js", "src/main.js"]);
  assert.equal(plan.changes.find((c) => c.path === "src/main.js").after, MAIN_JS.replace("import App from './App.vue'\n", `import App from './App.vue'\nimport { init } from '@parlox/browser'\ninit({ publicKey: '${PK}' })\n`));
  assert.ok(plan.install.args.includes(`@parlox/server@${SERVER_VERSION}`));
  assert.equal(hostStepFor(u, RENDER), true);
  // Uninstall: both files back.
  applyPlan(dir, plan);
  const [after] = scanApps(dir).units;
  const un = unplanUnit(after, { read: reader(dir), git });
  applyPlan(dir, un);
  assert.equal(readFileSync(join(dir, "src/main.js"), "utf8"), MAIN_JS);
  assert.equal(readFileSync(join(dir, "server.js"), "utf8"), SERVER);
});

test("when the folder's Vite Vue build could bundle PARLOX_SECRET_KEY, the Express server part gets no edit, no key and no host step; the warning says why", () => {
  const dir = vueExpress(EXPOSING);
  const [u] = scanApps(dir).units;
  assert.equal(u.server, null);
  assert.equal(u.withheld.detection.integration, "express");
  assert.match(u.warnings[0], /^Express: no server part was added\. Your Vite config lists PARLOX_ in envPrefix, so the secret key would be bundled into the browser code\. A PARLOX_SECRET_KEY set on the host for this server could also reach this folder's Vite build \(hosts usually give the build the same variables\)\. Remove PARLOX_ from envPrefix and run the wizard again to add the server part\.$/);
  assert.equal(hostStepFor(u, RENDER), false);
  assert.equal(describeUnit(u), "./ · Vite Vue + Express · browser part");
  const plan = planUnit(u, unitInput, { read: reader(dir), git });
  assert.deepEqual(plan.changes.map((c) => c.path), ["src/main.js"]);
  assert.equal(plan.install.args.some((a) => a.startsWith("@parlox/server")), false);
});

test("beside Express, a Vite Vue app's own config check decides as a Vite React app's does, whatever the build commands; a Vite framework no integration detects is left to the build commands", () => {
  const SERVER_ONLY = "import express from 'express'\nconst app = express()\napp.listen(3000)\n";
  const PREFIX = "import { defineConfig } from 'vite'\nexport default defineConfig({\n  envPrefix: ['VITE_', 'PARLOX_'],\n})\n";
  const unit = (framework) => scanApps(fixture({ "package.json": JSON.stringify({ type: "module", scripts: { build: "tsc", start: "node server.js" }, dependencies: { express: "^5.1.0", ...framework }, devDependencies: { vite: "^7.2.0" } }), "package-lock.json": "{}", "server.js": SERVER_ONLY, "vite.config.js": PREFIX })).units[0];
  const react = unit({ react: "^19.2.0", "react-dom": "^19.2.0" }), vue = unit({ vue: "^3.5.42" }), svelte = unit({ svelte: "^5.0.0" });
  for (const u of [react, vue]) {
    assert.equal(u.server, null, u.detections[0].integration);
    assert.match(u.warnings.find((w) => w.startsWith("Express: no server part was added.")), /Your Vite config lists PARLOX_ in envPrefix/);
  }
  assert.deepEqual(react.warnings, vue.warnings);
  assert.equal(svelte.server.integration, "express", "tsc never runs Vite, and nothing else checks the config");
});

test("Express 4 serving the Vite Vue build, its server part withheld: the ownership file goes in Vite's public folder", () => {
  const UNPROVEN = "import { defineConfig } from 'vite'\nexport default defineConfig({\n  plugins: [{ name: 'mine', config: () => ({}) }],\n})\n";
  const dir = vueExpress(UNPROVEN, "^4.21.2");
  const [u] = scanApps(dir).units;
  assert.equal(u.server, null, "withheld");
  assert.equal(u.withheld.verifyFrom, "dist");
  const plan = planUnit(u, unitInput, { read: (f) => readInside(dir, f), git });
  assert.deepEqual(plan.changes.map((c) => c.path).sort(), ["public/.well-known/parlox-verify", "src/main.js"]);
  assert.ok(u.warnings.includes("Express: the ownership file goes in public/.well-known/parlox-verify: Express 4 serves dist/ (express.static in server.js), where Vite copies the public folder when it builds."), u.warnings.join("\n"));
  // Express 5 does not serve files inside .well-known/: no ownership file.
  const five = vueExpress(UNPROVEN, "^5.1.0");
  assert.deepEqual(planUnit(scanApps(five).units[0], unitInput, { read: (f) => readInside(five, f), git }).changes.map((c) => c.path), ["src/main.js"]);
});

test("Express only in devDependencies beside a Vite Vue app is a dev helper: the Vercel middleware is the server part", () => {
  const dir = fixture({
    "package.json": JSON.stringify({ type: "module", scripts: { dev: "node server.js", build: "vite build" }, dependencies: { vue: "^3.5.42" }, devDependencies: { express: "^5.1.0", "@vitejs/plugin-vue": "^6.0.8", vite: "^8.3.0" } }),
    "package-lock.json": "{}", "vercel.json": "{}", "index.html": '<div id="app"></div><script type="module" src="/src/main.js"></script>', "src/main.js": MAIN_JS, "vite.config.js": VUE_CONFIG,
    "server.js": "import express from 'express'\nimport { createServer } from 'vite'\nconst app = express()\nconst vite = await createServer({ server: { middlewareMode: true } })\napp.use(vite.middlewares)\napp.listen(5173)\n",
  });
  const [u] = scanApps(dir).units;
  assert.equal(u.server.integration, "vite-vue");
  assert.equal(u.server.parts.server.kind, "vercel-edge");
  assert.equal(describeUnit(u), "./ · Vite Vue + Express · browser part (server part on Vercel)");
});

test("in a monorepo scan, a Vite Vue app and a Vite React app each say where their server part comes from", () => {
  const root = fixture({
    "package.json": JSON.stringify({ name: "mono", private: true, workspaces: ["apps/*"] }), "package-lock.json": "{}",
    "apps/shop/package.json": pkgJson(), "apps/shop/vercel.json": "{}", "apps/shop/index.html": INDEX_HTML, "apps/shop/vite.config.ts": VUE_CONFIG, "apps/shop/src/main.ts": MAIN_TS,
    "apps/blog/package.json": pkgJson(), "apps/blog/netlify.toml": "", "apps/blog/index.html": INDEX_HTML, "apps/blog/src/main.ts": MAIN_TS,
    "apps/docs/package.json": pkgJson({ devDependencies: { vite: "^8.3.0", vitepress: "^1.6.4" } }),
    "apps/web/package.json": JSON.stringify({ name: "web", dependencies: { react: "^19.2.0", "react-dom": "^19.2.0" }, devDependencies: { vite: "^8.3.0" } }), "apps/web/index.html": '<script type="module" src="/src/main.jsx"></script>', "apps/web/src/main.jsx": "import { createRoot } from 'react-dom/client'\ncreateRoot(root).render(<App />)\n",
  });
  const scan = scanApps(root);
  assert.deepEqual(scan.units.map(describeUnit), [
    "apps/blog/ · Vite Vue · browser part only (static site)",
    "apps/shop/ · Vite Vue · browser part (server part on Vercel)",
    "apps/web/ · Vite React · browser part (server part if it deploys on Vercel)",
  ]);
  assert.deepEqual(scan.problems.map((p) => p.rel), ["apps/docs"]);
});

// ---- A full run: a key already set on the Vercel project of a static Vite Vue site ----

const G = ["-c", "user.email=t@t", "-c", "user.name=t"];
const gitInit = (dir) => { execFileSync("git", [...G, "init", "-q"], { cwd: dir }); execFileSync("git", [...G, "add", "-A"], { cwd: dir }); execFileSync("git", [...G, "commit", "-qm", "init"], { cwd: dir }); };

test("a key already set on a static Vite Vue site's Vercel project: no key is created, and the report asks to check that it is crawler-only", async (t) => {
  const auth = await startFakeAuth({ decide: "approve" });
  const gw = await startFakeGateway({ sites: [{ id: "11111111-1111-1111-1111-111111111111", name: "Shop", domain: "shop.example.com", public_key: PK, verified: false }], keys: [] });
  t.after(() => { auth.close(); gw.close(); });
  const config = { gateway: gw.url, supabaseUrl: auth.url, clientId: "wiz", apiKey: "k", ports: [53992, 53993], dashboard: "https://app.parlox.io" };
  const dir = app({ ".vercel/project.json": JSON.stringify({ projectName: "shop-prod" }), ".gitignore": ".vercel\n" });
  gitInit(dir);
  const out = [], reports = [];
  const run = (cmd, args) => (cmd === "vercel" && args[1] === "ls" ? { status: 0, stdout: " PARLOX_SECRET_KEY  Encrypted  Production\n", stderr: "" } : { status: 0, stdout: "", stderr: "" });
  const ui = { info: (m) => out.push(m), warn: (m) => out.push(`WARN ${m}`), confirm: async () => true, select: async (_m, o) => o[0].value, text: async () => "", report: (lines) => reports.push(...lines) };
  const code = await main(["--yes", "--vercel", "--site", "shop.example.com", "--skip-check"], { cwd: dir, config, ui, run, open: (u) => { if (!u.includes("newKey")) fetch(u).catch(() => {}); } });
  assert.equal(code, 0, out.join("\n"));
  assert.deepEqual(gw.state.keys, [], "no key was created");
  assert.equal(existsSync(join(dir, "middleware.ts")), true);
  assert.equal(readFileSync(join(dir, "src/main.ts"), "utf8"), MAIN_TS.replace("import App from './App.vue'\n", ADDED));
  const line = reports.find((l) => l.startsWith("PARLOX_SECRET_KEY was already set on Vercel"));
  assert.ok(line && line.includes('check in Settings → Keys that this key is "Crawler reports only"'), reports.join("\n"));
});
