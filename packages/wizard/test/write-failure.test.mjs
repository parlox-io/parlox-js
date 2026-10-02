import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "../dist/cli.js";
import { BROWSER_VERSION, SERVER_VERSION } from "../dist/versions.js";
import { startFakeAuth, startFakeGateway } from "./fake-servers.mjs";
import { fixture, pkg, read } from "./helpers.mjs";

// A write that fails after the check: the package command goes only to an app whose files are all as the run meant
// them (for an install, also to one partly changed, whose written files already import the package). Every other app
// is told to run the wizard again; an uninstall never hands out the removal command for an app whose files may still
// import the packages. An app with none of its changes gets no host hand-off.

const canChmod = process.platform !== "win32" && process.getuid?.() !== 0;
const layout = `export default function RootLayout({ children }) {\n  return (\n    <html>\n      <body>{children}</body>\n    </html>\n  );\n}\n`;
const SITE = { id: "11111111-1111-1111-1111-111111111111", name: "Shop", domain: "shop.example.com", public_key: "pk_" + "a1".repeat(12), verified: false };
const G = ["-c", "user.email=t@t", "-c", "user.name=t"];
const commit = (dir, msg) => { execFileSync("git", [...G, "add", "-A"], { cwd: dir }); execFileSync("git", [...G, "commit", "-qm", msg], { cwd: dir }); };
const REMOVE = "npm uninstall @parlox/browser @parlox/server";
const mono = () => {
  const root = fixture({
    "package.json": JSON.stringify({ name: "mono", private: true, workspaces: ["apps/*"] }), "package-lock.json": "{}", ".gitignore": ".env*.local\n",
    "apps/web/package.json": pkg(), "apps/web/app/layout.tsx": layout, "apps/web/netlify.toml": "",
    "apps/shop/package.json": pkg(), "apps/shop/app/layout.tsx": layout, "apps/shop/fly.toml": "",
  });
  execFileSync("git", [...G, "init", "-q"], { cwd: root });
  commit(root, "init");
  return root;
};

async function env(t) {
  const auth = await startFakeAuth({ decide: "approve" });
  const gw = await startFakeGateway({ sites: [{ ...SITE }], keys: [] });
  t.after(() => { auth.close(); gw.close(); });
  const config = { gateway: gw.url, supabaseUrl: auth.url, clientId: "wiz", apiKey: "k", ports: [53932, 53933], dashboard: "https://app.parlox.io" };
  return (root, face, runs) => ({ cwd: root, config, ui: face, open: (u) => { if (!u.includes("newKey")) fetch(u).catch(() => {}); }, run: (cmd, args) => { runs.push([cmd, ...args]); return { status: 0, stdout: "", stderr: "" }; } });
}
const recorder = (onLanded) => {
  const out = [];
  let injected = false;
  return { out, ui: {
    info: (m) => out.push(m), warn: (m) => out.push(`WARN ${m}`), confirm: async () => true, select: async (_m, o) => o[0].value, text: async () => "", multiselect: async (_m, o) => o.map((x) => x.value),
    // Once the first change has landed, the failure is set up.
    step: (id, status) => { if (id === "review" && status === "done" && !injected) { injected = true; onLanded(); } },
  } };
};
const installAll = async (deps, root) => {
  assert.equal(await main(["--yes", "--no-vercel", "--site", "shop.example.com", "--skip-check"], deps(root, recorder(() => {}).ui, [])), 0);
  for (const app of ["web", "shop"]) writeFileSync(join(root, "apps", app, "package.json"), pkg({ next: "16.0.1", react: "19.0.0", "@parlox/browser": BROWSER_VERSION, "@parlox/server": SERVER_VERSION }));
  commit(root, "installed");
};

test("install: an app none of whose changes were written gets no package command and no hand-off, and is told to run the wizard again", { skip: !canChmod }, async (t) => {
  const deps = await env(t);
  const root = mono();
  const r = recorder(() => chmodSync(join(root, "apps/web/app/layout.tsx"), 0o444));
  t.after(() => chmodSync(join(root, "apps/web/app/layout.tsx"), 0o644));
  const runs = [];
  assert.equal(await main(["--yes", "--no-vercel", "--site", "shop.example.com", "--skip-check"], deps(root, r.ui, runs)), 1);
  assert.deepEqual(runs, []);
  assert.ok(r.out.some((m) => m.startsWith("WARN The package install did not run in apps/shop; run it yourself:")), r.out.join("\n"));
  assert.equal(r.out.some((m) => m.startsWith("WARN The package install did not run in apps/web")), false, r.out.join("\n"));
  assert.ok(r.out.includes("WARN Run the wizard again for apps/web (npx parlox init --app apps/web): none of its changes were written."), r.out.join("\n"));
  const handoffs = r.out.filter((m) => m.startsWith("Connect your host"));
  assert.equal(handoffs.length, 1, handoffs.join("\n---\n"));
  assert.match(handoffs[0], /\(for apps\/shop\)/);
});

test("uninstall: the removal command only for an app fully changed; the others run the uninstall again", { skip: !canChmod }, async (t) => {
  const deps = await env(t);
  const root = mono();
  await installAll(deps, root);
  const r = recorder(() => chmodSync(join(root, "apps/web/app/layout.tsx"), 0o444));
  t.after(() => chmodSync(join(root, "apps/web/app/layout.tsx"), 0o644));
  const runs = [];
  assert.equal(await main(["uninstall", "--yes"], deps(root, r.ui, runs)), 1, r.out.join("\n"));
  assert.deepEqual(runs, []);
  assert.ok(r.out.includes(`WARN The package removal did not run in apps/shop; run it yourself: ${REMOVE}`), r.out.join("\n"));
  assert.equal(r.out.some((m) => m.startsWith("WARN The package removal did not run in apps/web")), false, r.out.join("\n"));
  assert.ok(r.out.includes("WARN Run the uninstall again for apps/web (npx parlox uninstall --app apps/web): none of the app's files were changed, and they may still import the Parlox packages, so remove no package by hand before then."), r.out.join("\n"));
});

test("uninstall: an app partly changed gets no removal command either", { skip: !canChmod }, async (t) => {
  const deps = await env(t);
  const root = mono();
  await installAll(deps, root);
  // After apps/shop's first file is written, its folder takes no more changes (its proxy.js cannot be deleted).
  const r = recorder(() => chmodSync(join(root, "apps/shop"), 0o555));
  t.after(() => chmodSync(join(root, "apps/shop"), 0o755));
  const runs = [];
  assert.equal(await main(["uninstall", "--yes"], deps(root, r.ui, runs)), 1, r.out.join("\n"));
  assert.equal(r.out.some((m) => m.startsWith("WARN The package removal did not run")), false, r.out.join("\n"));
  assert.ok(r.out.some((m) => m.startsWith("WARN Run the uninstall again for apps/shop (npx parlox uninstall --app apps/shop): the app was partly changed")), r.out.join("\n"));
  assert.ok(r.out.some((m) => m.startsWith("WARN Run the uninstall again for apps/web")), r.out.join("\n"));
  assert.match(read(root, "apps/shop/proxy.js"), /withParlox/, "the file that failed is as it was");
});
