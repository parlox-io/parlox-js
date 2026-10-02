import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export function fixture(files) {
  const dir = mkdtempSync(join(tmpdir(), "parlox-wizard-"));
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  return dir;
}
export const read = (dir, rel) => (existsSync(join(dir, rel)) ? readFileSync(join(dir, rel), "utf8") : null);
export const append = (dir, rel, text) => appendFileSync(join(dir, rel), text);
export const pkg = (deps = { next: "16.0.1", react: "19.0.0" }, extra = {}) => JSON.stringify({ name: "shop", dependencies: deps, ...extra });

/**
 * True if every line of `original` (split on \r\n or \n) still appears, unchanged and in the same
 * relative order, somewhere in `updated` — i.e. `original`'s lines are a subsequence of `updated`'s.
 * Used to confirm an edit only *added* lines rather than reformatting ones it did not touch.
 */
export function linesPreserved(original, updated) {
  const origLines = original.split(/\r\n|\n/);
  const newLines = updated.split(/\r\n|\n/);
  let i = 0;
  for (const line of newLines) {
    if (i < origLines.length && line === origLines[i]) i++;
  }
  return i === origLines.length;
}

// Waiting in the screen tests: on what is drawn or stored, never on a fixed time, so a slow machine (a CI runner, a
// busy laptop) only makes a test slower, not red.

/** Waits until `check()` holds, looking every 5 ms, for at most `ms` (10 s): past that the test fails, never hangs. */
export async function until(check, what, ms = 10_000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** React runs a screen's effects, where Ink attaches its key handlers, in a task queued when the frame is drawn: two
 * turns of the event loop let the screen just drawn start listening, and let keys already sent be handled. A count of
 * turns, not a time. */
export const effects = () => new Promise((r) => setImmediate(() => setImmediate(r)));

/** Waits until the last frame matches `re`, then for that screen's effects: a key sent after this reaches it. */
export async function drawn(lastFrame, re, what = String(re)) {
  await until(() => re.test(lastFrame() ?? ""), what);
  await effects();
}

/** Resolves once the app listens for keys at all: a key typed before that goes nowhere, as in a real terminal. */
export const ready = (stdin) => until(() => stdin.listenerCount("readable") > 0, "the screen to take keys");

/** A promise's outcome, readable at any time, so a test can wait for it with until() and fail, not hang, on a lost key. */
export function outcome(p) {
  const o = { done: false, value: undefined, error: undefined };
  p.then((v) => { o.done = true; o.value = v; }, (e) => { o.done = true; o.error = e; });
  return o;
}

export const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** A question ignores keys for `guardMs` after it starts taking them (Prompt.tsx). Once it is drawn and its effects
 * have run, the guard's clock has started; waiting it out from then, with a margin, cannot be too short on a slow
 * machine (a late timer only waits longer). */
export async function answerable(lastFrame, re, guardMs) {
  await drawn(lastFrame, re);
  await wait(guardMs + 100);
}
