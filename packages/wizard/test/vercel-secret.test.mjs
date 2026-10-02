import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { main } from "../dist/cli.js";
import { startFakeAuth, startFakeGateway } from "./fake-servers.mjs";
import { fixture, pkg } from "./helpers.mjs";

// PARLOX_SECRET_KEY on Vercel: stored as a Secret (`--visibility secret`, Vercel's Config and Secret types) when the
// installed Vercel CLI offers it, read once from `vercel env add --help`; otherwise as sensitive, as before. The report
// says which. A key already set there is one the wizard cannot see: on a static Vite site the report asks to check
// that it can only send crawler reports.

const layout = `export default function RootLayout({ children }) {\n  return (\n    <html>\n      <body>{children}</body>\n    </html>\n  );\n}\n`;
const SITE = { id: "11111111-1111-1111-1111-111111111111", name: "Shop", domain: "shop.example.com", public_key: "pk_" + "a1".repeat(12), verified: false };
const G = ["-c", "user.email=t@t", "-c", "user.name=t"];
const gitInit = (dir) => { execFileSync("git", [...G, "init", "-q"], { cwd: dir }); execFileSync("git", [...G, "add", "-A"], { cwd: dir }); execFileSync("git", [...G, "commit", "-qm", "init"], { cwd: dir }); };
// As Vercel CLI 59.1.3 prints it: on stderr, with exit code 2.
const HELP = "\n  ▲ vercel env add name [environment] [options]\n\n  Options:\n\n       --sensitive                Store the value as sensitive for Production or     \n                                  Preview                                            \n       --visibility <VISIBILITY>  Set config/secret visibility (`config` or          \n                                  `secret`). Inferred from type when omitted and     \n";
const OLD_HELP = "\n  ▲ vercel env add name [environment] [options]\n\n  Options:\n\n       --sensitive                Store the value as sensitive for Production or     \n";

async function env(t) {
  const auth = await startFakeAuth({ decide: "approve" });
  const gw = await startFakeGateway({ sites: [{ ...SITE }], keys: [] });
  t.after(() => { auth.close(); gw.close(); });
  const config = { gateway: gw.url, supabaseUrl: auth.url, clientId: "wiz", apiKey: "test-publishable-key", ports: [53902, 53903], dashboard: "https://app.parlox.io" };
  return { gw, start: async (dir, argv, { help = "", listing = "" } = {}) => {
    const runs = [], out = [], reports = [];
    const run = (cmd, args, opts) => {
      runs.push({ cmd, args, cwd: opts.cwd });
      if (cmd === "vercel" && args.join(" ") === "env add --help") return { status: 2, stdout: "", stderr: help };
      if (cmd === "vercel" && args[1] === "ls") return { status: 0, stdout: listing, stderr: "" };
      return { status: 0, stdout: "", stderr: "" };
    };
    const ui = { info: (m) => out.push(m), warn: (m) => out.push(`WARN ${m}`), confirm: async () => true, select: async (_m, o) => o[0].value, text: async () => "", multiselect: async (_m, o) => o.map((x) => x.value), report: (lines) => reports.push(...lines) };
    const code = await main(argv, { cwd: dir, config, ui, run, open: (u) => { if (!u.includes("newKey")) fetch(u).catch(() => {}); } });
    return { code, runs, out, reports };
  } };
}
const nextApp = (extra = {}) => { const dir = fixture({ "package.json": pkg(), "package-lock.json": "{}", "app/layout.tsx": layout, ".vercel/project.json": JSON.stringify({ projectName: "shop-prod" }), ".gitignore": ".vercel\n.env*.local\n", ...extra }); gitInit(dir); return dir; };
const adds = (runs) => runs.filter((r) => r.cmd === "vercel" && r.args[0] === "env" && r.args[1] === "add" && r.args[2] !== "--help").map((r) => r.args.slice(2));
const ARGS = ["--yes", "--vercel", "--site", "shop.example.com", "--skip-check"];

