import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bunLoadsEnv, elsewhereNote, envLoading, localCheckFor, noEnvNote, notLoaded, planEnvToken, unplanEnv } from "../dist/envfiles.js";
import { PathError } from "../dist/fs-safe.js";
import { express } from "../dist/integrations/express.js";
import { hono } from "../dist/integrations/hono.js";
import { isEnvFile } from "../dist/plan-core.js";
import { main } from "../dist/cli.js";
import { startFakeAuth, startFakeGateway } from "./fake-servers.mjs";
import { fixture, pkg as nextPkg, read } from "./helpers.mjs";

const load = (pkg, code, file = "server.js", bun = false, bunfig = null) => envLoading(pkg, code, file, bun, bunfig);
const dev = (command, extra = {}) => ({ scripts: { dev: command, ...extra } });
const role = { browser: false, server: true, unitHasBrowser: false };

test("what counts as loading a .env: dotenv or dotenvx, dotenv/config, config(), --env-file, process.loadEnvFile(), Bun", () => {
  assert.deepEqual(load({ dependencies: { dotenv: "^16.4.0" } }, "x"), { file: ".env", how: "inferred from the dotenv dependency" });
  assert.deepEqual(load({ dependencies: { "@dotenvx/dotenvx": "^1.0.0" } }, "x"), { file: ".env", how: "inferred from the @dotenvx/dotenvx dependency" });
  assert.deepEqual(load({}, 'import "dotenv/config";\n'), { file: ".env", how: 'import "dotenv/config"' });
  assert.deepEqual(load({}, 'require("dotenv").config({ path: ".env.local" });\n'), { file: ".env.local", how: "dotenv's config()" });
  assert.deepEqual(load(dev("node --watch --env-file=.env.development server.js"), ""), { file: ".env.development", how: '--env-file in the script "dev"' });
  assert.deepEqual(load(dev("node --env-file-if-exists .env server.js"), ""), { file: ".env", how: '--env-file in the script "dev"' });
  assert.deepEqual(load({}, "process.loadEnvFile();\n"), { file: ".env", how: "process.loadEnvFile()" });
  // Bun named by the integration alone (no script runs bun) is an inference, and says so.
  assert.deepEqual(load({}, "x", "src/index.ts", true), { file: ".env", how: "Bun reads .env by itself; that the app runs on Bun is inferred" });
  assert.deepEqual(load({ devDependencies: { "@types/bun": "latest" } }, "x", "src/index.ts", true), { file: ".env", how: "Bun reads .env by itself; Bun inferred from the @types/bun dependency" });
  // What was looked at, for the note.
  assert.deepEqual(load({}, "const x = 1;\n"), { file: null, how: null, checked: "server.js or the dependencies (the app has no dev or start script)" });
});

test("the script loaders dotenv-cli and env-cmd count, with their own default (.env); so do dotenv run, dotenvx run and a preloaded dotenv/config", () => {
  assert.deepEqual(load(dev("dotenv -e .env.local -- node server.js"), ""), { file: ".env.local", how: 'dotenv-cli in the script "dev"' });
  assert.deepEqual(load(dev("dotenv -- nodemon server.js"), ""), { file: ".env", how: 'dotenv-cli in the script "dev"' });
  assert.deepEqual(load(dev("dotenv -c development -- node server.js"), ""), { file: ".env", how: 'dotenv-cli in the script "dev"' }, "the cascade always loads the base file");
  assert.deepEqual(load(dev("npx dotenv -e=.env.development.local -- node server.js"), ""), { file: ".env.development.local", how: 'dotenv-cli in the script "dev"' });
  assert.deepEqual(load(dev("env-cmd -f .env.development node server.js"), ""), { file: ".env.development", how: 'env-cmd in the script "dev"' });
  assert.deepEqual(load(dev("env-cmd --file=./.env.local -- tsx watch src/index.ts"), ""), { file: ".env.local", how: 'env-cmd in the script "dev"' });
  assert.deepEqual(load(dev("env-cmd node server.js"), ""), { file: ".env", how: 'env-cmd in the script "dev"' });
  assert.deepEqual(load(dev("dotenv run -f .env.local,.env -- node server.js"), ""), { file: ".env.local", how: 'dotenv run in the script "dev"' });
  assert.deepEqual(load(dev("dotenvx run -f .env.production -- node server.js"), ""), { file: ".env.production", how: 'dotenvx run in the script "dev"' });
  assert.deepEqual(load(dev("dotenvx run -- node server.js"), ""), { file: ".env", how: 'dotenvx run in the script "dev"' });
  assert.deepEqual(load(dev("node -r dotenv/config server.js"), ""), { file: ".env", how: 'dotenv/config preloaded in the script "dev"' });
  assert.deepEqual(load(dev('node --env-file=".env.local" server.js'), ""), { file: ".env.local", how: '--env-file in the script "dev"' }, "a quoted value");
  assert.deepEqual(load(dev("tsx watch src/index.ts"), 'import "dotenv/config"\n', "src/index.ts"), { file: ".env", how: 'import "dotenv/config"' });
});

