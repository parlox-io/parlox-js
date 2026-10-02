// The Vite secret guard: what a static Vite site's build reads or runs before the wizard plans a Vercel middleware and a
// key. Default-deny: each shape below is not proven safe, and the test checks the guard's reason, never a real build.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { readViteSettings } from "../dist/edits/vite-config.js";
import { viteReact, viteServerKind } from "../dist/integrations/vite-react.js";
import { vercelHost } from "../dist/hosts.js";
import { scanApps } from "../dist/apps.js";
import { BROWSER_VERSION, SERVER_VERSION } from "../dist/versions.js";
import { fixture } from "./helpers.mjs";

const PK = "pk_" + "b2".repeat(12);
const MAIN_TSX = "import { StrictMode } from 'react'\nimport { createRoot } from 'react-dom/client'\nimport App from './App.tsx'\n\ncreateRoot(document.getElementById('root')!).render(\n  <StrictMode>\n    <App />\n  </StrictMode>,\n)\n";
const INDEX_HTML = `<!doctype html>\n<html lang="en">\n  <head>\n    <meta charset="UTF-8" />\n    <title>shop</title>\n  </head>\n  <body>\n    <div id="root"></div>\n    <script type="module" src="/src/main.tsx"></script>\n  </body>\n</html>\n`;
const pkgJson = (extra = {}) => JSON.stringify({ name: "shop", type: "module", dependencies: { react: "^19.2.8", "react-dom": "^19.2.8" }, devDependencies: { vite: "^8.3.0", "@vitejs/plugin-react": "^6.1.1" }, ...extra });
const app = (files = {}) => fixture({ "package.json": pkgJson(), "package-lock.json": "{}", "tsconfig.json": "{}", "index.html": INDEX_HTML, "src/main.tsx": MAIN_TSX, ...files });
const self = (dir) => viteReact.detect(dir, dir);
const git = { isRepo: () => false, dirty: () => [], isTracked: () => false, isIgnored: () => false };
const reader = (dir) => (rel) => (existsSync(join(dir, rel)) ? readFileSync(join(dir, rel), "utf8") : null);
const input = (dir, host) => ({ publicKey: PK, verifyToken: "vt_fake", host, versions: { browser: BROWSER_VERSION, server: SERVER_VERSION }, parts: { browser: true, server: true }, read: reader(dir), git });
const listOf = (files) => (rel) => {
  const prefix = rel === "." ? "" : `${rel}/`;
  const names = new Set();
  for (const key of Object.keys(files)) {
    if (!key.startsWith(prefix) || key.startsWith("../")) continue;
    const rest = key.slice(prefix.length);
    const slash = rest.indexOf("/");
    names.add(slash < 0 ? rest : rest.slice(0, slash + 1));
  }
  return [...names];
};
/** readViteSettings over files in memory (null: the file is there, but it cannot be read). A folder exists when a file
 * is in it. */
const existsIn = (files) => (rel) => rel in files || Object.keys(files).some((k) => k.startsWith(`${rel}/`));
const settingsOf = (files, more = {}) => readViteSettings((rel) => (rel in files ? files[rel] : null), existsIn(files), { list: listOf(files), postcssTop: ".", workspace: null, ...more });
const R = "import react from '@vitejs/plugin-react'\nimport { defineConfig } from 'vite'\n";

/** Each [label, files, reason]: not proven safe in memory and on disk, and on Vercel no middleware and no host step. */
function assertNotSafe(cases) {
  for (const [label, files, why] of cases) {
    const s = settingsOf({ "package.json": pkgJson(), ...files });
    assert.ok(s.exposure, `${label}: read as safe`);
    assert.match(s.exposure.why, why, label);
    if (Object.values(files).includes(null)) continue;
    const d = self(app({ "vercel.json": "{}", ...files }));
    assert.match(d.data.exposure?.why ?? "", why, `${label} (on disk)`);
    assert.equal(d.parts.server.kind, "verify-file", label);
    assert.equal(viteServerKind(vercelHost(null), d.data), "verify-file", label);
    assert.equal(viteReact.hostStep(d, vercelHost(null)), false, label);
    const plan = viteReact.plan(d, input(d.dir, vercelHost(null)));
    assert.equal(plan.changes.some((c) => c.path.startsWith("middleware.")), false, label);
  }
}
/** Each [label, files]: proven safe in memory and on disk, and on Vercel the middleware and the host step. */
function assertSafe(cases) {
  for (const [label, files] of cases) {
    assert.equal(settingsOf({ "package.json": pkgJson(), ...files }).exposure, null, label);
    const d = self(app({ "vercel.json": "{}", ...files }));
    assert.equal(d.data.exposure, null, `${label} (on disk): ${d.data.exposure?.why}`);
    assert.equal(d.parts.server.kind, "vercel-edge", label);
    assert.equal(viteReact.hostStep(d, vercelHost(null)), true, label);
  }
}

test("a mode set in the Vite config makes Vite load .env.<mode>: not proven safe unless it is 'production'", () => {
  assertNotSafe([
    ["mode: 'staging'", { "vite.config.js": R + "export default defineConfig({ plugins: [react()], mode: 'staging' })\n" }, /^vite\.config\.js uses the setting mode \(line 3\), which the wizard does not check/],
    ["mode from a command test", { "vite.config.js": "import { defineConfig } from 'vite'\nexport default defineConfig(({ command }) => ({ mode: command === 'build' ? 'staging' : 'development' }))\n" }, /uses the setting mode \(line 2\)/],
    ["mode: 'development'", { "vite.config.ts": "export default { mode: 'development' }\n" }, /uses the setting mode \(line 1\)/],
    ["mode as a template literal", { "vite.config.ts": "export default { mode: `staging` }\n" }, /uses the setting mode \(line 1\)/],
  ]);
  assertSafe([
    ["mode: 'production'", { "vite.config.js": R + "export default defineConfig({ plugins: [react()], mode: 'production' })\n" }],
    ["mode: \"production\" in TypeScript", { "vite.config.ts": "export default { mode: \"production\" as const }\n" }],
  ]);
});

test("functions in server and preview: only a proxy's rewrite, configure and bypass, which vite build never calls", () => {
  const V = "import { defineConfig } from 'vite'\n";
  assertNotSafe([
    // Vite reads these while it resolves the config, in a build too (server.origin.endsWith, server.fs.allow.map).
    ["a method on server.origin", { "vite.config.js": V + "export default defineConfig({ server: { origin: { endsWith: () => true, toString: () => 'x' } } })\n" }, /^vite\.config\.js uses the setting server \(line 2\), which the wizard does not check/],
    ["a method on server.fs.allow", { "vite.config.js": V + "export default defineConfig({ server: { fs: { allow: { map: () => [] } } } })\n" }, /uses the setting server \(line 2\)/],
    ["a watch function", { "vite.config.js": V + "export default defineConfig({ server: { watch: { ignored: (p) => p.includes('tmp') } } })\n" }, /uses the setting server \(line 2\)/],
    ["a proxy option other than rewrite, configure and bypass", { "vite.config.js": V + "export default defineConfig({ server: { proxy: { '/api': { target: 'http://localhost:3000', router: () => 'http://localhost:4000' } } } })\n" }, /uses the setting server \(line 2\)/],
    ["rewrite directly on proxy", { "vite.config.js": V + "export default defineConfig({ server: { proxy: { rewrite: (p) => p } } })\n" }, /uses the setting server \(line 2\)/],
    ["a function in preview.headers", { "vite.config.js": V + "export default defineConfig({ preview: { headers: { toJSON() { return {} } } } })\n" }, /uses the setting preview \(line 2\)/],
    ["a function in a proxy's array", { "vite.config.js": V + "export default defineConfig({ server: { proxy: { '/api': { target: 'http://localhost:3000', rewrite: [(p) => p] } } } })\n" }, /uses the setting server \(line 2\)/],
  ]);
  assertSafe([
    ["rewrite, configure and bypass", { "vite.config.js": V + "export default defineConfig({\n  server: { proxy: { '/api': { target: 'http://localhost:3000', changeOrigin: true, rewrite: (path) => path.replace(/^\\/api/, ''), configure(proxy) { proxy.on('error', (err) => console.log(err)) } } } },\n  preview: { proxy: { '/api': { target: 'http://localhost:3000', bypass: function (req) { return req.url } } } },\n})\n" }],
  ]);
});

test("vercel.json is read by an allowlist of keys: anything else may change how Vercel builds the app", () => {
  const vj = (o) => ({ "vercel.json": JSON.stringify(o) });
  assertNotSafe([
    ["framework of another stack", vj({ framework: "nextjs" }), /^vercel\.json sets framework to "nextjs", which the wizard does not check, and it may change how Vercel builds this app/],
    ["functions", vj({ functions: { "api/*.js": { maxDuration: 10 } } }), /^vercel\.json sets functions, which the wizard does not check, and it may change how Vercel builds this app/],
    ["build.env", vj({ build: { env: { VITE_KEY: "@parlox-secret-key" } } }), /^vercel\.json sets build, which the wizard does not check/],
    ["env", vj({ env: { VITE_KEY: "x" } }), /^vercel\.json sets env, which the wizard does not check/],
    ["routes", vj({ routes: [{ src: "/(.*)", dest: "/index.html" }] }), /^vercel\.json sets routes, which the wizard does not check/],
    ["a key Vercel may add later", vj({ experimentalServices: {} }), /^vercel\.json sets experimentalServices, which the wizard does not check/],
    ["installCommand keeps its own reason", vj({ cleanUrls: true, installCommand: "node install.mjs" }), /^vercel\.json sets installCommand, which Vercel runs in the build and the wizard does not check/],
  ]);
  assertSafe([
    ["the routing and output keys", vj({ $schema: "https://openapi.vercel.sh/vercel.json", cleanUrls: true, trailingSlash: false, outputDirectory: "dist", headers: [{ source: "/(.*)", headers: [{ key: "X-Frame-Options", value: "DENY" }] }], rewrites: [{ source: "/(.*)", destination: "/index.html" }], redirects: [{ source: "/old", destination: "/new", permanent: true }], regions: ["iad1"], images: { sizes: [640] }, git: { deploymentEnabled: { main: true } } })],
    ["framework vite", vj({ framework: "vite", buildCommand: "vite build" })],
    ["framework null", vj({ framework: null })],
  ]);
});

