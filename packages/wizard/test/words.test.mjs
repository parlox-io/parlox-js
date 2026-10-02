import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createElement } from "react";
import { render } from "ink-testing-library";
import { App } from "../dist/tui/App.js";
import { WizardStore } from "../dist/tui/store.js";
import { start } from "../dist/start.js";
import { main } from "../dist/cli.js";
import { scanApps } from "../dist/apps.js";
import { handoffUrl } from "../dist/hosts.js";
import { viteReact } from "../dist/integrations/vite-react.js";
import { startFakeAuth, startFakeGateway } from "./fake-servers.mjs";
import { fixture, pkg, read } from "./helpers.mjs";

// The words people read: the welcome screen, the no-terminal refusal, the report's title, the held-back key warning,
// the hand-off link and the uninstall report.

const PK = "pk_" + "a1".repeat(12);
const never = () => { throw new Error("nothing should run"); };

test("welcome: the first step names the stacks the wizard installs into", () => {
  const { lastFrame, unmount } = render(createElement(App, { store: new WizardStore() }));
  assert.match(lastFrame().replace(/\s+/g, " "), /1 Find your apps: Next\.js, Vite React, Express, Hono/);
  unmount();
});

test("welcome: with --local-key, the promise stays on one row of the panel at 100 columns", () => {
  const { lastFrame, unmount } = render(createElement(App, { store: new WizardStore(), localKey: true }));
  const row = lastFrame().split("\n").find((l) => l.includes("--local-key"));
  assert.ok(row, lastFrame());
  assert.match(row, /✔ puts a key for crawler reports only in your local env file, because you asked \(--local-key\)/);
  unmount();
});

class Out extends EventEmitter {
  constructor() { super(); this.isTTY = false; this.columns = 120; this.rows = 40; this.chunks = []; }
  write(d, cb) { this.chunks.push(String(d)); if (typeof cb === "function") cb(); return true; }
  get text() { return this.chunks.join(""); }
}
class In extends EventEmitter {
  constructor() { super(); this.isTTY = false; }
  setEncoding() {} setRawMode() {} resume() {} pause() {} ref() {} unref() {}
}