test("DOTENV_CONFIG_PATH, DOTENV_PATH and dotenv_config_path are not followed (dotenv's versions read them differently); the loader becomes elsewhere", () => {
  const not = (name, verb = "sets") => `the script "dev" ${verb} ${name}, which the wizard does not follow`;
  assert.deepEqual(load(dev("DOTENV_CONFIG_PATH=.env.local node -r dotenv/config server.js"), ""), { file: null, how: null, elsewhere: { file: null, how: 'dotenv/config preloaded in the script "dev"', why: not("DOTENV_CONFIG_PATH") } });
  assert.deepEqual(load(dev("cross-env DOTENV_PATH=.env.development tsx watch server.ts"), 'import "dotenv/config"\n', "server.ts"), { file: null, how: null, elsewhere: { file: null, how: 'import "dotenv/config"', why: not("DOTENV_PATH") } });
  assert.deepEqual(load(dev("node -r dotenv/config server.js dotenv_config_path=.env.local"), ""), { file: null, how: null, elsewhere: { file: null, how: 'dotenv/config preloaded in the script "dev"', why: not("dotenv_config_path", "passes") } });
  assert.deepEqual(load({ ...dev("DOTENV_CONFIG_PATH=x node server.js"), dependencies: { dotenv: "^17.2.0" } }, ""), { file: null, how: null, elsewhere: { file: null, how: "inferred from the dotenv dependency", why: not("DOTENV_CONFIG_PATH") } });
  // A path written in the call, or another loader, does not depend on those variables.
  assert.deepEqual(load(dev("DOTENV_CONFIG_PATH=x node server.js"), 'require("dotenv").config({ path: ".env.local" })\n'), { file: ".env.local", how: "dotenv's config()" });
  assert.deepEqual(load(dev("DOTENV_CONFIG_PATH=x node --env-file=.env server.js"), ""), { file: ".env", how: '--env-file in the script "dev"' });
  const note = elsewhereNote({ file: null, how: 'import "dotenv/config"', why: not("DOTENV_CONFIG_PATH") });
  assert.equal(note, 'The app loads its variables through import "dotenv/config", but the script "dev" sets DOTENV_CONFIG_PATH, which the wizard does not follow, so nothing was written for local use and no package was added. To check the server part on your computer, add PARLOX_VERIFY_TOKEN to the file it names, with the same value as on your host.');
  assert.equal(localCheckFor({}, "npm", "", "server.js", { file: null, how: null, elsewhere: { file: null, how: "x", why: not("DOTENV_CONFIG_PATH") } }).skip, 'the script "dev" sets DOTENV_CONFIG_PATH, which the wizard does not follow; check it after you deploy');
});

test("--env-file counts for node, bun and tsx only before the first word that is not a flag", () => {
  assert.deepEqual(load(dev("node server.js --env-file=.env"), ""), { file: null, how: null, checked: 'the script "dev", server.js or the dependencies' }, "an argument of the app, not node's");
  assert.deepEqual(load(dev("tsx watch --env-file=.env.local src/index.ts"), "", "src/index.ts"), { file: ".env.local", how: '--env-file in the script "dev"' });
  assert.deepEqual(load(dev("node --import tsx --env-file .env src/index.ts"), "", "src/index.ts"), { file: ".env", how: '--env-file in the script "dev"' }, "past another flag's value");
  assert.deepEqual(load(dev("node src/index.js -r dotenv/config"), "", "src/index.js"), { file: null, how: null, checked: 'the script "dev", src/index.js or the dependencies' });
});

test("the script that starts the app counts (dev, else start), with the scripts it runs; a test script's env file does not", () => {
  assert.deepEqual(load({ scripts: { dev: "npm run serve", serve: "node --env-file=.env.local server.js" } }, ""), { file: ".env.local", how: '--env-file in the script "serve"' });
  assert.deepEqual(load({ scripts: { start: "node --env-file=.env server.js" } }, ""), { file: ".env", how: '--env-file in the script "start"' });
  assert.deepEqual(load({ scripts: { dev: "tsx watch server.ts", test: "node --env-file=.env.test --test" } }, 'import "dotenv/config"\n'), { file: ".env", how: 'import "dotenv/config"' });
  assert.deepEqual(load({ scripts: { dev: "tsx watch server.ts", test: "node --env-file=.env.test --test" } }, ""), { file: null, how: null, checked: 'the script "dev", server.js or the dependencies' });
});

test("dotenv's config(), however it is bound: import { config }, a renamed require, a path array; a path computed in code is not a guess", () => {
  assert.deepEqual(load({}, 'import { config } from "dotenv"\nconfig({ path: ".env.development" })\n', "server.ts"), { file: ".env.development", how: "dotenv's config()" });
  assert.deepEqual(load({}, 'const env = require("dotenv")\nenv.config()\n'), { file: ".env", how: "dotenv's config()" });
  assert.deepEqual(load({}, 'import * as dotenvx from "@dotenvx/dotenvx"\ndotenvx.config({ path: [".env.local", ".env"] })\n', "server.ts"), { file: ".env.local", how: "dotenvx's config()" });
  assert.deepEqual(load({ dependencies: { dotenv: "^16.4.0" } }, 'const path = require("path")\nrequire("dotenv").config({ path: path.resolve(__dirname, "../.env") })\n'), { file: null, how: null, elsewhere: { file: null, how: "dotenv's config()" } }, "not inferred from the dependency either: the call was seen");
  assert.deepEqual(load({}, 'const dotenv = { config() {} }\ndotenv.config()\n'), { file: null, how: null, checked: "server.js or the dependencies (the app has no dev or start script)" }, "a config() that is not dotenv's");
  assert.deepEqual(load({}, "process.loadEnvFile(process.env.ENV_FILE)\n"), { file: null, how: null, elsewhere: { file: null, how: "process.loadEnvFile()" } });
});

