import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { basename } from "node:path";
import { join } from "node:path";
import { main } from "../dist/cli.js";
import { coverageNotes, keyLabel } from "../dist/apps.js";
import { INTEGRATIONS } from "../dist/integrations/registry.js";
import { runNames } from "../dist/names.js";
import { handoffUrl } from "../dist/hosts.js";
import { summary } from "../dist/start.js";
import { WizardStore } from "../dist/tui/store.js";
import { applyPlan, isEnvFile } from "../dist/plan-core.js";
import { writeSecretInside } from "../dist/fs-safe.js";
import { summarizeChanges } from "../dist/ui/summary.js";
import { plainUi } from "../dist/ui/plain.js";
import { createElement } from "react";
import { render } from "ink-testing-library";
import { Review } from "../dist/tui/screens/Review.js";
import { BROWSER_VERSION, SERVER_VERSION } from "../dist/versions.js";
import { startFakeAuth, startFakeGateway } from "./fake-servers.mjs";
import { fixture, pkg, read } from "./helpers.mjs";

const layout = `export default function RootLayout({ children }) {\n  return (\n    <html>\n      <body>{children}</body>\n    </html>\n  );\n}\n`;
const G = ["-c", "user.email=t@t", "-c", "user.name=t"];
const commitAll = (dir, msg) => { execFileSync("git", [...G, "add", "-A"], { cwd: dir }); execFileSync("git", [...G, "commit", "-qm", msg], { cwd: dir }); };
const gitInit = (dir) => { execFileSync("git", [...G, "init", "-q"], { cwd: dir }); commitAll(dir, "init"); };
const follow = (url) => { if (!url.includes("newKey")) fetch(url).catch(() => {}); };
const SITE = { id: "11111111-1111-1111-1111-111111111111", name: "Shop", domain: "shop.example.com", public_key: "pk_" + "a1".repeat(12), verified: false };
const INSTALL = `npm install --save-exact @parlox/browser@${BROWSER_VERSION} @parlox/server@${SERVER_VERSION}`;
const BASE = ["--site", "shop.example.com", "--skip-check"];

async function env(t) {
  const auth = await startFakeAuth({ decide: "approve" });
  const gw = await startFakeGateway({ sites: [{ ...SITE }], keys: [] });
  t.after(() => { auth.close(); gw.close(); });
  const runs = [];
  const run = (cmd, args, opts) => { runs.push({ cmd, args, cwd: opts.cwd, input: opts.input }); return { status: 0, stdout: "", stderr: "" }; };
  const config = { gateway: gw.url, supabaseUrl: auth.url, clientId: "wiz", apiKey: "test-publishable-key", ports: [53812, 53813], dashboard: "https://app.parlox.io" };
  return { auth, gw, runs, deps: (dir, extra = {}) => ({ cwd: dir, config, open: follow, run, ...extra }) };
}
function ui(answers = {}) {
  const out = [], asked = [];
  return { out, asked, ui: {
    info: (m) => out.push(m), warn: (m) => out.push(`WARN ${m}`),
    confirm: async (m) => { asked.push(m); return answers.confirm ? answers.confirm(m) : true; },
    select: async (_m, o) => o[0].value, text: async () => "",
    multiselect: async (m, o) => { asked.push(m); return answers.pick ? answers.pick(o) : o.map((x) => x.value); },
  } };
}
const mono = (extra = {}) => fixture({
  "package.json": JSON.stringify({ name: "mono", private: true, workspaces: ["apps/*"] }), "package-lock.json": "{}", ".gitignore": ".vercel\n.env*.local\n",
  "apps/web/package.json": pkg(), "apps/web/app/layout.tsx": layout, "apps/shop/package.json": pkg(), "apps/shop/app/layout.tsx": layout, ...extra,
});
const markInstalled = (root, apps) => {
  for (const app of apps) {
    const p = JSON.parse(read(root, `apps/${app}/package.json`));
    p.dependencies["@parlox/browser"] = BROWSER_VERSION; p.dependencies["@parlox/server"] = SERVER_VERSION;
    writeFileSync(join(root, "apps", app, "package.json"), JSON.stringify(p));
  }
};

