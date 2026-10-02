import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

test("the shrinkwrap has no dev entries and no install scripts", () => {
  const out = execFileSync(process.execPath, [resolve(import.meta.dirname, "..", "scripts", "check-shrinkwrap.mjs")], { encoding: "utf8" });
  assert.match(out, /ok: \d+ packages, no dev entries, no install scripts/);
});
