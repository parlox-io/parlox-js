import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { addViteEntry, moduleEntry, removeViteEntry } from "../dist/edits/vite-entry.js";
import { exposesSecret, readViteSettings, VITE_CONFIGS } from "../dist/edits/vite-config.js";
import { viteReact, viteServerKind } from "../dist/integrations/vite-react.js";
import { INTEGRATIONS } from "../dist/integrations/registry.js";
import { describeUnit, scanApps } from "../dist/apps.js";
import { applyPlan } from "../dist/plan-core.js";
import { readInside } from "../dist/fs-safe.js";
import { detectHost, vercelHost } from "../dist/hosts.js";
import { main } from "../dist/cli.js";
import { BROWSER_VERSION, SERVER_VERSION, VERCEL_FUNCTIONS_VERSION } from "../dist/versions.js";
import { fixture } from "./helpers.mjs";
import { startFakeAuth, startFakeGateway } from "./fake-servers.mjs";

const PK = "pk_" + "a1".repeat(12);
// src/main.tsx exactly as create-vite 9.2.1 writes it (template react-ts).
const MAIN_TSX = `import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
`;
const INDEX_HTML = `<!doctype html>\n<html lang="en">\n  <head>\n    <meta charset="UTF-8" />\n    <title>shop</title>\n  </head>\n  <body>\n    <div id="root"></div>\n    <script type="module" src="/src/main.tsx"></script>\n  </body>\n</html>\n`;
const pkgJson = (extra = {}) => JSON.stringify({ name: "shop", type: "module", dependencies: { react: "^19.2.8", "react-dom": "^19.2.8" }, devDependencies: { vite: "^8.3.0", "@vitejs/plugin-react": "^6.1.1" }, ...extra });
const app = (files = {}) => fixture({ "package.json": pkgJson(), "package-lock.json": "{}", "tsconfig.json": "{}", "index.html": INDEX_HTML, "src/main.tsx": MAIN_TSX, ...files });
const git = { isRepo: () => false, dirty: () => [], isTracked: () => false, isIgnored: () => false };
const reader = (dir) => (rel) => (existsSync(join(dir, rel)) ? readFileSync(join(dir, rel), "utf8") : null);
const OTHER = { id: "netlify", label: "Netlify", where: "Project configuration → Environment variables", docs: null, vercelDir: null };
const UNKNOWN = { id: "unknown", label: "your host", where: "your host's environment-variable settings", docs: null, vercelDir: null };
const input = (dir, host) => ({ publicKey: PK, verifyToken: "vt_fake", host, versions: { browser: BROWSER_VERSION, server: SERVER_VERSION }, parts: { browser: true, server: true }, read: reader(dir), git });
const self = (dir) => viteReact.detect(dir, dir);
const detectHostOf = (d) => detectHost(d.dir, d.root);
/** The names in a folder of `files` (in memory), a folder's with "/" after it. */
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
/** readViteSettings over files in memory: a file exists when it is listed (null: listed, but it cannot be read). An app
 * outside a workspace unless `app` says otherwise. */
const settingsOf = (files, app = {}) => readViteSettings((rel) => (rel in files ? files[rel] : null), (rel) => rel in files, { list: listOf(files), postcssTop: ".", workspace: null, ...app });

test("registered after Next.js", () => {
  assert.deepEqual(INTEGRATIONS.map((i) => i.id).slice(0, 2), ["nextjs", "vite-react"]);
});

test("detect: react and vite without next; the entry from index.html's module script", () => {
  const dir = app();
  const d = viteReact.detect(dir, dir);
  assert.deepEqual(d.facts, [["Found", "Vite React · src/main.tsx · TypeScript · npm"]]);
  assert.deepEqual(d.parts.browser, { file: "src/main.tsx", kind: "vite-entry" });
  assert.equal(d.parts.server.kind, "host-question", "no host file: the host is asked");
  assert.equal(d.envFile, null);
  assert.equal(self(fixture({ "package.json": JSON.stringify({ dependencies: { react: "19", vite: "8", next: "16" } }) })), null);
  assert.equal(self(fixture({ "package.json": JSON.stringify({ dependencies: { vue: "3", vite: "8" } }) })), null, "Vue on Vite is not covered");
  assert.equal(self(app({ "vercel.json": "{}" })).parts.server.kind, "vercel-edge");
  assert.equal(self(app({ "netlify.toml": "" })).parts.server.kind, "verify-file");
});

test("detect: Vite frameworks with their own server and routing are declined with the guide; a client-side router is not", () => {
  for (const [dep, name] of [["@react-router/dev", "React Router in framework mode"], ["@remix-run/dev", "Remix"], ["@tanstack/react-start", "TanStack Start"], ["vike", "Vike"], ["@tanstack/start", "TanStack Start"], ["vite-plugin-ssr", "Vike"], ["astro", "Astro"], ["waku", "Waku"], ["@redwoodjs/core", "RedwoodJS"], ["@redwoodjs/vite", "RedwoodJS"]]) {
    const dir = app({ "vercel.json": "{}", "package.json": pkgJson({ devDependencies: { vite: "^8.3.0", [dep]: "1.0.0" } }) });
    assert.throws(() => self(dir), (e) => e.code === "not-supported" && e.message.startsWith(`${name} (${dep}) is a framework with its own server and routing, not a Vite React single-page app;`) && e.message.endsWith("See https://gateway.parlox.io/install.md"), dep);
    // In a scan, the refusal is what the developer is told, not "no supported stack".
    assert.equal(scanApps(dir).problems[0]?.error.message.includes(dep), true, dep);
  }
  for (const router of ["react-router-dom", "react-router"]) {
    const d = self(app({ "package.json": pkgJson({ dependencies: { react: "^19.2.8", "react-dom": "^19.2.8", [router]: "^7.9.0" } }) }));
    assert.equal(d?.integration, "vite-react", router);
  }
});

test("detect: a folder where index.html cannot be read, or its script leaves the folder, gets the snippet, not an error", () => {
  const dir = app();
  const noHtml = fixture({ "package.json": pkgJson() });
  mkdirSync(join(noHtml, "index.html"));
  assert.equal(self(noHtml).parts.browser.file, null, "a folder named index.html is not read");
  assert.match(self(noHtml).parts.browser.manualReason, /No index\.html/);
  const outside = app({ "index.html": '<script type="module" src="../shared/main.tsx"></script>' });
  assert.match(self(outside).parts.browser.manualReason, /outside this folder/);
  assert.equal(self(dir).data.entry, "src/main.tsx");
});

test("detect: Vite's root moves index.html and the public folder", () => {
  const dir = fixture({ "package.json": pkgJson(), "vite.config.ts": "import { defineConfig } from 'vite'\nexport default defineConfig({ root: 'client' })\n", "client/index.html": '<script type="module" src="/main.jsx"></script>', "client/main.jsx": "" });
  const d = self(fixture({ "package.json": pkgJson(), "netlify.toml": "", "vite.config.ts": "export default { root: './client/' }", "client/index.html": '<script type="module" src="./main.jsx"></script>' }));
  assert.equal(d.data.entry, "client/main.jsx");
  assert.equal(d.data.publicDir, "client/public");
  assert.equal(d.parts.server.file, "client/public/.well-known/parlox-verify");
  assert.equal(self(dir).data.entry, "client/main.jsx");
  const computed = self(fixture({ "package.json": pkgJson(), "vite.config.ts": "export default { root: path.resolve(__dirname, 'client') }", "index.html": INDEX_HTML }));
  assert.equal(computed.data.entry, null, "a root set in code: the wizard cannot tell which index.html Vite uses");
  assert.match(computed.data.entryReason, /root/);
  assert.equal(computed.data.publicDir, null);
});

test("in a monorepo scan, each Vite app says where its server part comes from", () => {
  const root = fixture({
    "package.json": JSON.stringify({ name: "mono", private: true, workspaces: ["apps/*"] }), "package-lock.json": "{}",
    "apps/web/package.json": pkgJson(), "apps/web/index.html": INDEX_HTML, "apps/web/src/main.tsx": MAIN_TSX,
    "apps/shop/package.json": pkgJson(), "apps/shop/vercel.json": "{}", "apps/shop/index.html": INDEX_HTML, "apps/shop/src/main.tsx": MAIN_TSX,
    "apps/blog/package.json": pkgJson(), "apps/blog/netlify.toml": "", "apps/blog/index.html": INDEX_HTML, "apps/blog/src/main.tsx": MAIN_TSX,
    "apps/rr/package.json": pkgJson({ devDependencies: { vite: "^8.3.0", "@react-router/dev": "^7.9.0" } }),
  });
  const scan = scanApps(root);
  assert.deepEqual(scan.units.map(describeUnit), [
    "apps/blog/ · Vite React · browser part only (static site)",
    "apps/shop/ · Vite React · browser part (server part on Vercel)",
    "apps/web/ · Vite React · browser part (server part if it deploys on Vercel)",
  ]);
  assert.deepEqual(scan.problems.map((p) => p.rel), ["apps/rr"]);
});

test("moduleEntry: one local module script; external, commented-out and duplicate scripts do not count", () => {
  assert.equal(moduleEntry('<script type="module" src="/src/main.tsx"></script>'), "src/main.tsx");
  assert.equal(moduleEntry('<script type=module src="./src/main.jsx"></script><script type="module" src="https://cdn.example/x.js"></script>'), "src/main.jsx");
  assert.equal(moduleEntry('<script type="module" src="/a.js"></script><script type="module" src="/b.js"></script>'), null);
  assert.equal(moduleEntry("<script src=\"/src/main.js\"></script>"), null);
  assert.equal(moduleEntry('<!-- <script type="module" src="/old.jsx"></script> -->\n<script type="module" src="/src/main.jsx"></script>'), "src/main.jsx");
  assert.equal(moduleEntry('<script data-type="module" src="/src/a.js"></script><script type="modulepreload" src="/src/b.js"></script>'), null);
  assert.equal(moduleEntry('<script type="module" src="//cdn.example/x.js"></script>'), null);
  // A query or a hash is not part of the file's name; a source with a scheme (data:, a drive letter) is not the app's own.
  assert.equal(moduleEntry('<script type="module" src="/src/main.tsx?v=1"></script>'), "src/main.tsx");
  assert.equal(moduleEntry('<script type="module" src="/src/main.tsx#x"></script>'), "src/main.tsx");
  assert.equal(moduleEntry('<script type="module" src="data:text/javascript,alert(1)"></script>'), null);
  assert.equal(moduleEntry('<script type="module" src="C:/x/main.tsx"></script>'), null);
  assert.equal(moduleEntry('<script type="module" src="data:text/javascript,1"></script><script type="module" src="/src/main.tsx"></script>'), "src/main.tsx");
  // A ">" inside a quoted attribute does not end the tag.
  assert.equal(moduleEntry('<script title="a>b" type="module" src="/src/main.tsx"></script>'), "src/main.tsx");
});

test("the entry edit sits beside <App /> inside StrictMode; a bare <App /> becomes a fragment; uninstall gives back the exact bytes", () => {
  const e = addViteEntry(MAIN_TSX, "src/main.tsx", PK);
  assert.equal(e.code, `import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { ParloxAnalytics } from '@parlox/browser/react'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
    <ParloxAnalytics publicKey="${PK}" />
  </StrictMode>,
)
`);
  assert.equal(addViteEntry(e.code, "src/main.tsx", PK).changed, false, "a second run changes nothing");
  assert.equal(removeViteEntry(e.code, "src/main.tsx").code, MAIN_TSX);
  const bare = `import React from "react";\nimport ReactDOM from "react-dom/client";\nimport App from "./App";\n\nReactDOM.createRoot(document.getElementById("root")).render(<App />);\n`;
  const b = addViteEntry(bare, "src/main.jsx", PK);
  assert.match(b.code, /\.render\(<><App \/><ParloxAnalytics publicKey="pk_a1\w+" \/><\/>\);/);
  assert.match(b.code, /^import App from "\.\/App";\nimport \{ ParloxAnalytics \} from "@parlox\/browser\/react";\n\n/m);
  assert.equal(removeViteEntry(b.code, "src/main.jsx").code, bare, "the blank line after the imports survives (recast's reprint would drop it)");
  const crlf = MAIN_TSX.replace(/\n/g, "\r\n");
  assert.equal(removeViteEntry(addViteEntry(crlf, "src/main.tsx", PK).code, "src/main.tsx").code, crlf);
  // Inline StrictMode, React.StrictMode and another wrapper element round-trip too.
  for (const code of [
    "import { createRoot } from 'react-dom/client'\ncreateRoot(root).render(<StrictMode><App /></StrictMode>)\n",
    "import React from 'react'\nimport ReactDOM from 'react-dom/client'\nReactDOM.createRoot(root).render(\n  <React.StrictMode>\n\t\t<App />\n  </React.StrictMode>\n)\n",
    "import { createRoot } from 'react-dom/client'\ncreateRoot(root).render(\n  <Provider store={store}>\n    <App />\n  </Provider>,\n)\n",
  ]) {
    const r = addViteEntry(code, "src/main.jsx", PK);
    assert.equal(r.ok && r.changed, true, code);
    assert.equal(removeViteEntry(r.code, "src/main.jsx").code, code, code);
  }
  assert.match(addViteEntry("createRoot(root).render(\n  <React.StrictMode>\n\t\t<App />\n  </React.StrictMode>\n)\n", "src/main.jsx", PK).code, /\n\t\t<App \/>\n\t\t<ParloxAnalytics /, "at the indentation of the element beside it");
});

test("uninstall leaves an import the wizard wrote when nothing else of Parlox is in the file out too, and only that", () => {
  const e = addViteEntry(MAIN_TSX, "src/main.tsx", PK).code;
  const withoutElement = e.replace(/\n    <ParloxAnalytics[^\n]*/, "");
  assert.equal(removeViteEntry(withoutElement, "src/main.tsx").code, MAIN_TSX, "the import alone would break the build once the package is removed");
  const renamed = MAIN_TSX.replace("import App", "import { ParloxAnalytics as P } from '@parlox/browser/react'\nimport App");
  assert.equal(removeViteEntry(renamed, "src/main.tsx").changed, false, "not the wizard's import: left as it is");
  assert.match(removeViteEntry(renamed, "src/main.tsx").warning, /^Line 4 still uses @parlox\/browser, which the uninstall removes/, "and named, since the package goes");
  // Another use of the package beside the wizard's edit: the edit comes out exactly, and the line is named.
  const own = MAIN_TSX.replace("import './index.css'", "import './index.css'\nimport { track } from '@parlox/browser'");
  const r = removeViteEntry(addViteEntry(own, "src/main.tsx", PK).code, "src/main.tsx");
  assert.equal(r.code, own);
  assert.match(r.warning, /^Line 4 still uses @parlox\/browser/);
  const dir = app({ "src/main.tsx": addViteEntry(own, "src/main.tsx", PK).code });
  const un = viteReact.unplan(self(dir), { read: reader(dir), git });
  assert.deepEqual(un.changes.map((c) => [c.path, c.after]), [["src/main.tsx", own]]);
  assert.deepEqual(un.manual.map((m) => [m.file, m.part]), [["src/main.tsx", "browser"]]);
  assert.match(un.manual[0].reason, /Line 4 still uses @parlox\/browser/);
});