test("two apps, one run: one question, one diff, one Yes; an install in each app's folder; a hand-off per app named for its folder", async (t) => {
  const { runs, gw, deps } = await env(t);
  const root = mono({ "apps/web/netlify.toml": "", "apps/shop/fly.toml": "" });
  gitInit(root);
  const u = ui();
  assert.equal(await main(["--no-vercel", ...BASE], deps(root, { ui: u.ui })), 0, u.out.join("\n"));
  assert.deepEqual(u.asked, ["Which apps should Parlox be installed in?", `Apply these changes to ${root.split(/[\\/]/).pop()}?`]);
  const diff = u.out.find((m) => m.includes("+++ b/apps/web/proxy.js"));
  assert.ok(diff && diff.includes("+++ b/apps/shop/proxy.js"), "one diff covers both apps");
  assert.ok(u.out.includes(`Will run in apps/shop: ${INSTALL}`), u.out.join("\n"));
  assert.ok(u.out.includes(`Will run in apps/web: ${INSTALL}`));
  assert.deepEqual(runs.filter((r) => r.cmd === "npm").map((r) => r.cwd), [join(root, "apps", "shop"), join(root, "apps", "web")]);
  assert.match(read(root, "apps/web/app/layout.tsx"), /<ParloxAnalytics publicKey="pk_a1/);
  assert.match(read(root, "apps/shop/proxy.js"), /withParlox\(\)/);
  assert.equal(read(root, "apps/web/.env.local"), "PARLOX_VERIFY_TOKEN=vt_fake\n");
  const handoffs = u.out.filter((m) => m.startsWith("Connect your host"));
  assert.equal(handoffs.length, 2, handoffs.join("\n---\n"));
  assert.ok(handoffs.some((m) => m.includes("Set on Fly.io (for apps/shop):") && m.includes("newKey=apps%2Fshop%20%C2%B7%20Fly.io%20%C2%B7%20production")), handoffs.join("\n"));
  assert.ok(handoffs.some((m) => m.includes("Set on Netlify (for apps/web):") && m.includes("newKey=apps%2Fweb%20%C2%B7%20Netlify%20%C2%B7%20production")));
  assert.deepEqual(gw.state.keys, [], "no key is created without Vercel");
  const report = u.out.at(-1);
  assert.match(report, /Server part \(apps\/shop\): not checked\./);
  assert.match(report, /Browser part \(apps\/web\): added to your code/);
});

test("Vercel per app: each linked app gets its own send-only key, named for its folder, set from its own folder", async (t) => {
  const { runs, gw, deps } = await env(t);
  const root = mono({ "apps/web/.vercel/project.json": JSON.stringify({ projectName: "web-prod" }), "apps/shop/.vercel/project.json": JSON.stringify({ projectName: "shop-prod" }) });
  gitInit(root);
  const u = ui();
  assert.equal(await main(["--yes", "--vercel", "--app", "apps/web", "--app", "apps/shop", ...BASE], deps(root, { ui: u.ui })), 0, u.out.join("\n"));
  assert.deepEqual(u.asked, [], "--app, --yes and --vercel leave nothing to ask");
  assert.deepEqual(gw.state.keys, ["apps/web · Vercel · production", "apps/shop · Vercel · production"]);
  const adds = runs.filter((r) => r.cmd === "vercel" && r.args[0] === "env" && r.args[1] === "add" && r.args[2] !== "--help");
  assert.deepEqual(adds.map((r) => [r.cwd, r.args[2]]), [
    [join(root, "apps", "web"), "PARLOX_SECRET_KEY"], [join(root, "apps", "web"), "PARLOX_VERIFY_TOKEN"],
    [join(root, "apps", "shop"), "PARLOX_SECRET_KEY"], [join(root, "apps", "shop"), "PARLOX_VERIFY_TOKEN"],
  ]);
  assert.equal(u.out.some((m) => m.includes("sk_parlox_")), false, "the secret is never printed");
});

test("the picker: only the chosen app changes, and a run with one app keeps the old key names", async (t) => {
  const { deps } = await env(t);
  const root = mono({ "apps/web/netlify.toml": "" });
  gitInit(root);
  const u = ui({ pick: () => ["apps/web"] });
  assert.equal(await main(["--yes", "--no-vercel", ...BASE], deps(root, { ui: u.ui })), 0, u.out.join("\n"));
  assert.match(read(root, "apps/web/app/layout.tsx"), /ParloxAnalytics/);
  assert.equal(read(root, "apps/shop/app/layout.tsx"), layout);
  assert.equal(read(root, "apps/shop/proxy.js"), null);
  assert.ok(u.out.some((m) => m.includes("Set on Netlify:") && m.includes("newKey=Netlify%20%C2%B7%20production")), u.out.join("\n"));
});

test("uninstall across apps: one question and one diff restore both; with one app installed there is no question", async (t) => {
  const { deps, runs } = await env(t);
  const root = mono();
  gitInit(root);
  assert.equal(await main(["--yes", "--no-vercel", "--app", "apps/web", "--app", "apps/shop", ...BASE], deps(root, { ui: ui().ui })), 0);
  markInstalled(root, ["web", "shop"]);
  commitAll(root, "installed");
  runs.length = 0;
  const u = ui();
  assert.equal(await main(["uninstall", "--yes"], deps(root, { ui: u.ui })), 0, u.out.join("\n"));
  assert.deepEqual(u.asked, ["Which apps should Parlox be removed from?"]);
  for (const app of ["web", "shop"]) {
    assert.doesNotMatch(read(root, `apps/${app}/app/layout.tsx`), /Parlox/);
    assert.equal(read(root, `apps/${app}/proxy.js`), null);
    assert.equal(read(root, `apps/${app}/.env.local`), null);
  }
  assert.deepEqual(runs.map((r) => [r.cwd, ...r.args]), [
    [join(root, "apps", "shop"), "uninstall", "@parlox/browser", "@parlox/server"],
    [join(root, "apps", "web"), "uninstall", "@parlox/browser", "@parlox/server"],
  ]);

  const one = mono();
  gitInit(one);
  assert.equal(await main(["--yes", "--no-vercel", "--app", "apps/web", ...BASE], deps(one, { ui: ui().ui })), 0);
  markInstalled(one, ["web"]);
  commitAll(one, "installed");
  const v = ui();
  assert.equal(await main(["uninstall", "--yes"], deps(one, { ui: v.ui })), 0, v.out.join("\n"));
  assert.deepEqual(v.asked, [], "only one app has Parlox: no question");
  assert.doesNotMatch(read(one, "apps/web/app/layout.tsx"), /Parlox/);
});

test("--url with several apps that have a server part is refused before sign-in", async (t) => {
  const { auth, deps } = await env(t);
  const root = mono();
  gitInit(root);
  const u = ui();
  assert.equal(await main(["--yes", "--no-vercel", "--site", "shop.example.com", "--url", "http://localhost:3000", "--app", "apps/web", "--app", "apps/shop"], deps(root, { ui: u.ui })), 1);
  assert.ok(u.out.some((m) => m.startsWith("WARN --url names one local address")), u.out.join("\n"));
  assert.equal(auth.tokenRequests.length, 0);
});

test("--app naming a folder with no app is refused, listing the apps found", async (t) => {
  const { deps } = await env(t);
  const root = mono();
  gitInit(root);
  const u = ui();
  assert.equal(await main(["--yes", "--app", "apps/admin", ...BASE], deps(root, { ui: u.ui })), 1);
  assert.ok(u.out.includes("WARN --app apps/admin: no app the wizard supports there. Apps found: apps/shop, apps/web."), u.out.join("\n"));
});

test("key names: folder · host · production, at most 71 characters, keeping the end of a long folder", () => {
  assert.equal(keyLabel("apps/web", "Vercel"), "apps/web · Vercel · production");
  const label = keyLabel("packages/" + "x".repeat(80) + "/storefront", "Cloudflare");
  assert.ok(label.length <= 71, label);
  assert.ok(label.endsWith("/storefront · Cloudflare · production"));
  const netlify = { id: "netlify", label: "Netlify", where: "", docs: null, vercelDir: null };
  assert.equal(handoffUrl("https://app.parlox.io", "s 1", netlify), "https://app.parlox.io/sites/s%201?newKey=Netlify%20%C2%B7%20production&scope=fetch#keys");
  assert.equal(handoffUrl("https://app.parlox.io", "s1", netlify, "web · Netlify · production"), "https://app.parlox.io/sites/s1?newKey=web%20%C2%B7%20Netlify%20%C2%B7%20production&scope=fetch#keys");
});

test("the full screen keeps every hand-off for the summary it prints when it closes", () => {
  const s = new WizardStore();
  s.handoff({ host: "Netlify (for web)", url: null, where: "w", docs: null, variables: ["PARLOX_VERIFY_TOKEN=vt"] });
  s.handoff({ host: "Fly.io (for api)", url: null, where: "w", docs: null, variables: ["PARLOX_VERIFY_TOKEN=vt"] });
  assert.equal(s.getSnapshot().handoff.host, "Fly.io (for api)", "the screen shows the latest");
  const text = summary(s.getSnapshot(), 0);
  assert.match(text, /Set on Netlify \(for web\):/);
  assert.match(text, /Set on Fly\.io \(for api\):/);
});

// A UI that cannot ask the multi-select (a scripted one without it) is refused the
// question at once, as a face with no terminal is, with what to pass instead; nothing is signed in to.
test("a UI without multiselect, several apps: refused at once, naming --app; no sign-in", async (t) => {
  const { auth, deps } = await env(t);
  const root = mono();
  gitInit(root);
  const out = [];
  const basic = { info: (m) => out.push(m), warn: (m) => out.push(`WARN ${m}`), confirm: async () => true, select: async (_m, o) => o[0].value, text: async () => "" };
  assert.equal(await main(["--yes", "--no-vercel", ...BASE], deps(root, { ui: basic })), 1);
  assert.ok(out.includes("WARN No terminal to answer: Which apps should Parlox be installed in? Run it from the app's own folder, or pass --app <folder> for each app to include (apps/shop, apps/web)."), out.join("\n"));
  assert.equal(auth.tokenRequests.length, 0);
  assert.equal(read(root, "apps/web/app/layout.tsx"), layout);
});

test("--dry-run across apps: one diff, and nothing is written, installed or created", async (t) => {
  const { runs, gw, deps } = await env(t);
  const root = mono();
  gitInit(root);
  const u = ui();
  assert.equal(await main(["--dry-run", ...BASE], deps(root, { ui: u.ui })), 0, u.out.join("\n"));
  assert.ok(u.out.some((m) => m.includes("+++ b/apps/web/proxy.js") && m.includes("+++ b/apps/shop/proxy.js")));
  assert.equal(read(root, "apps/web/app/layout.tsx"), layout);
  assert.equal(read(root, "apps/shop/proxy.js"), null);
  assert.deepEqual(runs, []);
  assert.equal(gw.calls.some((c) => c.method === "POST"), false);
  assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }), "");
});

