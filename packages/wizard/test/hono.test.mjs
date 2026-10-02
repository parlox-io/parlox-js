import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { hono, honoTarget, readJsonc } from "../dist/integrations/hono.js";
import { express } from "../dist/integrations/express.js";
import { INTEGRATIONS } from "../dist/integrations/registry.js";
import { addUseLine, removeUseLine } from "../dist/edits/use-line.js";
import { headTag, HTML_MARKER, JSX_MARKER } from "../dist/edits/head-tag.js";
import { detectHost } from "../dist/hosts.js";
import { gitFor } from "../dist/git.js";
import { applyPlan } from "../dist/plan-core.js";
import { readInside } from "../dist/fs-safe.js";
import { ownReporting } from "../dist/own-reporting.js";
import { describeUnit, hostStepFor, planUnit, scanApps, selectUnits } from "../dist/apps.js";
import { main } from "../dist/cli.js";
import { HANDOFF_TITLE } from "../dist/ui/handoff.js";
import { startFakeAuth, startFakeGateway } from "./fake-servers.mjs";
import { SERVER_VERSION } from "../dist/versions.js";
import { fixture } from "./helpers.mjs";

// The file contents are create-hono 0.19.5's templates, as generated (`npm create hono@0.19.5 -- --template <name>`,
// re-checked on 2026-10-01).
const PK = "pk_" + "a1".repeat(12);
const BASIC = "import { Hono } from 'hono'\n\nconst app = new Hono()\n\napp.get('/', (c) => {\n  return c.text('Hello Hono!')\n})\n\nexport default app\n";
const NODE = "import { serve } from '@hono/node-server'\nimport { Hono } from 'hono'\n\nconst app = new Hono()\n\napp.get('/', (c) => {\n  return c.text('Hello Hono!')\n})\n\nserve({\n  fetch: app.fetch,\n  port: 3000\n}, (info) => {\n  console.log(`Server is running on http://localhost:${info.port}`)\n})\n";
const LAMBDA = "import { Hono } from 'hono'\nimport { handle } from '@hono/aws-lambda'\n\nconst app = new Hono()\n\napp.get('/', (c) => {\n  return c.text('Hello Hono!')\n})\n\nexport const handler = handle(app)\n";
const PAGES_INDEX = "import { Hono } from 'hono'\nimport { renderer } from './renderer'\n\nconst app = new Hono()\n\napp.use(renderer)\n\napp.get('/', (c) => {\n  return c.render(<h1>Hello!</h1>)\n})\n\nexport default app\n";
const RENDERER = "import { jsxRenderer } from 'hono/jsx-renderer'\n\nexport const renderer = jsxRenderer(({ children }) => {\n  return (\n    <html>\n      <head>\n        <link href=\"/static/style.css\" rel=\"stylesheet\" />\n      </head>\n      <body>{children}</body>\n    </html>\n  )\n})\n";
const WRANGLER_WORKERS = '{\n  "$schema": "node_modules/wrangler/config-schema.json",\n  "name": "shop",\n  "main": "src/index.ts",\n  "compatibility_date": "2026-09-29"\n  // "compatibility_flags": [\n  //   "nodejs_compat"\n  // ],\n}\n';
const WRANGLER_PAGES = '{\n  "name": "shop",\n  "compatibility_date": "2026-09-29",\n  "pages_build_output_dir": "./dist",\n  "compatibility_flags": [\n    "nodejs_compat"\n  ]\n  // "vars": {},\n}\n';
// create-hono's cloudflare-pages template also writes this vite.config.ts (left out of TEMPLATES, which test the
// integration itself; the unit-level Vite check below uses it).
const PAGES_VITE = "import build from '@hono/vite-build/cloudflare-pages'\nimport devServer from '@hono/vite-dev-server'\nimport adapter from '@hono/vite-dev-server/cloudflare'\nimport { defineConfig } from 'vite'\n\nexport default defineConfig({\n  plugins: [\n    build(),\n    devServer({\n      adapter,\n      entry: 'src/index.tsx'\n    })\n  ]\n})\n";
// create-hono's tsconfig.json (the JSX part): every template's JSX is typed by hono/jsx.
const HONO_TSCONFIG = '{\n  "compilerOptions": {\n    "strict": true,\n    "jsx": "react-jsx",\n    "jsxImportSource": "hono/jsx"\n  },\n}\n';
const pkg = (p) => JSON.stringify({ name: "shop", type: "module", ...p });
const TEMPLATES = {
  nodejs: { "package.json": pkg({ scripts: { dev: "tsx watch src/index.ts", build: "tsc", start: "node dist/index.js" }, dependencies: { "@hono/node-server": "^2.1.3", hono: "^4.13.11" } }), "src/index.ts": NODE },
  bun: { "package.json": JSON.stringify({ name: "shop", scripts: { dev: "bun run --hot src/index.ts" }, dependencies: { hono: "^4.13.11" }, devDependencies: { "@types/bun": "latest" } }), "src/index.ts": BASIC },
  "cloudflare-workers": { "package.json": pkg({ scripts: { dev: "wrangler dev", deploy: "wrangler deploy --minify" }, dependencies: { hono: "^4.13.11" }, devDependencies: { wrangler: "^4.110.0" } }), "src/index.ts": BASIC, "wrangler.jsonc": WRANGLER_WORKERS },
  "cloudflare-pages": { "package.json": pkg({ scripts: { dev: "vite", build: "vite build" }, dependencies: { hono: "^4.13.11" }, devDependencies: { "@hono/vite-build": "^1.11.1", vite: "^8.1.4", wrangler: "^4.110.0" } }), "src/index.tsx": PAGES_INDEX, "src/renderer.tsx": RENDERER, "wrangler.jsonc": WRANGLER_PAGES },
  vercel: { "package.json": pkg({ dependencies: { hono: "^4.13.11" }, devDependencies: { tsx: "^4.23.0" } }), "src/index.ts": BASIC, "vercel.json": "{}" },
  "aws-lambda": { "package.json": pkg({ dependencies: { "@hono/aws-lambda": "^1.0.0", hono: "^4.13.11" } }), "src/index.ts": LAMBDA },
};
const git = { isRepo: () => false, dirty: () => [], isTracked: () => false, isIgnored: () => false };
const reader = (dir) => (rel) => (existsSync(join(dir, rel)) ? readFileSync(join(dir, rel), "utf8") : null);
const omit = (files, name) => Object.fromEntries(Object.entries(files).filter(([f]) => f !== name));
const input = (dir) => ({ publicKey: PK, verifyToken: "vt", host: { id: "unknown" }, versions: { browser: "1.0.3", server: SERVER_VERSION }, parts: { browser: true, server: true }, read: reader(dir), git });

test("registered last, after Express", () => {
  assert.deepEqual(INTEGRATIONS.map((i) => i.id), ["nextjs", "vite-react", "express", "hono"]);
});

test("every covered create-hono template: its target, its app file, the use line right after `new Hono()`; uninstall gives back the bytes", () => {
  const expected = { nodejs: ["Node.js", "src/index.ts"], bun: ["Bun", "src/index.ts"], "cloudflare-workers": ["Cloudflare Workers", "src/index.ts"], "cloudflare-pages": ["Cloudflare Pages", "src/index.tsx"], vercel: ["Vercel", "src/index.ts"], "aws-lambda": ["AWS Lambda", "src/index.ts"] };
  for (const [name, files] of Object.entries(TEMPLATES)) {
    const dir = fixture({ ...files, "package-lock.json": "{}" });
    const d = hono.detect(dir, dir);
    const [label, file] = expected[name];
    assert.equal(d.data.target, name, name);
    assert.equal(d.facts[0][1], `Hono · ${file} · ${label} · npm`, name);
    const plan = hono.plan(d, input(dir));
    const change = plan.changes.find((c) => c.path === file);
    assert.match(change.after, /const app = new Hono\(\)\napp\.use\(parlox\(\)\)\n/, name);
    assert.match(change.after, /import \{ parlox \} from '@parlox\/server\/hono'\n/, name);
    assert.deepEqual(plan.install.args, ["install", "--save-exact", `@parlox/server@${SERVER_VERSION}`], name);
    assert.equal(removeUseLine(change.after, file, "@parlox/server/hono").code, files[file], name);
  }
});

// The tag the wizard writes is preceded by a marker in the file's own comment syntax
// ({/* parlox:wizard */} in JSX, <!-- parlox:wizard --> in an html`…` template).
test("cloudflare-pages: the jsxRenderer's <head> gets the tag as a JSX element", () => {
  const dir = fixture({ ...TEMPLATES["cloudflare-pages"], "package-lock.json": "{}" });
  const d = hono.detect(dir, dir);
  assert.deepEqual(d.parts.browser, { file: "src/renderer.tsx", kind: "hono-layout" });
  const plan = hono.plan(d, input(dir));
  assert.ok(plan.changes.find((c) => c.path === "src/renderer.tsx").after.includes(`      <head>\n        ${JSX_MARKER}\n        ${headTag(PK)}\n`));
  applyPlan(dir, plan);
  applyPlan(dir, hono.unplan(hono.detect(dir, dir), { read: reader(dir), git }));
  assert.equal(readFileSync(join(dir, "src/renderer.tsx"), "utf8"), RENDERER);
  assert.equal(readFileSync(join(dir, "src/index.tsx"), "utf8"), PAGES_INDEX);
});

