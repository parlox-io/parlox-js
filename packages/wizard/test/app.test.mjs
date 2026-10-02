import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { render } from "ink-testing-library";
import { App } from "../dist/tui/App.js";
import { WizardStore } from "../dist/tui/store.js";
import { INPUT_DELAY_MS } from "../dist/tui/Prompt.js";
import { answerable as pastGuard, drawn, effects, outcome, ready, until, wait } from "./helpers.mjs";

// Every wait below is on what the screen draws or the store holds (helpers.mjs), not on a fixed time. A question takes
// keys only INPUT_DELAY_MS after it appears (a double tap must not answer it unseen): answerable() waits until it is
// drawn, then out the guard.
const answerable = (lastFrame, re) => pastGuard(lastFrame, re, INPUT_DELAY_MS);
const DOWN = "\u001B[B";
const SECRET = "sk_parlox_" + "f".repeat(64);

test("welcome: wordmark, tagline, the five steps and the promise panel; Enter starts", async () => {
  const s = new WizardStore();
  const { lastFrame, stdin, unmount } = render(createElement(App, { store: s }));
  const f = lastFrame();
  assert.match(f, /P A R L O X/);
  assert.match(f, /Your next customer is software\./);
  assert.match(f, /Sign in/); assert.match(f, /Pick your site/); assert.match(f, /Review the changes/); assert.match(f, /Install and connect/);
  assert.match(f, /never puts your secret key on this computer/i);
  assert.match(f, /never sends your code anywhere/i);
  const started = s.waitForStart();
  await ready(stdin);
  stdin.write("\r"); await until(() => s.getSnapshot().started, "the start");
  assert.equal(await started, true);
  unmount();
});

// "never puts your secret key on this computer" is not true under --local-key, which asks for exactly
// that; the promise says what that run does instead.
test("welcome: with --local-key, the promise says a key for crawler reports only goes in the local env file, because it was asked for", async () => {
  const s = new WizardStore();
  const { lastFrame, unmount } = render(createElement(App, { store: s, localKey: true }));
  const f = lastFrame().replace(/\s+/g, " ");
  assert.match(f, /puts a key for crawler reports only in your local env file, because you asked \(--local-key\)/);
  assert.doesNotMatch(f, /never puts your secret key/i);
  unmount();
  const plain = render(createElement(App, { store: new WizardStore() }));
  assert.match(plain.lastFrame(), /never puts your secret key on this computer/i);
  assert.doesNotMatch(plain.lastFrame(), /--local-key/);
  plain.unmount();
});

test("q on the welcome screen quits without starting", async () => {
  const s = new WizardStore();
  const { stdin, unmount } = render(createElement(App, { store: s }));
  const started = s.waitForStart();
  const o = outcome(started);
  await ready(stdin);
  stdin.write("q"); await until(() => o.done, "the quit");
  assert.equal(await started, false);
  unmount();
});

test("a step screen shows facts and a select prompt driven by the arrow keys", async () => {
  const s = new WizardStore(); s.start();
  s.step("detect", "active"); s.fact("Found", "Next.js 16 · App Router · TypeScript · npm"); s.fact("Git", "clean");
  s.step("detect", "done"); s.step("site", "active");
  const { lastFrame, stdin, unmount } = render(createElement(App, { store: s }));
  const answer = s.select("Which site is this project?", [{ value: "a", label: "Shop (shop.example.com)" }, { value: "new", label: "A new site" }]);
  const o = outcome(answer);
  await answerable(lastFrame, /Which site is this project\?/);
  assert.match(lastFrame(), /Next\.js 16 · App Router/);
  assert.match(lastFrame(), /Which site is this project\?/);
  stdin.write(DOWN); await drawn(lastFrame, /● A new site/);
  stdin.write("\r"); await until(() => o.done, "the answer");
  assert.equal(await answer, "new");
  unmount();
});

