import { test } from "node:test";
import assert from "node:assert/strict";
import { WizardStore, MAX_LOG_LINES, MAX_LINE, handoffLines } from "../dist/tui/store.js";

const SECRET = "sk_parlox_" + "c".repeat(64);
const OLD_SECRET = "sk_" + "e".repeat(64);

test("every string stored is scrubbed", () => {
  const s = new WizardStore();
  s.info(`hello ${SECRET}`); s.warn(SECRET); s.log(`npm echo ${SECRET}`); s.fact("Key", SECRET); s.report([SECRET]);
  assert.equal(JSON.stringify(s.getSnapshot()).includes(SECRET), false);
});

// A --local-key uninstall diffs .env.local, which holds the key; a hand-off, a task detail, a prompt or a title could
// carry one too. Everything the store keeps for display is scrubbed, including the plan it hands to the screens.
test("plan, target, hand-off, task details, prompts, fact labels and the report title are scrubbed too", async () => {
  const s = new WizardStore();
  const plan = {
    changes: [{ path: ".env.local", before: `PARLOX_SECRET_KEY=${SECRET}\n`, after: `PARLOX_SECRET_KEY=${SECRET}\nPARLOX_VERIFY_TOKEN=vt\nOLD=${OLD_SECRET}\n` }, { path: `x-${SECRET}.ts`, before: null, after: "a" }],
    install: { command: "npm", args: ["install", "@parlox/server@1.0.1"] },
    manual: [{ file: `m-${SECRET}`, reason: `r ${SECRET}`, snippet: `s ${SECRET}` }],
    warnings: [`w ${SECRET}`],
  };
  s.changes(plan, `app-${SECRET}`, "uninstall");
  s.handoff({ host: `h ${SECRET}`, url: `https://app.parlox.io/k?x=${SECRET}`, where: `w ${SECRET}`, docs: `https://docs.example/${SECRET}`, variables: [`PARLOX_SECRET_KEY=${SECRET}`] });
  s.task("install", "active", `detail ${SECRET}`);
  s.fact(`label ${SECRET}`, "v");
  s.report([OLD_SECRET], `title ${SECRET}`);
  const snapshotHasNoKey = () => { const j = JSON.stringify(s.getSnapshot()); return !j.includes(SECRET) && !j.includes(OLD_SECRET); };
  assert.ok(snapshotHasNoKey());
  // An env file is kept as the review shows it: Parlox's own line, and how many others there are.
  assert.equal(s.getSnapshot().plan.changes[0].after, "[your line 1, not shown]\nPARLOX_VERIFY_TOKEN=vt\n[your line 2, not shown]\n");
  assert.equal(s.getSnapshot().plan.changes[0].hiddenLines, 2);
  assert.equal(plan.changes[0].before, `PARLOX_SECRET_KEY=${SECRET}\n`, "the flow's own plan is not modified");

  const p = s.select(`pick ${SECRET}`, [{ value: { id: "site-1" }, label: `Shop ${SECRET}` }]);
  assert.ok(snapshotHasNoKey());
  s.answer(s.getSnapshot().prompt.options[0].value);
  assert.deepEqual(await p, { id: "site-1" }, "option values are returned unchanged");
  const q = s.text(`domain ${SECRET}`, SECRET);
  assert.ok(snapshotHasNoKey());
  s.cancelPrompt();
  await assert.rejects(q, /Cancelled\./);
});

test("the hand-off reads as in the plain face, with each link on a line of its own", () => {
  const lines = handoffLines({ host: "Netlify", url: "https://app.parlox.io/sites/1?newKey=Netlify%20%C2%B7%20production#keys", where: "Project configuration → Environment variables", docs: "https://docs.netlify.com/build/environment-variables/get-started/", variables: ["PARLOX_SECRET_KEY (from the dashboard key, shown once)", "PARLOX_VERIFY_TOKEN=vt"] });
  assert.deepEqual(lines, [
    "Set on Netlify:",
    "  PARLOX_SECRET_KEY (from the dashboard key, shown once)",
    "  PARLOX_VERIFY_TOKEN=vt",
    "Where to paste: Project configuration → Environment variables",
    "Create the secret key here (shown once):",
    "  https://app.parlox.io/sites/1?newKey=Netlify%20%C2%B7%20production#keys",
    "Docs:",
    "  https://docs.netlify.com/build/environment-variables/get-started/",
  ]);
  // Only the token left to set (the secret is already on the host): no key line at all.
  assert.deepEqual(handoffLines({ host: "Vercel", url: null, where: "w", docs: null, variables: ["PARLOX_VERIFY_TOKEN=vt"] }), ["Set on Vercel:", "  PARLOX_VERIFY_TOKEN=vt", "Where to paste: w"]);
});

test("logs keep the last 500 lines, each at most 2000 characters", () => {
  const s = new WizardStore();
  for (let i = 0; i < 1200; i++) s.log(`line ${i} ` + "x".repeat(3000));
  const { logs } = s.getSnapshot();
  assert.equal(logs.length, MAX_LOG_LINES);
  assert.ok(logs.every((l) => l.length <= MAX_LINE));
  assert.match(logs.at(-1), /^line 1199 /);
});

test("prompts resolve through answer and reject with Cancelled. on cancel", async () => {
  const s = new WizardStore();
  const p = s.select("Which?", [{ value: "a", label: "A" }, { value: "b", label: "B" }]);
  assert.equal(s.getSnapshot().prompt.kind, "select");
  s.answer("b");
  assert.equal(await p, "b");
  assert.equal(s.getSnapshot().prompt, null);
  const q = s.text("Domain");
  s.cancelPrompt();
  await assert.rejects(q, /Cancelled\./);
});