test("accepted names: .env, .env.<name>, .env.<name>.local in the app's own folder; any other file is named in a note, never 'loads no .env file'", () => {
  for (const f of [".env", ".env.local", ".env.staging", ".env.development.local", "./.env.test"]) assert.equal(load(dev(`node --env-file=${f} server.js`), "").file, f.replace(/^\.\//, ""), f);
  const elsewhere = (f) => load(dev(`node --env-file=${f} server.js`), "");
  for (const f of ["../shared.env", "config/.env", "/etc/shop.env", ".env.json", "dev.env"]) assert.deepEqual(elsewhere(f), { file: null, how: null, elsewhere: { file: f, how: '--env-file in the script "dev"' } }, f);
  // env-cmd's rc file is never written, whatever its name.
  const RC = "env-cmd reads it as an rc file of environments, not as a .env file";
  assert.deepEqual(load(dev("env-cmd -e development node server.js"), ""), { file: null, how: null, elsewhere: { file: ".env-cmdrc", how: 'env-cmd in the script "dev"', why: RC } });
  assert.deepEqual(load(dev("env-cmd -e development -f .env.development node server.js"), ""), { file: null, how: null, elsewhere: { file: ".env.development", how: 'env-cmd in the script "dev"', why: RC } });
  assert.equal(elsewhereNote({ file: ".env.development", how: 'env-cmd in the script "dev"', why: RC }), `The app loads its variables from .env.development (env-cmd in the script "dev"), which the wizard does not write: ${RC}. Nothing was written for local use and no package was added. To check the server part on your computer, set PARLOX_VERIFY_TOKEN there, with the same value as on your host.`);
  // A file the wizard can write wins over one it cannot, whichever comes first.
  assert.deepEqual(load(dev("node --env-file=../shared.env server.js"), 'import "dotenv/config"\n'), { file: ".env", how: 'import "dotenv/config"' });
  const note = elsewhereNote({ file: "../shared.env", how: '--env-file in the script "dev"' });
  assert.equal(note, "The app loads its variables from ../shared.env (--env-file in the script \"dev\"), which the wizard does not write (it writes only .env, .env.<name> or .env.<name>.local in the app's own folder), so nothing was written for local use and no package was added. To check the server part on your computer, add PARLOX_VERIFY_TOKEN to ../shared.env, with the same value as on your host.");
  assert.equal(elsewhereNote({ file: null, how: "dotenv's config()" }), "The app loads its variables from a file whose path is computed in code (dotenv's config()), which the wizard does not follow, so nothing was written for local use and no package was added. To check the server part on your computer, add PARLOX_VERIFY_TOKEN to that file, with the same value as on your host.");
  assert.doesNotMatch(note, /loads no \.env file/);
});

test("Bun: its own .env unless a script names the files (--env-file) or turns it off (--no-env-file, bunfig's env = false)", () => {
  assert.deepEqual(load(dev("bun --env-file=.env.dev src/index.ts"), "", "src/index.ts", true), { file: ".env.dev", how: '--env-file in the script "dev"' });
  assert.deepEqual(load(dev("bun --env-file=../all.env src/index.ts"), "", "src/index.ts", true), { file: null, how: null, elsewhere: { file: "../all.env", how: '--env-file in the script "dev"' } });
  assert.deepEqual(load(dev("bun run --no-env-file src/index.ts"), "", "src/index.ts", true), { file: null, how: null, checked: `the script "dev", src/index.ts or the dependencies; Bun's own .env loading is turned off (--no-env-file in the script "dev")` });
  assert.deepEqual(load(dev("bun run --hot src/index.ts"), "", "src/index.ts", true, "env = false\n"), { file: null, how: null, checked: `the script "dev", src/index.ts or the dependencies; Bun's own .env loading is turned off (bunfig.toml)` });
  assert.deepEqual(load(dev("bun run --hot src/index.ts"), 'require("dotenv").config({ path: "../x.env" })\n', "src/index.ts", true), { file: ".env", how: 'Bun reads .env by itself: the script "dev" runs bun' });
  // An app whose start script runs bun is on Bun, whatever the integration (Express too).
  assert.deepEqual(load(dev("bun --hot server.js"), ""), { file: ".env", how: 'Bun reads .env by itself: the script "dev" runs bun' });
  assert.deepEqual(load({ scripts: { dev: "bun run serve", serve: "bun server.ts" } }, ""), { file: ".env", how: 'Bun reads .env by itself: the script "serve" runs bun' });
  assert.equal(load(dev("bun run build", { build: "tsc" }), "").file, null, "bun running a script of the package is the package manager");
  assert.deepEqual(load(dev("bun test"), "").file, null);
  assert.equal(bunLoadsEnv(null), true);
  assert.equal(bunLoadsEnv("telemetry = false\n"), true);
  assert.equal(bunLoadsEnv("env = false\n[test]\nroot = \"./t\"\n"), false);
  assert.equal(bunLoadsEnv("[install]\nenv = false\n"), true, "only the top-level setting");
});

test("the local check: the port the code listens on (else 3000) and the command that starts it; none without a loaded .env", () => {
  const env = { file: ".env", how: "x" };
  assert.deepEqual(localCheckFor({ scripts: { start: "node ./bin/www" } }, "npm", "server.listen(port);\n", "bin/www", env), { url: "http://localhost:3000", start: "npm start" });
  assert.deepEqual(localCheckFor({ scripts: { dev: "tsx watch src/index.ts" } }, "pnpm", "serve({ fetch: app.fetch, port: 8787 })\n", "src/index.ts", env), { url: "http://localhost:8787", start: "pnpm dev" });
  assert.deepEqual(localCheckFor({ scripts: { dev: "bun run --hot src/index.ts" } }, "bun", "app.listen(4000)\n", "src/index.ts", env), { url: "http://localhost:4000", start: "bun run dev" });
  assert.deepEqual(localCheckFor({}, "yarn", "const port = process.env.PORT || 4100\napp.listen(port)\n", "server.js", env), { url: "http://localhost:4100", start: "node server.js" });
  assert.deepEqual(localCheckFor({}, "npm", "export default { port: 4200, fetch: app.fetch }\n", "src/index.ts", env).url, "http://localhost:4200");
  assert.equal(localCheckFor({}, "npm", "const db = connect({ host: 'db', port: 5432 })\napp.listen(3001)\n", "server.js", env).url, "http://localhost:3001", "a port of something else is not the server's");
  // PORT from the .env being edited, when the code reads it.
  assert.equal(localCheckFor({}, "npm", "const port = process.env.PORT || 4100\napp.listen(port)\n", "server.js", env, "A=1\nPORT=4321\n").url, "http://localhost:4321");
  assert.equal(localCheckFor({}, "npm", "app.listen(Number(process.env.PORT ?? 3000))\n", "server.js", env, "export PORT='5000' # dev\n").url, "http://localhost:5000");
  assert.equal(localCheckFor({}, "npm", "app.listen(process.env.PORT || 3000)\n", "server.js", env, "PORT=abc\n").url, "http://localhost:3000");
  assert.equal(localCheckFor({}, "npm", "app.listen(4100)\n", "server.js", env, "PORT=4321\n").url, "http://localhost:4100", "PORT counts only where the code reads it");
  const checked = "server.js or the dependencies (the app has no dev or start script)";
  assert.equal(localCheckFor({}, "npm", "", "server.js", { file: null, how: null, checked }).skip, notLoaded(checked));
  assert.equal(notLoaded(checked), "the wizard found no .env loader in server.js or the dependencies (the app has no dev or start script), so PARLOX_VERIFY_TOKEN is not loaded locally; check it after you deploy");
  assert.equal(localCheckFor({}, "npm", "", "server.js", { file: null, how: null, elsewhere: { file: "../shared.env", how: "x" } }).skip, "the app loads its variables from ../shared.env, which the wizard does not write; check it after you deploy");
});

test("the token goes in the loaded .env; .gitignore covers it; an env file it may not write is a step by hand, never the end of the run; uninstall takes the lines back out", () => {
  const input = (files, git, extra = {}) => ({ publicKey: "pk_" + "a1".repeat(12), verifyToken: "vt_fake", host: { id: "unknown" }, versions: { browser: "1.0.3", server: "1.1.0" }, parts: { browser: false, server: true }, read: (r) => { if (files[r] instanceof Error) throw files[r]; return files[r] ?? null; }, git, ...extra });
  const repo = (tracked = [], ignored = []) => ({ isRepo: () => true, dirty: () => [], isTracked: (f) => tracked.includes(f), isIgnored: (f) => ignored.includes(f) });
  const paths = (r) => r.changes.map((c) => [c.path, c.after]);
  assert.deepEqual(paths(planEnvToken(input({ ".gitignore": "node_modules\n" }, repo()), ".env")), [[".env", "PARLOX_VERIFY_TOKEN=vt_fake\n"], [".gitignore", "node_modules\n.env\n"]]);
  assert.deepEqual(paths(planEnvToken(input({ ".env": "PORT=3000\n" }, repo([], [".env"])), ".env")), [[".env", "PORT=3000\nPARLOX_VERIFY_TOKEN=vt_fake\n"]]);
  assert.deepEqual(planEnvToken(input({ ".env": "PARLOX_VERIFY_TOKEN=vt_fake\n" }, repo([], [".env"])), ".env"), { changes: [], manual: [] }, "already there");
  // A tracked file (dotenvx keeps an encrypted .env in git), a link, a .gitignore it may not read.
  const tracked = planEnvToken(input({ ".env": "X=1\n" }, repo([".env"]), { shown: (f) => `apps/api/${f}` }), ".env");
  assert.deepEqual(tracked.changes, []);
  assert.deepEqual(tracked.manual, [{ file: ".env", snippet: "PARLOX_VERIFY_TOKEN=vt_fake", reason: "git tracks this file, so the wizard does not write to it. Remove it from git (git rm --cached apps/api/.env) and run the wizard again; or, if it is meant to be in git (dotenvx's encrypted .env, say), set PARLOX_VERIFY_TOKEN in the environment you start the server with instead." }]);
  const linked = planEnvToken(input({ ".env": new PathError("Refusing .env: it points outside the project folder", ".env") }, repo()), ".env");
  assert.deepEqual(linked, { changes: [], manual: [{ file: ".env", snippet: "PARLOX_VERIFY_TOKEN=vt_fake", reason: "The wizard does not read or write this file (Refusing .env: it points outside the project folder): add the line to it yourself." }] });
  const ignoreLinked = planEnvToken(input({ ".gitignore": new PathError("Refusing .gitignore: it points outside the project folder", ".gitignore") }, repo()), ".env");
  assert.deepEqual(ignoreLinked.changes, []);
  assert.match(ignoreLinked.manual[0].reason, /^The wizard writes this file only when \.gitignore keeps it out of git, and it does not read \.gitignore \(Refusing \.gitignore/);
  assert.throws(() => planEnvToken(input({ ".env": new Error("disk") }, repo()), ".env"), /disk/, "anything else is not swallowed");
  // A PARLOX_SECRET_KEY line stays: it may be the merchant's own key (for orders).
  assert.deepEqual(unplanEnv({ read: (r) => ({ ".env": "PORT=3000\nPARLOX_VERIFY_TOKEN=vt_fake\nPARLOX_SECRET_KEY=sk_x\n" })[r] ?? null }, ".env").changes.map((c) => c.after), ["PORT=3000\nPARLOX_SECRET_KEY=sk_x\n"]);
  assert.deepEqual(unplanEnv({ read: (r) => ({ ".env": "PARLOX_VERIFY_TOKEN=vt_fake\n" })[r] ?? null }, ".env").changes.map((c) => c.after), [null], "a file left empty goes");
  assert.deepEqual(unplanEnv({ read: () => "PORT=3000\n" }, ".env"), { changes: [], manual: [] });
  const unlinked = unplanEnv({ read: () => { throw new PathError("Refusing .env: it points outside the project folder", ".env"); } }, ".env");
  assert.deepEqual(unlinked.changes, []);
  assert.equal(unlinked.manual[0].reason, "The wizard does not read or write this file (Refusing .env: it points outside the project folder): remove Parlox's lines from it yourself, if they are there.");
  assert.equal(isEnvFile("api/.env"), true);
  assert.equal(isEnvFile(".env.development"), true);
  assert.equal(isEnvFile("src/env.ts"), false);
});

test("Express and Hono detections carry the env file and the local check; without a loader, a note and nothing written", () => {
  const withDotenv = fixture({ "package.json": JSON.stringify({ scripts: { dev: "node --watch server.js" }, dependencies: { express: "^5.1.0", dotenv: "^16.4.0" } }), "package-lock.json": "{}", "server.js": "require('dotenv').config();\nconst express = require('express');\nconst app = express();\napp.listen(process.env.PORT || 4000);\n", ".env": "PORT=4555\n" });
  const d = express.detect(withDotenv, withDotenv);
  assert.equal(d.envFile, ".env");
  assert.deepEqual(d.localCheck, { url: "http://localhost:4555", start: "npm run dev" }, "PORT from the .env");
  assert.ok(d.facts.some(([label, value]) => label === "Env" && value === ".env (dotenv's config())"));
  assert.ok(!express.hostNotes(d, { id: "unknown" }, role).some((n) => /\.env loader/.test(n)));
  const bare = fixture({ "package.json": JSON.stringify({ dependencies: { express: "^5.1.0" } }), "package-lock.json": "{}", "server.js": "const express = require('express');\nconst app = express();\n" });
  const b = express.detect(bare, bare);
  const checked = "server.js or the dependencies (the app has no dev or start script)";
  assert.equal(b.envFile, null);
  // Said only where the server part is planned (hostNotes), with what was looked at.
  assert.match(express.hostNotes(b, { id: "unknown" }, role).join("\n"), /found no \.env loader in server\.js or the dependencies \(the app has no dev or start script\), so it wrote nothing for local use and added no package/);
  assert.ok(express.hostNotes(b, { id: "unknown" }, role).includes(noEnvNote(checked)));
  assert.deepEqual(express.hostNotes(b, { id: "unknown" }, { ...role, server: false }), [], "no note where the server part is not planned");
  assert.ok(!b.notes.includes(noEnvNote(checked)));
  assert.deepEqual(b.localCheck, { skip: notLoaded(checked) });
  assert.ok(!b.facts.some(([label]) => label === "Env"));
  const inferred = fixture({ "package.json": JSON.stringify({ dependencies: { express: "^5.1.0", dotenv: "^16.4.0" } }), "package-lock.json": "{}", "server.js": "const express = require('express');\nconst app = express();\n" });
  assert.ok(express.detect(inferred, inferred).facts.some(([label, value]) => label === "Env" && value === ".env (inferred from the dotenv dependency)"));
  const shared = fixture({ "package.json": JSON.stringify({ scripts: { dev: "node --env-file=../shared.env server.js" }, dependencies: { express: "^5.1.0" } }), "package-lock.json": "{}", "server.js": "const express = require('express');\nconst app = express();\n" });
  const s = express.detect(shared, shared);
  assert.equal(s.envFile, null);
  const sharedNotes = express.hostNotes(s, { id: "unknown" }, role);
  assert.ok(sharedNotes.includes(elsewhereNote({ file: "../shared.env", how: '--env-file in the script "dev"' })), sharedNotes.join("\n"));
  assert.doesNotMatch(sharedNotes.join("\n"), /loads no \.env file|found no \.env loader/);
  // An Express app whose start script runs bun is on Bun.
  const bunExpress = fixture({ "package.json": JSON.stringify({ scripts: { dev: "bun --hot server.js" }, dependencies: { express: "^5.1.0" } }), "package-lock.json": "{}", "server.js": "const express = require('express');\nconst app = express();\n" });
  const be = express.detect(bunExpress, bunExpress);
  assert.equal(be.envFile, ".env");
  assert.ok(be.facts.some(([label, value]) => label === "Env" && value === '.env (Bun reads .env by itself: the script "dev" runs bun)'));
  const worker = fixture({ "package.json": JSON.stringify({ type: "module", dependencies: { hono: "^4.13.11" }, devDependencies: { wrangler: "^4.110.0" } }), "package-lock.json": "{}", "wrangler.jsonc": '{ "main": "src/index.ts" }', "src/index.ts": "import { Hono } from 'hono'\nconst app = new Hono()\nexport default app\n" });
  const w = hono.detect(worker, worker);
  assert.equal(w.envFile, null);
  assert.match(w.localCheck.skip, /Worker's local variables/);
  assert.ok(!hono.hostNotes(w, { id: "cloudflare" }, role).some((n) => /\.env loader/.test(n)), "a Worker's variables are not a .env the app fails to load");
  const node = fixture({ "package.json": JSON.stringify({ type: "module", scripts: { dev: "tsx watch src/index.ts" }, dependencies: { hono: "^4.13.11", "@hono/node-server": "^2.1.3", dotenv: "^17.2.0" } }), "package-lock.json": "{}", "src/index.ts": "import 'dotenv/config'\nimport { serve } from '@hono/node-server'\nimport { Hono } from 'hono'\nconst app = new Hono()\nserve({ fetch: app.fetch, port: 8787 })\n" });
  const n = hono.detect(node, node);
  assert.equal(n.envFile, ".env");
  assert.deepEqual(n.localCheck, { url: "http://localhost:8787", start: "npm run dev" });
  assert.ok(n.facts.some(([label, value]) => label === "Env" && value === '.env (import "dotenv/config")'));
  const mounted = fixture({ "package.json": JSON.stringify({ type: "module", scripts: { dev: "node --env-file=.env src/index.js" }, dependencies: { hono: "^4.13.11", "@hono/node-server": "^2.1.3" } }), "package-lock.json": "{}", "src/index.js": "import { serve } from '@hono/node-server'\nimport { Hono } from 'hono'\nconst app = new Hono().basePath('/api')\nserve({ fetch: app.fetch, port: 8787 })\n" });
  const m = hono.detect(mounted, mounted);
  assert.equal(m.envFile, ".env", "the token still goes in .env: the local key is read from it");
  assert.deepEqual(m.localCheck, { skip: "the app is mounted under /api, so /.well-known/parlox-verify does not reach it" });
  const bun = fixture({ "package.json": JSON.stringify({ scripts: { dev: "bun run --hot src/index.ts" }, dependencies: { hono: "^4.13.11" }, devDependencies: { "@types/bun": "latest" } }), "package-lock.json": "{}", "src/index.ts": "import { Hono } from 'hono'\nconst app = new Hono()\nexport default app\n" });
  assert.equal(hono.detect(bun, bun).envFile, ".env");
  const bunOff = fixture({ "package.json": JSON.stringify({ scripts: { dev: "bun run --hot src/index.ts" }, dependencies: { hono: "^4.13.11" }, devDependencies: { "@types/bun": "latest" } }), "package-lock.json": "{}", "bunfig.toml": "env = false\n", "src/index.ts": "import { Hono } from 'hono'\nconst app = new Hono()\nexport default app\n" });
  assert.equal(hono.detect(bunOff, bunOff).envFile, null);
  // On Cloudflare (wrangler), an Express server is a Worker too.
  const expressWorker = fixture({ "package.json": JSON.stringify({ dependencies: { express: "^5.1.0", dotenv: "^16.4.0" }, devDependencies: { wrangler: "^4.110.0" } }), "package-lock.json": "{}", "wrangler.toml": 'main = "server.js"\n', "server.js": "require('dotenv').config();\nconst express = require('express');\nconst app = express();\n" });
  const ew = express.detect(expressWorker, expressWorker);
  assert.equal(ew.envFile, null);
  assert.match(ew.localCheck.skip, /Worker's local variables/);
});

test("Express: install writes the token to the .env the app loads and .gitignore covers it; uninstall gives back the bytes", async (t) => {
  const { config } = await servers(t);
  const server = "require('dotenv').config();\nconst express = require('express');\nconst app = express();\napp.listen(4000);\n";
  const dir = fixture({ "package.json": JSON.stringify({ dependencies: { express: "^5.1.0", dotenv: "^16.4.0" } }), "package-lock.json": "{}", ".gitignore": "node_modules\n", ".env": "PORT=4000\n", "server.js": server });
  gitInit(dir, [".env"]);
  const out = [];
  const deps = { cwd: dir, config, open, run: () => ({ status: 0, stdout: "", stderr: "" }), ui: quiet(out) };
  assert.equal(await main(["--yes", "--no-vercel", "--allow-dirty", "--site", "shop.example.com", "--skip-check"], { ...deps, ui: quiet(out) }), 0, out.join("\n"));
  assert.equal(read(dir, ".env"), "PORT=4000\nPARLOX_VERIFY_TOKEN=vt_fake\n");
  assert.equal(read(dir, ".gitignore"), "node_modules\n.env\n");
  execFileSync("git", [...G, "add", "-A"], { cwd: dir });
  execFileSync("git", [...G, "commit", "-qm", "parlox"], { cwd: dir });
  assert.equal(await main(["uninstall", "--yes"], { ...deps, ui: quiet(out) }), 0, out.join("\n"));
  assert.equal(read(dir, ".env"), "PORT=4000\n");
  assert.equal(read(dir, "server.js"), server);
});

async function servers(t) {
  const auth = await startFakeAuth({ decide: "approve" });
  const gw = await startFakeGateway({ sites: [{ id: "11111111-1111-1111-1111-111111111111", name: "Shop", domain: "shop.example.com", public_key: "pk_" + "a1".repeat(12), verified: false }], keys: [] });
  t.after(() => { auth.close(); gw.close(); });
  return { gw, config: { gateway: gw.url, supabaseUrl: auth.url, clientId: "wiz", apiKey: "k", ports: [53832, 53833], dashboard: "https://app.parlox.io" } };
}
const G = ["-c", "user.email=t@t", "-c", "user.name=t"];
/** A repository with everything committed but `untracked` (a .env the developer never committed). */
const gitInit = (dir, untracked = []) => {
  execFileSync("git", [...G, "init", "-q"], { cwd: dir });
  execFileSync("git", [...G, "add", "-A", "--", ".", ...untracked.map((f) => `:!${f}`)], { cwd: dir });
  execFileSync("git", [...G, "commit", "-qm", "i"], { cwd: dir });
};
const open = (url) => { if (!url.includes("newKey")) fetch(url).catch(() => {}); };
const quiet = (out) => ({ info: (m) => out.push(m), warn: (m) => out.push(`WARN ${m}`), confirm: async () => true, select: async (_m, o) => o[0].value, text: async () => "", multiselect: async (_m, o) => o.map((x) => x.value) });

test("--local-key on an Express app that loads .env: a crawler-reports-only key in .env, readable only by its owner", async (t) => {
  const { gw, config } = await servers(t);
  const dir = fixture({ "package.json": JSON.stringify({ dependencies: { express: "^5.1.0", dotenv: "^16.4.0" } }), "package-lock.json": "{}", ".gitignore": "node_modules\n.env\n", "server.js": "require('dotenv').config();\nconst express = require('express');\nconst app = express();\n" });
  gitInit(dir);
  const out = [];
  assert.equal(await main(["--yes", "--no-vercel", "--local-key", "--site", "shop.example.com", "--skip-check"], { cwd: dir, config, open, run: () => ({ status: 0, stdout: "", stderr: "" }), ui: quiet(out) }), 0, out.join("\n"));
  assert.match(read(dir, ".env"), /^PARLOX_VERIFY_TOKEN=vt_fake\nPARLOX_SECRET_KEY=sk_parlox_/);
  assert.equal(gw.state.keys.length, 1);
  if (process.platform !== "win32") {
    assert.equal(statSync(join(dir, ".env")).mode & 0o777, 0o600);
    assert.ok(out.at(-1).includes(".env is now readable only by you: it holds the local key."), out.at(-1));
  }
  assert.equal(out.some((m) => m.includes("sk_parlox_")), false);
});

test("--local-key where Vite would expose it (envPrefix that PARLOX_ matches): refused, and no key is created", async (t) => {
  const { gw, config } = await servers(t);
  const dir = fixture({
    "package.json": JSON.stringify({ type: "module", dependencies: { react: "^19.2.8", express: "^5.1.0", dotenv: "^16.4.0" }, devDependencies: { vite: "^8.3.0" } }),
    "package-lock.json": "{}", ".gitignore": "node_modules\n.env\n", "index.html": '<script type="module" src="/src/main.jsx"></script>\n',
    "src/main.jsx": "createRoot(document.getElementById('root')).render(<App />)\n", "vite.config.js": "export default { envPrefix: ['VITE_', 'PARLOX_'] }\n",
    "server.js": "import 'dotenv/config'\nimport express from 'express'\nconst app = express()\n",
  });
  gitInit(dir);
  const out = [];
  assert.equal(await main(["--yes", "--no-vercel", "--local-key", "--site", "shop.example.com", "--skip-check"], { cwd: dir, config, open, run: () => ({ status: 0, stdout: "", stderr: "" }), ui: quiet(out) }), 0, out.join("\n"));
  // The warning the Vite exposure check gives before any key is written (cli.ts): it names the config's envPrefix and the key
  // reaching the browser code.
  assert.ok(out.includes("WARN No local key: Your Vite config lists PARLOX_ in envPrefix, so the secret key would be bundled into the browser code. Remove PARLOX_ from envPrefix and run the wizard again."), out.join("\n"));
  assert.deepEqual(gw.state.keys, []);
  assert.doesNotMatch(read(dir, ".env") ?? "", /PARLOX_SECRET_KEY/);
});

test("several apps: the .env and its .gitignore line are the app's own, and the messages name them from the start folder", async (t) => {
  const { gw, config } = await servers(t);
  const layout = "export default function RootLayout({ children }) {\n  return (\n    <html>\n      <body>{children}</body>\n    </html>\n  );\n}\n";
  const root = fixture({
    "package.json": JSON.stringify({ name: "mono", private: true, workspaces: ["apps/*"] }), "package-lock.json": "{}", ".gitignore": ".env*.local\n",
    "apps/web/package.json": nextPkg(), "apps/web/app/layout.tsx": layout,
    "apps/api/package.json": JSON.stringify({ name: "api", scripts: { dev: "node --env-file=.env server.js" }, dependencies: { express: "^5.1.0" } }),
    "apps/api/server.js": "const express = require('express');\nconst app = express();\napp.listen(4000);\n",
  });
  gitInit(root);
  const out = [];
  assert.equal(await main(["--yes", "--no-vercel", "--local-key", "--site", "shop.example.com", "--skip-check"], { cwd: root, config, open, run: () => ({ status: 0, stdout: "", stderr: "" }), ui: quiet(out) }), 0, out.join("\n"));
  const diff = out.find((m) => m.includes("+++ b/apps/api/.env"));
  assert.ok(diff && diff.includes("+++ b/apps/api/.gitignore"), out.join("\n"));
  assert.match(read(root, "apps/api/.env"), /^PARLOX_VERIFY_TOKEN=vt_fake\nPARLOX_SECRET_KEY=sk_parlox_/);
  assert.equal(read(root, "apps/api/.gitignore"), ".env\n");
  assert.equal(read(root, ".env"), null);
  assert.equal(gw.state.keys.length, 2, "one local key per app");
  assert.ok(out.some((m) => m.startsWith("WARN A separate key") && m.includes("is in apps/api/.env for local development")), out.join("\n"));
  if (process.platform !== "win32") assert.match(out.at(-1), /^apps\/api\/\.env is now readable only by you: it holds the local key\.$/m);
});

// ---- An env file the wizard may not write, and notes only where the server part is planned ----

const LAYOUT = "export default function RootLayout({ children }) {\n  return (\n    <html>\n      <body>{children}</body>\n    </html>\n  );\n}\n";
const SERVER = "const express = require('express');\nconst app = express();\napp.listen(4000);\n";
/** apps/web (Next.js) and apps/api (Express whose dev script loads .env with --env-file). */
const twoApps = (extra = {}, gitignore = ".env*.local\n") => fixture({
  "package.json": JSON.stringify({ name: "mono", private: true, workspaces: ["apps/*"] }), "package-lock.json": "{}", ".gitignore": gitignore,
  "apps/web/package.json": nextPkg(), "apps/web/app/layout.tsx": LAYOUT,
  "apps/api/package.json": JSON.stringify({ name: "api", scripts: { dev: "node --env-file=.env server.js" }, dependencies: { express: "^5.1.0" } }),
  "apps/api/server.js": SERVER, ...extra,
});
const run = () => ({ status: 0, stdout: "", stderr: "" });

test("a symlinked apps/api/.env in a two-app repo is a step by hand at install and uninstall; both runs finish, the link is not followed", { skip: process.platform === "win32" }, async (t) => {
  const { gw, config } = await servers(t);
  const outside = fixture({ "shared.env": "SHARED=1\n" });
  const root = twoApps({}, ".env\n.env*.local\n");
  symlinkSync(join(outside, "shared.env"), join(root, "apps/api/.env"), "file");
  gitInit(root);
  const out = [];
  assert.equal(await main(["--yes", "--no-vercel", "--local-key", "--site", "shop.example.com", "--skip-check"], { cwd: root, config, open, run, ui: quiet(out) }), 0, out.join("\n"));
  const step = out.find((m) => m.startsWith("WARN apps/api/.env: The wizard does not read or write this file (Refusing .env: it points outside the project folder)"));
  assert.ok(step && step.endsWith("Add this by hand:\nPARLOX_VERIFY_TOKEN=vt_fake"), out.join("\n"));
  assert.equal(read(outside, "shared.env"), "SHARED=1\n", "the link is not followed");
  assert.match(read(root, "apps/api/server.js"), /app\.use\(parlox\(\)\)/, "the rest of the app is installed");
  assert.match(read(root, "apps/web/.env.local"), /^PARLOX_VERIFY_TOKEN=vt_fake\nPARLOX_SECRET_KEY=sk_parlox_/, "and the other app, with its local key");
  assert.equal(gw.state.keys.length, 1, "no local key for apps/api");
  assert.ok(out.includes("WARN No local key (apps/api): apps/api/.env is a step by hand (the wizard does not write it), so no key was created. To report from your dev server, create a key in Settings → Keys and set PARLOX_SECRET_KEY in the environment you start the server with."), out.join("\n"));
  execFileSync("git", [...G, "add", "-A"], { cwd: root });
  execFileSync("git", [...G, "commit", "-qm", "parlox"], { cwd: root });
  const un = [];
  assert.equal(await main(["uninstall", "--yes"], { cwd: root, config, open, run, ui: quiet(un) }), 0, un.join("\n"));
  assert.ok(un.some((m) => m.startsWith("WARN apps/api/.env: The wizard does not read or write this file (Refusing .env: it points outside the project folder): remove Parlox's lines from it yourself")), un.join("\n"));
  assert.equal(read(root, "apps/api/server.js"), SERVER);
  // The local key's line stays (the wizard cannot tell it from the merchant's own key), and the review says so.
  assert.match(read(root, "apps/web/.env.local"), /^PARLOX_SECRET_KEY=sk_parlox_[0-9a-f]{64}\n$/);
  assert.equal(read(outside, "shared.env"), "SHARED=1\n");
});

test("a .env git tracks (dotenvx's encrypted file) is a step by hand naming both ways, with its path from the start folder; the run finishes with no local key for that app", async (t) => {
  const { gw, config } = await servers(t);
  const encrypted = '#/-------------------[DOTENV_PUBLIC_KEY]--------------------/\nDOTENV_PUBLIC_KEY="03a1b2"\nHELLO="encrypted:BDqDBibm4wsYqMpCjTQ6BsDHmMadg9K3dAt+Z9HPMfLEIRVz50hmLXPXRuDBXaJi"\n';
  const root = twoApps({ "apps/api/.env": encrypted, "apps/api/package.json": JSON.stringify({ name: "api", dependencies: { express: "^5.1.0", "@dotenvx/dotenvx": "^1.51.0" } }), "apps/api/server.js": "require('@dotenvx/dotenvx').config();\n" + SERVER });
  gitInit(root);
  const out = [];
  assert.equal(await main(["--yes", "--no-vercel", "--local-key", "--site", "shop.example.com", "--skip-check"], { cwd: root, config, open, run, ui: quiet(out) }), 0, out.join("\n"));
  assert.ok(out.includes("WARN apps/api/.env: git tracks this file, so the wizard does not write to it. Remove it from git (git rm --cached apps/api/.env) and run the wizard again; or, if it is meant to be in git (dotenvx's encrypted .env, say), set PARLOX_VERIFY_TOKEN in the environment you start the server with instead.\nAdd this by hand:\nPARLOX_VERIFY_TOKEN=vt_fake"), out.join("\n"));
  assert.equal(read(root, "apps/api/.env"), encrypted);
  assert.match(read(root, "apps/api/server.js"), /app\.use\(parlox\(\)\)/);
  assert.equal(gw.state.keys.length, 1, "the local key of apps/web only");
  assert.ok(out.some((m) => m.startsWith("WARN No local key (apps/api): apps/api/.env is a step by hand")), out.join("\n"));
  assert.match(out.at(-1), /^Server part \(apps\/api\): not checked \(PARLOX_VERIFY_TOKEN is not in apps\/api\/\.env yet: it is a step by hand\)\.$/m);
});

test("no note about local variables where the server part is withheld (a Vite build that could expose the key)", async (t) => {
  const { config } = await servers(t);
  const dir = fixture({
    "package.json": JSON.stringify({ type: "module", dependencies: { react: "^19.2.8", express: "^5.1.0" }, devDependencies: { vite: "^8.3.0" } }),
    "package-lock.json": "{}", ".gitignore": "node_modules\n", "index.html": '<script type="module" src="/src/main.jsx"></script>\n',
    "src/main.jsx": "createRoot(document.getElementById('root')).render(<App />)\n", "vite.config.js": "export default { envPrefix: ['VITE_', 'PARLOX_'] }\n",
    "server.js": "import express from 'express'\nconst app = express()\n",
  });
  gitInit(dir);
  const out = [];
  assert.equal(await main(["--yes", "--no-vercel", "--site", "shop.example.com", "--skip-check"], { cwd: dir, config, open, run, ui: quiet(out) }), 0, out.join("\n"));
  assert.match(out.at(-1), /Express: no server part was added/);
  assert.doesNotMatch(out.join("\n"), /\.env loader|nothing was written for local use/);
});
