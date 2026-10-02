import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PathError, readInside, resolveInside, writeInside } from "../dist/fs-safe.js";
import { fixture } from "./helpers.mjs";

// A dangling symlink's target does not exist yet, so existsSync/realpathSync both report "not found" for
// it — the exact gap a naive "climb to the nearest existing ancestor" probe falls through, since the
// probe then climbs straight past the symlink to the project root and never inspects the link itself.
test("dangling symlink leaf: refused, and writeInside never creates the outside target", () => {
  const dir = fixture({ "package.json": "{}" });
  const outside = mkdtempSync(join(tmpdir(), "outside-"));
  const outsideTarget = join(outside, "pwned.txt");
  symlinkSync(outsideTarget, join(dir, "evil-leaf"), "file");
  assert.throws(() => resolveInside(dir, "evil-leaf"), PathError);
  assert.throws(() => writeInside(dir, "evil-leaf", "HELLO"), PathError);
  assert.equal(existsSync(outsideTarget), false);
});

test("symlink leaf to an existing outside file: refused, the outside file is untouched", () => {
  const dir = fixture({ "package.json": "{}" });
  const outside = mkdtempSync(join(tmpdir(), "outside-"));
  const outsideTarget = join(outside, "real.txt");
  writeFileSync(outsideTarget, "original");
  symlinkSync(outsideTarget, join(dir, "leaf-to-real"), "file");
  assert.throws(() => resolveInside(dir, "leaf-to-real"), PathError);
  assert.throws(() => writeInside(dir, "leaf-to-real", "HELLO"), PathError);
  assert.equal(readFileSync(outsideTarget, "utf8"), "original");
});

test("symlinked parent directory: refused", () => {
  const dir = fixture({ "package.json": "{}" });
  const outside = mkdtempSync(join(tmpdir(), "outside-"));
  symlinkSync(outside, join(dir, "app"), "dir");
  assert.throws(() => resolveInside(dir, "app/layout.tsx"), /outside/);
});

test("a normal new file in a new subfolder is allowed", () => {
  const dir = fixture({ "package.json": "{}" });
  writeInside(dir, "sub/new.txt", "hi\n");
  assert.equal(readInside(dir, "sub/new.txt"), "hi\n");
});

test("writeInside: a file it creates gets the mode asked for; an existing file keeps its own mode", { skip: process.platform === "win32" }, async () => {
  const { chmodSync, statSync } = await import("node:fs");
  const dir = fixture({ "existing.env": "A=1\n" });
  chmodSync(join(dir, "existing.env"), 0o644);
  writeInside(dir, "new.env", "B=2\n", 0o600);
  assert.equal(statSync(join(dir, "new.env")).mode & 0o777, 0o600);
  writeInside(dir, "existing.env", "A=2\n", 0o600);
  assert.equal(statSync(join(dir, "existing.env")).mode & 0o777, 0o644);
  assert.equal(readFileSync(join(dir, "existing.env"), "utf8"), "A=2\n");
});

// Residual 1: a secret write (.env.local under --local-key) replaces the file whole. Truncating it in place and then
// changing its mode lost the developer's variables whenever the mode change failed (a file owned by another user).
test("writeSecretInside: replaces the file whole, readable only by its owner, and leaves no temporary file", { skip: process.platform === "win32" }, async () => {
  const { writeSecretInside } = await import("../dist/fs-safe.js");
  const { chmodSync, readdirSync, statSync } = await import("node:fs");
  const dir = fixture({ ".env.local": "OTHER=1\n" });
  chmodSync(join(dir, ".env.local"), 0o644);
  writeSecretInside(dir, ".env.local", "OTHER=1\nPARLOX_SECRET_KEY=x\n");
  assert.equal(readFileSync(join(dir, ".env.local"), "utf8"), "OTHER=1\nPARLOX_SECRET_KEY=x\n");
  assert.equal(statSync(join(dir, ".env.local")).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(dir), [".env.local"]);
  // A new file too.
  const fresh = fixture({ "package.json": "{}" });
  writeSecretInside(fresh, ".env.local", "PARLOX_SECRET_KEY=x\n");
  assert.equal(statSync(join(fresh, ".env.local")).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(fresh).sort(), [".env.local", "package.json"]);
});

test("writeSecretInside: when the new file cannot be written or put in place, the original is untouched and nothing is left behind", { skip: process.platform === "win32" || process.getuid?.() === 0 }, async () => {
  const { writeSecretInside } = await import("../dist/fs-safe.js");
  const { chmodSync, mkdirSync, readdirSync } = await import("node:fs");
  // The folder takes no new file (as when the folder is not the developer's): the original keeps every variable.
  const locked = fixture({ ".env.local": "OTHER=1\nMORE=2\n" });
  chmodSync(locked, 0o555);
  try {
    assert.throws(() => writeSecretInside(locked, ".env.local", "PARLOX_SECRET_KEY=x\n"), /EACCES|EPERM/);
    assert.equal(readFileSync(join(locked, ".env.local"), "utf8"), "OTHER=1\nMORE=2\n");
    assert.deepEqual(readdirSync(locked), [".env.local"]);
  } finally { chmodSync(locked, 0o755); }
  // The new file is written, but the rename over the target fails (here the target is a folder): it is removed.
  const blocked = fixture({ "keep.txt": "k\n" });
  mkdirSync(join(blocked, ".env.local"));
  writeFileSync(join(blocked, ".env.local", "inside"), "untouched\n");
  assert.throws(() => writeSecretInside(blocked, ".env.local", "PARLOX_SECRET_KEY=x\n"));
  assert.deepEqual(readdirSync(blocked).sort(), [".env.local", "keep.txt"], "no temporary file left");
  assert.equal(readFileSync(join(blocked, ".env.local", "inside"), "utf8"), "untouched\n");
});

test("writeSecretInside: a symlinked target is refused; nothing is written anywhere", async () => {
  const { writeSecretInside } = await import("../dist/fs-safe.js");
  const { readdirSync } = await import("node:fs");
  const dir = fixture({ "package.json": "{}" });
  const outside = mkdtempSync(join(tmpdir(), "outside-"));
  writeFileSync(join(outside, "real.env"), "REAL=1\n");
  symlinkSync(join(outside, "real.env"), join(dir, ".env.local"), "file");
  assert.throws(() => writeSecretInside(dir, ".env.local", "PARLOX_SECRET_KEY=x\n"), PathError);
  assert.equal(readFileSync(join(outside, "real.env"), "utf8"), "REAL=1\n");
  assert.deepEqual(readdirSync(dir).sort(), [".env.local", "package.json"], "no temporary file left");
});
