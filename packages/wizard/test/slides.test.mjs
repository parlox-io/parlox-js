import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement, Profiler } from "react";
import { render } from "ink-testing-library";
import { Slides, SLIDES, SLIDES_HEIGHT } from "../dist/tui/Slides.js";
import { App } from "../dist/tui/App.js";
import { WizardStore } from "../dist/tui/store.js";
import { INPUT_DELAY_MS } from "../dist/tui/Prompt.js";
import { answerable, drawn, effects, ready, until, wait } from "./helpers.mjs";

// Every wait below is on what is drawn (helpers.mjs), not on a fixed time, except where only time can show that
// nothing more happens (a settled slide).
const RIGHT = "\u001B[C", LEFT = "\u001B[D";
const AGENTS = ["ChatGPT", "Claude", "Gemini", "Perplexity", "Copilot"];

test("four slides following the landing page's journey", () => {
  assert.deepEqual(SLIDES.map((s) => s.title), ["Observe · It finds you", "Diagnose · It gets stuck", "Fix · It gets a straight answer", "Attribute · It buys, and you know"]);
});

test("no slide body contains a figure, at any animation frame", () => {
  for (const s of SLIDES) for (let f = 0; f < 40; f++) {
    const body = s.render(f).join("\n");
    assert.doesNotMatch(body, /[0-9]/, `${s.title} frame ${f}`);
  }
});

// The wizard has read nothing from the merchant's store yet; the slide illustrates what the dashboard will
// show, not a claim about data it already has.
test("no slide claims live data", () => {
  for (const s of SLIDES) for (let f = 0; f < 40; f++) {
    const body = s.render(f).join("\n");
    assert.doesNotMatch(body, /right now/i, `${s.title} frame ${f}`);
    assert.doesNotMatch(body, /your store/i, `${s.title} frame ${f}`);
  }
});

test("slides name agents and pages without comparing volumes", () => {
  const observe = SLIDES[0].render(20).join("\n");
  assert.match(observe, /ChatGPT/); assert.match(observe, /Claude/); assert.match(observe, /Gemini/); assert.match(observe, /Perplexity/);
  assert.doesNotMatch(observe, /█/, "no bars");
  assert.match(SLIDES[1].render(10).join("\n"), /stuck here/);
  assert.match(SLIDES[2].render(10).join("\n"), /arrives by/);
  assert.match(SLIDES[3].render(10).join("\n"), /confirmed by your server/);
});

// Five distinct agents, each once, each with a different page; no frame ever repeats one (which would
// suggest it visits more than another — only a measured rate is ever shown as a number, and only in the dashboard).
test("the Observe slide names five distinct agents, each appearing at most once per frame", () => {
  assert.equal(new Set(AGENTS).size, 5);
  for (let f = 0; f < 40; f++) {
    const body = SLIDES[0].render(f).join("\n");
    for (const agent of AGENTS) {
      const count = body.split(agent).length - 1;
      assert.ok(count <= 1, `${agent} appears ${count} times at frame ${f}`);
    }
  }
});

test("the slide frame is marked illustration; arrows flip; the dots follow", async () => {
  const { lastFrame, stdin, unmount } = render(createElement(Slides, { intervalMs: 60_000, animationMs: 60_000 }));
  assert.match(lastFrame(), /illustration/);
  assert.match(lastFrame(), /Observe · It finds you/);
  assert.match(lastFrame(), /● ○ ○ ○/);
  await ready(stdin);
  stdin.write(RIGHT); await drawn(lastFrame, /Diagnose · It gets stuck/);
  assert.match(lastFrame(), /Diagnose · It gets stuck/);
  assert.match(lastFrame(), /○ ● ○ ○/);
  stdin.write(LEFT); await drawn(lastFrame, /Observe · It finds you/); stdin.write(LEFT); await drawn(lastFrame, /Attribute · It buys/);
  assert.match(lastFrame(), /Attribute · It buys, and you know/);
  unmount();
});

test("inactive slides ignore the arrow keys", async () => {
  const { lastFrame, stdin, unmount } = render(createElement(Slides, { intervalMs: 60_000, animationMs: 60_000, active: false }));
  await effects();
  // Inactive, the slides listen for no key at all: nothing is waiting on the terminal.
  assert.equal(stdin.listenerCount("readable"), 0);
  stdin.write(RIGHT); await effects();
  assert.match(lastFrame(), /Observe · It finds you/);
  unmount();
});