test("a Vercel CLI with --visibility: the key is stored as a Secret, the token as a normal variable, and the report says so", async (t) => {
  const { start } = await env(t);
  const r = await start(nextApp(), ARGS, { help: HELP });
  assert.equal(r.code, 0, r.out.join("\n"));
  assert.deepEqual(adds(r.runs), [["PARLOX_SECRET_KEY", "production", "--visibility", "secret"], ["PARLOX_VERIFY_TOKEN", "production"]]);
  assert.ok(r.out.some((m) => m.includes('Vercel "shop-prod": PARLOX_SECRET_KEY set (Secret: no one on the team can read it back), PARLOX_VERIFY_TOKEN set.')), r.out.join("\n"));
  const line = r.reports.find((l) => l.startsWith("PARLOX_SECRET_KEY is stored on Vercel as a Secret"));
  assert.ok(line && /your deployments and builds still receive it/.test(line), r.reports.join("\n"));
  assert.equal(r.reports.some((l) => /keeps? .*out of the build/.test(l)), false, "no claim that it keeps the key out of the build");
});

test("a Vercel CLI without --visibility: the key is stored as sensitive, as before, and the report says so", async (t) => {
  const { start } = await env(t);
  const r = await start(nextApp(), ARGS, { help: OLD_HELP });
  assert.equal(r.code, 0, r.out.join("\n"));
  assert.deepEqual(adds(r.runs), [["PARLOX_SECRET_KEY", "production", "--sensitive"], ["PARLOX_VERIFY_TOKEN", "production"]]);
  assert.ok(r.reports.some((l) => l.startsWith("PARLOX_SECRET_KEY is stored on Vercel as sensitive (--sensitive: this Vercel CLI has no --visibility option)")), r.reports.join("\n"));
});

test("the help is read once per run, however many apps are set on Vercel", async (t) => {
  const { start } = await env(t);
  const root = fixture({
    "package.json": JSON.stringify({ name: "mono", private: true, workspaces: ["apps/*"] }), "package-lock.json": "{}", ".gitignore": ".vercel\n.env*.local\n",
    "apps/web/package.json": pkg(), "apps/web/app/layout.tsx": layout, "apps/web/.vercel/project.json": JSON.stringify({ projectName: "web" }),
    "apps/shop/package.json": pkg(), "apps/shop/app/layout.tsx": layout, "apps/shop/.vercel/project.json": JSON.stringify({ projectName: "shop" }),
  });
  gitInit(root);
  const r = await start(root, ARGS, { help: HELP });
  assert.equal(r.code, 0, r.out.join("\n"));
  assert.equal(r.runs.filter((x) => x.args.join(" ") === "env add --help").length, 1);
  assert.equal(adds(r.runs).filter((a) => a[0] === "PARLOX_SECRET_KEY" && a.includes("--visibility")).length, 2);
});

// A static Vite site whose middleware the wizard sets on Vercel.
const MAIN = "import { createRoot } from 'react-dom/client'\nimport App from './App.tsx'\n\ncreateRoot(document.getElementById('root')!).render(<App />)\n";
const viteApp = () => {
  const dir = fixture({
    "package.json": JSON.stringify({ name: "shop", type: "module", scripts: { build: "vite build" }, dependencies: { react: "^19.2.8", "react-dom": "^19.2.8" }, devDependencies: { vite: "^8.3.0", "@vitejs/plugin-react": "^6.1.1" } }),
    "package-lock.json": "{}", "tsconfig.json": "{}", ".gitignore": ".vercel\n",
    "index.html": '<!doctype html>\n<html>\n  <body>\n    <div id="root"></div>\n    <script type="module" src="/src/main.tsx"></script>\n  </body>\n</html>\n',
    "src/main.tsx": MAIN, ".vercel/project.json": JSON.stringify({ projectName: "shop-prod" }),
  });
  gitInit(dir);
  return dir;
};

