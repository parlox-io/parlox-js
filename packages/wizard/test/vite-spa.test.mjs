import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describeUnit, hostStepFor, planUnit, scanApps } from "../dist/apps.js";
import { applyPlan } from "../dist/plan-core.js";
import { vercelHost } from "../dist/hosts.js";
import { fixture } from "./helpers.mjs";

// What Vite React and Vite Vue share as Vite single-page apps (integrations/vite-spa.ts), tested on both.

const PK = "pk_" + "e5".repeat(12);
const git = { isRepo: () => false, dirty: () => [], isTracked: () => false, isIgnored: () => false };
const reader = (dir) => (rel) => (existsSync(join(dir, rel)) ? readFileSync(join(dir, rel), "utf8") : null);
const VERCEL = vercelHost(null);
const FRAMEWORKS = {
  react: {
    deps: { react: "^19.2.0", "react-dom": "^19.2.0" }, dev: { "@vitejs/plugin-react": "^6.1.1" }, label: "Vite React",
    entry: "src/main.jsx", main: "import { createRoot } from 'react-dom/client'\nimport App from './App.jsx'\n\ncreateRoot(document.getElementById('root')).render(<App />)\n",
    config: "import { defineConfig } from 'vite'\nimport react from '@vitejs/plugin-react'\n\nexport default defineConfig({\n  plugins: [react()],\n})\n",
  },
  vue: {
    deps: { vue: "^3.5.42" }, dev: { "@vitejs/plugin-vue": "^6.0.8" }, label: "Vite Vue",
    entry: "src/main.js", main: "import { createApp } from 'vue'\nimport App from './App.vue'\n\ncreateApp(App).mount('#app')\n",
    config: "import vue from '@vitejs/plugin-vue'\nimport { defineConfig } from 'vite'\n\nexport default defineConfig({\n  plugins: [vue()],\n})\n",
  },
};
/** A Vite single-page app of `fw` (a file given as undefined is left out). */
const spa = (fw, { pkg = {}, ...files } = {}) => {
  const f = FRAMEWORKS[fw];
  const all = {
    "package.json": JSON.stringify({ name: "shop", type: "module", ...pkg, scripts: { dev: "vite", build: "vite build", ...pkg.scripts }, dependencies: { ...f.deps, ...pkg.dependencies }, devDependencies: { vite: "^8.3.0", ...f.dev, ...pkg.devDependencies } }),
    "package-lock.json": "{}", "index.html": `<!doctype html>\n<html>\n  <head>\n    <title>shop</title>\n  </head>\n  <body>\n    <div id="app"></div>\n    <script type="module" src="/${f.entry}"></script>\n  </body>\n</html>\n`,
    [f.entry]: f.main, "vite.config.js": f.config, ...files,
  };
  return fixture(Object.fromEntries(Object.entries(all).filter(([, v]) => v !== undefined)));
};
const unitOf = (dir) => scanApps(dir).units[0];

// ---- The server part of a Vite app on Vercel: every Vite build its key could reach is checked ----

const EXPOSING_BELOW = { "client/package.json": JSON.stringify({ scripts: { build: "vite build" }, devDependencies: { vite: "^8.3.0" } }), "client/vite.config.js": "import { defineConfig } from 'vite'\nexport default defineConfig({ envPrefix: ['VITE_', 'PARLOX_'] })\n" };
const NAMING_BELOW = { "client/vite.config.js": "export default { define: { K: process.env.PARLOX_SECRET_KEY } }\n" };
const DEV_EXPRESS = { pkg: { scripts: { dev: "node server.js" }, devDependencies: { express: "^5.1.0" } }, "server.js": "import express from 'express'\nconst app = express()\napp.listen(5173)\n" };