// After the apply, every early end says the host is not connected and hands off what to set, for each app.
test("an install that fails: the installs left are named, then the host warning and a hand-off for each app", async (t) => {
  const { deps } = await env(t);
  const root = mono({ "apps/web/netlify.toml": "", "apps/shop/fly.toml": "" });
  gitInit(root);
  const u = ui();
  const run = (_cmd, _args, opts) => ({ status: opts.cwd.endsWith("web") ? 1 : 0, stdout: "", stderr: "" });
  assert.equal(await main(["--yes", "--no-vercel", ...BASE], deps(root, { ui: u.ui, run })), 1);
  const failed = u.out.indexOf(`WARN The package manager reported an error. Run it yourself in apps/web: ${INSTALL}`);
  const host = u.out.findIndex((m) => m.startsWith("WARN Stopped before your host was connected."));
  assert.ok(failed >= 0 && host > failed, u.out.join("\n"));
  const handoffs = u.out.slice(host).filter((m) => m.startsWith("Connect your host"));
  assert.deepEqual(handoffs.map((m) => m.split("\n")[1]), ["Set on Fly.io (for apps/shop):", "Set on Netlify (for apps/web):"]);
  assert.equal(u.out.some((m) => m.includes("did not run")), false, "nothing was left after it");

  // A failure in the first app: the install of the app after it is named, with the command that finishes it.
  const first = mono({ "apps/web/netlify.toml": "", "apps/shop/fly.toml": "" });
  gitInit(first);
  const v = ui();
  const runs = [];
  const failShop = (_cmd, _args, opts) => { runs.push(opts.cwd); return { status: opts.cwd.endsWith("shop") ? 1 : 0, stdout: "", stderr: "" }; };
  assert.equal(await main(["--yes", "--no-vercel", ...BASE], deps(first, { ui: v.ui, run: failShop })), 1);
  assert.deepEqual(runs, [join(first, "apps", "shop")], "no install after the failed one");
  const shop = v.out.indexOf(`WARN The package manager reported an error. Run it yourself in apps/shop: ${INSTALL}`);
  const web = v.out.indexOf(`WARN The package install did not run in apps/web; run it yourself: ${INSTALL}`);
  const hostLine = v.out.findIndex((m) => m.startsWith("WARN Stopped before your host was connected."));
  assert.ok(shop >= 0 && web > shop && hostLine > web, v.out.join("\n"));
  assert.match(read(first, "apps/web/app/layout.tsx"), /ParloxAnalytics/, "every app's files were written before the installs");
});