test("slides advance on their own", async () => {
  const { lastFrame, unmount } = render(createElement(Slides, { intervalMs: 40, animationMs: 60_000 }));
  await until(() => !/Observe · It finds you/.test(lastFrame()), "the next slide, on its own");
  assert.doesNotMatch(lastFrame(), /Observe · It finds you/);
  unmount();
});

// The frame ticker stops itself once a slide has finished revealing (verified here, not just asserted in a
// comment), rather than redrawing a settled illustration for as long as the run takes.
test("the animation settles instead of ticking forever once a slide is fully revealed", async () => {
  const { lastFrame, unmount } = render(createElement(Slides, { intervalMs: 60_000, animationMs: 5 }));
  await until(() => AGENTS.every((a) => lastFrame().includes(a)), "the first slide fully revealed");
  const settled = lastFrame();
  // Only time can show that nothing more happens: thirty animation steps.
  await wait(150);
  assert.equal(lastFrame(), settled, "no further change once the slide has settled");
  unmount();
});

// Frames 0 and 1 draw the same picture, so a ticker that stops at the first repeated picture never
// moves. Each slide must reach its final picture, and only then stop redrawing (React's Profiler counts commits).
test("each slide animates to its final picture, then stops redrawing", async () => {
  const finals = [
    ["Observe · It finds you", (f) => AGENTS.every((a) => f.includes(a))],
    ["Diagnose · It gets stuck", (f) => f.includes("stuck here: the date picker needs a mouse")],
    ["Fix · It gets a straight answer", (f) => f.includes("arrives by    a date, not a picker")],
    ["Attribute · It buys, and you know", (f) => f.includes("confirmed by your server")],
  ];
  for (let i = 0; i < finals.length; i++) {
    const [title, reached] = finals[i];
    let commits = 0;
    const r = render(createElement(Profiler, { id: "slides", onRender: () => { commits++; } }, createElement(Slides, { intervalMs: 60_000, animationMs: 5 })));
    // Unmounted whatever happens: the slide timer would otherwise keep the test process alive.
    try {
      await ready(r.stdin);
      for (let k = 0; k < i; k++) { const before = r.lastFrame(); r.stdin.write("\u001B[C"); await until(() => r.lastFrame() !== before, "the next slide"); }
      await until(() => r.lastFrame().includes(title), title);
      await until(() => reached(r.lastFrame()), `${title}: its final picture`);
      const settled = commits;
      // Absence of redraws can only be shown over time: forty animation steps.
      await wait(200);
      assert.equal(commits, settled, `${title}: no redraw once the final picture is up`);
    } finally { r.unmount(); }
  }
});

// Guards SLIDES_HEIGHT against drift: every slide renders 8 lines or fewer (Slides.tsx's comment explains why), so
// the box is this fixed height for all four, not just the first.
test("the slides box is exactly SLIDES_HEIGHT rows tall, for every slide", async () => {
  const { lastFrame, stdin, unmount } = render(createElement(Slides, { intervalMs: 60_000, animationMs: 60_000 }));
  for (let i = 0; i < SLIDES.length; i++) {
    assert.equal(lastFrame().split("\n").length, SLIDES_HEIGHT, SLIDES[i].title);
    if (i < SLIDES.length - 1) { if (i === 0) await ready(stdin); stdin.write(RIGHT); await drawn(lastFrame, new RegExp(SLIDES[i + 1].title)); }
  }
  unmount();
});


/** The app drawn in a window of `columns` × `rows`, once it has been laid out for that size (as in screens.test.mjs). */
async function renderAt(store, columns, rows) {
  const r = render(createElement(App, { store }));
  Object.defineProperty(r.stdout, "columns", { value: columns, configurable: true });
  Object.defineProperty(r.stdout, "rows", { value: rows, configurable: true });
  r.stdout.emit("resize");
  await until(() => r.lastFrame()?.split("\n")[0].length === columns - 1, `the app laid out at ${columns} columns`);
  return r;
}
const runningStore = () => { const s = new WizardStore(); s.start(); s.step("install", "active"); s.task("install", "active", "Installing"); return s; };