test("netlify.toml: a dotted key (build.command = …) and an inline table are read like the [build] table", async () => {
  const { netlifyCommands, runsViteBuild } = await import("../dist/integrations/vite-react.js");
  assert.deepEqual(netlifyCommands('build.command = "npx vite build"\n'), ["npx vite build"]);
  assert.deepEqual(netlifyCommands("[context]\nproduction.command = 'vite build --mode production'\n"), ["vite build --mode production"]);
  assert.deepEqual(netlifyCommands('"build" . "command" = "vite build"\ncontext.deploy-preview.command = "npm run preview"\n'), ["vite build", "npm run preview"]);
  assert.deepEqual(netlifyCommands('build = { publish = "dist", command = "vite build" }\n'), ["vite build"]);
  assert.deepEqual(netlifyCommands('[build]\ncommand = "vite build"\n'), ["vite build"], "the table form as before");
  // What it changes: a Netlify build that runs Vite, in a folder that declares no vite and has no Vite config.
  const pkg = { name: "api", scripts: { start: "node server.js" }, dependencies: { express: "^5.1.0" } };
  const files = { "netlify.toml": 'build.command = "npx vite build"\n' };
  assert.equal(runsViteBuild(pkg, (rel) => rel in files, (rel) => files[rel] ?? null), true);
});

test("a config file given to Vite with --config is a Vite config, not reporting code: its PARLOX_SECRET_KEY gets the exposure reason", async () => {
  const { ownReporting } = await import("../dist/own-reporting.js");
  const { scanApps } = await import("../dist/apps.js");
  const SERVER = "import express from 'express'\n\nconst app = express()\napp.use(express.static('dist'))\napp.listen(3000)\n";
  const CONFIG = "import { defineConfig } from 'vite'\nexport default defineConfig({ define: { __KEY__: JSON.stringify(process.env.PARLOX_SECRET_KEY) } })\n";
  for (const [label, files, file] of [
    ["a script", { "package.json": JSON.stringify({ type: "module", scripts: { build: "vite build --config config/vite.prod.ts", start: "node server.js" }, dependencies: { express: "^5.1.0" }, devDependencies: { vite: "^8.3.0" } }), "config/vite.prod.ts": CONFIG }, "config/vite.prod.ts"],
    ["-c=", { "package.json": JSON.stringify({ type: "module", scripts: { build: "vite build -c=./vite.web.mjs", start: "node server.js" }, dependencies: { express: "^5.1.0" }, devDependencies: { vite: "^8.3.0" } }), "vite.web.mjs": CONFIG }, "./vite.web.mjs"],
    ["vercel.json's buildCommand", { "package.json": JSON.stringify({ type: "module", scripts: { start: "node server.js" }, dependencies: { express: "^5.1.0" }, devDependencies: { vite: "^8.3.0" } }), "vercel.json": JSON.stringify({ buildCommand: "vite build --config web.vite.ts" }), "web.vite.ts": CONFIG }, "web.vite.ts"],
  ]) {
    const dir = fixture({ "package-lock.json": "{}", "server.js": SERVER, ...files });
    assert.equal(ownReporting(dir).found, null, `${label}: ${JSON.stringify(ownReporting(dir).found)}`);
    const [u] = scanApps(dir).units;
    assert.equal(u.server, null, label);
    const w = u.warnings.find((x) => x.startsWith("Express: no server part was added."));
    assert.ok(w?.includes(`${file} (`) && w.includes("--config): ") && w.includes("names PARLOX_SECRET_KEY (line 2)"), `${label}: ${u.warnings.join("\n")}`);
    assert.equal(u.warnings.some((x) => x.includes("already reports to Parlox with its own code")), false, label);
  }
  // The same code in a file Vite is not given is still the app's own reporting.
  const own = fixture({ "package-lock.json": "{}", "server.js": SERVER, "package.json": JSON.stringify({ type: "module", scripts: { start: "node server.js" }, dependencies: { express: "^5.1.0" } }), "src/report.js": "export const key = process.env.PARLOX_SECRET_KEY\n" });
  assert.deepEqual(ownReporting(own).found, { file: "src/report.js", line: 1 });
});

const DASHBOARD = "If this project sets a Build Command, an Install Command or an Ignored Build Step in Vercel's dashboard, check that the Build Command runs `vite build` and that none of them runs code that could put PARLOX_SECRET_KEY into the build: the wizard cannot see dashboard settings.";
test("on Vercel, the report names the three dashboard settings that run in the build and that the wizard cannot see", () => {
  const role = { browser: true, server: true, unitHasBrowser: true };
  const d = self(app({ "vercel.json": "{}" }));
  assert.ok(viteReact.hostNotes(d, vercelHost(null), role).includes(DASHBOARD), viteReact.hostNotes(d, vercelHost(null), role).join("\n"));
  // Also beside a withheld middleware: the dashboard still runs those commands.
  const exposed = self(app({ "vercel.json": "{}", "vite.config.ts": "export default { envPrefix: ['VITE_', 'PARLOX_'] }" }));
  assert.ok(viteReact.hostNotes(exposed, vercelHost(null), role).includes(DASHBOARD));
  assert.equal(viteReact.hostNotes(d, { id: "netlify" }, role).includes(DASHBOARD), false, "not off Vercel");
});

// A workspace on disk: the root (workspaces apps/* and packages/*), the Vite app in apps/web, and `more` files by path.
const mono = (more = {}, rootPkg = {}) => fixture({
  "package.json": JSON.stringify({ name: "mono", private: true, workspaces: ["apps/*", "packages/*"], ...rootPkg }),
  "package-lock.json": "{}",
  "apps/web/package.json": pkgJson(), "apps/web/index.html": INDEX_HTML, "apps/web/src/main.tsx": MAIN_TSX,
  ...more,
});
const web = (root) => viteReact.detect(join(root, "apps/web"), root);
/** In memory, an app in apps/web of a workspace at ../.. (its files keyed from the app folder). */
const inWorkspace = { workspace: { root: "../..", vercel: false, app: "apps/web" }, repoTop: "../..", packages: { list: [{ dir: ".", name: "shop" }], notChecked: null } };

test("install-time code: the package managers' own files that run code when the dependencies are installed are not proven safe", () => {
  assertNotSafe([
    ["pnpm's pnpm:devPreinstall", { "package.json": pkgJson({ scripts: { "pnpm:devPreinstall": "node gen.mjs", build: "vite build" } }) }, /^package\.json has a "pnpm:devPreinstall" script, which runs when Vercel installs the dependencies, and the wizard does not check it/],
    [".npmrc node-options --require", { ".npmrc": "registry=https://registry.npmjs.org/\nnode-options=--require ./hook.cjs\n" }, /^\.npmrc sets node-options to "--require \.\/hook\.cjs", which the wizard does not check, and npm passes it to every script of the install and the build/],
    [".npmrc node-options --import", { ".npmrc": "node-options = \"--import ./hook.mjs --max-old-space-size=4096\"\n" }, /^\.npmrc sets node-options to "--import \.\/hook\.mjs --max-old-space-size=4096"/],
    [".npmrc node-options -r", { ".npmrc": "node_options=-r ./hook.cjs\n" }, /^\.npmrc sets node-options/],
    [".npmrc node-options from a variable", { ".npmrc": "node-options=${NODE_HOOK}\n" }, /^\.npmrc sets node-options/],
    [".npmrc script-shell", { ".npmrc": "script-shell=./shell.sh\n" }, /^\.npmrc sets script-shell, the program that runs every script of the install and the build/],
    [".npmrc pnpmfile", { ".npmrc": "pnpmfile=./hooks.cjs\n" }, /^\.npmrc sets pnpmfile, a file of code pnpm runs when it installs/],
    [".npmrc global-pnpmfile", { ".npmrc": "global-pnpmfile=/tmp/hooks.cjs\n" }, /^\.npmrc sets global-pnpmfile, a file of code pnpm runs when it installs/],
    [".pnpmfile.cjs", { ".pnpmfile.cjs": "module.exports = { hooks: {} }\n" }, /^\.pnpmfile\.cjs exists, and pnpm runs it when it installs/],
    ["pnpm-workspace.yaml's pnpmfile", { "pnpm-workspace.yaml": "pnpmfile: ./hooks.cjs\n" }, /^pnpm-workspace\.yaml sets pnpmfile, a file of code pnpm runs when it installs/],
    ["pnpm-workspace.yaml's nodeOptions", { "pnpm-workspace.yaml": "nodeOptions: --require ./hook.cjs\n" }, /^pnpm-workspace\.yaml sets nodeOptions to "--require \.\/hook\.cjs"/],
    [".yarnrc.yml yarnPath", { ".yarnrc.yml": "nodeLinker: node-modules\nyarnPath: .yarn/releases/yarn-4.9.0.cjs\n" }, /^\.yarnrc\.yml sets yarnPath, a file Yarn runs in its own place when it installs/],
    [".yarnrc.yml plugins", { ".yarnrc.yml": "plugins:\n  - path: .yarn/plugins/x.cjs\n" }, /^\.yarnrc\.yml sets plugins, code Yarn loads when it installs/],
    ["yarn classic's yarn-path", { ".yarnrc": "yarn-path \".yarn/releases/yarn-1.22.22.cjs\"\n" }, /^\.yarnrc sets yarn-path, a file Yarn runs in its own place when it installs/],
    ["bunfig.toml preload", { "bunfig.toml": "[install]\nexact = true\n\npreload = [\"./setup.ts\"]\n" }, /^bunfig\.toml sets preload \(line 4\), code Bun runs before the scripts it runs/],
    ["bunfig.toml [test] preload", { "bunfig.toml": "[test]\npreload = [\"./happydom.ts\"]\n" }, /^bunfig\.toml sets preload \(line 2\)/],
  ]);
  const unreadable = settingsOf({ "package.json": pkgJson(), ".npmrc": null });
  assert.match(unreadable.exposure?.why ?? "", /^\.npmrc exists, but the wizard cannot read it, and the package manager reads it when it installs/);
  const yaml = settingsOf({ "package.json": pkgJson(), ".yarnrc.yml": "yarnPath: [" });
  assert.match(yaml.exposure?.why ?? "", /^\.yarnrc\.yml exists, but the wizard cannot read it/);
  assertSafe([
    [".npmrc with registry settings and a heap size", { ".npmrc": "registry=https://registry.npmjs.org/\n//registry.npmjs.org/:_authToken=${NPM_TOKEN}\nlegacy-peer-deps=true\nnode-options=--max-old-space-size=4096\n" }],
    [".yarnrc.yml without code", { ".yarnrc.yml": "nodeLinker: node-modules\nenableTelemetry: false\n" }],
    ["bunfig.toml without preload", { "bunfig.toml": "[install]\nexact = true\n" }],
    ["pnpm-workspace.yaml settings", { "pnpm-workspace.yaml": "onlyBuiltDependencies:\n  - esbuild\n" }],
  ]);
  // Up the tree to the workspace root, where the install runs.
  const atRoot = settingsOf({ "package.json": pkgJson(), "../../package.json": JSON.stringify({ name: "mono", workspaces: ["apps/*"] }), "../../.npmrc": "node-options=--import ./hook.mjs\n" }, inWorkspace);
  assert.match(atRoot.exposure?.why ?? "", /^\.\.\/\.\.\/\.npmrc sets node-options/);
  const yarnUp = settingsOf({ "package.json": pkgJson(), "../../package.json": JSON.stringify({ name: "mono", workspaces: ["apps/*"] }), "../.yarnrc.yml": "yarnPath: x.cjs\n" }, inWorkspace);
  assert.match(yarnUp.exposure?.why ?? "", /^\.\.\/\.yarnrc\.yml sets yarnPath/);
});

