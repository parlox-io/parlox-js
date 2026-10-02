import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { main } from "../dist/cli.js";
import { GatewayClient, KeyScopeError } from "../dist/api.js";
import { startFakeAuth, startFakeGateway } from "./fake-servers.mjs";
import { fixture, pkg, read } from "./helpers.mjs";

// Every key the wizard sets is "Crawler reports only" (scope "fetch"): the gateway decides it, and the wizard checks
// the answer. A key with any other scope (an older gateway, say) is never used, and the developer is told to revoke it.

const layout = `export default function RootLayout({ children }) {\n  return (\n    <html>\n      <body>{children}</body>\n    </html>\n  );\n}\n`;
const SITE = { id: "11111111-1111-1111-1111-111111111111", name: "Shop", domain: "shop.example.com", public_key: "pk_" + "a1".repeat(12), verified: false };
const VALUE = "sk_parlox_" + "d".repeat(64);
const G = ["-c", "user.email=t@t", "-c", "user.name=t"];
const gitInit = (dir) => { execFileSync("git", [...G, "init", "-q"], { cwd: dir }); execFileSync("git", [...G, "add", "-A"], { cwd: dir }); execFileSync("git", [...G, "commit", "-qm", "init"], { cwd: dir }); };

async function env(t, keyScope) {
  const auth = await startFakeAuth({ decide: "approve" });
  const gw = await startFakeGateway({ sites: [{ ...SITE }], keys: [] }, { keyScope });
  t.after(() => { auth.close(); gw.close(); });
  const runs = [];
  const run = (cmd, args, opts) => { runs.push({ cmd, args, input: opts.input }); return { status: 0, stdout: "", stderr: "" }; };
  const config = { gateway: gw.url, supabaseUrl: auth.url, clientId: "wiz", apiKey: "test-publishable-key", ports: [53882, 53883], dashboard: "https://app.parlox.io" };
  const out = [];
  const ui = { info: (m) => out.push(m), warn: (m) => out.push(`WARN ${m}`), confirm: async () => true, select: async (_m, o) => o[0].value, text: async () => "" };
  return { gw, runs, out, deps: (dir) => ({ cwd: dir, config, ui, open: (url) => { fetch(url).catch(() => {}); }, run }) };
}

test("the gateway client refuses a key whose scope is not exactly fetch, naming the key and never its value", async (t) => {
  for (const scope of ["ingest", "full", "FETCH", null]) {
    const gw = await startFakeGateway({ sites: [{ ...SITE }], keys: [] }, { keyScope: scope });
    t.after(() => gw.close());
    const c = new GatewayClient(gw.url, "wizard-token");
    await assert.rejects(c.createKey(SITE.id, "Vercel · production"), (e) => e instanceof KeyScopeError && e.keyName === "wizard · Vercel · production" && !e.message.includes(VALUE), String(scope));
  }
  const ok = await startFakeGateway({ sites: [{ ...SITE }], keys: [] });
  t.after(() => ok.close());
  assert.equal(await new GatewayClient(ok.url, "wizard-token").createKey(SITE.id, "Vercel · production"), VALUE);
});

test("Vercel: a key that is not crawler-only is not set; the developer is told to revoke it, and the host step is a step by hand", async (t) => {
  const { gw, runs, out, deps } = await env(t, "ingest");
  const dir = fixture({ "package.json": pkg(), "package-lock.json": "{}", "app/layout.tsx": layout, ".vercel/project.json": JSON.stringify({ projectName: "shop-prod" }), ".gitignore": ".vercel\n.env*.local\n" });
  gitInit(dir);
  assert.equal(await main(["--yes", "--vercel", "--site", "shop.example.com", "--skip-check"], deps(dir)), 0, out.join("\n"));
  assert.deepEqual(gw.state.keys, ["Vercel · production"], "the gateway created it");
  assert.equal(runs.some((r) => r.args[0] === "env" && r.args[1] === "add" && r.args[2] === "PARLOX_SECRET_KEY"), false, "never sent to Vercel");
  assert.equal(runs.some((r) => (r.input ?? "").includes("sk_parlox_")), false);
  const warning = out.find((m) => m.startsWith("WARN") && m.includes('"wizard · Vercel · production"'));
  assert.ok(warning && /Revoke "wizard · Vercel · production" in Settings → Keys/.test(warning) && /"Crawler reports only"/.test(warning), out.join("\n"));
  const handoff = out.find((m) => m.startsWith("Connect your host"));
  assert.ok(handoff && /PARLOX_SECRET_KEY/.test(handoff) && /scope=fetch/.test(handoff), out.join("\n"));
  assert.ok(out.some((m) => m.includes('Vercel "shop-prod": PARLOX_SECRET_KEY not set (see above), PARLOX_VERIFY_TOKEN set.')), out.join("\n"));
  assert.equal(out.some((m) => m.includes(VALUE)), false, "the value is never printed");
});

