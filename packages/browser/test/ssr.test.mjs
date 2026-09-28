// Server-side rendering: importing and calling the package where there is no window must be a harmless no-op.
import { test } from "node:test";
import assert from "node:assert/strict";
import { init, track, consent, sessionId } from "../dist/esm/index.js";

test("init, track, consent and sessionId are no-ops without a browser", () => {
  assert.equal(typeof window, "undefined");
  assert.equal(init({ publicKey: "pk_0123456789abcdef01234567" }), null);
  assert.doesNotThrow(() => track("add_to_cart", { value: 1 }));
  assert.doesNotThrow(() => consent(true));
  assert.equal(sessionId(), null);
});

test("the React entry imports on the server without touching the DOM", async () => {
  const mod = await import("../dist/esm/react.js");
  assert.equal(typeof mod.ParloxAnalytics, "function");
});
