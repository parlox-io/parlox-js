import { test } from "node:test";
import assert from "node:assert/strict";
import { symlinkSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectApp } from "../dist/detect.js";
import { installPlan, uninstallPlan, applyPlan, packageCommand, PlanError } from "../dist/plan.js";
import { resolveInside, readInside } from "../dist/fs-safe.js";
import { fixture, pkg, read } from "./helpers.mjs";

const PK = "pk_" + "a1".repeat(12);
const layout = `export default function RootLayout({ children }) {\n  return (\n    <html>\n      <body>{children}</body>\n    </html>\n  );\n}\n`;
const git = (tracked = [], ignored = [".env.local"]) => ({ isRepo: () => true, dirty: () => [], isTracked: (f) => tracked.includes(f), isIgnored: (f) => ignored.includes(f) });
const readerFor = (dir) => (rel) => readInside(dir, rel);
const installed = (dir) => writeFileSync(join(dir, "package.json"), pkg({ next: "16.0.1", react: "19.0.0", "@parlox/browser": "1.0.3", "@parlox/server": "1.2.0" }));

test("fresh Next 16 app: layout edit, proxy.ts created, .env.local with the verify token only, exact installs", () => {
  const dir = fixture({ "package.json": pkg(), "package-lock.json": "{}", "tsconfig.json": "{}", "app/layout.tsx": layout });
  const plan = installPlan(detectApp(dir), { publicKey: PK, verifyToken: "vt_abc" }, readerFor(dir), git());
  assert.deepEqual(plan.changes.map((c) => c.path).sort(), [".env.local", "app/layout.tsx", "proxy.ts"]);
  assert.equal(plan.changes.find((c) => c.path === ".env.local").after, "PARLOX_VERIFY_TOKEN=vt_abc\n");
  assert.equal(JSON.stringify(plan).includes("sk_"), false);
  assert.deepEqual(plan.install, { command: "npm", args: ["install", "--save-exact", "@parlox/browser@1.0.3", "@parlox/server@1.2.0"] });
  assert.deepEqual(plan.manual, []);
});

test(".env.local not ignored: .gitignore gets the line; tracked .env.local: a step by hand, not written", () => {
  const dir = fixture({ "package.json": pkg(), "package-lock.json": "{}", "app/layout.tsx": layout, ".gitignore": "node_modules\n" });
  const plan = installPlan(detectApp(dir), { publicKey: PK, verifyToken: "vt" }, readerFor(dir), git([], []));
  assert.equal(plan.changes.find((c) => c.path === ".gitignore").after, "node_modules\n.env.local\n");
  const tracked = installPlan(detectApp(dir), { publicKey: PK, verifyToken: "vt" }, readerFor(dir), git([".env.local"], []));
  assert.equal(tracked.changes.some((c) => c.path === ".env.local" || c.path === ".gitignore"), false);
  assert.deepEqual(tracked.manual.map((m) => [m.file, m.snippet]), [[".env.local", "PARLOX_VERIFY_TOKEN=vt"]]);
  assert.match(tracked.manual[0].reason, /^git tracks this file, so the wizard does not write to it\. Remove it from git \(git rm --cached \.env\.local\)/);
});

test("an existing matcher produces a warning in the plan", () => {
  const dir = fixture({ "package.json": pkg(), "package-lock.json": "{}", "app/layout.tsx": layout, "proxy.ts": "export function proxy(r) { return undefined; }\nexport const config = { matcher: ['/shop/:path*'] };\n", "tsconfig.json": "{}" });
  const plan = installPlan(detectApp(dir), { publicKey: PK, verifyToken: "vt" }, readerFor(dir), git());
  assert.ok(plan.warnings.some((w) => /parlox-verify/.test(w)));
});

test("apply then plan again: nothing left to change, nothing to install", () => {
  const dir = fixture({ "package.json": pkg(), "package-lock.json": "{}", "app/layout.tsx": layout });
  applyPlan(dir, installPlan(detectApp(dir), { publicKey: PK, verifyToken: "vt" }, readerFor(dir), git()));
  installed(dir);
  const again = installPlan(detectApp(dir), { publicKey: PK, verifyToken: "vt" }, readerFor(dir), git());
  assert.deepEqual(again.changes, []);
  assert.equal(again.install, null);
});

test("uninstall reverses it: created proxy deleted, layout and env restored, packages removed", () => {
  const dir = fixture({ "package.json": pkg(), "pnpm-lock.yaml": "", "app/layout.tsx": layout, ".env.local": "A=1\n" });
  applyPlan(dir, installPlan(detectApp(dir), { publicKey: PK, verifyToken: "vt" }, readerFor(dir), git()));
  installed(dir);
  const un = uninstallPlan(detectApp(dir), readerFor(dir), git());
  applyPlan(dir, un);
  assert.equal(read(dir, "proxy.js") ?? read(dir, "proxy.ts"), null);
  assert.equal(read(dir, "app/layout.tsx"), layout);
  assert.equal(read(dir, ".env.local"), "A=1\n");
  assert.deepEqual(un.install, { command: "pnpm", args: ["remove", "@parlox/browser", "@parlox/server"] });
});

