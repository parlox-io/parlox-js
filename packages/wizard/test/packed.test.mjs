import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("the published bin runs through npm's bin link", { timeout: 180_000 }, () => {
  const pkgDir = resolve(import.meta.dirname, "..");
  const out = mkdtempSync(join(tmpdir(), "wizard-pack-"));
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const opts = { cwd: pkgDir, encoding: "utf8", shell: process.platform === "win32" };
  const file = JSON.parse(execFileSync(npm, ["pack", "--json", "--pack-destination", out], opts))[0].filename;
  const app = mkdtempSync(join(tmpdir(), "wizard-user-"));
  writeFileSync(join(app, "package.json"), JSON.stringify({ name: "u", private: true }));
  execFileSync(npm, ["install", "--no-audit", "--no-fund", join(out, file)], { ...opts, cwd: app });
  const bin = join(app, "node_modules", ".bin", process.platform === "win32" ? "parlox.cmd" : "parlox");
  // --yes: spawnSync gives the child a pipe for stdin, not a terminal; without --yes, start()'s no-terminal guard
  // would refuse before reaching the placeholder guard this test checks for.
  const r = spawnSync(bin, ["--dry-run", "--yes"], { cwd: app, encoding: "utf8", shell: process.platform === "win32" });
  assert.equal(r.status, 1);
  // Until a release fills in the real OAuth client id and Supabase key, the compiled PRODUCTION config (this
  // test runs the real bin, unmodified) still carries its "REPLACE_WITH" placeholders, so main()'s placeholder
  // guard refuses before Next.js detection ever runs. Once they are filled in, this same install (no Next.js app
  // in `app`) reaches the detect error instead. Either is a correct exit 1 through npm's bin link.
  assert.match(r.stdout + r.stderr, /No Next\.js app found|not use Next\.js|does not use a stack the wizard supports|missing its OAuth client id or Supabase key/);
});
