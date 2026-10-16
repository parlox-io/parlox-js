// The shared cuts (text.ts) on their own: a cut never leaves half of an emoji or an unpaired surrogate (a database that
// stores JSON refuses one), and a trim at the end of a string is one pass. Built from the source here, since it is not
// part of the package's API.
import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const out = await build({ entryPoints: [fileURLToPath(new URL("../src/text.ts", import.meta.url))], bundle: true, format: "esm", platform: "neutral", write: false, logLevel: "error" });
const { cut, trimEnd } = await import("data:text/javascript;base64," + Buffer.from(out.outputFiles[0].text).toString("base64"));

test("cut counts an emoji as one character and never splits it", () => {
  assert.equal(cut("abc", 5), "abc");
  assert.equal(cut("x".repeat(59) + "\u{1F600}\u{1F600}", 60), "x".repeat(59) + "\u{1F600}");
  assert.equal(cut("\u{1F600}".repeat(3), 2), "\u{1F600}\u{1F600}");
  assert.equal(cut("", 3), "");
});

test("cut replaces an unpaired surrogate already in the text", () => {
  assert.equal(cut("ab\uD800cd", 10), "ab\uFFFDcd");
  assert.equal(cut("ab\uDC00", 10), "ab\uFFFD");
  assert.equal(cut("\uD800", 1), "\uFFFD");
  const wellFormed = (s) => !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);
  for (const s of ["a\uD83D", "\uDE00b", "x".repeat(299) + "\u{1F600}"]) assert.ok(wellFormed(cut(s, 300)), JSON.stringify(s));
});

test("trimEnd removes a run at the end in one pass", () => {
  assert.equal(trimEnd("a,b,,,", 44), "a,b");
  assert.equal(trimEnd(",,,", 44), "");
  assert.equal(trimEnd("https://gateway.parlox.io//", 47), "https://gateway.parlox.io");
  const t = performance.now();
  assert.equal(trimEnd("a" + ",".repeat(200000) + "b" + ",".repeat(200000), 44), "a" + ",".repeat(200000) + "b");
  assert.ok(performance.now() - t < 200);
});