test("uninstall with a hand-guarded ParloxAnalytics element: layout is a manual step, middleware wrapper and .env.local are still reverted", () => {
  const dir = fixture({ "package.json": pkg(), "pnpm-lock.yaml": "", "app/layout.tsx": layout, ".env.local": "A=1\n" });
  applyPlan(dir, installPlan(detectApp(dir), { publicKey: PK, verifyToken: "vt" }, readerFor(dir), git()));
  installed(dir);
  // A merchant hand-edits the installed layout to only render Parlox in production, moving the
  // ParloxAnalytics element under a `{cond && <Tag/>}` guard the wizard cannot safely unwrap.
  const guardedLayout = `import { ParloxAnalytics } from "@parlox/browser/react";\nexport default function RootLayout({ children }) {\n  return (\n    <html>\n      <body>\n        {children}\n        {process.env.NODE_ENV === "production" && <ParloxAnalytics publicKey="${PK}" />}\n      </body>\n    </html>\n  );\n}\n`;
  writeFileSync(join(dir, "app/layout.tsx"), guardedLayout);
  const un = uninstallPlan(detectApp(dir), readerFor(dir), git());
  assert.equal(un.manual.length, 1);
  assert.equal(un.manual[0].file, "app/layout.tsx");
  assert.equal(read(dir, "app/layout.tsx"), guardedLayout);
  applyPlan(dir, un);
  assert.equal(read(dir, "proxy.js") ?? read(dir, "proxy.ts"), null);
  assert.equal(read(dir, ".env.local"), "A=1\n");
  assert.equal(read(dir, "app/layout.tsx"), guardedLayout);
  assert.deepEqual(un.install, { command: "pnpm", args: ["remove", "@parlox/browser", "@parlox/server"] });
});

test("a layout the wizard cannot edit becomes a manual step, the rest still planned", () => {
  const dir = fixture({ "package.json": pkg(), "package-lock.json": "{}", "app/layout.tsx": "export default function L({ children }) { return children; }\n" });
  const plan = installPlan(detectApp(dir), { publicKey: PK, verifyToken: "vt" }, readerFor(dir), git());
  assert.equal(plan.manual.length, 1);
  assert.equal(plan.manual[0].file, "app/layout.tsx");
  assert.ok(plan.changes.some((c) => c.path === "proxy.js"));
});

test("package commands per manager", () => {
  assert.deepEqual(packageCommand("yarn", "add", ["a@1"]), { command: "yarn", args: ["add", "--exact", "a@1"] });
  assert.deepEqual(packageCommand("bun", "add", ["a@1"]), { command: "bun", args: ["add", "--exact", "a@1"] });
  assert.deepEqual(packageCommand("pnpm", "add", ["a@1"]), { command: "pnpm", args: ["add", "--save-exact", "a@1"] });
  assert.deepEqual(packageCommand("npm", "remove", ["a"]), { command: "npm", args: ["uninstall", "a"] });
});

test("paths that leave the project are refused, including through a symlink", () => {
  const dir = fixture({ "package.json": pkg() });
  const outside = mkdtempSync(join(tmpdir(), "outside-"));
  symlinkSync(outside, join(dir, "app"), "dir");
  assert.throws(() => resolveInside(dir, "app/layout.tsx"), /outside/);
  assert.throws(() => resolveInside(dir, "../x"), /Refusing/);
  assert.throws(() => resolveInside(dir, "/etc/passwd"), /Refusing/);
});

test("the .env.local the wizard creates is readable by its owner only; an existing one keeps its mode", { skip: process.platform === "win32" }, async () => {
  const { chmodSync, statSync } = await import("node:fs");
  const fresh = fixture({ "package.json": pkg(), "package-lock.json": "{}", "app/layout.tsx": layout });
  applyPlan(fresh, installPlan(detectApp(fresh), { publicKey: PK, verifyToken: "vt" }, readerFor(fresh), git()));
  assert.equal(statSync(join(fresh, ".env.local")).mode & 0o777, 0o600);
  const kept = fixture({ "package.json": pkg(), "package-lock.json": "{}", "app/layout.tsx": layout, ".env.local": "A=1\n" });
  chmodSync(join(kept, ".env.local"), 0o640);
  applyPlan(kept, installPlan(detectApp(kept), { publicKey: PK, verifyToken: "vt" }, readerFor(kept), git()));
  assert.equal(statSync(join(kept, ".env.local")).mode & 0o777, 0o640);
});

test("uninstall leaves a PARLOX_SECRET_KEY line in .env.local (it could be the merchant's own), and keeps the developer's own lines", () => {
  const dir = fixture({ "package.json": pkg(), "pnpm-lock.yaml": "", "app/layout.tsx": layout, ".env.local": "A=1\n" });
  applyPlan(dir, installPlan(detectApp(dir), { publicKey: PK, verifyToken: "vt" }, readerFor(dir), git()));
  writeFileSync(join(dir, ".env.local"), read(dir, ".env.local") + `  PARLOX_SECRET_KEY=sk_parlox_${"d".repeat(64)}\n`);
  installed(dir);
  applyPlan(dir, uninstallPlan(detectApp(dir), readerFor(dir), git()));
  assert.equal(read(dir, ".env.local"), `A=1\n  PARLOX_SECRET_KEY=sk_parlox_${"d".repeat(64)}\n`);
});