test("the entry edit becomes a snippet when it cannot be made safely", () => {
  for (const [code, why] of [
    ["export {}\n", /No single createRoot/],
    ["createRoot(a).render(<App />);\ncreateRoot(b).render(<Admin />);\n", /No single createRoot/],
    ["createRoot(a).render(app);\n", /does not render a JSX element/],
    ["import { ParloxAnalytics } from 'x';\ncreateRoot(a).render(<App />);\n", /already has something named ParloxAnalytics/],
    ["createRoot(a).render(<><App /><ParloxAnalytics publicKey=\"pk_other1234\" /></>);\n", /another key/],
    ["function f(ParloxAnalytics) { return ParloxAnalytics }\ncreateRoot(a).render(<App />);\n", /uses the name ParloxAnalytics on line 1/],
    ["createRoot(a).render(<StrictMode>{app}</StrictMode>);\n", /nothing the wizard can sit beside/],
    // An inline fragment around one element: the result would read like the wizard's own fragment, and uninstall
    // would take the developer's fragment out with it.
    ["createRoot(a).render(<><App /></>);\n", /take out again exactly/],
    // A line break the line primitives do not edit around (a lone carriage return).
    ["import App from './App'\rcreateRoot(a).render(\n  <StrictMode>\n    <App />\n  </StrictMode>\n)\n", /line break the wizard does not edit around/],
    ["createRoot(a).render(<App />", /could not read this file/],
    // "Already installed" is the wizard's own shape: the import, and the element in the root render call.
    [`createRoot(a).render(<App />)\nfunction X() { return <ParloxAnalytics publicKey="${PK}" /> }\n`, /already has a ParloxAnalytics element on line 2 outside the root render/],
    [`createRoot(a).render(<><App /><ParloxAnalytics publicKey="${PK}" /></>)\n`, /not imported from @parlox\/browser\/react/],
  ]) {
    const e = addViteEntry(code, "src/main.jsx", PK);
    assert.equal(e.ok, false, code);
    assert.match(e.reason, why, code);
    assert.match(e.snippet, /<ParloxAnalytics publicKey="pk_a1/);
  }
  assert.throws(() => addViteEntry(MAIN_TSX, "src/main.tsx", "pk_bad key"), /invalid public key/);
});

test("uninstall of the entry edit names what it cannot take out", () => {
  const twice = "createRoot(a).render(<><App /><ParloxAnalytics publicKey=\"pk_a1a1a1a1a1\" /><ParloxAnalytics publicKey=\"pk_a1a1a1a1a1\" /></>);\n";
  assert.match(removeViteEntry(twice, "src/main.jsx").reason, /more than once/);
  const guarded = "createRoot(a).render(<>{on && <ParloxAnalytics publicKey=\"pk_a1a1a1a1a1\" />}</>);\n";
  assert.match(removeViteEntry(guarded, "src/main.jsx").reason, /not a plain JSX child/);
  assert.equal(removeViteEntry(MAIN_TSX, "src/main.tsx").changed, false);
  assert.match(removeViteEntry("x = <\n", "src/main.jsx").reason, /could not read/);
});

test("envPrefix, publicDir and root come from the Vite config's literals; anything computed is unknown and treated as exposing", () => {
  assert.deepEqual(settingsOf(({})), { file: null, root: ".", envPrefix: ["VITE_"], publicDir: "public", exposure: null });
  const listed = settingsOf(({ "vite.config.js": "export default { envPrefix: ['VITE_', 'PARLOX_'], publicDir: './static/' }" }));
  assert.deepEqual({ ...listed, exposure: !!listed.exposure }, { file: "vite.config.js", root: ".", envPrefix: ["VITE_", "PARLOX_"], publicDir: "static", exposure: true });
  assert.equal(settingsOf(({ "vite.config.ts": "export default defineConfig(({ mode }) => ({ envPrefix: mode === 'x' ? 'A_' : 'B_', publicDir: false }))" })).envPrefix, null);
  assert.equal(settingsOf(({ "vite.config.ts": "export default { publicDir: false }" })).publicDir, false);
  assert.equal(settingsOf(({ "vite.config.ts": "export default { publicDir: '' }" })).publicDir, false, "Vite turns an empty publicDir off too");
  assert.equal(settingsOf(({ "vite.config.ts": "export default { publicDir: '../shared' }" })).publicDir, null, "never outside the app");
  assert.equal(settingsOf(({ "vite.config.ts": "export default { publicDir: '/srv/public' }" })).publicDir, null);
  // publicDir is relative to root: joined first, then checked.
  assert.equal(settingsOf(({ "vite.config.ts": "export default { root: 'src', publicDir: '../public' }" })).publicDir, "public");
  assert.equal(settingsOf(({ "vite.config.ts": "export default { root: 'src', publicDir: '../../public' }" })).publicDir, null);
  // A folder named "unknown" is a folder like any other.
  assert.equal(settingsOf(({ "vite.config.ts": "export default { publicDir: 'unknown' }" })).publicDir, "unknown");
  assert.equal(exposesSecret(["VITE_"]), false);
  assert.equal(exposesSecret([""]), true);
  assert.equal(exposesSecret(["VITE_", "PARLOX_"]), true);
  assert.equal(exposesSecret(["P"]), true);
  assert.equal(exposesSecret(null), true);
});

test("the Vite config: Vite's own file order, only the config object's own keys, and a spread or computed config is unknown", () => {
  // vitejs/vite packages/vite/src/node/constants.ts DEFAULT_CONFIG_FILES: .js first, then .mjs, .ts, .cjs, .mts, .cts.
  assert.deepEqual(VITE_CONFIGS, ["vite.config.js", "vite.config.mjs", "vite.config.ts", "vite.config.cjs", "vite.config.mts", "vite.config.cts"]);
  assert.equal(settingsOf(({ "vite.config.ts": "export default { publicDir: 'a' }", "vite.config.js": "export default { publicDir: 'b' }" })).publicDir, "b");
  // The keys of a plugin's options, or of `test`, are not Vite's.
  const nested = settingsOf(({ "vite.config.ts": "import { defineConfig } from 'vite'\nexport default defineConfig({ plugins: [copy({ publicDir: 'x', root: 'y' })], test: { root: 'z' } })" }));
  assert.deepEqual({ ...nested, exposure: undefined }, { file: "vite.config.ts", root: ".", envPrefix: ["VITE_"], publicDir: "public", exposure: undefined });
  assert.match(nested.exposure.why, /uses a plugin \(line \d+\), which the wizard does not check/, "and copy() is not a plugin the wizard checks");
  // The config through a variable, a function returning it, TypeScript's satisfies, and CommonJS.
  assert.equal(settingsOf(({ "vite.config.ts": "const config = { publicDir: 'assets' } satisfies UserConfig\nexport default config" })).publicDir, "assets");
  assert.equal(settingsOf(({ "vite.config.js": "export default defineConfig(() => { const x = 1; return { publicDir: 'www' } })" })).publicDir, "www");
  assert.equal(settingsOf(({ "vite.config.cjs": "module.exports = { envPrefix: 'APP_' }" })).envPrefix.join(), "APP_");
  // Branches that agree are known; ones that differ are not.
  assert.equal(settingsOf(({ "vite.config.js": "export default defineConfig(({ command }) => command === 'build' ? { publicDir: 'p' } : { publicDir: 'p' })" })).publicDir, "p");
  assert.equal(settingsOf(({ "vite.config.js": "export default defineConfig(({ command }) => command === 'build' ? { publicDir: 'p' } : {})" })).publicDir, null);
  // A spread may set any key; mergeConfig, an async config or one that does not parse cannot be read.
  // So can a config object that is changed, or used, besides being exported.
  for (const code of ["export default { ...shared, plugins: [] }", "export default mergeConfig(base, { plugins: [] })", "export default defineConfig(async () => ({ }))", "export default {",
    "const cfg = { plugins: [] }\ncfg.envPrefix = 'PARLOX_'\nexport default cfg", "const cfg = {}\nObject.assign(cfg, { envPrefix: 'PARLOX_' })\nexport default cfg", "const cfg = {}\nsetUp(cfg)\nexport default defineConfig(cfg)"]) {
    const s = settingsOf(({ "vite.config.js": code }));
    assert.deepEqual({ ...s, exposure: undefined }, { file: "vite.config.js", root: null, envPrefix: null, publicDir: null, exposure: undefined }, code);
    assert.match(s.exposure.why, /^The wizard cannot read vite\.config\.js to the end \(.+\), so it cannot prove that Vite keeps the secret key out of the browser code\.$/, code);
  }
  assert.match(settingsOf(({ "vite.config.js": "const cfg = { plugins: [] }\ncfg.envPrefix = 'PARLOX_'\nexport default cfg" })).exposure.why, /also changed or used on line 2/);
  assert.equal(settingsOf(({ "vite.config.ts": "const config = defineConfig({ publicDir: 'www' })\nexport default config" })).publicDir, "www", "a config const used once, by the export, is read");
});

test("off Vercel: the entry edit and the ownership file; no server part, and the report says crawlers are not seen", () => {
  const dir = app({ "netlify.toml": "" });
  const d = viteReact.detect(dir, dir);
  const plan = viteReact.plan(d, input(dir, OTHER));
  assert.deepEqual(plan.changes.map((c) => [c.path, c.purpose]), [["src/main.tsx", "browser part"], ["public/.well-known/parlox-verify", "ownership proof"]]);
  assert.equal(plan.changes[1].after, "vt_fake\n");
  assert.equal(plan.changes[1].before, null);
  assert.deepEqual(plan.install, { command: "npm", args: ["install", "--save-exact", `@parlox/browser@${BROWSER_VERSION}`] });
  assert.equal(viteReact.hostStep(d, OTHER), false);
  const notes = viteReact.hostNotes(d, OTHER, { browser: true, server: true, unitHasBrowser: true }).join("\n");
  assert.match(notes, /Crawlers that do not run JavaScript are not seen on this host: they never run the browser part, and the site has no server of its own\. Deploy on Vercel, or add a server, to see them\./);
  assert.equal(viteReact.hostNotes(d, OTHER, { browser: true, server: false, unitHasBrowser: true }).length, 0, "with a server of its own in the folder, no such note");
  assert.deepEqual(d.notes, []);
  // The developer answered No to "deployed on Vercel?": the same.
  assert.deepEqual(viteReact.plan(self(app()), input(dir, UNKNOWN)).changes.map((c) => c.path), ["src/main.tsx", "public/.well-known/parlox-verify"]);
  assert.throws(() => viteReact.plan(d, { ...input(dir, OTHER), verifyToken: "vt fake\n<script>" }), /invalid verification code/);
});

test("off Vercel, the public folder turned off or unreadable: the ownership file is a step by hand", () => {
  for (const [config, why] of [["export default { publicDir: false }", /turns the public folder off/], ["export default { publicDir: dir }", /could not read the Vite config's publicDir/]]) {
    const dir = app({ "netlify.toml": "", "vite.config.js": config });
    const d = self(dir);
    assert.equal(d.parts.server.file, null);
    const plan = viteReact.plan(d, input(dir, OTHER));
    assert.deepEqual(plan.changes.map((c) => c.path), ["src/main.tsx"]);
    assert.equal(plan.manual.length, 1);
    assert.equal(plan.manual[0].part, "server");
    assert.match(plan.manual[0].reason, why);
    assert.match(plan.manual[0].snippet, /\/\.well-known\/parlox-verify[\s\S]*vt_fake/);
  }
});

test("on Vercel: the entry edit and the Routing Middleware; @parlox/server and @vercel/functions are added", () => {
  const dir = app({ "vercel.json": "{}" });
  const d = viteReact.detect(dir, dir);
  const host = vercelHost(null);
  assert.deepEqual(host, { id: "vercel", label: "Vercel", where: "your project → Settings → Environment Variables (then redeploy)", docs: "https://vercel.com/docs/environment-variables/managing-environment-variables", vercelDir: null });
  assert.equal(vercelHost("/x").vercelDir, "/x");
  assert.equal(viteServerKind(host, d.data), "vercel-edge");
  const plan = viteReact.plan(d, input(dir, host));
  assert.deepEqual(plan.changes.map((c) => c.path), ["src/main.tsx", "middleware.ts"]);
  assert.deepEqual(plan.install.args, ["install", "--save-exact", `@parlox/browser@${BROWSER_VERSION}`, `@parlox/server@${SERVER_VERSION}`, `@vercel/functions@${VERCEL_FUNCTIONS_VERSION}`]);
  assert.equal(viteReact.hostStep(d, host), true);
  assert.match(viteReact.hostNotes(d, host, { browser: true, server: true, unitHasBrowser: true }).join("\n"), /runs on every page request/);
  assert.match("skip" in d.localCheck ? d.localCheck.skip : "", /only on Vercel/);
  // The browser part alone (another integration's server in the same folder): no middleware, no server packages.
  const browserOnly = viteReact.plan(d, { ...input(dir, host), parts: { browser: true, server: false } });
  assert.deepEqual(browserOnly.changes.map((c) => c.path), ["src/main.tsx"]);
  assert.deepEqual(browserOnly.install.args, ["install", "--save-exact", `@parlox/browser@${BROWSER_VERSION}`]);
});

test("a project that deploys Storybook on Vercel: no middleware (it might never run), the ownership file instead, and the reason in the review and the report", () => {
  const dir = app({ "vercel.json": "{}", "package.json": pkgJson({ scripts: { build: "storybook build" }, devDependencies: { vite: "^8.3.0", storybook: "^9.0.0" } }) });
  const d = viteReact.detect(dir, dir);
  assert.equal(d.parts.server.kind, "verify-file");
  const plan = viteReact.plan(d, input(dir, vercelHost(null)));
  assert.deepEqual(plan.changes.map((c) => c.path), ["src/main.tsx", "public/.well-known/parlox-verify"]);
  assert.match(d.notes.join("\n"), /Storybook/);
  assert.match(plan.warnings.join("\n"), /No Vercel middleware: .*Storybook/);
  assert.equal(viteReact.hostStep(d, vercelHost(null)), false);
  const notes = viteReact.hostNotes(d, vercelHost(null), { browser: true, server: true, unitHasBrowser: true }).join("\n");
  assert.match(notes, /Crawlers that do not run JavaScript are not seen/);
  assert.doesNotMatch(notes, /Deploy on Vercel/, "Vercel would not run a middleware here either");
  // No host file: nothing to ask, since Vercel would not run the middleware either.
  const unknown = self(app({ "package.json": pkgJson({ scripts: { build: "storybook build" } }) }));
  assert.equal(unknown.parts.server.kind, "verify-file");
  // A storybook package alone is not a Storybook deployment: the middleware is added.
  const withStorybook = app({ "vercel.json": "{}", "package.json": pkgJson({ scripts: { build: "tsc -b && vite build", "build-storybook": "storybook build" }, devDependencies: { vite: "^8.3.0", storybook: "^9.0.0" } }) });
  assert.deepEqual(viteReact.plan(self(withStorybook), input(withStorybook, vercelHost(null))).changes.map((c) => c.path), ["src/main.tsx", "middleware.ts"]);
});

test("uninstall: the entry, the middleware and the ownership file go back; @vercel/functions stays", () => {
  const dir = app({ "vercel.json": "{}" });
  const before = readFileSync(join(dir, "src/main.tsx"), "utf8");
  const d = viteReact.detect(dir, dir);
  applyPlan(dir, viteReact.plan(d, input(dir, vercelHost(null))));
  applyPlan(dir, viteReact.plan(viteReact.detect(dir, dir), input(dir, OTHER)));   // the ownership file too
  assert.equal(existsSync(join(dir, "public/.well-known/parlox-verify")), true);
  const un = viteReact.unplan(viteReact.detect(dir, dir), { read: reader(dir), git });
  assert.deepEqual(un.manual, []);
  applyPlan(dir, un);
  assert.equal(readFileSync(join(dir, "src/main.tsx"), "utf8"), before);
  assert.equal(existsSync(join(dir, "middleware.ts")), false);
  assert.equal(existsSync(join(dir, "public/.well-known/parlox-verify")), false);
});

test("uninstall of the ownership file: also after a checkout that made its line break CRLF; a file changed since is a step by hand", () => {
  const crlf = app({ "public/.well-known/parlox-verify": "vt_fake\r\n" });
  assert.deepEqual(viteReact.unplan(self(crlf), { read: reader(crlf), git }).changes.map((c) => [c.path, c.after]), [["public/.well-known/parlox-verify", null]]);
  const edited = app({ "public/.well-known/parlox-verify": "parlox-verify=vt_fake\nsomething else\n" });
  const un = viteReact.unplan(self(edited), { read: reader(edited), git });
  assert.deepEqual(un.changes, []);
  assert.match(un.manual[0].reason, /not as the wizard writes it/);
  assert.equal(un.manual[0].file, "public/.well-known/parlox-verify");
});

test("uninstall removes the packages the wizard adds, and nothing when none is there", () => {
  const dir = app({ "package.json": pkgJson({ dependencies: { react: "^19.2.8", "@parlox/browser": "1.0.3", "@parlox/server": "1.0.1", "@vercel/functions": "3.9.9" } }) });
  assert.deepEqual(viteReact.unplan(self(dir), { read: reader(dir), git }).install, { command: "npm", args: ["uninstall", "@parlox/browser", "@parlox/server"] });
  const clean = app();
  const un = viteReact.unplan(self(clean), { read: reader(clean), git });
  assert.deepEqual([un.changes, un.install, un.manual], [[], null, []]);
});

test("no host file: the wizard asks whether the site is on Vercel; Yes plans the middleware, --no-vercel the ownership file", async (t) => {
  const auth = await startFakeAuth({ decide: "approve" });
  const gw = await startFakeGateway({ sites: [{ id: "11111111-1111-1111-1111-111111111111", name: "Shop", domain: "shop.example.com", public_key: PK, verified: false }], keys: [] });
  t.after(() => { auth.close(); gw.close(); });
  const config = { gateway: gw.url, supabaseUrl: auth.url, clientId: "wiz", apiKey: "k", ports: [53822, 53823], dashboard: "https://app.parlox.io" };
  const G = ["-c", "user.email=t@t", "-c", "user.name=t"];
  const run = () => ({ status: 0, stdout: "", stderr: "" });
  for (const [argv, expected, answer] of [[["--dry-run"], "middleware.ts", true], [["--dry-run"], "public/.well-known/parlox-verify", false], [["--dry-run", "--no-vercel"], "public/.well-known/parlox-verify", true], [["--dry-run", "--vercel"], "middleware.ts", false]]) {
    const dir = app({ ".gitignore": "node_modules\n" });
    execFileSync("git", [...G, "init", "-q"], { cwd: dir }); execFileSync("git", [...G, "add", "-A"], { cwd: dir }); execFileSync("git", [...G, "commit", "-qm", "i"], { cwd: dir });
    const out = [], asked = [], facts = [];
    const ui = { info: (m) => out.push(m), warn: (m) => out.push(`WARN ${m}`), confirm: async (m) => { asked.push(m); return answer; }, select: async (_m, o) => o[0].value, text: async () => "", fact: (l, v) => facts.push(`${l}: ${v}`) };
    // A dry run still signs in: opening the sign-in link is what lets the fake auth server approve it.
    const open = (url) => { fetch(url).catch(() => {}); };
    assert.equal(await main([...argv, "--site", "shop.example.com", "--skip-check"], { cwd: dir, config, open, run, ui }), 0, out.join("\n"));
    const flag = argv.includes("--vercel") || argv.includes("--no-vercel");
    assert.equal(asked.some((m) => /^Is .* deployed on Vercel\?$/.test(m)), !flag, `${argv}: ${asked.join(" | ")}`);
    assert.ok(out.some((m) => m.includes(`+++ b/${expected}`)), `${argv}: ${out.join("\n")}`);
    assert.equal(facts.includes("Host: Vercel (your answer)"), expected === "middleware.ts", `${argv}: ${facts.join(" | ")}`);
  }
});

test("a Vite app with a host file is not asked where it is deployed", async (t) => {
  const auth = await startFakeAuth({ decide: "approve" });
  const gw = await startFakeGateway({ sites: [{ id: "11111111-1111-1111-1111-111111111111", name: "Shop", domain: "shop.example.com", public_key: PK, verified: false }], keys: [] });
  t.after(() => { auth.close(); gw.close(); });
  const config = { gateway: gw.url, supabaseUrl: auth.url, clientId: "wiz", apiKey: "k", ports: [53822, 53823], dashboard: "https://app.parlox.io" };
  const dir = app({ "netlify.toml": "" });
  const out = [], asked = [];
  const ui = { info: (m) => out.push(m), warn: (m) => out.push(`WARN ${m}`), confirm: async (m) => { asked.push(m); return true; }, select: async (_m, o) => o[0].value, text: async () => "" };
  assert.equal(await main(["--dry-run", "--site", "shop.example.com", "--skip-check"], { cwd: dir, config, open: (url) => { fetch(url).catch(() => {}); }, run: () => ({ status: 0, stdout: "", stderr: "" }), ui }), 0, out.join("\n"));
  assert.deepEqual(asked, []);
  assert.ok(out.some((m) => m.includes("+++ b/public/.well-known/parlox-verify")), out.join("\n"));
});

test("--local-key in a Vite app writes no key anywhere: Vite loads the app's .env files, and its middleware reads its variables on Vercel only", async (t) => {
  const auth = await startFakeAuth({ decide: "approve" });
  const gw = await startFakeGateway({ sites: [{ id: "11111111-1111-1111-1111-111111111111", name: "Shop", domain: "shop.example.com", public_key: PK, verified: false }], keys: [] });
  t.after(() => { auth.close(); gw.close(); });
  const config = { gateway: gw.url, supabaseUrl: auth.url, clientId: "wiz", apiKey: "k", ports: [53822, 53823], dashboard: "https://app.parlox.io" };
  const dir = app({ "vercel.json": "{}" });
  const out = [];
  const ui = { info: (m) => out.push(m), warn: (m) => out.push(`WARN ${m}`), confirm: async () => true, select: async (_m, o) => o[0].value, text: async () => "" };
  assert.equal(await main(["--yes", "--allow-no-git", "--no-vercel", "--local-key", "--site", "shop.example.com", "--skip-check"], { cwd: dir, config, open: (url) => { if (!url.includes("newKey")) fetch(url).catch(() => {}); }, run: () => ({ status: 0, stdout: "", stderr: "" }), ui }), 0, out.join("\n"));
  assert.deepEqual(gw.state.keys, [], "no key was created");
  for (const f of [".env", ".env.local", ".env.production", ".env.production.local"]) assert.equal(existsSync(join(dir, f)), false, f);
  assert.ok(out.includes("WARN No local key: the Vercel middleware runs only on Vercel; check it after you deploy. To report from your dev server, create a key in Settings → Keys and set PARLOX_SECRET_KEY in the environment you start the server with."), out.join("\n"));
  assert.equal(existsSync(join(dir, "middleware.ts")), true);
  assert.doesNotMatch(readFileSync(join(dir, "src/main.tsx"), "utf8") + readFileSync(join(dir, "middleware.ts"), "utf8"), /sk_parlox_|PARLOX_SECRET_KEY/);
});

test("already installed: the wizard's import and its element in the root render call", () => {
  const e = addViteEntry(MAIN_TSX, "src/main.tsx", PK);
  assert.deepEqual(addViteEntry(e.code, "src/main.tsx", PK), { ok: true, code: e.code, changed: false });
  const own = `import { createRoot } from 'react-dom/client'\nimport { ParloxAnalytics } from "@parlox/browser/react"\ncreateRoot(a).render(<><App /><ParloxAnalytics publicKey="${PK}" /></>)\n`;
  assert.equal(addViteEntry(own, "src/main.jsx", PK).changed, false, "added by hand the same way");
});

// Security: Vercel exposes a project's variables during the build, and Vite's loadEnv takes every
// process.env variable whose name starts with an envPrefix. A config that would bundle PARLOX_SECRET_KEY, or that the
// wizard cannot prove does not, gets no middleware and no host step (no key is created or asked for).
const EXPOSING = [
  ["envPrefix string", { "vite.config.ts": "export default { envPrefix: 'PARLOX_' }" }, /lists PARLOX_ in envPrefix/],
  ["envPrefix array", { "vite.config.ts": "export default defineConfig({ envPrefix: ['VITE_', 'PARLOX_'] })" }, /lists PARLOX_ in envPrefix/],
  ["empty prefix", { "vite.config.js": "export default { envPrefix: '' }" }, /lists an empty prefix \(""\) in envPrefix/],
  ["computed envPrefix", { "vite.config.js": "export default { envPrefix: prefix }" }, /cannot read envPrefix in vite\.config\.js/],
  ["unreadable config", { "vite.config.js": "export default defineConfig(async () => ({}))" }, /cannot read vite\.config\.js to the end/],
  ["mutated config", { "vite.config.js": "const cfg = {}\ncfg.envPrefix = 'PARLOX_'\nexport default cfg" }, /also changed or used on line 2/],
  ["define with loadEnv(…, '')", { "vite.config.js": "import { defineConfig, loadEnv } from 'vite'\nexport default defineConfig(({ mode }) => {\n  const env = loadEnv(mode, process.cwd(), '')\n  return { define: { 'process.env': env } }\n})" }, /passes environment values to the browser code through define \(line 4\)/],
  ["define with process.env.X", { "vite.config.js": "export default { define: { __KEY__: JSON.stringify(process.env.MY_KEY) } }" }, /through define \(line 1\)/],
  ["define spread", { "vite.config.js": "export default { define: { ...defs } }" }, /through define \(line 1\)/],
  ["loadEnv(…, '')", { "vite.config.js": "import { defineConfig, loadEnv } from 'vite'\nexport default defineConfig(({ mode }) => {\n  const env = loadEnv(mode, process.cwd(), '')\n  return { server: { port: Number(env.PORT) } }\n})" }, /loads every variable with loadEnv\(…, ''\) \(line 3\)/],
  ["loadEnv with a matching prefix", { "vite.config.js": "export default defineConfig(({ mode }) => ({ server: { port: loadEnv(mode, '.', 'PARLOX').PARLOX_PORT } }))" }, /loads the variables starting with PARLOX with loadEnv \(line 1\)/],
  ["names the key", { "vite.config.js": "export default { plugins: [html({ inject: { key: process.env['PARLOX_SECRET_KEY'] } })] }" }, /names PARLOX_SECRET_KEY \(line 1\)/],
  ["build --config", { "package.json": pkgJson({ scripts: { build: "tsc -b && vite build --config vite.prod.ts" } }) }, /The script "build" runs Vite with --config/],
  ["dev -c", { "package.json": pkgJson({ scripts: { dev: "vite -c=other.config.js" } }) }, /The script "dev" runs Vite with --config/],
  ["vercel.json buildCommand --config", { "vercel.json": JSON.stringify({ buildCommand: "npx vite build --config x.ts" }) }, /vercel\.json's buildCommand runs Vite with --config/],
  // Round 1b: vite-plugin-environment puts the variables it is given (or all of them) into the browser code.
  ["EnvironmentPlugin('all')", { "vite.config.js": "import { defineConfig } from 'vite'\nimport EnvironmentPlugin from 'vite-plugin-environment'\nexport default defineConfig({ plugins: [EnvironmentPlugin('all', { prefix: 'REACT_APP_' })] })" }, /loads EnvironmentPlugin\('all'\) \(line 3\), which puts every environment variable into the browser code/],
  ["EnvironmentPlugin with PARLOX_SECRET_KEY", { "vite.config.js": "import EnvironmentPlugin from 'vite-plugin-environment'\nexport default { plugins: [EnvironmentPlugin(['API_URL', 'PARLOX_SECRET_KEY'])] }" }, /passes PARLOX_SECRET_KEY to EnvironmentPlugin \(line 2\), so it would be bundled into the browser code/],
  ["EnvironmentPlugin with a PARLOX_ default", { "vite.config.js": "import env from 'vite-plugin-environment'\nexport default { plugins: [env({ API_URL: 'x', PARLOX_KEY: '' })] }" }, /passes PARLOX_KEY to EnvironmentPlugin \(line 2\)/],
  ["EnvironmentPlugin with a variable", { "vite.config.js": "import EnvironmentPlugin from 'vite-plugin-environment'\nconst keys = ['API_URL']\nexport default { plugins: [EnvironmentPlugin(keys)] }" }, /calls EnvironmentPlugin \(line 3\) with variables the wizard cannot read/],
  ["EnvironmentPlugin with a spread", { "vite.config.js": "import EnvironmentPlugin from 'vite-plugin-environment'\nexport default { plugins: [EnvironmentPlugin([...keys])] }" }, /calls EnvironmentPlugin \(line 2\) with variables the wizard cannot read/],
  ["EnvironmentPlugin passed around", { "vite.config.js": "import * as envPlugin from 'vite-plugin-environment'\nexport default { plugins: [make(envPlugin)] }" }, /uses vite-plugin-environment \(line 2\) in a way the wizard cannot follow/],
  ["EnvironmentPlugin from elsewhere", { "vite.config.js": "import { EnvironmentPlugin } from './plugins.js'\nexport default { plugins: [EnvironmentPlugin('all')] }" }, /loads EnvironmentPlugin\('all'\) \(line 2\)/],
  ["vite-plugin-environment required", { "vite.config.cjs": "module.exports = { plugins: [require('vite-plugin-environment').default('all')] }" }, /uses vite-plugin-environment \(line 1\) in a way the wizard cannot follow/],
  // A root folder on Vite's command line: Vite then reads the config (and index.html, and the public folder) there.
  ["vite build app", { "package.json": pkgJson({ scripts: { build: "tsc -b && vite build app --mode production" } }) }, /The script "build" runs Vite in another folder \(app\)/],
  ["vite dev folder", { "package.json": pkgJson({ scripts: { dev: "vite --port 5173 ./site" } }) }, /The script "dev" runs Vite in another folder \(\.\/site\)/],
];
// A config is safe only when everything in it is on the wizard's list (an allowlist): the imports, the
// plugins, envPrefix, define, and literal settings or path helpers. These are.
const CREATE_VITE = {
  // create-vite 9.2.1 (packages/create-vite/template-react*/vite.config.*, and setupReactCompiler in src/index.ts).
  react: { "vite.config.js": "import react from '@vitejs/plugin-react'\nimport { defineConfig } from 'vite'\n\n// https://vite.dev/config/\nexport default defineConfig({\n  plugins: [react()],\n})\n", "package.json": pkgJson({ scripts: { dev: "vite", build: "vite build", lint: "eslint .", preview: "vite preview" } }) },
  "react-ts": { "vite.config.ts": "import react from '@vitejs/plugin-react'\nimport { defineConfig } from 'vite'\n\n// https://vite.dev/config/\nexport default defineConfig({\n  plugins: [react()],\n})\n", "package.json": pkgJson({ scripts: { dev: "vite", build: "tsc -b && vite build", lint: "eslint .", preview: "vite preview" } }) },
  "react-compiler": { "vite.config.js": "import react, { reactCompilerPreset } from '@vitejs/plugin-react'\nimport babel from '@rolldown/plugin-babel'\nimport { defineConfig } from 'vite'\n\n// https://vite.dev/config/\nexport default defineConfig({\n  plugins: [\n    react(),\n    babel({ presets: [reactCompilerPreset()] })\n  ],\n})\n", "package.json": pkgJson({ scripts: { dev: "vite", build: "vite build", lint: "eslint .", preview: "vite preview" } }) },
  "react-compiler-ts": { "vite.config.ts": "import react, { reactCompilerPreset } from '@vitejs/plugin-react'\nimport babel from '@rolldown/plugin-babel'\nimport { defineConfig } from 'vite'\n\n// https://vite.dev/config/\nexport default defineConfig({\n  plugins: [\n    react(),\n    babel({ presets: [reactCompilerPreset()] })\n  ],\n})\n", "package.json": pkgJson({ scripts: { dev: "vite", build: "tsc -b && vite build", lint: "eslint .", preview: "vite preview" } }) },
  "react-compiler (earlier create-vite)": { "vite.config.js": "import { defineConfig } from 'vite'\nimport react from '@vitejs/plugin-react'\n\nexport default defineConfig({\n  plugins: [\n    react({\n      babel: {\n        plugins: [['babel-plugin-react-compiler']],\n      },\n    }),\n  ],\n})\n" },
};
// Lovable's default vite.config.ts (lovable-tagger 1.3.5 reads only process.env.LOVABLE_DEV_SERVER, and the plugin is
// gated to development).
const LOVABLE = `import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import { componentTagger } from "lovable-tagger";

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => ({
  server: {
    host: "::",
    port: 8080,
  },
  plugins: [
    react(),
    mode === 'development' &&
    componentTagger(),
  ].filter(Boolean),
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
}));
`;
const TAILWIND = "import path from 'path'\nimport tailwindcss from '@tailwindcss/vite'\nimport react from '@vitejs/plugin-react'\nimport tsconfigPaths from 'vite-tsconfig-paths'\nimport { defineConfig } from 'vite'\n\nexport default defineConfig({\n  plugins: [react(), tailwindcss(), tsconfigPaths()],\n  resolve: {\n    alias: {\n      '@': path.resolve(__dirname, './src'),\n    },\n  },\n})\n";
const SAFE = [
  ["no config", {}],
  ...Object.entries(CREATE_VITE).map(([name, files]) => [`create-vite ${name}`, files]),
  ["Tailwind, tsconfig-paths and an @ alias", { "vite.config.ts": TAILWIND }],
  ["fileURLToPath alias, SWC and literal settings", { "vite.config.ts": "import { fileURLToPath, URL } from 'node:url'\nimport { defineConfig } from 'vite'\nimport react from '@vitejs/plugin-react-swc'\nexport default defineConfig({ plugins: [react()], resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } }, server: { port: 3000, host: true }, build: { outDir: 'dist', sourcemap: true, chunkSizeWarningLimit: 1000 } })" }],
  ["__dirname in an ES module", { "vite.config.js": "import { dirname, resolve } from 'node:path'\nimport { fileURLToPath } from 'node:url'\nimport { defineConfig } from 'vite'\nconst __dirname = dirname(fileURLToPath(import.meta.url))\nexport default defineConfig({ resolve: { alias: { '@': resolve(__dirname, 'src') } } })" }],
  ["vitest's defineConfig", { "vite.config.ts": "/// <reference types=\"vitest/config\" />\nimport { defineConfig } from 'vitest/config'\nimport react from '@vitejs/plugin-react'\nexport default defineConfig({ plugins: [react()], test: { environment: 'jsdom', globals: true, setupFiles: './src/setupTests.ts', include: ['src/**/*.test.tsx'] } })" }],
  ["define with literals", { "vite.config.ts": "import { defineConfig } from 'vite'\nexport default defineConfig({ define: { __APP__: JSON.stringify('shop'), __DEV__: false, __FLAGS__: JSON.stringify({ a: 1, b: [true] }) } })" }],
  ["VITE_ prefixes", { "vite.config.ts": "export default { envPrefix: ['VITE_', 'VITE_PUBLIC_'] }" }],
  ["satisfies, and a function that returns an object", { "vite.config.ts": "import type { UserConfig } from 'vite'\nexport default { base: '/shop/', plugins: [] } satisfies UserConfig", "vite.config.js": "import { defineConfig } from 'vite'\nexport default defineConfig(() => ({ base: '/shop/' }))" }],
  ["scripts without --config", { "package.json": pkgJson({ scripts: { dev: "vite", build: "tsc -b && vite build", test: "vitest --config vitest.config.ts", lint: "eslint -c .eslintrc ." } }) }],
  ["vite flags with values in other scripts", { "package.json": pkgJson({ scripts: { dev: "vite --host 0.0.0.0 --port 3000 --open", build: "vite build", "build:staging": "vite build --mode staging --outDir ../dist --sourcemap hidden --emptyOutDir", preview: "vite preview --port 4173 .", here: "vite build ./ > build.log" } }) }],
  // The build command Vercel runs: vercel.json's buildCommand, else the vercel-build script, else build, through
  // npm run / pnpm / yarn.
  ["tsc && vite build through npm run", { "package.json": pkgJson({ scripts: { build: "npm run build:app", "build:app": "tsc && vite build" } }) }],
  // Only an explicit `pnpm run X` / `yarn run X` is followed (`pnpm X` may be one of pnpm's own commands).
  ["vercel-build first, through pnpm run", { "package.json": pkgJson({ scripts: { build: "node other.mjs", "vercel-build": "pnpm run build:web", "build:web": "vite build" } }) }],
  ["vercel.json's buildCommand first, through yarn", { "vercel.json": JSON.stringify({ buildCommand: "yarn run build" }), "package.json": pkgJson({ scripts: { build: "tsc -b && vite build", "vercel-build": "node other.mjs" } }) }],
  ["Lovable's default config", { "vite.config.ts": LOVABLE, "package.json": pkgJson({ scripts: { dev: "vite", build: "vite build", "build:dev": "vite build --mode development", lint: "eslint .", preview: "vite preview" } }) }],
  ["Lovable's config in double quotes and ==", { "vite.config.ts": LOVABLE.replace("mode === 'development'", 'mode == "development"') }],
  ["vite build --mode <literal>", { "package.json": pkgJson({ scripts: { build: "tsc -b && vite build --mode staging", "build:prod": "vite build -m production", "build:eq": "vite build --mode=production" } }) }],
  ["vite build --mode through vercel.json", { "vercel.json": JSON.stringify({ buildCommand: "vite build --mode=production" }) }],
  ["package.json version in define", { "vite.config.ts": "import pkg from './package.json'\nexport default { define: { __VERSION__: JSON.stringify(pkg.version) } }" }],
  ["package.json with an import attribute", { "vite.config.ts": "import { defineConfig } from 'vite'\nimport pkg from './package.json' with { type: 'json' }\nexport default defineConfig({ define: { __APP_VERSION__: JSON.stringify(pkg.version), __NAME__: JSON.stringify(pkg.name) } })" }],
  ["package.json with an import assertion", { "vite.config.js": "import pkg from './package.json' assert { type: 'json' }\nexport default { define: { __VERSION__: JSON.stringify(pkg.version) } }" }],
  // Functions in server and preview, which vite build never calls; a { command } parameter.
  ["a server proxy with a function", { "vite.config.js": "import { defineConfig } from 'vite'\nexport default defineConfig({ server: { proxy: { '/api': { target: 'http://localhost:3000', rewrite: (p) => p.replace(/^\\/api/, '') } } } })" }],
  ["a { command } parameter that gates a plugin", { "vite.config.ts": "import { defineConfig } from 'vite'\nimport react from '@vitejs/plugin-react'\nexport default defineConfig(({ command }) => ({ plugins: [command === 'serve' && react()] }))" }],
  ["postcss and tailwind configs without the environment", { "postcss.config.js": "export default { plugins: { '@tailwindcss/postcss': {} } }\n", "tailwind.config.js": "/** @type {import('tailwindcss').Config} */\nexport default { content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'], theme: { extend: {} }, plugins: [] }\n" }],
];
// Everything else is unknown, and fails closed. The first eleven are configs whose real build
// (Vite 6.4.3, a canary in PARLOX_SECRET_KEY) bundled the key while an earlier denylist read them as safe; the config over
// 1 MB and the unreadable one are in their own test below.
const UNCHECKED = [
  ["inline plugin config() envPrefix", { "vite.config.js": "import { defineConfig } from 'vite'\nexport default defineConfig({ plugins: [{ name: 'p', config: () => ({ envPrefix: ['VITE_', 'PARLOX_'] }) }] })" }, /uses a plugin \(line 2\), which the wizard does not check/],
  ["inline plugin config() define", { "vite.config.js": "import { defineConfig } from 'vite'\nexport default defineConfig({ plugins: [{ name: 'p', config() { return { define: { __ENV__: JSON.stringify(process.env) } } } }] })" }, /uses the name process \(line 2\)/],
  ["local plugin file", { "vite.config.js": "import { defineConfig } from 'vite'\nimport envPlugin from './build/env-plugin.js'\nexport default defineConfig({ plugins: [envPlugin()] })", "build/env-plugin.js": "export default () => ({ name: 'e', config: () => ({ define: { __ENV__: JSON.stringify(process.env) } }) })" }, /uses the import of \.\/build\/env-plugin\.js \(line 2\)/],
  ["transformIndexHtml", { "vite.config.js": "import { defineConfig } from 'vite'\nexport default defineConfig({ plugins: [{ name: 'h', transformIndexHtml: (html) => html.replace('</head>', '<script>window.E=' + JSON.stringify(process.env) + '</script></head>') }] })" }, /uses the name process/],
  ["define process['env']", { "vite.config.js": "import { defineConfig } from 'vite'\nexport default defineConfig({ define: { __ENV__: JSON.stringify(process['env']) } })" }, /uses the name process/],
  ["define globalThis.process.env", { "vite.config.js": "import { defineConfig } from 'vite'\nexport default defineConfig({ define: { __ENV__: JSON.stringify(globalThis.process.env) } })" }, /uses the name process/],
  ["define const { env } = process", { "vite.config.js": "import { defineConfig } from 'vite'\nconst { env } = process\nexport default defineConfig({ define: { __ENV__: JSON.stringify(env) } })" }, /uses the name (env|process) \(line 2\)/],
  ["define import { env } from node:process", { "vite.config.js": "import { defineConfig } from 'vite'\nimport { env } from 'node:process'\nexport default defineConfig({ define: { __ENV__: JSON.stringify(env) } })" }, /uses the name env \(line 2\)|uses the import of node:process/],
  ["define loadEnv as an alias", { "vite.config.js": "import { defineConfig, loadEnv as le } from 'vite'\nexport default defineConfig(({ mode }) => ({ define: { __ENV__: JSON.stringify(le(mode, process.cwd(), '')) } }))" }, /uses the name loadEnv \(line 1\)/],
  ["define helper from a file", { "vite.config.js": "import { defineConfig } from 'vite'\nimport { clientEnv } from './env.js'\nexport default defineConfig({ define: { __ENV__: clientEnv() } })", "env.js": "export const clientEnv = () => JSON.stringify(process.env)" }, /uses the import of \.\/env\.js/],
  ["defineConfig wrapper from a file", { "vite.config.js": "import { defineConfig } from './base.js'\nexport default defineConfig({})", "base.js": "export const defineConfig = (c) => ({ ...c, envPrefix: ['VITE_', 'PARLOX_'] })" }, /uses the import of \.\/base\.js \(line 1\)/],
  ["environments.client.define", { "vite.config.js": "import { defineConfig } from 'vite'\nexport default defineConfig({ environments: { client: { define: { __ENV__: JSON.stringify(process.env) } } } })" }, /uses the name process/],
  ["esbuild.define", { "vite.config.js": "import { defineConfig } from 'vite'\nexport default defineConfig({ esbuild: { define: { __ENV__: JSON.stringify(JSON.stringify(process.env)) } } })" }, /uses the name process/],
  ["rollup plugin transform", { "vite.config.js": "import { defineConfig } from 'vite'\nexport default defineConfig({ build: { rollupOptions: { plugins: [{ name: 'r', transform: (code) => code.replace('__ENV__', JSON.stringify(process.env)) }] } } })" }, /uses the name process/],
  ["cd app && vite build", { "package.json": pkgJson({ scripts: { build: "cd app && vite build" } }), "app/vite.config.js": "export default { envPrefix: ['VITE_', 'PARLOX_'] }" }, /The script "build" runs Vite in another folder \(app\)/],
  ["node script, JS API", { "package.json": pkgJson({ scripts: { build: "node build.mjs" } }), "build.mjs": "import { build } from 'vite'\nawait build({ configFile: false, envPrefix: ['VITE_', 'PARLOX_'] })" }, /Vercel builds this app with the "build" script \("node build\.mjs"\), which is not one of the builds the wizard checks/],
  // More shapes that must fail closed.
  ["a defineConfig of another package", { "vite.config.ts": "import { defineConfig } from '@acme/vite-config'\nexport default defineConfig({ plugins: [] })" }, /uses the import of @acme\/vite-config/],
  ["dotenv", { "vite.config.ts": "import dotenv from 'dotenv'\nconst parsed = dotenv.config({ path: '.env.local' }).parsed\nexport default { define: { __ENV__: JSON.stringify(parsed) } }" }, /uses the import of dotenv/],
  ["an env plugin of another package", { "vite.config.ts": "import env from 'vite-plugin-env-compatible'\nexport default { plugins: [env({ prefix: '' })] }" }, /uses the import of vite-plugin-env-compatible/],
  ["process through a const", { "vite.config.ts": "const p = process\nexport default { define: { 'process.env': JSON.stringify(p.env) } }" }, /uses the name process \(line 1\)/],
  ["require('process').env", { "vite.config.cjs": "module.exports = { define: { __ENV__: JSON.stringify(require('process').env) } }" }, /uses the name env|uses require/],
  ["code besides the imports and the export", { "vite.config.js": "import { defineConfig } from 'vite'\nconsole.log('building')\nexport default defineConfig({})" }, /uses code besides the imports and the export \(line 2\)/],
  ["a function that computes the config", { "vite.config.js": "import { defineConfig } from 'vite'\nfunction all() { return {} }\nexport default defineConfig(all())" }, /cannot read vite\.config\.js to the end/],
  ["an envPrefix that is not VITE_", { "vite.config.ts": "export default { envPrefix: ['VITE_', 'PUBLIC_'] }" }, /uses an envPrefix other than VITE_ prefixes \(line 1\)/],
  // package.json only as JSON.stringify(pkg.<name>) in define; Lovable's tagger only behind its development
  // gate; mode only in that gate.
  ["package.json used as a whole", { "vite.config.ts": "import pkg from './package.json'\nexport default { define: { __PKG__: JSON.stringify(pkg) } }" }, /uses a define value that is not a literal/],
  ["package.json in another setting", { "vite.config.ts": "import pkg from './package.json'\nexport default { base: pkg.homepage }" }, /uses the setting base/],
  ["package.json two levels down", { "vite.config.ts": "import pkg from './package.json'\nexport default { define: { __R__: JSON.stringify(pkg.dependencies.react) } }" }, /uses a define value that is not a literal/],
  ["package.json named import", { "vite.config.ts": "import { version } from './package.json'\nexport default { define: { __V__: JSON.stringify(version) } }" }, /uses the import of \.\/package\.json/],
  ["another JSON file", { "vite.config.ts": "import data from './data.json'\nexport default { define: { __V__: JSON.stringify(data.v) } }" }, /uses the import of \.\/data\.json/],
  ["Lovable's tagger without its gate", { "vite.config.ts": LOVABLE.replace("mode === 'development' &&\n    componentTagger()", "componentTagger()") }, /uses a plugin \(line \d+\), which the wizard does not check/],
  ["Lovable's tagger in production", { "vite.config.ts": LOVABLE.replace("mode === 'development'", "mode === 'production'") }, /uses a plugin \(line \d+\), which the wizard does not check/],
  ["Lovable's tagger as a default import", { "vite.config.ts": "import tagger from 'lovable-tagger'\nexport default { plugins: [tagger()] }" }, /uses the import of lovable-tagger|uses a plugin/],
  ["mode in a setting", { "vite.config.ts": LOVABLE.replace('host: "::",', 'host: mode === "development" ? "::" : "localhost",') }, /uses the setting server/],
  ["mode in define", { "vite.config.ts": "import { defineConfig } from 'vite'\nexport default defineConfig(({ mode }) => ({ define: { __MODE__: JSON.stringify(mode) } }))" }, /uses a define value that is not a literal/],
  ["a filter other than Boolean", { "vite.config.ts": LOVABLE.replace(".filter(Boolean)", ".filter((p) => p)") }, /uses a plugin|uses the setting plugins/],
  // Build-time files that run when Vite builds.
  ["process in postcss.config.js", { "postcss.config.js": "export default { plugins: { tailwindcss: {}, autoprefixer: {} }, map: process.env.CSS_MAP }\n" }, /^postcss\.config\.js uses the option map \(line 1\), which the wizard does not check, and PostCSS runs it when Vite builds/],
  ["env in tailwind.config.ts", { "tailwind.config.ts": "import type { Config } from 'tailwindcss'\nconst brand = import.meta.env.VITE_BRAND\nexport default { content: ['./src/**/*.tsx'] } satisfies Config\n" }, /^tailwind\.config\.ts uses code besides the imports and the export \(line 2\), which the wizard does not check, and Tailwind runs it when Vite builds/],
  ["process in .postcssrc.cjs", { ".postcssrc.cjs": "module.exports = { plugins: [require('x')(process.env)] }\n" }, /^\.postcssrc\.cjs uses the plugin x \(line 1\), which the wizard does not check/],
  ["loadEnv with the default prefix", { "vite.config.ts": "export default defineConfig(({ mode }) => { const env = loadEnv(mode, process.cwd()); return { base: env.VITE_BASE } })" }, /uses the name (env|loadEnv|process)/],
  ["EnvironmentPlugin with a named list", { "vite.config.js": "import { defineConfig } from 'vite'\nimport EnvironmentPlugin from 'vite-plugin-environment'\nexport default defineConfig({ plugins: [EnvironmentPlugin(['API_URL', 'DEBUG'])] })" }, /uses the import of vite-plugin-environment \(line 2\)/],
  ["EnvironmentPlugin with defaults", { "vite.config.js": "import EnvironmentPlugin from 'vite-plugin-environment'\nexport default { plugins: [EnvironmentPlugin({ API_URL: 'http://localhost' })] }" }, /uses the import of vite-plugin-environment/],
  ["a babel plugin other than the React Compiler", { "vite.config.js": "import react from '@vitejs/plugin-react'\nexport default { plugins: [react({ babel: { plugins: ['transform-inline-environment-variables'] } })] }" }, /uses the option babel\.plugins of @vitejs\/plugin-react \(line 2\), which the wizard does not check/],
  ["a Babel config file", { "vite.config.js": "import react from '@vitejs/plugin-react'\nexport default { plugins: [react({ babel: { babelrc: true } })] }" }, /uses the option babel\.babelrc of @vitejs\/plugin-react \(line 2\), which the wizard does not check/],
  // Build commands Vercel would run that are not a plain Vite build.
  ["a lint step before the build", { "package.json": pkgJson({ scripts: { build: "npm run lint && vite build", lint: "eslint ." } }) }, /the "build" script \("npm run lint && vite build"\)/],
  ["vite build with a mode from a variable", { "package.json": pkgJson({ scripts: { build: "vite build --mode $MODE" } }) }, /the "build" script \("vite build --mode \$MODE"\)/],
  ["vite build with two modes", { "package.json": pkgJson({ scripts: { build: "vite build --mode a --mode b" } }) }, /the "build" script/],
  ["pnpm -C app", { "package.json": pkgJson({ scripts: { build: "pnpm -C app exec vite build" } }) }, /the "build" script \("pnpm -C app exec vite build"\)/],
  ["npx vite@5 build app", { "package.json": pkgJson({ scripts: { build: "npx --yes vite@5 build app" } }) }, /The script "build" runs Vite in another folder \(app\)/],
  ["vercel.json's buildCommand cd", { "vercel.json": JSON.stringify({ buildCommand: "cd web && vite build" }) }, /vercel\.json's buildCommand runs Vite in another folder \(web\)/],
  ["the vercel-build script first", { "package.json": pkgJson({ scripts: { build: "vite build", "vercel-build": "node build.mjs" } }) }, /the "vercel-build" script \("node build\.mjs"\)/],
  ["a script that runs itself", { "package.json": pkgJson({ scripts: { build: "npm run build" } }) }, /the "build" script \("npm run build"\)/],
];

test("readViteSettings: what would put PARLOX_SECRET_KEY into the browser build, and what would not", () => {
  for (const [label, files, why] of EXPOSING) {
    const s = settingsOf(({ "package.json": pkgJson(), ...files }));
    assert.ok(s.exposure, label);
    assert.match(s.exposure.why, why, label);
    assert.ok(s.exposure.fix.length > 0, label);
  }
  for (const [label, files, why] of UNCHECKED) {
    const s = settingsOf(({ "package.json": pkgJson(), ...files }));
    assert.ok(s.exposure, label);
    assert.match(s.exposure.why, why, label);
  }
  for (const [label, files] of SAFE) assert.equal(settingsOf(({ "package.json": pkgJson(), ...files })).exposure, null, label);
});

/** The warning for an exposure, as the review and the report give it. */
const warningFor = (e, entryKnown) => `${e.why} ${entryKnown ? "Parlox set up the browser part only" : "Parlox added no server part"}${e.byHand ? `. ${e.fix[0].toUpperCase()}${e.fix.slice(1)}.` : `; ${e.fix} and run the wizard again to add the server part.`}`;

test("on Vercel, a Vite config that could bundle the secret key: the browser part and the ownership file only, no middleware, no host step, and the reason in the review and the report", () => {
  for (const [label, files] of [...EXPOSING, ...UNCHECKED]) {
    const dir = app({ "vercel.json": "{}", ...files });
    const d = self(dir);
    assert.equal(d.parts.server.kind, "verify-file", label);
    const host = vercelHost(null);
    assert.equal(viteServerKind(host, d.data), "verify-file", label);
    assert.equal(viteReact.hostStep(d, host), false, label);
    const plan = viteReact.plan(d, input(dir, host));
    // A config the wizard cannot read at all hides index.html's and the public folder's place too: both by hand.
    const readable = d.data.publicDir !== null;
    assert.deepEqual(plan.changes.map((c) => c.path), readable ? ["src/main.tsx", "public/.well-known/parlox-verify"] : [], label);
    if (!readable) assert.deepEqual(plan.manual.map((m) => m.part), ["browser", "server"], label);
    assert.deepEqual(plan.install.args, ["install", "--save-exact", `@parlox/browser@${BROWSER_VERSION}`], label);
    const warning = warningFor(d.data.exposure, !!d.data.entry);
    assert.deepEqual(plan.warnings, [warning], label);
    assert.deepEqual(d.notes, [warning], label);
    assert.doesNotMatch(viteReact.hostNotes(d, host, { browser: true, server: true, unitHasBrowser: true }).join("\n"), /Deploy on Vercel/, label);
  }
  const d = self(app({ "vercel.json": "{}", "vite.config.ts": "export default { envPrefix: ['VITE_', 'PARLOX_'] }" }));
  assert.equal(d.notes[0], "Your Vite config lists PARLOX_ in envPrefix, so the secret key would be bundled into the browser code. Parlox set up the browser part only; remove PARLOX_ from envPrefix and run the wizard again to add the server part.");
  // With no host file, nothing is asked: the answer would change nothing.
  assert.equal(self(app({ "vite.config.ts": "export default { envPrefix: 'PARLOX_' }" })).parts.server.kind, "verify-file");
  for (const [label, files] of SAFE) assert.equal(self(app({ "vercel.json": "{}", ...files })).parts.server.kind, "vercel-edge", label);
});

test("a full run on Vercel with an exposing Vite config creates no key, hands off no secret, and says why in the review and the report; --local-key refuses too", async (t) => {
  const auth = await startFakeAuth({ decide: "approve" });
  const gw = await startFakeGateway({ sites: [{ id: "11111111-1111-1111-1111-111111111111", name: "Shop", domain: "shop.example.com", public_key: PK, verified: false }], keys: [] });
  t.after(() => { auth.close(); gw.close(); });
  const config = { gateway: gw.url, supabaseUrl: auth.url, clientId: "wiz", apiKey: "k", ports: [53822, 53823], dashboard: "https://app.parlox.io" };
  for (const [files, warning, localKey, verified] of [
    [{ "vite.config.ts": "export default { envPrefix: ['VITE_', 'PARLOX_'] }" }, "Your Vite config lists PARLOX_ in envPrefix, so the secret key would be bundled into the browser code. Parlox set up the browser part only; remove PARLOX_ from envPrefix and run the wizard again to add the server part.", "WARN No local key: Your Vite config lists PARLOX_ in envPrefix, so the secret key would be bundled into the browser code. Remove PARLOX_ from envPrefix and run the wizard again.", true],
    [{ "vite.config.js": "import EnvironmentPlugin from 'vite-plugin-environment'\nexport default { plugins: [EnvironmentPlugin('all')] }" }, "vite.config.js loads EnvironmentPlugin('all') (line 2), which puts every environment variable into the browser code, the secret key included. Parlox set up the browser part only; remove vite-plugin-environment from the Vite config and run the wizard again to add the server part.", "WARN No local key: vite.config.js loads EnvironmentPlugin('all') (line 2), which puts every environment variable into the browser code, the secret key included. Remove vite-plugin-environment from the Vite config and run the wizard again.", true],
    [{ "vite.config.js": "import { defineConfig } from 'vite'\nexport default defineConfig({ plugins: [{ name: 'p', config: () => ({ envPrefix: ['VITE_', 'PARLOX_'] }) }] })" }, "vite.config.js uses a plugin (line 2), which the wizard does not check, so it cannot prove that Vite keeps the secret key out of the browser code. Parlox set up the browser part only. If nothing in the build puts a PARLOX_ variable into the browser code, add the server part by hand (see https://gateway.parlox.io/install.md).", "WARN No local key: vite.config.js uses a plugin (line 2), which the wizard does not check, so it cannot prove that Vite keeps the secret key out of the browser code.", true],
    [{ "package.json": pkgJson({ scripts: { build: "vite build app" } }) }, "The script \"build\" runs Vite in another folder (app), so the wizard cannot tell which config Vite uses, or prove that it keeps the secret key out of the browser code. Parlox added no server part; run Vite from this folder, without the folder name (app), and run the wizard again to add the server part.", "WARN No local key: The script \"build\" runs Vite in another folder (app), so the wizard cannot tell which config Vite uses, or prove that it keeps the secret key out of the browser code. Run Vite from this folder, without the folder name (app), and run the wizard again.", false],
  ]) {
  const dir = app({ "vercel.json": "{}", ".vercel/project.json": JSON.stringify({ projectId: "p", orgId: "o" }), ...files });
  gw.state.keys.length = 0;
  const out = [], reports = [], runs = [];
  const ui = { info: (m) => out.push(m), warn: (m) => out.push(`WARN ${m}`), confirm: async () => true, select: async (_m, o) => o[0].value, text: async () => "", report: (lines) => reports.push(...lines) };
  const run = (cmd, args) => { runs.push([cmd, ...args].join(" ")); return { status: 0, stdout: "", stderr: "" }; };
  assert.equal(await main(["--yes", "--vercel", "--allow-no-git", "--local-key", "--site", "shop.example.com", "--skip-check"], { cwd: dir, config, open: (url) => { if (!url.includes("newKey")) fetch(url).catch(() => {}); }, run, ui }), 0, out.join("\n"));
  assert.ok(out.includes(`WARN ${warning}`), "in the review: " + out.join("\n"));
  assert.ok(reports.includes(warning), "in the report: " + reports.join("\n"));
  assert.deepEqual(gw.state.keys, [], "no key was created");
  assert.equal(runs.some((r) => r.includes("vercel")), false, "nothing was set on Vercel: " + runs.join(" | "));
  assert.equal(out.some((m) => m.includes("PARLOX_SECRET_KEY (from the dashboard key")), false, "no hand-off asks for the secret key");
  assert.ok(out.includes(localKey), out.join("\n"));
  assert.equal(existsSync(join(dir, "middleware.ts")), false);
  // With a root elsewhere, where the public folder is is not known either: the ownership file is a step by hand.
  assert.equal(existsSync(join(dir, "public/.well-known/parlox-verify")) && readFileSync(join(dir, "public/.well-known/parlox-verify"), "utf8"), verified ? "vt_fake\n" : false);
  for (const f of [".env", ".env.local"]) assert.equal(existsSync(join(dir, f)), false, f);
  }
});

test("the Vercel middleware's own warnings (its matcher) reach the report as well as the review", async (t) => {
  const auth = await startFakeAuth({ decide: "approve" });
  const gw = await startFakeGateway({ sites: [{ id: "11111111-1111-1111-1111-111111111111", name: "Shop", domain: "shop.example.com", public_key: PK, verified: false }], keys: [] });
  t.after(() => { auth.close(); gw.close(); });
  const config = { gateway: gw.url, supabaseUrl: auth.url, clientId: "wiz", apiKey: "k", ports: [53822, 53823], dashboard: "https://app.parlox.io" };
  const dir = app({ "vercel.json": "{}", "middleware.ts": "export default function mw(req: Request) {}\nexport const config = { matcher: ['/shop/:path*'] }\n" });
  const out = [], reports = [];
  const ui = { info: (m) => out.push(m), warn: (m) => out.push(`WARN ${m}`), confirm: async () => true, select: async (_m, o) => o[0].value, text: async () => "", report: (lines) => reports.push(...lines) };
  assert.equal(await main(["--yes", "--no-vercel", "--allow-no-git", "--site", "shop.example.com", "--skip-check"], { cwd: dir, config, open: (url) => { if (!url.includes("newKey")) fetch(url).catch(() => {}); }, run: () => ({ status: 0, stdout: "", stderr: "" }), ui }), 0, out.join("\n"));
  const matcher = reports.filter((l) => l.startsWith("middleware.ts: This file has its own matcher."));
  assert.equal(matcher.length, 1, reports.join("\n"));
  assert.ok(out.some((m) => m.startsWith("WARN middleware.ts: This file has its own matcher.")), out.join("\n"));
});

test("uninstall removes the folders the ownership file was put in when they are left empty, and keeps any that hold something else", () => {
  for (const [label, files, gone, kept] of [
    ["the wizard created public/ and .well-known/", {}, ["public/.well-known", "public"], []],
    ["public/ was there (with a file)", { "public/vite.svg": "<svg/>" }, ["public/.well-known"], ["public/vite.svg"]],
    [".well-known/ was there (with a file)", { "public/.well-known/security.txt": "Contact: x\n" }, [], ["public/.well-known/security.txt"]],
    ["a publicDir inside root", { "vite.config.js": "export default { root: 'web', publicDir: 'static' }", "web/index.html": '<script type="module" src="/main.jsx"></script>', "web/main.jsx": "createRoot(a).render(<App />)\n", "web/app.css": "" }, ["web/static/.well-known", "web/static"], ["web/app.css"]],
  ]) {
    const dir = fixture({ "package.json": pkgJson(), "netlify.toml": "", "index.html": INDEX_HTML, "src/main.tsx": MAIN_TSX, ...files });
    applyPlan(dir, viteReact.plan(self(dir), input(dir, OTHER)));
    const un = viteReact.unplan(self(dir), { read: reader(dir), git });
    applyPlan(dir, un);
    for (const f of gone) assert.equal(existsSync(join(dir, f)), false, `${label}: ${f} removed`);
    for (const f of kept) assert.equal(existsSync(join(dir, f)), true, `${label}: ${f} kept`);
    assert.equal(existsSync(join(dir, "package.json")), true, `${label}: the app folder stays`);
  }
  // publicDir "." (the app folder itself): only .well-known/ goes.
  const dot = app({ "netlify.toml": "", "vite.config.js": "export default { publicDir: '.' }" });
  applyPlan(dot, viteReact.plan(self(dot), input(dot, OTHER)));
  applyPlan(dot, viteReact.unplan(self(dot), { read: reader(dot), git }));
  assert.equal(existsSync(join(dot, ".well-known")), false);
  assert.equal(existsSync(join(dot, "package.json")), true);
});

test("a symlinked public folder or entry file is a step by hand, not the end of the run", () => {
  const outside = fixture({ "main.tsx": MAIN_TSX });
  const pub = app({ "netlify.toml": "" });
  symlinkSync(fixture({}), join(pub, "public"));
  const plan = viteReact.plan(self(pub), { ...input(pub, OTHER), read: (f) => readInside(pub, f) });
  assert.deepEqual(plan.changes.map((c) => c.path), ["src/main.tsx"]);
  assert.equal(plan.manual.length, 1);
  assert.equal(plan.manual[0].part, "server");
  assert.match(plan.manual[0].reason, /points outside the project folder/);
  const entry = app({ "netlify.toml": "" });
  rmSync(join(entry, "src/main.tsx"));
  symlinkSync(join(outside, "main.tsx"), join(entry, "src/main.tsx"));
  const p2 = viteReact.plan(self(entry), { ...input(entry, OTHER), read: (f) => readInside(entry, f) });
  assert.deepEqual(p2.changes.map((c) => c.path), ["public/.well-known/parlox-verify"]);
  assert.equal(p2.manual[0].part, "browser");
  assert.match(p2.manual[0].reason, /points outside the project folder/);
  const un = viteReact.unplan(self(entry), { read: (f) => readInside(entry, f), git });
  assert.match(un.manual.map((m) => m.reason).join("\n"), /points outside the project folder/);
});

test("a symlinked middleware on Vercel is a step by hand naming that file", () => {
  const dir = app({ "vercel.json": "{}" });
  symlinkSync(join(fixture({ "m.ts": "export default function m() {}\n" }), "m.ts"), join(dir, "middleware.ts"));
  const plan = viteReact.plan(self(dir), { ...input(dir, vercelHost(null)), read: (f) => readInside(dir, f) });
  assert.deepEqual(plan.changes.map((c) => c.path), ["src/main.tsx"]);
  assert.deepEqual(plan.manual.map((m) => [m.file, m.part]), [["middleware.ts", "server"]]);
  assert.match(plan.manual[0].reason, /^Refusing middleware\.ts: it points outside the project folder\.$/);
  assert.match(viteReact.unplan(self(dir), { read: (f) => readInside(dir, f), git }).manual[0].reason, /^Refusing middleware\.ts/);
});

test("a Vite config that exists but cannot be read, or is over 1 MB, is unknown, never no config", () => {
  assert.match(settingsOf({ "vite.config.js": null }).exposure.why, /^vite\.config\.js exists, but the wizard cannot read it/);
  assert.equal(settingsOf({ "vite.config.ts": "export default { envPrefix: 'PARLOX_' }", "vite.config.js": null }).file, "vite.config.js", "Vite takes the first that exists");
  const big = app({ "vercel.json": "{}", "vite.config.js": "export default {}\n//" + "x".repeat(1_000_100) });
  const folder = app({ "vercel.json": "{}" });
  mkdirSync(join(folder, "vite.config.js"));
  const cases = [["over 1 MB", big], ["a folder", folder]];
  // POSIX only, and not as root: Windows has no such permission, and root reads it all the same.
  if (process.platform !== "win32" && process.getuid?.() !== 0) {
    const locked = app({ "vercel.json": "{}", "vite.config.js": "export default {}\n" });
    chmodSync(join(locked, "vite.config.js"), 0o000);
    cases.push(["unreadable", locked]);
  }
  for (const [label, dir] of cases) {
    const d = self(dir);
    assert.match(d.data.exposure?.why ?? "", /^vite\.config\.js exists, but the wizard cannot read it/, label);
    assert.equal(d.data.entry, null, label);
    assert.equal(d.parts.server.kind, "verify-file", label);
    assert.equal(viteReact.hostStep(d, vercelHost(null)), false, label);
    assert.deepEqual(viteReact.plan(d, input(dir, vercelHost(null))).changes, [], label);
  }
});

test("the create-vite configs and a Tailwind config with an @ alias are safe: the middleware and the host step on Vercel", () => {
  for (const [label, files] of SAFE) {
    const dir = app({ "vercel.json": "{}", ...files });
    const d = self(dir);
    assert.equal(d.data.exposure, null, label);
    assert.equal(d.parts.server.kind, "vercel-edge", label);
    assert.equal(viteReact.hostStep(d, vercelHost(null)), true, label);
    assert.ok(viteReact.plan(d, input(dir, vercelHost(null))).changes.some((c) => c.path.startsWith("middleware.")), label);
  }
  // The @ alias is a path helper, not a string: the settings the wizard needs are still known.
  assert.deepEqual(settingsOf(({ "vite.config.ts": TAILWIND })), { file: "vite.config.ts", root: ".", envPrefix: ["VITE_"], publicDir: "public", exposure: null });
});

test("on Vercel, the report says to check a Build Command set in Vercel's dashboard", async (t) => {
  const NOTE = "If this project sets a Build Command, an Install Command or an Ignored Build Step in Vercel's dashboard, check that the Build Command runs `vite build` and that none of them runs code that could put PARLOX_SECRET_KEY into the build: the wizard cannot see dashboard settings.";
  const d = self(app({ "vercel.json": "{}" }));
  assert.ok(viteReact.hostNotes(d, vercelHost(null), { browser: true, server: true, unitHasBrowser: true }).includes(NOTE));
  assert.ok(!viteReact.hostNotes(d, OTHER, { browser: true, server: true, unitHasBrowser: true }).includes(NOTE), "not off Vercel");
  const auth = await startFakeAuth({ decide: "approve" });
  const gw = await startFakeGateway({ sites: [{ id: "11111111-1111-1111-1111-111111111111", name: "Shop", domain: "shop.example.com", public_key: PK, verified: false }], keys: [] });
  t.after(() => { auth.close(); gw.close(); });
  const config = { gateway: gw.url, supabaseUrl: auth.url, clientId: "wiz", apiKey: "k", ports: [53822, 53823], dashboard: "https://app.parlox.io" };
  const dir = app({ "vercel.json": "{}", "vite.config.ts": LOVABLE });
  const out = [], reports = [];
  const ui = { info: (m) => out.push(m), warn: (m) => out.push(`WARN ${m}`), confirm: async () => true, select: async (_m, o) => o[0].value, text: async () => "", report: (lines) => reports.push(...lines) };
  assert.equal(await main(["--yes", "--no-vercel", "--allow-no-git", "--site", "shop.example.com", "--skip-check"], { cwd: dir, config, open: (url) => { if (!url.includes("newKey")) fetch(url).catch(() => {}); }, run: () => ({ status: 0, stdout: "", stderr: "" }), ui }), 0, out.join("\n"));
  assert.ok(reports.includes(NOTE), reports.join("\n"));
  assert.equal(existsSync(join(dir, "middleware.ts")), true, "Lovable's default config gets the middleware");
});

// The allowlist's own contract. It is default-deny, so the only possible mistake is an unusual shape it
// reads as safe; each of these is one, and each must read as not proven safe, for the reason given.
const CONTRACT_R = "import react from '@vitejs/plugin-react'\nimport { defineConfig } from 'vite'\n";
const CONTRACT_P = "import path from 'path'\nimport { fileURLToPath, URL } from 'node:url'\nimport { defineConfig } from 'vite'\n";
const CONTRACT = [
  ["1 const react re-declared", { "vite.config.js": CONTRACT_R + "const react = () => ({ name: 'x', config: () => ({ envPrefix: 'PARLOX_' }) })\nexport default defineConfig({ plugins: [react()] })" }, /cannot read vite\.config\.js to the end \(it does not parse\)/],
  ["1 a parameter named react", { "vite.config.js": CONTRACT_R + "export default defineConfig(({ react }) => ({ plugins: [react()] }))" }, /uses a config function with parameters other than \{ mode, command \} \(line 3\)/],
  ["1 a parameter that shadows JSON", { "vite.config.js": "import { defineConfig } from 'vite'\nexport default defineConfig(({ JSON }) => ({ define: { X: JSON.stringify('a') } }))" }, /uses a config function with parameters other than \{ mode, command \} \(line 2\)/],
  ["1 a parameter that shadows __dirname", { "vite.config.js": CONTRACT_P + "export default defineConfig(({ __dirname }) => ({ resolve: { alias: { '@': path.resolve(__dirname, 'src') } } }))" }, /uses a config function with parameters other than \{ mode, command \} \(line 4\)/],
  ["1 mode beside another parameter", { "vite.config.ts": LOVABLE.replace("({ mode })", "({ mode, react })") }, /uses a config function with parameters other than \{ mode, command \} \(line 7\)/],
  ["2 a spread argument", { "vite.config.js": CONTRACT_R + "export default defineConfig({ plugins: [react(...opts)] })" }, /uses the options of @vitejs\/plugin-react \(line 3\)/],
  ["2 a computed option", { "vite.config.js": CONTRACT_R + "export default defineConfig({ plugins: [react({ [key]: true })] })" }, /uses an option of @vitejs\/plugin-react written in code \(line 3\)/],
  ["3 JSON.stringify(pkg[someVar])", { "vite.config.js": "import pkg from './package.json'\nexport default { define: { X: JSON.stringify(pkg[someVar]) } }" }, /uses a define value that is not a literal \(line 2\)/],
  ["3 pkg reassigned", { "vite.config.js": "import pkg from './package.json'\npkg = { version: 'x' }\nexport default { define: { X: JSON.stringify(pkg.version) } }" }, /uses code besides the imports and the export \(line 2\)/],
  ["3 pkg mutated", { "vite.config.js": "import pkg from './package.json'\npkg.version = globalThis['proc' + 'ess']\nexport default { define: { X: JSON.stringify(pkg.version) } }" }, /uses code besides the imports and the export \(line 2\)/],
  ["4 the gate with ||", { "vite.config.ts": LOVABLE.replace("mode === 'development' &&\n    componentTagger()", "(mode === 'development' || other) && componentTagger()") }, /uses a plugin \(line 14\)/],
  ["4 the gate as mode === development || tagger", { "vite.config.ts": LOVABLE.replace("mode === 'development' &&\n    componentTagger()", "mode === 'development' || componentTagger()") }, /uses a plugin \(line 14\)/],
  ["4 mode !== production", { "vite.config.ts": LOVABLE.replace("mode === 'development' &&", "mode !== 'production' &&") }, /uses a plugin \(line 14\)/],
  ["5 the tagger under another name", { "vite.config.ts": LOVABLE.replace("import { componentTagger } from", "import { componentTagger as tag } from").replace("componentTagger(),", "tag(),") }, /uses the import of lovable-tagger \(line 4\)/],
  ["5 the tagger re-bound", { "vite.config.ts": LOVABLE.replace("// https://vitejs.dev/config/", "const t = componentTagger").replace("componentTagger(),", "t(),") }, /uses code besides the imports and the export \(line 6\)/],
  ["6 path.resolve(__dirname, someVar)", { "vite.config.js": CONTRACT_P + "export default defineConfig({ resolve: { alias: { '@': path.resolve(__dirname, someVar) } } })" }, /uses the setting resolve \(line 4\)/],
  ["6 new URL(someVar, import.meta.url)", { "vite.config.js": CONTRACT_P + "export default defineConfig({ resolve: { alias: { '@': fileURLToPath(new URL(someVar, import.meta.url)) } } })" }, /uses the setting resolve \(line 4\)/],
  ["7 a template literal with an expression in define", { "vite.config.js": "export default { define: { X: `${globalThis.x}` } }" }, /uses a define value that is not a literal \(line 1\)/],
  ["7 String.raw in define", { "vite.config.js": "export default { define: { X: String.raw`a` } }" }, /uses a define value that is not a literal \(line 1\)/],
  ["7 JSON.stringify of a template with an expression", { "vite.config.js": "export default { define: { X: JSON.stringify(`${globalThis.x}`) } }" }, /uses a define value that is not a literal \(line 1\)/],
  ["8 a Unicode-escaped process", { "vite.config.js": "export default { define: { X: JSON.stringify(\\u0070rocess.env) } }" }, /passes environment values to the browser code through define \(line 1\)/],
  ["8 Unicode-escaped names in a member", { "vite.config.js": "export default { define: { X: JSON.stringify(globalThis.proc\\u0065ss.\\u0065nv) } }" }, /uses the name process \(line 1\)/],
  ["8 a Unicode-escaped key", { "vite.config.js": "export default { '\\u0065nvPrefix': 'PARLOX_' }" }, /lists PARLOX_ in envPrefix/],
  ["9 a getter", { "vite.config.js": "export default { get envPrefix() { return 'PARLOX_' } }" }, /cannot read envPrefix in vite\.config\.js \(it is computed in code\)/],
  ["9 Object.defineProperty", { "vite.config.js": "const c = {}\nObject.defineProperty(c, 'envPrefix', { value: 'PARLOX_' })\nexport default c" }, /cannot read vite\.config\.js to the end \(its config object c is also changed or used on line 2\)/],
  ["9 Object.defineProperty as the export", { "vite.config.js": "export default Object.defineProperty({}, 'envPrefix', { value: 'PARLOX_' })" }, /cannot read vite\.config\.js to the end \(it is built in code the wizard cannot follow/],
  ["9 __proto__ holding envPrefix", { "vite.config.js": "export default { __proto__: { envPrefix: 'PARLOX_' } }" }, /uses a setting written in code \(line 1\)/],
  ["9 '__proto__' as a string key", { "vite.config.js": "import { defineConfig } from 'vite'\nexport default defineConfig({ '__proto__': { envPrefix: ['VITE_', 'PARLOX_'] } })" }, /uses a setting written in code \(line 2\)/],
  ["9 an escaped __proto__ key in a plugin's options", { "vite.config.js": CONTRACT_R + "export default defineConfig({ plugins: [react({ '\\u005f_proto__': { babel: { plugins: ['x'] } } })] })" }, /uses an option of @vitejs\/plugin-react written in code \(line 3\)/],
  ["10 top-level await", { "vite.config.js": "import { defineConfig } from 'vite'\nconst x = await Promise.resolve('a')\nexport default defineConfig({ base: '/' })" }, /uses code besides the imports and the export \(line 2\)/],
  ["10 await in the export", { "vite.config.js": "export default await Promise.resolve({ envPrefix: 'PARLOX_' })" }, /cannot read vite\.config\.js to the end \(it is built in code the wizard cannot follow/],
  ["10 await in define", { "vite.config.js": "export default { define: { X: await Promise.resolve('\"a\"') } }" }, /uses a define value that is not a literal \(line 1\)/],
  ["11 the export of a variable assigned later", { "vite.config.js": "let c\nc = { envPrefix: 'PARLOX_' }\nexport default c" }, /cannot read vite\.config\.js to the end \(it is built in code the wizard cannot follow/],
  ["12 a re-export from another file", { "vite.config.js": "export { default } from './base.config'", "base.config.js": "export default { envPrefix: 'PARLOX_' }" }, /cannot read vite\.config\.js to the end \(it has no single default export/],
  ["13 envDir", { "vite.config.js": "export default { envDir: '../..' }" }, /uses the setting envDir \(line 1\)/],
  ["13 envDir through a path helper", { "vite.config.js": CONTRACT_P + "export default defineConfig({ envDir: path.resolve(__dirname, 'env') })" }, /uses the setting envDir \(line 4\)/],
  ["14 --mode x --config y", { "package.json": pkgJson({ scripts: { build: "vite build --mode x --config y" } }) }, /^The script \"build\" runs Vite with --config/],
  ["14 --mode x app", { "package.json": pkgJson({ scripts: { build: "vite build --mode x app" } }) }, /^The script \"build\" runs Vite in another folder \(app\)/],
  ["14 --mode x --outDir ../d", { "package.json": pkgJson({ scripts: { build: "vite build --mode x --outDir ../d" } }) }, /^Vercel builds this app with the \"build\" script \(\"vite build --mode x --outDir \.\.\/d\"\), which is not one of the builds the wizard checks/],
  ["14 --mode x --base ../", { "package.json": pkgJson({ scripts: { build: "vite build --mode x --base ../" } }) }, /^Vercel builds this app with the \"build\" script \(\"vite build --mode x --base \.\.\/\"\), which is not one of the builds the wizard checks/],
  ["15 vercel-build not plain while build is", { "package.json": pkgJson({ scripts: { build: "vite build", "vercel-build": "vite build && node leak.mjs" } }) }, /^Vercel builds this app with the \"vercel-build\" script \(\"vite build && node leak\.mjs\"\), which is not one of the builds/],
  ["16 buildCommand npm ci && vite build", { "vercel.json": JSON.stringify({ buildCommand: "npm ci && vite build" }) }, /^Vercel builds this app with vercel\.json's buildCommand \(\"npm ci && vite build\"\), which is not one of the builds/],
  ["16 buildCommand with ;", { "vercel.json": JSON.stringify({ buildCommand: "vite build; node leak.mjs" }) }, /^Vercel builds this app with vercel\.json's buildCommand \(\"vite build; node leak\.mjs\"\), which is not one of the builds/],
  ["16 buildCommand with |", { "vercel.json": JSON.stringify({ buildCommand: "vite build | tee log" }) }, /^Vercel builds this app with vercel\.json's buildCommand \(\"vite build \| tee log\"\), which is not one of the builds/],
  ["16 buildCommand FOO=1 vite build", { "vercel.json": JSON.stringify({ buildCommand: "FOO=1 vite build" }) }, /^Vercel builds this app with vercel\.json's buildCommand \(\"FOO=1 vite build\"\), which is not one of the builds/],
  ["16 buildCommand with a newline", { "vercel.json": JSON.stringify({ buildCommand: "vite build\nnode leak.mjs" }) }, /^Vercel builds this app with vercel\.json's buildCommand \(\"vite build\\nnode leak\.mjs\"\), which is not one of the builds/],
  ["16 buildCommand tsc && vite build && more", { "vercel.json": JSON.stringify({ buildCommand: "tsc && vite build && node leak.mjs" }) }, /^Vercel builds this app with vercel\.json's buildCommand \(\"tsc && vite build && node leak\.mjs\"\), which is not one of the builds/],
  ["16 buildCommand with ||", { "vercel.json": JSON.stringify({ buildCommand: "vite build || node leak.mjs" }) }, /^Vercel builds this app with vercel\.json's buildCommand \(\"vite build \|\| node leak\.mjs\"\), which is not one of the builds/],
  ["16 buildCommand with a subshell", { "vercel.json": JSON.stringify({ buildCommand: "vite build $(node leak.mjs)" }) }, /^vercel\.json's buildCommand runs Vite in another folder \(\$\(node\)/],
  ["16 buildCommand with a background &", { "vercel.json": JSON.stringify({ buildCommand: "node leak.mjs & vite build" }) }, /^Vercel builds this app with vercel\.json's buildCommand \(\"node leak\.mjs & vite build\"\), which is not one of the builds/],
  // Found while writing these: a PostCSS config at a path of the config's own choosing runs in the build.
  ["css.postcss as a path", { "vite.config.js": "export default { css: { postcss: './build/postcss.js' } }", "build/postcss.js": "module.exports = { plugins: [require('x')(process.env)] }" }, /uses the setting css\.postcss \(line 1\)/],
];

test("the allowlist's contract: the configs it must read as safe", () => {
  for (const [label, files] of [...Object.entries(CREATE_VITE).map(([n, f]) => [`create-vite ${n}`, f]), ["Lovable's default", { "vite.config.ts": LOVABLE }], ["Tailwind, tsconfig-paths and an @ alias", { "vite.config.ts": TAILWIND }]]) {
    assert.equal(settingsOf({ "package.json": pkgJson(), ...files }).exposure, null, label);
  }
});

test("the allowlist's contract: unusual shapes are never read as safe, and get no middleware or host step on Vercel", () => {
  for (const [label, files, why] of CONTRACT) {
    const s = settingsOf({ "package.json": pkgJson(), ...files });
    assert.ok(s.exposure, `${label}: read as safe`);
    assert.match(s.exposure.why, why, label);
    const d = self(app({ "vercel.json": "{}", ...files }));
    assert.equal(d.parts.server.kind, "verify-file", label);
    assert.equal(viteReact.hostStep(d, vercelHost(null)), false, label);
    assert.equal(viteReact.plan(d, input(d.dir, vercelHost(null))).changes.some((c) => c.path.startsWith("middleware.")), false, label);
  }
});

// What else Vercel's build reads or runs besides the Vite config (the build and install commands and
// their npm hooks, the other Vercel config files, .env files, PostCSS and Tailwind configs, stylesheets that load
// code, plugin options), each not proven safe for the reason given; and the shapes it must read as safe.
const scripts = (s, extra = {}) => ({ "package.json": pkgJson({ scripts: s, ...extra }) });
const BABEL_R = "import react, { reactCompilerPreset } from '@vitejs/plugin-react'\nimport babel from '@rolldown/plugin-babel'\n";
const R5_NOT_SAFE = [
  // Vercel runs the first of vercel-build, now-build and build (@vercel/static-build 14.0.0).
  ["now-build comes before build", scripts({ "now-build": "node leak.mjs", build: "vite build" }), /^Vercel builds this app with the "now-build" script \("node leak\.mjs"\), which is not one of the builds the wizard checks/],
  // npm runs a script's pre and post scripts with it.
  ["a prebuild script", scripts({ prebuild: "node gen.mjs", build: "vite build" }), /^Vercel builds this app with the "build" script \("vite build"\), and npm also runs the "prebuild" script with it, which the wizard does not check/],
  ["a postbuild script", scripts({ build: "tsc -b && vite build", postbuild: "node gen.mjs" }), /and npm also runs the "postbuild" script with it/],
  ["a pre script of a script the build runs", scripts({ build: "npm run build:app", "build:app": "vite build", "prebuild:app": "node gen.mjs" }), /and npm also runs the "prebuild:app" script with it/],
  ["a pre script of vercel-build", scripts({ "vercel-build": "vite build", "prevercel-build": "node gen.mjs" }), /^Vercel builds this app with the "vercel-build" script \("vite build"\), and npm also runs the "prevercel-build" script/],
  // The install runs before the build, with the same variables.
  ["vercel.json's installCommand", { "vercel.json": JSON.stringify({ installCommand: "npm ci && node gen.mjs" }) }, /^vercel\.json sets installCommand, which Vercel runs in the build and the wizard does not check/],
  ["vercel.json's ignoreCommand", { "vercel.json": JSON.stringify({ ignoreCommand: "node check.mjs" }) }, /^vercel\.json sets ignoreCommand, which Vercel runs in the build/],
  ["vercel.json's builds", { "vercel.json": JSON.stringify({ builds: [{ src: "package.json", use: "@vercel/static-build" }] }) }, /^vercel\.json sets builds, which Vercel runs in the build/],
  ["a postinstall script", scripts({ postinstall: "node gen-env.mjs", build: "vite build" }), /^package\.json has a "postinstall" script, which runs when Vercel installs the dependencies, and the wizard does not check it/],
  ["a prepare script that is not husky", scripts({ prepare: "node gen.mjs", build: "vite build" }), /^package\.json has a "prepare" script, which runs when Vercel installs the dependencies/],
  ...["vercel.ts", "vercel.mts", "vercel.js", "vercel.mjs", "vercel.cjs", "vercel.toml"].map((f) => [`Vercel's ${f}`, { [f]: "export const config = {}\n" }, new RegExp(`^Vercel reads ${f.replace(".", "\\.")}, which the wizard does not check`)]),
  ["a vercel.json that cannot be read", { "vercel.json": null }, /^vercel\.json exists, but the wizard cannot read it/],
  ["a vercel.json that is not JSON", { "vercel.json": "{ buildCommand: 'vite build' }" }, /^vercel\.json exists, but the wizard cannot read it/],
  ["a package.json that cannot be read", { "package.json": null }, /^package\.json exists, but the wizard cannot read it/],
  // Only an explicit `run` names a script; pnpm's and yarn's own commands are not scripts.
  ["pnpm without run", scripts({ build: "pnpm build:web", "build:web": "vite build" }), /^Vercel builds this app with the "build" script \("pnpm build:web"\), which is not one of the builds/],
  ["yarn without run", scripts({ build: "yarn build:web", "build:web": "vite build" }), /^Vercel builds this app with the "build" script \("yarn build:web"\), which is not one of the builds/],
  ["a package manager's own command", scripts({ build: "pnpm install && vite build" }), /\("pnpm install && vite build"\), which is not one of the builds/],
  // A root the wizard cannot read hides what the build reads there.
  ["a root set in code", { "vite.config.js": "import path from 'path'\nexport default { root: path.resolve(__dirname, 'client') }", "client/postcss.config.js": "module.exports = { plugins: [require('./leak')] }\n" }, /^The wizard cannot read Vite's root from vite\.config\.js/],
  ["a root outside the folder", { "vite.config.js": "export default { root: '../web' }" }, /^The wizard cannot read Vite's root from vite\.config\.js/],
  ["roots that differ by command", { "vite.config.js": "import { defineConfig } from 'vite'\nexport default defineConfig(({ command }) => command === 'build' ? { root: 'a' } : { root: 'b' })" }, /^The wizard cannot read Vite's root from vite\.config\.js/],
  // Vite's loadEnv expands $NAME from the build's environment before it keeps the VITE_ variables.
  [".env that expands a variable", { ".env": "VITE_API=https://api.example\nVITE_KEY=$PARLOX_SECRET_KEY\n" }, /^\.env has a \$ \(line 2\): Vite expands \$NAME in \.env values from the build's environment, which holds the secret key on Vercel/],
  [".env.local with braces", { ".env.local": "VITE_KEY=${PARLOX_SECRET_KEY}\n" }, /^\.env\.local has a \$ \(line 1\)/],
  [".env.production", { ".env.production": "VITE_KEY=$PARLOX_SECRET_KEY\n" }, /^\.env\.production has a \$ \(line 1\)/],
  [".env.production.local", { ".env.production.local": "VITE_KEY=$PARLOX_SECRET_KEY\n" }, /^\.env\.production\.local has a \$ \(line 1\)/],
  [".env of the build's --mode", { ...scripts({ build: "vite build --mode staging" }), ".env.staging": "VITE_KEY=$PARLOX_SECRET_KEY\n" }, /^\.env\.staging has a \$ \(line 1\)/],
  [".env in Vite's root", { "vite.config.js": "export default { root: 'client' }", "client/index.html": INDEX_HTML, "client/.env": "VITE_KEY=$PARLOX_SECRET_KEY\n" }, /^client\/\.env has a \$ \(line 1\)/],
  [".env that cannot be read", { ".env": null }, /^\.env exists, but the wizard cannot read it, and Vite loads it when it builds/],
  // Plugin options: only the ones each plugin's published types list, with literal values; Babel loads no other file.
  ["Babel's extends in react()", { "vite.config.js": CONTRACT_R + "export default defineConfig({ plugins: [react({ babel: { extends: './babel.shared.js' } })] })" }, /uses the option babel\.extends of @vitejs\/plugin-react \(line 3\), which the wizard does not check/],
  ["extends in babel()", { "vite.config.js": BABEL_R + "export default { plugins: [react(), babel({ presets: [reactCompilerPreset()], extends: './babel.shared.js' })] }" }, /uses the option extends of @rolldown\/plugin-babel \(line 3\)/],
  ["a Babel plugin by path", { "vite.config.js": CONTRACT_R + "export default defineConfig({ plugins: [react({ babel: { plugins: ['./my-plugin.js'] } })] })" }, /uses the option babel\.plugins of @vitejs\/plugin-react/],
  ["a Babel preset by path in babel()", { "vite.config.js": BABEL_R + "export default { plugins: [babel({ presets: ['./preset.js'] })] }" }, /uses the option presets of @rolldown\/plugin-babel/],
  ["Babel's configFile", { "vite.config.js": CONTRACT_R + "export default defineConfig({ plugins: [react({ babel: { configFile: './babel.config.js' } })] })" }, /uses the option babel\.configFile of @vitejs\/plugin-react/],
  ["Babel's overrides", { "vite.config.js": CONTRACT_R + "export default defineConfig({ plugins: [react({ babel: { overrides: [{ plugins: ['x'] }] } })] })" }, /uses the option babel\.overrides of @vitejs\/plugin-react/],
  ["SWC plugins", { "vite.config.js": "import react from '@vitejs/plugin-react-swc'\nexport default { plugins: [react({ plugins: [['@swc/plugin-emotion', {}]] })] }" }, /uses the option plugins of @vitejs\/plugin-react-swc \(line 2\)/],
  ["an option the plugin does not take", { "vite.config.js": "import tailwindcss from '@tailwindcss/vite'\nexport default { plugins: [tailwindcss({ config: './tw.config.js' })] }" }, /uses the option config of @tailwindcss\/vite \(line 2\)/],
  // PostCSS: a literal object whose plugins are npm names from a short list (postcss-load-config requires each by name).
  ["a PostCSS plugin by path", { "postcss.config.js": "export default { plugins: { './local-plugin.js': {} } }\n" }, /^postcss\.config\.js uses the plugin \.\/local-plugin\.js \(line 1\), which the wizard does not check, and PostCSS runs it when Vite builds/],
  ["a relative require in PostCSS", { "postcss.config.cjs": "module.exports = { plugins: [require('./local-plugin')] }\n" }, /^postcss\.config\.cjs uses the plugin \.\/local-plugin \(line 1\)/],
  ["a relative import in PostCSS", { "postcss.config.mjs": "import local from './local.js'\nexport default { plugins: [local()] }\n" }, /^postcss\.config\.mjs uses the import of \.\/local\.js \(line 1\)/],
  ["a computed key in PostCSS", { "postcss.config.js": "export default { plugins: { ['tail' + 'windcss']: {} } }\n" }, /^postcss\.config\.js uses a key written in code \(line 1\)/],
  ["computed access in PostCSS", { "postcss.config.js": "import tw from 'tailwindcss'\nexport default { plugins: [tw['default']] }\n" }, /^postcss\.config\.js uses a plugin \(line 2\)/],
  ["a PostCSS plugin not on the list", { "postcss.config.js": "export default { plugins: { 'postcss-preset-env': {} } }\n" }, /^postcss\.config\.js uses the plugin postcss-preset-env \(line 1\)/],
  ["a PostCSS config function", { "postcss.config.cjs": "module.exports = (ctx) => ({ plugins: { tailwindcss: {} } })\n" }, /^postcss\.config\.cjs uses a config that is not one object \(line 1\)/],
  ["a PostCSS parser by name", { "postcss.config.js": "export default { parser: 'sugarss', plugins: {} }\n" }, /^postcss\.config\.js uses the option parser \(line 1\)/],
  ["tailwindcss's config option", { "postcss.config.js": "export default { plugins: { tailwindcss: { config: './tw.config.js' } } }\n" }, /^postcss\.config\.js uses the option config of tailwindcss \(line 1\)/],
  [".postcssrc.json with a path", { ".postcssrc.json": JSON.stringify({ plugins: { "./x.js": {} } }) }, /^\.postcssrc\.json uses the plugin \.\/x\.js, which the wizard does not check, and PostCSS runs it/],
  [".postcssrc in YAML", { ".postcssrc": "plugins:\n  ./x.js: {}\n" }, /^\.postcssrc uses the plugin \.\/x\.js, which the wizard does not check/],
  [".postcssrc.yml with a parser", { ".postcssrc.yml": "plugins:\n  autoprefixer: {}\nparser: sugarss\n" }, /^\.postcssrc\.yml uses the option parser, which the wizard does not check/],
  ["package.json's postcss field", { "package.json": pkgJson({ postcss: { plugins: { "./x.js": {} } } }) }, /^package\.json's "postcss" field uses the plugin \.\/x\.js, which the wizard does not check/],
  ["a PostCSS config that cannot be read", { "postcss.config.js": null }, /^postcss\.config\.js exists, but the wizard cannot read it, and PostCSS runs it when Vite builds/],
  ["a PostCSS config in Vite's root", { "vite.config.js": "export default { root: 'client' }", "client/index.html": INDEX_HTML, "client/postcss.config.js": "module.exports = { plugins: [require('./x')] }\n" }, /^client\/postcss\.config\.js uses the plugin \.\/x \(line 1\)/],
  // Tailwind: a literal object, plugins only npm names from @tailwindcss/*.
  ["a relative require in Tailwind's config", { "tailwind.config.js": "module.exports = { content: ['./src/**/*.tsx'], plugins: [require('./plugins/brand')] }\n" }, /^tailwind\.config\.js uses the plugin \.\/plugins\/brand \(line 1\), which the wizard does not check, and Tailwind runs it when Vite builds/],
  ["a relative import in Tailwind's config", { "tailwind.config.mjs": "import brand from './brand.js'\nexport default { plugins: [brand] }\n" }, /^tailwind\.config\.mjs uses the import of \.\/brand\.js \(line 1\)/],
  ["a Tailwind plugin not on the list", { "tailwind.config.ts": "import type { Config } from 'tailwindcss'\nexport default { content: ['./src/**/*.tsx'], plugins: [require('tailwind-scrollbar')] } satisfies Config\n" }, /^tailwind\.config\.ts uses the plugin tailwind-scrollbar \(line 2\)/],
  ["a theme function", { "tailwind.config.js": "export default { theme: { extend: { colors: ({ theme }) => ({ brand: theme('colors.blue.500') }) } } }\n" }, /^tailwind\.config\.js uses the setting theme \(line 1\)/],
  ["a Tailwind preset", { "tailwind.config.cjs": "module.exports = { presets: [require('@acme/tailwind-preset')] }\n" }, /^tailwind\.config\.cjs uses the setting presets \(line 1\)/],
  ["a spread of defaultTheme", { "tailwind.config.js": "const defaultTheme = require('tailwindcss/defaultTheme')\nmodule.exports = { theme: { extend: { fontFamily: { sans: ['Inter', ...defaultTheme.fontFamily.sans] } } } }\n" }, /^tailwind\.config\.js uses code besides the imports and the export \(line 1\)/],
  ["a Tailwind config that cannot be read", { "tailwind.config.ts": null }, /^tailwind\.config\.ts exists, but the wizard cannot read it, and Tailwind runs it when Vite builds/],
  // Stylesheets that load code: Tailwind's @plugin and @config from a path, Less's @plugin, Stylus's use().
  ["Tailwind's @plugin with a path", { "src/index.css": "@import \"tailwindcss\";\n@plugin \"./plugins/brand.js\";\n" }, /^src\/index\.css loads code with @plugin "\.\/plugins\/brand\.js" \(line 2\), which the wizard does not check/],
  ["Tailwind's @config with a path", { "src/index.css": "@config '../tailwind.config.js';\n" }, /^src\/index\.css loads code with @config "\.\.\/tailwind\.config\.js" \(line 1\)/],
  ["@plugin through the @ alias", { "vite.config.ts": TAILWIND, "src/index.css": "@import \"tailwindcss\";\n@plugin \"@/plugins/brand\";\n" }, /^src\/index\.css loads code with @plugin "@\/plugins\/brand" \(line 2\)/],
  ["@plugin through an alias that looks like a package", { "vite.config.js": "import path from 'path'\nexport default { resolve: { alias: { brand: path.resolve(__dirname, 'brand') } } }", "src/index.css": "@plugin \"brand/plugin.js\";\n" }, /^src\/index\.css loads code with @plugin "brand\/plugin\.js" \(line 1\)/],
  ["Less's @plugin", { "src/theme.less": "@plugin \"my-plugin\";\n@x: pi();\n" }, /^src\/theme\.less loads code with Less's @plugin \(line 1\)/],
  ["Less's plugin import", { "src/theme.less": "@w: 1px;\n@import (plugin) \"my-plugin\";\n" }, /^src\/theme\.less loads code with Less's @plugin \(line 2\)/],
  ["Stylus's use()", { "src/theme.styl": "use('plugin.js')\n" }, /^src\/theme\.styl loads code with Stylus's use\(\) \(line 1\)/],
  ["a stylesheet outside src", { "styles/main.css": "@plugin './brand.js';\n" }, /^styles\/main\.css loads code with @plugin "\.\/brand\.js" \(line 1\)/],
  ["a stylesheet that cannot be read", { "src/index.css": null }, /^src\/index\.css exists, but the wizard cannot read it, and Vite builds it/],
  ["more than 200 stylesheets", Object.fromEntries(Array.from({ length: 201 }, (_, i) => [`src/c${i}.module.css`, ".a { color: red }\n"])), /^This app has more than 200 stylesheets, more than the wizard checks/],
  ["Less's javascriptEnabled", { "vite.config.js": "export default { css: { preprocessorOptions: { less: { javascriptEnabled: true } } } }" }, /uses Less's javascriptEnabled in the setting css \(line 1\)/],
  ["a plugin in additionalData", { "vite.config.js": "export default { css: { preprocessorOptions: { less: { additionalData: '@plugin \"./x.js\";' } } } }" }, /uses a stylesheet that loads code in the setting css \(line 1\)/],
  // Lovable's tagger opens its gate, and its module runs, in any mode but production.
  ["Lovable's tagger under --mode development", { "vite.config.ts": LOVABLE, ...scripts({ build: "vite build --mode development" }) }, /uses lovable-tagger with the build mode development \(line 4\)/],
  ["Lovable's tagger under another mode", { "vite.config.ts": LOVABLE, ...scripts({ build: "tsc -b && vite build -m staging" }) }, /uses lovable-tagger with the build mode staging \(line 4\)/],
  // Functions only in server and preview, and only ones that cannot reach the environment or load code.
  ["a server function that reads globalThis", { "vite.config.js": "export default { server: { proxy: { '/api': { target: 'http://localhost:3000', rewrite: (p) => globalThis.x ?? p } } } }" }, /uses the setting server \(line 1\)/],
  ["require in a server function", { "vite.config.js": "export default { server: { proxy: { '/api': { configure: (proxy) => require('./hook.cjs')(proxy) } } } }" }, /uses the setting server \(line 1\)/],
  ["import() in a preview function", { "vite.config.js": "export default { preview: { proxy: { '/api': { configure: () => import('./hook.js') } } } }" }, /uses the setting preview \(line 1\)/],
  ["import.meta in a server function", { "vite.config.js": "export default { server: { proxy: { '/api': { rewrite: () => import.meta.url } } } }" }, /uses the setting server \(line 1\)/],
  ["a getter in server", { "vite.config.js": "export default { server: { get port() { return 3000 } } }" }, /uses the setting server \(line 1\)/],
  ["a function called in server", { "vite.config.js": "export default { server: { port: (() => 3000)() } }" }, /uses the setting server \(line 1\)/],
  ["a function outside server and preview", { "vite.config.js": "export default { build: { rollupOptions: { output: { manualChunks: (id) => (id.includes('node_modules') ? 'vendor' : undefined) } } } }" }, /uses the setting build \(line 1\)/],
  ["a config function that does more than return", { "vite.config.js": "import { defineConfig } from 'vite'\nexport default defineConfig(() => { const base = '/'; return { base } })" }, /uses a config function that does more than return its config \(line 2\)/],
  ["isSsrBuild as a parameter", { "vite.config.js": "import { defineConfig } from 'vite'\nexport default defineConfig(({ isSsrBuild }) => ({ base: '/' }))" }, /uses a config function with parameters other than \{ mode, command \} \(line 2\)/],
  ["command renamed", { "vite.config.js": "import { defineConfig } from 'vite'\nexport default defineConfig(({ command: c }) => ({ base: c === 'build' ? '/a/' : '/' }))" }, /uses a config function with parameters other than \{ mode, command \}/],
  ["mode with a default", { "vite.config.js": "import { defineConfig } from 'vite'\nexport default defineConfig(({ mode = 'x' }) => ({ base: '/' }))" }, /uses a config function with parameters other than \{ mode, command \}/],
  ["an async function without defineConfig", { "vite.config.js": "export default async () => ({ base: '/' })" }, /cannot read vite\.config\.js to the end/],
];
const R5_SAFE = [
  ["now-build that is plain while build is not", scripts({ "now-build": "vite build", build: "node other.mjs" })],
  ["a pre script of a script the build does not run", scripts({ prelint: "node x.mjs", lint: "eslint .", build: "vite build" })],
  ["prepare: husky", scripts({ prepare: "husky", build: "tsc -b && vite build" })],
  ["prepare: husky install", scripts({ prepare: "husky install", build: "vite build" })],
  ["pnpm run and yarn run", scripts({ build: "pnpm run build:web", "build:web": "yarn run build:app", "build:app": "vite build" })],
  [".env files without a $", { ".env": "VITE_API=https://api.example\n# a comment\n", ".env.production": "VITE_FLAG=1\n" }],
  [".env.development with a $ (the build does not read it)", { ".env.development": "VITE_KEY=$PARLOX_SECRET_KEY\n" }],
  ["plugin options the wizard checks", { "vite.config.ts": "import react from '@vitejs/plugin-react'\nimport tailwindcss from '@tailwindcss/vite'\nimport tsconfigPaths from 'vite-tsconfig-paths'\nexport default { plugins: [react({ include: /\\.(mdx|jsx|tsx)$/, jsxImportSource: '@emotion/react', babel: { babelrc: false, configFile: false, plugins: ['babel-plugin-react-compiler'] } }), tailwindcss({ optimize: false }), tsconfigPaths({ root: './', projects: ['./tsconfig.json'] })] }" }],
  ["SWC options", { "vite.config.js": "import react from '@vitejs/plugin-react-swc'\nexport default { plugins: [react({ tsDecorators: true, devTarget: 'es2022' })] }" }],
  ["Lovable's PostCSS config", { "postcss.config.js": "export default {\n  plugins: {\n    tailwindcss: {},\n    autoprefixer: {},\n  },\n}\n" }],
  ["shadcn's PostCSS config", { "postcss.config.mjs": "const config = {\n  plugins: {\n    \"@tailwindcss/postcss\": {},\n  },\n};\n\nexport default config;\n" }],
  ["PostCSS plugins required in a list", { "postcss.config.cjs": "module.exports = {\n  plugins: [require('postcss-import'), require('tailwindcss'), require('autoprefixer')({ grid: 'autoplace' })],\n}\n" }],
  ["PostCSS plugins imported, in TypeScript", { "postcss.config.ts": "import type { Config } from 'postcss-load-config'\nimport nesting from 'postcss-nesting'\nimport autoprefixer from 'autoprefixer'\n\nconst config: Config = { plugins: [nesting({ edition: '2024-02' }), autoprefixer()] }\n\nexport default config\n" }],
  [".postcssrc.json", { ".postcssrc.json": JSON.stringify({ plugins: { autoprefixer: { overrideBrowserslist: ["defaults"] } } }) }],
  [".postcssrc in YAML", { ".postcssrc": "plugins:\n  autoprefixer: {}\n  postcss-nesting: {}\n" }],
  ["package.json's postcss field", { "package.json": pkgJson({ postcss: { plugins: { autoprefixer: {} } } }) }],
  ["a Tailwind config with @tailwindcss plugins", { "tailwind.config.ts": "import type { Config } from 'tailwindcss'\nimport typography from '@tailwindcss/typography'\n\nexport default {\n  darkMode: ['class'],\n  content: ['./index.html', './src/**/*.{ts,tsx}'],\n  theme: { extend: { colors: { border: 'hsl(var(--border))' }, keyframes: { 'accordion-down': { from: { height: '0' }, to: { height: 'var(--radix-accordion-content-height)' } } } } },\n  plugins: [typography, require('@tailwindcss/forms')({ strategy: 'class' })],\n} satisfies Config\n" }],
  ["stylesheets that load no code", { "src/index.css": "@import \"tailwindcss\";\n@plugin \"@tailwindcss/typography\";\n@plugin \"daisyui\" {\n  themes: light --default;\n}\n", "src/theme.scss": "@use 'sass:math';\n.a { width: math.div(1, 2) }\n", "src/x.less": "@w: 10px;\n.a { width: @w }\n", "src/y.styl": "a\n  color red\n", "node_modules/pkg/x.css": "@plugin './x.js';\n", "dist/assets/i.css": "@plugin './x.js';\n" }],
  ["200 stylesheets", Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`src/c${i}.module.css`, ".a { color: red }\n"]))],
  ["Lovable's tagger under --mode production", { "vite.config.ts": LOVABLE, ...scripts({ build: "vite build --mode production" }) }],
  // Friction: shapes the allowlist reads as safe now.
  ["a block body that only returns", { "vite.config.js": "import react from '@vitejs/plugin-react'\nimport { defineConfig } from 'vite'\nexport default defineConfig(() => {\n  return { plugins: [react()] }\n})\n" }],
  ["a block body with { mode }", { "vite.config.js": "import react from '@vitejs/plugin-react'\nimport { defineConfig } from 'vite'\nexport default defineConfig(({ mode }) => {\n  return { plugins: [react(), mode === 'development' && react()].filter(Boolean) }\n})\n" }],
  ["an arrow without defineConfig", { "vite.config.js": "import react from '@vitejs/plugin-react'\nexport default () => ({ plugins: [react()] })\n" }],
  ["a function without defineConfig", { "vite.config.js": "export default function () {\n  return { base: '/shop/' }\n}\n" }],
  ["({ command })", { "vite.config.js": "import react from '@vitejs/plugin-react'\nimport { defineConfig } from 'vite'\nexport default defineConfig(({ command }) => ({ base: command === 'build' ? '/shop/' : '/', plugins: [react()] }))\n" }],
  ["({ mode, command }) with Lovable's tagger", { "vite.config.ts": LOVABLE.replace("({ mode })", "({ mode, command })").replace("port: 8080,", "port: command === 'serve' ? 8080 : 4173,") }],
  ["vite.defineConfig through a namespace import", { "vite.config.js": "import * as vite from 'vite'\nimport react from '@vitejs/plugin-react'\nexport default vite.defineConfig({ plugins: [react()] })\n" }],
  ["TypeScript assertions", { "vite.config.ts": "import react from '@vitejs/plugin-react'\nimport { defineConfig, type PluginOption, type UserConfig } from 'vite'\nexport default defineConfig({\n  plugins: [react()] as PluginOption[],\n  envPrefix: ['VITE_'] as const,\n  server: { port: 5173 as number },\n} satisfies UserConfig)\n" }],
  ["functions in server and preview", { "vite.config.js": "import { defineConfig } from 'vite'\nexport default defineConfig({\n  server: {\n    proxy: {\n      '/api': {\n        target: 'http://localhost:3000',\n        changeOrigin: true,\n        rewrite: (path) => path.replace(/^\\/api/, ''),\n        configure(proxy) { proxy.on('error', (err) => console.log(err)) },\n      },\n    },\n  },\n  preview: { proxy: { '/api': { target: 'http://localhost:3000', bypass: (req) => (req.headers.accept?.includes('html') ? '/index.html' : undefined) } } },\n})\n" }],
  ["tsc --noEmit before the build", scripts({ build: "tsc --noEmit && vite build" })],
  ["tsc --build before the build", scripts({ build: "tsc --build && vite build" })],
  ["tsc -p before the build", scripts({ build: "tsc -p tsconfig.app.json && vite build" })],
  ["tsc -p --noEmit before a build with a mode", scripts({ build: "tsc -p tsconfig.app.json --noEmit && vite build --mode staging" })],
];

test("what else the build reads or runs is not proven safe, each for its reason, and gets no middleware or host step on Vercel", () => {
  for (const [label, files, why] of R5_NOT_SAFE) {
    const s = settingsOf({ "package.json": pkgJson(), ...files });
    assert.ok(s.exposure, `${label}: read as safe`);
    assert.match(s.exposure.why, why, label);
    // On disk too (a file that cannot be read is in memory only).
    if (Object.values(files).includes(null)) continue;
    const d = self(app({ "vercel.json": "{}", ...files }));
    assert.match(d.data.exposure?.why ?? "", why, `${label} (on disk)`);
    assert.equal(d.parts.server.kind, "verify-file", label);
    assert.equal(viteReact.hostStep(d, vercelHost(null)), false, label);
    assert.equal(viteReact.plan(d, input(d.dir, vercelHost(null))).changes.some((c) => c.path.startsWith("middleware.")), false, label);
    assert.ok(d.notes.some((n) => n.startsWith(d.data.exposure.why)), `${label}: the reason in the report`);
  }
});

test("the shapes it must read as safe get the middleware and the host step on Vercel", () => {
  for (const [label, files] of R5_SAFE) {
    assert.equal(settingsOf({ "package.json": pkgJson(), ...files }).exposure, null, label);
    const d = self(app({ "vercel.json": "{}", ...files }));
    assert.equal(d.data.exposure, null, `${label} (on disk)`);
    assert.equal(d.parts.server.kind, "vercel-edge", label);
    assert.equal(viteReact.hostStep(d, vercelHost(null)), true, label);
    assert.ok(viteReact.plan(d, input(d.dir, vercelHost(null))).changes.some((c) => c.path.startsWith("middleware.")), label);
  }
  // The settings are still read through TypeScript's assertions.
  assert.deepEqual(settingsOf({ "vite.config.ts": "export default { envPrefix: ['VITE_'] as const, publicDir: 'static' as string, root: '.' satisfies string }" }), { file: "vite.config.ts", root: ".", envPrefix: ["VITE_"], publicDir: "static", exposure: null });
});

test("in a workspace, the root's install scripts count, and with Vercel set up at the root its build and config too; PostCSS is searched up to the workspace root", () => {
  const mono = (rootFiles, appFiles = {}) => fixture({
    "package.json": JSON.stringify({ name: "mono", private: true, workspaces: ["apps/*"], ...(rootFiles["package.json"] ?? {}) }),
    "package-lock.json": "{}",
    ...Object.fromEntries(Object.entries(rootFiles).filter(([k]) => k !== "package.json")),
    "apps/web/package.json": pkgJson(), "apps/web/index.html": INDEX_HTML, "apps/web/src/main.tsx": MAIN_TSX, ...Object.fromEntries(Object.entries(appFiles).map(([k, v]) => [`apps/web/${k}`, v])),
  });
  const linked = { ".vercel/project.json": JSON.stringify({ projectId: "p", orgId: "o" }) };
  const web = (root) => viteReact.detect(join(root, "apps/web"), root);
  for (const [label, root, why] of [
    ["the root's build, with Vercel linked at the root", mono({ ...linked, "package.json": { scripts: { build: "turbo run build" } } }), /^Vercel builds this app with the "build" script in \.\.\/\.\.\/package\.json \("turbo run build"\), which is not one of the builds the wizard checks/],
    ["the root's vercel.json buildCommand", mono({ ...linked, "vercel.json": JSON.stringify({ buildCommand: "turbo run build --filter web" }) }), /^Vercel builds this app with \.\.\/\.\.\/vercel\.json's buildCommand \("turbo run build --filter web"\)/],
    ["the root's installCommand", mono({ "vercel.json": JSON.stringify({ installCommand: "pnpm install --frozen-lockfile && node gen.mjs" }) }), /^\.\.\/\.\.\/vercel\.json sets installCommand/],
    ["the root's vercel.ts", mono({ ...linked, "vercel.ts": "export const config = {}\n" }), /^Vercel reads \.\.\/\.\.\/vercel\.ts, which the wizard does not check/],
    ["the root's postinstall, wherever Vercel is linked", mono({ "package.json": { scripts: { postinstall: "node gen-env.mjs" } } }, linked), /^\.\.\/\.\.\/package\.json has a "postinstall" script, which runs when Vercel installs the dependencies/],
    ["a PostCSS config at the workspace root", mono({ "postcss.config.js": "module.exports = { plugins: [require('./tools/leak')] }\n" }, linked), /^\.\.\/\.\.\/postcss\.config\.js uses the plugin \.\/tools\/leak \(line 1\)/],
  ]) {
    const d = web(root);
    assert.match(d.data.exposure?.why ?? "", why, label);
    assert.equal(viteReact.hostStep(d, detectHostOf(d)), false, label);
  }
  for (const [label, root] of [
    ["the root's build when the app is linked itself", mono({ "package.json": { scripts: { build: "turbo run build" } } }, linked)],
    ["the app's own PostCSS config comes first", mono({ "postcss.config.js": "module.exports = { plugins: [require('./tools/leak')] }\n" }, { ...linked, "postcss.config.js": "export default { plugins: { autoprefixer: {} } }\n" })],
  ]) {
    const d = web(root);
    assert.equal(d.data.exposure, null, label);
    assert.equal(viteReact.hostStep(d, detectHostOf(d)), true, label);
  }
});

// tailwindcss-animate, which Lovable's projects add, is allowed beside @tailwindcss/* (1.0.7: its
// only require is tailwindcss/plugin; no process or env).
test("Lovable's Tailwind config with tailwindcss-animate reads as safe; a relative require beside it does not", () => {
  const LOVABLE_TAILWIND = (plugins, head = "") => `import type { Config } from "tailwindcss";\n${head}\nexport default {\n\tdarkMode: ["class"],\n\tcontent: ["./pages/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}", "./app/**/*.{ts,tsx}", "./src/**/*.{ts,tsx}"],\n\tprefix: "",\n\ttheme: {\n\t\tcontainer: { center: true, padding: '2rem', screens: { '2xl': '1400px' } },\n\t\textend: {\n\t\t\tcolors: { border: 'hsl(var(--border))', primary: { DEFAULT: 'hsl(var(--primary))', foreground: 'hsl(var(--primary-foreground))' } },\n\t\t\tborderRadius: { lg: 'var(--radius)', md: 'calc(var(--radius) - 2px)' },\n\t\t\tkeyframes: { 'accordion-down': { from: { height: '0' }, to: { height: 'var(--radix-accordion-content-height)' } } },\n\t\t\tanimation: { 'accordion-down': 'accordion-down 0.2s ease-out' }\n\t\t}\n\t},\n\tplugins: [${plugins}],\n} satisfies Config;\n`;
  const lovable = (tailwind) => ({ "vite.config.ts": LOVABLE, "postcss.config.js": "export default {\n  plugins: {\n    tailwindcss: {},\n    autoprefixer: {},\n  },\n}\n", "tailwind.config.ts": tailwind, ...scripts({ dev: "vite", build: "vite build", "build:dev": "vite build --mode development", lint: "eslint .", preview: "vite preview" }) });
  for (const [label, tailwind] of [
    ["require(\"tailwindcss-animate\")", LOVABLE_TAILWIND('require("tailwindcss-animate")')],
    ["import animate from \"tailwindcss-animate\"", LOVABLE_TAILWIND("animate", 'import animate from "tailwindcss-animate";')],
  ]) {
    assert.equal(settingsOf({ "package.json": pkgJson(), ...lovable(tailwind) }).exposure, null, label);
    const d = self(app({ "vercel.json": "{}", ...lovable(tailwind) }));
    assert.equal(d.data.exposure, null, `${label} (on disk)`);
    assert.equal(d.parts.server.kind, "vercel-edge", label);
    assert.equal(viteReact.hostStep(d, vercelHost(null)), true, label);
  }
  const relative = settingsOf({ "package.json": pkgJson(), ...lovable(LOVABLE_TAILWIND('require("tailwindcss-animate"), require("./plugins/brand")')) });
  assert.match(relative.exposure?.why ?? "", /^tailwind\.config\.ts uses the plugin \.\/plugins\/brand \(line 16\), which the wizard does not check, and Tailwind runs it when Vite builds/);
});

// The plain builds the guard vouches for also take, each once and literal: --outDir <folder> (inside the project) and
// --base <path> (where the build is served: neither changes what goes into the bundle), and --emptyOutDir; and a script
// reached through `bun run <script>`, which runs that script with its pre and post scripts as npm does.
test("plain builds: literal --outDir, --base and --emptyOutDir beside --mode, and bun run <script>; look-alikes are not plain", () => {
  for (const [label, s] of [
    ["--outDir <folder>", { build: "vite build --outDir build" }],
    ["--outDir=<folder> and --emptyOutDir after tsc", { build: "tsc -b && vite build --outDir=dist/client --emptyOutDir" }],
    ["--base <path>", { build: "vite build --base /shop/" }],
    ["--base=./", { build: "vite build --base=./" }],
    ["all four, in any order", { build: "vite build --emptyOutDir --base / --outDir www --mode staging" }],
    ["bun run <script>", { build: "bun run build:web", "build:web": "vite build --outDir dist" }],
  ]) {
    assert.equal(settingsOf({ "package.json": pkgJson({ scripts: s }) }).exposure, null, label);
    assert.equal(self(app({ "vercel.json": "{}", "package.json": pkgJson({ scripts: s }) })).parts.server.kind, "vercel-edge", label);
  }
  // The mode is still read beside the other options: its .env file is checked.
  const staged = settingsOf({ "package.json": pkgJson({ scripts: { build: "vite build --outDir www --mode staging" } }), ".env.staging": "VITE_KEY=$PARLOX_SECRET_KEY\n" });
  assert.match(staged.exposure?.why ?? "", /^\.env\.staging has a \$ \(line 1\)/);
  for (const [label, build] of [
    ["--outDir=$(x)", "vite build --outDir=$(x)"],
    ["--base ../", "vite build --base ../"],
    ["--outDir above the project", "vite build --outDir ../public"],
    ["--outDir with a .. inside", "vite build --outDir dist/../../out"],
    ["--outDir absolute", "vite build --outDir /tmp/out"],
    ["--outDir twice", "vite build --outDir a --outDir b"],
    ["--outDir with no value", "vite build --outDir"],
    ["--outDir followed by an option", "vite build --outDir --emptyOutDir"],
    ["--out-dir", "vite build --out-dir dist"],
    ["--emptyOutDir false", "vite build --emptyOutDir false"],
    ["--emptyOutDir twice", "vite build --emptyOutDir --emptyOutDir"],
    ["--base from a variable", "vite build --base $BASE"],
    ["--base with a quote", "vite build --base '/shop/'"],
    ["--mode that looks like an option", "vite build --mode -x"],
    ["another option", "vite build --outDir dist --sourcemap"],
    ["bun run with an option", "bun run --bun build:web"],
    ["bun x", "bunx vite build"],
  ]) {
    const scripts = { build, "build:web": "vite build" };
    const s = settingsOf({ "package.json": pkgJson({ scripts }) });
    assert.ok(s.exposure, `${label}: read as plain`);
    assert.equal(self(app({ "vercel.json": "{}", "package.json": pkgJson({ scripts }) })).parts.server.kind, "verify-file", label);
  }
});

// Bun loads .env, .env.<NODE_ENV>, .env.local and .env.<NODE_ENV>.local by itself, for NODE_ENV production,
// development or test, and expands $NAME in them (bun.com/docs/runtime/environment-variables, opened 2026-10-02); Vite
// then keeps the VITE_ variables it finds in the environment. A build reached through `bun run`, in a command or as
// Vercel runs the build script with a project's Bun, has every one of those files checked for a $, as Vite's own are.
test("a build reached through bun run: every .env file Bun loads is checked for a $, whatever NODE_ENV the host gives the build", () => {
  const LEAK = "VITE_API=https://api.example\nVITE_KEY=$PARLOX_SECRET_KEY\n";
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const name of [".env.development", ".env.test", ".env.development.local", ".env.test.local"]) {
    const bunWhy = new RegExp(`^${esc(name)} has a \\$ \\(line 2\\): Bun expands \\$NAME in the \\.env files it loads, from the build's environment, which holds the secret key on Vercel, and Vite keeps the VITE_ variables it finds there, so the key could reach the browser code\\.`);
    const viaRun = settingsOf({ "package.json": pkgJson({ scripts: { build: "bun run build:web", "build:web": "vite build" } }), [name]: LEAK });
    assert.match(viaRun.exposure?.why ?? "", bunWhy, `${name}, bun run in the build script`);
    assert.match(viaRun.exposure?.fix ?? "", new RegExp(`^remove the \\$ from ${esc(name)}`), name);
    const viaVercelJson = settingsOf({ "package.json": pkgJson({ scripts: { "build:web": "vite build" } }), "vercel.json": JSON.stringify({ buildCommand: "bun run build:web" }), [name]: LEAK });
    assert.match(viaVercelJson.exposure?.why ?? "", bunWhy, `${name}, vercel.json's buildCommand`);
    // Vercel runs the "build" script with the project's package manager: Bun, by its lockfile or packageManager.
    for (const [label, files] of [["bun.lock", { "bun.lock": "{}" }], ["bun.lockb", { "bun.lockb": "" }], ["packageManager", { "package.json": pkgJson({ packageManager: "bun@1.3.0", scripts: { build: "vite build" } }) }]]) {
      const viaPm = settingsOf({ "package.json": pkgJson({ scripts: { build: "vite build" } }), ...files, [name]: LEAK });
      assert.match(viaPm.exposure?.why ?? "", bunWhy, `${name}, ${label}`);
    }
    // npm runs the build: only Vite reads .env files, and a production build does not read this one.
    assert.equal(settingsOf({ "package.json": pkgJson({ scripts: { build: "vite build" } }), "package-lock.json": "{}", [name]: LEAK }).exposure, null, `${name} with npm`);
  }
  // A Bun lockfile at the workspace root counts for the app below it.
  const below = settingsOf({ "package.json": pkgJson({ scripts: { build: "vite build" } }), "../../bun.lock": "{}", ".env.development": LEAK }, { workspace: { root: "../..", vercel: false, app: "apps/web" } });
  assert.match(below.exposure?.why ?? "", /^\.env\.development has a \$ \(line 2\): Bun expands/);
  // Without a $, the same files are fine; one that is there but cannot be read is not.
  assert.equal(settingsOf({ "package.json": pkgJson({ scripts: { build: "bun run build:web", "build:web": "vite build" } }), ".env.test": "VITE_API=https://api.example\n" }).exposure, null);
  const unread = settingsOf({ "package.json": pkgJson({ scripts: { build: "vite build" } }), "bun.lock": "{}", ".env.test.local": null });
  assert.match(unread.exposure?.why ?? "", /^\.env\.test\.local exists, but the wizard cannot read it, and Bun loads it when it runs the build/);
  // On disk, beside a vercel.json: the middleware is not added.
  const dir = app({ "vercel.json": "{}", "bun.lock": "{}", ".env.development": LEAK });
  rmSync(join(dir, "package-lock.json"));
  assert.equal(self(dir).parts.server.kind, "verify-file");
});