test("step and task status; the current step follows the active one", () => {
  const s = new WizardStore();
  s.step("detect", "active"); assert.equal(s.getSnapshot().step, "detect");
  s.step("detect", "done"); s.step("review", "active");
  assert.equal(s.getSnapshot().steps.detect, "done");
  assert.equal(s.getSnapshot().step, "review");
  s.task("install", "active", "Installing"); assert.deepEqual(s.getSnapshot().tasks.install, { status: "active", detail: "Installing" });
});

test("snapshots are new objects on change and stable otherwise", () => {
  const s = new WizardStore();
  const a = s.getSnapshot(); assert.equal(s.getSnapshot(), a);
  s.info("x"); assert.notEqual(s.getSnapshot(), a);
});

test("waitForStart resolves true on start and false on quit", async () => {
  const a = new WizardStore(); setTimeout(() => a.start(), 5); assert.equal(await a.waitForStart(), true);
  const b = new WizardStore(); setTimeout(() => b.quit(), 5); assert.equal(await b.waitForStart(), false);
});

test("q with a question pending cancels it; otherwise it asks before quitting", async () => {
  const s = new WizardStore();
  const p = s.confirm("Apply?");
  s.requestQuit();
  await assert.rejects(p, /Cancelled\./);
  assert.equal(s.getSnapshot().quitAsked, false);
  s.requestQuit();
  assert.equal(s.getSnapshot().quitAsked, true);
  s.dismissQuit();
  assert.equal(s.getSnapshot().quitAsked, false);
});

// "Before the review is approved, quitting changes nothing": a stop must not leave the flow waiting on a
// question nobody will answer (it would never reach its next check), nor let it ask a new one.
test("a stop cancels the open question and refuses every later one at once", async () => {
  const s = new WizardStore();
  const open = s.confirm("Apply these changes to shop?");
  const rejected = assert.rejects(open, /Cancelled\./);
  s.stop();
  await rejected;
  assert.equal(s.getSnapshot().prompt, null);
  assert.equal(s.getSnapshot().closing, "Stopping…");
  await assert.rejects(s.confirm("Remove these?"), /Cancelled\./);
  await assert.rejects(s.select("Which site is this project?", [{ value: 1, label: "Shop" }]), /Cancelled\./);
  await assert.rejects(s.text("The site's domain"), /Cancelled\./);
  assert.equal(s.getSnapshot().prompt, null, "no question is shown after a stop");
});

// A key handled by a question already answered (the screen had not redrawn yet) carries that question's id.
test("an answer carrying an earlier question's id is dropped", async () => {
  const s = new WizardStore();
  const first = s.select("Which app should Parlox be installed in?", [{ value: "apps/web", label: "apps/web" }]);
  const firstId = s.getSnapshot().prompt.id;
  s.answer("apps/web", firstId);
  assert.equal(await first, "apps/web");
  const second = s.confirm("Continue anyway?");
  let settled = false;
  second.then(() => (settled = true), () => (settled = true));
  s.answer(true, firstId);
  await new Promise((r) => setImmediate(r));
  assert.equal(settled, false, "the stale answer did not answer the new question");
  assert.equal(s.getSnapshot().prompt?.message, "Continue anyway?");
  s.answer(false, s.getSnapshot().prompt.id);
  assert.equal(await second, false);
});

// One question at a time: a second question asked while one is open cancels the older one, which would otherwise
// wait forever for an answer that can no longer be given.
test("a question asked while another is open cancels the older one", async () => {
  const s = new WizardStore();
  const older = s.confirm("Continue anyway?");
  const rejected = assert.rejects(older, /Cancelled\./);
  const newer = s.confirm("Remove these?");
  await rejected;
  assert.equal(s.getSnapshot().prompt.message, "Remove these?");
  s.answer(true);
  assert.equal(await newer, true);
});

// A stop is deliberate, so whatever was still running ends "skipped" (as a declined step does); what the
// flow reports afterwards (the install it interrupted, say) is the outcome and replaces it.
test("a stop marks every step and task still running as skipped; a later report from the flow still wins", () => {
  const s = new WizardStore();
  s.step("detect", "done"); s.step("install", "active"); s.task("install", "active", "Installing @parlox/browser and @parlox/server");
  s.stop();
  const st = s.getSnapshot();
  assert.equal(st.steps.install, "skipped");
  assert.equal(st.steps.detect, "done", "a finished step keeps its outcome");
  assert.equal(st.steps.host, "pending", "a step that never started stays pending");
  assert.deepEqual(st.tasks.install, { status: "skipped" }, "the running line no longer describes it");
  assert.deepEqual(st.tasks.host, { status: "pending" });
  assert.equal(st.step, "install", "the screen stays where it was");
  s.task("install", "failed", "Interrupted"); s.step("install", "failed");
  assert.deepEqual(s.getSnapshot().tasks.install, { status: "failed", detail: "Interrupted" });
  assert.equal(s.getSnapshot().steps.install, "failed");
});

test("each message records the step it came in", () => {
  const s = new WizardStore();
  s.warn("before the start");
  s.step("detect", "active"); s.warn("dirty");
  s.step("signin", "active"); s.info("link");
  assert.deepEqual(s.getSnapshot().messages.map((m) => [m.step, m.text]), [["welcome", "before the start"], ["detect", "dirty"], ["signin", "link"]]);
});
