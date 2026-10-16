import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { describeUnit, hostStepFor, planUnit, scanApps } from "../dist/apps.js";
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