for (const fw of Object.keys(FRAMEWORKS)) {
  test(`${FRAMEWORKS[fw].label} on Vercel, alone or beside a dev-only Express: a Vite app below it that could bundle the key, or a Vite config there naming the key, withholds the middleware and its key`, () => {
    for (const [label, extra] of [["alone", {}], ["beside a dev-only Express", DEV_EXPRESS]]) {
      const plain = unitOf(spa(fw, { "vercel.json": "{}", ...extra }));
      assert.equal(plain.server.integration, `vite-${fw}`, label);
      assert.equal(plain.server.parts.server.kind, "vercel-edge", `${label}: nothing below it, the middleware as before`);
      assert.equal(hostStepFor(plain, VERCEL), true, label);
      for (const [what, below, why] of [
        ["an exposing config below", EXPOSING_BELOW, /^In client\/: Your Vite config lists PARLOX_ in envPrefix, so the secret key would be bundled into the browser code\./],
        ["a config below naming the key", NAMING_BELOW, /^In client\/: vite\.config\.js names PARLOX_SECRET_KEY \(line 1\)/],
      ]) {
        const dir = spa(fw, { "vercel.json": "{}", ...extra, ...below });
        const u = unitOf(dir);
        assert.equal(u.server.integration, `vite-${fw}`, `${label}, ${what}`);
        assert.equal(u.server.parts.server.kind, "verify-file", `${label}, ${what}`);
        assert.equal(hostStepFor(u, VERCEL), false, `${label}, ${what}: no key is set`);
        assert.match(u.server.data.exposure.why, why, `${label}, ${what}`);
        assert.match(u.server.notes[0], why, `${label}, ${what}: said in the review and the report`);
        const plan = planUnit(u, { publicKey: PK, verifyToken: "vt_fake", host: VERCEL }, { read: reader(dir), git });
        assert.deepEqual(plan.changes.map((c) => c.path).filter((p) => !p.startsWith("src/")), ["public/.well-known/parlox-verify"], `${label}, ${what}: the ownership file only`);
        assert.equal(plan.install.args.some((a) => a.startsWith("@parlox/server")), false, `${label}, ${what}`);
      }
      // A link to a folder below it is not looked into, so it is not proven safe.
      const linked = spa(fw, { "vercel.json": "{}", ...extra });
      symlinkSync(fixture({ "vite.config.js": "export default {}\n" }), join(linked, "shared"));
      const l = unitOf(linked);
      assert.equal(l.server.parts.server.kind, "verify-file", `${label}, a linked folder`);
      assert.match(l.server.data.exposure.why, /^The wizard did not look inside shared\/, a link to another folder/, `${label}, a linked folder`);
    }
  });
}

// ---- A Parlox start already in the index.html Vite uses: no second start in the entry ----

const TAG = `<script async src="https://gateway.parlox.io/sdk/1.0.3/parlox.js" data-key="${PK}" data-consent="required"></script>`;
const page = (fw, head, body = "") => `<!doctype html>\n<html>\n  <head>\n    <title>shop</title>\n${head}  </head>\n  <body>\n    <div id="app"></div>\n${body}    <script type="module" src="/${FRAMEWORKS[fw].entry}"></script>\n  </body>\n</html>\n`;
const TAG_MANAGER = "Parlox starts once per page, with the options of whichever start runs first. If a tag manager (Google Tag Manager, say) also loads Parlox's tag on this site, the wizard cannot see it in your files: keep one of the two, since a start there with data-consent=\"required\" could otherwise be set aside.";
const startReason = (line) => `index.html already starts Parlox on line ${line} (a Parlox script tag, or a module that loads @parlox/browser), so the wizard adds no second start: Parlox keeps the first start of a page, and another one could run first and set aside that start's options (data-consent="required", say). If that is this site's own start, nothing more is needed; to start Parlox from the app's code instead, remove it and run the wizard again.`;
const nothingToAdd = (line) => `Nothing to add while index.html starts Parlox (line ${line}).`;
const planOf = (dir, host = { id: "netlify", label: "Netlify", where: "", docs: null, vercelDir: null }) => planUnit(unitOf(dir), { publicKey: PK, verifyToken: "vt_fake", host }, { read: reader(dir), git });