test("--local-key across apps: a key per app, named for this computer and the folder, in each app's env file, owner-only", async (t) => {
  const { gw, deps } = await env(t);
  const root = mono();
  gitInit(root);
  const u = ui();
  assert.equal(await main(["--yes", "--no-vercel", "--local-key", "--app", "apps/web", "--app", "apps/shop", ...BASE], deps(root, { ui: u.ui })), 0, u.out.join("\n"));
  assert.equal(gw.state.keys.length, 2);
  assert.match(gw.state.keys[0], /^local dev · .+ · apps\/web$/);
  assert.match(gw.state.keys[1], /^local dev · .+ · apps\/shop$/);
  for (const app of ["web", "shop"]) {
    assert.match(read(root, `apps/${app}/.env.local`), /^PARLOX_VERIFY_TOKEN=vt_fake\nPARLOX_SECRET_KEY=sk_parlox_d{64}\n$/);
    if (process.platform !== "win32") assert.equal(statSync(join(root, "apps", app, ".env.local")).mode & 0o777, 0o600);
  }
  assert.equal(u.out.some((m) => m.includes("sk_parlox_")), false, "the key is never printed");
  if (process.platform !== "win32") assert.match(u.out.at(-1), /apps\/web\/\.env\.local is now readable only by you: it holds the local key\.\napps\/shop\/\.env\.local is now readable only by you/);
});

// The apps the wizard refused beside the ones it found are named in the review and in
// the report, and still in the review when nothing else changes.
test("an app the wizard cannot install into, beside others: named in the review and the report, even when nothing changes", async (t) => {
  const { deps } = await env(t);
  const root = mono({ "apps/legacy/package.json": pkg({ next: "12.3.4", react: "18.2.0" }), "apps/legacy/app/layout.tsx": layout });
  gitInit(root);
  const note = "apps/legacy is not included: Next.js 12 is not supported by the wizard (13 or later). See https://gateway.parlox.io/install.md";
  const u = ui();
  let offered = [];
  assert.equal(await main(["--yes", "--no-vercel", ...BASE], deps(root, { ui: { ...u.ui, multiselect: async (_m, o) => { offered = o.map((x) => x.value); return offered; } } })), 0, u.out.join("\n"));
  assert.deepEqual(offered, ["apps/shop", "apps/web"]);
  assert.ok(u.out.includes(`WARN ${note}`), u.out.join("\n"));
  assert.ok(u.out.at(-1).split("\n").includes(note), u.out.at(-1));
  assert.equal(read(root, "apps/legacy/app/layout.tsx"), layout);

  markInstalled(root, ["web", "shop"]);
  commitAll(root, "installed");
  const again = ui();
  assert.equal(await main(["--yes", "--no-vercel", ...BASE], deps(root, { ui: again.ui })), 0, again.out.join("\n"));
  const nothing = again.out.indexOf("Parlox is already installed in these apps. Nothing to change.");
  assert.ok(nothing >= 0 && again.out.indexOf(`WARN ${note}`) > nothing, again.out.join("\n"));
});

test("one app found beside one the wizard cannot install into: no question, the old single-app names, the other app named", async (t) => {
  const { deps } = await env(t);
  const root = fixture({
    "package.json": JSON.stringify({ name: "mono", private: true, workspaces: ["apps/*"] }), "package-lock.json": "{}", ".gitignore": ".env*.local\n",
    "apps/web/package.json": pkg(), "apps/web/app/layout.tsx": layout, "apps/web/netlify.toml": "",
    "apps/legacy/package.json": pkg({ next: "12.3.4", react: "18.2.0" }), "apps/legacy/app/layout.tsx": layout,
  });
  gitInit(root);
  const u = ui();
  assert.equal(await main(["--no-vercel", ...BASE], deps(root, { ui: u.ui })), 0, u.out.join("\n"));
  assert.deepEqual(u.asked, ["Apply these changes to apps/web?"]);
  assert.ok(u.out.includes("WARN apps/legacy is not included: Next.js 12 is not supported by the wizard (13 or later). See https://gateway.parlox.io/install.md"), u.out.join("\n"));
  assert.ok(u.out.some((m) => m.includes("Set on Netlify:") && m.includes("newKey=Netlify%20%C2%B7%20production")));
  assert.match(u.out.at(-1), /^Server part: not checked\.\nBrowser part: added to your code/);
});

test("uninstall where no app has Parlox: nothing to choose, nothing to remove", async (t) => {
  const { deps, runs } = await env(t);
  const root = mono();
  gitInit(root);
  const u = ui();
  assert.equal(await main(["uninstall", "--yes"], deps(root, { ui: u.ui })), 0, u.out.join("\n"));
  assert.deepEqual(u.asked, []);
  assert.ok(u.out.includes("Nothing from Parlox was found to remove."), u.out.join("\n"));
  assert.deepEqual(runs, []);
});