test("an html`…` layout in its own module gets the tag inside its template; a layout that already has a Parlox tag is left alone", () => {
  const layout = "import { html } from 'hono/html'\n\nexport const layout = (title, body) => html`<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><title>${title}</title></head><body>${body}</body></html>`\n";
  const dir = fixture({ ...TEMPLATES.nodejs, "package-lock.json": "{}", "src/html.ts": layout });
  const d = hono.detect(dir, dir);
  assert.equal(d.parts.browser.file, "src/html.ts");
  assert.ok(hono.plan(d, input(dir)).changes.find((c) => c.path === "src/html.ts").after.includes(`<head>${HTML_MARKER}${headTag(PK)}<meta charset="utf-8">`));
  // A store whose page already has an unpinned Parlox tag, in a plain template string.
  const ownTag = "export function parloxHead(env) {\n  return `<script async src=\"${env.PARLOX_GATEWAY ?? \"https://gateway.parlox.io\"}/sdk/parlox.js\" data-key=\"${env.PARLOX_PUBLIC_KEY}\"></script>`;\n}\nexport const layout = (b) => `<!doctype html><html><head>${parloxHead({})}</head><body>${b}</body></html>`;\n";
  const nf = fixture({ ...TEMPLATES.nodejs, "package-lock.json": "{}", "src/html.mjs": ownTag });
  const n = hono.detect(nf, nf);
  assert.equal(n.data.tagAlready, "src/html.mjs");
  const p = hono.plan(n, input(nf));
  assert.equal(p.changes.some((c) => c.path === "src/html.mjs"), false);
  // The warning names the file and the line.
  assert.ok(p.warnings.some((w) => /src\/html\.mjs: A Parlox tag is already in this file, on line 2; it was left as it is\./.test(w)), p.warnings.join("\n"));
});

test("an API without pages has no browser part; two page files are a snippet naming both", () => {
  const dir = fixture({ ...TEMPLATES.bun, "package-lock.json": "{}" });
  assert.equal(hono.detect(dir, dir).parts.browser, null);
  const two = fixture({ ...TEMPLATES["cloudflare-pages"], "package-lock.json": "{}", "src/admin.tsx": RENDERER });
  const d = hono.detect(two, two);
  assert.equal(d.parts.browser.file, null);
  assert.match(d.parts.browser.manualReason, /src\/admin\.tsx, src\/renderer\.tsx/);
});

test("basePath: the server part sees only that path, and the report says how to prove ownership instead", () => {
  const code = "import { Hono } from 'hono'\nimport { handle } from 'hono/vercel'\n\nconst app = new Hono().basePath('/api')\n\nexport default handle(app)\n";
  const dir = fixture({ "package.json": pkg({ dependencies: { hono: "^4.13.11" } }), "package-lock.json": "{}", "api/index.ts": code });
  const d = hono.detect(dir, dir);
  assert.equal(d.data.appFile, "api/index.ts");
  assert.equal(d.data.basePath, "/api");
  assert.match(d.notes.join("\n"), /mounted under \/api: the server part sees only requests there, and the ownership check at \/\.well-known\/parlox-verify does not reach it/);
});

test("Deno and Fastly are declined (not covered yet); JSONC with comments and trailing commas is read", () => {
  const deno = fixture({ "package.json": pkg({ dependencies: { hono: "^4.13.11" } }), "deno.json": "{}", "src/index.ts": BASIC });
  assert.throws(() => hono.detect(deno, deno), (e) => e.code === "declined" && /Deno/.test(e.message));
  assert.equal(honoTarget(() => null, { dependencies: { hono: "4", "@fastly/js-compute": "3" } }, BASIC), "fastly");
  assert.deepEqual(readJsonc(WRANGLER_WORKERS), { $schema: "node_modules/wrangler/config-schema.json", name: "shop", main: "src/index.ts", compatibility_date: "2026-09-29" });
});

test("generic type arguments and `new Hono<{ Bindings }>()` are found", () => {
  const code = "import { Hono } from 'hono'\ntype Bindings = { DB: D1Database }\nconst app = new Hono<{ Bindings: Bindings }>()\nexport default app\n";
  const e = addUseLine(code, "src/index.ts", { kind: "hono", source: "@parlox/server/hono", pkgType: "module" });
  assert.match(e.code, /new Hono<\{ Bindings: Bindings \}>\(\)\napp\.use\(parlox\(\)\)\n/);
});

// ---- A store that reports to Parlox with its own code and has its own tag ----

