import { test } from "node:test";
import assert from "node:assert/strict";
import { chooseFace } from "../dist/face.js";

const ok = { stdoutTTY: true, stdinTTY: true, columns: 120, rows: 40, env: {}, platform: "darwin", argv: [] };
test("full screen only in a real, large enough, interactive terminal", () => {
  assert.equal(chooseFace(ok), "full");
  for (const [name, change] of [
    ["piped stdout", { stdoutTTY: false }], ["piped stdin", { stdinTTY: false }], ["CI", { env: { CI: "true" } }],
    ["narrow", { columns: 79 }], ["short", { rows: 23 }], ["dumb terminal", { env: { TERM: "dumb" } }],
    ["--yes", { argv: ["--yes"] }], ["--plain", { argv: ["init", "--plain"] }], ["legacy Windows console", { platform: "win32" }],
  ]) assert.equal(chooseFace({ ...ok, ...change }), "plain", name);
  assert.equal(chooseFace({ ...ok, platform: "win32", env: { WT_SESSION: "x" } }), "full");
  assert.equal(chooseFace({ ...ok, platform: "win32", env: { TERM_PROGRAM: "vscode" } }), "full");
});

// Ink switches to its CI mode (no redraws, only the last frame at exit) whenever CI or CONTINUOUS_INTEGRATION is
// present and not "0"/"false"; the plain face is chosen whenever CI is set at all (so never a blank full screen).
test("any CI variable means the plain face, whatever its value", () => {
  for (const env of [{ CI: "" }, { CI: "1" }, { CI: "false" }, { CI: "0" }, { CONTINUOUS_INTEGRATION: "true" }]) {
    assert.equal(chooseFace({ ...ok, env }), "plain", JSON.stringify(env));
  }
  assert.equal(chooseFace({ ...ok, env: { CI: undefined } }), "full");
});
