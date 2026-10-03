import { test } from "node:test";
import assert from "node:assert/strict";
import { compareVersions, packagesToAdd, pinFor } from "../dist/pins.js";

const S = "@parlox/server";
const B = "@parlox/browser";
const newer = (name, spec, pinned) => `${name} ${spec} is already in package.json, newer than the version this wizard was tested with (${pinned}), so the wizard keeps it.`;
const atLeast = (name, spec, pinned) => `${name} ${spec} is already in package.json: the version this wizard was tested with (${pinned}) or newer, so the wizard keeps it.`;
const otherMajor = (name, spec, pinned) => `${name} ${spec} is already in package.json, a different major version from the one this wizard was tested with (${pinned}), so the wizard did not change it.`;
const cannotCompare = (name, spec, pinned) => `${name} is already in package.json as ${JSON.stringify(spec)}, which the wizard cannot compare with the version it was tested with (${pinned}), so the wizard did not change it.`;

test("compareVersions: x.y.z by number, a prerelease lower than its release, build metadata ignored", () => {
  assert.equal(compareVersions("1.2.0", "1.1.0"), 1);
  assert.equal(compareVersions("1.1.0", "1.2.0"), -1);
  assert.equal(compareVersions("1.2.3", "1.2.3"), 0);
  assert.equal(compareVersions("1.10.0", "1.9.0"), 1, "numbers, not text");
  assert.equal(compareVersions("1.2.10", "1.2.9"), 1);
  assert.equal(compareVersions("2.0.0", "1.99.99"), 1);
  assert.equal(compareVersions("1.2.0-beta.1", "1.2.0"), -1);
  assert.equal(compareVersions("1.2.0", "1.2.0-beta.1"), 1);
  assert.equal(compareVersions("1.3.0-beta.1", "1.2.0"), 1, "a prerelease of a later version is still later");
  assert.equal(compareVersions("1.2.0+build.5", "1.2.0"), 0);
  // semver.org, section 11: the order of prereleases.
  const order = ["1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta", "1.0.0-beta.2", "1.0.0-beta.11", "1.0.0-rc.1", "1.0.0"];
  for (let i = 0; i + 1 < order.length; i++) {
    assert.equal(compareVersions(order[i], order[i + 1]), -1, `${order[i]} < ${order[i + 1]}`);
    assert.equal(compareVersions(order[i + 1], order[i]), 1, `${order[i + 1]} > ${order[i]}`);
  }
});

test("compareVersions: null for anything that is not x.y.z", () => {
  for (const bad of ["1.2", "1", "v1.2.0", "=1.2.0", "^1.2.0", "1.2.0.0", "01.2.0", "1.2.x", "1.2.0-01", "1.2.0-", "latest", "", " 1.2.0"]) {
    assert.equal(compareVersions(bad, "1.2.0"), null, bad);
    assert.equal(compareVersions("1.2.0", bad), null, bad);
  }
});

test("not in package.json: added at the pinned version", () => {
  assert.deepEqual(pinFor(S, undefined, "1.2.0"), { add: "@parlox/server@1.2.0", note: null });
  assert.deepEqual(pinFor(B, undefined, "1.0.3"), { add: "@parlox/browser@1.0.3", note: null });
});

test("exactly the pinned version: nothing to add, nothing to say", () => {
  assert.deepEqual(pinFor(S, "1.2.0", "1.2.0"), { add: null, note: null });
});

test("newer, same major (exact, ^ or ~): kept, and the plan says so", () => {
  assert.deepEqual(pinFor(S, "1.2.0", "1.1.0"), { add: null, note: newer(S, "1.2.0", "1.1.0") });
  assert.deepEqual(pinFor(S, "^1.3.0", "1.2.0"), { add: null, note: newer(S, "^1.3.0", "1.2.0") });
  assert.deepEqual(pinFor(S, "~1.2.1", "1.2.0"), { add: null, note: newer(S, "~1.2.1", "1.2.0") });
  assert.deepEqual(pinFor(B, "1.1.0", "1.0.3"), { add: null, note: newer(B, "1.1.0", "1.0.3") });
  // A range that starts at the pinned version allows it, or a newer one.
  assert.deepEqual(pinFor(S, "^1.2.0", "1.2.0"), { add: null, note: atLeast(S, "^1.2.0", "1.2.0") });
  assert.deepEqual(pinFor(S, "~1.2.0", "1.2.0"), { add: null, note: atLeast(S, "~1.2.0", "1.2.0") });
});