// A store that reports by itself: dev.mjs serves src/app.mjs, whose `export const app = new Hono()`
// posts to /v1/s itself; src/html.mjs holds an unpinned Parlox tag in a plain template string; deployed on Vercel.
const NF_APP = [
  'import { Hono } from "hono";',
  'import { layout } from "./html.mjs";',
  "",
  "const env = process.env;",
  'const GATEWAY = env.PARLOX_GATEWAY ?? "https://gateway.parlox.io";',
  "",
  "export const app = new Hono();",
  "",
  'app.use("*", async (c, next) => {',
  "  await next();",
  "  if (!env.PARLOX_SECRET_KEY) return;",
  '  const send = fetch(`${GATEWAY}/v1/s`, { method: "POST", headers: { authorization: `Bearer ${env.PARLOX_SECRET_KEY}` }, body: "{}" }).catch(() => {});',
  '  try { const { waitUntil } = await import("@vercel/functions"); waitUntil(send); } catch { /* local */ }',
  "});",
  "",
  'app.get("/", (c) => c.html(layout(env, "<h1>Outdoor shop</h1>")));',
  "",
].join("\n");
const NF_HTML = [
  "export function parloxHead(env) {",
  '  if (!env.PARLOX_PUBLIC_KEY) return "";',
  '  return `<script async src="${env.PARLOX_GATEWAY ?? "https://gateway.parlox.io"}/sdk/parlox.js" data-key="${env.PARLOX_PUBLIC_KEY}"></script>`;',
  "}",
  "export const layout = (env, body) => `<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">${parloxHead(env)}</head><body>${body}</body></html>`;",
  "",
].join("\n");
const NF_DEV = 'import { serve } from "@hono/node-server";\nimport { app } from "./src/app.mjs";\nserve({ fetch: app.fetch, port: 3002 });\n';
const ownReporter = () => fixture({
  "package.json": JSON.stringify({ name: "outdoor-shop", private: true, type: "module", scripts: { dev: "node dev.mjs", build: "node build-feed.mjs" }, dependencies: { "@vercel/functions": "^3.9.9", hono: "^4.7.0" }, devDependencies: { "@hono/node-server": "^1.14.0", esbuild: "^0.24.0" } }),
  "package-lock.json": "{}", "vercel.json": '{ "regions": ["cdg1"] }', "dev.mjs": NF_DEV, "build-feed.mjs": "console.log('feed')\n", "src/app.mjs": NF_APP, "src/html.mjs": NF_HTML,
});
const NF_OWN = `This app already reports to Parlox with its own code (src/app.mjs:${NF_APP.split("\n").findIndex((l) => l.includes("/v1/s")) + 1}). Adding the server part would count visits twice: remove that code, then run the wizard again.`;
const NF_TAG = "src/html.mjs: A Parlox tag is already in this file, on line 3; it was left as it is.";

test("a store that reports by itself: no server part (own-report, no key, no host step), the warning in the review and the report; its own tag is left alone, with its file and line", () => {
  const dir = ownReporter();
  const d = hono.detect(dir, dir);
  assert.deepEqual(d.parts.server, { file: "src/app.mjs", kind: "own-report" });
  assert.equal(d.parts.browser, null, "a tag already there is not a browser part the wizard adds");
  assert.equal(d.facts[0][1], "Hono · src/app.mjs · Vercel · npm", "@hono/node-server only in devDependencies is the local server; vercel.json says where it deploys");
  assert.deepEqual(d.notes, [NF_OWN, NF_TAG], "repeated in the report");
  assert.deepEqual(hono.plan(d, input(dir)), { changes: [], install: null, manual: [], warnings: [NF_OWN, NF_TAG] }, "shown in the review");
  assert.equal(hono.hostStep(d, { id: "vercel" }), false);
  assert.deepEqual(hono.hostNotes(d, { id: "vercel" }, { browser: false, server: true, unitHasBrowser: false }), []);
  const [u] = scanApps(dir).units;
  assert.equal(describeUnit(u), "./ · Hono · no server part (it reports to Parlox with its own code)");
  assert.equal(hostStepFor(u, { id: "vercel" }), false);
  assert.deepEqual(planUnit(u, { publicKey: PK, verifyToken: "vt", host: { id: "vercel" } }, { read: reader(dir), git }).warnings, [NF_OWN, NF_TAG]);
  assert.deepEqual(hono.unplan(d, { read: reader(dir), git }), { changes: [], install: null, manual: [], warnings: [] }, "uninstall touches none of its own code");
});

test("`--yes` on a store that reports by itself: nothing to change, both warnings in the review and the report; no key, no package, no hand-off, nothing written", async (t) => {
  const auth = await startFakeAuth({ decide: "approve" });
  const gw = await startFakeGateway({ sites: [{ id: "11111111-1111-1111-1111-111111111111", name: "Shop", domain: "shop.example.com", public_key: PK, verified: false }], keys: [] });
  t.after(() => { auth.close(); gw.close(); });
  const dir = ownReporter();
  const out = [];
  const ui = { info: (m) => out.push(m), warn: (m) => out.push(`WARN ${m}`), confirm: async () => true, select: async (_m, o) => o[0].value, text: async () => "" };
  const config = { gateway: gw.url, supabaseUrl: auth.url, clientId: "wiz", apiKey: "test-publishable-key", ports: [53842, 53843], dashboard: "https://app.parlox.io" };
  const runs = [];
  const deps = { cwd: dir, config, ui, open: (url) => { fetch(url).catch(() => {}); }, run: (cmd, args) => { runs.push([cmd, ...args]); return { status: 0, stdout: "", stderr: "" }; } };
  assert.equal(await main(["--yes", "--allow-no-git", "--no-vercel", "--site", "shop.example.com", "--skip-check"], deps), 0, out.join("\n"));
  const nothing = out.indexOf("Nothing to change.");
  assert.ok(nothing >= 0 && out.indexOf(`WARN ${NF_OWN}`) > nothing && out.indexOf(`WARN ${NF_TAG}`) > nothing, out.join("\n"));
  const report = out.at(-1).split("\n");
  assert.ok(report.includes(NF_OWN) && report.includes(NF_TAG), out.at(-1));
  assert.equal(report.some((l) => l.startsWith("Browser part") || l.startsWith("Server part")), false, out.at(-1));
  assert.deepEqual(gw.state.keys, [], "no key is created");
  assert.deepEqual(runs, [], "no package step, no host command");
  assert.equal(out.some((m) => m.includes(HANDOFF_TITLE)), false, "no hand-off");
  assert.equal(readFileSync(join(dir, "src/app.mjs"), "utf8"), NF_APP);
  assert.equal(readFileSync(join(dir, "src/html.mjs"), "utf8"), NF_HTML);
});

test("a Parlox tag the wizard did not write anywhere in the app's source means no second tag in its layout; the warning names the file, the line and the layout", () => {
  const pasted = "export const Analytics = () => (\n  <script async src=\"https://gateway.parlox.io/sdk/parlox.js\" data-key=\"pk_abcdefgh12\"></script>\n)\n";
  const dir = fixture({ ...TEMPLATES["cloudflare-pages"], "package-lock.json": "{}", "src/components/analytics.tsx": pasted });
  const d = hono.detect(dir, dir);
  const warning = "src/components/analytics.tsx: A Parlox tag is already in this file, on line 2; it was left as it is, and the wizard adds no tag to src/renderer.tsx, which may show it.";
  assert.equal(d.parts.browser, null);
  assert.ok(d.notes.includes(warning), d.notes.join("\n"));
  const plan = hono.plan(d, input(dir));
  assert.deepEqual(plan.changes.map((c) => c.path), ["src/index.tsx"], "the server part only");
  assert.ok(plan.warnings.includes(warning), plan.warnings.join("\n"));
  assert.deepEqual(hono.hostNotes(d, { id: "cloudflare" }, { browser: false, server: true, unitHasBrowser: false }), ["On Cloudflare the adapter reads PARLOX_SECRET_KEY and PARLOX_VERIFY_TOKEN from the Worker's variables (c.env)."], "no pure-API note: the app has pages");
});

test("the layout is the app file itself: one change with both parts; uninstall gives back the exact bytes (CRLF too); a second run changes nothing", () => {
  const one = "import { Hono } from 'hono'\n\nconst app = new Hono()\n\napp.get('/', (c) => c.html(\n  <html>\n    <head>\n      <title>Shop</title>\n    </head>\n    <body>Hi</body>\n  </html>\n))\n\nexport default app\n";
  for (const text of [one, one.replace(/\n/g, "\r\n")]) {
    const dir = fixture({ ...omit(TEMPLATES["cloudflare-workers"], "src/index.ts"), "src/index.tsx": text, "wrangler.jsonc": WRANGLER_WORKERS.replace("src/index.ts", "src/index.tsx"), "tsconfig.json": HONO_TSCONFIG, "package-lock.json": "{}" });
    const d = hono.detect(dir, dir);
    assert.equal(d.data.appFile, "src/index.tsx");
    assert.equal(d.data.layout, "src/index.tsx");
    const plan = hono.plan(d, input(dir));
    assert.equal(plan.changes.length, 1);
    assert.equal(plan.changes[0].before, text);
    assert.equal(plan.changes[0].purpose, "server and browser parts");
    const eol = text.includes("\r\n") ? "\r\n" : "\n";
    assert.ok(plan.changes[0].after.includes(`const app = new Hono()${eol}app.use(parlox())${eol}`));
    assert.ok(plan.changes[0].after.includes(`    <head>${eol}      ${JSX_MARKER}${eol}      ${headTag(PK)}${eol}      <title>`));
    applyPlan(dir, plan);
    const again = hono.plan(hono.detect(dir, dir), input(dir));
    assert.deepEqual(again.changes, [], "a second run changes nothing");
    const back = hono.unplan(hono.detect(dir, dir), { read: reader(dir), git });
    assert.equal(back.changes.length, 1);
    applyPlan(dir, back);
    assert.equal(readFileSync(join(dir, "src/index.tsx"), "utf8"), text);
  }
});

test("uninstall removes only the tag the wizard wrote (found by its marker in every source file), whatever detection says now; a tag pasted by hand stays", () => {
  const dir = fixture({ ...TEMPLATES["cloudflare-pages"], "package-lock.json": "{}" });
  applyPlan(dir, hono.plan(hono.detect(dir, dir), input(dir)));
  // After the install: a second page with a <head> (detection now finds two), and a tag pasted by hand elsewhere.
  writeFileSync(join(dir, "src/admin.tsx"), RENDERER);
  const pasted = `export const Tag = () => ${headTag(PK)}\n`;
  writeFileSync(join(dir, "src/tag.tsx"), pasted);
  const d = hono.detect(dir, dir);
  assert.equal(d.data.layout, null);
  const back = hono.unplan(d, { read: reader(dir), git });
  assert.deepEqual(back.changes.map((c) => c.path).sort(), ["src/index.tsx", "src/renderer.tsx"]);
  applyPlan(dir, back);
  assert.equal(readFileSync(join(dir, "src/renderer.tsx"), "utf8"), RENDERER);
  assert.equal(readFileSync(join(dir, "src/index.tsx"), "utf8"), PAGES_INDEX);
  assert.equal(readFileSync(join(dir, "src/tag.tsx"), "utf8"), pasted);
});

test("a line break the wizard does not edit around (a lone CR, U+2028) is a snippet with the reason, never an error", () => {
  const cr = fixture({ ...TEMPLATES.bun, "src/index.ts": BASIC.replace("app.get", "\rapp.get"), "package-lock.json": "{}" });
  const p = hono.plan(hono.detect(cr, cr), input(cr));
  // Bun reads .env by itself, so the token goes there; the app file itself is not changed.
  assert.deepEqual(p.changes.map((c) => c.path), [".env"]);
  assert.equal(p.manual.length, 1);
  assert.equal(p.manual[0].part, "server");
  assert.match(p.manual[0].snippet, /app\.use\(parlox\(\)\)/);
  const ls = fixture({ ...TEMPLATES["cloudflare-pages"], "src/renderer.tsx": RENDERER.replace("<head>\n", "<head> \n"), "package-lock.json": "{}" });
  const q = hono.plan(hono.detect(ls, ls), input(ls));
  assert.deepEqual(q.changes.map((c) => c.path), ["src/index.tsx"]);
  assert.equal(q.manual.length, 1);
  assert.equal(q.manual[0].file, "src/renderer.tsx");
  assert.equal(q.manual[0].part, "browser");
  assert.ok(q.manual[0].snippet.includes(headTag(PK)));
});

test("compiled output is never edited: wrangler's main in dist/ stands for its source; an app file or layout git ignores is a step by hand", () => {
  const dir = fixture({ ...TEMPLATES["cloudflare-workers"], "wrangler.jsonc": WRANGLER_WORKERS.replace("src/index.ts", "dist/index.js"), "dist/index.js": BASIC, "package-lock.json": "{}" });
  assert.equal(hono.detect(dir, dir).data.appFile, "src/index.ts");
  // tsc's outDir inside src/ (tsconfig.json): a <head> there is build output, not a second page layout.
  const built = fixture({ ...TEMPLATES["cloudflare-pages"], "tsconfig.json": '{ "compilerOptions": { "outDir": "src/compiled" } }', "src/compiled/renderer.jsx": RENDERER, "package-lock.json": "{}" });
  assert.equal(hono.detect(built, built).data.layout, "src/renderer.tsx");
  const p = fixture({ ...TEMPLATES["cloudflare-pages"], "package-lock.json": "{}" });
  const ignored = { ...git, isRepo: () => true, isIgnored: () => true };
  const plan = hono.plan(hono.detect(p, p), { ...input(p), git: ignored });
  assert.deepEqual(plan.changes, []);
  assert.deepEqual(plan.manual.map((m) => [m.file, m.part]), [["src/index.tsx", "server"], ["src/renderer.tsx", "browser"]]);
  assert.match(plan.manual[0].reason, /^git ignores src\/index\.tsx/);
  assert.match(plan.manual[1].reason, /^git ignores src\/renderer\.tsx/);
});

test("an app file or layout the wizard may not write through (a symlink) is a step by hand, never the end of the run", { skip: process.platform === "win32" }, () => {
  const outside = fixture({ "index.ts": BASIC, "renderer.tsx": RENDERER });
  const dir = fixture({ "package.json": TEMPLATES.bun["package.json"], "package-lock.json": "{}" });
  symlinkSync(join(outside, "index.ts"), join(dir, "index.ts"), "file");
  const linkedLayout = fixture({ ...omit(TEMPLATES["cloudflare-pages"], "src/renderer.tsx"), "package-lock.json": "{}" });
  symlinkSync(join(outside, "renderer.tsx"), join(linkedLayout, "src/renderer.tsx"), "file");
  const d = hono.detect(dir, dir);
  assert.equal(d.data.appFile, "index.ts");
  const inside = (root) => (f) => readInside(root, f);
  const plan = hono.plan(d, { ...input(dir), read: inside(dir) });
  // Bun reads .env by itself, so the token goes there; the linked app file is not changed.
  assert.deepEqual(plan.changes.map((c) => c.path), [".env"]);
  assert.match(plan.manual[0].reason, /Refusing index\.ts/);
  assert.match(hono.unplan(d, { read: inside(dir), git }).manual[0].reason, /Refusing index\.ts/);
  const l = hono.detect(linkedLayout, linkedLayout);
  assert.equal(l.data.layout, "src/renderer.tsx");
  const lp = hono.plan(l, { ...input(linkedLayout), read: inside(linkedLayout) });
  assert.deepEqual(lp.changes.map((c) => c.path), ["src/index.tsx"]);
  assert.match(lp.manual.find((m) => m.part === "browser").reason, /Refusing src\/renderer\.tsx/);
});

test("the AWS Lambda note says what the server package's README says: a report starts after the handler has returned, so it usually waits for the next invocation", () => {
  const oneLine = (text) => text.replace(/\s+/g, " ");
  const readme = oneLine(readFileSync(fileURLToPath(new URL("../../server/README.md", import.meta.url)), "utf8"));
  const dir = fixture({ ...TEMPLATES["aws-lambda"], "package-lock.json": "{}" });
  const notes = hono.hostNotes(hono.detect(dir, dir), { id: "unknown" }, { browser: false, server: true, unitHasBrowser: false });
  const note = notes.find((n) => n.startsWith("On AWS Lambda"));
  assert.ok(note, notes.join("\n"));
  const SAME = "usually delayed to the next invocation of the same warm instance, and lost when the instance is frozen and then recycled";
  assert.ok(readme.includes(SAME), "the README says it");
  assert.ok(note.includes(SAME), note);
  assert.match(readme, /starts only after an asynchronous one-way hash, so after your handler has returned/);
  assert.match(note, /starts only after your handler has returned/);
  assert.equal(note, "On AWS Lambda each report is sent on its own, never queued, but its request to Parlox starts only after your handler has returned, and Lambda then freezes the function: the report is usually delayed to the next invocation of the same warm instance, and lost when the instance is frozen and then recycled.");
});

test("the app file is the one that creates the app: a route file that imports hono first is passed over; HonoX and Lambda@Edge are declined", () => {
  const routes = "import { Hono } from 'hono'\nexport type { Hono }\nexport const health = (c) => c.text('ok')\n";
  const dir = fixture({ "package.json": pkg({ scripts: { dev: "tsx watch src/routes.ts" }, dependencies: { hono: "^4.13.11", "@hono/node-server": "^2.1.3" } }), "package-lock.json": "{}", "src/routes.ts": routes, "src/index.ts": NODE });
  assert.equal(hono.detect(dir, dir).data.appFile, "src/index.ts");
  const x = fixture({ "package.json": pkg({ dependencies: { hono: "^4.13.12", honox: "0.1.61" } }), "app/server.ts": "import { createApp } from 'honox/server'\nexport default createApp()\n" });
  assert.throws(() => hono.detect(x, x), (e) => e.code === "declined" && /HonoX/.test(e.message) && e.message.includes("https://gateway.parlox.io/install.md"));
  const edge = fixture({ "package.json": pkg({ dependencies: { "@hono/lambda-edge": "^1.0.0", hono: "^4.13.12" } }), "src/index.ts": BASIC });
  assert.throws(() => hono.detect(edge, edge), (e) => e.code === "declined" && /Lambda@Edge/.test(e.message) && /environment variables/.test(e.message));
});

test("notes by runtime: the CDN note where a cache can sit in front, the Lambda note, the Workers variables; the pure-API note; the local check", () => {
  const notes = (name, unitHasBrowser = false) => {
    const dir = fixture({ ...TEMPLATES[name], "package-lock.json": "{}" });
    const d = hono.detect(dir, dir);
    return { d, notes: hono.hostNotes(d, { id: "unknown" }, { browser: false, server: true, unitHasBrowser }) };
  };
  const CDN = "Pages a CDN serves from its cache never reach this server, so those crawler visits are not seen.";
  const NO_PAGES = "This app serves no pages the wizard can see (no JSX <head>, no html`…` template with a <head>): the browser part belongs in your frontend.";
  // Where the wizard adds the server part, what it found about local variables (here: no .env loader).
  assert.deepEqual(notes("nodejs").notes, [CDN, NO_PAGES, 'The wizard found no .env loader in the script "dev", src/index.ts or the dependencies, so it wrote nothing for local use and added no package. To check the server part on your computer, start it with PARLOX_VERIFY_TOKEN set to the same value as on your host.']);
  assert.deepEqual(notes("bun", true).notes, [CDN]);
  assert.deepEqual(notes("vercel").notes, [CDN, NO_PAGES]);
  assert.deepEqual(notes("aws-lambda").notes, [CDN, "On AWS Lambda each report is sent on its own, never queued, but its request to Parlox starts only after your handler has returned, and Lambda then freezes the function: the report is usually delayed to the next invocation of the same warm instance, and lost when the instance is frozen and then recycled.", NO_PAGES]);
  // The runtime-secret sentence follows the Workers target, which create-hono's Workers template has, whatever host
  // object the notes are given (workers-host.test.mjs).
  assert.deepEqual(notes("cloudflare-workers").notes, ["On Cloudflare the adapter reads PARLOX_SECRET_KEY and PARLOX_VERIFY_TOKEN from the Worker's variables (c.env).", RUNTIME_SECRET, NO_PAGES]);
  const { d } = notes("aws-lambda");
  assert.deepEqual(d.localCheck, { skip: "an AWS Lambda function has no local server to check" });
  // The local check says why there is none (create-hono's Node.js template loads no .env).
  assert.deepEqual(notes("nodejs").d.localCheck, { skip: "the wizard found no .env loader in the script \"dev\", src/index.ts or the dependencies, so PARLOX_VERIFY_TOKEN is not loaded locally; check it after you deploy" });
  assert.equal(hono.hostStep(d, { id: "unknown" }), true);
  assert.deepEqual(hono.hostNotes(d, { id: "unknown" }, { browser: false, server: false, unitHasBrowser: false }), [], "only the detection that plays the server part says these");
});

test("a Vite build in the folder: create-hono's cloudflare-pages template as generated (a Vite build with @hono/vite-build, which the guard reads as safe) keeps its server part, key and host step; an exposing config there gets no server part, key or host step, and its layout still gets the tag", () => {
  const dir = fixture({ ...TEMPLATES["cloudflare-pages"], "vite.config.ts": PAGES_VITE, "package-lock.json": "{}" });
  const [kept] = scanApps(dir).units;
  assert.equal(kept.server?.integration, "hono", kept.warnings.join("\n"));
  assert.equal(kept.warnings.length, 1);
  assert.match(kept.warnings[0], /^Hono: the wizard read the build commands in package\.json, vercel\.json and netlify\.toml/);
  assert.equal(hostStepFor(kept, { id: "cloudflare" }), true);
  assert.equal(describeUnit(kept), "./ · Hono · browser and server parts");
  assert.deepEqual(planUnit(kept, { publicKey: PK, verifyToken: "vt", host: { id: "cloudflare" } }, { read: reader(dir), git }).changes.map((c) => c.path), ["src/index.tsx", "src/renderer.tsx"]);
  const exposing = fixture({ ...TEMPLATES["cloudflare-pages"], "vite.config.ts": PAGES_VITE.replace("plugins: [", "envPrefix: ['VITE_', 'PARLOX_'],\n  plugins: ["), "package-lock.json": "{}" });
  const [u] = scanApps(exposing).units;
  assert.equal(u.server, null);
  assert.equal(u.warnings.length, 1);
  assert.match(u.warnings[0], /^Hono: no server part was added\. /);
  assert.equal(hostStepFor(u, { id: "cloudflare" }), false);
  assert.equal(describeUnit(u), "./ · Hono · browser part");
  const plan = planUnit(u, { publicKey: PK, verifyToken: "vt", host: { id: "cloudflare" } }, { read: reader(exposing), git });
  assert.deepEqual(plan.changes.map((c) => c.path), ["src/renderer.tsx"]);
  assert.equal(plan.install, null);
  // Without a Vite build in the folder, the server part and its key stay.
  const node = fixture({ ...TEMPLATES.nodejs, "package-lock.json": "{}" });
  const [n] = scanApps(node).units;
  assert.equal(n.server.integration, "hono");
  assert.deepEqual(n.warnings, []);
  assert.equal(hostStepFor(n, { id: "unknown" }), true);
  assert.equal(describeUnit(n), "./ · Hono · server part");
});

test("bounded scans: past ownReporting's caps the note is in the review and the report and the server part is planned; past 300 source files a layout found is a step by hand", () => {
  const many = Object.fromEntries(Array.from({ length: 205 }, (_, i) => [`src/m${String(i).padStart(3, "0")}.ts`, "export const x = 1\n"]));
  const dir = fixture({ ...TEMPLATES.bun, ...many, "package-lock.json": "{}" });
  const d = hono.detect(dir, dir);
  const notChecked = ownReporting(dir).notChecked;
  assert.ok(notChecked);
  assert.ok(d.notes.includes(notChecked));
  const plan = hono.plan(d, input(dir));
  assert.ok(plan.warnings.includes(notChecked));
  // Bun reads .env by itself, so the token goes there too.
  assert.deepEqual(plan.changes.map((c) => c.path), ["src/index.ts", ".env"]);
  const more = Object.fromEntries(Array.from({ length: 305 }, (_, i) => [`src/z${String(i).padStart(3, "0")}.ts`, "export const x = 1\n"]));
  const big = fixture({ ...TEMPLATES["cloudflare-pages"], ...more, "package-lock.json": "{}" });
  const b = hono.detect(big, big);
  assert.equal(b.parts.browser.file, null);
  assert.match(b.parts.browser.manualReason, /read the first 300 source files/);
});

test("install, then uninstall, end to end: the app file and the html`…` layout get their parts, and come back byte for byte", async (t) => {
  const auth = await startFakeAuth({ decide: "approve" });
  const gw = await startFakeGateway({ sites: [{ id: "11111111-1111-1111-1111-111111111111", name: "Shop", domain: "shop.example.com", public_key: PK, verified: false }], keys: [] });
  t.after(() => { auth.close(); gw.close(); });
  const layout = "import { html } from 'hono/html'\n\nexport const layout = (body: string) => html`<!doctype html>\n<html>\n  <head>\n    <title>Shop</title>\n  </head>\n  <body>${body}</body>\n</html>`\n";
  const dir = fixture({ ...TEMPLATES.nodejs, "package-lock.json": "{}", "src/html.ts": layout });
  const out = [];
  const ui = { info: (m) => out.push(m), warn: (m) => out.push(`WARN ${m}`), confirm: async () => true, select: async (_m, o) => o[0].value, text: async () => "" };
  const config = { gateway: gw.url, supabaseUrl: auth.url, clientId: "wiz", apiKey: "test-publishable-key", ports: [53842, 53843], dashboard: "https://app.parlox.io" };
  const runs = [];
  const deps = { cwd: dir, config, ui, open: (url) => { fetch(url).catch(() => {}); }, run: (cmd, args) => { runs.push([cmd, ...args]); return { status: 0, stdout: "", stderr: "" }; } };
  assert.equal(await main(["--yes", "--allow-no-git", "--no-vercel", "--site", "shop.example.com", "--skip-check"], deps), 0, out.join("\n"));
  assert.ok(readFileSync(join(dir, "src/index.ts"), "utf8").includes("const app = new Hono()\napp.use(parlox())\n"));
  assert.ok(readFileSync(join(dir, "src/html.ts"), "utf8").includes(`  <head>\n    ${HTML_MARKER}\n    ${headTag(PK)}\n    <title>`));
  assert.deepEqual(runs[0], ["npm", "install", "--save-exact", `@parlox/server@${SERVER_VERSION}`]);
  const report = out.at(-1);
  assert.ok(report.includes("Browser part: added to your code"), report);
  // The local check says why there is none (create-hono's Node.js template loads no .env).
  assert.ok(report.includes("Server part: not checked (the wizard found no .env loader in the script \"dev\", src/index.ts or the dependencies, so PARLOX_VERIFY_TOKEN is not loaded locally; check it after you deploy)."), report);
  assert.equal(await main(["uninstall", "--yes", "--allow-no-git"], deps), 0, out.join("\n"));
  assert.equal(readFileSync(join(dir, "src/index.ts"), "utf8"), NODE);
  assert.equal(readFileSync(join(dir, "src/html.ts"), "utf8"), layout);
});

// ---- Workers and the key, JSX types, Vercel's api/, wrangler's builds, pages in plain strings ----

const G = ["-c", "user.email=t@t", "-c", "user.name=t"];
const gitInit = (dir) => { execFileSync("git", [...G, "init", "-q"], { cwd: dir }); execFileSync("git", [...G, "add", "-A"], { cwd: dir }); execFileSync("git", [...G, "commit", "-qm", "init"], { cwd: dir }); };
// create-hono 0.19.5's cloudflare-workers+vite template, as generated (its tsconfig's JSX part).
const WV = {
  "package.json": pkg({ scripts: { dev: "vite", build: "vite build", deploy: "$npm_execpath run build && wrangler deploy" }, dependencies: { hono: "^4.13.12" }, devDependencies: { "@cloudflare/vite-plugin": "^1.44.0", vite: "^8.1.4", "vite-ssr-components": "^0.8.0", wrangler: "^4.110.0" } }),
  "wrangler.jsonc": '{\n  "$schema": "node_modules/wrangler/config-schema.json",\n  "name": "shop",\n  "compatibility_date": "2025-08-03",\n  "main": "./src/index.tsx"\n}\n',
  "vite.config.ts": "import { cloudflare } from '@cloudflare/vite-plugin'\nimport { defineConfig } from 'vite'\nimport ssrPlugin from 'vite-ssr-components/plugin'\n\nexport default defineConfig({\n  plugins: [cloudflare(), ssrPlugin()]\n})\n",
  "src/index.tsx": PAGES_INDEX,
  "src/renderer.tsx": "import { jsxRenderer } from 'hono/jsx-renderer'\nimport { Link, ViteClient } from 'vite-ssr-components/hono'\n\nexport const renderer = jsxRenderer(({ children }) => {\n  return (\n    <html>\n      <head>\n        <ViteClient />\n        <Link href=\"/src/style.css\" rel=\"stylesheet\" />\n      </head>\n      <body>{children}</body>\n    </html>\n  )\n})\n",
  "tsconfig.json": HONO_TSCONFIG,
  "package-lock.json": "{}",
};
const RUNTIME_SECRET = "Add PARLOX_SECRET_KEY as a runtime secret under Settings → Variables & Secrets, not as a build variable.";

test("on Cloudflare Workers a Vite build is checked as on every host: create-hono's Workers+Vite template (a plugin the guard does not vouch for) gets no server part, nor does a config that exposes PARLOX_ or that the wizard cannot follow; Pages keeps the guard; the report on Workers says where the secret goes", () => {
  const [u] = scanApps(fixture(WV)).units;
  assert.equal(u.server, null, JSON.stringify(u.warnings));
  assert.match(u.warnings[0], /^Hono: no server part was added\. vite\.config\.ts uses the import of /);
  assert.equal(hostStepFor(u, { id: "cloudflare" }), false);
  assert.equal(describeUnit(u), "./ · Hono · browser part");
  const withheld = (config) => { const [w] = scanApps(fixture({ ...WV, "vite.config.ts": config })).units; return w.server ? null : w.warnings.join("\n"); };
  assert.match(withheld("import { defineConfig } from 'vite'\nimport { cloudflare } from '@cloudflare/vite-plugin'\n\nexport default defineConfig({\n  plugins: [cloudflare()],\n  envPrefix: ['VITE_', 'PARLOX_'],\n})\n"), /^Hono: no server part was added\. Your Vite config lists PARLOX_ in envPrefix/);
  assert.match(withheld("import { defineConfig } from 'vite'\nexport default defineConfig({ envPrefix: '' })\n"), /^Hono: no server part was added\. /, "an empty prefix is a prefix of PARLOX_");
  assert.match(withheld("import { defineConfig } from 'vite'\nexport default defineConfig({\n  define: { __KEY__: JSON.stringify(process.env.PARLOX_SECRET_KEY) },\n})\n"), /^Hono: no server part was added\. vite\.config\.ts names PARLOX_SECRET_KEY \(line 3\)/);
  assert.match(withheld("import { defineConfig, loadEnv, mergeConfig } from 'vite'\nexport default ({ mode }) => mergeConfig({}, { define: loadEnv(mode, process.cwd(), 'PARLOX_') })\n"), /^Hono: no server part was added\. The wizard cannot read vite\.config\.ts to the end/);
  assert.match(withheld("import { defineConfig, mergeConfig } from 'vite'\nimport base from './base'\nexport default mergeConfig(base, { define: { 'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV) } })\n"), /^Hono: no server part was added\. The wizard cannot read vite\.config\.ts to the end/, "not proven safe: withheld, though it names no PARLOX variable");
  // A Vite app below the folder is read the same way (beside a config of the folder's own the guard proves safe).
  const below = scanApps(fixture({ ...WV, "vite.config.ts": "import { defineConfig } from 'vite'\nexport default defineConfig({})\n", "client/package.json": JSON.stringify({ devDependencies: { vite: "^8.1.4" } }), "client/vite.config.js": "export default { envPrefix: 'PARLOX_' }\n" })).units[0];
  assert.equal(below.server, null);
  assert.match(below.warnings[0], /^Hono: no server part was added\. In client\/: /);
  // Cloudflare Pages: the guard stays (its build output is the Worker's, and Pages builds with the project's variables):
  // a config that exposes the key withholds it, though create-hono's own config is proven safe.
  const [pages] = scanApps(fixture({ ...TEMPLATES["cloudflare-pages"], "vite.config.ts": PAGES_VITE.replace("plugins: [", "envPrefix: ['VITE_', 'PARLOX_'],\n  plugins: ["), "package-lock.json": "{}" })).units;
  assert.equal(pages.server, null);
  // The report on Workers names the runtime secret, and so does the Workers hand-off (handoffNotes); Pages gets neither.
  const plain = fixture({ ...TEMPLATES["cloudflare-workers"], "package-lock.json": "{}" });
  const [w] = scanApps(plain).units;
  assert.ok(hono.hostNotes(w.server, { id: "cloudflare" }, { browser: true, server: true, unitHasBrowser: true }).includes(RUNTIME_SECRET));
});

// A renderer typed by React (@hono/react-renderer, with tsconfig's jsxImportSource react).
const REACT_RENDERER = "import { reactRenderer } from '@hono/react-renderer'\n\nexport const renderer = reactRenderer(({ children }) => {\n  return (\n    <html>\n      <head>\n        <title>Shop</title>\n      </head>\n      <body>{children}</body>\n    </html>\n  )\n})\n";
const REACT_TSCONFIG = '{\n  "compilerOptions": {\n    "strict": true,\n    "jsx": "react-jsx",\n    "jsxImportSource": "react"\n  }\n}\n';
const jsxApp = (files, without = []) => fixture({ ...Object.fromEntries(Object.entries(TEMPLATES["cloudflare-pages"]).filter(([f]) => !without.includes(f))), "package-lock.json": "{}", ...files });
const rendererAfter = (dir) => hono.plan(hono.detect(dir, dir), input(dir));

test("the JSX tag is written for the JSX types the file is checked with: hono/jsx as it is, React with crossOrigin; types it cannot tell give a snippet", () => {
  const reactTag = headTag(PK).replace("crossorigin=", "crossOrigin=");
  // hono/jsx: tsconfig, a pragma, or an import from hono/jsx*.
  for (const files of [{ "tsconfig.json": HONO_TSCONFIG }, { "src/renderer.tsx": `/** @jsxImportSource hono/jsx */\n${RENDERER.replace("import { jsxRenderer } from 'hono/jsx-renderer'\n", "")}` }, {}]) {
    const p = rendererAfter(jsxApp(files));
    const after = p.changes.find((c) => c.path === "src/renderer.tsx")?.after ?? "";
    assert.ok(after.includes(`${JSX_MARKER}\n        ${headTag(PK)}\n`), JSON.stringify({ files: Object.keys(files), manual: p.manual }));
  }
  // React: tsconfig's jsxImportSource, or @hono/react-renderer.
  for (const files of [{ "tsconfig.json": REACT_TSCONFIG, "src/renderer.tsx": REACT_RENDERER }, { "src/renderer.tsx": REACT_RENDERER }, { "tsconfig.json": '{ "compilerOptions": { "jsx": "react-jsx" } }', "src/renderer.tsx": REACT_RENDERER.replace("@hono/react-renderer", "./mine") }]) {
    const dir = jsxApp(files);
    const p = rendererAfter(dir);
    const change = p.changes.find((c) => c.path === "src/renderer.tsx");
    assert.ok(change?.after.includes(`${JSX_MARKER}\n        ${reactTag}\n`), JSON.stringify({ files: Object.keys(files), manual: p.manual }));
    applyPlan(dir, p);
    applyPlan(dir, hono.unplan(hono.detect(dir, dir), { read: reader(dir), git }));
    assert.equal(readFileSync(join(dir, "src/renderer.tsx"), "utf8"), files["src/renderer.tsx"], "uninstall gives back the bytes");
  }
  // Not known (no tsconfig, pragma or JSX import), or the signs disagree: a snippet, with both spellings.
  for (const files of [{ "src/renderer.tsx": RENDERER.replace("import { jsxRenderer } from 'hono/jsx-renderer'\n", "import { jsxRenderer } from './mine'\n") }, { "tsconfig.json": REACT_TSCONFIG }, { "tsconfig.json": '{ "extends": "@tsconfig/strictest" }', "src/renderer.tsx": RENDERER.replace("'hono/jsx-renderer'", "'./mine'") }]) {
    const p = rendererAfter(jsxApp(files));
    assert.equal(p.changes.some((c) => c.path === "src/renderer.tsx"), false, JSON.stringify(Object.keys(files)));
    const m = p.manual.find((x) => x.part === "browser");
    assert.match(m.reason, /cannot tell whether this file's JSX is typed by hono\/jsx or by React/);
    assert.ok(m.snippet.includes(headTag(PK)) && m.snippet.includes("crossOrigin"), m.snippet);
  }
  // An html`…` template is HTML whatever the JSX types: the tag as it is.
  const html = jsxApp({ "tsconfig.json": REACT_TSCONFIG, "src/layout.ts": "import { html } from 'hono/html'\nexport const layout = (b: string) => html`<html><head><title>x</title></head><body>${b}</body></html>`\n" }, ["src/renderer.tsx"]);
  assert.ok(rendererAfter(html).changes.find((c) => c.path === "src/layout.ts").after.includes(`<head>${HTML_MARKER}${headTag(PK)}<title>`));
});

test("the edited layouts type-check with tsc, under hono/jsx's types and under React's", { timeout: 120_000 }, (t) => {
  const require = createRequire(import.meta.url);
  const tsc = require.resolve("typescript/bin/tsc");
  // Inside the package's node_modules, so hono and React's types resolve from the repository's install.
  const here = dirname(fileURLToPath(import.meta.url));
  const base = join(here, "..", "node_modules", ".cache", `parlox-tsx-${process.pid}`);
  mkdirSync(base, { recursive: true });
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const check = (name, tsconfig, files) => {
    const dir = join(base, name);
    mkdirSync(dir, { recursive: true });
    for (const [f, text] of Object.entries(files)) writeFileSync(join(dir, f), text);
    writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [], module: "esnext", moduleResolution: "bundler", target: "esnext", ...tsconfig }, files: Object.keys(files) }));
    try { execFileSync(process.execPath, [tsc, "-p", join(dir, "tsconfig.json")], { cwd: dir, stdio: "pipe" }); return ""; }
    catch (e) { return String(e.stdout) || String(e); }
  };
  const honoAfter = rendererAfter(jsxApp({ "tsconfig.json": HONO_TSCONFIG })).changes.find((c) => c.path === "src/renderer.tsx").after;
  const reactAfter = rendererAfter(jsxApp({ "tsconfig.json": REACT_TSCONFIG, "src/renderer.tsx": REACT_RENDERER })).changes.find((c) => c.path === "src/renderer.tsx").after;
  const shim = "declare module '@hono/react-renderer' { export const reactRenderer: (f: (p: { children?: any }) => any) => any }\n";
  assert.equal(check("hono", { jsx: "react-jsx", jsxImportSource: "hono/jsx" }, { "renderer.tsx": honoAfter }), "");
  assert.equal(check("react", { jsx: "react-jsx", jsxImportSource: "react", lib: ["esnext", "dom"] }, { "renderer.tsx": reactAfter, "shim.d.ts": shim }), "");
  // The check bites: hono/jsx's spelling does not compile under React's types.
  assert.match(check("react-with-hono-tag", { jsx: "react-jsx", jsxImportSource: "react", lib: ["esnext", "dom"] }, { "renderer.tsx": reactAfter.replace("crossOrigin=", "crossorigin="), "shim.d.ts": shim }), /TS2322/);
});

test("Vercel's api/: index and catch-all routes are the app, not a sub-router; several apps and none of those is a snippet", () => {
  const sub = (name) => `import { Hono } from 'hono'\nconst ${name} = new Hono()\n${name}.get('/', (c) => c.json([]))\nexport default ${name}\n`;
  const root = "import { Hono } from 'hono'\nimport { handle } from 'hono/vercel'\nimport books from './books'\nconst app = new Hono().basePath('/api')\napp.route('/books', books)\nexport default handle(app)\n";
  const vercel = (files) => { const dir = fixture({ "package.json": pkg({ dependencies: { hono: "^4.13.11" } }), "package-lock.json": "{}", "vercel.json": "{}", ...files }); return hono.detect(dir, dir); };
  assert.equal(vercel({ "api/books.ts": sub("books"), "api/index.ts": root }).data.appFile, "api/index.ts");
  assert.equal(vercel({ "api/_routes.ts": sub("routes"), "api/[[...route]].ts": root.replace("'./books'", "'./_routes'") }).data.appFile, "api/[[...route]].ts");
  assert.equal(vercel({ "api/a.ts": sub("a"), "api/[...path].ts": root.replace("'./books'", "'./a'") }).data.appFile, "api/[...path].ts");
  const two = vercel({ "api/books.ts": sub("books"), "api/users.ts": sub("users") });
  assert.equal(two.data.appFile, null);
  assert.equal(two.parts.server.manualReason, "More than one file in api/ creates a Hono app (api/books.ts, api/users.ts), and none is api/index or a catch-all route, so the wizard cannot tell which one serves the site.");
  const p = hono.plan(two, { ...input(fixture({})), read: () => null });
  assert.equal(p.manual[0].reason, two.parts.server.manualReason);
  assert.equal(vercel({ "api/books.ts": sub("books") }).data.appFile, "api/books.ts", "one app in api/ is the app");
});

test("wrangler's main built by its [build] command is never edited: its source is (with and without git); no source is a step by hand", () => {
  const BUNDLE = "var app=new Hono();export default app;\n";
  const worker = (wrangler, extra = {}) => ({ "package.json": pkg({ scripts: { build: "esbuild src/worker.ts --bundle --outfile=bundle/worker.js" }, dependencies: { hono: "^4.13.11" } }), "package-lock.json": "{}", ...wrangler, "bundle/worker.js": `import { Hono } from 'hono'\n${BUNDLE}`, "src/worker.ts": BASIC, ...extra });
  const TOML = { "wrangler.toml": 'name = "shop"\nmain = "bundle/worker.js"\n\n[build]\ncommand = "npm run build"\n' };
  const JSONC = { "wrangler.jsonc": '{\n  "name": "shop",\n  "main": "bundle/worker.js",\n  // built first\n  "build": { "command": "npm run build" },\n}\n' };
  for (const [label, config] of [["toml", TOML], ["jsonc", JSONC]]) {
    for (const ignore of [null, "bundle/\n", "node_modules/\n"]) {
      const dir = fixture(worker(config, ignore === null ? {} : { ".gitignore": ignore }));
      if (ignore !== null) gitInit(dir);
      const d = hono.detect(dir, dir);
      assert.equal(d.data.appFile, "src/worker.ts", `${label} ${ignore}`);
      const p = hono.plan(d, { ...input(dir), git: ignore === null ? git : gitFor(dir) });
      assert.deepEqual(p.changes.map((c) => c.path), ["src/worker.ts"], `${label} ${ignore}`);
    }
  }
  // No source for the bundle: a step by hand, never an edit to bundle/.
  const none = fixture(omit(worker(TOML), "src/worker.ts"));
  const d = hono.detect(none, none);
  assert.equal(d.data.appFile, null);
  assert.equal(d.parts.server.manualReason, "wrangler's main, bundle/worker.js, is build output (its [build] command builds it), and the wizard found no source for it (it edits only source files): add this to the source the bundle is built from.");
  assert.deepEqual(hono.plan(d, input(none)).changes, []);
  // Without a [build] command, a package.json script that writes main (esbuild --outfile, --outdir) says the same.
  for (const build of ["esbuild src/worker.ts --bundle --outfile=bundle/worker.js", "esbuild src/w.ts --bundle --outdir bundle"]) {
    const only = fixture({ ...omit(worker({ "wrangler.toml": 'name = "shop"\nmain = "bundle/worker.js"\n' }), "src/worker.ts"), "package.json": pkg({ scripts: { build }, dependencies: { hono: "^4.13.11" } }) });
    const o = hono.detect(only, only);
    assert.equal(o.data.appFile, null, build);
    assert.equal(o.parts.server.manualReason, "wrangler's main, bundle/worker.js, is build output (the package.json script \"build\" names it as an output), and the wizard found no source for it (it edits only source files): add this to the source the bundle is built from.");
  }
  // A script that only reads main or its folder (a linter, wrangler dev) does not build it: a JavaScript main stays the app.
  const js = fixture({ "package.json": pkg({ scripts: { lint: "eslint src", dev: "wrangler dev src/index.js" }, dependencies: { hono: "^4.13.11" } }), "package-lock.json": "{}", "wrangler.toml": 'name = "shop"\nmain = "src/index.js"\n', "src/index.js": BASIC });
  assert.equal(hono.detect(js, js).data.appFile, "src/index.js");
  // A TypeScript main is the source wrangler bundles itself: a [build] command beside it (code generation) changes nothing.
  const ts = fixture({ ...omit(TEMPLATES["cloudflare-workers"], "wrangler.jsonc"), "wrangler.toml": 'name = "shop"\nmain = "src/index.ts"\n[build]\ncommand = "npm run codegen"\n', "package-lock.json": "{}" });
  assert.equal(hono.detect(ts, ts).data.appFile, "src/index.ts");
});

test("a page in a plain template string is a step by hand, not 'belongs in your frontend'; nested build folders and Vite's outDir are not pages", () => {
  const plain = "import { Hono } from 'hono'\nconst app = new Hono()\napp.get('/', (c) => c.html(`<html><head><title>x</title></head><body></body></html>`))\nexport default app\n";
  const dir = fixture({ ...TEMPLATES.bun, "src/index.ts": plain, "package-lock.json": "{}" });
  const d = hono.detect(dir, dir);
  assert.deepEqual(d.parts.browser, { file: "src/index.ts", kind: "hono-layout" });
  const p = hono.plan(d, input(dir));
  // Bun reads .env by itself, so the token goes there too.
  assert.deepEqual(p.changes.map((c) => [c.path, c.purpose]), [["src/index.ts", "server part"], [".env", "ownership token"]]);
  const m = p.manual.find((x) => x.part === "browser");
  assert.equal(m.reason, "The page's <head> is in a plain string, which the wizard does not edit (it edits a JSX <head> or an html`…` template): add the tag to it by hand.");
  assert.equal(hono.hostNotes(d, { id: "unknown" }, { browser: true, server: true, unitHasBrowser: true }).some((n) => n.includes("belongs in your frontend")), false);
  // Build output anywhere under the app (dist/, build/, out/, a Vite outDir) holds no page layout.
  const LAYOUT = "import { html } from 'hono/html'\nexport const l = html`<html><head></head></html>`\n";
  const built = fixture({ ...TEMPLATES["cloudflare-pages"], "package-lock.json": "{}", "src/dist/layout.js": LAYOUT, "api/build/layout.js": LAYOUT, "src/out/x/layout.mjs": LAYOUT, "src/static/assets/page.js": LAYOUT, "vite.config.ts": "import { defineConfig } from 'vite'\nexport default defineConfig({ build: { outDir: 'src/static' } })\n" });
  assert.equal(hono.detect(built, built).data.layout, "src/renderer.tsx");
  // A Vite outDir the wizard cannot read: a JavaScript layout could be its output (a step by hand); TypeScript never is.
  const unknown = "import { defineConfig } from 'vite'\nexport default defineConfig({ build: { outDir: process.env.OUT } })\n";
  const js = fixture({ ...TEMPLATES.nodejs, "package-lock.json": "{}", "src/layout.js": LAYOUT, "vite.config.ts": unknown });
  const jd = hono.detect(js, js);
  assert.equal(jd.data.layout, null);
  assert.match(jd.parts.browser.manualReason, /^The wizard could not read where vite\.config\.ts builds to/);
  const tsx = fixture({ ...TEMPLATES["cloudflare-pages"], "package-lock.json": "{}", "vite.config.ts": unknown });
  assert.equal(hono.detect(tsx, tsx).data.layout, "src/renderer.tsx");
});

test("Deno without a package.json is declined with the guide; OpenAPIHono is an app like new Hono(); a file with the wizard's own tag is not named as left without one", async () => {
  for (const config of ["deno.json", "deno.jsonc"]) {
    const deno = fixture({ [config]: '{ "imports": { "hono": "jsr:@hono/hono@^4" } }', "main.ts": "import { Hono } from 'hono'\nconst app = new Hono()\nDeno.serve(app.fetch)\n" });
    const scan = scanApps(deno);
    assert.equal(scan.units.length, 0);
    await assert.rejects(selectUnits(scan, [], { multiselect: async () => [] }, "install"), (e) => e.code === "declined" && /^Hono on Deno is not covered by the wizard yet/.test(e.message) && e.message.includes("https://gateway.parlox.io/install.md"));
  }
  const api = "import { OpenAPIHono } from '@hono/zod-openapi'\nimport type { Context } from 'hono'\n\nconst app = new OpenAPIHono()\n\napp.get('/', (c: Context) => c.text('x'))\n\nexport default app\n";
  const oa = fixture({ "package.json": pkg({ scripts: { dev: "tsx watch src/index.ts" }, dependencies: { hono: "^4.13.11", "@hono/zod-openapi": "^1.0.0", "@hono/node-server": "^2.1.3" } }), "package-lock.json": "{}", "src/index.ts": api });
  const od = hono.detect(oa, oa);
  assert.equal(od.data.appFile, "src/index.ts");
  const change = hono.plan(od, input(oa)).changes[0];
  assert.ok(change.after.includes("const app = new OpenAPIHono()\napp.use(parlox())\n"), change.after);
  assert.equal(removeUseLine(change.after, "src/index.ts", "@parlox/server/hono").code, api);
  // The wizard's tag in the layout (an earlier run), then a tag pasted elsewhere: the note does not say the layout lacks one.
  const dir = fixture({ ...TEMPLATES["cloudflare-pages"], "package-lock.json": "{}" });
  applyPlan(dir, hono.plan(hono.detect(dir, dir), input(dir)));
  writeFileSync(join(dir, "src/other.ts"), `export const x = '${headTag(PK)}'\n`);
  assert.deepEqual(hono.detect(dir, dir).notes, ["src/other.ts: A Parlox tag is already in this file, on line 1; it was left as it is."]);
});

// ---- A Vite config naming PARLOX, the runtime-secret sentence, --config on Workers, wrangler's inline build ----

const NODE_PKG = pkg({ scripts: { dev: "tsx watch src/index.ts" }, dependencies: { hono: "^4.13.11", "@hono/node-server": "^2.1.3" } });
const DEFINES_KEY = "import { defineConfig } from 'vite'\nexport default defineConfig({ define: { K: JSON.stringify(process.env.PARLOX_SECRET_KEY) } })\n";

test("a Vite config that names PARLOX withholds the key whatever the target, though Vite is neither declared nor run", () => {
  for (const [label, files, why] of [
    ["A3, vite.config.ts in the folder", { "vite.config.ts": DEFINES_KEY }, /^Hono: no server part was added\. vite\.config\.ts names PARLOX_SECRET_KEY \(line 2\)/],
    ["A4, client/vite.config.ts below it", { "client/vite.config.ts": DEFINES_KEY }, /^Hono: no server part was added\. In client\/: vite\.config\.ts names PARLOX_SECRET_KEY \(line 2\)/],
  ]) {
    const [u] = scanApps(fixture({ "package.json": NODE_PKG, "package-lock.json": "{}", "src/index.ts": BASIC, ...files })).units;
    assert.equal(u.server, null, label);
    assert.match(u.warnings[0], why, label);
    assert.equal(hostStepFor(u, { id: "unknown" }), false, label);
  }
});

test("the runtime-secret sentence is said on Workers (Hono's Workers target; not Express), never on Pages or in the shared hand-off", () => {
  const role = { browser: false, server: true, unitHasBrowser: true };
  const workers = fixture({ ...TEMPLATES["cloudflare-workers"], "package-lock.json": "{}" });
  assert.ok(hono.hostNotes(hono.detect(workers, workers), { id: "cloudflare" }, role).includes(RUNTIME_SECRET));
  const pages = fixture({ ...TEMPLATES["cloudflare-pages"], "package-lock.json": "{}" });
  assert.equal(hono.hostNotes(hono.detect(pages, pages), { id: "cloudflare" }, role).includes(RUNTIME_SECRET), false);
  assert.equal(detectHost(workers, workers).where, "Workers & Pages → your Worker → Settings → Variables and Secrets → Add");
  const SRV = "import express from 'express'\nconst app = express()\nexport default app\n";
  const exp = (wrangler) => { const dir = fixture({ "package.json": pkg({ scripts: { start: "node server.js" }, dependencies: { express: "^5.1.0" } }), "package-lock.json": "{}", "server.js": SRV, ...wrangler }); return express.hostNotes(express.detect(dir, dir), { id: "cloudflare" }, role); };
  assert.equal(exp({ "wrangler.toml": 'name = "shop"\nmain = "server.js"\n' }).includes(RUNTIME_SECRET), false, "Express under wrangler: no sentence");
  assert.equal(exp({ "wrangler.toml": 'name = "shop"\npages_build_output_dir = "./dist"\n' }).includes(RUNTIME_SECRET), false);
  assert.equal(exp({}).includes(RUNTIME_SECRET), false);
});

test("on Workers, a build that gives Vite another config with --config or -c is withheld, as on every host", () => {
  for (const flag of ["--config vite.prod.config.ts", "--config=vite.prod.config.ts", "-c vite.prod.config.ts"]) {
    const dir = fixture({ ...WV, "package.json": pkg({ scripts: { build: `vite build ${flag}` }, dependencies: { hono: "^4.13.12" }, devDependencies: { vite: "^8.1.4", wrangler: "^4.110.0" } }), "vite.prod.config.ts": "import { defineConfig } from 'vite'\nexport default defineConfig({ envPrefix: 'PARLOX_' })\n" });
    const [u] = scanApps(dir).units;
    assert.equal(u.server, null, flag);
    assert.match(u.warnings[0], /^Hono: no server part was added\. /, flag);
  }
  // One the wizard cannot read is not shown not to.
  const missing = fixture({ ...WV, "package.json": pkg({ scripts: { build: "vite build --config ../elsewhere/vite.config.ts" }, dependencies: { hono: "^4.13.12" }, devDependencies: { vite: "^8.1.4" } }) });
  assert.equal(scanApps(missing).units[0].server, null);
  // A --config file that names no PARLOX variable is still one the default-config guard does not read.
  const plain = fixture({ ...WV, "package.json": pkg({ scripts: { build: "vite build -c vite.prod.config.ts" }, dependencies: { hono: "^4.13.12" }, devDependencies: { vite: "^8.1.4" } }), "vite.prod.config.ts": "export default {}\n" });
  assert.equal(scanApps(plain).units[0].server, null);
});

test("wrangler.toml's inline `build = { command = … }` makes main build output too", () => {
  const dir = fixture({ "package.json": pkg({ dependencies: { hono: "^4.13.11" } }), "package-lock.json": "{}", "wrangler.toml": 'name = "shop"\nmain = "bundle/worker.js"\nbuild = { command = "npm run build" }\n', "bundle/worker.js": "import { Hono } from 'hono'\nconst app = new Hono()\nexport default app\n", "src/worker.ts": BASIC });
  const d = hono.detect(dir, dir);
  assert.equal(d.data.appFile, "src/worker.ts");
  assert.deepEqual(hono.plan(d, input(dir)).changes.map((c) => c.path), ["src/worker.ts"]);
});