for (const fw of Object.keys(FRAMEWORKS)) {
  const { entry, label } = FRAMEWORKS[fw];
  test(`${label}: a Parlox tag or a module loading @parlox/browser in index.html makes the browser part a step by hand; a tag manager's start cannot be seen, and the review says so`, () => {
    for (const [what, head, body, line] of [
      ["the hosted tag", `    ${TAG}\n`, "", 5],
      ["an inline module that loads @parlox/browser", "", `    <script type="module">\n      import { init } from "@parlox/browser"\n      init({ publicKey: "${PK}", consent: "required" })\n    </script>\n`, 9],
    ]) {
      const dir = spa(fw, { "netlify.toml": "", "index.html": page(fw, head, body) });
      const plan = planOf(dir);
      assert.deepEqual(plan.changes.map((c) => c.path), ["public/.well-known/parlox-verify"], `${what}: the entry is not changed`);
      assert.deepEqual(plan.manual, [{ file: "index.html", reason: startReason(line), snippet: nothingToAdd(line), part: "browser" }], what);
      assert.equal(plan.install, null, `${what}: no package for a start that is already there`);
      assert.equal(plan.warnings.includes(TAG_MANAGER), false, what);
    }
    // In an HTML comment it starts nothing: the browser part is added, with the note on a tag manager's start.
    const commented = spa(fw, { "netlify.toml": "", "index.html": page(fw, `    <!-- ${TAG} -->\n`) });
    const c = planOf(commented);
    assert.deepEqual(c.changes.map((x) => x.path), [entry, "public/.well-known/parlox-verify"]);
    assert.ok(c.warnings.includes(TAG_MANAGER), c.warnings.join("\n"));
    // Already installed by the wizard, with a tag added since: nothing to change, and the review says the page now
    // starts Parlox twice.
    const installed = spa(fw, { "netlify.toml": "" });
    applyPlan(installed, planOf(installed));
    writeFileSync(join(installed, "index.html"), page(fw, `    ${TAG}\n`));
    const again = planOf(installed);
    assert.deepEqual([again.changes, again.manual], [[], []]);
    assert.equal(again.warnings.includes(TAG_MANAGER), false);
    assert.ok(again.warnings.includes(`index.html also starts Parlox, on line 5, beside the wizard's start in ${entry}: the page starts Parlox twice, and only the first start's options apply (a data-consent="required" there could be set aside). Keep one of the two.`), again.warnings.join("\n"));
  });

  test(`${label}: a Parlox start in index.html comes before any other reason the entry cannot be edited: one step that says so, nothing to paste, no package`, () => {
    const refused = fw === "vue" ? "import { createApp } from 'vue'\nconst init = 1\ncreateApp({}).mount('#app')\n" : "console.log('no render call')\n";
    for (const [what, files] of [
      ["an entry the edit refuses", { [entry]: refused }],
      ["no module script with a src", { "index.html": page(fw, `    ${TAG}\n`).replace(`<script type="module" src="/${entry}"></script>`, `<script type="module">import './${entry}'</script>`) }],
      ["the entry file missing", { [entry]: undefined }],
    ]) {
      const dir = spa(fw, { "netlify.toml": "", "index.html": page(fw, `    ${TAG}\n`), ...files });
      const plan = planOf(dir);
      assert.deepEqual(plan.changes.map((c) => c.path), ["public/.well-known/parlox-verify"], what);
      assert.deepEqual(plan.manual, [{ file: "index.html", reason: startReason(5), snippet: nothingToAdd(5), part: "browser" }], what);
      assert.equal(plan.install, null, what);
    }
  });
}

// ---- Which part wins in a folder with Express pages and a Vite build: the one the wizard can add ----

const GENERATED = join(import.meta.dirname, "fixtures", "generated");
const UNPROVEN = "import { defineConfig } from 'vite'\nexport default defineConfig({\n  plugins: [{ name: 'mine', config: () => ({}) }],\n  build: { manifest: true, rollupOptions: { input: 'src/widgets.js' } },\n})\n";
/** An Express server with its own pages that also builds widgets with Vite (Vite's backend integration: no
 * index.html). */
const expressWithWidgets = (fw, express = "^4.21.2") => fixture({
  "package.json": JSON.stringify({ name: "shop", type: "module", scripts: { dev: "vite", build: "vite build", start: "node server.js" }, dependencies: { express, ejs: "^3.1.10", ...FRAMEWORKS[fw].deps }, devDependencies: { vite: "^8.3.0", ...FRAMEWORKS[fw].dev } }),
  "package-lock.json": "{}", "render.yaml": "", "vite.config.js": UNPROVEN, "src/widgets.js": FRAMEWORKS[fw].main,
  "server.js": "import express from 'express'\n\nconst app = express()\napp.use(express.static('dist'))\napp.set('view engine', 'ejs')\napp.get('/', (req, res) => res.render('index'))\napp.listen(3000)\n",
  "views/index.ejs": "<!doctype html>\n<html>\n  <head>\n    <title>shop</title>\n  </head>\n  <body></body>\n</html>\n",
});
const RENDER = { id: "render", label: "Render", where: "", docs: null, vercelDir: null };