test("older, same major: upgraded to the pinned version", () => {
  for (const spec of ["1.1.0", "1.0.1", "^1.0.0", "~1.1.5", "1.2.0-beta.1", "^1.2.0-rc.1"]) {
    assert.deepEqual(pinFor(S, spec, "1.2.0"), { add: "@parlox/server@1.2.0", note: null }, spec);
  }
  assert.deepEqual(pinFor(B, "1.0.1", "1.0.3"), { add: "@parlox/browser@1.0.3", note: null });
});

test("a prerelease counts as lower than its release, and higher than an earlier release", () => {
  assert.deepEqual(pinFor(S, "1.2.0-beta.1", "1.2.0"), { add: "@parlox/server@1.2.0", note: null });
  assert.deepEqual(pinFor(S, "1.3.0-rc.1", "1.2.0"), { add: null, note: newer(S, "1.3.0-rc.1", "1.2.0") });
});

test("another major: left as it is, with a note", () => {
  for (const spec of ["2.0.0", "^2.1.0", "~2.0.0", "0.9.0", "2.0.0-beta.1"]) {
    assert.deepEqual(pinFor(S, spec, "1.2.0"), { add: null, note: otherMajor(S, spec, "1.2.0") }, spec);
  }
});

test("a spec the wizard cannot compare: left as it is, with a note", () => {
  const specs = [
    "workspace:*", "workspace:^1.2.0", "file:../server", "link:../server", "github:parlox-io/parlox-js", "parlox-io/parlox-js#main",
    "git+https://github.com/parlox-io/parlox-js.git", "https://example.com/parlox-server-1.2.0.tgz", "npm:@parlox/server@1.2.0",
    "latest", "next", "*", "", "x", ">=1.0.0", "1.x", "1.2", "^1.2", ">=1.0.0 <2.0.0", "1.0.0 - 1.3.0", "^1.0.0 || ^2.0.0", "v1.3.0", "=1.3.0",
  ];
  for (const spec of specs) assert.deepEqual(pinFor(S, spec, "1.2.0"), { add: null, note: cannotCompare(S, spec, "1.2.0") }, spec);
  // Not a string at all (a broken package.json): not compared either.
  for (const spec of [null, 5, { version: "1.2.0" }]) assert.deepEqual(pinFor(S, spec, "1.2.0"), { add: null, note: cannotCompare(S, spec, "1.2.0") });
});

test("a git or URL source: the note never shows the user part of its address, where a token can be", () => {
  const note = pinFor(S, "git+https://ghp_abc123:x-oauth-basic@github.com/parlox-io/parlox-js.git", "1.2.0").note;
  assert.equal(note, cannotCompare(S, "git+https://[hidden]@github.com/parlox-io/parlox-js.git", "1.2.0"));
  assert.equal(pinFor(S, "https://user:pass@example.com/s.tgz", "1.2.0").note, cannotCompare(S, "https://[hidden]@example.com/s.tgz", "1.2.0"));
  assert.equal(pinFor(S, "git@github.com:parlox-io/parlox-js.git", "1.2.0").note, cannotCompare(S, "git@github.com:parlox-io/parlox-js.git", "1.2.0"), "an ssh address names no secret");
});

test("a pinned version that is not x.y.z is a bug in the wizard, not a guess", () => {
  assert.throws(() => pinFor(S, "1.2.0", "latest"), /latest/);
});

test("packagesToAdd: the same rule for each package, in order", () => {
  assert.deepEqual(packagesToAdd({ react: "19.0.0" }, [[B, "1.0.3"], [S, "1.2.0"]]), { add: ["@parlox/browser@1.0.3", "@parlox/server@1.2.0"], notes: [] });
  assert.deepEqual(packagesToAdd({ [B]: "1.1.0", [S]: "1.0.1" }, [[B, "1.0.3"], [S, "1.2.0"]]), { add: ["@parlox/server@1.2.0"], notes: [newer(B, "1.1.0", "1.0.3")] });
  assert.deepEqual(packagesToAdd({ [B]: "workspace:*", [S]: "2.0.0" }, [[B, "1.0.3"], [S, "1.2.0"]]), { add: [], notes: [cannotCompare(B, "workspace:*", "1.0.3"), otherMajor(S, "2.0.0", "1.2.0")] });
  assert.deepEqual(packagesToAdd({ [B]: "1.0.3", [S]: "1.2.0" }, [[B, "1.0.3"], [S, "1.2.0"]]), { add: [], notes: [] });
});
