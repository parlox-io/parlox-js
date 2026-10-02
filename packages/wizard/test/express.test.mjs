import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { scriptFile, serverFileCandidates, findServerFile, importsModule } from "../dist/scripts.js";
import { addUseLine, removeUseLine } from "../dist/edits/use-line.js";
import { express } from "../dist/integrations/express.js";
import { INTEGRATIONS } from "../dist/integrations/registry.js";
import { readText } from "../dist/workspace.js";
import { readInside } from "../dist/fs-safe.js";
import { ownReporting } from "../dist/own-reporting.js";
import { describeUnit, hostStepFor, planUnit, scanApps } from "../dist/apps.js";
import { netlifyCommands } from "../dist/integrations/vite-react.js";
import { main } from "../dist/cli.js";
import { HANDOFF_TITLE } from "../dist/ui/handoff.js";
import { startFakeAuth, startFakeGateway } from "./fake-servers.mjs";
import { SERVER_VERSION } from "../dist/versions.js";
import { fixture } from "./helpers.mjs";

// app.js and bin/www as express-generator 4.16.1 writes them (the parts that matter here).
const GEN_APP = `var createError = require('http-errors');
var express = require('express');
var path = require('path');
var cookieParser = require('cookie-parser');
var logger = require('morgan');

var indexRouter = require('./routes/index');
var usersRouter = require('./routes/users');

var app = express();

// view engine setup
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'pug');

app.use(logger('dev'));
app.use('/', indexRouter);

module.exports = app;
`;
const GEN_WWW = "#!/usr/bin/env node\n\nvar app = require('../app');\nvar http = require('http');\nvar server = http.createServer(app);\nserver.listen(3000);\n";
const SPEC = { kind: "express", source: "@parlox/server/express", pkgType: undefined };
const git = { isRepo: () => false, dirty: () => [], isTracked: () => false, isIgnored: () => false };
const reader = (dir) => (rel) => (existsSync(join(dir, rel)) ? readFileSync(join(dir, rel), "utf8") : null);
const generated = (extra = {}) => fixture({
  "package.json": JSON.stringify({ name: "shop", version: "0.0.0", private: true, scripts: { start: "node ./bin/www" }, dependencies: { express: "~4.16.1", pug: "2.0.0-beta11" } }),
  "package-lock.json": "{}", "app.js": GEN_APP, "bin/www": GEN_WWW, ...extra,
});

test("registered after Vite React", () => {
  assert.deepEqual(INTEGRATIONS.map((i) => i.id).slice(0, 3), ["nextjs", "vite-react", "express"]);
});

test("the file a start or dev script runs", () => {
  const cases = {
    "node ./bin/www": "bin/www", "tsx watch src/index.ts": "src/index.ts", "node --watch --env-file=.env server.js": "server.js",
    "node --env-file .env server.js": "server.js", "bun run --hot src/index.ts": "src/index.ts", "nodemon --exec ts-node src/app.ts": "src/app.ts",
    "nodemon -w src src/server.js": "src/server.js", "cross-env PORT=4000 node app.js": "app.js", "dotenvx run -- node index.js": "index.js",
    "ts-node-dev --respawn src/index.ts": "src/index.ts", "vite": null, "wrangler dev": null, 'node -e "require(1)"': null, "tsc && node dist/x.js": null,
  };
  for (const [script, file] of Object.entries(cases)) assert.equal(scriptFile(script), file, script);
});

test("express-generator: bin/www leads to app.js; the use line goes right after `var app = express();`, the require after the others", () => {
  const dir = generated();
  const d = express.detect(dir, dir);
  assert.deepEqual(d.facts, [["Found", "Express 4 · app.js · CommonJS · npm"]]);
  assert.deepEqual(d.parts.server, { file: "app.js", kind: "express" });
  const plan = express.plan(d, { publicKey: "pk_" + "a1".repeat(12), verifyToken: "vt", host: { id: "unknown" }, versions: { browser: "1.0.3", server: SERVER_VERSION }, parts: { browser: false, server: true }, read: reader(dir), git });
  const after = plan.changes.find((c) => c.path === "app.js").after;
  assert.ok(after.includes("var usersRouter = require('./routes/users');\nconst { parlox } = require('@parlox/server/express');\n\nvar app = express();\napp.use(parlox());\n\n// view engine setup"), after);
  assert.deepEqual(plan.install, { command: "npm", args: ["install", "--save-exact", `@parlox/server@${SERVER_VERSION}`] });
  assert.equal(removeUseLine(after, "app.js", SPEC.source).code, GEN_APP, "uninstall gives back the exact bytes");
  assert.equal(addUseLine(after, "app.js", SPEC).changed, false, "a second run changes nothing");
});

test("ES modules and TypeScript: an import; inside a factory function the use line keeps its indentation", () => {
  const ts = `import express, { type Express } from "express";\nimport { routes } from "./routes.js";\n\nexport function createApp(): Express {\n  const app = express();\n  app.use(routes);\n  return app;\n}\n`;
  const e = addUseLine(ts, "src/app.ts", SPEC);
  assert.equal(e.code, `import express, { type Express } from "express";\nimport { routes } from "./routes.js";\nimport { parlox } from "@parlox/server/express";\n\nexport function createApp(): Express {\n  const app = express();\n  app.use(parlox());\n  app.use(routes);\n  return app;\n}\n`);
  assert.equal(removeUseLine(e.code, "src/app.ts", SPEC.source).code, ts);
  const cjsInModulePkg = "const express = require('express')\nconst app = express()\nmodule.exports = app\n";
  assert.match(addUseLine(cjsInModulePkg, "server.cjs", { ...SPEC, pkgType: "module" }).code, /const \{ parlox \} = require\('@parlox\/server\/express'\)\n/, ".cjs is CommonJS, whatever package.json says");
  const renamed = "import createServer from 'express';\nconst server = createServer();\n";
  assert.match(addUseLine(renamed, "a.mjs", SPEC).code, /server\.use\(parlox\(\)\);?\n/);
});

test("what cannot be edited safely is a snippet: two apps, none, a Router only, code after the declaration, a name taken", () => {
  for (const [code, why] of [
    ["const express = require('express');\nconst a = express();\nconst b = express();\n", /more than once/],
    ["const express = require('express');\nconst r = express.Router();\n", /No express\(\) call assigned to a variable/],
    ["const express = require('express');\nconst app = express(); app.get('/', h);\n", /more code after it/],
    ["const express = require('express');\nconst parlox = 1;\nconst app = express();\n", /already has something named parlox/],
    ["const express = require('express')\nconst app = express(\n", /could not read/],
  ]) {
    const e = addUseLine(code, "x.js", SPEC);
    assert.equal(e.ok, false, code);
    assert.match(e.reason, why);
    assert.match(e.snippet, /app\.use\(parlox\(\)\)/);
  }
});

test("NestJS and Express 3 are declined and pointed to the guide", () => {
  const dir = fixture({ "package.json": JSON.stringify({ dependencies: { express: "^5.1.0", "@nestjs/core": "^11.0.0" } }), "package-lock.json": "{}" });
  assert.throws(() => express.detect(dir, dir), (e) => e.code === "declined" && /NestJS/.test(e.message) && /install\.md/.test(e.message));
  const old = fixture({ "package.json": JSON.stringify({ dependencies: { express: "3.21.2" } }), "package-lock.json": "{}" });
  assert.throws(() => express.detect(old, old), (e) => e.code === "declined" && /Express 3 is not covered/.test(e.message));
});

test("no server file found: a snippet naming where the wizard looked", () => {
  const dir = fixture({ "package.json": JSON.stringify({ dependencies: { express: "^5.1.0" } }), "package-lock.json": "{}", "lib/boot.js": "module.exports = 1\n" });
  const d = express.detect(dir, dir);
  assert.equal(d.parts.server.file, null);
  assert.match(d.parts.server.manualReason, /the files the start and dev scripts run, main, and server, index and app files/);
});

// Windows line endings (git autocrlf).
test("a CRLF server file gets CRLF lines, and uninstall restores its exact bytes", () => {
  const crlf = GEN_APP.replace(/\n/g, "\r\n");
  const e = addUseLine(crlf, "app.js", SPEC);
  assert.equal(/[^\r]\n/.test(e.code), false, "every line break is CRLF");
  assert.ok(e.code.includes("var app = express();\r\napp.use(parlox());\r\n"));
  assert.equal(removeUseLine(e.code, "app.js", SPEC.source).code, crlf);
});

// A TypeScript app whose start script runs compiled output.
test("`start: node dist/server.js` with `dev: tsx watch src/server.ts` edits src/server.ts, never dist/", () => {
  const src = `import express from "express";\n\nconst app = express();\napp.get("/", (_req, res) => res.send("ok"));\napp.listen(3000);\n`;
  const dir = fixture({
    "package.json": JSON.stringify({ type: "module", scripts: { build: "tsc", start: "node dist/server.js", dev: "tsx watch src/server.ts" }, dependencies: { express: "^5.1.0" } }),
    "package-lock.json": "{}", "tsconfig.json": "{}", "src/server.ts": src, "dist/server.js": "import express from 'express';\nconst app = express();\n",
  });
  const read = readText(dir);
  assert.deepEqual(serverFileCandidates(read, JSON.parse(read("package.json"))), ["src/server.ts"]);
  const d = express.detect(dir, dir);
  assert.equal(d.parts.server.file, "src/server.ts");
  assert.match(d.facts[0][1], /Express 5 · src\/server\.ts · ES modules/);
});

