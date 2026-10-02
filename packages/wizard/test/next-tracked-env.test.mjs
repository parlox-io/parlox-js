import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "../dist/cli.js";
import { startFakeAuth, startFakeGateway } from "./fake-servers.mjs";
import { fixture, pkg, read } from "./helpers.mjs";

// A Next.js app whose .env.local git tracks is a step by hand for that app, as for Express and Hono: the run goes on,
// the step names the file from the start folder and both ways out, and that app gets no local key. Uninstall the same.

const layout = `export default function RootLayout({ children }) {\n  return (\n    <html>\n      <body>{children}</body>\n    </html>\n  );\n}\n`;
const SITE = { id: "11111111-1111-1111-1111-111111111111", name: "Shop", domain: "shop.example.com", public_key: "pk_" + "a1".repeat(12), verified: false };
const G = ["-c", "user.email=t@t", "-c", "user.name=t"];
const commit = (dir, msg) => { execFileSync("git", [...G, "add", "-A"], { cwd: dir }); execFileSync("git", [...G, "commit", "-qm", msg], { cwd: dir }); };

test("two Next.js apps, one with a tracked .env.local: a step by hand for it, the other installed, both runs finish", async (t) => {
  const auth = await startFakeAuth({ decide: "approve" });
  const gw = await startFakeGateway({ sites: [{ ...SITE }], keys: [] });
  t.after(() => { auth.close(); gw.close(); });
  const config = { gateway: gw.url, supabaseUrl: auth.url, clientId: "wiz", apiKey: "k", ports: [53922, 53923], dashboard: "https://app.parlox.io" };
  const root = fixture({
    "package.json": JSON.stringify({ name: "mono", private: true, workspaces: ["apps/*"] }), "package-lock.json": "{}",
    "apps/web/package.json": pkg(), "apps/web/app/layout.tsx": layout, "apps/web/.env.local": "DATABASE_URL=postgres://u:hunter2@h/db\n", "apps/web/netlify.toml": "",
    "apps/shop/package.json": pkg(), "apps/shop/app/layout.tsx": layout, "apps/shop/.gitignore": ".env.local\n", "apps/shop/netlify.toml": "",
  });
  execFileSync("git", [...G, "init", "-q"], { cwd: root });
  commit(root, "init");
  const out = [], reports = [];
  const ui = { info: (m) => out.push(m), warn: (m) => out.push(`WARN ${m}`), confirm: async () => true, select: async (_m, o) => o[0].value, text: async () => "", multiselect: async (_m, o) => o.map((x) => x.value), report: (lines) => reports.push(...lines) };
  const deps = { cwd: root, config, ui, open: (u) => { if (!u.includes("newKey")) fetch(u).catch(() => {}); }, run: () => ({ status: 0, stdout: "", stderr: "" }) };
  assert.equal(await main(["--yes", "--no-vercel", "--local-key", "--site", "shop.example.com", "--skip-check"], deps), 0, out.join("\n"));
  const step = out.find((m) => m.startsWith("WARN apps/web/.env.local: git tracks this file, so the wizard does not write to it."));
  assert.ok(step && step.includes("git rm --cached apps/web/.env.local") && /set PARLOX_VERIFY_TOKEN in the environment you start the server with instead/.test(step) && step.endsWith("PARLOX_VERIFY_TOKEN=vt_fake"), out.join("\n"));
  assert.equal(read(root, "apps/web/.env.local"), "DATABASE_URL=postgres://u:hunter2@h/db\n", "the tracked file is not written");
  assert.match(read(root, "apps/web/app/layout.tsx"), /ParloxAnalytics/, "the rest of the app is installed");
  assert.match(read(root, "apps/shop/.env.local"), /^PARLOX_VERIFY_TOKEN=vt_fake\nPARLOX_SECRET_KEY=sk_parlox_/, "the other app, with its local key");
  assert.equal(gw.state.keys.length, 1, "no local key for apps/web");
  assert.ok(out.some((m) => m.startsWith("WARN No local key (apps/web): apps/web/.env.local is a step by hand")), out.join("\n"));
  assert.equal(out.some((m) => m.includes("hunter2")), false);

  // Uninstall: the same file is a step by hand again; the run finishes.
  const p = JSON.parse(read(root, "apps/shop/package.json"));
  for (const app of ["web", "shop"]) writeFileSync(join(root, "apps", app, "package.json"), JSON.stringify({ ...p, dependencies: { ...p.dependencies, "@parlox/browser": "1.0.3", "@parlox/server": "1.1.0" } }));
  writeFileSync(join(root, "apps/web/.env.local"), "DATABASE_URL=postgres://u:hunter2@h/db\nPARLOX_VERIFY_TOKEN=vt_fake\n");
  commit(root, "installed");
  const un = [];
  assert.equal(await main(["uninstall", "--yes"], { ...deps, ui: { ...ui, info: (m) => un.push(m), warn: (m) => un.push(`WARN ${m}`) } }), 0, un.join("\n"));
  assert.ok(un.some((m) => m.startsWith("WARN apps/web/.env.local: git tracks this file, so the wizard does not change it: remove the PARLOX_VERIFY_TOKEN line yourself.")), un.join("\n"));
  assert.equal(read(root, "apps/web/.env.local"), "DATABASE_URL=postgres://u:hunter2@h/db\nPARLOX_VERIFY_TOKEN=vt_fake\n");
  assert.doesNotMatch(read(root, "apps/web/app/layout.tsx"), /Parlox/);
  assert.equal(un.some((m) => m.includes("hunter2")), false);
});

