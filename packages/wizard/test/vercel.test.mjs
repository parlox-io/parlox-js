import { test } from "node:test";
import assert from "node:assert/strict";
import { vercelProject, vercelHasVar, addVercelEnv } from "../dist/vercel.js";
import { fixture } from "./helpers.mjs";

function recorder(results) {
  const calls = [];
  const run = (cmd, args, opts) => { calls.push({ cmd, args, input: opts.input }); return results.shift() ?? { status: 0, stdout: "", stderr: "" }; };
  return { calls, run };
}

test("the linked project is named from .vercel/project.json; no CLI or no login: null", async () => {
  const dir = fixture({ ".vercel/project.json": JSON.stringify({ projectName: "shop-prod", projectId: "prj_1" }) });
  assert.deepEqual(await vercelProject(dir, recorder([{ status: 0, stdout: "60.1.3", stderr: "" }, { status: 0, stdout: "me", stderr: "" }]).run), { name: "shop-prod" });
  assert.equal(await vercelProject(fixture({}), recorder([]).run), null);
  assert.equal(await vercelProject(dir, recorder([{ status: 0, stdout: "", stderr: "" }, { status: 1, stdout: "", stderr: "Log in to Vercel" }]).run), null);
});

test("an existing production variable is detected before any key is created", async () => {
  const { run } = recorder([{ status: 0, stdout: " name               value               environments\n PARLOX_SECRET_KEY  Encrypted           Production\n", stderr: "" }]);
  assert.equal(await vercelHasVar("/app", "PARLOX_SECRET_KEY", run), "yes");
  assert.equal(await vercelHasVar("/app", "PARLOX_VERIFY_TOKEN", recorder([{ status: 0, stdout: "No Environment Variables found", stderr: "" }]).run), "no");
});

test("a failing `vercel env ls` is 'unknown', never 'no': a caller must not treat it as absent and create an orphaned key", async () => {
  assert.equal(await vercelHasVar("/app", "PARLOX_SECRET_KEY", recorder([{ status: 1, stdout: "", stderr: "Error: Project not linked" }]).run), "unknown");
  assert.equal(await vercelHasVar("/app", "PARLOX_SECRET_KEY", recorder([{ status: null, stdout: "", stderr: "" }]).run), "unknown");
});

test("the secret is passed on standard input, never in the arguments; production only; sensitive", async () => {
  const { calls, run } = recorder([{ status: 0, stdout: "", stderr: "" }]);
  const secret = "sk_parlox_" + "e".repeat(64);
  assert.deepEqual(await addVercelEnv("/app", "PARLOX_SECRET_KEY", secret, true, run), { ok: true });
  assert.deepEqual(calls[0].args, ["env", "add", "PARLOX_SECRET_KEY", "production", "--sensitive"]);
  assert.equal(calls[0].input, secret);
  assert.equal(calls[0].args.join(" ").includes(secret), false);
});

test("a failure message never contains the value", async () => {
  const secret = "sk_parlox_" + "e".repeat(64);
  const r = await addVercelEnv("/app", "PARLOX_SECRET_KEY", secret, true, recorder([{ status: 1, stdout: "", stderr: `Error: bad value ${secret}` }]).run);
  assert.equal(r.ok, false);
  assert.equal(r.message.includes(secret), false);
});
