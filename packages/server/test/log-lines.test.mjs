// The recorder the purchase, queue and server tests keep the SDK's log lines in (test-support/log-lines.mjs): its
// check passes the lines the SDK means to write, each said once by its instance, and fails a file in which an
// instance says one twice, a line the SDK does not write appears, or a line comes from no tracked instance. Each case
// runs in a child process of its own.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const here = import.meta.dirname;
const helper = pathToFileURL(resolve(here, "../test-support/log-lines.mjs")).href;
const core = pathToFileURL(resolve(here, "../dist/esm/index.js")).href;
const dir = mkdtempSync(join(tmpdir(), "parlox-log-lines-"));
const REFUSED = "@parlox/server: Parlox refused the order (HTTP 403): This key can only send crawler reports. (said once per instance; onError receives every refusal)";

/** Runs a test file with `body` after the imports; its exit status and output. */
function run(name, body) {
  const file = join(dir, `${name}.test.mjs`);
  writeFileSync(file, `import { test } from "node:test";\nimport { checkLogLines, tracked } from ${JSON.stringify(helper)};\nimport { createParlox as createCore } from ${JSON.stringify(core)};\nconst createParlox = tracked(createCore);\n// An instance that says a refusal the way the SDK does: right after it tells onError.\nconst refuser = tracked((options) => ({ refuse() { options.onError(new Error("refused")); console.warn(${JSON.stringify(REFUSED)}); } }));\n${body}\ntest("checked", () => { checkLogLines(); });\n`);
  // The child runs its tests on its own, not as part of this run.
  const { NODE_TEST_CONTEXT, ...env } = process.env;
  const r = spawnSync(process.execPath, [file], { encoding: "utf8", timeout: 60_000, env });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

test("the SDK's own lines, each once per instance, pass", () => {
  const r = run("ok", `test("two instances with an empty key, and one refusal each", () => { createParlox({ secretKey: "" }); createParlox({ secretKey: undefined }); refuser({}).refuse(); refuser({ onError() {} }).refuse(); });`);
  assert.equal(r.status, 0, r.out);
});

test("a line said twice by one instance, a line the SDK does not write, or a line from no tracked instance fails the file", () => {
  const twice = run("twice", `test("one instance refuses twice", () => { const p = refuser({}); p.refuse(); p.refuse(); });`);
  assert.equal(twice.status, 1, twice.out);
  assert.match(twice.out, /said a refused order more than once/);
  const other = run("other", `test("another line", () => { console.warn("@parlox/server: something else"); });`);
  assert.equal(other.status, 1, other.out);
  assert.match(other.out, /a line the SDK is not meant to write: @parlox\/server: something else/);
  const untracked = run("untracked", `test("an instance made without the recorder", () => { createCore({ secretKey: "" }); });`);
  assert.equal(untracked.status, 1, untracked.out);
  assert.match(untracked.out, /a line no tracked instance said/);
});
