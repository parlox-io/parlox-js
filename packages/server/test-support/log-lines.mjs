// What @parlox/server writes to console.warn, for test files that provoke it on purpose (an empty secretKey, a key the
// stand-in gateway refuses): each line is recorded instead of printed, with the instance that said it, and the file's
// last test (checkLogLines) asserts that every line is one the SDK means to write, said at most once by its instance.
// A misconfigured key must cost one line in the merchant's log, never a line per request. A test, not an after hook:
// a hook that fails stops the file's later hooks, which close its stand-in gateway. (Outside test/, so that
// `node --test` does not run this file on its own.)
import { mock } from "node:test";
import assert from "node:assert/strict";

const SAID_ONCE = String.raw` \(said once per instance; onError receives every refusal\)$`;
/** The lines the SDK writes (core.ts: say): an empty secretKey, and a key Parlox refused, for an order, a UCP report or
 * a crawler report. */
const KINDS = [
  ["an empty secretKey", /^@parlox\/server: secretKey was given but is empty: set PARLOX_ORDERS_KEY \(or the variable you pass\) — Parlox did not fall back to PARLOX_SECRET_KEY$/],
  ["a refused order", new RegExp(String.raw`^@parlox\/server: Parlox refused the order \(HTTP 40[13]\)(?:: [^\n]+)?${SAID_ONCE}`)],
  ["a refused UCP report", new RegExp(String.raw`^@parlox\/server: Parlox refused the UCP report \(HTTP 40[13]\)(?:: [^\n]+)?${SAID_ONCE}`)],
  ["a refused report", new RegExp(String.raw`^@parlox\/server: Parlox refused a crawler report \(HTTP 40[13]\)(?:: [^\n]+)?${SAID_ONCE}`)],
];

const lines = [];
// The instance whose own code is running: while it is being created (an empty secretKey is said then), and in the turn
// in which its onError is called (the SDK says a refusal right after it tells onError of it).
let speaking = null;
mock.method(console, "warn", (...args) => { lines.push({ text: args.map(String).join(" "), instance: speaking }); });

let made = 0;
/**
 * `factory` (createParlox or an adapter's) with each instance it makes told apart: its options (argument
 * `optionsAt`) get an onError that marks the instance as speaking, then calls the test's own onError, if any, as
 * before. Properties of the factory (an adapter's flush) are kept.
 */
export function tracked(factory, optionsAt = 0) {
  const wrapped = (...args) => {
    const id = ++made;
    const given = args[optionsAt] ?? {};
    const own = given.onError;
    args[optionsAt] = {
      ...given,
      onError: (error) => {
        speaking = id;
        queueMicrotask(() => { if (speaking === id) speaking = null; });
        return own?.(error);
      },
    };
    const before = speaking;
    speaking = id;
    try { return factory(...args); } finally { speaking = before; }
  };
  return Object.assign(wrapped, factory);
}

/** Asserts that every line recorded so far is one the SDK means to write (KINDS), said by a tracked instance, and at
 * most once by that instance for each kind. The number of lines checked, for the test's own use. */
export function checkLogLines() {
  const said = new Map();
  for (const { text, instance } of lines) {
    const kind = KINDS.find(([, shape]) => shape.test(text))?.[0];
    assert.ok(kind, `a line the SDK is not meant to write: ${text}`);
    assert.notEqual(instance, null, `a line no tracked instance said: ${text}`);
    const key = `${instance}: ${kind}`;
    said.set(key, (said.get(key) ?? 0) + 1);
    assert.equal(said.get(key), 1, `instance ${instance} said ${kind} more than once: ${text}`);
  }
  return lines.length;
}