test("coverage notes: refused apps by folder (the start folder by its name, never \".\"); what another integration refused inside an app, by folder when there are several", () => {
  const unit = (rel, warnings) => ({ rel, warnings, dir: rel === "." ? "/work/mono" : `/work/mono/${rel}`, root: "/work/mono", detections: [], browser: null, server: null });
  const problems = [{ rel: "apps/old", error: new Error("Next.js 12 is not supported.") }, { rel: ".", error: new Error("No entry.") }];
  const several = [unit("apps/web", ["Express: NestJS is not supported."]), unit("apps/shop", [])];
  assert.deepEqual(coverageNotes(problems, several, runNames(several, "/work/mono")), [
    "apps/old is not included: Next.js 12 is not supported.", "mono is not included: No entry.", "apps/web: Express: NestJS is not supported.",
  ]);
  const one = [unit(".", ["Express: NestJS is not supported."])];
  assert.deepEqual(coverageNotes([], one, runNames(one, "/work/mono")), ["Express: NestJS is not supported."]);
});

// Any env file the wizard creates is owner-only, in any app folder and whatever its name
// (.env for Express and Hono), and a key written into one goes through the atomic owner-only write.
test("env files: every name the wizard writes counts, in any folder; created owner-only; a key written into .env ends owner-only", { skip: process.platform === "win32" }, () => {
  for (const p of [".env", ".env.local", ".env.development", ".env.production.local", "apps/api/.env", "apps/web/.env.local"]) assert.equal(isEnvFile(p), true, p);
  for (const p of [".envrc", "env.ts", "src/.environment", ".env.local.bak~", "apps/web/.gitignore"]) assert.equal(isEnvFile(p), false, p);
  const dir = fixture({ "package.json": "{}" });
  applyPlan(dir, { changes: [{ path: ".env", before: null, after: "A=1\n" }, { path: "apps/api/.env", before: null, after: "A=1\n" }, { path: "apps/api/index.js", before: null, after: "x\n" }], install: null, manual: [], warnings: [] });
  assert.equal(statSync(join(dir, ".env")).mode & 0o777, 0o600);
  assert.equal(statSync(join(dir, "apps/api/.env")).mode & 0o777, 0o600);
  assert.notEqual(statSync(join(dir, "apps/api/index.js")).mode & 0o777, 0o600);
  const kept = fixture({ ".env": "OTHER=1\n" });
  chmodSync(join(kept, ".env"), 0o644);
  writeSecretInside(kept, ".env", "OTHER=1\nPARLOX_SECRET_KEY=x\n");
  assert.equal(statSync(join(kept, ".env")).mode & 0o777, 0o600);
  assert.equal(read(kept, ".env"), "OTHER=1\nPARLOX_SECRET_KEY=x\n");
});

test("an empty purpose falls back to the one the file name gives, as the full screen does", () => {
  const [row] = summarizeChanges({ changes: [{ path: "apps/web/app/layout.tsx", before: "a\n", after: "b\n", purpose: "" }], install: null, manual: [], warnings: [] });
  assert.equal(row.purpose, "browser part");
});

// Each app's plan is written in the folder it was read from: a workspace app that is a symlink to a folder inside the
// repository (allowed by the workspace scan) is installed as it would be from its own folder.
test("a workspace app linked to a folder inside the repository: written through its own folder, like a run started there", { skip: process.platform === "win32" }, async (t) => {
  const { symlinkSync } = await import("node:fs");
  const { deps } = await env(t);
  const root = mono({ "packages/store/package.json": pkg(), "packages/store/app/layout.tsx": layout });
  symlinkSync(join(root, "packages", "store"), join(root, "apps", "store"), "dir");
  gitInit(root);
  const u = ui();
  assert.equal(await main(["--yes", "--no-vercel", "--app", "apps/store", "--app", "apps/web", ...BASE], deps(root, { ui: u.ui })), 0, u.out.join("\n"));
  assert.match(read(root, "packages/store/app/layout.tsx"), /ParloxAnalytics/);
  assert.match(read(root, "apps/web/app/layout.tsx"), /ParloxAnalytics/);
});

// Folder names now reach the facts, the review, the task lines and the report: the plain face writes their control
// characters out, as the full screen does (as for the question's labels).
test("the plain face writes out control characters in what it prints, a folder name included", async () => {
  const { Writable } = await import("node:stream");
  let text = "";
  const out = new Writable({ write(c, _e, cb) { text += c.toString(); cb(); } });
  out.isTTY = false; out.columns = 100;
  const face = plainUi(out, undefined, { isTTY: false });
  const rel = "apps/we\u001b]0;owned\u0007b";
  face.fact("App", `${rel}/ · Next.js`);
  face.info(`Parlox is in ${rel}`);
  face.warn(`${rel}: a note`);
  face.task("install", "active", `Installing @parlox/browser in ${rel}`);
  face.changes({ changes: [{ path: `${rel}/a.txt`, before: null, after: "x\n" }], install: null, installs: [{ dir: rel, command: "npm", args: ["install"] }], manual: [], warnings: [`${rel}: note`] }, rel, "install");
  face.report([`Server part (${rel}): not checked.`], "Parlox is installed");
  assert.equal(text.includes("\u001b]0;owned"), false, JSON.stringify(text));
  assert.equal(text.split("we^[]0;owned^Gb").length - 1 >= 7, true, text);
});

// A stop during one app's host step: the next app's host step does not start (not even its Vercel CLI checks); the
// early end names only what is still to set, not the hand-off already shown.
test("a stop after the first app's hand-off: the next app's host step never starts, and only its hand-off follows", async (t) => {
  const { runs, deps } = await env(t);
  const root = mono({ "apps/shop/fly.toml": "", "apps/web/.vercel/project.json": JSON.stringify({ projectName: "web-prod" }) });
  gitInit(root);
  const stop = new AbortController();
  const u = ui();
  const face = { ...u.ui, handoff: (h) => { u.out.push(`HANDOFF ${h.host}`); if (h.host.includes("apps/shop")) stop.abort(); } };
  assert.equal(await main(["--yes", "--vercel", ...BASE], deps(root, { ui: face, signal: stop.signal })), 130, u.out.join("\n"));
  assert.equal(runs.some((r) => r.cmd === "vercel"), false, JSON.stringify(runs));
  const host = u.out.findIndex((m) => m.startsWith("WARN Stopped before your host was connected."));
  assert.deepEqual(u.out.filter((m) => m.startsWith("HANDOFF")), ["HANDOFF Fly.io (for apps/shop)", "HANDOFF Vercel (for apps/web)"]);
  assert.ok(host >= 0 && u.out.indexOf("HANDOFF Fly.io (for apps/shop)") < host && u.out.indexOf("HANDOFF Vercel (for apps/web)") > host, u.out.join("\n"));
});