test("importsModule and findServerFile follow one local require to the file that creates the app", () => {
  assert.equal(importsModule("const e = require('express')", "a.js", ["express"]), true);
  assert.equal(importsModule("import x from 'express-session'", "a.js", ["express"]), false);
  const files = { "bin/www": GEN_WWW, "app.js": GEN_APP };
  const found = findServerFile((r) => files[r] ?? null, ["bin/www"], (code, file) => importsModule(code, file, ["express"]));
  assert.equal(found.file, "app.js");
});

// ---- Server files, module systems, names and line breaks ----

const PK = "pk_" + "a1".repeat(12);
const input = (dir, extra = {}) => ({ publicKey: PK, verifyToken: "vt", host: { id: "unknown" }, versions: { browser: "1.0.3", server: SERVER_VERSION }, parts: { browser: false, server: true }, read: reader(dir), git, ...extra });

test("the server file is the one that creates the app: a required router that imports express is passed over", () => {
  const dir = fixture({
    "package.json": JSON.stringify({ main: "index.js", dependencies: { express: "^4.21.0" } }), "package-lock.json": "{}",
    "index.js": "const routes = require('./routes');\nconst app = require('./app');\napp.listen(3000);\n",
    "routes.js": "const express = require('express');\nmodule.exports = express.Router();\n",
    "app.js": "const express = require('express');\nconst app = express();\nmodule.exports = app;\n",
  });
  assert.equal(express.detect(dir, dir).parts.server.file, "app.js");
  // A file that imports express but creates the app some other way is still named, so the snippet says why.
  const odd = fixture({ "package.json": JSON.stringify({ dependencies: { express: "^4.21.0" } }), "package-lock.json": "{}", "server.js": "const express = require('express');\nmodule.exports = express();\n" });
  const d = express.detect(odd, odd);
  assert.equal(d.parts.server.file, "server.js");
  assert.match(express.plan(d, input(odd)).manual[0].reason, /No express\(\) call assigned to a variable/);
});

test("Express 6 or later is declined until a wizard release covers it; an unknown version is detected", () => {
  const next = fixture({ "package.json": JSON.stringify({ dependencies: { express: "^6.0.0" } }), "package-lock.json": "{}" });
  assert.throws(() => express.detect(next, next), (e) => e.code === "declined" && /Express 6 is not covered by the wizard \(Express 4 and 5 are\)/.test(e.message));
  const any = fixture({ "package.json": JSON.stringify({ dependencies: { express: "latest" } }), "package-lock.json": "{}", "server.js": "const express = require('express');\nconst app = express();\n" });
  assert.equal(express.detect(any, any).facts[0][1], "Express · server.js · CommonJS · npm");
});

test("`import * as express` and TypeScript's `import express = require()` create an app too", () => {
  const ns = addUseLine("import * as express from 'express';\nconst app = express();\n", "a.ts", SPEC);
  assert.equal(ns.code, "import * as express from 'express';\nimport { parlox } from '@parlox/server/express';\nconst app = express();\napp.use(parlox());\n");
  const eq = "import express = require('express');\nconst app = express();\n";
  const e = addUseLine(eq, "a.ts", SPEC);
  assert.equal(e.code, "import express = require('express');\nimport parloxServer = require('@parlox/server/express');\nconst app = express();\napp.use(parloxServer.parlox());\n", "an import-equals file gets the same form");
  assert.equal(removeUseLine(e.code, "a.ts", SPEC.source).code, eq);
  assert.equal(addUseLine(e.code, "a.ts", SPEC).changed, false);
});

test("the app's name is written only when it is a plain identifier; the name parlox used anywhere is a snippet", () => {
  const unicode = addUseLine("const express = require('express');\nconst café = express();\n", "x.js", SPEC);
  assert.equal(unicode.ok, false);
  assert.match(unicode.reason, /café/);
  const param = addUseLine("const express = require('express');\nfunction make(parlox) {\n  const app = express();\n  return app;\n}\n", "x.js", SPEC);
  assert.equal(param.ok, false);
  assert.match(param.reason, /uses the name parlox on line 2/);
  const prop = addUseLine("const express = require('express');\nconst cfg = { parlox: 1 };\nconst app = express();\n", "x.js", SPEC);
  assert.equal(prop.ok, true, "a property named parlox is not the name");
});

test("a line break the wizard does not edit around (a lone CR, U+2028) is a snippet with the reason, never an error", () => {
  for (const code of ["const express = require('express');\rconst app = express();\n", "const express = require('express');\nconst s = ' ';\nconst app = express();\n"]) {
    const e = addUseLine(code, "x.js", SPEC);
    assert.equal(e.ok, false, JSON.stringify(code));
    assert.match(e.reason, /line break the wizard does not edit around/);
    assert.match(e.snippet, /app\.use\(parlox\(\)\)/);
  }
  const installed = addUseLine("const express = require('express');\nconst app = express();\n", "x.js", SPEC).code;
  const r = removeUseLine(installed.replace("const app", "const s = ' ';\nconst app"), "x.js", SPEC.source);
  assert.equal(r.ok, false);
  assert.match(r.reason, /line break the wizard does not edit around/);
});

test("an added line that would run into the next one (no semicolons, a line starting with a parenthesis) is a snippet", () => {
  for (const code of [
    "const express = require('express')\nconst app = express();\n(async () => {})()\n",
    "const express = require('express')\nconst path = require('path');\n(function () {})()\nconst app = express()\n",
  ]) {
    const e = addUseLine(code, "x.js", SPEC);
    assert.equal(e.ok, false, code);
    assert.match(e.reason, /would run into the line after it/);
  }
});

test("Parlox imported here in another shape (a namespace, with options) is left as it is", () => {
  const ns = "import * as px from '@parlox/server/express';\nimport express from 'express';\nconst app = express();\napp.use(px.parlox());\n";
  const e = addUseLine(ns, "a.mjs", SPEC);
  assert.equal(e.ok, false);
  assert.match(e.reason, /imported here in a way the wizard did not write/);
  const opts = "const express = require('express');\nconst { parlox } = require('@parlox/server/express');\nconst app = express();\napp.use(parlox({ ipHeader: 'x-real-ip' }));\n";
  assert.deepEqual(addUseLine(opts, "x.js", SPEC), { ok: true, code: opts, changed: false });
  assert.match(removeUseLine(opts, "x.js", SPEC.source).reason, /did not write/);
});

test("uninstall: the server file back byte for byte, and @parlox/server removed", () => {
  const dir = generated();
  const plan = express.plan(express.detect(dir, dir), input(dir));
  writeFileSync(join(dir, "app.js"), plan.changes[0].after);
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  pkg.dependencies["@parlox/server"] = SERVER_VERSION;
  writeFileSync(join(dir, "package.json"), JSON.stringify(pkg));
  const back = express.unplan(express.detect(dir, dir), { read: reader(dir), git });
  assert.deepEqual(back.changes.map((c) => [c.path, c.after]), [["app.js", GEN_APP]]);
  assert.deepEqual(back.install, { command: "npm", args: ["uninstall", "@parlox/server"] });
});

test("a server file the wizard may not write through (a symlink) is a step by hand, never the end of the run", { skip: process.platform === "win32" }, () => {
  const outside = fixture({ "app.js": GEN_APP });
  const linked = fixture({ "package.json": JSON.stringify({ dependencies: { express: "~4.16.1" } }), "package-lock.json": "{}" });
  symlinkSync(join(outside, "app.js"), join(linked, "app.js"), "file");
  const d = express.detect(linked, linked);
  assert.equal(d.parts.server.file, "app.js");
  const inside = (f) => readInside(linked, f);
  const plan = express.plan(d, input(linked, { read: inside }));
  assert.deepEqual(plan.changes, []);
  assert.match(plan.manual[0].reason, /Refusing app\.js/);
  assert.match(express.unplan(d, { read: inside, git }).manual[0].reason, /Refusing app\.js/);
});

// ---- An app that already reports to Parlox with its own code ----

// A store that posts to /v1/s itself after the response, with the key.
const OWN_APP = [
  'import express from "express";',
  "",
  'const GATEWAY = process.env.PARLOX_GATEWAY ?? "https://gateway.parlox.io";',
  "const app = express();",
  "",
  "app.use((req, res, next) => {",
  '  res.on("finish", () => {',
  "    if (!process.env.PARLOX_SECRET_KEY) return;",
  '    fetch(`${GATEWAY}/v1/s`, { method: "POST", headers: { authorization: `Bearer ${process.env.PARLOX_SECRET_KEY}` } }).catch(() => {});',
  "  });",
  "  next();",
  "});",
  "",
].join("\n");
const OWN_WARNING = "This app already reports to Parlox with its own code (src/app.mjs:9). Adding the server part would count visits twice: remove that code, then run the wizard again.";
const ownApp = () => fixture({
  "package.json": JSON.stringify({ name: "shop", type: "module", scripts: { start: "node src/app.mjs" }, dependencies: { express: "^5.1.0" } }),
  "package-lock.json": "{}", "src/app.mjs": OWN_APP,
});

