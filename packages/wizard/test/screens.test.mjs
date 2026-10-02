import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { render } from "ink-testing-library";
import { Box, Text } from "ink";
import { App } from "../dist/tui/App.js";
import { Review } from "../dist/tui/screens/Review.js";
import { Run } from "../dist/tui/screens/Run.js";
import { Signin } from "../dist/tui/screens/Signin.js";
import { HostPanel } from "../dist/tui/screens/HostPanel.js";
import { WizardStore } from "../dist/tui/store.js";
import { INPUT_DELAY_MS } from "../dist/tui/Prompt.js";
import { answerable as pastGuard, outcome, ready, until } from "./helpers.mjs";

const SECRET = "sk_parlox_" + "b".repeat(64);
const OLD_SECRET = "sk_" + "9".repeat(64);

// The tests wait on what is drawn, not on time (helpers.mjs). A question takes keys only INPUT_DELAY_MS after it
// appears: answerable() waits until it is drawn, then out the guard.
const answerable = (lastFrame, re) => pastGuard(lastFrame, re, INPUT_DELAY_MS);
const DOWN = "\u001B[B";

const plan = { install: { command: "npm", args: ["install", "--save-exact", "@parlox/browser@1.0.3"] }, warnings: ["proxy.ts: This file has its own matcher."], manual: [], changes: [
  { path: "app/layout.tsx", before: "a\n", after: "a\nimport { ParloxAnalytics } from \"@parlox/browser/react\";\n" },
  { path: "proxy.ts", before: null, after: Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n") + "\n" },
] };
const netlify = { host: "Netlify", url: "https://app.parlox.io/sites/1?newKey=Netlify%20%C2%B7%20production#keys", where: "Project configuration → Environment variables", docs: "https://docs.netlify.com/build/environment-variables/get-started/", variables: ["PARLOX_SECRET_KEY (from the dashboard key, shown once)", "PARLOX_VERIFY_TOKEN=vt"] };
const review = (s, extra = {}) => createElement(Review, { state: s.getSnapshot(), width: 100, rows: 30, ...extra });
// A frame's line without the box borders around it.
const bare = (l) => l.replace(/[│╭╮╰╯─]/g, "").trim();

test("review lists files with purpose and counts, and names the target folder", () => {
  const s = new WizardStore(); s.changes(plan, "margarita-shop", "install");
  const { lastFrame, unmount } = render(review(s));
  const f = lastFrame();
  assert.match(f, /Changes in margarita-shop: 2 files/);
  assert.match(f, /~ app\/layout\.tsx\s+\+1\s+-0\s+browser part/);
  assert.match(f, /\+ proxy\.ts\s+\+60\s+-0\s+server part/);
  assert.match(f, /npm install --save-exact @parlox\/browser@1\.0\.3/);
  assert.match(f, /This file has its own matcher/);
  unmount();
});

test("an uninstall's review says Removals", () => {
  const s = new WizardStore();
  s.changes({ changes: [{ path: "app/layout.tsx", before: "a\nb\n", after: "a\n" }], install: null, manual: [], warnings: [] }, "shop", "uninstall");
  const { lastFrame, unmount } = render(review(s));
  assert.match(lastFrame(), /Removals in shop: 1 file\b/);
  assert.match(lastFrame(), /~ app\/layout\.tsx\s+\+0\s+-1/);
  unmount();
});

test("Enter opens a file's diff; the diff scrolls; Escape goes back", async () => {
  const s = new WizardStore(); s.changes(plan, "shop", "install");
  const { lastFrame, stdin, unmount } = render(review(s));
  await ready(stdin);
  stdin.write(DOWN); await until(() => /› \+ proxy\.ts/.test(lastFrame()), "the cursor on proxy.ts");
  stdin.write("\r"); await until(() => /\+line 0/.test(lastFrame()), "the diff");
  assert.doesNotMatch(lastFrame(), /\+line 59/);
  for (let i = 0; i < 60; i++) stdin.write(DOWN);
  await until(() => /\+line 59/.test(lastFrame()), "the end of the diff");
  assert.doesNotMatch(lastFrame(), /\+line 0\n/, "scrolled: the first line is off the screen");
  stdin.write("\u001B"); await until(() => /Changes in shop/.test(lastFrame()), "the list again");
  unmount();
});

// Finding 3: the position counts screen rows (a long line takes several), so it says rows.
test("the diff: PgDn, PgUp, Home and End; the position is shown in screen rows", async () => {
  const s = new WizardStore(); s.changes(plan, "shop", "install");
  const { lastFrame, stdin, unmount } = render(review(s));
  await ready(stdin);
  stdin.write(DOWN); stdin.write("d");
  await until(() => /\+line 0/.test(lastFrame()), "the diff");
  assert.match(lastFrame(), /rows 1–18 of 64/);
  stdin.write("\u001B[6~"); await until(() => /rows 19–36 of 64/.test(lastFrame()), "a page down");
  stdin.write("\u001B[F"); await until(() => /\+line 59/.test(lastFrame()), "the end");
  assert.match(lastFrame(), /rows 47–64 of 64/);
  stdin.write("\u001B[5~"); await until(() => /rows 29–46 of 64/.test(lastFrame()), "a page up");
  stdin.write("\u001B[H"); await until(() => /rows 1–18 of 64/.test(lastFrame()), "the start");
  unmount();
});

// A line wider than the screen is wrapped onto the next rows, never cut: every character of a change is reviewable.
// Tabs and control characters are shown as a terminal pager shows them (spaces, ^M), so file content cannot move the
// cursor or restyle the screen.
test("the diff wraps long lines instead of cutting them, and shows tabs and control characters safely", async () => {
  const long = "export const config = { matcher: [" + "\"/x\", ".repeat(30) + "] }; // END";
  const s = new WizardStore();
  s.changes({ changes: [{ path: "proxy.ts", before: null, after: `${long}\n\tindented\r\nbell\u0007 esc\u001B[2J\n` }], install: null, manual: [], warnings: [] }, "shop", "install");
  const { lastFrame, stdin, unmount } = render(review(s));
  await ready(stdin);
  stdin.write("d"); await until(() => /END/.test(lastFrame()), "the end of the long line");
  const f = lastFrame();
  const rows = f.split("\n");
  const first = rows.findIndex((l) => l.startsWith("+export const config"));
  assert.ok(first >= 0);
  assert.equal(rows.slice(first, first + 3).join(""), `+${long}`, "the long line continues on the next rows, whole");
  assert.ok(rows.every((l) => l.length <= 98), "no row is wider than the screen");
  assert.match(f, /\+ {7}indented\^M/);
  assert.match(f, /bell\^G esc\^\[\[2J/);
  assert.equal(/[\t\r\u0007]/.test(f), false);
  unmount();
});

test("with the apply question pending, d opens the diff and Enter is left to the question", async () => {
  const s = new WizardStore(); s.changes(plan, "shop", "install");
  const answered = s.confirm("Apply these changes to shop?");
  const { lastFrame, stdin, unmount } = render(review(s));
  await ready(stdin);
  // Keys are handled in order: had the Enter opened app/layout.tsx's diff, the down arrow would scroll that diff and
  // the cursor would never be seen on proxy.ts.
  stdin.write("\r"); stdin.write(DOWN);
  await until(() => /› \+ proxy\.ts/.test(lastFrame()), "the cursor on proxy.ts");
  assert.match(lastFrame(), /Changes in shop/, "Enter did not open a diff");
  assert.match(lastFrame(), /d show diff/);
  stdin.write("d"); await until(() => /d or Esc back/.test(lastFrame()), "the diff");
  assert.match(lastFrame(), /\+line 0/);
  s.answer(true); assert.equal(await answered, true);
  unmount();
});

test("in the app: the Apply question stays under an open diff, and Enter there answers it", async () => {
  const s = new WizardStore(); s.start(); s.step("review", "active"); s.changes(plan, "shop", "install");
  const { lastFrame, stdin, unmount } = render(createElement(App, { store: s }));
  const apply = s.confirm("Apply these changes to shop?"); const o = outcome(apply);
  await until(() => /Apply these changes to shop\?/.test(lastFrame()), "the question");
  await ready(stdin);
  stdin.write("d"); await until(() => /d or Esc back/.test(lastFrame()), "the diff");
  assert.match(lastFrame(), /Apply these changes to shop\?/);
  await answerable(lastFrame, /Apply these changes to shop\?/);
  stdin.write("\r"); await until(() => o.done, "the answer");
  assert.equal(await apply, true);
  unmount();
});

// Down on an empty list must not move the cursor to -1 (the next list would then have no row selected).
test("review: an empty list keeps the cursor at 0; d and Enter open nothing", async () => {
  const s = new WizardStore();
  s.changes({ changes: [], install: null, manual: [{ file: "proxy.ts", reason: "It has its own matcher", snippet: "x" }], warnings: [] }, "shop", "install");
  const { lastFrame, stdin, rerender, unmount } = render(review(s));
  assert.match(lastFrame(), /Changes in shop: 0 files/);
  assert.match(lastFrame(), /▲ proxy\.ts: It has its own matcher \(add by hand; shown in the summary\)/);
  await ready(stdin);
  stdin.write(DOWN); stdin.write(DOWN); stdin.write("d"); stdin.write("\r");
  s.changes(plan, "shop", "install");
  rerender(review(s));
  await until(() => /› ~ app\/layout\.tsx/.test(lastFrame()), "the first row selected");
  stdin.write(DOWN); await until(() => /› \+ proxy\.ts/.test(lastFrame()), "one down arrow selects the second row");
  unmount();
});

// While "Quit now?" is showing, its y / n / Esc belong to it; the review takes no keys.
test("in the app: while 'Quit now?' is showing, the review ignores keys", async () => {
  const s = new WizardStore(); s.start(); s.step("review", "active"); s.changes(plan, "shop", "install");
  const { lastFrame, stdin, unmount } = render(createElement(App, { store: s }));
  await ready(stdin);
  s.requestQuit(); await until(() => /Quit now\?/.test(lastFrame()), "the quit question");
  stdin.write("d"); stdin.write(DOWN); stdin.write("n");
  await until(() => !/Quit now\?/.test(lastFrame()), "the quit question dismissed");
  assert.doesNotMatch(lastFrame(), /d or Esc back/, "d did not open a diff");
  assert.match(lastFrame(), /› ~ app\/layout\.tsx/, "the down arrow did not move the cursor");
  // Once "Quit now?" is gone the review takes keys again (sent until seen: the review starts listening on its next
  // render; Enter only ever opens a diff, so repeating it is harmless).
  for (let i = 0; i < 500 && !/d or Esc back/.test(lastFrame()); i++) { stdin.write("\r"); await new Promise((r) => setTimeout(r, 10)); }
  assert.match(lastFrame(), /d or Esc back/);
  unmount();
});

test("run view: tasks on the right, tabs switch to Changes and Logs", async () => {
  const s = new WizardStore(); s.changes(plan, "shop", "install");
  s.task("install", "active", "Installing @parlox/browser and @parlox/server"); s.log("added 2 packages in 3s");
  const left = createElement(Text, null, "LEFT PANE");
  const { lastFrame, stdin, unmount } = render(createElement(Run, { state: s.getSnapshot(), width: 120, left }));
  assert.match(lastFrame(), /LEFT PANE/);
  assert.match(lastFrame(), /◐ Install packages/);
  assert.match(lastFrame(), /○ Connect your host/);
  assert.match(lastFrame(), /○ Check locally/);
  assert.match(lastFrame(), /\[Status\]/);
  await ready(stdin);
  stdin.write("\t"); await until(() => /\[Changes\]/.test(lastFrame()), "the Changes tab");
  assert.match(lastFrame(), /~ app\/layout\.tsx\s+\+1\s+-0\s+browser part/);
  assert.match(lastFrame(), /\+ proxy\.ts\s+\+60\s+-0\s+server part/);
  assert.doesNotMatch(lastFrame(), /LEFT PANE/);
  stdin.write("\t"); await until(() => /\[Logs\]/.test(lastFrame()), "the Logs tab");
  assert.match(lastFrame(), /added 2 packages in 3s/);
  stdin.write("\u001B[Z"); await until(() => /\[Changes\]/.test(lastFrame()), "Shift-Tab goes back");
  stdin.write("\t"); stdin.write("\t"); await until(() => /\[Status\]/.test(lastFrame()), "Tab wraps round to Status");
  unmount();
});

test("run view: a task's outcome is shown once it is no longer running; an uninstall shows only the package step", () => {
  const s = new WizardStore();
  s.task("install", "done", "Packages installed"); s.task("host", "skipped"); s.task("check", "failed", "not verified locally (connection refused)");
  const a = render(createElement(Run, { state: s.getSnapshot(), width: 120, left: createElement(Text, null, "x") }));
  assert.match(a.lastFrame(), /✔ Install packages: Packages installed/);
  assert.match(a.lastFrame(), /– Connect your host/);
  assert.match(a.lastFrame(), /✖ Check locally: not verified locally/);
  a.unmount();
  const u = new WizardStore();
  u.changes({ changes: [{ path: "app/layout.tsx", before: "a\nb\n", after: "a\n" }], install: { command: "npm", args: ["uninstall", "@parlox/browser"] }, manual: [], warnings: [] }, "shop", "uninstall");
  u.task("install", "active", "Removing @parlox/browser and @parlox/server");
  const b = render(createElement(Run, { state: u.getSnapshot(), width: 120, left: createElement(Text, null, "x") }));
  assert.match(b.lastFrame(), /◐ Remove packages/);
  assert.doesNotMatch(b.lastFrame(), /Install packages|Connect your host|Check locally/);
  b.unmount();
});

// The task list is a box, so its title "Tasks" is on the row below its top border, while a
// plain left pane starts on the border's row. Side by side means the left pane's first row also holds the box's top
// border (and "Tasks" sits right of the left pane's second row); stacked means the box starts below the left pane.
test("run view stacks its panes below 100 columns", () => {
  const s = new WizardStore();
  const left = createElement(Box, { flexDirection: "column" }, createElement(Text, null, "LEFT PANE"), createElement(Text, null, "SECOND ROW"));
  const wide = render(createElement(Run, { state: s.getSnapshot(), width: 120, left }));
  const narrow = render(createElement(Run, { state: s.getSnapshot(), width: 90, left }));
  const sideBySide = (f) => { const rows = f.split("\n"); const at = rows.findIndex((l) => l.includes("LEFT PANE")); return rows[at].includes("╭") && rows[at + 1].includes("SECOND ROW") && rows[at + 1].includes("Tasks"); };
  assert.equal(sideBySide(wide.lastFrame()), true);
  assert.equal(sideBySide(narrow.lastFrame()), false);
  const rows = narrow.lastFrame().split("\n");
  assert.ok(rows.findIndex((l) => l.includes("Tasks")) > rows.findIndex((l) => l.includes("SECOND ROW")), "stacked: the task list below the left pane");
  wide.unmount(); narrow.unmount();
});

// The hand-off takes the whole width (its links then fit on their lines), with the task list on one line below it:
// the panel and the question below it fit a window of 80 × 24.
test("run view: with a hand-off, the panel takes the left pane's place, full width, and the tasks fit on one line", () => {
  const s = new WizardStore(); s.handoff(netlify); s.task("install", "done", "Packages installed"); s.task("host", "skipped"); s.task("check", "active");
  const { lastFrame, unmount } = render(createElement(Run, { state: s.getSnapshot(), width: 120, left: createElement(Text, null, "LEFT PANE") }));
  const rows = lastFrame().split("\n");
  assert.doesNotMatch(lastFrame(), /LEFT PANE/);
  const tasks = rows.findIndex((l) => l.includes("Tasks"));
  assert.ok(tasks > rows.findIndex((l) => l.includes("Links are printed again")), "below the panel");
  assert.match(rows[tasks], /Tasks +✔ Install packages +– Connect your host +◐ Check locally/);
  assert.ok(rows.length + 2 + 3 <= 24, `the view (${rows.length} rows), the header and a question fit 24 rows`);
  unmount();
});

test("in the app: the run view follows the window's width when it is resized", async () => {
  const s = new WizardStore(); s.start(); s.step("install", "active"); s.task("install", "active", "Installing");
  const { lastFrame, stdout, unmount } = render(createElement(App, { store: s }));
  const sameLine = () => lastFrame().split("\n").some((l) => l.includes("Tasks") && /[✔◐○–✖] \S/.test(l.split("Tasks")[0]));
  await until(() => /Tasks/.test(lastFrame()), "the run view");
  assert.equal(sameLine(), true, "side by side at 100 columns");
  Object.defineProperty(stdout, "columns", { value: 90, configurable: true });
  stdout.emit("resize");
  await until(() => !sameLine(), "the panes stacked at 90 columns");
  unmount();
});

test("run view: the latest messages since the review are shown; earlier steps' are not", () => {
  const s = new WizardStore();
  s.step("detect", "active"); s.warn("Uncommitted changes:\n  app/page.tsx");
  s.step("review", "active"); s.info("Parlox is already installed in this app. Nothing to change.");
  s.step("host", "active"); s.warn("Could not read \"shop\"'s Vercel environment variables.");
  const { lastFrame, unmount } = render(createElement(Run, { state: s.getSnapshot(), width: 120, left: createElement(Text, null, "x") }));
  assert.match(lastFrame(), /● Parlox is already installed/);
  assert.match(lastFrame(), /▲ Could not read "shop"'s Vercel environment variables\./);
  assert.doesNotMatch(lastFrame(), /Uncommitted changes/);
  unmount();
});

// Tab belongs to a text answer being typed, and to "Quit now?" while it is showing.
test("run view: Tab does not switch tabs while a text answer is being typed or 'Quit now?' is showing", async () => {
  const s = new WizardStore(); s.start(); s.step("check", "active"); s.task("check", "active");
  const { lastFrame, stdin, unmount } = render(createElement(App, { store: s }));
  const url = s.text("Local URL", "http://localhost:3000");
  await answerable(lastFrame, /Local URL/);
  stdin.write("\t"); stdin.write("x");
  await until(() => /  x▌/.test(lastFrame()), "the typed x");
  assert.match(lastFrame(), /\[Status\]/, "Tab during a text answer did not switch tabs");
  stdin.write("\r"); assert.equal(await url, "x");
  s.requestQuit(); await until(() => /Quit now\?/.test(lastFrame()), "the quit question");
  stdin.write("\t"); stdin.write("n");
  await until(() => !/Quit now\?/.test(lastFrame()), "the quit question dismissed");
  assert.match(lastFrame(), /\[Status\]/, "Tab during 'Quit now?' did not switch tabs");
  unmount();
});

test("sign-in shows the link and a waiting line", () => {
  const s = new WizardStore(); s.step("signin", "active");
  s.info("Approve access in your browser. If it did not open, open this link on this computer:\nhttp://127.0.0.1:53682/x");
  const { lastFrame, unmount } = render(createElement(Signin, { state: s.getSnapshot() }));
  assert.match(lastFrame(), /Approve access in your browser/);
  assert.match(lastFrame(), /http:\/\/127\.0\.0\.1:53682\/x/);
  assert.match(lastFrame(), /Waiting for your approval/);
  unmount();
});

test("sign-in shows the latest link and the sign-in step's warnings, not earlier steps'", () => {
  const s = new WizardStore();
  s.step("detect", "active"); s.warn("Uncommitted changes:\n  app/page.tsx");
  s.step("signin", "active");
  s.info("Approve access in your browser. If it did not open, open this link on this computer:\nhttp://127.0.0.1:53682/old");
  s.info("Approve access in your browser. If it did not open, open this link on this computer:\nhttp://127.0.0.1:53683/new");
  s.warn("The browser did not open.");
  const { lastFrame, unmount } = render(createElement(Signin, { state: s.getSnapshot() }));
  assert.match(lastFrame(), /53683\/new/);
  assert.doesNotMatch(lastFrame(), /53682\/old/);
  assert.match(lastFrame(), /▲ The browser did not open\./);
  assert.doesNotMatch(lastFrame(), /Uncommitted changes/);
  unmount();
});

// After a stop the sign-in step is "skipped"; its link leads nowhere and nothing is waited for.
test("sign-in: once the step has ended (a stop, a failure), the link and the waiting line are gone", () => {
  const link = "Approve access in your browser. If it did not open, open this link on this computer:\nhttp://127.0.0.1:53682/x";
  const s = new WizardStore(); s.step("signin", "active"); s.info(link); s.stop();
  const a = render(createElement(Signin, { state: s.getSnapshot() }));
  assert.doesNotMatch(a.lastFrame(), /Approve access|53682|Waiting for your approval/);
  a.unmount();
  const f = new WizardStore(); f.step("signin", "active"); f.info(link); f.step("signin", "failed"); f.warn("Sign-in was not completed in time. Run the wizard again.");
  const b = render(createElement(Signin, { state: f.getSnapshot() }));
  assert.match(b.lastFrame(), /▲ Sign-in was not completed in time\. Run the wizard again\./);
  assert.doesNotMatch(b.lastFrame(), /53682|Waiting for your approval/);
  b.unmount();
});

test("host hand-off panel shows host, link, where to paste and docs", () => {
  const s = new WizardStore();
  s.handoff(netlify);
  s.task("host", "skipped");
  const { lastFrame, unmount } = render(createElement(Run, { state: s.getSnapshot(), width: 120, left: createElement(Text, null, "x") }));
  const f = lastFrame();
  const lines = f.split("\n").map(bare);
  assert.ok(lines.includes("Connect your host"), "the panel's title on a line of its own (the task line has a mark)");
  assert.match(f, /Set on Netlify:/);
  assert.ok(lines.includes("PARLOX_SECRET_KEY (from the dashboard key, shown once)"));
  assert.ok(lines.includes("PARLOX_VERIFY_TOKEN=vt"));
  assert.match(f, /Where to paste: Project configuration → Environment variables/);
  assert.match(f, /Create the secret key here \(shown once\):/);
  assert.ok(lines.includes(netlify.url), "the key link on a line of its own");
  assert.match(f, /newKey=Netlify/);
  assert.ok(lines.includes(netlify.docs), "the docs link on a line of its own");
  assert.match(f, /Links are printed again when you close the wizard\./);
  assert.match(f, /– Connect your host/, "the task list is still shown");
  unmount();
});

test("in the app: sign-in, review, install, host and check each get their screen", async () => {
  const s = new WizardStore(); s.start();
  const { lastFrame, unmount } = render(createElement(App, { store: s }));
  s.step("detect", "active"); s.fact("Found", "Next.js 16 · App Router · TypeScript · npm");
  await until(() => /Checking your project/.test(lastFrame()), "the detect step");
  s.step("detect", "done"); s.step("signin", "active");
  s.info("Approve access in your browser. If it did not open, open this link on this computer:\nhttp://127.0.0.1:53682/x");
  await until(() => /Waiting for your approval/.test(lastFrame()), "the sign-in screen");
  s.step("signin", "done"); s.step("site", "active");
  await until(() => /Choosing the site/.test(lastFrame()), "the site step");
  assert.doesNotMatch(lastFrame(), /Approve access/, "the sign-in instruction is gone once signed in");
  s.step("site", "done"); s.step("review", "active"); s.changes(plan, "shop", "install");
  await until(() => /Changes in shop: 2 files/.test(lastFrame()), "the review screen");
  s.step("review", "done"); s.step("install", "active"); s.task("install", "active", "Installing");
  await until(() => /\[Status\]/.test(lastFrame()), "the run view");
  assert.match(lastFrame(), /✔ Reviewing changes/, "the steps overview on the left");
  assert.match(lastFrame(), /◐ Installing packages/);
  s.step("install", "done"); s.step("host", "active"); s.handoff(netlify);
  await until(() => /Set on Netlify:/.test(lastFrame()), "the hand-off");
  s.task("host", "skipped"); s.step("host", "skipped"); s.step("check", "active"); s.task("check", "active");
  await until(() => /◐ Check locally/.test(lastFrame()), "the check step");
  assert.match(lastFrame(), /– Connect your host/);
  assert.match(lastFrame(), /Set on Netlify:/, "the hand-off stays on screen until the end");
  unmount();
});

// The screens draw only the store's scrubbed state, so no key reaches a frame on any screen or tab.
test("the secret never appears in a frame of the review, the run view's three tabs, the hand-off panel or the sign-in screen", async () => {
  const s = new WizardStore();
  s.changes({
    changes: [{ path: ".env.local", before: `PARLOX_VERIFY_TOKEN=vt\nPARLOX_SECRET_KEY=${SECRET}\nOLD=${OLD_SECRET}\n`, after: "PARLOX_VERIFY_TOKEN=vt\n" }, { path: `x-${SECRET}.ts`, before: "a\n", after: "b\n" }],
    install: { command: "npm", args: ["uninstall", SECRET] }, manual: [{ file: `m-${SECRET}`, reason: `r ${SECRET}`, snippet: SECRET }], warnings: [`w ${SECRET}`],
  }, `shop-${SECRET}`, "uninstall");
  s.step("review", "active"); s.warn(`review ${SECRET}`);
  const rv = render(review(s));
  await ready(rv.stdin);
  rv.stdin.write("d"); await until(() => /d or Esc back/.test(rv.lastFrame()), "the .env.local diff");
  // An env file's diff shows Parlox's own line only, and a count of the others (the key's line among them).
  assert.match(rv.lastFrame(), /^-\[your line 1, not shown\]$/m);
  assert.doesNotMatch(rv.lastFrame(), /PARLOX_SECRET_KEY/);
  rv.stdin.write("d"); rv.stdin.write(DOWN); rv.stdin.write("d");
  await until(() => /^x-\[hidden\]\.ts\n.*d or Esc back/m.test(rv.lastFrame()), "the second file's diff");
  const reviewFrames = rv.frames;
  rv.unmount();

  s.step("install", "active"); s.task("install", "failed", `detail ${SECRET}`); s.log(`npm echo ${SECRET}`); s.log(OLD_SECRET); s.warn(`run ${SECRET}`);
  // The Status tab before the hand-off: the task box draws the task's detail.
  const before = render(createElement(Run, { state: s.getSnapshot(), width: 120, left: createElement(Text, null, "x") }));
  assert.match(before.lastFrame(), /✖ Remove packages: detail \[hidden\]/);
  assert.match(before.lastFrame(), /▲ run \[hidden\]/);
  const statusFrames = before.frames;
  before.unmount();
  s.handoff({ host: `h ${SECRET}`, url: `https://app.parlox.io/?k=${SECRET}`, where: `w ${SECRET}`, docs: `https://docs.example/${SECRET}`, variables: [`PARLOX_SECRET_KEY=${SECRET}`, `OLD=${OLD_SECRET}`] });
  const run = render(createElement(Run, { state: s.getSnapshot(), width: 120, left: createElement(Text, null, "x") }));
  await ready(run.stdin);
  run.stdin.write("\t"); await until(() => /\[Changes\]/.test(run.lastFrame()), "the Changes tab");
  run.stdin.write("\t"); await until(() => /\[Logs\]/.test(run.lastFrame()), "the Logs tab");
  assert.match(run.lastFrame(), /npm echo \[hidden\]/);
  const runFrames = run.frames;
  run.unmount();

  // The panel also draws a hand-off that did not come through the store without the key: its lines are scrubbed.
  const raw = { host: `h ${SECRET}`, url: `https://app.parlox.io/?k=${SECRET}`, where: `w ${SECRET}`, docs: `https://docs.example/${OLD_SECRET}`, variables: [`PARLOX_SECRET_KEY=${SECRET}`] };
  const panels = [render(createElement(HostPanel, { handoff: s.getSnapshot().handoff })), render(createElement(HostPanel, { handoff: raw }))];
  const panelFrames = panels.flatMap((p) => p.frames);
  for (const p of panels) p.unmount();

  // The sign-in screen, with a key in its link and in a warning.
  const si = new WizardStore(); si.step("signin", "active");
  si.info(`Approve access in your browser. If it did not open, open this link on this computer:\nhttp://127.0.0.1:53682/?k=${SECRET}`);
  si.warn(`signin ${OLD_SECRET}`);
  const sg = render(createElement(Signin, { state: si.getSnapshot() }));
  assert.match(sg.lastFrame(), /53682\/\?k=\[hidden\]/);
  assert.match(sg.lastFrame(), /▲ signin \[hidden\]/);
  const signinFrames = sg.frames;
  sg.unmount();

  const all = [...reviewFrames, ...statusFrames, ...runFrames, ...panelFrames, ...signinFrames];
  assert.ok(all.length > 6);
  for (const key of [SECRET, OLD_SECRET]) assert.equal(all.some((f) => f.includes(key)), false, "no key in any frame");
  for (const frames of [reviewFrames, statusFrames, runFrames, panelFrames, signinFrames]) assert.ok(frames.some((f) => f.includes("[hidden]")), "the scrubbed text was drawn");
});

/** The app drawn in a window of `columns` × `rows`, once it has been laid out for that size (its header row spans
 * the window, less the right margin). */
async function renderAt(store, columns, rows) {
  const r = render(createElement(App, { store }));
  Object.defineProperty(r.stdout, "columns", { value: columns, configurable: true });
  Object.defineProperty(r.stdout, "rows", { value: rows, configurable: true });
  r.stdout.emit("resize");
  await until(() => r.lastFrame()?.split("\n")[0].length === columns - 1, `the app laid out at ${columns} columns`);
  return r;
}
const vercel = { host: "Vercel", url: "https://app.parlox.io/sites/3f2b8c1e-9d4a-4b7e-8c21-5a6f0e9d7b13?newKey=Vercel%20%C2%B7%20production#keys", where: "your project → Settings → Environment Variables (then redeploy)", docs: "https://vercel.com/docs/environment-variables/managing-environment-variables", variables: ["PARLOX_SECRET_KEY (from the dashboard key, shown once)", "PARLOX_VERIFY_TOKEN=vt_0123456789abcdef"] };
const LOCAL_KEY_WARNING = 'A separate key "wizard · laptop" is in .env.local for local development. Visits to your local server will appear in the site\'s real data. Revoke this key in Settings → Keys when you are done.';
const VERCEL_WARNING = 'Could not read "margarita-shop"\'s Vercel environment variables; not creating a key, to avoid creating one that never gets stored. Set PARLOX_SECRET_KEY by hand from a key you create in the dashboard (Settings → Keys, shown once).';
/** A run that reached the local check with a Vercel hand-off, the given warnings on the way, and the check question. */
function atCheck(warnings) {
  const s = new WizardStore(); s.start();
  s.step("review", "active"); s.changes(plan, "margarita-shop", "install"); s.step("review", "done");
  s.step("install", "active"); s.task("install", "done", "Packages installed"); s.step("install", "done");
  s.step("host", "active"); s.task("host", "active");
  for (const w of warnings) s.warn(w);
  s.handoff(vercel); s.task("host", "skipped"); s.step("host", "skipped");
  s.step("check", "active"); s.task("check", "active");
  s.confirm("Check the server part now? Start your app (npm run dev) first.").catch(() => {});
  return s;
}

// Finding 1: the frame must stay shorter than the window (at the window's full height Ink clears and redraws the
// whole screen on every change, and anything taller scrolls the header, the tabs and the panel's top away).
test("run view: realistic hand-off frames fit 80 × 24 and 100 × 30, with the tabs and the panel on screen", async () => {
  for (const [columns, rows] of [[80, 24], [100, 30]]) {
    for (const warnings of [[], [VERCEL_WARNING], [LOCAL_KEY_WARNING, VERCEL_WARNING]]) {
      const s = atCheck(warnings);
      const { lastFrame, unmount } = await renderAt(s, columns, rows);
      await until(() => /Check the server part now\?/.test(lastFrame()) && /Set on Vercel:/.test(lastFrame()), "the check step");
      await until(() => lastFrame().split("\n").length < rows, `${columns}×${rows} with ${warnings.length} warnings: a frame shorter than the window (last: ${lastFrame().split("\n").length} rows)`);
      const f = lastFrame();
      const label = `${columns}×${rows}, ${warnings.length} warnings`;
      assert.match(f, /P A R L O X/, label);
      assert.match(f, /\[Status\]/, label);
      assert.match(f, /╭─+╮\n │ Connect your host/, `${label}: the panel's top`);
      assert.match(f, /Links are printed again when you close the wizard\./, label);
      assert.ok(f.split("\n").every((l) => l.length <= columns), `${label}: no row wider than the window`);
      const shown = warnings.filter((w) => f.replace(/\s+/g, " ").includes(w.slice(0, 40))).length;
      const hidden = warnings.length - shown;
      if (hidden) assert.match(f, new RegExp(`${hidden} more warnings? (is|are) printed when you close the wizard\\.`), label);
      else assert.doesNotMatch(f, /more warnings? (is|are) printed/, label);
      if (columns === 100) assert.equal(hidden, 0, `${label}: at 100 × 30 both warnings fit`);
      unmount();
    }
  }
});

test("run view: stacked, with two warnings and a question, the frame fits 80 × 24; the steps overview gives way", async () => {
  const s = new WizardStore(); s.start();
  s.step("review", "active"); s.changes(plan, "margarita-shop", "install"); s.step("review", "done");
  s.step("install", "active"); s.task("install", "done", "Packages installed"); s.step("install", "done");
  s.step("host", "active"); s.task("host", "active");
  s.warn(LOCAL_KEY_WARNING); s.warn(VERCEL_WARNING);
  s.confirm('Set PARLOX_SECRET_KEY and PARLOX_VERIFY_TOKEN on the Vercel project "margarita-shop" (production)?').catch(() => {});
  const { lastFrame, unmount } = await renderAt(s, 80, 24);
  await until(() => /Set PARLOX_SECRET_KEY and PARLOX_VERIFY_TOKEN/.test(lastFrame()) && lastFrame().split("\n").length < 24, "a frame shorter than the window");
  assert.match(lastFrame(), /\[Status\]/);
  assert.match(lastFrame(), /│ Tasks/);
  assert.match(lastFrame(), /Could not read "margarita-shop"'s Vercel/, "the newest warning is shown");
  assert.doesNotMatch(lastFrame(), /Checking your project/, "the steps overview gave way to the warnings");
  assert.ok(lastFrame().split("\n").findIndex((l) => l.includes("│ Tasks")) > lastFrame().split("\n").findIndex((l) => l.includes("[Status]")) + 1, "stacked at 80 columns");
  unmount();
});

// The left pane is a function of the rows it may use, so the slides can be left out when they do not fit.
test("run view: the left pane is given the rows it may use", () => {
  const s = new WizardStore(); s.step("install", "active"); s.task("install", "active", "Installing");
  const left = (rows) => createElement(Text, null, `LEFT ${rows}`);
  const draw = (width, rows) => { const r = render(createElement(Run, { state: s.getSnapshot(), width, rows, left })); const f = r.lastFrame(); r.unmount(); return f; };
  // 40 rows: the app's header (2), a spare row, a question (3) and the tab bar (2) leave 32; side by side, all of them.
  assert.match(draw(120, 40), /LEFT 32/);
  // 24 rows leave 16; stacked, the task box (6 rows) is below the left pane.
  assert.match(draw(90, 24), /LEFT 10/);
  s.warn("A warning.");
  // One warning: a blank row and the warning's row.
  assert.match(draw(90, 24), /LEFT 8/);
  assert.match(draw(90, 24), /▲ A warning\./);
  // Without a size (a test, a caller that does not know it), nothing is held back.
  assert.match(draw(120, undefined), /LEFT Infinity/);
});

// Finding 2: after q, the next keys belong to "Quit now?" even when they arrive in the same read, before it is drawn.
test("in the app: keys that arrive with q go to 'Quit now?', not to the screen behind it", async () => {
  {
    const s = new WizardStore(); s.start(); s.step("review", "active"); s.changes(plan, "shop", "install");
    const { lastFrame, stdin, unmount } = render(createElement(App, { store: s }));
    await until(() => /Changes in shop/.test(lastFrame()), "the review"); await ready(stdin);
    stdin.write("q"); stdin.write("d"); stdin.write(DOWN);
    await until(() => /Quit now\?/.test(lastFrame()), "the quit question");
    assert.doesNotMatch(lastFrame(), /rows \d+–\d+ of/, "d did not open a diff");
    assert.match(lastFrame(), /› ~ app\/layout\.tsx/, "↓ did not move the cursor");
    unmount();
  }
  {
    const s = new WizardStore(); s.start(); s.step("install", "active"); s.task("install", "active", "Installing");
    const { lastFrame, stdin, unmount } = render(createElement(App, { store: s }));
    await until(() => /\[Status\]/.test(lastFrame()), "the run view"); await ready(stdin);
    stdin.write("q"); stdin.write("\t");
    await until(() => /Quit now\?/.test(lastFrame()), "the quit question");
    assert.match(lastFrame(), /\[Status\]/, "Tab did not switch tabs");
    unmount();
  }
  {
    let quits = 0;
    const s = new WizardStore(); s.start(); s.step("install", "active");
    const { stdin, unmount } = render(createElement(App, { store: s, onQuit: () => { quits++; } }));
    await ready(stdin);
    stdin.write("q"); stdin.write("y");
    await until(() => quits === 1, "q then y, typed together, to quit");
    unmount();
  }
});

// Finding 5 (Trojan Source): a bidirectional override or a zero-width character makes text display differently from
// what is written. Every line the full screen draws writes them out, the diff and every message and path included.
test("invisible format characters are written out in the diff, the file list, messages and the hand-off", async () => {
  const s = new WizardStore(); s.step("review", "active");
  s.changes({ changes: [{ path: "src/a‮b.ts", before: null, after: "const admin = false;‮⁦ // ok⁩\nx​y\n" }], install: null, manual: [], warnings: ["w​x"] }, "shop", "install");
  s.warn("a‮b"); s.handoff({ host: "Net​lify", url: null, where: "here‮", docs: null, variables: ["PARLOX_VERIFY_TOKEN=vt​"] });
  const rv = render(review(s));
  await ready(rv.stdin);
  rv.stdin.write("d"); await until(() => /rows \d+–\d+ of/.test(rv.lastFrame()), "the diff");
  const run = render(createElement(Run, { state: s.getSnapshot(), width: 120, left: createElement(Text, null, "x") }));
  const frames = [...rv.frames, ...run.frames];
  rv.unmount(); run.unmount();
  const all = frames.join("\n");
  for (const raw of ["‮", "⁦", "⁩", "​"]) assert.equal(all.includes(raw), false, JSON.stringify(raw));
  assert.match(all, /src\/a<U\+202E>b\.ts/);
  assert.match(all, /\+const admin = false;<U\+202E><U\+2066> \/\/ ok<U\+2069>/);
  assert.match(all, /\+x<U\+200B>y/);
  assert.match(all, /▲ w<U\+200B>x/);
  assert.match(all, /▲ a<U\+202E>b/);
  assert.match(all, /Set on Net<U\+200B>lify:/);
  assert.match(all, /Where to paste: here<U\+202E>/);
});

// The done card is drawn before anything is printed, so it never points "above"; where it refers to what
// is printed (the code to add by hand, this report, the hand-off), it says that is printed when the wizard closes.
test("the done card never says 'above'; it says what is printed when you close the wizard", async () => {
  const lines = ["Server part: add it by hand (above).", "Browser part: added to your code; confirmed after you deploy, when the first visit from shop.example.com arrives."];
  for (const withHandoff of [true, false]) {
    const s = new WizardStore(); s.start();
    if (withHandoff) s.handoff(netlify);
    s.report(lines, "Parlox is installed"); s.step("done", "done");
    const { lastFrame, unmount } = render(createElement(App, { store: s }));
    await until(() => /Parlox is installed/.test(lastFrame()), "the done card");
    const f = lastFrame().replace(/\s*│\s*/g, " ");
    assert.doesNotMatch(f, /above/);
    assert.match(f, /Server part: add it by hand \(the code is printed when you close the wizard\)\./);
    assert.match(f, withHandoff ? /This report and what to set on your host are printed when you close the wizard\./ : /This report is printed when you close the wizard\./);
    unmount();
  }
});

// The sign-in link carries a 22-character token; it must still sit whole on one row at 80 columns, so it can
// be copied.
test("sign-in: the link with its token fits on one row at 80 columns", async () => {
  const link = "http://127.0.0.1:53685/?t=" + "Ab0_-".repeat(4) + "Zz";
  const s = new WizardStore(); s.start(); s.step("signin", "active");
  s.info(`Approve access in your browser. If it did not open, open this link on this computer:\n${link}`);
  const { lastFrame, unmount } = await renderAt(s, 80, 24);
  await until(() => /Waiting for your approval/.test(lastFrame()), "the sign-in screen");
  assert.ok(lastFrame().split("\n").some((l) => l.trim() === link), "the link alone and whole on its row");
  unmount();
});

// The step screens (detect, site) drew every message whole, with no height budget: a 60-file
// "Uncommitted changes" warning pushed the question off an 80 × 24 window. They now get the rows left, the newest
// first, and one row counts the lines left out, which are printed when the wizard closes.
test("a step screen keeps to the window: a 60-line warning and a question fit 80 × 24; the summary prints it all", async () => {
  const { summary } = await import("../dist/start.js");
  const files = Array.from({ length: 60 }, (_, i) => `  src/components/file-${i}.tsx`);
  const s = new WizardStore(); s.start();
  s.step("detect", "active"); s.fact("Found", "Next.js 16 · App Router · TypeScript · npm");
  s.warn(`Uncommitted changes:\n${files.join("\n")}\nCommit or stash them first, so the wizard's changes are easy to review.`);
  s.confirm("Continue anyway?").catch(() => {});
  const { lastFrame, unmount } = await renderAt(s, 80, 24);
  await until(() => /Continue anyway\?/.test(lastFrame()) && lastFrame().split("\n").length < 24, `a frame shorter than the window (last: ${lastFrame().split("\n").length} rows)`);
  const f = lastFrame();
  assert.match(f, /Checking your project/);
  assert.match(f, /Next\.js 16 · App Router/);
  assert.match(f, /▲ Uncommitted changes:/, "the warning starts on screen");
  assert.match(f, /\d+ more lines are printed when you close the wizard\./);
  const shown = files.filter((l) => f.split("\n").some((row) => row.trim() === l.trim())).length;
  const hidden = Number(f.match(/(\d+) more lines are printed/)[1]);
  assert.equal(shown + hidden, files.length + 1, "every line is either shown or counted (the files and the closing sentence)");
  assert.ok(f.split("\n").every((l) => l.length <= 80));
  unmount();
  const printed = summary(s.getSnapshot(), 1);
  for (const l of files) assert.ok(printed.includes(l), l);
  assert.ok(printed.includes("Commit or stash them first"));
});