// A .gitignore the wizard may not read (a link, which is never followed; a file over 1 MB): .env.local is written only
// where git ignores it, so it becomes a step by hand for that app, never the end of the run.
for (const [label, make, skip] of [
  ["a link", (dir) => { const outside = fixture({ "gitignore": "node_modules\n" }); symlinkSync(join(outside, "gitignore"), join(dir, ".gitignore"), "file"); }, process.platform === "win32"],
  ["over 1 MB", (dir) => writeFileSync(join(dir, ".gitignore"), `node_modules\n${"#".repeat(1_100_000)}\n`), false],
]) {
  test(`two Next.js apps, one whose .gitignore is ${label}: .env.local is a step by hand for it, the other installed, the run finishes`, { skip }, async (t) => {
    const auth = await startFakeAuth({ decide: "approve" });
    const gw = await startFakeGateway({ sites: [{ ...SITE }], keys: [] });
    t.after(() => { auth.close(); gw.close(); });
    const config = { gateway: gw.url, supabaseUrl: auth.url, clientId: "wiz", apiKey: "k", ports: [53962, 53963], dashboard: "https://app.parlox.io" };
    const root = fixture({
      "package.json": JSON.stringify({ name: "mono", private: true, workspaces: ["apps/*"] }), "package-lock.json": "{}",
      "apps/web/package.json": pkg(), "apps/web/app/layout.tsx": layout, "apps/web/netlify.toml": "",
      "apps/shop/package.json": pkg(), "apps/shop/app/layout.tsx": layout, "apps/shop/.gitignore": ".env.local\n", "apps/shop/netlify.toml": "",
    });
    make(join(root, "apps/web"));
    execFileSync("git", [...G, "init", "-q"], { cwd: root });
    commit(root, "init");
    const out = [];
    const ui = { info: (m) => out.push(m), warn: (m) => out.push(`WARN ${m}`), confirm: async () => true, select: async (_m, o) => o[0].value, text: async () => "", multiselect: async (_m, o) => o.map((x) => x.value), report: () => {} };
    const deps = { cwd: root, config, ui, open: (u) => { if (!u.includes("newKey")) fetch(u).catch(() => {}); }, run: () => ({ status: 0, stdout: "", stderr: "" }) };
    assert.equal(await main(["--yes", "--no-vercel", "--site", "shop.example.com", "--skip-check"], deps), 0, out.join("\n"));
    const step = out.find((m) => m.startsWith("WARN apps/web/.env.local: The wizard writes this file only when .gitignore keeps it out of git, and it does not read .gitignore ("));
    assert.ok(step && step.endsWith("PARLOX_VERIFY_TOKEN=vt_fake"), out.join("\n"));
    assert.equal(read(root, "apps/web/.env.local"), null, "not written where git may not ignore it");
    assert.match(read(root, "apps/web/app/layout.tsx"), /ParloxAnalytics/, "the rest of the app is installed");
    assert.match(read(root, "apps/shop/.env.local"), /^PARLOX_VERIFY_TOKEN=vt_fake\n/, "the other app");
  });
}