test("install-time code: the install scripts of the other packages of the workspace are not proven safe", () => {
  const sibling = mono({ "packages/ui/package.json": JSON.stringify({ name: "@acme/ui", scripts: { postinstall: "node build-tokens.mjs" } }) });
  const d = web(sibling);
  assert.match(d.data.exposure?.why ?? "", /^\.\.\/\.\.\/packages\/ui\/package\.json has a "postinstall" script, which runs when Vercel installs the dependencies, and the wizard does not check it/);
  assert.equal(d.parts.server.kind, "verify-file");
  // A sibling with a harmless one, or none, keeps the middleware.
  const quiet = mono({ ".vercel/project.json": "{}", "apps/web/vercel.json": "{}", "packages/ui/package.json": JSON.stringify({ name: "@acme/ui", scripts: { build: "tsc", prepare: "husky" } }) });
  assert.equal(web(quiet).data.exposure, null, web(quiet).data.exposure?.why);
  // A workspace pattern the wizard does not expand: it cannot know every package, so it cannot know their scripts.
  const braces = mono({}, { workspaces: ["apps/*", "packages/{ui,core}"] });
  assert.match(web(braces).data.exposure?.why ?? "", /^The workspace lists packages with a pattern the wizard does not expand \(packages\/\{ui,core\}\)/);
  // ** reaches every depth.
  const deep = mono({ "packages/group/inner/package.json": JSON.stringify({ name: "inner", scripts: { install: "node-gyp rebuild" } }) }, { workspaces: ["apps/*", "packages/**"] });
  assert.match(web(deep).data.exposure?.why ?? "", /^\.\.\/\.\.\/packages\/group\/inner\/package\.json has a "install" script/);
});