test("the full screen: one package step per app in the review; a run with only package steps counts as changed when it closes", () => {
  const s = new WizardStore();
  s.step("review", "active");
  s.changes({ changes: [], install: null, installs: [{ dir: "apps/shop", command: "npm", args: ["install", "x@1"] }, { dir: "apps/web", command: "npm", args: ["install", "x@1"] }], manual: [], warnings: [] }, "mono", "install");
  const { lastFrame, unmount } = render(createElement(Review, { state: s.getSnapshot(), width: 100, rows: 30 }));
  assert.match(lastFrame(), /Will run in apps\/shop: npm install x@1\n.*Will run in apps\/web: npm install x@1/s);
  unmount();
  s.step("review", "done");
  assert.match(summary(s.getSnapshot(), 1), /Stopped\. The changes already applied stay\.\n$/);
});

// ---- Writes that fail, before the first write and after it ----

const canChmod = process.platform !== "win32" && process.getuid?.() !== 0;
const readOnly = (root, rel) => { chmodSync(join(root, rel), 0o444); };

// A gateway in front of the fake one that answers the Nth key POST with 409, as the real one does when a site has
// its 20 active keys (or 429 past its rate limit).
async function failingKeys(t, gwUrl, failAt) {
  let n = 0;
  const server = createServer(async (req, res) => {
    let raw = ""; for await (const c of req) raw += c;
    if (req.method === "POST" && /\/keys$/.test(req.url) && ++n === failAt) {
      res.writeHead(409, { "content-type": "application/json" }).end(JSON.stringify({ error: "A site can have at most 20 active keys. Revoke one first." }));
      return;
    }
    const r = await fetch(gwUrl + req.url, { method: req.method, headers: { authorization: req.headers.authorization ?? "", "content-type": "application/json" }, body: ["GET", "HEAD"].includes(req.method) ? undefined : raw });
    res.writeHead(r.status, { "content-type": "application/json" }).end(await r.text());
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => { server.closeAllConnections?.(); server.close(); });
  return `http://127.0.0.1:${server.address().port}`;
}

test("a target that cannot be written, in any app: refused before anything is written", { skip: !canChmod }, async (t) => {
  const { runs, deps } = await env(t);
  const root = mono({ "apps/web/netlify.toml": "", "apps/shop/fly.toml": "" });
  gitInit(root);
  // The file becomes read-only after the Yes, before the writes.
  const u = ui({ confirm: () => { readOnly(root, "apps/web/app/layout.tsx"); return true; } });
  t.after(() => chmodSync(join(root, "apps/web/app/layout.tsx"), 0o644));
  assert.equal(await main(["--no-vercel", ...BASE], deps(root, { ui: u.ui })), 1);
  assert.equal(read(root, "apps/shop/app/layout.tsx"), layout, "the app before it is not written either");
  assert.equal(read(root, "apps/shop/proxy.js"), null);
  assert.deepEqual(runs, []);
  const refusal = u.out.find((m) => m.startsWith("WARN Cannot write"));
  assert.ok(refusal && refusal.includes("apps/web/app/layout.tsx") && /Nothing was changed/.test(refusal), u.out.join("\n"));
  assert.equal(u.out.some((m) => m.includes("Stopped before your host was connected")), false, "nothing was written, so there is nothing to connect");

  // Uninstall goes through the same check.
  const other = mono();
  gitInit(other);
  assert.equal(await main(["--yes", "--no-vercel", ...BASE], deps(other, { ui: ui().ui })), 0);
  markInstalled(other, ["web", "shop"]);
  commitAll(other, "installed");
  const before = read(other, "apps/shop/app/layout.tsx");
  const v = ui({ confirm: () => { readOnly(other, "apps/web/app/layout.tsx"); return true; } });
  t.after(() => chmodSync(join(other, "apps/web/app/layout.tsx"), 0o644));
  assert.equal(await main(["uninstall"], deps(other, { ui: v.ui })), 1);
  assert.equal(read(other, "apps/shop/app/layout.tsx"), before);
  assert.ok(v.out.some((m) => m.startsWith("WARN Cannot write") && m.includes("apps/web/app/layout.tsx")), v.out.join("\n"));
});

test("a write that fails after the check: the apps written are named, then every package command not run, then the host", { skip: !canChmod }, async (t) => {
  const { runs, deps } = await env(t);
  const root = mono({ "apps/web/netlify.toml": "", "apps/shop/fly.toml": "" });
  gitInit(root);
  const u = ui();
  // Injected after the check: once the first file has landed (in apps/shop), apps/web's layout becomes read-only.
  let injected = false;
  const face = { ...u.ui, step: (id, status) => { if (id === "review" && status === "done" && !injected) { injected = true; readOnly(root, "apps/web/app/layout.tsx"); } } };
  t.after(() => chmodSync(join(root, "apps/web/app/layout.tsx"), 0o644));
  assert.equal(await main(["--yes", "--no-vercel", ...BASE], deps(root, { ui: face })), 1);
  assert.match(read(root, "apps/shop/app/layout.tsx"), /ParloxAnalytics/);
  assert.equal(read(root, "apps/web/app/layout.tsx"), layout);
  assert.deepEqual(runs, [], "no install ran");
  const failed = u.out.findIndex((m) => m.startsWith("WARN Could not write apps/web/app/layout.tsx"));
  assert.ok(failed >= 0, u.out.join("\n"));
  assert.match(u.out[failed], /Changed: apps\/shop\. Not changed: apps\/web\./);
  // apps/web got none of its changes: no package command and no hand-off for it (no key for an app with no Parlox
  // code), and it is told to run the wizard again.
  const shop = u.out.indexOf(`WARN The package install did not run in apps/shop; run it yourself: ${INSTALL}`);
  const web = u.out.indexOf("WARN Run the wizard again for apps/web (npx parlox init --app apps/web): none of its changes were written.");
  const host = u.out.findIndex((m) => m.startsWith("WARN Stopped before your host was connected."));
  assert.ok(shop > failed && web > shop && host > web, u.out.join("\n"));
  assert.equal(u.out.some((m) => m.startsWith("WARN The package install did not run in apps/web")), false);
  assert.equal(u.out.filter((m) => m.startsWith("Connect your host")).length, 1);
});

test("a key the gateway refuses for one app: that app is handed off, the others are set, and the run goes on", async (t) => {
  const { gw, runs, deps } = await env(t);
  const root = mono({ "apps/web/.vercel/project.json": JSON.stringify({ projectName: "web-prod" }), "apps/shop/.vercel/project.json": JSON.stringify({ projectName: "shop-prod" }) });
  gitInit(root);
  const gateway = await failingKeys(t, gw.url, 2);
  const u = ui();
  const d = deps(root, { ui: u.ui });
  assert.equal(await main(["--yes", "--vercel", "--app", "apps/web", "--app", "apps/shop", "--site", "shop.example.com"], { ...d, config: { ...d.config, gateway } }), 0, u.out.join("\n"));
  assert.deepEqual(gw.state.keys, ["apps/web · Vercel · production"]);
  const adds = runs.filter((r) => r.cmd === "vercel" && r.args[1] === "add" && r.args[2] !== "--help").map((r) => [basename(r.cwd), r.args[2]]);
  assert.deepEqual(adds, [["web", "PARLOX_SECRET_KEY"], ["web", "PARLOX_VERIFY_TOKEN"], ["shop", "PARLOX_VERIFY_TOKEN"]]);
  assert.ok(u.out.some((m) => m.startsWith("WARN Could not create a key for apps/shop (A site can have at most 20 active keys. Revoke one first.)")), u.out.join("\n"));
  const handoff = u.out.filter((m) => m.startsWith("Connect your host"));
  assert.equal(handoff.length, 1);
  assert.match(handoff[0], /Set on Vercel \(for apps\/shop\):\n  PARLOX_SECRET_KEY/);
  assert.doesNotMatch(handoff[0], /PARLOX_VERIFY_TOKEN=/, "the token was set");
  const report = u.out.at(-1);
  assert.match(report, /Server part \(apps\/web\): not checked\./);
  assert.match(report, /Server part \(apps\/shop\): not checked\./);
});

test("an app at the start folder, beside others: named by its folder's name everywhere, never \".\"", async (t) => {
  const { gw, deps } = await env(t);
  const root = fixture({
    "package.json": JSON.stringify({ name: "mono", private: true, workspaces: ["apps/*"], dependencies: { next: "16.0.1", react: "19.0.0" } }), "package-lock.json": "{}", ".gitignore": ".env*.local\n",
    "app/layout.tsx": layout, "netlify.toml": "", "apps/web/package.json": pkg(), "apps/web/app/layout.tsx": layout, "apps/web/netlify.toml": "",
  });
  gitInit(root);
  const name = basename(root);
  const u = ui();
  assert.equal(await main(["--yes", "--no-vercel", "--local-key", ...BASE], deps(root, { ui: u.ui })), 0, u.out.join("\n"));
  const text = u.out.join("\n");
  for (const bad of ["(for .)", " · . ·", "(.)", "in .:", "./.env.local", " · .\n", ". · "]) assert.equal(text.includes(bad), false, `${bad}\n${text}`);
  assert.ok(u.out.includes(`Will run in ${name}: ${INSTALL}`), text);
  assert.ok(u.out.some((m) => m.includes(`Set on Netlify (for ${name}):`) && m.includes(`newKey=${encodeURIComponent(`${name} · Netlify · production`)}`)), text);
  assert.ok(gw.state.keys.some((k) => new RegExp(`^local dev · .+ · ${name}$`).test(k)), JSON.stringify(gw.state.keys));
  assert.match(u.out.at(-1), new RegExp(`Server part \\(${name}\\): not checked\\.`));
  if (process.platform !== "win32") assert.match(u.out.at(-1), /^\.env\.local is now readable only by you/m);
});

test("--local-key in a run with several apps: every message names the app's own file", async (t) => {
  const { deps } = await env(t);
  const root = mono();
  gitInit(root);
  const u = ui();
  assert.equal(await main(["--yes", "--no-vercel", "--local-key", "--app", "apps/web", "--app", "apps/shop", ...BASE], deps(root, { ui: u.ui })), 0, u.out.join("\n"));
  assert.ok(u.out.some((m) => m.startsWith("WARN A separate key") && m.includes("is in apps/web/.env.local for local development")), u.out.join("\n"));
  assert.ok(u.out.some((m) => m.startsWith("WARN A separate key") && m.includes("is in apps/shop/.env.local for local development")));
  const again = ui();
  assert.equal(await main(["--yes", "--no-vercel", "--local-key", "--allow-dirty", "--app", "apps/web", "--app", "apps/shop", ...BASE], deps(root, { ui: again.ui })), 0);
  assert.ok(again.out.includes("PARLOX_SECRET_KEY is already in apps/web/.env.local; no new local key was created. To replace it, revoke the old key in Settings → Keys, delete that line, and run again with --local-key."), again.out.join("\n"));
});

test("two workspace entries for one real folder (a symlink both globs reach): one app, one install, one key", { skip: process.platform === "win32" }, async (t) => {
  const { runs, deps } = await env(t);
  const root = fixture({ "package.json": JSON.stringify({ name: "mono", private: true, workspaces: ["apps/*", "packages/*"] }), "package-lock.json": "{}", ".gitignore": ".env*.local\n", "packages/store/package.json": pkg(), "packages/store/app/layout.tsx": layout });
  mkdirSync(join(root, "apps"));
  symlinkSync(join(root, "packages", "store"), join(root, "apps", "store"), "dir");
  gitInit(root);
  const u = ui();
  assert.equal(await main(["--yes", "--no-vercel", ...BASE], deps(root, { ui: u.ui })), 0, u.out.join("\n"));
  assert.deepEqual(u.asked, [], "one app: no question");
  assert.deepEqual(runs.map((r) => r.cwd), [join(root, "packages", "store")]);
  assert.equal(read(root, "packages/store/app/layout.tsx").match(/<ParloxAnalytics/g).length, 1);
  assert.equal(u.out.filter((m) => m.startsWith("Connect your host")).length, 1);
  // Named by the link, it is the same app.
  const again = ui();
  assert.equal(await main(["--yes", "--no-vercel", "--allow-dirty", "--app", "apps/store", ...BASE], deps(root, { ui: again.ui })), 0, again.out.join("\n"));
  assert.ok(again.out.includes("Parlox is already installed in this app. Nothing to change.") || again.out.some((m) => m.startsWith("Will run")), again.out.join("\n"));
});

test("an app folder whose link is moved out of the repository after the scan: refused at the apply, nothing written", { skip: process.platform === "win32" }, async (t) => {
  const { runs, deps } = await env(t);
  const outside = fixture({ "package.json": pkg(), "app/layout.tsx": layout });
  const root = mono({ "packages/store/package.json": pkg(), "packages/store/app/layout.tsx": layout });
  symlinkSync(join(root, "packages", "store"), join(root, "apps", "store"), "dir");
  gitInit(root);
  const u = ui({ confirm: () => { unlinkSync(join(root, "apps", "store")); symlinkSync(outside, join(root, "apps", "store"), "dir"); return true; } });
  assert.equal(await main(["--no-vercel", "--app", "apps/store", "--app", "apps/web", ...BASE], deps(root, { ui: u.ui })), 1);
  assert.equal(read(outside, "app/layout.tsx"), layout, "nothing written outside the repository");
  assert.equal(read(root, "apps/web/app/layout.tsx"), layout, "nor in the other app");
  assert.deepEqual(runs, []);
  assert.ok(u.out.some((m) => m.startsWith("WARN") && m.includes("apps/store") && /outside the repository/.test(m) && /Nothing was changed/.test(m)), u.out.join("\n"));
  rmSync(join(root, "apps", "store"));
});

test("the plain face keeps the tabs of a paste-in snippet", async () => {
  const { Writable } = await import("node:stream");
  let text = "";
  const out = new Writable({ write(c, _e, cb) { text += c.toString(); cb(); } });
  out.isTTY = false; out.columns = 100;
  plainUi(out, undefined, { isTTY: false }).changes({ changes: [], install: null, manual: [{ file: "app/layout.tsx", reason: "It could not be edited safely.", snippet: "<ParloxAnalytics>\n\t<Page />\n</ParloxAnalytics>" }], warnings: [] }, "shop", "install");
  assert.ok(text.includes("\t<Page />"), JSON.stringify(text));
});

test("one app: a target that cannot be written is refused by the same check, before anything is written", { skip: !canChmod }, async (t) => {
  const { runs, deps } = await env(t);
  const dir = fixture({ "package.json": pkg(), "package-lock.json": "{}", "app/layout.tsx": layout, ".gitignore": ".env*.local\n", ".env.local": "OTHER=1\n" });
  gitInit(dir);
  readOnly(dir, ".env.local");
  t.after(() => chmodSync(join(dir, ".env.local"), 0o644));
  const u = ui();
  assert.equal(await main(["--yes", "--no-vercel", ...BASE], deps(dir, { ui: u.ui })), 1);
  assert.ok(u.out.includes("WARN Cannot write .env.local (permission denied). Nothing was changed: fix that, then run the wizard again."), u.out.join("\n"));
  assert.equal(read(dir, "app/layout.tsx"), layout, "the layout, before it in the plan, is not written");
  assert.equal(read(dir, "proxy.js"), null);
  assert.deepEqual(runs, []);
});

test("uninstall across apps: each app's removal is planned once, and that plan is the one reviewed and applied", async (t) => {
  const { deps } = await env(t);
  const root = mono();
  gitInit(root);
  assert.equal(await main(["--yes", "--no-vercel", "--app", "apps/web", "--app", "apps/shop", ...BASE], deps(root, { ui: ui().ui })), 0);
  markInstalled(root, ["web", "shop"]);
  commitAll(root, "installed");
  const unplan = t.mock.method(INTEGRATIONS.find((i) => i.id === "nextjs"), "unplan");
  const u = ui();
  assert.equal(await main(["uninstall", "--yes"], deps(root, { ui: u.ui })), 0, u.out.join("\n"));
  assert.equal(unplan.mock.callCount(), 2, "one plan per app");
  assert.deepEqual(unplan.mock.calls.map((c) => basename(c.arguments[0].dir)).sort(), ["shop", "web"]);
  for (const app of ["web", "shop"]) assert.doesNotMatch(read(root, `apps/${app}/app/layout.tsx`), /Parlox/);
});