test("no terminal and no --yes: the refusal says how to choose a monorepo's apps (--app), before anything runs", async () => {
  const stdout = new Out();
  assert.equal(await start([], { run: never, open: never }, { stdout, stdin: new In(), env: {} }), 1);
  assert.match(stdout.text, /^No terminal to answer questions in\. /);
  assert.match(stdout.text, /in a monorepo, run it from the app's own folder or pass --app <folder> for each app to include\./);
});

// An app that already reports to Parlox with its own code: nothing of the wizard's is added.
const OWN_APP = [
  'import express from "express";',
  "",
  "const app = express();",
  "app.use((req, res, next) => {",
  '  res.on("finish", () => { fetch("https://gateway.parlox.io/v1/s", { method: "POST", headers: { authorization: `Bearer ${process.env.PARLOX_SECRET_KEY}` } }).catch(() => {}); });',
  "  next();",
  "});",
  "",
].join("\n");

test("an app that reports with its own code and gets nothing added: the title does not say Parlox is installed, and the report ends with what to do next, not with deploying", async (t) => {
  const auth = await startFakeAuth({ decide: "approve" });
  const gw = await startFakeGateway({ sites: [{ id: "11111111-1111-1111-1111-111111111111", name: "Shop", domain: "shop.example.com", public_key: PK, verified: false }], keys: [] });
  t.after(() => { auth.close(); gw.close(); });
  const dir = fixture({
    "package.json": JSON.stringify({ name: "shop", type: "module", scripts: { start: "node src/app.mjs" }, dependencies: { express: "^5.1.0" } }),
    "package-lock.json": "{}", "src/app.mjs": OWN_APP,
  });
  const out = [];
  const reports = [];
  const ui = { info: (m) => out.push(m), warn: (m) => out.push(`WARN ${m}`), confirm: async () => true, select: async (_m, o) => o[0].value, text: async () => "", report: (lines, title) => reports.push({ lines, title }) };
  const config = { gateway: gw.url, supabaseUrl: auth.url, clientId: "wiz", apiKey: "test-publishable-key", ports: [53852, 53853], dashboard: "https://app.parlox.io" };
  const deps = { cwd: dir, config, ui, open: (url) => { fetch(url).catch(() => {}); }, run: never };
  assert.equal(await main(["--yes", "--allow-no-git", "--site", "shop.example.com", "--skip-check"], deps), 0, out.join("\n"));
  assert.ok(out.includes("Nothing to change."), out.join("\n"));
  assert.equal(reports.length, 1);
  assert.equal(reports[0].title, "Nothing was added to your code");
  const lines = reports[0].lines;
  assert.ok(lines.some((l) => l.startsWith("This app already reports to Parlox with its own code (src/app.mjs:5).")), lines.join("\n"));
  assert.equal(lines.at(-1), "Next: remove that code, then run the wizard again.", lines.join("\n"));
  for (const left of [/^Ownership of /, /^Visits on preview or staging URLs/, /^Next: deploy/, /^  https:\/\/app\.parlox\.io$/]) assert.equal(lines.some((l) => left.test(l)), false, `${left}: ${lines.join("\n")}`);
  assert.deepEqual(gw.state.keys, [], "no key");
});

// A server part held back beside a Vite build the wizard cannot prove safe: the warning says what the wizard read.
// It says that Vercel builds or installs the app only where the wizard detected Vercel as the host.
const SERVER = "import express from 'express'\n\nconst app = express()\napp.use(express.static('dist'))\napp.listen(3000)\n";
const withVite = (scripts, extra = {}, react = false) => fixture({
  "package.json": JSON.stringify({ name: "shop", type: "module", scripts: { start: "node server.js", ...scripts }, dependencies: { express: "^5.1.0", ...(react ? { react: "^19.2.0", "react-dom": "^19.2.0" } : {}) }, devDependencies: { vite: "^7.2.0" } }),
  "package-lock.json": "{}", "server.js": SERVER,
  ...(react ? { "index.html": '<!doctype html>\n<html>\n  <head></head>\n  <body>\n    <div id="root"></div>\n    <script type="module" src="/src/main.jsx"></script>\n  </body>\n</html>\n', "src/main.jsx": "import { createRoot } from 'react-dom/client'\n" } : {}),
  ...extra,
});
const withheld = (dir) => {
  const [u] = scanApps(dir).units;
  assert.equal(u.server, null, "no server part");
  const w = u.warnings.find((x) => x.startsWith("Express: no server part was added."));
  assert.ok(w, u.warnings.join("\n"));
  return w;
};
const OFF_VERCEL = { render: { "render.yaml": "services: []\n" }, netlify: { "netlify.toml": "" }, fly: { "fly.toml": "" }, "no host file": {} };
const ON_VERCEL = { vercel: { "vercel.json": "{}" }, "a Vercel link": { ".vercel/project.json": "{}" } };

test("held back beside a Vite build: off Vercel (another host, or none detected) the warning never names Vercel; on Vercel it says what Vercel runs", () => {
  const cases = [
    ["an npm hook beside the build", { prebuild: "node gen.mjs", build: "vite build" }, false,
      /^Express: no server part was added\. The build may run the "build" script \("vite build"\), and npm also runs the "prebuild" script with it, which the wizard does not check, so the wizard cannot prove that the build keeps the secret key out of the browser code\. /,
      /^Express: no server part was added\. Vercel builds this app with the "build" script \("vite build"\), and npm also runs the "prebuild" script with it/],
    ["a build the wizard does not check, Vite React beside Express", { build: "vite build && node copy.mjs" }, true,
      /^Express: no server part was added\. The build may run the "build" script \("vite build && node copy\.mjs"\), which is not one of the builds the wizard checks \(vite build, alone or after tsc, optionally with --mode <name>, --outDir <folder>, --base <path> or --emptyOutDir\), so the wizard cannot prove/,
      /^Express: no server part was added\. Vercel builds this app with the "build" script \("vite build && node copy\.mjs"\), which is not one of the builds the wizard checks/],
    ["an install script", { postinstall: "node gen.mjs", build: "vite build" }, false,
      /^Express: no server part was added\. package\.json has a "postinstall" script, which runs when the dependencies are installed, and the wizard does not check it, so the wizard cannot prove/,
      /^Express: no server part was added\. package\.json has a "postinstall" script, which runs when Vercel installs the dependencies/],
    ["a $ in a .env file Vite loads", { build: "vite build" }, false,
      /^Express: no server part was added\. \.env has a \$ \(line 1\): Vite expands \$NAME in \.env values from the build's environment, which holds the secret key when the host gives the build its variables, before it keeps the VITE_ variables/,
      /^Express: no server part was added\. \.env has a \$ \(line 1\): Vite expands \$NAME in \.env values from the build's environment, which holds the secret key on Vercel, before/,
      { ".env": "VITE_A=$HOME\n" }],
    ["a Vercel config file the wizard does not read", { build: "vite build" }, false,
      /^Express: no server part was added\. vercel\.ts is a build configuration file the wizard does not check, so the wizard cannot prove/,
      /^Express: no server part was added\. Vercel reads vercel\.ts, which the wizard does not check/,
      { "vercel.ts": "export const config = {}\n" }],
  ];
  for (const [label, scripts, react, off, on, more = {}] of cases) {
    for (const [host, files] of Object.entries(OFF_VERCEL)) {
      const w = withheld(withVite(scripts, { ...files, ...more }, react));
      assert.match(w, off, `${label}, ${host}`);
      assert.doesNotMatch(w, /Vercel/, `${label}, ${host}`);
    }
    for (const [host, files] of Object.entries(ON_VERCEL)) assert.match(withheld(withVite(scripts, { ...files, ...more }, react)), on, `${label}, ${host}`);
  }
});

// A Vite React site whose build the wizard does not check: its own note, and the --local-key warning.
const UNCHECKED = { build: "vite build && node copy.mjs" };
const viteSite = (files = {}) => fixture({
  "package.json": JSON.stringify({ name: "shop", type: "module", scripts: { dev: "vite", ...UNCHECKED }, dependencies: { react: "^19.2.0", "react-dom": "^19.2.0" }, devDependencies: { vite: "^7.2.0" } }),
  "package-lock.json": "{}",
  "index.html": '<!doctype html>\n<html>\n  <head></head>\n  <body>\n    <div id="root"></div>\n    <script type="module" src="/src/main.jsx"></script>\n  </body>\n</html>\n',
  "src/main.jsx": "import { createRoot } from 'react-dom/client'\nimport App from './App.jsx'\n\ncreateRoot(document.getElementById('root')).render(<App />)\n",
  ...files,
});
const BUILD_MAY_RUN = /^The build may run the "build" script \("vite build && node copy\.mjs"\), which is not one of the builds the wizard checks/;

test("Vite React with no host file: the note on the missing middleware never names Vercel as the builder; on Vercel it does", () => {
  const none = viteSite();
  const d = viteReact.detect(none, none);
  assert.equal(d.notes.length, 1, d.notes.join("\n"));
  assert.match(d.notes[0], BUILD_MAY_RUN);
  assert.doesNotMatch(d.notes[0], /Vercel/);
  const on = viteSite({ "vercel.json": "{}" });
  assert.match(viteReact.detect(on, on).notes[0], /^Vercel builds this app with the "build" script \("vite build && node copy\.mjs"\)/);
});

test("--local-key on Render beside a Vite build the wizard does not check: the warning says why without naming Vercel", async (t) => {
  const auth = await startFakeAuth({ decide: "approve" });
  const gw = await startFakeGateway({ sites: [{ id: "11111111-1111-1111-1111-111111111111", name: "Shop", domain: "shop.example.com", public_key: PK, verified: false }], keys: [] });
  t.after(() => { auth.close(); gw.close(); });
  const config = { gateway: gw.url, supabaseUrl: auth.url, clientId: "wiz", apiKey: "test-publishable-key", ports: [53852, 53853], dashboard: "https://app.parlox.io" };
  const run = async (files) => {
    const out = [];
    const ui = { info: (m) => out.push(m), warn: (m) => out.push(`WARN ${m}`), confirm: async () => true, select: async (_m, o) => o[0].value, text: async () => "" };
    const deps = { cwd: viteSite(files), config, ui, open: (url) => { fetch(url).catch(() => {}); }, run: () => ({ status: 0, stdout: "", stderr: "" }) };
    assert.equal(await main(["--yes", "--allow-no-git", "--no-vercel", "--local-key", "--site", "shop.example.com", "--skip-check"], deps), 0, out.join("\n"));
    const w = out.find((m) => m.startsWith("WARN No local key: "));
    assert.ok(w, out.join("\n"));
    return w.slice("WARN No local key: ".length);
  };
  const render = await run({ "render.yaml": "services: []\n" });
  assert.match(render, BUILD_MAY_RUN);
  assert.doesNotMatch(render, /Vercel/);
  assert.match(await run({ "vercel.json": "{}" }), /^Vercel builds this app with the "build" script/);
  assert.deepEqual(gw.state.keys, [], "no key");
});

test("the hand-off link asks the dashboard's key form for a key that can only send crawler reports (scope=fetch)", () => {
  const netlify = { id: "netlify", label: "Netlify", where: "", docs: null, vercelDir: null };
  const url = new URL(handoffUrl("https://app.parlox.io", "s1", netlify));
  assert.equal(url.searchParams.get("scope"), "fetch");
  assert.equal(url.searchParams.get("newKey"), "Netlify · production");
  assert.equal(url.hash, "#keys");
});

test("uninstall leaves .gitignore as it is and says so, naming the env file it took Parlox's lines out of", async () => {
  const layout = "export default function RootLayout({ children }) {\n  return (\n    <html>\n      <body>{children}</body>\n    </html>\n  );\n}\n";
  const dir = fixture({ "package.json": pkg(), "package-lock.json": "{}", "app/layout.tsx": layout, ".env.local": "OTHER=1\nPARLOX_VERIFY_TOKEN=vt_abc\n", ".gitignore": "node_modules\n.env.local\n" });
  const reports = [];
  // No sign-in happens in an uninstall; the config only has to be a real one (not the placeholder build).
  const config = { gateway: "http://127.0.0.1:9", supabaseUrl: "http://127.0.0.1:9", clientId: "wiz", apiKey: "k", ports: [53852, 53853], dashboard: "https://app.parlox.io" };
  const ui = { info: () => {}, warn: () => {}, confirm: async () => true, select: async (_m, o) => o[0].value, text: async () => "", report: (lines, title) => reports.push({ lines, title }) };
  assert.equal(await main(["uninstall", "--yes", "--allow-no-git"], { cwd: dir, config, ui, open: never, run: () => ({ status: 0, stdout: "", stderr: "" }) }), 0);
  assert.equal(read(dir, ".env.local"), "OTHER=1\n");
  assert.equal(read(dir, ".gitignore"), "node_modules\n.env.local\n", ".gitignore untouched");
  assert.equal(reports.at(-1).title, "Parlox is removed");
  assert.ok(reports.at(-1).lines.includes(".gitignore was not changed: any line the install added there to keep .env.local out of git stays."), reports.at(-1).lines.join("\n"));
  // Nothing in an env file to take out: nothing is said about .gitignore.
  const none = fixture({ "package.json": pkg({ next: "16.0.1", react: "19.0.0", "@parlox/browser": "1.0.3" }), "package-lock.json": "{}", "app/layout.tsx": layout });
  reports.length = 0;
  assert.equal(await main(["uninstall", "--yes", "--allow-no-git"], { cwd: none, config, ui, open: never, run: () => ({ status: 0, stdout: "", stderr: "" }) }), 0);
  assert.equal(reports.at(-1).lines.some((l) => l.includes(".gitignore")), false, reports.at(-1).lines.join("\n"));
});