test("an app with its own /v1/s call gets no server part, no key and no hand-off; the warning names the file and line", () => {
  const dir = ownApp();
  const d = express.detect(dir, dir);
  assert.deepEqual(d.parts.server, { file: "src/app.mjs", kind: "own-report" });
  assert.deepEqual(d.notes, [OWN_WARNING], "repeated in the report");
  const plan = express.plan(d, input(dir));
  assert.deepEqual(plan, { changes: [], install: null, manual: [], warnings: [OWN_WARNING] }, "shown in the review");
  assert.equal(express.hostStep(d, { id: "vercel" }), false);
  assert.deepEqual(express.hostNotes(d, { id: "unknown" }, { browser: false, server: true, unitHasBrowser: false }), []);
  const [u] = scanApps(dir).units;
  assert.equal(hostStepFor(u, { id: "vercel" }), false);
  assert.equal(describeUnit(u), "./ · Express · no server part (it reports to Parlox with its own code)");
  assert.equal(express.hostStep(express.detect(generated(), generated()), { id: "vercel" }), true, "an ordinary Express app has the host step");
});

test("ownReporting: a use of PARLOX_SECRET_KEY counts; the SDK's own files, types, comments, tests, other packages and build output do not", () => {
  assert.deepEqual(ownReporting(fixture({ "package.json": "{}", "server.js": "const express = require('express');\nconst key = process.env['PARLOX_SECRET_KEY'];\n" })).found, { file: "server.js", line: 2 });
  assert.deepEqual(ownReporting(fixture({ "src/a.ts": "const { PARLOX_SECRET_KEY } = process.env;\n" })).found, { file: "src/a.ts", line: 1 });
  const report = "fetch('https://gateway.parlox.io/v1/s', { method: 'POST' });\n";
  assert.deepEqual(ownReporting(fixture({
    "package.json": "{}",
    "src/with-sdk.ts": "import { parlox } from '@parlox/server/express';\nexport const p = parlox({ secretKey: process.env.PARLOX_SECRET_KEY });\n",
    "src/purchase.cjs": "const { purchase } = require('@parlox/server');\nmodule.exports = (o) => purchase({ key: process.env.PARLOX_SECRET_KEY, ...o });\n",
    "src/types.ts": "export type Bindings = { PARLOX_SECRET_KEY: string };\nexport interface Env { PARLOX_SECRET_KEY: string }\n",
    "src/env.d.ts": "declare const env: { PARLOX_SECRET_KEY: string };\n",
    "src/notes.js": "// Parlox: set PARLOX_SECRET_KEY on the host; reports go to /v1/s\nexport {};\n",
    "src/routes.js": "app.get('/v1/s', search);\n",
    "test/app.js": "process.env.PARLOX_SECRET_KEY = 'sk_test';\n",
    "src/app.test.mjs": "process.env.PARLOX_SECRET_KEY = 'sk_test';\n",
    "src/__tests__/x.js": report,
    "node_modules/x/index.js": report, "dist/server.js": report, "build/server.js": report, "out/server.js": report, ".cache/a.js": report,
    "tsconfig.json": '{ "compilerOptions": { "outDir": "lib" } }', "lib/server.js": report,
    "web/package.json": "{}", "web/src/report.js": report,
  })), { found: null, notChecked: null });
  // A file the wizard cannot parse still counts by its text.
  assert.deepEqual(ownReporting(fixture({ "src/broken.js": "const x = (;\nfetch('https://gateway.parlox.io/v1/s')\n" })).found, { file: "src/broken.js", line: 2 });
});

test("ownReporting reads at most 200 source files and 500 folders, the app's folder first, then its folders by name; past either, the rest is \"not checked\"", () => {
  const many = { "package.json": "{}", "zz/report.js": "fetch('https://gateway.parlox.io/v1/s')\n" };
  for (let i = 0; i < 200; i++) many[`aa/f${String(i).padStart(3, "0")}.js`] = "export {};\n";
  const capped = ownReporting(fixture(many));
  assert.equal(capped.found, null, "the 201st file is not read");
  assert.match(capped.notChecked, /^Not checked for code of its own that reports to Parlox past the first 200 source files and 500 folders/);
  delete many["aa/f199.js"];
  assert.deepEqual(ownReporting(fixture(many)), { found: { file: "zz/report.js", line: 1 }, notChecked: null });
  const folders = { "package.json": "{}", "zz/report.js": "fetch('https://gateway.parlox.io/v1/s')\n" };
  for (let i = 0; i < 500; i++) folders[`d${String(i).padStart(3, "0")}/README.md`] = "x\n";
  const walked = ownReporting(fixture(folders));
  assert.equal(walked.found, null, "the 501st folder is not opened");
  assert.match(walked.notChecked, /500 folders/);
  // Said in the review and the report, and the server part is still planned.
  const dir = fixture({ ...folders, "package-lock.json": "{}", "package.json": JSON.stringify({ dependencies: { express: "^5.1.0" } }), "server.js": "const express = require('express');\nconst app = express();\n" });
  const d = express.detect(dir, dir);
  assert.equal(d.parts.server.kind, "express");
  assert.match(d.notes.join("\n"), /^Not checked for code of its own/);
  assert.match(express.plan(d, input(dir)).warnings.join("\n"), /^Not checked for code of its own/);
});

test("`--yes` on an app with its own reporting: the warning in the review (nothing else to change) and the report; no key, no hand-off, nothing written", async (t) => {
  const auth = await startFakeAuth({ decide: "approve" });
  const gw = await startFakeGateway({ sites: [{ id: "11111111-1111-1111-1111-111111111111", name: "Shop", domain: "shop.example.com", public_key: PK, verified: false }], keys: [] });
  t.after(() => { auth.close(); gw.close(); });
  const dir = ownApp();
  const out = [];
  const ui = { info: (m) => out.push(m), warn: (m) => out.push(`WARN ${m}`), confirm: async () => true, select: async (_m, o) => o[0].value, text: async () => "" };
  const config = { gateway: gw.url, supabaseUrl: auth.url, clientId: "wiz", apiKey: "test-publishable-key", ports: [53832, 53833], dashboard: "https://app.parlox.io" };
  const runs = [];
  const deps = { cwd: dir, config, ui, open: (url) => { fetch(url).catch(() => {}); }, run: (cmd, args) => { runs.push([cmd, ...args]); return { status: 0, stdout: "", stderr: "" }; } };
  assert.equal(await main(["--yes", "--allow-no-git", "--site", "shop.example.com", "--skip-check"], deps), 0, out.join("\n"));
  const nothing = out.indexOf("Nothing to change.");
  assert.ok(nothing >= 0 && out.indexOf(`WARN ${OWN_WARNING}`) > nothing, out.join("\n"));
  assert.ok(out.at(-1).split("\n").includes(OWN_WARNING), out.at(-1));
  assert.deepEqual(gw.state.keys, [], "no key is created");
  assert.deepEqual(runs, [], "no package step, no host command");
  assert.equal(out.some((m) => m.includes(HANDOFF_TITLE)), false, "no hand-off");
  assert.equal(readFileSync(join(dir, "src/app.mjs"), "utf8"), OWN_APP);
});

// ---- Security at the app level: a Vite build in the same folder ----

const MAIN = 'import { StrictMode } from "react";\nimport { createRoot } from "react-dom/client";\nimport App from "./App.jsx";\n\ncreateRoot(document.getElementById("root")).render(\n  <StrictMode>\n    <App />\n  </StrictMode>,\n);\n';
const SERVER = "import express from 'express'\n\nconst app = express()\napp.use(express.static('dist'))\napp.listen(3000)\n";
const viteExpress = (config) => fixture({
  "package.json": JSON.stringify({ name: "shop", type: "module", scripts: { dev: "vite", build: "vite build", start: "node server.js" }, dependencies: { express: "^5.1.0", react: "^19.2.0", "react-dom": "^19.2.0" }, devDependencies: { "@vitejs/plugin-react": "^5.1.0", vite: "^7.2.0" } }),
  "package-lock.json": "{}",
  "index.html": '<!doctype html>\n<html>\n  <head></head>\n  <body>\n    <div id="root"></div>\n    <script type="module" src="/src/main.jsx"></script>\n  </body>\n</html>\n',
  "src/main.jsx": MAIN, "src/App.jsx": "export default function App() {\n  return null\n}\n", "vite.config.js": config, "server.js": SERVER,
});
const VITE_SAFE = "import { defineConfig } from 'vite'\nimport react from '@vitejs/plugin-react'\n\nexport default defineConfig({\n  plugins: [react()],\n})\n";
const VITE_EXPOSED = "import { defineConfig } from 'vite'\nimport react from '@vitejs/plugin-react'\n\nexport default defineConfig({\n  plugins: [react()],\n  envPrefix: ['VITE_', 'PARLOX_'],\n})\n";
const unitInput = { publicKey: PK, verifyToken: "vt", host: { id: "unknown" } };
const DASHBOARD = "Express: the wizard read the build commands in package.json, vercel.json and netlify.toml, but build and install commands set in your host's dashboard (on Vercel: the Build Command, Install Command and Ignored Build Step) are not visible to it. If one of them runs a Vite build or other build code, make sure it cannot read PARLOX_SECRET_KEY: see https://gateway.parlox.io/install.md";

test("Vite React and Express in one folder: the browser part in the Vite entry, the server part in the Express file", () => {
  const dir = viteExpress(VITE_SAFE);
  const [u] = scanApps(dir).units;
  assert.equal(u.browser.integration, "vite-react");
  assert.equal(u.server.integration, "express");
  assert.deepEqual(u.warnings, [DASHBOARD], "the dashboard is not visible: said in the review and the report");
  assert.equal(describeUnit(u), "./ · Vite React + Express · browser and server parts");
  const plan = planUnit(u, unitInput, { read: reader(dir), git });
  assert.deepEqual(plan.changes.map((c) => c.path).sort(), ["server.js", "src/main.jsx"]);
  assert.match(plan.changes.find((c) => c.path === "server.js").after, /const app = express\(\)\napp\.use\(parlox\(\)\)\n/);
  assert.ok(plan.install.args.includes(`@parlox/server@${SERVER_VERSION}`));
  assert.equal(hostStepFor(u, { id: "render" }), true);
});

