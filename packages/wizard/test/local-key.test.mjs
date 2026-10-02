import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeLocalKey } from "../dist/cli.js";
import { fixture, read } from "./helpers.mjs";

// The local key's own checks, whatever the plan decided: never into a file git tracks, never through a link, and no
// key is created for either.

const G = ["-c", "user.email=t@t", "-c", "user.name=t"];
const recorder = () => { const out = [], created = []; return { out, created, api: { createKey: async (_s, n) => { created.push(n); return "sk_parlox_" + "e".repeat(64); } }, ui: { info: (m) => out.push(m), warn: (m) => out.push(`WARN ${m}`) } }; };

test("a tracked env file gets no local key, and none is created", async () => {
  const dir = fixture({ "package.json": "{}", ".env": "PARLOX_VERIFY_TOKEN=vt\n" });
  execFileSync("git", [...G, "init", "-q"], { cwd: dir });
  execFileSync("git", [...G, "add", "-A"], { cwd: dir });
  execFileSync("git", [...G, "commit", "-qm", "init"], { cwd: dir });
  const r = recorder();
  assert.equal(await writeLocalKey(r.api, "site", dir, ".env", "apps/api/.env", "local dev · mac", r.ui), false);
  assert.deepEqual(r.created, []);
  assert.equal(read(dir, ".env"), "PARLOX_VERIFY_TOKEN=vt\n");
  assert.ok(r.out.some((m) => m.startsWith("WARN No local key: git tracks apps/api/.env, so a key written there would be committed")), r.out.join("\n"));
});

test("an env file that is a link gets no local key, and none is created", { skip: process.platform === "win32" }, async () => {
  const shared = fixture({ ".env": "SHARED=1\n" });
  const dir = fixture({ "package.json": "{}" });
  symlinkSync(join(shared, ".env"), join(dir, ".env"));
  const r = recorder();
  assert.equal(await writeLocalKey(r.api, "site", dir, ".env", ".env", "local dev · mac", r.ui), false);
  assert.deepEqual(r.created, []);
  assert.equal(read(shared, ".env"), "SHARED=1\n");
  assert.ok(r.out.some((m) => m.startsWith("WARN No local key: .env is a link, or inside one")), r.out.join("\n"));
  // A folder link on the way counts too.
  const app = fixture({ "package.json": "{}" });
  mkdirSync(join(shared, "conf"));
  writeFileSync(join(shared, "conf", ".env"), "X=1\n");
  symlinkSync(join(shared, "conf"), join(app, "conf"));
  assert.equal(await writeLocalKey(r.api, "site", app, "conf/.env", "conf/.env", "local dev · mac", r.ui), false);
  assert.deepEqual(r.created, []);
});

test("an ignored env file outside git's index gets the key", async () => {
  const dir = fixture({ "package.json": "{}", ".gitignore": ".env\n", ".env": "PARLOX_VERIFY_TOKEN=vt\n" });
  execFileSync("git", [...G, "init", "-q"], { cwd: dir });
  const r = recorder();
  assert.equal(await writeLocalKey(r.api, "site", dir, ".env", ".env", "local dev · mac", r.ui), true);
  assert.deepEqual(r.created, ["local dev · mac"]);
  assert.match(read(dir, ".env"), /^PARLOX_SECRET_KEY=sk_parlox_e{64}$/m);
});