for (const fw of Object.keys(FRAMEWORKS)) {
  const { label } = FRAMEWORKS[fw];
  test(`${label} without an index.html beside Express pages: the browser part goes in the pages, not a step by hand in the Vite entry; with an index.html the Vite entry still wins`, () => {
    // express-generator's Pug app, with the framework and Vite added (no index.html).
    const pug = fixture({});
    cpSync(join(GENERATED, "express-pug"), pug, { recursive: true });
    const pkg = JSON.parse(readFileSync(join(pug, "package.json"), "utf8"));
    writeFileSync(join(pug, "package.json"), JSON.stringify({ ...pkg, dependencies: { ...pkg.dependencies, ...FRAMEWORKS[fw].deps }, devDependencies: { vite: "^8.3.0", ...FRAMEWORKS[fw].dev } }));
    writeFileSync(join(pug, "render.yaml"), "");
    const u = unitOf(pug);
    assert.equal(u.browser.integration, "express");
    assert.equal(describeUnit(u), `./ · ${label} + Express · browser and server parts`);
    const plan = planUnit(u, { publicKey: PK, verifyToken: "vt_fake", host: RENDER }, { read: reader(pug), git });
    assert.deepEqual(plan.changes.map((c) => c.path).sort(), ["app.js", "views/layout.pug"]);
    assert.deepEqual(plan.manual, []);
    // An index.html that names the entry: the Vite entry, as before.
    const spaBeside = spa(fw, { pkg: { scripts: { start: "node server.js" }, dependencies: { express: "^5.1.0" } }, "server.js": "import express from 'express'\nconst app = express()\napp.use(express.static('dist'))\napp.listen(3000)\n", "views/index.ejs": "<html><head></head></html>\n" });
    assert.equal(unitOf(spaBeside).browser.integration, `vite-${fw}`);
  });

  test(`${label} without an index.html beside a withheld Express 4 server that serves its build: the tag in the pages, and the ownership file still planned`, () => {
    const dir = expressWithWidgets(fw);
    const u = unitOf(dir);
    assert.equal(u.server, null, "withheld: the Vite config is not proven safe");
    assert.equal(u.browser.integration, "express");
    assert.equal(u.withheld.verifyFrom, "dist");
    const plan = planUnit(u, { publicKey: PK, verifyToken: "vt_fake", host: RENDER }, { read: reader(dir), git });
    assert.deepEqual(plan.changes.map((c) => c.path).sort(), ["public/.well-known/parlox-verify", "views/index.ejs"]);
    assert.ok(u.warnings.includes("Express: the ownership file goes in public/.well-known/parlox-verify: Express 4 serves dist/ (express.static in server.js), where Vite copies the public folder when it builds."), u.warnings.join("\n"));
    // Express 5 does not serve files inside .well-known/: the tag only.
    const five = expressWithWidgets(fw, "^5.1.0");
    assert.deepEqual(planUnit(unitOf(five), { publicKey: PK, verifyToken: "vt_fake", host: RENDER }, { read: reader(five), git }).changes.map((c) => c.path), ["views/index.ejs"]);
  });
}

for (const fw of Object.keys(FRAMEWORKS)) {
  const { entry, label } = FRAMEWORKS[fw];
  test(`${label} with an index.html whose entry the wizard cannot find, beside Express pages: the Vite app keeps its step by hand and its reason; only with no index.html do the pages take the browser part`, () => {
    const files = (html) => ({
      pkg: { scripts: { start: "node server.js" }, dependencies: { express: "^4.21.2", ejs: "^3.1.10" } }, "render.yaml": "", "index.html": html,
      "server.js": "import express from 'express'\nconst app = express()\napp.set('view engine', 'ejs')\napp.use(express.static('dist'))\napp.get('/admin', (q, s) => s.render('admin'))\napp.listen(3000)\n",
      "views/admin.ejs": "<!doctype html>\n<html>\n<head>\n</head>\n<body>admin</body>\n</html>\n",
    });
    for (const [what, html, why] of [
      ["an inline module script", `<div id=app></div>\n<script type=module>import './${entry}'</script>\n`, /^index\.html has no single <script type="module" src="…"> of the app's own\.$/],
      ["two module scripts", `<script type="module" src="/${entry}"></script>\n<script type="module" src="/src/other.js"></script>\n`, /^index\.html has no single <script type="module" src="…"> of the app's own\.$/],
      ["an entry outside the folder", `<script type="module" src="../shared/main.js"></script>\n`, /^The module script in index\.html is outside this folder\.$/],
    ]) {
      const dir = spa(fw, files(html));
      const u = unitOf(dir);
      assert.equal(u.browser.integration, `vite-${fw}`, what);
      const plan = planUnit(u, { publicKey: PK, verifyToken: "vt_fake", host: RENDER }, { read: reader(dir), git });
      assert.equal(plan.changes.some((c) => c.path.startsWith("views/")), false, `${what}: the pages are left alone`);
      assert.deepEqual(plan.manual.map((m) => [m.file, m.part]), [["index.html", "browser"]], what);
      assert.match(plan.manual[0].reason, why, what);
    }
  });
}