test("a key already set on a static Vite site's Vercel project: the report asks to check that it is crawler-only", async (t) => {
  const { gw, start } = await env(t);
  const r = await start(viteApp(), ARGS, { help: HELP, listing: " PARLOX_SECRET_KEY  Encrypted  Production\n" });
  assert.equal(r.code, 0, r.out.join("\n"));
  assert.deepEqual(gw.state.keys, [], "no key was created");
  const line = r.reports.find((l) => l.startsWith("PARLOX_SECRET_KEY was already set on Vercel"));
  assert.ok(line && line.includes('check in Settings → Keys that this key is "Crawler reports only"'), r.reports.join("\n"));
  // A server app whose key no build reads: nothing to check.
  const n = await start(nextApp(), ARGS, { help: HELP, listing: " PARLOX_SECRET_KEY  Encrypted  Production\n" });
  assert.equal(n.reports.some((l) => l.startsWith("PARLOX_SECRET_KEY was already set on Vercel")), false, n.reports.join("\n"));
});

// An Express or Hono server beside a Vite build in its folder (the case the Vite guard checks): a build there can read
// the project's variables as well, so a key already set is one to check, as on a static Vite site.
const VITE_SAFE = "import { defineConfig } from 'vite'\n\nexport default defineConfig({})\n";
const LINKED = { ".vercel/project.json": JSON.stringify({ projectName: "shop-prod" }), ".gitignore": ".vercel\n", "package-lock.json": "{}" };
const besideVite = (deps, server) => {
  const dir = fixture({
    "package.json": JSON.stringify({ name: "shop", type: "module", scripts: { build: "vite build", start: "node server.js" }, dependencies: deps, devDependencies: { vite: "^8.3.0" } }),
    "vite.config.js": VITE_SAFE, "index.html": "<!doctype html>\n<html>\n  <head></head>\n  <body></body>\n</html>\n", ...server, ...LINKED,
  });
  gitInit(dir);
  return dir;
};
const EXPRESS_SERVER = { "server.js": "import express from 'express'\n\nconst app = express()\napp.use(express.static('dist'))\napp.listen(3000)\n" };
const HONO_SERVER = { "src/index.ts": "import { serve } from '@hono/node-server'\nimport { Hono } from 'hono'\n\nconst app = new Hono()\napp.get('/api/hello', (c) => c.json({ ok: true }))\n\nserve({ fetch: app.fetch, port: 3000 })\n" };

test("a key already set on Vercel for an Express or Hono server beside a Vite build in its folder: the report asks to check that it is crawler-only", async (t) => {
  const { gw, start } = await env(t);
  const LISTING = " PARLOX_SECRET_KEY  Encrypted  Production\n";
  for (const [label, dir] of [["Express", besideVite({ express: "^5.1.0" }, EXPRESS_SERVER)], ["Hono", besideVite({ hono: "^4.13.11", "@hono/node-server": "^2.1.3" }, HONO_SERVER)]]) {
    const r = await start(dir, ARGS, { help: HELP, listing: LISTING });
    assert.equal(r.code, 0, `${label}: ${r.out.join("\n")}`);
    assert.ok(r.reports.some((l) => l.startsWith("Server part:")), `${label}: the server part is planned\n${r.reports.join("\n")}`);
    const line = r.reports.find((l) => l.startsWith("PARLOX_SECRET_KEY was already set on Vercel"));
    assert.ok(line && line.includes('check in Settings → Keys that this key is "Crawler reports only"'), `${label}: ${r.reports.join("\n")}`);
  }
  assert.deepEqual(gw.state.keys, [], "no key was created");
  // An Express server with no Vite build in its folder: no build there reads the key, nothing to check.
  const alone = fixture({ "package.json": JSON.stringify({ name: "shop", type: "module", scripts: { start: "node server.js" }, dependencies: { express: "^5.1.0" } }), ...EXPRESS_SERVER, ...LINKED });
  gitInit(alone);
  const n = await start(alone, ARGS, { help: HELP, listing: LISTING });
  assert.equal(n.code, 0, n.out.join("\n"));
  assert.equal(n.reports.some((l) => l.startsWith("PARLOX_SECRET_KEY was already set on Vercel")), false, n.reports.join("\n"));
});