test("packages trusted by name: each must come from the npm registry, an override may only pin it to a registry version, and nothing may patch it", () => {
  const dev = (deps) => ({ "package.json": pkgJson({ devDependencies: { vite: "^8.3.0", "@vitejs/plugin-react": "^6.1.1", ...deps } }) });
  assertNotSafe([
    ["vite from a folder", dev({ vite: "file:../vite" }), /^package\.json declares vite as "file:\.\.\/vite", not a version from the npm registry, so the build could run other code under that name/],
    ["a plugin linked", dev({ "@vitejs/plugin-react": "link:../plugin-react" }), /^package\.json declares @vitejs\/plugin-react as "link:\.\.\/plugin-react"/],
    ["a workspace protocol", dev({ "@tailwindcss/vite": "workspace:*" }), /^package\.json declares @tailwindcss\/vite as "workspace:\*"/],
    ["git", dev({ vite: "github:someone/vite#main" }), /^package\.json declares vite as "github:someone\/vite#main"/],
    ["a tarball", dev({ autoprefixer: "https://example.com/autoprefixer.tgz" }), /^package\.json declares autoprefixer as "https:\/\/example\.com\/autoprefixer\.tgz"/],
    ["another package under the name", dev({ vite: "npm:not-vite@1.0.0" }), /^package\.json declares vite as "npm:not-vite@1\.0\.0"/],
    ["a folder path", dev({ typescript: "../typescript" }), /^package\.json declares typescript as "\.\.\/typescript"/],
    ["pnpm patchedDependencies", { "package.json": pkgJson({ pnpm: { patchedDependencies: { "vite@8.3.0": "patches/vite.patch" } } }) }, /^package\.json's pnpm\.patchedDependencies change vite/],
    ["bun patchedDependencies", { "package.json": pkgJson({ patchedDependencies: { "@tailwindcss/vite@4.3.3": "patches/tw.patch" } }) }, /^package\.json's patchedDependencies change @tailwindcss\/vite/],
    ["pnpm packageExtensions", { "package.json": pkgJson({ pnpm: { packageExtensions: { "vite@8": { dependencies: { "x": "1" } } } } }) }, /^package\.json's pnpm\.packageExtensions change vite/],
    ["an override with local code", { "package.json": pkgJson({ overrides: { "left-pad": "file:./vendor/left-pad" } }) }, /^package\.json's overrides replace left-pad with "file:\.\/vendor\/left-pad", not a version from the npm registry/],
    ["a catalog entry from a folder", { "package.json": pkgJson({ devDependencies: { vite: "catalog:" } }), "pnpm-workspace.yaml": "catalog:\n  vite: file:../vite\n" }, /^package\.json declares vite as "catalog:", which pnpm-workspace\.yaml's catalog gives as "file:\.\.\/vite", not a version from the npm registry/],
    ["a catalog entry that is not there", { "package.json": pkgJson({ devDependencies: { vite: "catalog:build" } }) }, /^package\.json declares vite as "catalog:build", and the wizard finds no such catalog entry/],
  ]);
  assertSafe([
    ["ranges, tags and versions", dev({ vite: "~8.3.0", "@vitejs/plugin-react": "latest", typescript: ">=5.8 <7", postcss: "8.5.6 || ^8.6.0", autoprefixer: "*" })],
    ["npm: with the same name", dev({ vite: "npm:vite@^8.3.0" })],
    ["a catalog of registry versions", { "package.json": pkgJson({ devDependencies: { vite: "catalog:", "@vitejs/plugin-react": "catalog:react" } }), "pnpm-workspace.yaml": "catalog:\n  vite: ^8.3.0\ncatalogs:\n  react:\n    '@vitejs/plugin-react': ^6.1.1\n" }],
    ["overrides of other packages", { "package.json": pkgJson({ overrides: { "left-pad": "1.3.0", "some-lib": { ".": "2.0.0", "lodash": "$lodash" } } }) }],
    ["npm overrides", { "package.json": pkgJson({ overrides: { vite: "8.3.0" } }) }],
    ["nested npm overrides", { "package.json": pkgJson({ overrides: { "some-tool": { postcss: "8.5.0" } } }) }],
    ["yarn resolutions", { "package.json": pkgJson({ resolutions: { "**/@vitejs/plugin-react": "6.1.1" } }) }],
    ["pnpm overrides", { "package.json": pkgJson({ pnpm: { overrides: { "foo>vite": "8.3.0" } } }) }],
    ["pnpm-workspace.yaml overrides", { "pnpm-workspace.yaml": "overrides:\n  esbuild: 0.25.0\n" }],
    ["a local package that is not trusted by name", { "package.json": pkgJson({ dependencies: { react: "^19.2.8", "react-dom": "^19.2.8", "@acme/ui": "file:../ui" } }) }],
  ]);
  // A workspace package under a trusted name would be the one the build runs.
  const named = mono({ "packages/vite/package.json": JSON.stringify({ name: "vite", version: "0.0.0" }) });
  assert.match(web(named).data.exposure?.why ?? "", /^\.\.\/\.\.\/packages\/vite\/package\.json is a workspace package named vite, so the build could run it in the place of the npm package/);
  // The root's and the other packages' declarations count too (hoisting can give the app their copy).
  const rootDecl = mono({}, { devDependencies: { vite: "file:./vendor/vite" } });
  assert.match(web(rootDecl).data.exposure?.why ?? "", /^\.\.\/\.\.\/package\.json declares vite as "file:\.\/vendor\/vite"/);
  const siblingDecl = mono({ "packages/ui/package.json": JSON.stringify({ name: "@acme/ui", devDependencies: { postcss: "link:../postcss" } }) });
  assert.match(web(siblingDecl).data.exposure?.why ?? "", /^\.\.\/\.\.\/packages\/ui\/package\.json declares postcss as "link:\.\.\/postcss"/);
});

test("known-harmless install commands beside a Vite config keep the key: exact words only", async () => {
  const { runsViteBuild } = await import("../dist/integrations/vite-react.js");
  const vj = (installCommand) => ({ "vercel.json": JSON.stringify({ installCommand }) });
  assertSafe([
    ...["npm ci", "npm install", "pnpm install", "pnpm install --frozen-lockfile", "yarn install", "yarn install --frozen-lockfile", "yarn install --immutable", "bun install", "bun install --frozen-lockfile", "  npm   ci  "].map((c) => [`installCommand ${JSON.stringify(c)}`, vj(c)]),
    ["postinstall: patch-package, no patches", { "package.json": pkgJson({ scripts: { postinstall: "patch-package", build: "vite build" } }) }],
    ["postinstall: patch-package, a patch of another package", { "package.json": pkgJson({ scripts: { postinstall: "patch-package", build: "vite build" } }), "patches/left-pad+1.3.0.patch": "diff\n" }],
    ["postinstall: prisma generate", { "package.json": pkgJson({ scripts: { postinstall: "prisma generate", build: "vite build" } }), "prisma/schema.prisma": "generator client {\n  provider = \"prisma-client-js\"\n}\n\ndatasource db {\n  provider = \"postgresql\"\n  url      = env(\"DATABASE_URL\")\n}\n" }],
    ["postinstall: prisma generate, the new generator", { "package.json": pkgJson({ scripts: { postinstall: "prisma generate", build: "vite build" } }), "prisma/schema.prisma": "generator client {\n  provider = \"prisma-client\"\n  output   = \"../src/generated/prisma\"\n}\n" }],
  ]);
  assertNotSafe([
    ["chained", vj("npm ci && node gen.mjs"), /^vercel\.json sets installCommand, which Vercel runs in the build and the wizard does not check/],
    ["an unknown flag", vj("npm ci --foreground-scripts"), /^vercel\.json sets installCommand/],
    ["npm i", vj("npm i"), /^vercel\.json sets installCommand/],
    ["patch-package with an argument", { "package.json": pkgJson({ scripts: { postinstall: "patch-package --patch-dir tools/patches", build: "vite build" } }) }, /^package\.json has a "postinstall" script, which runs when Vercel installs the dependencies/],
    ["a patch of vite", { "package.json": pkgJson({ scripts: { postinstall: "patch-package", build: "vite build" } }), "patches/vite+8.3.0.patch": "diff\n" }, /^package\.json's "postinstall" script runs patch-package, and patches\/vite\+8\.3\.0\.patch changes vite, which the build runs/],
    ["a patch of a scoped plugin", { "package.json": pkgJson({ scripts: { postinstall: "patch-package", build: "vite build" } }), "patches/@vitejs+plugin-react+6.1.1.patch": "diff\n" }, /patches\/@vitejs\+plugin-react\+6\.1\.1\.patch changes @vitejs\/plugin-react/],
    ["a patch of a nested package", { "package.json": pkgJson({ scripts: { postinstall: "patch-package", build: "vite build" } }), "patches/some-tool++postcss+8.5.0.patch": "diff\n" }, /patches\/some-tool\+\+postcss\+8\.5\.0\.patch changes postcss/],
    ["a prisma generator that runs code", { "package.json": pkgJson({ scripts: { postinstall: "prisma generate", build: "vite build" } }), "prisma/schema.prisma": "generator docs {\n  provider = \"node ./gen-docs.js\"\n}\n" }, /^package\.json's "postinstall" script runs prisma generate, and prisma\/schema\.prisma names the generator provider "node \.\/gen-docs\.js" \(line 2\), which runs code the wizard does not check/],
    ["prisma's config file", { "package.json": pkgJson({ scripts: { postinstall: "prisma generate", build: "vite build" } }), "prisma.config.ts": "export default {}\n" }, /^package\.json's "postinstall" script runs prisma generate, and prisma\.config\.ts is code prisma runs/],
    ["a prisma schema elsewhere", { "package.json": pkgJson({ scripts: { postinstall: "prisma generate", build: "vite build" }, prisma: { schema: "db/schema.prisma" } }) }, /^package\.json's "postinstall" script runs prisma generate, and package\.json's "prisma" field sets where prisma reads its settings/],
  ]);
  // Beside a Vite config in a server's folder, a harmless install command shows the build leaves Vite out.
  const files = { "vite.config.js": "export default {}\n" };
  const pkg = { scripts: { build: "tsc", start: "node dist/server.js", postinstall: "prisma generate" }, dependencies: { express: "^5.1.0" }, devDependencies: { vite: "^8.3.0" } };
  assert.equal(runsViteBuild(pkg, (rel) => rel in files, (rel) => files[rel] ?? null), false);
  assert.equal(runsViteBuild({ ...pkg, scripts: { ...pkg.scripts, postinstall: "prisma generate && node x.mjs" } }, (rel) => rel in files, (rel) => files[rel] ?? null), true, "chained: not shown");
});

// .vercel/project.json as the Vercel CLI writes it: `vercel link` writes the ids; `vercel pull` adds the project's
// settings (vercel/vercel packages/cli/src/util/projects/project-settings.ts, writeProjectSettings).
const link = (settings) => JSON.stringify({ projectId: "prj_1", orgId: "team_1", projectName: "shop", ...(settings ? { settings: { createdAt: 1, framework: "vite", devCommand: null, installCommand: null, buildCommand: null, outputDirectory: null, rootDirectory: null, directoryListing: false, nodeVersion: "22.x", ...settings } } : {}) });
const ROOT_LINKED = /^Vercel is set up at the workspace root \(\.\.\/\.\.\/\.vercel\/project\.json\), and the wizard cannot tell whether the project's Root Directory is this folder: if Vercel builds at the root, a middleware in this folder is not the project's root middleware, so Vercel would not run it\. Run `vercel pull` at the workspace root \(it saves the project's Root Directory in \.vercel\/project\.json\), or `vercel link` in this folder, then run the wizard again\.$/;

test("Vercel set up at the workspace root: a middleware in the app folder is planned only when the project's Root Directory is that folder", () => {
  const role = { browser: true, server: true, unitHasBrowser: true };
  for (const [label, root, why] of [
    ["linked at the root, no settings", mono({ ".vercel/project.json": link(null) }), ROOT_LINKED],
    ["a vercel.json at the root, no link", mono({ "vercel.json": "{}" }), /^Vercel is set up at the workspace root \(\.\.\/\.\.\/vercel\.json\), and the wizard cannot tell whether the project's Root Directory is this folder/],
    ["settings with no Root Directory", mono({ ".vercel/project.json": link({ rootDirectory: null }) }), /^Vercel builds this project at the workspace root \(\.\.\/\.\.\/\.vercel\/project\.json, saved by `vercel pull`, gives no Root Directory\), so a middleware in this folder is not the project's root middleware, and Vercel would not run it\. If the project's Root Directory is this folder, run `vercel pull` at the workspace root again, or `vercel link` in this folder, then run the wizard again\.$/],
    ["settings with another Root Directory", mono({ ".vercel/project.json": link({ rootDirectory: "apps/admin" }) }), /^The Vercel project linked at the workspace root builds apps\/admin \(its Root Directory in \.\.\/\.\.\/\.vercel\/project\.json, saved by `vercel pull`\), not this folder, so a middleware here would not run\./],
    ["a project.json that is not JSON", mono({ ".vercel/project.json": "{" }), /^\.\.\/\.\.\/\.vercel\/project\.json exists, but the wizard cannot read it, so it cannot tell where Vercel builds this project/],
  ]) {
    const d = web(root);
    assert.match(d.data.vercelRoot ?? "", why, label);
    assert.equal(d.parts.server.kind, "verify-file", label);
    assert.equal(viteServerKind(vercelHost(join(root)), d.data), "verify-file", label);
    assert.equal(viteReact.hostStep(d, vercelHost(root)), false, label);
    const plan = viteReact.plan(d, input(d.dir, vercelHost(root)));
    // The site still proves its domain: the ownership file in Vite's public folder, as off Vercel.
    assert.deepEqual(plan.changes.map((c) => c.path), ["src/main.tsx", "public/.well-known/parlox-verify"], label);
    assert.deepEqual(plan.warnings, [`No Vercel middleware: ${d.data.vercelRoot}`], label);
    assert.deepEqual(d.notes, [`No Vercel middleware: ${d.data.vercelRoot}`], label);
    const notes = viteReact.hostNotes(d, vercelHost(root), role);
    assert.ok(notes.includes("Crawlers that do not run JavaScript are not seen until the middleware is added (see the note on where Vercel builds this project)."), `${label}: ${notes.join("\n")}`);
    assert.equal(notes.some((n) => n.includes("Deploy on Vercel")), false, label);
  }
  // The Root Directory is the app's own folder: the middleware there is the project's root middleware.
  const own = mono({ ".vercel/project.json": link({ rootDirectory: "apps/web" }) });
  const d = web(own);
  assert.equal(d.data.vercelRoot, null);
  assert.equal(d.data.exposure, null, d.data.exposure?.why);
  assert.equal(d.parts.server.kind, "vercel-edge");
  assert.ok(viteReact.plan(d, input(d.dir, vercelHost(own))).changes.some((c) => c.path.startsWith("middleware.")));
  // Off Vercel, a static site with a safe config is told it would see crawlers there.
  assert.ok(viteReact.hostNotes(self(app()), { id: "netlify", label: "Netlify" }, { browser: true, server: true, unitHasBrowser: true }).some((n) => n.includes("Deploy on Vercel")));
  // A link in the app folder itself: as before, the app is the project.
  const appLinked = mono({ ".vercel/project.json": link(null), "apps/web/.vercel/project.json": link(null) });
  assert.equal(web(appLinked).data.vercelRoot, null);
  assert.equal(web(appLinked).parts.server.kind, "vercel-edge");
});

test("Vercel building at the workspace root with a root vite build: the root's Vite config and build files go through the same guard", () => {
  const rootBuild = (files, scripts = { build: "vite build" }) => mono({ ".vercel/project.json": link({ rootDirectory: null }), ...files }, { scripts, devDependencies: { vite: "^8.3.0" } });
  const exposing = web(rootBuild({ "vite.config.js": "export default { envPrefix: ['VITE_', 'PARLOX_'] }\n" }));
  assert.match(exposing.data.exposure?.why ?? "", /^In \.\.\/\.\.\/ \(the workspace root, where Vercel builds\): Your Vite config lists PARLOX_ in envPrefix, so the secret key would be bundled into the browser code\.$/);
  const css = web(rootBuild({ "src/theme.less": "@plugin \"my-plugin\";\n" }));
  assert.match(css.data.exposure?.why ?? "", /^In \.\.\/\.\.\/ \(the workspace root, where Vercel builds\): src\/theme\.less loads code with Less's @plugin \(line 1\)/);
  const env = web(rootBuild({ ".env.production": "VITE_KEY=$PARLOX_SECRET_KEY\n" }));
  assert.match(env.data.exposure?.why ?? "", /^In \.\.\/\.\.\/ \(the workspace root, where Vercel builds\): \.env\.production has a \$ \(line 1\)/);
  // No build command at the root, with vite there: Vercel's Vite preset runs vite build at the root.
  const preset = web(rootBuild({ "vite.config.js": "export default { envPrefix: '' }\n" }, {}));
  assert.match(preset.data.exposure?.why ?? "", /^In \.\.\/\.\.\/ \(the workspace root, where Vercel builds\): Your Vite config lists an empty prefix/);
  // A safe root build: no exposure (the middleware is still withheld: it would not be the root middleware).
  const safe = web(rootBuild({ "vite.config.js": "import { defineConfig } from 'vite'\nexport default defineConfig({ root: 'apps/web' })\n" }));
  assert.equal(safe.data.exposure, null, safe.data.exposure?.why);
  assert.match(safe.data.vercelRoot ?? "", /^Vercel builds this project at the workspace root/);
});

test("the project settings `vercel pull` saved are read: the Build Command, the Install Command and the framework set in Vercel's dashboard", () => {
  const appLinked = (settings, files = {}) => app({ ".vercel/project.json": link(settings), ...files });
  for (const [label, settings, why] of [
    ["a Build Command", { buildCommand: "node build.mjs" }, /^Vercel builds this app with the Build Command in Vercel's project settings \(\.vercel\/project\.json, saved by `vercel pull`\) \("node build\.mjs"\), which is not one of the builds the wizard checks/],
    ["an Install Command", { installCommand: "node install.mjs" }, /^Vercel's project settings \(\.vercel\/project\.json, saved by `vercel pull`\) set the Install Command "node install\.mjs", which Vercel runs in the build and the wizard does not check/],
    ["a framework", { framework: "nextjs" }, /^Vercel's project settings \(\.vercel\/project\.json, saved by `vercel pull`\) name the framework "nextjs", whose build the wizard does not check/],
  ]) {
    const d = self(appLinked(settings));
    assert.match(d.data.exposure?.why ?? "", why, label);
    assert.equal(d.parts.server.kind, "verify-file", label);
  }
  for (const [label, settings, files] of [
    ["a plain Build Command", { buildCommand: "tsc -b && vite build" }, {}],
    ["a harmless Install Command", { installCommand: "pnpm install --frozen-lockfile" }, {}],
    ["vercel.json's buildCommand comes first", { buildCommand: "node build.mjs" }, { "vercel.json": JSON.stringify({ buildCommand: "vite build" }) }],
    ["no framework", { framework: null }, {}],
  ]) {
    const d = self(appLinked(settings, files));
    assert.equal(d.data.exposure, null, `${label}: ${d.data.exposure?.why}`);
    assert.equal(d.parts.server.kind, "vercel-edge", label);
  }
  // Linked at the root with the app as its Root Directory: the root's settings are the app's.
  const rootLinked = mono({ ".vercel/project.json": link({ rootDirectory: "apps/web", buildCommand: "node build.mjs" }) });
  assert.match(web(rootLinked).data.exposure?.why ?? "", /^Vercel builds this app with the Build Command in Vercel's project settings \(\.\.\/\.\.\/\.vercel\/project\.json, saved by `vercel pull`\) \("node build\.mjs"\)/);
  // The report says what the wizard read, and what it did not (the Ignored Build Step, later changes).
  const role = { browser: true, server: true, unitHasBrowser: true };
  const read = self(appLinked({ buildCommand: "vite build" }));
  assert.ok(viteReact.hostNotes(read, vercelHost(read.dir), role).includes("The wizard read the Build Command and the Install Command that `vercel pull` saved in .vercel/project.json. If they have changed in Vercel's dashboard since, or the project sets an Ignored Build Step there, check that the Build Command runs `vite build` and that none of them runs code that could put PARLOX_SECRET_KEY into the build."), viteReact.hostNotes(read, vercelHost(read.dir), role).join("\n"));
});

test("a static Vite site whose middleware is withheld proves its domain with the ownership file, on Vercel and off it", () => {
  const role = { browser: true, server: true, unitHasBrowser: true };
  for (const [label, dir] of [
    ["an exposing config", app({ "vercel.json": "{}", "vite.config.ts": "export default { envPrefix: ['VITE_', 'PARLOX_'] }" })],
    ["a build the wizard does not check", app({ "vercel.json": "{}", "package.json": pkgJson({ scripts: { build: "node build.mjs" } }) })],
    ["a Storybook deployment", app({ "vercel.json": "{}", "package.json": pkgJson({ scripts: { build: "storybook build" } }) })],
  ]) {
    const d = self(dir);
    for (const host of [vercelHost(null), { id: "unknown", label: "your host" }, { id: "netlify", label: "Netlify" }]) {
      const plan = viteReact.plan(d, input(dir, host));
      assert.deepEqual(plan.changes.map((c) => [c.path, c.purpose]), [["src/main.tsx", "browser part"], ["public/.well-known/parlox-verify", "ownership proof"]], `${label} on ${host.id}`);
      assert.equal(plan.changes[1].after, "vt_fake\n");
      assert.equal(viteReact.hostStep(d, host), false, `${label} on ${host.id}`);
      // Vercel would withhold its middleware too, so no note says to deploy there.
      const notes = viteReact.hostNotes(d, host, role);
      assert.equal(notes.some((n) => /Deploy on Vercel/.test(n)), false, `${label} on ${host.id}: ${notes.join("\n")}`);
      assert.ok(notes.some((n) => n.startsWith("Crawlers that do not run JavaScript are not seen")), `${label} on ${host.id}`);
    }
  }
});

test("stylesheets: @plugin and @config only from the npm allowlist; <style> in HTML; every folder but node_modules and the build output", () => {
  assertNotSafe([
    ["@plugin of another package", { "src/index.css": "@import \"tailwindcss\";\n@plugin \"tailwind-scrollbar\";\n" }, /^src\/index\.css loads code with @plugin "tailwind-scrollbar" \(line 2\), which the wizard does not check/],
    ["@config of a package", { "src/index.css": "@config \"@acme/tailwind-config\";\n" }, /^src\/index\.css loads code with @config "@acme\/tailwind-config" \(line 1\)/],
    ["@plugin of a workspace-style name", { "src/index.css": "@plugin \"@repo/tailwind-plugin\";\n" }, /^src\/index\.css loads code with @plugin "@repo\/tailwind-plugin" \(line 1\)/],
    ["<style> in index.html", { "index.html": INDEX_HTML.replace("</head>", "<style type=\"text/tailwindcss\">\n@plugin \"./brand.js\";\n</style>\n</head>") }, /^index\.html loads code with @plugin "\.\/brand\.js" \(line 7\), which the wizard does not check/],
    ["<style> in another HTML entry", { "admin/index.html": "<html><head><style>@config \"./tw.js\";</style></head></html>\n" }, /^admin\/index\.html loads code with @config "\.\/tw\.js" \(line 1\)/],
    ["a stylesheet in a dot-folder", { ".storybook/preview.css": "@plugin \"./sb.js\";\n" }, /^\.storybook\/preview\.css loads code with @plugin "\.\/sb\.js" \(line 1\)/],
    ["a stylesheet in a top-level build/", { "build/theme.css": "@plugin \"./brand.js\";\n" }, /^build\/theme\.css loads code with @plugin "\.\/brand\.js" \(line 1\)/],
    ["the build output of another outDir", { "vite.config.js": "export default { build: { outDir: 'out' } }\n", "dist/x.css": "@plugin './x.js';\n" }, /^dist\/x\.css loads code with @plugin "\.\/x\.js" \(line 1\)/],
  ]);
  assertSafe([
    ["the allowlist", { "src/index.css": "@import \"tailwindcss\";\n@plugin \"@tailwindcss/typography\";\n@plugin \"@tailwindcss/forms\";\n@plugin \"tailwindcss-animate\";\n@plugin \"daisyui\" {\n  themes: light --default, dark --prefersdark;\n}\n@plugin \"daisyui/theme\" {\n  name: \"brand\";\n}\n" }],
    ["HTML without style code", { "index.html": INDEX_HTML.replace("</head>", "<style>body { margin: 0 }</style>\n</head>") }],
    ["Vite's own output folder", { "vite.config.js": "export default { build: { outDir: 'out' } }\n", "out/assets/x.css": "@plugin './x.js';\n" }],
  ]);
});

test("stylesheets imported from outside the app folder: followed inside the repository, not proven safe outside it", () => {
  // In memory, the repository is the app folder itself.
  for (const [label, files, why] of [
    ["a relative import from a module", { "src/main.tsx": "import '../../shared/theme.css'\n" + MAIN_TSX }, /^src\/main\.tsx imports "\.\.\/\.\.\/shared\/theme\.css" \(line 1\), from outside this repository, which the wizard does not check/],
    ["@import from a stylesheet", { "src/index.css": "@import \"../../x.css\";\n" }, /^src\/index\.css imports "\.\.\/\.\.\/x\.css" \(line 1\), from outside this repository/],
    ["a file URL", { "src/main.tsx": "import 'file:///srv/brand.css'\n" }, /^src\/main\.tsx imports "file:\/\/\/srv\/brand\.css" \(line 1\), from outside this repository/],
    ["Vite's /@fs/", { "src/main.tsx": "import '/@fs/srv/brand.css'\n" }, /^src\/main\.tsx imports "\/@fs\/srv\/brand\.css" \(line 1\), from outside this repository/],
    ["an alias out of the app", { "vite.config.js": "import path from 'path'\nexport default { resolve: { alias: { '@brand': path.resolve(__dirname, '../brand') } } }\n", "src/main.tsx": "import '@brand/theme.css'\n" }, /^src\/main\.tsx imports "@brand\/theme\.css" \(line 1\), from outside this repository/],
    ["an alias the wizard cannot follow", { "vite.config.js": "export default { resolve: { alias: [{ find: /^~(.+)/, replacement: '$1' }] } }\n", "src/main.tsx": "import 'some-ui/theme.css'\n" }, /^src\/main\.tsx imports "some-ui\/theme\.css" \(line 1\), and the Vite config has an alias the wizard cannot follow \(a RegExp, or one written in code\), so it cannot tell where that import leads/],
    ["a glob", { "src/main.tsx": "const all = import.meta.glob(['./pages/*.tsx', '../../themes/**/*.css'])\n" }, /^src\/main\.tsx imports "\.\.\/\.\.\/themes\/\*\*\/\*\.css" \(line 1\), from outside this repository/],
    ["<link> in index.html", { "index.html": INDEX_HTML.replace("</head>", "<link rel=\"stylesheet\" href=\"../../brand.css\">\n</head>") }, /^index\.html imports "\.\.\/\.\.\/brand\.css" \(line 6\), from outside this repository/],
    ["a source the wizard cannot read", { "src/big.js": null }, /^src\/big\.js exists, but the wizard cannot read it \(a file it may open, of at most 1 MB\), so it cannot tell what it imports, and Vite builds it/],
  ]) {
    const s = settingsOf({ "package.json": pkgJson(), ...files });
    assert.match(s.exposure?.why ?? "", why, label);
  }
  // Registry packages, the app's own files, root-relative paths and URLs are fine.
  assert.equal(settingsOf({ "package.json": pkgJson(), "src/main.tsx": "import 'normalize.css'\nimport '@fontsource/inter/400.css'\nimport './index.css'\nimport logo from '/vite.svg'\nimport x from 'https://esm.sh/x'\nimport('./lazy.tsx')\nconst u = new URL('./w.js', import.meta.url)\n", "src/index.css": "@import url(\"https://fonts.googleapis.com/css2?family=Inter\");\n@use 'sass:math';\n" }).exposure, null);

  // On disk, in a workspace: a workspace package, a local package and a relative path inside the repository are read
  // with the same checks, wherever they are.
  const ws = (files, appFiles = {}, appPkg = {}) => fixture({
    "package.json": JSON.stringify({ name: "mono", private: true, workspaces: ["apps/*", "packages/*"] }), "package-lock.json": "{}",
    "apps/web/package.json": pkgJson(appPkg), "apps/web/index.html": INDEX_HTML, "apps/web/vercel.json": "{}",
    "apps/web/src/main.tsx": MAIN_TSX, ...Object.fromEntries(Object.entries(appFiles).map(([k, v]) => [`apps/web/${k}`, v])),
    ...files,
  });
  const ui = { "packages/ui/package.json": JSON.stringify({ name: "@acme/ui", version: "0.0.0" }), "packages/ui/src/button.tsx": "import './button.css'\nexport const Button = () => null\n" };
  const leaky = ws({ ...ui, "packages/ui/src/button.css": "@plugin \"../tw/brand.js\";\n" }, { "src/App.tsx": "import { Button } from '@acme/ui'\nexport default () => Button\n" });
  assert.match(web(leaky).data.exposure?.why ?? "", /^\.\.\/\.\.\/packages\/ui\/src\/button\.css loads code with @plugin "\.\.\/tw\/brand\.js" \(line 1\)/);
  const clean = ws({ ...ui, "packages/ui/src/button.css": ".btn { color: red }\n" }, { "src/App.tsx": "import { Button } from '@acme/ui'\nexport default () => Button\n" });
  assert.equal(web(clean).data.exposure, null, web(clean).data.exposure?.why);
  const relative = ws({ "shared/theme.less": "@plugin \"x\";\n" }, { "src/App.tsx": "import '../../../shared/theme.less'\n" });
  assert.match(web(relative).data.exposure?.why ?? "", /^\.\.\/\.\.\/shared\/theme\.less loads code with Less's @plugin \(line 1\)/);
  const local = ws({ "vendor/brand/package.json": JSON.stringify({ name: "@acme/brand" }), "vendor/brand/brand.css": "@config \"./tw.js\";\n" }, { "src/App.tsx": "import '@acme/brand/brand.css'\n" }, { dependencies: { react: "^19.2.8", "react-dom": "^19.2.8", "@acme/brand": "file:../../vendor/brand" } });
  assert.match(web(local).data.exposure?.why ?? "", /^\.\.\/\.\.\/vendor\/brand\/brand\.css loads code with @config "\.\/tw\.js" \(line 1\)/);
});

// create-vite 9.2.1's Vue and Svelte templates (template-vue*, template-svelte*), and create-hono 0.19.5's Cloudflare
// Pages vite.config.ts.
const VUE_CONFIG = "import vue from '@vitejs/plugin-vue'\nimport { defineConfig } from 'vite'\n\n// https://vite.dev/config/\nexport default defineConfig({\n  plugins: [vue()],\n})\n";
const SVELTE_CONFIG = "import { svelte } from '@sveltejs/vite-plugin-svelte'\nimport { defineConfig } from 'vite'\n\n// https://vite.dev/config/\nexport default defineConfig({\n  plugins: [svelte()],\n})\n";
const SVELTE_DOT_CONFIG = "/** @type {import(\"@sveltejs/vite-plugin-svelte\").SvelteConfig} */\nexport default {}\n";
const PAGES_VITE = "import build from '@hono/vite-build/cloudflare-pages'\nimport devServer from '@hono/vite-dev-server'\nimport adapter from '@hono/vite-dev-server/cloudflare'\nimport { defineConfig } from 'vite'\n\nexport default defineConfig({\n  plugins: [\n    build(),\n    devServer({\n      adapter,\n      entry: 'src/index.tsx'\n    })\n  ]\n})\n";
const APP_VUE = "<script setup>\nimport HelloWorld from './components/HelloWorld.vue'\n</script>\n\n<template>\n  <HelloWorld />\n</template>\n\n<style scoped>\n.logo { height: 6em; }\n</style>\n";
const vueTs = { "vite.config.ts": VUE_CONFIG, "package.json": pkgJson({ scripts: { dev: "vite", build: "vue-tsc -b && vite build", preview: "vite preview" } }), "tsconfig.json": JSON.stringify({ files: [], references: [{ path: "./tsconfig.app.json" }, { path: "./tsconfig.node.json" }] }), "tsconfig.app.json": JSON.stringify({ extends: "@vue/tsconfig/tsconfig.dom.json", compilerOptions: { types: ["vite/client"] }, include: ["src/**/*.ts", "src/**/*.vue"] }), "tsconfig.node.json": JSON.stringify({ compilerOptions: { noEmit: true }, include: ["vite.config.ts"] }), "node_modules/@vue/tsconfig/tsconfig.dom.json": JSON.stringify({ extends: "./tsconfig.json", compilerOptions: { lib: ["ES2022", "DOM"] } }), "node_modules/@vue/tsconfig/tsconfig.json": JSON.stringify({ compilerOptions: { noEmit: true, jsxImportSource: "vue" } }), "src/App.vue": APP_VUE };

test("@vitejs/plugin-vue, @sveltejs/vite-plugin-svelte and @hono/vite-build are read as safe with their known options, and their files are checked", () => {
  assertSafe([
    ["create-vite vue", { "vite.config.js": VUE_CONFIG, "package.json": pkgJson({ scripts: { dev: "vite", build: "vite build", preview: "vite preview" } }), "src/App.vue": APP_VUE }],
    ["create-vite vue-ts (vue-tsc -b)", vueTs],
    ["plugin-vue's literal options", { "vite.config.js": "import vue from '@vitejs/plugin-vue'\nexport default { plugins: [vue({ include: [/\\.vue$/], script: { babelParserPlugins: ['decorators'] }, template: { compilerOptions: { whitespace: 'condense', comments: false }, transformAssetUrls: { img: ['src'] } }, features: { optionsAPI: false, prodDevtools: false } })] }\n" }],
    ["create-vite svelte", { "vite.config.js": SVELTE_CONFIG, "svelte.config.js": SVELTE_DOT_CONFIG, "src/App.svelte": "<script>\n  import Counter from './lib/Counter.svelte'\n</script>\n\n<main><Counter /></main>\n\n<style>\n  .logo { height: 6em; }\n</style>\n" }],
    ["svelte.config.js with vitePreprocess", { "vite.config.ts": SVELTE_CONFIG, "svelte.config.js": "import { vitePreprocess } from '@sveltejs/vite-plugin-svelte'\n\nexport default {\n  preprocess: vitePreprocess({ script: true }),\n  compilerOptions: { runes: true },\n}\n" }],
    ["svelte()'s literal options", { "vite.config.js": "import { svelte, vitePreprocess } from '@sveltejs/vite-plugin-svelte'\nexport default { plugins: [svelte({ configFile: false, preprocess: [vitePreprocess()], compilerOptions: { css: 'injected' }, emitCss: false, extensions: ['.svelte'] })] }\n" }],
    ["create-hono's Cloudflare Pages config", { "vite.config.ts": PAGES_VITE }],
    ["@hono/vite-build's literal options", { "vite.config.ts": "import build from '@hono/vite-build'\nexport default { plugins: [build({ entry: ['./src/index.ts'], outputDir: './dist', minify: false, external: ['pg'] })] }\n" }],
  ]);
  const V = "import vue from '@vitejs/plugin-vue'\n";
  assertNotSafe([
    ["a custom Vue compiler", { "vite.config.js": V + "import * as compiler from 'vue/compiler-sfc'\nexport default { plugins: [vue({ compiler })] }\n" }, /uses the import of vue\/compiler-sfc \(line 2\)/],
    ["Vue compiler transforms", { "vite.config.js": V + "export default { plugins: [vue({ template: { compilerOptions: { nodeTransforms: [(node) => node] } } })] }\n" }, /uses the option template of @vitejs\/plugin-vue \(line 2\)/],
    // The compiler calls it while Vite builds, so even a function that names nothing of the environment is code there.
    ["a custom-element test", { "vite.config.js": V + "export default { plugins: [vue({ template: { compilerOptions: { isCustomElement: (tag) => tag.startsWith('ion-') } } })] }\n" }, /uses the option template of @vitejs\/plugin-vue \(line 2\)/],
    ["a component id function", { "vite.config.js": V + "export default { plugins: [vue({ features: { componentIdGenerator: (p) => p } })] }\n" }, /uses the option features of @vitejs\/plugin-vue \(line 2\)/],
    ["a Pug template", { "vite.config.js": VUE_CONFIG, "src/App.vue": "<template lang=\"pug\">\np= 'hi'\n</template>\n" }, /^src\/App\.vue has a <template lang="pug"> \(line 1\), which compiles in a language that can run code when Vite builds, and the wizard does not check it/],
    ["a template from another file", { "vite.config.js": VUE_CONFIG, "src/App.vue": "<template src=\"./app.html\"></template>\n" }, /^src\/App\.vue has a <template src> \(line 1\)/],
    ["Less's @plugin in a Vue style block", { "vite.config.js": VUE_CONFIG, "src/App.vue": "<template><p/></template>\n<style lang=\"less\">\n@plugin \"x\";\n</style>\n" }, /^src\/App\.vue loads code with Less's @plugin \(line 3\)/],
    ["@plugin in a Svelte style block", { "vite.config.js": SVELTE_CONFIG, "src/App.svelte": "<main />\n<style>\n  @config \"./tw.js\";\n</style>\n" }, /^src\/App\.svelte loads code with @config "\.\/tw\.js" \(line 3\)/],
    ["vue-tsc with a language plugin", { ...vueTs, "tsconfig.app.json": JSON.stringify({ extends: "@vue/tsconfig/tsconfig.dom.json", vueCompilerOptions: { plugins: ["@vue/language-plugin-pug"] } }) }, /^tsconfig\.app\.json sets vueCompilerOptions\.plugins, code vue-tsc loads when the build runs it/],
    ["vue-tsc with a tsconfig it cannot read", Object.fromEntries(Object.entries(vueTs).filter(([k]) => !k.startsWith("node_modules/"))), /^vue-tsc runs in the build, and the wizard cannot read tsconfig\.app\.json's extends "@vue\/tsconfig\/tsconfig\.dom\.json"/],
    ["a preprocessor of another package", { "vite.config.js": "import { svelte } from '@sveltejs/vite-plugin-svelte'\nimport sveltePreprocess from 'svelte-preprocess'\nexport default { plugins: [svelte({ preprocess: sveltePreprocess() })] }\n" }, /uses the import of svelte-preprocess \(line 2\)/],
    ["svelte's onwarn", { "vite.config.js": "import { svelte } from '@sveltejs/vite-plugin-svelte'\nexport default { plugins: [svelte({ onwarn: (w, h) => h(w) })] }\n" }, /uses the option onwarn of @sveltejs\/vite-plugin-svelte \(line 2\)/],
    ["another svelte config file", { "vite.config.js": "import { svelte } from '@sveltejs/vite-plugin-svelte'\nexport default { plugins: [svelte({ configFile: './svelte.prod.js' })] }\n" }, /uses the option configFile of @sveltejs\/vite-plugin-svelte \(line 2\)/],
    ["vitePreprocess with a Vite config", { "vite.config.js": "import { svelte, vitePreprocess } from '@sveltejs/vite-plugin-svelte'\nexport default { plugins: [svelte({ preprocess: vitePreprocess({ style: { configFile: './x.js' } }) })] }\n" }, /uses the option preprocess of @sveltejs\/vite-plugin-svelte \(line 2\)/],
    ["svelte.config.js with another preprocessor", { "vite.config.js": SVELTE_CONFIG, "svelte.config.js": "import sveltePreprocess from 'svelte-preprocess'\nexport default { preprocess: sveltePreprocess({ replace: [['__ENV__', JSON.stringify(process.env)]] }) }\n" }, /^svelte\.config\.js uses the import of svelte-preprocess \(line 1\), which the wizard does not check, and the Svelte plugin runs it when Vite builds/],
    ["svelte.config.js with onwarn", { "vite.config.js": SVELTE_CONFIG, "svelte.config.js": "export default { onwarn: (w, h) => h(w) }\n" }, /^svelte\.config\.js uses the setting onwarn \(line 1\)/],
    ["svelte.config.js of SvelteKit", { "vite.config.js": SVELTE_CONFIG, "svelte.config.js": "export default { kit: { adapter: 'x' } }\n" }, /^svelte\.config\.js uses the setting kit \(line 1\)/],
    ["@hono/vite-build's hooks", { "vite.config.ts": "import build from '@hono/vite-build/cloudflare-pages'\nexport default { plugins: [build({ entryContentBeforeHooks: [() => 'x'] })] }\n" }, /uses the option entryContentBeforeHooks of @hono\/vite-build\/cloudflare-pages \(line 2\)/],
    ["@hono/vite-build's entry outside the app", { "vite.config.ts": "import build from '@hono/vite-build'\nexport default { plugins: [build({ entry: '../server/index.ts' })] }\n" }, /uses the option entry of @hono\/vite-build \(line 2\)/],
    ["another dev-server adapter", { "vite.config.ts": "import devServer from '@hono/vite-dev-server'\nimport node from '@hono/vite-dev-server/node'\nexport default { plugins: [devServer({ adapter: node })] }\n" }, /uses the import of @hono\/vite-dev-server\/node \(line 2\)/],
    // The name env is refused wherever it is in a config.
    ["the dev server's env", { "vite.config.ts": "import devServer from '@hono/vite-dev-server'\nexport default { plugins: [devServer({ env: { A: '1' } })] }\n" }, /uses the name env \(line 2\)/],
    ["the dev server's loadModule", { "vite.config.ts": "import devServer from '@hono/vite-dev-server'\nexport default { plugins: [devServer({ loadModule: (s, e) => s.ssrLoadModule(e) })] }\n" }, /uses the option loadModule of @hono\/vite-dev-server \(line 2\)/],
  ]);
});

test("the import scan: tool-state folders are not read for imports (their stylesheets are), and node_modules is the registry's", () => {
  // Bundles of the package manager and of host tools: never imported by the build, often over 1 MB.
  for (const file of [".yarn/releases/yarn-4.9.0.cjs", ".wrangler/tmp/dev-x/index.js", ".vercel/output/functions/_middleware.func/index.js", ".turbo/cache/x.js", ".cache/babel/x.js"]) {
    assert.equal(settingsOf({ "package.json": pkgJson(), [file]: null }).exposure, null, file);
  }
  assert.match(settingsOf({ "package.json": pkgJson(), ".wrangler/tmp/x.css": "@plugin './x.js';\n" }).exposure?.why ?? "", /^\.wrangler\/tmp\/x\.css loads code with @plugin/, "their stylesheets are still read");
  assert.match(settingsOf({ "package.json": pkgJson(), ".storybook/main.js": null }).exposure?.why ?? "", /^\.storybook\/main\.js exists, but the wizard cannot read it/, "another dot-folder is read");
  // A relative path into node_modules is a registry package, as a bare name would be.
  const ws = mono({ "apps/web/src/index.scss": "@import \"../../../node_modules/bootstrap/scss/bootstrap\";\n" });
  assert.equal(web(ws).data.exposure, null, web(ws).data.exposure?.why);
  // An empty node-options sets nothing.
  assert.equal(settingsOf({ "package.json": pkgJson(), ".npmrc": "node-options=\n" }).exposure, null);
});

test("npm: aliases: only the same package from the registry", () => {
  const dev = (vite) => ({ "package.json": pkgJson({ devDependencies: { vite, "@vitejs/plugin-react": "^6.1.1" } }) });
  assertNotSafe([["another package by name only", dev("npm:other-vite"), /^package\.json declares vite as "npm:other-vite"/]]);
  assertSafe([["npm:vite", dev("npm:vite")], ["Yarn's npm:<range>", dev("npm:^8.3.0")]]);
});

test("folders the stylesheet tools read from: postcss-import's paths and additionalData's imports stay inside the repository or are read", () => {
  assertNotSafe([
    ["postcss-import's path outside the app", { "postcss.config.js": "export default { plugins: { 'postcss-import': { path: ['../../shared/styles'] } } }\n" }, /^postcss\.config\.js uses the option path of postcss-import \(line 1\), which the wizard does not check/],
    ["postcss-import's root, as data", { ".postcssrc.json": JSON.stringify({ plugins: { "postcss-import": { root: "/srv/styles" } } }) }, /^\.postcssrc\.json uses the option root of postcss-import, which the wizard does not check/],
    ["additionalData from outside the repository", { "vite.config.js": "export default { css: { preprocessorOptions: { scss: { additionalData: '@use \"../../brand/vars\" as *;' } } } }\n" }, /^The Vite config gives the build "\.\.\/\.\.\/brand\/vars", from outside this repository/],
    ["a load path written as an absolute path", { "vite.config.js": "export default { css: { preprocessorOptions: { scss: { loadPaths: ['/srv/styles'] } } } }\n" }, /^The Vite config gives the build inputs or stylesheet folders the wizard cannot follow \(written in code, or an absolute path\)/],
  ]);
  assertSafe([
    ["postcss-import's path inside the app", { "postcss.config.js": "export default { plugins: { 'postcss-import': { path: ['src/styles'] } } }\n" }],
    ["additionalData from inside the app", { "vite.config.js": "export default { css: { preprocessorOptions: { scss: { additionalData: '@use \"./src/vars\" as *;\\n@use \"sass:math\";' } } } }\n", "src/vars.scss": "$c: red;\n" }],
  ]);
});

// Friction, without giving up the proof: an override that pins a package the guard trusts to a version from the npm
// registry keeps it a registry package; Yarn's own release file at the place `yarn set version` writes it is the
// package manager itself. Everything else stays not proven safe.
test("overrides of trusted packages to a registry version are allowed; local code, aliases, git, URLs and patches are not", () => {
  assertSafe([
    ["npm overrides to a range", { "package.json": pkgJson({ overrides: { vite: "^8.3.0" } }) }],
    ["npm overrides, nested", { "package.json": pkgJson({ overrides: { "some-tool": { postcss: "8.5.0" } } }) }],
    ["npm overrides with the package's own version and its dependencies'", { "package.json": pkgJson({ overrides: { vite: { ".": "8.3.0", esbuild: "0.25.0" } } }) }],
    ["yarn resolutions", { "package.json": pkgJson({ resolutions: { "**/@vitejs/plugin-react": "6.1.1", "vite@npm:8.3.0": "8.3.1" } }) }],
    ["pnpm overrides", { "package.json": pkgJson({ pnpm: { overrides: { "foo>vite": "8.3.0", "vite@<8": "^8.3.0" } } }) }],
    ["pnpm-workspace.yaml overrides", { "pnpm-workspace.yaml": "overrides:\n  esbuild: 0.25.0\n" }],
    ["npm: with the same name", { "package.json": pkgJson({ overrides: { vite: "npm:vite@^8.3.0" } }) }],
  ]);
  assertNotSafe([
    ["a folder", { "package.json": pkgJson({ overrides: { vite: "file:../vite" } }) }, /^package\.json's overrides replace vite with "file:\.\.\/vite", not a version from the npm registry/],
    ["a link", { "package.json": pkgJson({ resolutions: { vite: "link:../vite" } }) }, /^package\.json's resolutions replace vite with "link:\.\.\/vite"/],
    ["a workspace package", { "package.json": pkgJson({ pnpm: { overrides: { vite: "workspace:*" } } }) }, /^package\.json's pnpm\.overrides replace vite with "workspace:\*"/],
    ["git", { "package.json": pkgJson({ overrides: { "@vitejs/plugin-react": "github:someone/plugin-react#main" } }) }, /^package\.json's overrides replace @vitejs\/plugin-react with "github:someone\/plugin-react#main"/],
    ["a URL", { "package.json": pkgJson({ overrides: { vite: "https://example.com/vite.tgz" } }) }, /^package\.json's overrides replace vite with "https:\/\/example\.com\/vite\.tgz"/],
    ["an alias to another package", { "package.json": pkgJson({ overrides: { vite: "npm:rolldown-vite@7.1.0" } }) }, /^package\.json's overrides replace vite with "npm:rolldown-vite@7\.1\.0"/],
    ["yarn's patch protocol", { "package.json": pkgJson({ resolutions: { vite: "patch:vite@npm%3A8.3.0#./patches/vite.patch" } }) }, /^package\.json's resolutions replace vite with "patch:vite@npm%3A8\.3\.0#\.\/patches\/vite\.patch"/],
    ["a nested folder under a trusted package", { "package.json": pkgJson({ overrides: { vite: { ".": "8.3.0", esbuild: "file:../esbuild" } } }) }, /^package\.json's overrides replace esbuild with "file:\.\.\/esbuild"/],
    ["a nested version that is a folder", { "package.json": pkgJson({ overrides: { vite: { ".": "file:../vite" } } }) }, /^package\.json's overrides replace vite with "file:\.\.\/vite"/],
    ["npm's reference to the root's own version", { "package.json": pkgJson({ overrides: { vite: "$vite" } }) }, /^package\.json's overrides change vite, which the build runs/],
    ["pnpm's removal", { "package.json": pkgJson({ pnpm: { overrides: { "@vitejs/plugin-react": "-" } } }) }, /^package\.json's pnpm\.overrides change @vitejs\/plugin-react, which the build runs/],
    ["pnpm patchedDependencies", { "package.json": pkgJson({ pnpm: { patchedDependencies: { "vite@8.3.0": "patches/vite.patch" } } }) }, /^package\.json's pnpm\.patchedDependencies change vite/],
    ["pnpm packageExtensions", { "package.json": pkgJson({ pnpm: { packageExtensions: { "vite@8": { dependencies: { x: "1" } } } } }) }, /^package\.json's pnpm\.packageExtensions change vite/],
  ]);
});

test("yarnPath: Yarn's own release file at .yarn/releases/yarn-<version>.cjs, present in the repository, is allowed and named in the report; look-alikes are not", () => {
  const RELEASE = ".yarn/releases/yarn-4.9.0.cjs";
  const yarnrc = (path) => ({ ".yarnrc.yml": `nodeLinker: node-modules\nyarnPath: ${path}\n` });
  const kind = (files) => (rel) => (rel in files ? "file" : Object.keys(files).some((k) => k.startsWith(`${rel}/`)) ? "dir" : null);
  const inMemory = (files) => settingsOf({ "package.json": pkgJson(), ...files }, { kind: kind({ "package.json": "", ...files }) });
  for (const path of [RELEASE, ".yarn/releases/yarn-4.0.0-rc.53.cjs"]) {
    const files = { ...yarnrc(path), [path]: "// yarn\n" };
    const s = inMemory(files);
    assert.equal(s.exposure, null, `${path}: ${s.exposure?.why}`);
    assert.deepEqual(s.yarnReleases, [path]);
    const d = self(app({ "vercel.json": "{}", ...files }));
    assert.equal(d.data.exposure, null, `${path} (on disk): ${d.data.exposure?.why}`);
    assert.equal(d.parts.server.kind, "vercel-edge");
    const notes = viteReact.hostNotes(d, vercelHost(null), { browser: true, server: true, unitHasBrowser: true });
    assert.ok(notes.includes(`Yarn's own release file (${path}) runs at install; the wizard trusted it by its standard location, not by reading it.`), notes.join("\n"));
  }
  // Up the tree, in the workspace root: the path is given from the app folder.
  const up = settingsOf({ "package.json": pkgJson(), "../../package.json": JSON.stringify({ name: "mono", workspaces: ["apps/*"] }), "../../.yarnrc.yml": `yarnPath: ${RELEASE}\n`, [`../../${RELEASE}`]: "// yarn\n" }, { ...inWorkspace, kind: (rel) => (rel === `../../${RELEASE}` ? "file" : rel === "../../.yarn" || rel === "../../.yarn/releases" ? "dir" : null) });
  assert.equal(up.exposure, null, up.exposure?.why);
  assert.deepEqual(up.yarnReleases, [`../../${RELEASE}`]);
  // Look-alikes, a missing file, and no way to tell what is there.
  for (const [path, why, extra] of [
    [".yarn/releases/../evil.cjs", /is not where `yarn set version` puts Yarn's own release/, { ".yarn/evil.cjs": "" }],
    [".yarn/releases/yarn-4.cjs.js", /is not where `yarn set version` puts Yarn's own release/, { ".yarn/releases/yarn-4.cjs.js": "" }],
    ["/tmp/yarn-4.9.0.cjs", /is not where `yarn set version` puts Yarn's own release/, {}],
    ["./.yarn/releases/yarn-4.9.0.cjs", /is not where `yarn set version` puts Yarn's own release/, { [RELEASE]: "" }],
    [RELEASE, /\.yarn\/releases\/yarn-4\.9\.0\.cjs is not there/, {}],
  ]) {
    const s = inMemory({ ...yarnrc(path), ...extra });
    assert.match(s.exposure?.why ?? "", /^\.yarnrc\.yml sets yarnPath, a file Yarn runs in its own place when it installs, and /, path);
    assert.match(s.exposure.why, why, path);
  }
  const unknown = settingsOf({ "package.json": pkgJson(), ...yarnrc(RELEASE), [RELEASE]: "" });
  assert.match(unknown.exposure?.why ?? "", /the wizard cannot check that \.yarn\/releases\/yarn-4\.9\.0\.cjs is a file in the repository/);
  assert.match(inMemory({ ".yarnrc.yml": "yarnPath: 4\n" }).exposure?.why ?? "", /^\.yarnrc\.yml sets yarnPath, a file Yarn runs in its own place when it installs, and 4 is not where/);
  // Yarn's plugins stay not proven safe, and so does yarn classic's yarn-path.
  assert.match(inMemory({ ".yarnrc.yml": `yarnPath: ${RELEASE}\nplugins:\n  - path: .yarn/plugins/x.cjs\n`, [RELEASE]: "" }).exposure?.why ?? "", /^\.yarnrc\.yml sets plugins, code Yarn loads when it installs/);
  assert.match(inMemory({ ".yarnrc": `yarn-path "${RELEASE}"\n`, [RELEASE]: "" }).exposure?.why ?? "", /^\.yarnrc sets yarn-path/);
});

test("yarnPath on disk: a link at the standard place, or a linked .yarn folder, is not the release file in the repository", { skip: process.platform === "win32" }, () => {
  const RELEASE = ".yarn/releases/yarn-4.9.0.cjs";
  const outside = fixture({ "yarn.cjs": "// not yarn\n", "releases/yarn-4.9.0.cjs": "// not yarn\n" });
  const linkedFile = app({ "vercel.json": "{}", ".yarnrc.yml": `yarnPath: ${RELEASE}\n` });
  mkdirSync(join(linkedFile, ".yarn/releases"), { recursive: true });
  symlinkSync(join(outside, "yarn.cjs"), join(linkedFile, RELEASE));
  assert.match(self(linkedFile).data.exposure?.why ?? "", /\.yarn\/releases\/yarn-4\.9\.0\.cjs is a link/);
  const linkedFolder = app({ "vercel.json": "{}", ".yarnrc.yml": `yarnPath: ${RELEASE}\n` });
  mkdirSync(join(linkedFolder, ".yarn"));
  symlinkSync(join(outside, "releases"), join(linkedFolder, ".yarn/releases"));
  assert.match(self(linkedFolder).data.exposure?.why ?? "", /\.yarn\/releases is a link/);
});

test("yarnPath beside a server's Vite build: the server part is added, and the report names the release file trusted by its location", () => {
  const RELEASE = ".yarn/releases/yarn-4.9.0.cjs";
  const dir = fixture({
    "package.json": JSON.stringify({ name: "shop", type: "module", packageManager: "yarn@4.9.0", scripts: { build: "vite build", start: "node server.js" }, dependencies: { express: "^5.1.0", react: "^19.2.8", "react-dom": "^19.2.8" }, devDependencies: { vite: "^8.3.0", "@vitejs/plugin-react": "^6.1.1" } }),
    "yarn.lock": "", ".yarnrc.yml": `nodeLinker: node-modules\nyarnPath: ${RELEASE}\n`, [RELEASE]: "// yarn\n",
    "index.html": INDEX_HTML, "src/main.tsx": MAIN_TSX, "vite.config.js": R + "export default defineConfig({ plugins: [react()] })\n",
    "server.js": "import express from 'express'\n\nconst app = express()\napp.use(express.static('dist'))\napp.listen(3000)\n",
  });
  const [u] = scanApps(dir).units;
  assert.equal(u.server?.integration, "express", u.warnings.join("\n"));
  assert.ok(u.warnings.includes(`Express: Yarn's own release file (${RELEASE}) runs at install; the wizard trusted it by its standard location, not by reading it.`), u.warnings.join("\n"));
});