test("--local-key: a key that is not crawler-only is not written; the developer is told to revoke it", async (t) => {
  const { gw, out, deps } = await env(t, "ingest");
  const dir = fixture({ "package.json": pkg(), "package-lock.json": "{}", "app/layout.tsx": layout, "netlify.toml": "", ".gitignore": ".env*.local\n" });
  gitInit(dir);
  assert.equal(await main(["--yes", "--no-vercel", "--local-key", "--site", "shop.example.com", "--skip-check"], deps(dir)), 0, out.join("\n"));
  assert.equal(gw.state.keys.length, 1);
  assert.match(gw.state.keys[0], /^local dev · /);
  assert.equal(read(dir, ".env.local"), "PARLOX_VERIFY_TOKEN=vt_fake\n", "no key in the env file");
  const warning = out.find((m) => m.startsWith("WARN") && m.includes(`"wizard · ${gw.state.keys[0]}"`));
  assert.ok(warning && /Revoke/.test(warning) && /"Crawler reports only"/.test(warning) && /Nothing was written to \.env\.local\./.test(warning), out.join("\n"));
  assert.equal(out.some((m) => m.includes(VALUE)), false);
  assert.equal(out.some((m) => /is now readable only by you/.test(m)), false);
});

// Several apps: once the gateway has answered one key with other access, it is not the version this wizard needs, and
// it would answer every key the same way. No more keys are created in the run; it is said once, and every app's key
// is a step by hand.
const threeApps = (extra = {}) => fixture({
  "package.json": JSON.stringify({ name: "mono", private: true, workspaces: ["apps/*"] }), "package-lock.json": "{}", ".gitignore": ".vercel\n.env*.local\n",
  ...Object.fromEntries(["web", "shop", "blog"].flatMap((a) => [[`apps/${a}/package.json`, pkg()], [`apps/${a}/app/layout.tsx`, layout]])), ...extra,
});
const STOPPED = /^WARN No more keys were created in this run: the gateway answered "wizard · [^"]*apps\/web[^"]*" with access other than "Crawler reports only", so it is not the version this wizard needs, and it would answer every key the same way\./;

test("several apps on Vercel: after a key that is not crawler-only, no other key is created; it is said once, and each app is handed off", async (t) => {
  const { gw, runs, out, deps } = await env(t, "ingest");
  const root = threeApps(Object.fromEntries(["web", "shop", "blog"].map((a) => [`apps/${a}/.vercel/project.json`, JSON.stringify({ projectName: `${a}-prod` })])));
  gitInit(root);
  assert.equal(await main(["--yes", "--vercel", "--app", "apps/web", "--app", "apps/shop", "--app", "apps/blog", "--site", "shop.example.com", "--skip-check"], deps(root)), 0, out.join("\n"));
  assert.deepEqual(gw.state.keys, ["apps/web · Vercel · production"], "only the first key was created");
  const revoke = out.find((m) => m.startsWith("WARN") && m.includes('Revoke "wizard · apps/web · Vercel · production" in Settings → Keys'));
  assert.ok(revoke, out.join("\n"));
  assert.equal(out.filter((m) => STOPPED.test(m)).length, 1, out.join("\n"));
  assert.equal(runs.some((r) => r.args[0] === "env" && r.args[1] === "add" && r.args[2] === "PARLOX_SECRET_KEY"), false, "no key is sent to Vercel");
  // The token is still set; the key is a step by hand for every app.
  assert.equal(runs.filter((r) => r.args[0] === "env" && r.args[1] === "add" && r.args[2] === "PARLOX_VERIFY_TOKEN").length, 3);
  const handoffs = out.filter((m) => m.startsWith("Connect your host"));
  assert.equal(handoffs.length, 3, handoffs.join("\n---\n"));
  for (const a of ["web", "shop", "blog"]) assert.ok(handoffs.some((h) => h.includes(`(for apps/${a}):\n  PARLOX_SECRET_KEY`)), `apps/${a}: ${handoffs.join("\n---\n")}`);
  assert.equal(out.some((m) => m.includes(VALUE)), false);
});

test("--local-key across apps: after a key that is not crawler-only, no other local key is created; it is said once", async (t) => {
  const { gw, out, deps } = await env(t, "ingest");
  const root = threeApps(Object.fromEntries(["web", "shop", "blog"].map((a) => [`apps/${a}/netlify.toml`, ""])));
  gitInit(root);
  assert.equal(await main(["--yes", "--no-vercel", "--local-key", "--app", "apps/web", "--app", "apps/shop", "--app", "apps/blog", "--site", "shop.example.com", "--skip-check"], deps(root)), 0, out.join("\n"));
  assert.equal(gw.state.keys.length, 1, gw.state.keys.join(", "));
  assert.match(gw.state.keys[0], /^local dev · .* · apps\/web$/);
  assert.ok(out.some((m) => m.startsWith("WARN") && m.includes(`Revoke "wizard · ${gw.state.keys[0]}" in Settings → Keys`)), out.join("\n"));
  assert.equal(out.filter((m) => STOPPED.test(m)).length, 1, out.join("\n"));
  for (const a of ["web", "shop", "blog"]) assert.equal(read(root, `apps/${a}/.env.local`), "PARLOX_VERIFY_TOKEN=vt_fake\n", `apps/${a}: no key in the env file`);
});