// An empty answer returns "" as the plain face (clack) does, and the flow applies its own
// default (cli.ts: `|| "http://localhost:3000"`, `name || domain`). A placeholder is an example, not an answer: the
// domain question's placeholder is "shop.example.com", which must never become the site that gets created.
test("text prompt: typing, backspace and Enter; an empty answer is empty, never the placeholder", async () => {
  const s = new WizardStore(); s.start(); s.step("site", "active");
  const { lastFrame, stdin, unmount } = render(createElement(App, { store: s }));
  const a = s.text("The site's domain", "shop.example.com"); const oa = outcome(a);
  await answerable(lastFrame, /The site's domain/);
  assert.match(lastFrame(), /shop\.example\.com/, "the placeholder is shown");
  stdin.write("marg"); await drawn(lastFrame, /marg▌/); stdin.write("\u007F"); await drawn(lastFrame, /mar▌/); stdin.write("\r"); await until(() => oa.done, "the answer");
  assert.equal(await a, "mar");
  const b = s.text("Local URL", "http://localhost:3000"); const ob = outcome(b);
  await answerable(lastFrame, /Local URL/);
  stdin.write("\r"); await until(() => ob.done, "the empty answer");
  assert.equal(await b, "");
  unmount();
});

test("typing q in a text answer types it and does not quit", async () => {
  const s = new WizardStore(); s.start(); s.step("site", "active");
  const { lastFrame, stdin, unmount } = render(createElement(App, { store: s }));
  const a = s.text("The site's domain", "shop.example.com"); const o = outcome(a);
  await answerable(lastFrame, /The site's domain/);
  stdin.write("quilts.com"); await drawn(lastFrame, /quilts\.com▌/); stdin.write("\r"); await until(() => o.done, "the answer");
  assert.equal(await a, "quilts.com");
  assert.equal(s.getSnapshot().quitAsked, false);
  unmount();
});

test("q while a prompt is pending cancels it", async () => {
  const s = new WizardStore(); s.start(); s.step("site", "active");
  const { lastFrame, stdin, unmount } = render(createElement(App, { store: s }));
  const a = s.confirm("Apply these changes to shop?"); const o = outcome(a);
  await drawn(lastFrame, /Apply these changes to shop\?/);
  // The expectation is attached before q is typed: the rejection happens as q is handled, and a rejection with no
  // handler yet fails the test as unhandled.
  const rejected = assert.rejects(a, /Cancelled\./);
  stdin.write("q"); await until(() => o.done, "the cancel");
  await rejected;
  unmount();
});

// The quit question and a Yes/No question must never share a keypress: a "y" meant for "Quit now?" must not also
// answer "Apply these changes?" with Yes (which would write the files on the way out).
test("while 'Quit now?' is showing, y and n answer only that question", async () => {
  const s = new WizardStore(); s.start(); s.step("review", "active");
  let finished = 0;
  const { lastFrame, stdin, unmount } = render(createElement(App, { store: s, onQuit: () => { finished++; } }));
  s.requestQuit(); await drawn(lastFrame, /Quit now\? \(y \/ n\)/);
  assert.match(lastFrame(), /Quit now\? \(y \/ n\)/);
  let settled = false;
  const apply = s.confirm("Apply these changes to shop?"); apply.then(() => (settled = true), () => (settled = true));
  await drawn(lastFrame, /Apply these changes to shop\?/);
  stdin.write("n"); await until(() => !s.getSnapshot().quitAsked, "n handled"); await effects();
  assert.equal(s.getSnapshot().quitAsked, false);
  assert.equal(settled, false, "n dismissed the quit question only");
  s.requestQuit(); // with the prompt pending, q cancels it instead of asking
  await assert.rejects(apply, /Cancelled\./);
  s.requestQuit(); await drawn(lastFrame, /Quit now\?/);
  const again = s.confirm("Apply these changes to shop?"); let settled2 = false; again.then(() => (settled2 = true), () => (settled2 = true));
  await drawn(lastFrame, /Apply these changes to shop\?/);
  stdin.write("y"); await until(() => finished === 1, "y handled"); await effects();
  assert.equal(finished, 1, "y confirmed the quit");
  assert.equal(settled2, false, "y did not answer the Apply question");
  s.cancelPrompt(); await assert.rejects(again, /Cancelled\./);
  unmount();
});

test("done screen shows the report card", async () => {
  const s = new WizardStore(); s.start();
  s.report(["Server part: verified locally.", "Browser part: added to your code; confirmed after you deploy."], "Parlox is installed"); s.step("done", "done");
  const { lastFrame, unmount } = render(createElement(App, { store: s }));
  await drawn(lastFrame, /Parlox is installed/);
  assert.match(lastFrame(), /Parlox is installed/);
  assert.match(lastFrame(), /verified locally/);
  unmount();
});

test("Enter on the done screen finishes", async () => {
  const s = new WizardStore(); s.start(); s.report(["ok"], "Parlox is installed"); s.step("done", "done");
  let finished = 0;
  const { stdin, unmount } = render(createElement(App, { store: s, onFinish: () => { finished++; } }));
  await ready(stdin); stdin.write("\r"); await until(() => finished > 0, "Enter handled"); await effects();
  assert.equal(finished, 1);
  unmount();
});

test("the review step lists the files and the host step shows the hand-off", async () => {
  const s = new WizardStore(); s.start(); s.step("review", "active");
  s.changes({ changes: [{ path: "app/layout.tsx", before: "a\n", after: "a\nb\n" }, { path: ".env.local", before: null, after: "PARLOX_VERIFY_TOKEN=vt\n" }], install: { command: "npm", args: ["install", "--save-exact", "@parlox/browser@1.0.3"] }, manual: [], warnings: ["proxy.ts: check the matcher"] }, "shop", "install");
  const { lastFrame, unmount } = render(createElement(App, { store: s }));
  await drawn(lastFrame, /Changes in shop: 2 files/);
  assert.match(lastFrame(), /Changes in shop: 2 files/);
  assert.match(lastFrame(), /app\/layout\.tsx .*\+1 -0 .*browser part/);
  assert.match(lastFrame(), /\.env\.local .*ownership token/);
  assert.match(lastFrame(), /Will run: npm install --save-exact @parlox\/browser@1\.0\.3/);
  assert.match(lastFrame(), /check the matcher/);
  s.step("review", "done"); s.step("host", "active");
  s.handoff({ host: "Netlify", url: "https://app.parlox.io/sites/1?newKey=Netlify%20%C2%B7%20production#keys", where: "Project configuration → Environment variables", docs: null, variables: ["PARLOX_SECRET_KEY (from the dashboard key, shown once)", "PARLOX_VERIFY_TOKEN=vt"] });
  await drawn(lastFrame, /Set on Netlify:/);
  assert.match(lastFrame(), /Set on Netlify:/);
  assert.match(lastFrame(), /Create the secret key here \(shown once\):/);
  assert.match(lastFrame(), /Where to paste: Project configuration/);
  unmount();
});

test("the secret never appears in any frame", async () => {
  const s = new WizardStore(); s.start();
  s.step("detect", "active"); s.info(`leak ${SECRET}`); s.fact("x", SECRET); s.log(SECRET);
  const { frames, lastFrame, unmount } = render(createElement(App, { store: s }));
  await drawn(lastFrame, /Checking your project/);
  // A --local-key uninstall: the .env.local diff holds the key.
  s.step("detect", "done"); s.step("review", "active");
  s.changes({ changes: [{ path: ".env.local", before: `PARLOX_VERIFY_TOKEN=vt\nPARLOX_SECRET_KEY=${SECRET}\n`, after: null }], install: null, manual: [{ file: "proxy.ts", reason: `r ${SECRET}`, snippet: SECRET }], warnings: [SECRET] }, `shop-${SECRET}`, "uninstall");
  s.task("install", "active", SECRET);
  const asked = s.select(`Which ${SECRET}?`, [{ value: 1, label: SECRET }]); asked.catch(() => {});
  await drawn(lastFrame, /Which \[hidden\]\?/); s.cancelPrompt(); await drawn(lastFrame, /^(?![\s\S]*Which \[hidden\])/);
  const typed = s.text(SECRET, SECRET); typed.catch(() => {});
  await drawn(lastFrame, /◆ \[hidden\]/); s.cancelPrompt(); await drawn(lastFrame, /^(?![\s\S]*◆ \[hidden\])/);
  // A hand-off with a key in a field.
  s.step("review", "done"); s.step("host", "active");
  s.handoff({ host: SECRET, url: `https://app.parlox.io/?k=${SECRET}`, where: SECRET, docs: `https://docs/${SECRET}`, variables: [`PARLOX_SECRET_KEY=${SECRET}`] });
  await drawn(lastFrame, /Set on \[hidden\]:/); s.report([SECRET], SECRET); s.step("done", "done"); await drawn(lastFrame, /\[hidden\] ✔/);
  assert.ok(frames.length > 3);
  assert.equal(frames.some((f) => f.includes(SECRET)), false);
  assert.ok(frames.some((f) => f.includes("[hidden]")), "the scrubbed text was drawn");
  unmount();
});

// Browsers delay permission-dialog buttons for the same reason: a key meant for what was on screen before must not
// answer a question the person has not seen.
test("keys pressed within 250 ms of a question appearing are ignored; after that they count", async (t) => {
  assert.equal(INPUT_DELAY_MS, 250);
  const s = new WizardStore(); s.start(); s.step("review", "active");
  const { lastFrame, stdin, unmount } = render(createElement(App, { store: s }));
  const apply = s.confirm("Apply these changes to shop?");
  const askedAt = Date.now();
  let settled = false;
  apply.then(() => (settled = true), () => (settled = true));
  await drawn(lastFrame, /Apply these changes to shop\?/);
  // Enter, then y once Enter has been handled (both within the guard: nothing is drawn in between).
  stdin.write("\r"); await effects(); stdin.write("y");
  const late = Date.now() - askedAt >= INPUT_DELAY_MS - 50; // the machine stalled; the keys may be past the guard
  await effects();
  if (late) t.diagnostic(`the keys came ${Date.now() - askedAt} ms after the question; not asserted`);
  else assert.equal(settled, false, "Enter and y within 250 ms of the question were ignored");
  await wait(INPUT_DELAY_MS + 100); // the question was drawn and listening before the keys: past the guard from then
  stdin.write("\r"); await until(() => settled, "Enter after the guard");
  assert.equal(await apply, true);
  unmount();
});

// As in cli.ts: "Which app?" is followed at once by "Continue anyway?" (a dirty tree); in an uninstall, "Remove
// these?" follows "Continue anyway?". A double tap of Enter must answer only the first question.
test("a second Enter right after an answer never answers the next question", async (t) => {
  for (const gap of [0, 1, 20]) {
    const s = new WizardStore(); s.start(); s.step("detect", "active");
    const { lastFrame, stdin, unmount } = render(createElement(App, { store: s }));
    let go = "pending";
    const flow = (async () => {
      const app = await s.select("Which app should Parlox be installed in?", [{ value: "apps/web", label: "apps/web" }, { value: "apps/shop", label: "apps/shop" }]);
      s.confirm("Continue anyway?").then((v) => (go = v), () => (go = "cancelled"));
      return app;
    })();
    const o = outcome(flow);
    await answerable(lastFrame, /Which app should Parlox be installed in\?/);
    stdin.write("\r");
    const firstAt = Date.now();
    if (gap) await wait(gap); // the gap between the two Enters is what this test varies
    const late = Date.now() - firstAt >= INPUT_DELAY_MS - 50; // the machine stalled; the second Enter may be past the guard
    stdin.write("\r");
    await until(() => o.done, "the first answer"); await effects();
    assert.equal(await flow, "apps/web");
    if (late) t.diagnostic(`${gap} ms apart: the second Enter came ${Date.now() - firstAt} ms later; not asserted`);
    else {
      assert.equal(go, "pending", `${gap} ms apart: "Continue anyway?" is still open`);
      assert.equal(s.getSnapshot().prompt?.message, "Continue anyway?");
    }
    s.cancelPrompt(); await effects();
    unmount();
  }
});

// The done card shows while the flow is still signing out; closing it is not a quit (no "Quit now?", no stop).
test("the done card: Enter, q, Esc and Ctrl-C close it; none of them is a quit", async () => {
  for (const [name, key] of [["Enter", "\r"], ["q", "q"], ["Esc", "\u001B"], ["Ctrl-C", "\u0003"]]) {
    const s = new WizardStore(); s.start(); s.report(["ok"], "Parlox is installed"); s.step("done", "done");
    let finished = 0, quits = 0;
    const { lastFrame, stdin, unmount } = render(createElement(App, { store: s, onFinish: () => { finished++; }, onQuit: () => { quits++; } }));
    await ready(stdin); stdin.write(key); await until(() => finished > 0 || quits > 0, `${name} handled`); await effects();
    assert.equal(finished, 1, `${name} closes the done card`);
    assert.equal(quits, 0, `${name} is not a quit`);
    assert.equal(s.getSnapshot().quitAsked, false);
    assert.doesNotMatch(lastFrame(), /Quit now\?/);
    unmount();
  }
});

test("while the app is closing, it says so and ignores keys, except Ctrl-C, which asks to leave at once", async () => {
  const s = new WizardStore(); s.start(); s.step("install", "active");
  let quits = 0;
  const { lastFrame, stdin, unmount } = render(createElement(App, { store: s, onQuit: () => { quits++; } }));
  await ready(stdin);
  s.stop(); await drawn(lastFrame, /Stopping…/);
  assert.match(lastFrame(), /Stopping…/);
  stdin.write("q"); await effects();
  assert.equal(s.getSnapshot().quitAsked, false, "q does not ask again");
  assert.equal(quits, 0);
  stdin.write("\u0003"); await until(() => quits > 0, "Ctrl-C handled");
  assert.equal(quits, 1);
  s.showClosing("Signing out…"); await drawn(lastFrame, /Signing out…/);
  assert.match(lastFrame(), /Signing out…/);
  unmount();
});

// "Quit now?" is showing (q pressed while the flow was loading) and "Apply these changes?" arrives behind it. The
// person answers "Quit now?" as a line prompt would be answered: n, then Enter. The Enter must not answer the Apply
// question that has just become answerable (it would write the files unseen): the guard restarts when the question
// starts taking keys, not when it was first drawn behind "Quit now?".
test("a question that becomes answerable when 'Quit now?' is dismissed ignores keys for 250 ms from then", async (t) => {
  for (const gap of [30, 120]) {
    const s = new WizardStore(); s.start(); s.step("review", "active");
    const { lastFrame, stdin, unmount } = render(createElement(App, { store: s, onQuit: () => {} }));
    s.requestQuit(); await drawn(lastFrame, /Quit now\?/);
    const apply = s.confirm("Apply these changes to shop?");
    let result = "pending";
    apply.then((v) => (result = v), () => (result = "cancelled"));
    // Longer than the guard: the question has been on screen, behind "Quit now?"
    await answerable(lastFrame, /Apply these changes to shop\?/);
    stdin.write("n");
    const dismissedAt = Date.now();
    // "Quit now?" is gone and the question takes keys (its guard restarts as it does).
    await until(() => !s.getSnapshot().quitAsked, "n handled"); await effects();
    const rest = gap - (Date.now() - dismissedAt);
    if (rest > 0) await wait(rest); // the gap between n and Enter is what this test varies
    const late = Date.now() - dismissedAt >= INPUT_DELAY_MS - 50; // the machine stalled; the Enter may be past the guard
    stdin.write("\r"); await effects();
    if (late) t.diagnostic(`gap ${gap} ms: the Enter came ${Date.now() - dismissedAt} ms after the n; not asserted`);
    else assert.equal(result, "pending", `n, then Enter ${gap} ms later: the Apply question is not answered`);
    await wait(INPUT_DELAY_MS + 100); // past the guard, counted from when the question started taking keys
    stdin.write("\r"); await until(() => result !== "pending", "Enter after the guard");
    assert.equal(await apply, true, "after the guard, Enter answers it");
    unmount();
  }
});

// Several keys can reach a question before it is drawn again (typed together, or while the machine was busy). Each
// key must see the ones before it: the answer is what was typed or chosen, never what the screen showed before the
// last key. Written as separate reads with no redraw between them, so the race is exercised every time.
test("keys that arrive together answer with everything before them: text, select and Yes/No", async () => {
  const s = new WizardStore(); s.start(); s.step("site", "active");
  const { lastFrame, stdin, unmount } = render(createElement(App, { store: s }));
  const a = s.text("The site's domain", "shop.example.com"); const oa = outcome(a);
  await answerable(lastFrame, /The site's domain/);
  stdin.write("x"); stdin.write("\r"); await until(() => oa.done, "the text answer");
  assert.equal(await a, "x");
  const b = s.select("Which site is this project?", [{ value: "a", label: "Shop" }, { value: "b", label: "A new site" }]); const ob = outcome(b);
  await answerable(lastFrame, /Which site is this project\?/);
  stdin.write(DOWN); stdin.write("\r"); await until(() => ob.done, "the choice");
  assert.equal(await b, "b");
  const c = s.confirm("Apply these changes to shop?"); const oc = outcome(c);
  await answerable(lastFrame, /Apply these changes to shop\?/);
  stdin.write("\u001B[C"); stdin.write("\r"); await until(() => oc.done, "the Yes/No answer");
  assert.equal(await c, false);
  unmount();
});
