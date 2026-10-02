import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { INTEGRATIONS, integrationOf } from "../dist/integrations/registry.js";
import { nextjs, detectApp } from "../dist/integrations/nextjs.js";
import { installPlan, uninstallPlan, applyPlan } from "../dist/plan.js";
import { summarizeChanges } from "../dist/ui/summary.js";
import { WizardStore } from "../dist/tui/store.js";
import { fixture, pkg } from "./helpers.mjs";

const layout = "export default function RootLayout({ children }) { return <html><body>{children}</body></html>; }\n";
const PK = "pk_" + "a1".repeat(12);
const git = { isRepo: () => false, dirty: () => [], isTracked: () => false, isIgnored: () => false };
const reader = (dir) => (rel) => (existsSync(join(dir, rel)) ? readFileSync(join(dir, rel), "utf8") : null);
const HOST = { id: "unknown", label: "your host", where: "your host's environment-variable settings", docs: null, vercelDir: null };
const input = (dir) => ({ publicKey: PK, verifyToken: "vt_abc", host: HOST, versions: { browser: "1.0.3", server: "1.0.1" }, parts: { browser: true, server: true }, read: reader(dir), git });

test("the registry starts with Next.js, found by id or by a detection", () => {
  assert.equal(INTEGRATIONS[0], nextjs, "Next.js is checked first (later tasks append the other stacks)");
  assert.equal(integrationOf("nextjs"), nextjs);
  assert.equal(integrationOf({ integration: "nextjs" }), nextjs);
});

test("nextjs.detect: null for a folder that is not Next.js; otherwise the app, the facts line, both parts, .env.local", () => {
  const plain = fixture({ "package.json": pkg({ react: "19.0.0" }) });
  assert.equal(nextjs.detect(plain, plain), null);
  const dir = fixture({ "package.json": pkg(), "package-lock.json": "{}", "tsconfig.json": "{}", "app/layout.tsx": layout });
  const d = nextjs.detect(dir, dir);
  assert.equal(d.integration, "nextjs");
  assert.equal(d.packageManager, "npm");
  assert.deepEqual(d.facts, [["Found", "Next.js 16 · App Router · TypeScript · npm"]]);
  assert.deepEqual(d.parts, { browser: { file: "app/layout.tsx", kind: "layout" }, server: { file: "proxy.ts", kind: "middleware" } });
  assert.equal(d.envFile, ".env.local");
  assert.deepEqual(d.localCheck, { url: "http://localhost:3000", start: "npm run dev" });
  assert.deepEqual(d.notes, []);
  assert.deepEqual(d.data, detectApp(dir));
});

test("nextjs.plan and nextjs.unplan are exactly installPlan and uninstallPlan", () => {
  const dir = fixture({ "package.json": pkg(), "package-lock.json": "{}", "app/layout.tsx": layout, "middleware.js": "export function middleware() {}\n" });
  const d = nextjs.detect(dir, dir);
  const plan = nextjs.plan(d, input(dir));
  assert.deepEqual(plan, installPlan(detectApp(dir), { publicKey: PK, verifyToken: "vt_abc" }, reader(dir), git));
  applyPlan(dir, plan);
  const after = nextjs.detect(dir, dir);
  assert.deepEqual(nextjs.unplan(after, { read: reader(dir), git }), uninstallPlan(detectApp(dir), reader(dir), git));
});

test("a change's own purpose is shown, and the full screen keeps it", () => {
  const plan = { install: null, manual: [], warnings: [], changes: [
    { path: "src/main.tsx", before: "a\n", after: "a\nb\n", purpose: "browser part" },
    { path: "app/layout.tsx", before: "a\n", after: "a\nb\n" },
  ] };
  assert.deepEqual(summarizeChanges(plan).map((r) => r.purpose), ["browser part", "browser part"]);
  const s = new WizardStore();
  s.changes(plan, "shop", "install");
  assert.equal(s.getSnapshot().plan.changes[0].purpose, "browser part");
  assert.equal(s.getSnapshot().plan.changes[1].purpose, undefined);
});
