import { test } from "node:test";
import assert from "node:assert/strict";
import { setEnvValue, removeEnvValue, addGitignoreLine, hasEnvValue } from "../dist/edits/env.js";

test("new file / appended line / trailing newline added", () => {
  assert.deepEqual(setEnvValue(null, "PARLOX_VERIFY_TOKEN", "t1"), { content: "PARLOX_VERIFY_TOKEN=t1\n", changed: true });
  assert.deepEqual(setEnvValue("A=1", "PARLOX_VERIFY_TOKEN", "t1"), { content: "A=1\nPARLOX_VERIFY_TOKEN=t1\n", changed: true });
});

test("an existing value is replaced in place; the same value is no change", () => {
  assert.deepEqual(setEnvValue("A=1\nPARLOX_VERIFY_TOKEN=old\nB=2\n", "PARLOX_VERIFY_TOKEN", "new"), { content: "A=1\nPARLOX_VERIFY_TOKEN=new\nB=2\n", changed: true });
  assert.equal(setEnvValue("PARLOX_VERIFY_TOKEN=t1\n", "PARLOX_VERIFY_TOKEN", "t1").changed, false);
  assert.equal(setEnvValue("export PARLOX_VERIFY_TOKEN=\"t1\"\n", "PARLOX_VERIFY_TOKEN", "t1").changed, false);
});

test("CRLF files stay CRLF", () => {
  assert.equal(setEnvValue("A=1\r\nB=2\r\n", "PARLOX_VERIFY_TOKEN", "t").content, "A=1\r\nB=2\r\nPARLOX_VERIFY_TOKEN=t\r\n");
  assert.equal(setEnvValue("A=1\r\nPARLOX_VERIFY_TOKEN=x\r\n", "PARLOX_VERIFY_TOKEN", "t").content, "A=1\r\nPARLOX_VERIFY_TOKEN=t\r\n");
});

test("values that could break the file are refused", () => {
  assert.throws(() => setEnvValue(null, "PARLOX_VERIFY_TOKEN", "a\nB=2"), /invalid/);
  assert.throws(() => setEnvValue(null, "PARLOX_VERIFY_TOKEN", "a b"), /invalid/);
});

test("remove: the line goes; a file left empty is deleted", () => {
  assert.deepEqual(removeEnvValue("A=1\nPARLOX_VERIFY_TOKEN=t\n", "PARLOX_VERIFY_TOKEN"), { content: "A=1\n", changed: true });
  assert.deepEqual(removeEnvValue("PARLOX_VERIFY_TOKEN=t\n", "PARLOX_VERIFY_TOKEN"), { content: null, changed: true });
  assert.equal(removeEnvValue("A=1\n", "PARLOX_VERIFY_TOKEN").changed, false);
});

test("gitignore line added once", () => {
  assert.deepEqual(addGitignoreLine(null, ".env.local"), { content: ".env.local\n", changed: true });
  assert.deepEqual(addGitignoreLine("node_modules", ".env.local"), { content: "node_modules\n.env.local\n", changed: true });
  assert.equal(addGitignoreLine("node_modules\n.env.local\n", ".env.local").changed, false);
});

test("an indented line (dotenv allows leading whitespace) is found, replaced in place and removed", () => {
  assert.deepEqual(setEnvValue("A=1\n  PARLOX_SECRET_KEY=old\nB=2\n", "PARLOX_SECRET_KEY", "new"), { content: "A=1\n  PARLOX_SECRET_KEY=new\nB=2\n", changed: true });
  assert.equal(setEnvValue("\tPARLOX_SECRET_KEY=same\n", "PARLOX_SECRET_KEY", "same").changed, false);
  assert.deepEqual(removeEnvValue("A=1\n   export PARLOX_SECRET_KEY=x\n", "PARLOX_SECRET_KEY"), { content: "A=1\n", changed: true });
  assert.equal(hasEnvValue("A=1\n  PARLOX_SECRET_KEY=x\n", "PARLOX_SECRET_KEY"), true);
  assert.equal(hasEnvValue("\texport PARLOX_SECRET_KEY = x\n", "PARLOX_SECRET_KEY"), true);
  assert.equal(hasEnvValue("A=1\n# PARLOX_SECRET_KEY=x\nMY_PARLOX_SECRET_KEY=x\n", "PARLOX_SECRET_KEY"), false);
  assert.equal(hasEnvValue("PARLOX_SECRET_KEY=\n", "PARLOX_SECRET_KEY"), false, "an empty value is not a key");
  assert.equal(hasEnvValue(null, "PARLOX_SECRET_KEY"), false);
});
