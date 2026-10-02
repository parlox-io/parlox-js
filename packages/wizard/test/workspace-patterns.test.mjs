import { test } from "node:test";
import assert from "node:assert/strict";
import { scanApps } from "../dist/apps.js";
import { workspaceDirs, workspaceGlobs } from "../dist/workspace.js";
import { fixture, pkg } from "./helpers.mjs";

// A workspace list's negated patterns ("!apps/old-shop") take folders out, as the package managers read them:
// - package.json's workspaces, as npm does (@npmcli/map-workspaces 4.0.2, appendNegatedPatterns): a negation takes out
//   what the patterns match, wherever it is listed, unless a later pattern it matches adds the folder back;
// - pnpm-workspace.yaml's packages, as pnpm does (9.15, findPackages through fast-glob): every negation applies to every
//   pattern, whatever the order.
// Checked against npm 10.9.7 (`npm pkg get name --workspaces`) and pnpm 9.15.0 (`pnpm ls -r --depth -1`) on these lists.

const layout = "export default function RootLayout({ children }) {\n  return <html><body>{children}</body></html>\n}\n";
const APPS = Object.fromEntries(["web", "old-shop", "older"].flatMap((a) => [[`apps/${a}/package.json`, pkg()], [`apps/${a}/app/layout.tsx`, layout]]));
const npmRoot = (workspaces) => fixture({ "package.json": JSON.stringify({ name: "mono", private: true, workspaces }), "package-lock.json": "{}", ...APPS });
const pnpmRoot = (packages) => fixture({ "package.json": JSON.stringify({ name: "mono", private: true }), "pnpm-workspace.yaml": `packages:\n${packages.map((p) => `  - '${p}'\n`).join("")}`, "pnpm-lock.yaml": "lockfileVersion: '9.0'\n", ...APPS });
const sorted = (dirs) => [...dirs].sort();

test("['apps/*', '!apps/old-shop'] does not offer apps/old-shop, in package.json or pnpm-workspace.yaml", () => {
  for (const root of [npmRoot(["apps/*", "!apps/old-shop"]), pnpmRoot(["apps/*", "!apps/old-shop"])]) {
    assert.deepEqual(sorted(workspaceDirs(root)), ["apps/older", "apps/web"]);
    assert.deepEqual(scanApps(root).units.map((u) => u.rel), ["apps/older", "apps/web"]);
    assert.deepEqual(workspaceGlobs(root), ["apps/*"], "the positive patterns, as before");
  }
});

test("a negation applies after the positive patterns, wherever it is listed; one with * takes out every folder it matches", () => {
  for (const root of [npmRoot(["!apps/old-shop", "apps/*"]), pnpmRoot(["!apps/old-shop", "apps/*"])]) assert.deepEqual(sorted(workspaceDirs(root)), ["apps/older", "apps/web"]);
  for (const root of [npmRoot(["apps/*", "!apps/old*"]), pnpmRoot(["apps/*", "!apps/old*"])]) assert.deepEqual(workspaceDirs(root), ["apps/web"]);
  for (const root of [npmRoot(["apps/*", "!apps/**"]), pnpmRoot(["apps/*", "!apps/*"])]) assert.deepEqual(workspaceDirs(root), []);
});

test("a later pattern adds back what a negation took out in package.json (npm), never in pnpm-workspace.yaml (pnpm)", () => {
  assert.deepEqual(sorted(workspaceDirs(npmRoot(["apps/*", "!apps/old-*", "apps/old-shop"]))), ["apps/old-shop", "apps/older", "apps/web"]);
  assert.deepEqual(sorted(workspaceDirs(pnpmRoot(["apps/*", "!apps/old-*", "apps/old-shop"]))), ["apps/older", "apps/web"]);
});

test("an even number of ! is a positive pattern, as npm reads it", () => {
  assert.deepEqual(workspaceDirs(npmRoot(["!!apps/web"])), ["apps/web"]);
  assert.deepEqual(workspaceGlobs(npmRoot(["!!apps/web"])), ["apps/web"]);
});