// The left pane shows the slides only once the window gives their box the room it needs, the steps
// overview alone when it does not, and the combined frame never overflows the window at either size.
test("run view: the left pane shows the slides only when they fit; the frame never exceeds the window", async () => {
  {
    const r = await renderAt(runningStore(), 120, 40);
    // A resize's own re-render can land a frame drawn just before the width prop it depends on catches up (Ink's
    // canvas and React's state settle a tick apart): wait for a frame no taller than the window, as the existing
    // hand-off test does, rather than trust the first frame that happens to mention the run view.
    await until(() => r.lastFrame().split("\n").length <= 40, "a frame that fits 120×40");
    assert.match(r.lastFrame(), /Observe · It finds you/, "the slides fit");
    assert.match(r.lastFrame(), /Installing packages/, "the steps overview also fits, below the slides");
    r.unmount();
  }
  {
    const r = await renderAt(runningStore(), 80, 24);
    await until(() => r.lastFrame().split("\n").length <= 24, "a frame that fits 80×24");
    assert.doesNotMatch(r.lastFrame(), /Observe · It finds you/, "the slides do not fit at 80×24");
    assert.match(r.lastFrame(), /Installing packages/, "the steps overview alone");
    r.unmount();
  }
});

// A question (any kind) and "Quit now?" both take ← → for themselves; the slides must not also flip.
test("run view: the slides ignore arrow keys while a question or 'Quit now?' is on screen", async () => {
  const s = runningStore();
  const r = await renderAt(s, 120, 40);
  await until(() => /Observe · It finds you/.test(r.lastFrame()), "the slides");
  await ready(r.stdin);
  const apply = s.confirm("Apply these changes to shop?");
  await answerable(r.lastFrame, /Apply these changes to shop\?/, INPUT_DELAY_MS);
  // → reached the question: its answer moves to No.
  r.stdin.write(RIGHT); await drawn(r.lastFrame, /● No/);
  assert.match(r.lastFrame(), /Observe · It finds you/, "→ went to the question, not the slides");
  s.answer(false); await assert.doesNotReject(apply);
  await until(() => !/Apply these changes/.test(r.lastFrame()), "the question answered");
  s.requestQuit(); await drawn(r.lastFrame, /Quit now\?/);
  r.stdin.write(RIGHT); await effects();
  assert.match(r.lastFrame(), /Observe · It finds you/, "→ did not flip the slide while 'Quit now?' is showing");
  s.dismissQuit();
  r.unmount();
});

// The 40-row floor and an actual fit are both required, not either alone.
test("welcome: the slides show under it only from 40 rows, and only when the two together fit", async () => {
  {
    const r = await renderAt(new WizardStore(), 120, 40);
    await until(() => /Observe · It finds you/.test(r.lastFrame()), "the slides under the welcome screen");
    assert.ok(r.lastFrame().split("\n").length <= 40, `frame (${r.lastFrame().split("\n").length} rows) fits 120×40`);
    r.unmount();
  }
  {
    const r = await renderAt(new WizardStore(), 120, 30);
    await until(() => /Press Enter to start/.test(r.lastFrame()), "the welcome screen");
    assert.doesNotMatch(r.lastFrame(), /Observe · It finds you/, "no slides below 40 rows");
    r.unmount();
  }
  {
    // 35 rows: the welcome panel and the slides would fit together (32 rows), but the floor is 40 rows.
    const r = await renderAt(new WizardStore(), 120, 35);
    await until(() => /Press Enter to start/.test(r.lastFrame()), "the welcome screen");
    assert.doesNotMatch(r.lastFrame(), /Observe · It finds you/, "the 40-row floor applies even though the content would fit");
    r.unmount();
  }
});

// A host hand-off still takes the left pane's place entirely (Run.tsx).
test("run view: a host hand-off takes the slides' place", async () => {
  const s = runningStore();
  s.step("install", "done"); s.step("host", "active");
  s.handoff({ host: "Netlify", url: "https://app.parlox.io/sites/1?newKey=Netlify%20%C2%B7%20production#keys", where: "Project configuration → Environment variables", docs: "https://docs.netlify.com/", variables: ["PARLOX_SECRET_KEY (from the dashboard key, shown once)"] });
  const r = await renderAt(s, 120, 40);
  await until(() => /Set on Netlify:/.test(r.lastFrame()), "the hand-off panel");
  assert.doesNotMatch(r.lastFrame(), /Observe · It finds you/, "the slides gave way to the hand-off");
  r.unmount();
});
