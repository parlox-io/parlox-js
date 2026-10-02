// Every committed fixture (official generators and hand-written variants), offline: plan, apply, plan again (nothing
// left to change), uninstall, and every file back byte for byte. The installs, builds and renders are in
// scripts/e2e.mjs (CI job wizard-e2e).
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { mergePlans, planUnit, scanApps, unplanUnit } from "../dist/apps.js";
import { applyPlan } from "../dist/plan-core.js";
import { vercelHost } from "../dist/hosts.js";
import { parseCode } from "../dist/edits/splice.js";

const FIXTURES = resolve(import.meta.dirname, "fixtures");
const manifest = JSON.parse(readFileSync(join(FIXTURES, "manifest.json"), "utf8"));
const PK = "pk_" + "f1".repeat(12);
const git = { isRepo: () => false, dirty: () => [], isTracked: () => false, isIgnored: () => false };
const OTHER = { id: "netlify", label: "Netlify", where: "Project configuration → Environment variables", docs: null, vercelDir: null };
const reader = (dir) => (rel) => { try { const p = join(dir, rel); return statSync(p).isFile() ? readFileSync(p, "utf8") : null; } catch { return null; } };
function files(dir) {
  const out = {};
  const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) walk(p); else out[relative(dir, p).split("\\").join("/")] = readFileSync(p); } };
  walk(dir);
  return out;
}
function planAll(dir, host) {
  const scan = scanApps(dir);
  const parts = scan.units.map((u) => ({ unit: u, plan: planUnit(u, { publicKey: PK, verifyToken: "vt_fixture", host: host === "vercel" ? vercelHost(null) : OTHER }, { read: reader(u.dir), git }) }));
  return { scan, plan: parts.length === 1 ? parts[0].plan : mergePlans(parts) };
}

for (const f of manifest.fixtures) {
  test(`fixture ${f.name}: plan, apply, nothing left on a second run, uninstall gives back every byte`, () => {
    const dir = mkdtempSync(join(tmpdir(), "parlox-fixture-"));
    cpSync(join(FIXTURES, f.dir), dir, { recursive: true });
    const original = files(dir);
    const { scan, plan } = planAll(dir, f.host);
    assert.deepEqual(plan.changes.map((c) => c.path).sort(), [...f.changes].sort());
    assert.deepEqual(plan.manual, [], "nothing to paste by hand");
    const base = scan.units.length === 1 ? scan.units[0].dir : scan.base;
    applyPlan(base, plan);
    for (const c of plan.changes) if (/\.(m?[jt]sx?|cjs)$/.test(c.path)) assert.ok(parseCode(c.after, c.path), `${c.path} still parses`);
    assert.deepEqual(planAll(dir, f.host).plan.changes, [], "already installed: nothing to change");
    const again = scanApps(dir);
    const un = again.units.map((u) => ({ unit: u, plan: unplanUnit(u, { read: reader(u.dir), git }) }));
    applyPlan(base, un.length === 1 ? un[0].plan : mergePlans(un));
    const after = files(dir);
    assert.deepEqual(Object.keys(after).sort(), Object.keys(original).sort(), "the same files");
    for (const [rel, bytes] of Object.entries(original)) assert.ok(after[rel].equals(bytes), `${rel} is back byte for byte`);
  });
}
