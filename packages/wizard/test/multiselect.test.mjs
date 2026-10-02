import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import { createElement } from "react";
import { render } from "ink-testing-library";
import { App } from "../dist/tui/App.js";
import { WizardStore } from "../dist/tui/store.js";
import { INPUT_DELAY_MS } from "../dist/tui/Prompt.js";
import { plainUi } from "../dist/ui/plain.js";
import { withDefaults, NoTerminalError } from "../dist/ui/types.js";
import { answerable as pastGuard, drawn, effects, outcome, until } from "./helpers.mjs";
import { describeUnit } from "../dist/apps.js";

const answerable = (lastFrame, re) => pastGuard(lastFrame, re, INPUT_DELAY_MS);
const DOWN = "\u001B[B";
const SECRET = "sk_parlox_" + "c".repeat(64);
const OPTIONS = [{ value: "web", label: "web/ · Vite React · browser part" }, { value: "api", label: "api/ · Express · server part" }];

test("full screen: every app starts selected; space changes one; Enter answers the selected, in order", async () => {
  const s = new WizardStore(); s.start(); s.step("detect", "active");
  const { lastFrame, stdin, unmount } = render(createElement(App, { store: s }));
  const answer = s.multiselect("Which apps should Parlox be installed in?", OPTIONS);
  const o = outcome(answer);
  await answerable(lastFrame, /Which apps should Parlox be installed in\?/);
  assert.match(lastFrame(), /◼ web\/ · Vite React · browser part/);
  assert.match(lastFrame(), /◼ api\/ · Express · server part/);
  stdin.write(DOWN); await drawn(lastFrame, /› ◼ api\//);
  stdin.write(" "); await drawn(lastFrame, /› ◻ api\//);
  stdin.write("\r"); await until(() => o.done, "the answer");
  assert.deepEqual(await answer, ["web"]);
  unmount();
});

test("full screen: with nothing selected, Enter does not answer", async () => {
  const s = new WizardStore(); s.start(); s.step("detect", "active");
  const { lastFrame, stdin, unmount } = render(createElement(App, { store: s }));
  const answer = s.multiselect("Which apps?", OPTIONS.slice(0, 1));
  const o = outcome(answer);
  await answerable(lastFrame, /Which apps\?/);
  stdin.write(" "); await drawn(lastFrame, /select at least one/);
  // Waits on the key being handled (two turns of the event loop, as for any key), not on a fixed time.
  stdin.write("\r"); await effects();
  assert.equal(o.done, false);
  stdin.write(" "); await drawn(lastFrame, /◼ web\//);
  stdin.write("\r"); await until(() => o.done, "the answer");
  assert.deepEqual(await answer, ["web"]);
  unmount();
});

test("the store scrubs the labels and keeps the values", async () => {
  const s = new WizardStore();
  const p = s.multiselect(`pick ${SECRET}`, [{ value: { rel: "web" }, label: `web ${SECRET}` }]);
  assert.equal(s.getSnapshot().prompt.kind, "multiselect");
  assert.equal(s.getSnapshot().prompt.options[0].label, "web [hidden]");
  s.answer([{ rel: "web" }], s.getSnapshot().prompt.id);
  assert.deepEqual(await p, [{ rel: "web" }]);
});

// The plain face's question itself (clack's multiselect), answered through a stream standing in for a terminal.
test("plain face in a terminal: every option starts selected; Enter with none selected is refused, then answers", async () => {
  const input = new PassThrough(); input.isTTY = true; input.setRawMode = () => input;
  let screen = "";
  const out = new Writable({ write(chunk, _e, cb) { screen += chunk.toString(); cb(); } }); out.isTTY = true; out.columns = 100; out.rows = 30;
  const ui = plainUi(out, undefined, input);
  const all = ui.multiselect("Which apps?", OPTIONS);
  const first = outcome(all);
  await until(() => screen.includes("Which apps?"), "the question");
  input.write("\r");
  await until(() => first.done, "the first answer");
  assert.deepEqual(await all, ["web", "api"]);
  screen = "";
  const some = ui.multiselect(`Which apps now? ${SECRET}`, [{ value: "web", label: `web/ ${SECRET}` }, ...OPTIONS.slice(1)]);
  const o = outcome(some);
  await until(() => screen.includes("Which apps now?"), "the second question");
  assert.doesNotMatch(screen, /sk_parlox_/);
  input.write(` ${DOWN} \r`);
  await until(() => /at least one/i.test(screen), "the refusal");
  assert.equal(o.done, false);
  input.write(" \r");
  await until(() => o.done, "the answer");
  assert.deepEqual(await some, ["api"]);
});

// A folder name is the developer's, and can hold an escape sequence (here one that would retitle the terminal window).
test("plain face: a folder name's control characters are written out in both pickers, never sent to the terminal", async () => {
  const d = { integration: "nextjs", parts: { browser: { file: "app/layout.tsx", kind: "layout" }, server: { file: "proxy.ts", kind: "middleware" } } };
  const label = describeUnit({ rel: "web\u001B]0;owned\u0007", detections: [d], browser: d, server: d, warnings: [] });
  const input = new PassThrough(); input.isTTY = true; input.setRawMode = () => input;
  let screen = "";
  const out = new Writable({ write(chunk, _e, cb) { screen += chunk.toString(); cb(); } }); out.isTTY = true; out.columns = 100; out.rows = 30;
  const ui = plainUi(out, undefined, input);
  for (const ask of [() => ui.select("Which app?", [{ value: "web", label }]), () => ui.multiselect("Which apps?", [{ value: "web", label }])]) {
    screen = "";
    const o = outcome(ask());
    await until(() => screen.includes("web^[]0;owned^G/ · Next.js"), "the written-out folder name");
    assert.equal(screen.includes("\u001B]0;owned"), false);
    input.write("\r");
    await until(() => o.done, "the answer");
    assert.equal(o.error, undefined);
  }
});

test("plain face without a terminal: refused at once with the hint; a UI without multiselect refuses the same way", async () => {
  const out = { isTTY: false, write: () => true };
  await assert.rejects(plainUi(out, undefined, { isTTY: false }).multiselect("Which apps should Parlox be installed in?", OPTIONS, "Pass --app <folder>."),
    (e) => e instanceof NoTerminalError && e.message === "No terminal to answer: Which apps should Parlox be installed in? Pass --app <folder>.");
  const basic = withDefaults({ info() {}, warn() {}, confirm: async () => true, select: async (_m, o) => o[0].value, text: async () => "" });
  await assert.rejects(basic.multiselect("Which apps?", OPTIONS, "Pass --app <folder>."), (e) => e instanceof NoTerminalError);
});