test("when the folder's Vite build could bundle PARLOX_SECRET_KEY, the Express server part gets no edit, no key and no host step; the warning says why", () => {
  const dir = viteExpress(VITE_EXPOSED);
  const [u] = scanApps(dir).units;
  assert.equal(u.server, null);
  assert.equal(u.warnings.length, 1);
  assert.match(u.warnings[0], /^Express: no server part was added\. Your Vite config lists PARLOX_ in envPrefix, so the secret key would be bundled into the browser code\. A PARLOX_SECRET_KEY set on the host for this server could also reach this folder's Vite build \(hosts usually give the build the same variables\)\. Remove PARLOX_ from envPrefix and run the wizard again to add the server part\.$/);
  assert.equal(hostStepFor(u, { id: "render" }), false);
  assert.equal(describeUnit(u), "./ · Vite React + Express · browser part");
  const plan = planUnit(u, unitInput, { read: reader(dir), git });
  assert.deepEqual(plan.changes.map((c) => c.path), ["src/main.jsx"]);
  assert.equal(plan.install.args.some((a) => a.startsWith("@parlox/server")), false);
});

// ---- Any Vite build in the folder, compiled output, dev helpers, the SDK's own key option ----

const SRV_TS = "import express from 'express';\nconst app = express();\napp.listen(3000);\n";
const SRV_JS = "const express = require('express');\nconst app = express();\napp.listen(3000);\n";
const serverOf = (files) => { const dir = fixture({ "package-lock.json": "{}", ...files }); return express.detect(dir, dir).parts.server.file; };
const expressPkg = (extra) => JSON.stringify({ dependencies: { express: "^5.1.0" }, ...extra });

test("any Vite build in the folder, whatever its framework, is checked before an Express server part gets a key", () => {
  const withServer = (pkg, files) => fixture({ "package.json": JSON.stringify({ type: "module", ...pkg }), "package-lock.json": "{}", "server.js": SERVER, ...files });
  const withheld = (u) => {
    assert.equal(u.server, null);
    assert.equal(hostStepFor(u, { id: "render" }), false);
    const w = u.warnings.find((x) => x.startsWith("Express: no server part was added."));
    assert.ok(w, u.warnings.join("\n"));
    return w;
  };
  // Vue on Vite with PARLOX_ in envPrefix.
  const vue = withServer({ scripts: { dev: "vite", build: "vite build", start: "node server.js" }, dependencies: { express: "^5.1.0", vue: "^3.5.0" }, devDependencies: { "@vitejs/plugin-vue": "^6.0.0", vite: "^7.2.0" } },
    { "vite.config.js": "import { defineConfig } from 'vite'\nimport vue from '@vitejs/plugin-vue'\n\nexport default defineConfig({\n  plugins: [vue()],\n  envPrefix: ['VITE_', 'PARLOX_'],\n})\n", "index.html": "<div id=app></div><script type=module src=/src/main.js></script>", "src/main.js": "import { createApp } from 'vue'\n" });
  withheld(scanApps(vue).units[0]);
  // Svelte on Vite passing process.env through define.
  const svelte = withServer({ scripts: { build: "vite build", start: "node server.js" }, dependencies: { express: "^4.21.0", svelte: "^5.0.0" }, devDependencies: { vite: "^7.2.0" } },
    { "vite.config.js": "import { defineConfig } from 'vite'\nexport default defineConfig({ define: { 'process.env': process.env } })\n" });
  assert.match(withheld(scanApps(svelte).units[0]), /define/);
  // React Router in framework mode beside a custom Express server: its refusal is a warning, and the guard still runs.
  const rr = withServer({ scripts: { build: "react-router build", start: "node server.js" }, dependencies: { express: "^5.1.0", react: "^19.0.0", "@react-router/express": "^7.0.0" }, devDependencies: { "@react-router/dev": "^7.0.0", vite: "^7.2.0" } },
    { "vite.config.ts": "import { reactRouter } from '@react-router/dev/vite'\nimport { defineConfig } from 'vite'\nexport default defineConfig({ plugins: [reactRouter()] })\n" });
  const [r] = scanApps(rr).units;
  withheld(r);
  assert.ok(r.warnings.some((w) => /React Router in framework mode/.test(w)));
  // Vue on Vite with nothing the wizard cannot prove safe: the server part and its key as usual.
  const safe = withServer({ scripts: { dev: "vite", build: "vite build", start: "node server.js" }, dependencies: { express: "^5.1.0", vue: "^3.5.0" }, devDependencies: { vite: "^7.2.0" } },
    { "index.html": "<div id=app></div><script type=module src=/src/main.js></script>", "src/main.js": "import { createApp } from 'vue/dist/vue.esm-bundler.js'\n" });
  const [s] = scanApps(safe).units;
  assert.equal(s.server.integration, "express");
  assert.deepEqual(s.warnings, [DASHBOARD]);
  assert.equal(hostStepFor(s, { id: "render" }), true);
  // No Vite build at all (vite only for its tests): nothing to check.
  const tests = withServer({ scripts: { build: "tsc", start: "node server.js", test: "vitest" }, dependencies: { express: "^5.1.0" }, devDependencies: { vite: "^7.2.0", vitest: "^3.2.0" } },
    { "vite.config.ts": "import { defineConfig } from 'vite'\nexport default defineConfig({ test: { environment: 'node' } })\n" });
  assert.equal(scanApps(tests).units[0].server.integration, "express");
});

test("compiled output is never edited: dist/ and lib/ reached through a require, tsconfig's outDir, .build, a .js beside its .ts", () => {
  // A launcher that requires the build: the source it is built from.
  assert.equal(serverOf({ "package.json": expressPkg({ scripts: { start: "node index.js" } }), "index.js": "require('./dist/server');\n", "src/server.ts": SRV_TS, "dist/server.js": SRV_JS }), "src/server.ts");
  assert.equal(serverOf({ "package.json": expressPkg({ scripts: { start: "node bin/www" } }), "bin/www": "#!/usr/bin/env node\nvar app = require('../dist/app');\n", "src/app.ts": SRV_TS, "dist/app.js": SRV_JS }), "src/app.ts");
  // tsconfig's outDir (JSON with comments, as tsc writes it), mapped back to rootDir.
  const tsconfig = '{\n  // tsc --init\n  "compilerOptions": {\n    "outDir": "./lib/", /* built here */\n    "rootDir": "./source",\n  },\n}\n';
  assert.equal(serverOf({ "package.json": expressPkg({ main: "lib/server.js", scripts: { start: "node lib/server.js" } }), "tsconfig.json": tsconfig, "source/server.ts": SRV_TS, "lib/server.js": SRV_JS }), "source/server.ts");
  assert.equal(serverOf({ "package.json": expressPkg({ main: "lib/index.js", scripts: { start: "node lib/index.js" } }), "tsconfig.json": JSON.stringify({ compilerOptions: { outDir: "lib" } }), "lib/index.js": SRV_JS }), null, "no source for the build: nothing to edit");
  // .build and other dot-folders.
  assert.equal(serverOf({ "package.json": expressPkg({ scripts: { start: "node .build/server.js" } }), "src/server.ts": SRV_TS, ".build/server.js": SRV_JS }), "src/server.ts");
  // tsc run in place: src/index.js sits beside src/index.ts.
  assert.equal(serverOf({ "package.json": expressPkg({ scripts: { start: "node src/index.js" } }), "tsconfig.json": "{}", "src/index.ts": SRV_TS, "src/index.js": SRV_JS }), "src/index.ts");
  // dist/main.js before any build: src/main.ts; dist/src/server.js (rootDir "."): src/server.ts.
  assert.equal(serverOf({ "package.json": expressPkg({ scripts: { build: "tsc", start: "node dist/main.js" } }), "src/main.ts": SRV_TS }), "src/main.ts");
  assert.equal(serverOf({ "package.json": expressPkg({ scripts: { start: "node dist/src/server.js" } }), "src/server.ts": SRV_TS }), "src/server.ts");
});

test("a server file git ignores is a step by hand", () => {
  const dir = generated();
  const ignored = { ...git, isRepo: () => true, isIgnored: (rel) => rel === "app.js" };
  const plan = express.plan(express.detect(dir, dir), input(dir, { git: ignored }));
  assert.deepEqual(plan.changes, []);
  assert.match(plan.manual[0].reason, /^git ignores app\.js/);
  assert.match(plan.manual[0].snippet, /app\.use\(parlox\(\)\)/);
});

test("Express only in devDependencies beside a Vite React app is a dev helper: the Vercel middleware is the server part; elsewhere a devDependency counts", () => {
  const files = {
    "package.json": JSON.stringify({ type: "module", scripts: { dev: "node server.js", build: "vite build" }, dependencies: { react: "^19.2.0", "react-dom": "^19.2.0" }, devDependencies: { express: "^5.1.0", "@vitejs/plugin-react": "^5.1.0", vite: "^7.2.0" } }),
    "package-lock.json": "{}", "vercel.json": "{}", "index.html": '<div id="root"></div><script type="module" src="/src/main.jsx"></script>', "src/main.jsx": MAIN,
    "vite.config.js": VITE_SAFE,
    "server.js": "import express from 'express'\nimport { createServer } from 'vite'\nconst app = express()\nconst vite = await createServer({ server: { middlewareMode: true } })\napp.use(vite.middlewares)\napp.listen(5173)\n",
  };
  const [u] = scanApps(fixture(files)).units;
  assert.equal(u.server.integration, "vite-react");
  assert.equal(u.server.parts.server.kind, "vercel-edge");
  assert.equal(describeUnit(u), "./ · Vite React + Express · browser part (server part on Vercel)");
  // The same Express in dependencies: Express serves the app.
  const prod = JSON.parse(files["package.json"]);
  prod.dependencies.express = prod.devDependencies.express; delete prod.devDependencies.express;
  assert.equal(scanApps(fixture({ ...files, "package.json": JSON.stringify(prod) })).units[0].server.integration, "express");
  // No Vite React app beside it: a devDependency counts.
  assert.equal(serverOf({ "package.json": JSON.stringify({ devDependencies: { express: "^5.1.0" } }), "server.js": SRV_JS }), "server.js");
});

test("a use of the key alone is not own reporting when @parlox/server is a declared dependency (its secretKey option, an env schema)", () => {
  const zod = { "src/env.ts": "import { z } from 'zod';\nexport const env = z.object({ PARLOX_SECRET_KEY: z.string() }).parse(process.env);\n" };
  const config = { "src/config.js": "export const parloxKey = process.env.PARLOX_SECRET_KEY;\n", "src/server.js": "import { parlox } from '@parlox/server/express';\nimport { parloxKey } from './config.js';\nexport const p = parlox({ secretKey: parloxKey });\n" };
  const sdk = JSON.stringify({ dependencies: { "@parlox/server": "1.0.1" } });
  assert.deepEqual(ownReporting(fixture({ "package.json": sdk, ...zod })).found, null);
  assert.deepEqual(ownReporting(fixture({ "package.json": sdk, ...config })).found, null);
  assert.deepEqual(ownReporting(fixture({ "package.json": "{}", ...zod })).found, { file: "src/env.ts", line: 2 }, "without the SDK it counts");
  // The /v1/s call itself counts either way.
  assert.deepEqual(ownReporting(fixture({ "package.json": sdk, "src/r.js": "fetch('https://gateway.parlox.io/v1/s')\n" })).found, { file: "src/r.js", line: 1 });
});

test("`start: npm run serve` is followed to the script it names", () => {
  assert.equal(serverOf({ "package.json": expressPkg({ scripts: { start: "npm run serve", serve: "node lib/serve.js" } }), "lib/serve.js": SRV_JS }), "lib/serve.js");
  assert.equal(serverOf({ "package.json": expressPkg({ scripts: { dev: "pnpm run watch", watch: "yarn serve", serve: "tsx watch src/serve.ts" } }), "src/serve.ts": SRV_TS }), "src/serve.ts");
  assert.equal(serverOf({ "package.json": expressPkg({ scripts: { start: "npm run start" } }), "lib/x.js": SRV_JS }), null, "a script that runs itself ends");
});

test("a file with no top-level import or require gets its own dominant quote", () => {
  const code = "'use strict';\nmodule.exports = function make() {\n  const express = require('express');\n  const app = express();\n  return app;\n};\n";
  const e = addUseLine(code, "app.js", SPEC);
  assert.equal(e.code, "'use strict';\nconst { parlox } = require('@parlox/server/express');\nmodule.exports = function make() {\n  const express = require('express');\n  const app = express();\n  app.use(parlox());\n  return app;\n};\n");
  assert.equal(removeUseLine(e.code, "app.js", SPEC.source).code, code);
});

// ---- Vite commands in quotes, Vite not declared here, the host's build command, chained scripts ----

const EXPOSING = "import { defineConfig } from 'vite'\nexport default defineConfig({\n  envPrefix: ['VITE_', 'PARLOX_'],\n})\n";
const isWithheld = (dir) => {
  const [u] = scanApps(dir).units;
  return u.server === null && u.warnings.some((w) => w.startsWith("Express: no server part was added.")) && !hostStepFor(u, { id: "render" });
};
const beside = (pkg, files = {}) => fixture({ "package.json": JSON.stringify({ type: "module", ...pkg }), "package-lock.json": "{}", "server.js": SERVER, ...files });

test("a Vite command in quotes, in backticks or with @version counts as running Vite", () => {
  const deps = { dependencies: { express: "^5.1.0", vue: "^3.5.0" }, devDependencies: { vite: "^7.2.0" } };
  for (const build of ['concurrently "vite build" "tsc -p server"', "concurrently 'vite build' 'tsc -p server'", "sh -c `vite build`", "npx vite@7 build", "pnpm dlx vite@latest build"]) {
    assert.ok(isWithheld(beside({ scripts: { build, start: "node server.js" }, ...deps }, { "vite.config.js": EXPOSING })), build);
  }
  for (const build of ["vitest run", "vite-node scripts/x.ts", "tsc -p tsconfig.vite.json"]) {
    assert.equal(isWithheld(beside({ scripts: { build, start: "node server.js" }, dependencies: { express: "^5.1.0" } }, { "vite.config.js": EXPOSING })), false, build);
  }
});

test("Vite not declared in the package: a script that runs it, or a framework built on it, is checked; a config alone counts with vite at the workspace root", () => {
  // vite only in the workspace root's devDependencies, `build: vite build` in the package: no key, from either folder.
  const ws = fixture({
    "package.json": JSON.stringify({ private: true, workspaces: ["apps/*"], devDependencies: { vite: "^7.2.0" } }), "package-lock.json": "{}",
    "apps/web/package.json": JSON.stringify({ name: "web", type: "module", scripts: { build: "vite build", start: "node server.js" }, dependencies: { express: "^5.1.0", vue: "^3.5.0" } }),
    "apps/web/server.js": SERVER, "apps/web/vite.config.js": EXPOSING,
  });
  assert.ok(isWithheld(ws));
  assert.ok(isWithheld(join(ws, "apps/web")));
  // The same with no build script: the config and the root's vite are enough.
  const noBuild = fixture({
    "package.json": JSON.stringify({ private: true, workspaces: ["apps/*"], devDependencies: { vite: "^7.2.0" } }), "package-lock.json": "{}",
    "apps/web/package.json": JSON.stringify({ name: "web", type: "module", scripts: { start: "node server.js" }, dependencies: { express: "^5.1.0" } }),
    "apps/web/server.js": SERVER, "apps/web/vite.config.js": EXPOSING,
  });
  assert.ok(isWithheld(noBuild));
  // Frameworks built on Vite, with vite itself not declared.
  assert.ok(isWithheld(beside({ scripts: { build: "astro build", start: "node server.js" }, dependencies: { express: "^5.1.0", astro: "^5.0.0", "@astrojs/node": "^9.0.0" } })), "Astro");
  assert.ok(isWithheld(beside({ scripts: { build: "nuxt build", start: "node server.js" }, dependencies: { express: "^5.1.0", nuxt: "^4.0.0" } })), "Nuxt");
  assert.ok(isWithheld(beside({ scripts: { start: "node server.js" }, dependencies: { express: "^5.1.0", "@sveltejs/kit": "^2.0.0" } }, { "vite.config.js": "import { sveltekit } from '@sveltejs/kit/vite'\nimport { defineConfig } from 'vite'\nexport default defineConfig({ plugins: [sveltekit()] })\n" })), "SvelteKit with no build script and vite not declared");
});

test("the build command the host runs: vercel.json's buildCommand running Vite counts, though `build` is tsc", () => {
  const deps = { dependencies: { express: "^5.1.0" }, devDependencies: { vite: "^7.2.0" } };
  assert.ok(isWithheld(beside({ scripts: { build: "tsc", start: "node server.js" }, ...deps }, { "vercel.json": JSON.stringify({ buildCommand: "vite build" }), "vite.config.js": EXPOSING })));
  assert.equal(isWithheld(beside({ scripts: { build: "tsc", start: "node server.js" }, ...deps }, { "vercel.json": JSON.stringify({ buildCommand: "tsc" }), "vite.config.js": EXPOSING })), false);
});

test("chained scripts are followed to the server file", () => {
  assert.equal(serverOf({ "package.json": expressPkg({ scripts: { start: "npm run build && npm run serve", build: "tsc", serve: "node lib/serve.js" } }), "lib/serve.js": SRV_JS }), "lib/serve.js");
  assert.equal(serverOf({ "package.json": expressPkg({ scripts: { start: "cross-env NODE_ENV=production npm run serve", serve: "node lib/serve.js" } }), "lib/serve.js": SRV_JS }), "lib/serve.js");
  assert.equal(serverOf({ "package.json": expressPkg({ scripts: { start: "NODE_ENV=production pnpm serve", serve: "node lib/serve.js" } }), "lib/serve.js": SRV_JS }), "lib/serve.js");
  assert.equal(serverOf({ "package.json": expressPkg({ scripts: { start: "tsc && node dist/x.js" } }), "src/x.ts": SRV_TS }), "src/x.ts", "the command after the build, mapped to its source");
});

test("a file with no semicolons and no top-level import or require gets lines without one", () => {
  const code = "module.exports = function make() {\n  const express = require('express')\n  const app = express()\n  return app\n}\n";
  const e = addUseLine(code, "app.js", SPEC);
  assert.equal(e.code, "const { parlox } = require('@parlox/server/express')\nmodule.exports = function make() {\n  const express = require('express')\n  const app = express()\n  app.use(parlox())\n  return app\n}\n");
  assert.equal(removeUseLine(e.code, "app.js", SPEC.source).code, code);
});

// ---- Vite's JavaScript API, Vite below the folder, netlify.toml, the host's dashboard ----

const CLIENT_PKG = JSON.stringify({ scripts: { build: "vite build" }, dependencies: { react: "^19.2.0" }, devDependencies: { vite: "^7.2.0", "@vitejs/plugin-react": "^5.1.0" } });
const mern = (config) => fixture({
  "package.json": JSON.stringify({ scripts: { build: "npm run build --prefix client", start: "node server/index.js" }, dependencies: { express: "^5.1.0" } }), "package-lock.json": "{}",
  "server/index.js": SRV_JS, "client/package.json": CLIENT_PKG, "client/vite.config.js": config, "client/index.html": "<div id=root></div>",
});

test("a build script that drives Vite's JavaScript API is a Vite build with unknown settings: no key", () => {
  const api = beside({ scripts: { build: "node scripts/build.mjs", start: "node server.js" }, dependencies: { express: "^5.1.0" }, devDependencies: { vite: "^7.2.0" } },
    { "scripts/build.mjs": "import { build } from 'vite'\nawait build()\n" });
  assert.ok(isWithheld(api));
  assert.match(scanApps(api).units[0].warnings.join("\n"), /The build runs scripts\/build\.mjs, which uses Vite's JavaScript API/);
  // tsx, through npm run, with a dynamic import, and vite declared nowhere.
  const tsx = beside({ scripts: { build: "npm run bundle", bundle: "tsx scripts/bundle.ts", start: "node server.js" }, dependencies: { express: "^5.1.0" } },
    { "scripts/bundle.ts": "const { build } = await import('vite')\nawait build({})\n" });
  assert.ok(isWithheld(tsx));
  // A build script that does not load Vite is no Vite build.
  assert.equal(isWithheld(beside({ scripts: { build: "node scripts/build.mjs", start: "node server.js" }, dependencies: { express: "^5.1.0" } }, { "scripts/build.mjs": "import { build } from 'esbuild'\n" })), false);
});

test("Vite below the folder: every Vite config found is checked (client/ built with --prefix); a safe one allows the key", () => {
  const exposed = mern(EXPOSING);
  assert.ok(isWithheld(exposed));
  assert.match(scanApps(exposed).units[0].warnings.join("\n"), /In client\/: Your Vite config lists PARLOX_ in envPrefix/);
  const safe = mern(VITE_SAFE);
  const [u] = scanApps(safe).units;
  assert.equal(u.server.integration, "express");
  assert.equal(hostStepFor(u, { id: "render" }), true);
  assert.deepEqual(u.warnings, [DASHBOARD]);
  // Folders past the cap are not checked: no key, and the review and the report say why.
  const deep = { "package.json": JSON.stringify({ dependencies: { express: "^5.1.0" }, devDependencies: { vite: "^7.2.0" } }), "package-lock.json": "{}", "server.js": SRV_JS };
  for (let i = 0; i < 1000; i++) deep[`assets/d${String(i).padStart(4, "0")}/x.txt`] = "x\n";
  const big = fixture(deep);
  assert.ok(isWithheld(big), "a walk that stops at its cap proves nothing: no key, no host step");
  assert.ok(scanApps(big).units[0].warnings.some((w) => /^Express: no server part was added\. The wizard did not look for a Vite build past the first 1000 folders of this app/.test(w)), scanApps(big).units[0].warnings.join("\n"));
});

test("netlify.toml's build command (and the production context's) running Vite counts", () => {
  const deps = { dependencies: { express: "^5.1.0" }, devDependencies: { vite: "^7.2.0" } };
  const toml = (body) => beside({ scripts: { build: "tsc", start: "node server.js" }, ...deps }, { "netlify.toml": body, "vite.config.js": EXPOSING });
  assert.ok(isWithheld(toml('[build]\n  command = "vite build"\n  publish = "dist"\n')), "[build]");
  assert.ok(isWithheld(toml("[build]\ncommand = 'tsc'\n\n[context.production]\ncommand = 'npx vite@7 build'\n")), "[context.production]");
  assert.equal(isWithheld(toml('[build]\ncommand = "tsc"\n')), false);
});

test("the report says that a build command set in the host's dashboard is not visible to the wizard (where a Vite build could run)", async (t) => {
  const auth = await startFakeAuth({ decide: "approve" });
  const gw = await startFakeGateway({ sites: [{ id: "11111111-1111-1111-1111-111111111111", name: "Shop", domain: "shop.example.com", public_key: PK, verified: false }], keys: [] });
  t.after(() => { auth.close(); gw.close(); });
  const dir = mern(VITE_SAFE);
  const out = [];
  const ui = { info: (m) => out.push(m), warn: (m) => out.push(`WARN ${m}`), confirm: async () => true, select: async (_m, o) => o[0].value, text: async () => "" };
  const config = { gateway: gw.url, supabaseUrl: auth.url, clientId: "wiz", apiKey: "test-publishable-key", ports: [53832, 53833], dashboard: "https://app.parlox.io" };
  const deps = { cwd: dir, config, ui, open: (url) => { fetch(url).catch(() => {}); }, run: () => ({ status: 0, stdout: "", stderr: "" }) };
  assert.equal(await main(["--yes", "--allow-no-git", "--no-vercel", "--site", "shop.example.com", "--skip-check"], deps), 0, out.join("\n"));
  assert.ok(out.at(-1).split("\n").includes(DASHBOARD), out.at(-1));
  // An Express app with no Vite anywhere: nothing to say about it.
  assert.deepEqual(scanApps(generated()).units[0].warnings, []);
});

// ---- netlify.toml as TOML, tools known not to run Vite, folders the wizard cannot look into ----

const API_BUILD = "import { build } from 'vite'\nawait build({ envPrefix: 'PARLOX_' })\n";
// A Vite config the exposure guard proves safe on its own: a withheld key beside it is the build's doing, not the config's.
const PLAIN_VITE = "import { defineConfig } from 'vite'\nexport default defineConfig({})\n";
/** The reason the app's server part was withheld (its only unit), asserted with its consequences: no server part, no
 * host step. Null when the Express server part keeps its key and host step. */
const withheldWhy = (dir) => {
  const [u] = scanApps(dir).units;
  const w = u.warnings.find((x) => x.startsWith("Express: no server part was added."));
  if (u.server === null) {
    assert.equal(hostStepFor(u, { id: "render" }), false);
    assert.ok(w, u.warnings.join("\n"));
    return w;
  }
  assert.equal(w, undefined, w);
  assert.equal(u.server.integration, "express");
  assert.equal(hostStepFor(u, { id: "render" }), true);
  return null;
};
const G = ["-c", "user.email=t@t", "-c", "user.name=t"];
const commitAll = (dir) => {
  execFileSync("git", [...G, "init", "-q"], { cwd: dir });
  execFileSync("git", [...G, "add", "-A"], { cwd: dir });
  execFileSync("git", [...G, "commit", "-qm", "init"], { cwd: dir });
};

test("netlify.toml's strings are read as TOML reads them: no quotes, escapes in basic strings, none in literal ones", () => {
  assert.deepEqual(netlifyCommands([
    "[build]",
    'command = "node scripts/b.mjs"',
    "[context.production]",
    "command = 'npm run bundle'",
    "[context.deploy-preview]",
    'command = "node \\"scripts/b.mjs\\" --tab\\tx \\u0076ite C:\\\\dir"',
    "[context.branch-deploy]",
    "command = 'C:\\dir \\n'",
    "[dev]",
    'command = """',
    "npx vite \\",
    '    build"""',
    "[context.staging]",
    "command = '''",
    "vite build'''",
  ].join("\n")), [
    "node scripts/b.mjs",
    "npm run bundle",
    'node "scripts/b.mjs" --tab\tx vite C:\\dir',
    "C:\\dir \\n",
    "npx vite build",
    "vite build",
  ]);
  const api = (toml, scripts = {}) => beside({ scripts: { build: "tsc", start: "node server.js", ...scripts }, dependencies: { express: "^5.1.0" }, devDependencies: { vite: "^7.2.0" } }, { "scripts/b.mjs": API_BUILD, "netlify.toml": toml });
  const API_WHY = /^Express: no server part was added\. The build runs scripts\/b\.mjs, which uses Vite's JavaScript API, so the wizard cannot read the settings it builds with\./;
  assert.match(withheldWhy(api('[build]\ncommand = "node scripts/b.mjs"\n')), API_WHY, "N1");
  assert.match(withheldWhy(api('[build]\ncommand = "npm run bundle"\n', { bundle: "node scripts/b.mjs" })), API_WHY, "N2");
  assert.match(withheldWhy(api('[build]\ncommand = "node \\"scripts/b.mjs\\""\n')), API_WHY, "an escaped quote");
  // Vite named only through an escape, beside a config that would bundle the key (vite declared nowhere).
  assert.match(withheldWhy(beside({ scripts: { start: "node server.js" }, dependencies: { express: "^5.1.0" } }, { "netlify.toml": '[build]\ncommand = "\\u0076ite build"\n', "vite.config.js": EXPOSING })),
    /^Express: no server part was added\. Your Vite config lists PARLOX_ in envPrefix/);
});

test("a Vite config in the folder, with vite declared here or at the workspace root, is checked unless every build command is a known non-Vite tool", () => {
  const own = (scripts, files = {}) => beside({ scripts: { start: "node server.js", ...scripts }, dependencies: { express: "^5.1.0", vue: "^3.5.0" }, devDependencies: { vite: "^7.2.0" } }, { "vite.config.js": EXPOSING, ...files });
  const opaque = (build) => `the "build" script (${JSON.stringify(build)}), which is not one of the builds the wizard checks`;
  for (const [build, files] of [
    ["nx build shop", { "project.json": JSON.stringify({ targets: { build: { executor: "@nx/vite:build" } } }), "nx.json": "{}" }],
    ["turbo run build:app", { "turbo.json": "{}" }],
    ["make build", { Makefile: "build:\n\tnpx vite build\n" }],
    ["tsc && make", { Makefile: "all:\n\tnpx vite build\n" }],
  ]) {
    const why = withheldWhy(own({ build }, { ...files, "vite.config.js": PLAIN_VITE }));
    assert.ok(why?.includes(opaque(build)), `${build}: ${why}`);
  }
  assert.equal(withheldWhy(own({ build: "vite build" }, { "vite.config.js": PLAIN_VITE })), null, "the same config built by `vite build` is proven safe");
  // Known tools that do not run Vite: the config is never built, and the server part keeps its key.
  assert.equal(withheldWhy(own({ build: "tsc" })), null, "tsc");
  assert.equal(withheldWhy(own({ build: "tsc -p server && esbuild src/worker.ts --bundle --outdir=dist" })), null, "tsc then esbuild");
  assert.equal(withheldWhy(own({ build: "npm run build:server", "build:server": "tsup src/server.ts", "postbuild:server": "rollup -c" })), null, "a script of the package, followed, with its hook");
  assert.equal(withheldWhy(own({ build: "webpack --mode production && babel src -d lib && swc src -d out" })), null, "webpack, babel, swc");
  assert.ok(withheldWhy(own({ build: "npm run build:server", "build:server": "tsup src/server.ts", "postbuild:server": "make" }, { "vite.config.js": PLAIN_VITE }))?.includes('the "build" script ("npm run build:server"), and npm also runs the "postbuild:server" script with it, which the wizard does not check'), "a hook that is not shown");
  // vite only at the workspace root.
  const ws = fixture({
    "package.json": JSON.stringify({ private: true, workspaces: ["apps/*"], devDependencies: { vite: "^7.2.0" } }), "package-lock.json": "{}",
    "apps/web/package.json": JSON.stringify({ name: "web", type: "module", scripts: { build: "nx build web", start: "node server.js" }, dependencies: { express: "^5.1.0" } }),
    "apps/web/server.js": SERVER, "apps/web/vite.config.js": PLAIN_VITE,
  });
  assert.ok(withheldWhy(join(ws, "apps/web"))?.includes(opaque("nx build web")));
});

test("a folder whose script runs Vite declares it; a folder below with only a Vite config is checked when Vite is declared or run", () => {
  const app = (files, extra = {}) => fixture({ "package.json": JSON.stringify({ type: "module", scripts: { build: "npm run build --prefix client", start: "node server.js" }, dependencies: { express: "^5.1.0" }, ...extra }), "package-lock.json": "{}", "server.js": SERVER, ...files });
  const IN_CLIENT = /^Express: no server part was added\. In client\/: Your Vite config lists PARLOX_ in envPrefix/;
  // E1: client/ built with `npx vite build` (or quoted, with @version), vite declared nowhere.
  assert.match(withheldWhy(app({ "client/package.json": JSON.stringify({ scripts: { build: "npx vite build" } }), "client/vite.config.js": EXPOSING })), IN_CLIENT, "npx");
  assert.match(withheldWhy(app({ "client/package.json": JSON.stringify({ scripts: { build: "concurrently 'vite@7 build'" } }), "client/vite.config.js": EXPOSING })), IN_CLIENT, "quoted, @version");
  // E2: client/ runs Vite with -c and its package.json does not declare vite (the app does).
  assert.match(withheldWhy(app({ "client/package.json": JSON.stringify({ scripts: { build: "vite build -c vite.custom.ts" } }), "client/vite.custom.ts": EXPOSING }, { devDependencies: { vite: "^7.2.0" } })),
    /^Express: no server part was added\. In client\/: The script "build" runs Vite with --config/);
  // E2: client/ with no package.json, only a Vite config: vite declared by the app, or by the workspace root only.
  assert.match(withheldWhy(app({ "client/vite.config.js": EXPOSING }, { devDependencies: { vite: "^7.2.0" } })), IN_CLIENT, "declared by the app");
  const ws = fixture({
    "package.json": JSON.stringify({ private: true, workspaces: ["apps/*"], devDependencies: { vite: "^7.2.0" } }), "package-lock.json": "{}",
    "apps/api/package.json": JSON.stringify({ name: "api", type: "module", scripts: { start: "node server.js" }, dependencies: { express: "^5.1.0" } }),
    "apps/api/server.js": SERVER, "apps/api/client/vite.config.js": EXPOSING,
  });
  assert.match(withheldWhy(join(ws, "apps/api")), IN_CLIENT, "declared by the workspace root");
  // own || declared: the app's own build runs Vite (vercel.json), vite declared nowhere: client/ is checked as well.
  assert.match(withheldWhy(app({ "vercel.json": JSON.stringify({ buildCommand: "vite build" }), "client/vite.config.js": EXPOSING }, { scripts: { start: "node server.js" } })), IN_CLIENT, "own");
  // Neither declared nor run anywhere: a stray config is no Vite build.
  assert.equal(withheldWhy(app({ "client/vite.config.js": EXPOSING }, { scripts: { start: "node server.js" } })), null);
});

test("every word of a build command that names a local file is checked for Vite's JavaScript API (npx tsx, pnpm exec tsx, pnpm tsx, vite-node, esno)", () => {
  const app = (build, code = "import { build } from 'vite'\nawait build()\n") => beside({ scripts: { build, start: "node server.js" }, dependencies: { express: "^5.1.0" } }, { "scripts/build.ts": code });
  for (const build of ["npx tsx scripts/build.ts", "pnpm exec tsx scripts/build.ts", "pnpm tsx scripts/build.ts", "vite-node scripts/build.ts", "esno scripts/build.ts", 'sh -c "tsc && tsx ./scripts/build.ts"']) {
    assert.match(withheldWhy(app(build)), /^Express: no server part was added\. The build runs scripts\/build\.ts, which uses Vite's JavaScript API/, build);
  }
  assert.equal(withheldWhy(app("npx tsx scripts/build.ts", "import { build } from 'esbuild'\nawait build({})\n")), null, "a build script without Vite");
});

test("install commands are checked for Vite too: vercel.json's installCommand and the install scripts", () => {
  const app = (scripts, files = {}) => beside({ scripts: { build: "tsc", start: "node server.js", ...scripts }, dependencies: { express: "^5.1.0" }, devDependencies: { vite: "^7.2.0" } }, files);
  // A Vite build in the installCommand, beside a config that the build (tsc) never builds.
  assert.match(withheldWhy(app({}, { "vercel.json": JSON.stringify({ installCommand: "npm ci && npx vite build" }), "vite.config.js": PLAIN_VITE })), /^Express: no server part was added\. vercel\.json sets installCommand, which Vercel runs in the build/);
  // An install command is held to the non-Vite tool list too; `npm ci` alone is a known-harmless install command.
  assert.ok(withheldWhy(app({}, { "vercel.json": JSON.stringify({ installCommand: "npm ci && node gen.mjs" }), "vite.config.js": PLAIN_VITE }))?.includes("vercel.json sets installCommand, which Vercel runs in the build"), "an installCommand beside a Vite config");
  assert.equal(withheldWhy(app({}, { "vercel.json": JSON.stringify({ installCommand: "npm ci" }), "vite.config.js": PLAIN_VITE })), null, "npm ci beside a Vite config");
  // Vite's JavaScript API run by an install script, or by the installCommand.
  const INSTALL_WHY = /^Express: no server part was added\. The install runs scripts\/b\.mjs, which uses Vite's JavaScript API/;
  for (const name of ["preinstall", "install", "postinstall", "prepare"]) assert.match(withheldWhy(app({ [name]: "node scripts/b.mjs" }, { "scripts/b.mjs": API_BUILD })), INSTALL_WHY, name);
  assert.match(withheldWhy(app({}, { "vercel.json": JSON.stringify({ installCommand: "npm ci && node scripts/b.mjs" }), "scripts/b.mjs": API_BUILD })), INSTALL_WHY, "installCommand");
  // husky's prepare beside a vitest config (case J): the key stays.
  assert.equal(withheldWhy(app({ prepare: "husky", test: "vitest" }, { "vite.config.ts": "import { defineConfig } from 'vite'\nexport default defineConfig({ test: { environment: 'node' } })\n" })), null);
});

test("a folder the wizard cannot look into (a link to another folder, one it cannot open) is not checked: no key", { skip: process.platform === "win32" }, () => {
  const app = () => fixture({ "package.json": JSON.stringify({ type: "module", scripts: { build: "npm run build --prefix client", start: "node server.js" }, dependencies: { express: "^5.1.0" } }), "package-lock.json": "{}", "server.js": SERVER });
  const LINKED = /^Express: no server part was added\. The wizard did not look inside client\/, a link to another folder, so it cannot prove that no Vite build there reads PARLOX_SECRET_KEY\./;
  const web = fixture({ "package.json": CLIENT_PKG, "vite.config.js": EXPOSING });
  const linked = app();
  symlinkSync(web, join(linked, "client"), "dir");
  assert.match(withheldWhy(linked), LINKED, "outside git");
  const tracked = app();
  symlinkSync(web, join(tracked, "client"), "dir");
  commitAll(tracked);
  assert.match(withheldWhy(tracked), LINKED, "a link git tracks");
  // Root can open any folder: there the unreadable case cannot be made.
  if (process.getuid?.() !== 0) {
    const closed = app();
    mkdirSync(join(closed, "client"));
    writeFileSync(join(closed, "client/package.json"), CLIENT_PKG);
    chmodSync(join(closed, "client"), 0o000);
    try { assert.match(withheldWhy(closed), /^Express: no server part was added\. The wizard could not open client\/, so it cannot prove that no Vite build there reads PARLOX_SECRET_KEY\./); }
    finally { chmodSync(join(closed, "client"), 0o755); }
  }
});

test("in a git repository only the files git lists are walked: an ignored uploads/ tree past the folder cap keeps the key; outside git the cap still holds", () => {
  const files = { "package.json": JSON.stringify({ dependencies: { express: "^5.1.0" } }), "package-lock.json": "{}", "server.js": SRV_JS, ".gitignore": "uploads/\n" };
  for (let i = 0; i < 1000; i++) files[`uploads/u${String(i).padStart(4, "0")}/x.jpg`] = "x\n";
  assert.match(withheldWhy(fixture(files)), /^Express: no server part was added\. The wizard did not look for a Vite build past the first 1000 folders of this app/, "outside git: the cap");
  const repo = fixture(files);
  commitAll(repo);
  assert.equal(withheldWhy(repo), null, "in git: uploads/ is ignored, and not walked");
  assert.deepEqual(scanApps(repo).units[0].warnings, []);
  // What git lists is still walked: a committed client/, and one not committed yet that git would add.
  const IN_CLIENT = /^Express: no server part was added\. In client\/: Your Vite config lists PARLOX_ in envPrefix/;
  const tracked = fixture({ ...files, "client/package.json": CLIENT_PKG, "client/vite.config.js": EXPOSING });
  commitAll(tracked);
  assert.match(withheldWhy(tracked), IN_CLIENT, "committed");
  const added = fixture(files);
  commitAll(added);
  mkdirSync(join(added, "client"));
  writeFileSync(join(added, "client/package.json"), CLIENT_PKG);
  writeFileSync(join(added, "client/vite.config.js"), EXPOSING);
  assert.match(withheldWhy(added), IN_CLIENT, "not committed yet, not ignored");
  // A folder git ignores is not in the repository a host builds from.
  const ignored = fixture({ ...files, ".gitignore": "uploads/\nclient/\n", "client/package.json": CLIENT_PKG, "client/vite.config.js": EXPOSING });
  commitAll(ignored);
  assert.equal(withheldWhy(ignored), null, "ignored client/");
  // A submodule git has not checked out: its files are not listed, so it is not checked.
  const sub = fixture({ "package.json": files["package.json"], "package-lock.json": "{}", "server.js": SRV_JS });
  commitAll(sub);
  execFileSync("git", [...G, "update-index", "--add", "--cacheinfo", `160000,${"a1".repeat(20)},vendor`], { cwd: sub });
  assert.match(withheldWhy(sub), /^Express: no server part was added\. The wizard did not look inside vendor\/, a git submodule that is not checked out, so it cannot prove that no Vite build there reads PARLOX_SECRET_KEY\./);
});

// ---- Install commands, repositories inside the app, submodules, script runners ----

const gitIn = (dir, ...args) => execFileSync("git", [...G, "-c", "protocol.file.allow=always", ...args], { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
const NOT_CHECKED_OUT = (rel) => new RegExp(`^Express: no server part was added\\. The wizard did not look inside ${rel}/, a git submodule that is not checked out, so it cannot prove that no Vite build there reads PARLOX_SECRET_KEY\\.`);

test("install commands are held to the non-Vite tool list too (Vercel installs with the project's variables); husky's prepare is allowed", () => {
  const app = (scripts, files = {}) => beside({ scripts: { build: "tsc", start: "node server.js", ...scripts }, dependencies: { express: "^5.1.0", vue: "^3.5.0" }, devDependencies: { vite: "^7.2.0" } }, { "vite.config.js": PLAIN_VITE, ...files });
  const script = (name) => `package.json has a "${name}" script, which runs when the dependencies are installed, and the wizard does not check it`;
  for (const [label, scripts, files, why] of [
    ["I1 postinstall: nx run shop:build", { postinstall: "nx run shop:build" }, { "project.json": JSON.stringify({ targets: { build: { executor: "@nx/vite:build" } } }), "nx.json": "{}" }, script("postinstall")],
    ["I2 postinstall: make web", { postinstall: "make web" }, { Makefile: "web:\n\tnpx vite build\n" }, script("postinstall")],
    ["I3 prepare: turbo run build:web", { prepare: "turbo run build:web" }, { "turbo.json": "{}" }, script("prepare")],
    ["I4 installCommand: npm ci && nx build shop", {}, { "vercel.json": JSON.stringify({ installCommand: "npm ci && nx build shop" }), "nx.json": "{}" }, "vercel.json sets installCommand, which Vercel runs in the build and the wizard does not check"],
    ["I8 postinstall: npm run build:client → turbo run build", { postinstall: "npm run build:client", "build:client": "turbo run build" }, { "turbo.json": "{}" }, script("postinstall")],
  ]) {
    const why2 = withheldWhy(app(scripts, files));
    assert.ok(why2?.includes(why), `${label}: ${why2}`);
  }
  // Case J with husky: a vitest config that would bundle the key is never built, and the key stays.
  for (const prepare of ["husky", "husky install"]) assert.equal(withheldWhy(app({ prepare, test: "vitest" }, { "vite.config.js": EXPOSING })), null, prepare);
  // An install step made only of a known non-Vite tool.
  assert.equal(withheldWhy(app({ postinstall: "tsc -p tsconfig.json" }, { "vite.config.js": EXPOSING })), null, "postinstall: tsc");
});

test("a git repository of its own inside the app, which this one does not list, is not checked: no key", () => {
  const dir = fixture({ "package.json": JSON.stringify({ type: "module", scripts: { build: "npm run build --prefix client", start: "node server.js" }, dependencies: { express: "^5.1.0" } }), "package-lock.json": "{}", "server.js": SERVER });
  commitAll(dir);
  mkdirSync(join(dir, "client"));
  writeFileSync(join(dir, "client/package.json"), CLIENT_PKG);
  writeFileSync(join(dir, "client/vite.config.js"), EXPOSING);
  gitIn(join(dir, "client"), "init", "-q");
  assert.match(withheldWhy(dir), /^Express: no server part was added\. The wizard did not look inside client\/, a git repository of its own that this one does not list, so it cannot prove that no Vite build there reads PARLOX_SECRET_KEY\./);
});

test("a submodule that is initialised but never checked out is not checked: no key", () => {
  const sub = fixture({ "package.json": CLIENT_PKG, "vite.config.js": EXPOSING });
  commitAll(sub);
  const app = fixture({ "package.json": JSON.stringify({ type: "module", scripts: { build: "npm run build --prefix client", start: "node server.js" }, dependencies: { express: "^5.1.0" } }), "package-lock.json": "{}", "server.js": SERVER });
  commitAll(app);
  gitIn(app, "submodule", "--quiet", "add", sub, "client");
  gitIn(app, "commit", "-qm", "client");
  assert.match(withheldWhy(app), /^Express: no server part was added\. In client\/: Your Vite config lists PARLOX_ in envPrefix/, "checked out: walked like any folder");
  const clone = join(fixture({}), "app");
  gitIn(dirname(clone), "clone", "-q", app, clone);
  assert.match(withheldWhy(clone), NOT_CHECKED_OUT("client"), "cloned without its submodules");
  gitIn(clone, "submodule", "--quiet", "init");
  assert.match(withheldWhy(clone), NOT_CHECKED_OUT("client"), "initialised, never updated");
});

test("a build or install command run through a script runner the wizard does not follow (run-s, run-p, npm-run-all, concurrently npm:) is unknown: with Vite declared anywhere, the folder's build is checked", () => {
  const app = (scripts, dev = { vite: "^7.2.0" }, files = {}) => beside({ scripts: { start: "node server.js", ...scripts }, dependencies: { express: "^5.1.0" }, devDependencies: dev }, { "scripts/b.mjs": API_BUILD, ...files });
  const opaque = (build) => `the "build" script (${JSON.stringify(build)}), which is not one of the builds the wizard checks`;
  for (const build of ["run-s build:*", "npm-run-all build:client", "concurrently npm:build:client", "run-p 'build:*'", 'concurrently "npm:build:*" "tsc"']) {
    const w = withheldWhy(app({ build, "build:client": "node scripts/b.mjs" }));
    assert.ok(w?.includes(opaque(build)), `${build}: ${w}`);
  }
  // Reached from a script the build runs, and in an install script.
  assert.ok(withheldWhy(app({ build: "npm run all", all: "run-s build:*", "build:client": "node scripts/b.mjs" }))?.includes(opaque("npm run all")), "through npm run");
  assert.ok(withheldWhy(app({ postinstall: "run-s build:*", "build:client": "node scripts/b.mjs" }))?.includes('package.json has a "postinstall" script'), "postinstall");
  // Vite declared only below the app (client/): still checked.
  assert.ok(withheldWhy(app({ build: "run-s build:*", "build:client": "node scripts/b.mjs" }, {}, { "client/package.json": CLIENT_PKG, "client/vite.config.js": PLAIN_VITE }))?.includes(opaque("run-s build:*")), "declared below");
  // Vite declared nowhere: nothing to check.
  assert.equal(withheldWhy(app({ build: "run-s build:*", "build:client": "tsc" }, {})), null);
});
