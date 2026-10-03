import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { main, normaliseDomain } from "../dist/cli.js";
import { startFakeAuth, startFakeGateway } from "./fake-servers.mjs";
import { append, fixture, pkg, read } from "./helpers.mjs";

const layout = `export default function RootLayout({ children }) {\n  return (\n    <html>\n      <body>{children}</body>\n    </html>\n  );\n}\n`;
const follow = (url) => { fetch(url).catch(() => {}); };
const G = ["-c", "user.email=t@t", "-c", "user.name=t"];
const gitInit = (dir) => { execFileSync("git", [...G, "init", "-q"], { cwd: dir }); commitAll(dir, "init"); };
const commitAll = (dir, msg) => { execFileSync("git", [...G, "add", "-A"], { cwd: dir }); execFileSync("git", [...G, "commit", "-qm", msg], { cwd: dir }); };
const allFiles = (dir) => { const out = []; const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { if (e.name === ".git") continue; const p = join(d, e.name); e.isDirectory() ? walk(p) : out.push(relative(dir, p)); } }; walk(dir); return out; };
function ui(answers = {}) {
  const out = [];
  return { out, ui: { info: (m) => out.push(m), warn: (m) => out.push(`WARN ${m}`), confirm: async (m) => (answers.confirm ? answers.confirm(m) : true), select: async (_m, o) => o[0].value, text: async () => answers.text ?? "" } };
}
// Like ui(), but also records every step(id, status) call, in order, so a test can check that a step never
// stays "active" forever: every id that ever went "active" must end the run as "done", "failed" or "skipped".
function stepTracker(answers = {}) {
  const { out, ui: base } = ui(answers);
  const steps = [];
  return { out, steps, ui: { ...base, step: (id, status) => steps.push([id, status]) } };
}
function assertStepsResolved(steps, label) {
  const last = new Map();
  const everActive = new Set();
  for (const [id, status] of steps) {
    last.set(id, status);
    if (status === "active") everActive.add(id);
  }
  for (const id of everActive) {
    assert.ok(["done", "failed", "skipped"].includes(last.get(id)), `${label}: step "${id}" last recorded as "${last.get(id)}" (expected done, failed or skipped); full trace: ${JSON.stringify(steps)}`);
  }
}
async function env(t, decide = "approve", logoutStatus = 204) {
  const auth = await startFakeAuth({ decide, logoutStatus });
  const gw = await startFakeGateway({ sites: [{ id: "11111111-1111-1111-1111-111111111111", name: "Shop", domain: "shop.example.com", public_key: "pk_" + "a1".repeat(12), verified: false }], keys: [] });
  t.after(() => { auth.close(); gw.close(); });
  const runs = [];
  const run = (cmd, args, opts) => { runs.push({ cmd, args, input: opts.input }); return { status: 0, stdout: "", stderr: "" }; };
  // Real config now carries `apiKey`: Supabase's API gateway 401s the token exchange and logout without it.
  const config = { gateway: gw.url, supabaseUrl: auth.url, clientId: "wiz", apiKey: "test-publishable-key", ports: [53792, 53793], dashboard: "https://app.parlox.io" };
  return { auth, gw, runs, deps: (dir, extra = {}) => ({ cwd: dir, config, open: follow, run, ...extra }) };
}
const BASE = ["--site", "shop.example.com", "--skip-check"];

// The sign-in line (both faces print this message) offers the short loopback link; the browser gets the
// full authorize URL.
test("sign-in: the link to copy is the short loopback link; the browser is opened with the full authorize URL", async (t) => {
  const { deps } = await env(t);
  const dir = fixture({ "package.json": pkg(), "package-lock.json": "{}", "app/layout.tsx": layout, ".gitignore": ".env*.local\n" });
  gitInit(dir);
  const u = ui();
  const opened = [];
  assert.equal(await main(["--dry-run", ...BASE], deps(dir, { ui: u.ui, open: (url) => { opened.push(url); follow(url); } })), 0);
  const line = u.out.find((m) => m.startsWith("Approve access in your browser"));
  assert.match(line, /^Approve access in your browser\. If it did not open, open this link on this computer:\nhttp:\/\/127\.0\.0\.1:53792\/\?t=[A-Za-z0-9_-]{22}$/);
  assert.equal(opened.length, 1);
  assert.match(opened[0], /\/auth\/v1\/oauth\/authorize\?.*redirect_uri=http%3A%2F%2F127\.0\.0\.1%3A53792%2Fcallback/);
});

test("full install on a clean repo: files written, packages installed exactly, no secret anywhere, session ended", async (t) => {
  const { gw, auth, runs, deps } = await env(t);
  const dir = fixture({ "package.json": pkg(), "package-lock.json": "{}", "tsconfig.json": "{}", "app/layout.tsx": layout, ".gitignore": "node_modules\n.env*.local\n" });
  gitInit(dir);
  const u = ui();
  assert.equal(await main(["--yes", "--no-vercel", ...BASE], deps(dir, { ui: u.ui })), 0);
  assert.match(read(dir, "app/layout.tsx"), /<ParloxAnalytics publicKey="pk_a1/);
  assert.match(read(dir, "proxy.ts"), /withParlox\(\)/);
  assert.equal(read(dir, ".env.local"), "PARLOX_VERIFY_TOKEN=vt_fake\n");
  assert.deepEqual(runs.map((r) => [r.cmd, ...r.args]), [["npm", "install", "--save-exact", "@parlox/browser@1.0.3", "@parlox/server@1.2.0"]]);
  assert.equal(allFiles(dir).some((f) => (read(dir, f) ?? "").includes("sk_")), false, "no secret key written");
  assert.equal(gw.calls.some((c) => c.path.endsWith("/keys")), false, "no key created without Vercel");
  assert.deepEqual(auth.logouts, ["Bearer wizard-token"]);
  assert.ok(u.out.some((m) => /Server part: not checked/.test(m)));
  assert.ok(u.out.some((m) => /confirmed after you deploy/.test(m)));
});

test("uncommitted changes: refused under --yes unless --allow-dirty; nothing written", async (t) => {
  const { deps } = await env(t);
  const dir = fixture({ "package.json": pkg(), "package-lock.json": "{}", "app/layout.tsx": layout });
  gitInit(dir);
  append(dir, "app/layout.tsx", "// edit\n");
  const before = read(dir, "app/layout.tsx");
  assert.equal(await main(["--yes", "--no-vercel", ...BASE], deps(dir, { ui: ui().ui })), 1);
  assert.equal(read(dir, "app/layout.tsx"), before);
  assert.equal(await main(["--yes", "--allow-dirty", "--no-vercel", ...BASE], deps(dir, { ui: ui().ui })), 0);
});

test("not a git repository: refused under --yes unless --allow-no-git", async (t) => {
  const { deps } = await env(t);
  const dir = fixture({ "package.json": pkg(), "package-lock.json": "{}", "app/layout.tsx": layout });
  assert.equal(await main(["--yes", "--no-vercel", ...BASE], deps(dir, { ui: ui().ui })), 1);
  assert.equal(await main(["--yes", "--allow-no-git", "--no-vercel", ...BASE], deps(dir, { ui: ui().ui })), 0);
});

test("--dry-run shows the diff and writes nothing; no key, no install, no POST", async (t) => {
  const { gw, runs, deps } = await env(t);
  const dir = fixture({ "package.json": pkg(), "package-lock.json": "{}", "app/layout.tsx": layout });
  gitInit(dir);
  const u = ui();
  assert.equal(await main(["--dry-run", ...BASE], deps(dir, { ui: u.ui })), 0);
  assert.equal(read(dir, "proxy.js"), null);
  assert.equal(runs.length, 0);
  assert.ok(u.out.some((m) => m.includes("+++ b/proxy.js")));
  assert.equal(gw.calls.some((c) => c.method === "POST"), false);

  // A domain with no existing site: dry-run must never create it either.
  const u2 = ui();
  assert.equal(await main(["--dry-run", "--site", "new.example.com", "--skip-check"], deps(dir, { ui: u2.ui })), 0);
  assert.equal(gw.calls.some((c) => c.method === "POST"), false, "dry-run must not create a site");
  assert.ok(u2.out.some((m) => /No site for new\.example\.com in your account yet; run without --dry-run to create it\./.test(m)));
});

test("Vercel: asked even under --yes; with --vercel, the project is named, one key created, value only on stdin", async (t) => {
  const { gw, runs, deps } = await env(t);
  const dir = fixture({ "package.json": pkg(), "package-lock.json": "{}", "app/layout.tsx": layout, ".vercel/project.json": JSON.stringify({ projectName: "shop-prod" }), ".gitignore": ".vercel\n.env*.local\n" });
  gitInit(dir);
  const asked = [];
  await main(["--yes", ...BASE], deps(dir, { ui: ui({ confirm: (m) => { asked.push(m); return !/Vercel/.test(m); } }).ui }));
  assert.ok(asked.some((m) => /shop-prod/.test(m)), "the Vercel question names the project");
  assert.deepEqual(gw.state.keys, [], "declined: no key");
  runs.length = 0;
  const u = ui();
  assert.equal(await main(["--yes", "--vercel", "--allow-dirty", ...BASE], deps(dir, { ui: u.ui })), 0);
  assert.deepEqual(gw.state.keys, ["Vercel · production"]);
  const adds = runs.filter((r) => r.args[0] === "env" && r.args[1] === "add" && r.args[2] !== "--help");
  assert.deepEqual(adds.map((r) => r.args), [["env", "add", "PARLOX_SECRET_KEY", "production", "--sensitive"], ["env", "add", "PARLOX_VERIFY_TOKEN", "production"]]);
  assert.match(adds[0].input, /^sk_parlox_/);
  assert.equal(u.out.some((m) => m.includes("sk_parlox_")), false, "the secret is never printed");
});

test("Vercel variable already set: no key is created", async (t) => {
  const { gw, deps } = await env(t);
  const dir = fixture({ "package.json": pkg(), "package-lock.json": "{}", "app/layout.tsx": layout, ".vercel/project.json": JSON.stringify({ projectName: "shop-prod" }), ".gitignore": ".vercel\n.env*.local\n" });
  gitInit(dir);
  const run = (cmd, args) => ({ status: 0, stdout: args[1] === "ls" ? " PARLOX_SECRET_KEY  Encrypted  Production\n" : "", stderr: "" });
  const u = ui();
  assert.equal(await main(["--yes", "--vercel", ...BASE], deps(dir, { run, ui: u.ui })), 0);
  assert.deepEqual(gw.state.keys, []);
  assert.ok(u.out.some((m) => /already set/.test(m)));
});

test("second run on an installed project: nothing to change, no install, exit 0", async (t) => {
  const { runs, deps } = await env(t);
  const dir = fixture({ "package.json": pkg(), "package-lock.json": "{}", "app/layout.tsx": layout, ".gitignore": ".env*.local\n" });
  gitInit(dir);
  assert.equal(await main(["--yes", "--no-vercel", ...BASE], deps(dir, { ui: ui().ui })), 0);
  const p = JSON.parse(read(dir, "package.json"));
  p.dependencies["@parlox/browser"] = "1.0.3"; p.dependencies["@parlox/server"] = "1.2.0";
  execFileSync("node", ["-e", `require("fs").writeFileSync("package.json", ${JSON.stringify(JSON.stringify(p))})`], { cwd: dir });
  commitAll(dir, "installed");
  runs.length = 0;
  const u = ui();
  assert.equal(await main(["--yes", "--no-vercel", ...BASE], deps(dir, { ui: u.ui })), 0);
  assert.equal(runs.length, 0);
  assert.ok(u.out.some((m) => /already installed/i.test(m)));
});

test("uninstall restores the project", async (t) => {
  const { deps } = await env(t);
  const dir = fixture({ "package.json": pkg(), "package-lock.json": "{}", "app/layout.tsx": layout, ".gitignore": ".env*.local\n" });
  gitInit(dir);
  await main(["--yes", "--no-vercel", ...BASE], deps(dir, { ui: ui().ui }));
  commitAll(dir, "installed");
  assert.equal(await main(["uninstall", "--yes"], deps(dir, { ui: ui().ui })), 0);
  assert.equal(read(dir, "proxy.ts") ?? read(dir, "proxy.js"), null);
  assert.doesNotMatch(read(dir, "app/layout.tsx"), /Parlox/);
  assert.equal(read(dir, ".env.local"), null);
});

test("sign-in denied: exit 1, nothing written", async (t) => {
  const { deps } = await env(t, "deny");
  const dir = fixture({ "package.json": pkg(), "package-lock.json": "{}", "app/layout.tsx": layout });
  gitInit(dir);
  assert.equal(await main(["--yes", "--no-vercel", ...BASE], deps(dir, { ui: ui().ui })), 1);
  assert.equal(read(dir, "app/layout.tsx"), layout);
});

test("a build missing its OAuth client id or Supabase key refuses before any network or file access", async (t) => {
  const { auth, gw, deps } = await env(t);
  const dir = fixture({ "package.json": pkg(), "package-lock.json": "{}", "app/layout.tsx": layout });
  const base = deps(dir, { ui: ui().ui });
  const withPlaceholderClientId = { ...base, config: { ...base.config, clientId: "REPLACE_WITH_OAUTH_CLIENT_ID" } };
  assert.equal(await main(["--yes", "--no-vercel", ...BASE], withPlaceholderClientId), 1);
  const withPlaceholderApiKey = { ...base, config: { ...base.config, apiKey: "REPLACE_WITH_SUPABASE_PUBLISHABLE_KEY" } };
  assert.equal(await main(["--yes", "--no-vercel", ...BASE], withPlaceholderApiKey), 1);
  assert.equal(auth.tokenRequests.length, 0, "no sign-in request reached the fake auth server");
  assert.equal(gw.calls.length, 0, "no request reached the fake gateway");
});

test("an unknown or misspelled flag is rejected, not silently ignored", async (t) => {
  const { runs, deps } = await env(t);
  const dir = fixture({ "package.json": pkg(), "package-lock.json": "{}", "app/layout.tsx": layout });
  gitInit(dir);
  // Before the fix, "--dryrun" (missing the hyphen) was ignored and "--yes" made this a real install.
  assert.equal(await main(["--dryrun", "--yes", ...BASE], deps(dir, { ui: ui().ui })), 1);
  assert.equal(runs.length, 0);
  assert.equal(read(dir, "proxy.js"), null);
  assert.doesNotMatch(read(dir, "app/layout.tsx"), /Parlox/);
});

test("--site and --url refuse a following value that is itself a flag", async (t) => {
  const { runs, deps } = await env(t);
  const dir = fixture({ "package.json": pkg(), "package-lock.json": "{}", "app/layout.tsx": layout });
  gitInit(dir);
  // Before the fix, "--url" swallowed "--yes" as its own value instead of refusing.
  assert.equal(await main(["--url", "--yes", "--site", "shop.example.com", "--skip-check"], deps(dir, { ui: ui().ui })), 1);
  assert.equal(runs.length, 0);
  assert.equal(await main(["--site", "--skip-check"], deps(dir, { ui: ui().ui })), 1);
});

test("uninstall still accepts its own flags", async (t) => {
  const { deps } = await env(t);
  const dir = fixture({ "package.json": pkg(), "package-lock.json": "{}", "app/layout.tsx": layout, ".gitignore": ".env*.local\n" });
  gitInit(dir);
  assert.equal(await main(["--yes", "--no-vercel", ...BASE], deps(dir, { ui: ui().ui })), 0);
  commitAll(dir, "installed");
  assert.equal(await main(["uninstall", "--dry-run"], deps(dir, { ui: ui().ui })), 0);
  assert.match(read(dir, "app/layout.tsx"), /Parlox/, "dry-run: nothing removed yet");
});

test("`vercel env ls` failing is 'unknown', not 'absent': no key is created, and the manual instruction is shown", async (t) => {
  const { gw, deps } = await env(t);
  const dir = fixture({ "package.json": pkg(), "package-lock.json": "{}", "app/layout.tsx": layout, ".vercel/project.json": JSON.stringify({ projectName: "shop-prod" }), ".gitignore": ".vercel\n.env*.local\n" });
  gitInit(dir);
  const run = (cmd, args) => (args[1] === "ls" ? { status: 1, stdout: "", stderr: "Error: Project not linked" } : { status: 0, stdout: "", stderr: "" });
  const u = ui();
  assert.equal(await main(["--yes", "--vercel", ...BASE], deps(dir, { run, ui: u.ui })), 0);
  assert.deepEqual(gw.state.keys, [], "unknown Vercel state must never lead to a key being created");
  assert.ok(u.out.some((m) => /not creating a key/.test(m)));
  assert.ok(u.out.some((m) => /PARLOX_SECRET_KEY not checked/.test(m)));
});

test("a key value from the dashboard that does not look like a Parlox secret key is refused, never stored or printed", async (t) => {
  const auth = await startFakeAuth({ decide: "approve" });
  const gw = await startFakeGateway({ sites: [{ id: "11111111-1111-1111-1111-111111111111", name: "Shop", domain: "shop.example.com", public_key: "pk_" + "a1".repeat(12), verified: false }], keys: [] }, { keyValue: "not-a-valid-key-shape" });
  t.after(() => { auth.close(); gw.close(); });
  const runs = [];
  const run = (cmd, args, opts) => { runs.push({ cmd, args, input: opts.input }); return { status: 0, stdout: "", stderr: "" }; };
  const config = { gateway: gw.url, supabaseUrl: auth.url, clientId: "wiz", apiKey: "test-publishable-key", ports: [53792, 53793], dashboard: "https://app.parlox.io" };
  const dir = fixture({ "package.json": pkg(), "package-lock.json": "{}", "app/layout.tsx": layout, ".vercel/project.json": JSON.stringify({ projectName: "shop-prod" }), ".gitignore": ".vercel\n.env*.local\n" });
  gitInit(dir);
  const u = ui();
  assert.equal(await main(["--yes", "--vercel", ...BASE], { cwd: dir, config, open: follow, run, ui: u.ui }), 0);
  assert.equal(runs.some((r) => r.args[0] === "env" && r.args[1] === "add" && r.args[2] === "PARLOX_SECRET_KEY"), false, "never sent to Vercel");
  assert.equal(u.out.some((m) => m.includes("not-a-valid-key-shape")), false, "the value is never printed");
  assert.ok(u.out.some((m) => /unexpected form/.test(m)));
  // The key was created before the check failed: the developer is told exactly which one to revoke, and where.
  assert.ok(u.out.some((m) => m.includes('revoke "wizard · Vercel · production"') && m.includes("Settings → Keys")));
});

test("--site is normalised like the gateway does before it is compared with your sites", async (t) => {
  const { gw, deps } = await env(t);
  const dir = fixture({ "package.json": pkg(), "package-lock.json": "{}", "app/layout.tsx": layout });
  gitInit(dir);
  for (const raw of ["WWW.Shop.example.com", " https://shop.example.com/products?x=1 ", "shop.example.com."]) {
    assert.equal(await main(["--yes", "--no-vercel", "--dry-run", "--skip-check", "--site", raw], deps(dir, { ui: ui().ui })), 0, raw);
  }
  assert.equal(gw.calls.some((c) => c.method === "POST" && c.path === "/v1/wizard/sites"), false, "no new site for a spelling of an existing domain");
  assert.equal(gw.calls.filter((c) => c.path.endsWith("/verify-token")).length, 3, "the existing site was used each time");
});

test("the Vercel step reports exactly what was set", async (t) => {
  const { deps } = await env(t);
  const dir = fixture({ "package.json": pkg(), "package-lock.json": "{}", "app/layout.tsx": layout, ".vercel/project.json": JSON.stringify({ projectName: "shop-prod" }), ".gitignore": ".vercel\n.env*.local\n" });
  gitInit(dir);
  const u = ui();
  assert.equal(await main(["--yes", "--vercel", ...BASE], deps(dir, { ui: u.ui })), 0);
  assert.ok(u.out.some((m) => m.includes('Vercel "shop-prod": PARLOX_SECRET_KEY set (sensitive), PARLOX_VERIFY_TOKEN set.')));
});

// One `vercel env ls production` per run, reused for both variables.
test("the Vercel variables are listed once per run", async (t) => {
  const { runs, deps } = await env(t);
  const dir = fixture({ "package.json": pkg(), "package-lock.json": "{}", "app/layout.tsx": layout, ".vercel/project.json": JSON.stringify({ projectName: "shop-prod" }), ".gitignore": ".vercel\n.env*.local\n" });
  gitInit(dir);
  assert.equal(await main(["--yes", "--vercel", ...BASE], deps(dir, { ui: ui().ui })), 0);
  assert.deepEqual(runs.filter((r) => r.cmd === "vercel" && r.args[0] === "env" && r.args[1] === "ls").map((r) => r.args), [["env", "ls", "production"]]);
  assert.equal(runs.filter((r) => r.args[0] === "env" && r.args[1] === "add" && r.args[2] !== "--help").length, 2, "both variables still set");
});

test("the verify-token add failing while the secret succeeded reports only the token as needing manual setup", async (t) => {
  const { deps } = await env(t);
  const dir = fixture({ "package.json": pkg(), "package-lock.json": "{}", "app/layout.tsx": layout, ".vercel/project.json": JSON.stringify({ projectName: "shop-prod" }), ".gitignore": ".vercel\n.env*.local\n" });
  gitInit(dir);
  // "env ls" reports nothing set; the package install and the secret key's "env add" succeed; only the verify
  // token's "env add" fails.
  const run = (cmd, args) => {
    if (args[0] === "env" && args[1] === "ls") return { status: 0, stdout: "No Environment Variables found", stderr: "" };
    if (args[0] === "env" && args[1] === "add" && args[2] === "PARLOX_VERIFY_TOKEN") return { status: 1, stdout: "", stderr: "Error: something went wrong" };
    return { status: 0, stdout: "", stderr: "" };
  };
  const u = ui();
  assert.equal(await main(["--yes", "--vercel", ...BASE], deps(dir, { run, ui: u.ui })), 0);
  // The hand-off in its single wording (ui/handoff.ts).
  assert.ok(u.out.some((m) => m.includes("Set on Vercel:\n  PARLOX_VERIFY_TOKEN=vt_fake\n")), JSON.stringify(u.out));
  assert.equal(u.out.some((m) => /^ {2}PARLOX_SECRET_KEY/m.test(m)), false, "the secret succeeded: no fallback for it");
});

test("cancelling a prompt prints a plain message, not 'Unexpected error: Cancelled.'", async (t) => {
  const { deps } = await env(t);
  const dir = fixture({ "package.json": pkg(), "package-lock.json": "{}", "app/layout.tsx": layout });
  // Not a git repository and not --yes: gitGate asks to continue; simulate cancelling that prompt, the way
  // clack's own confirm()/select()/text() do (they throw this exact Error when the person cancels).
  const out = [];
  const cancelUi = { info: (m) => out.push(m), warn: (m) => out.push(`WARN ${m}`), confirm: async () => { throw new Error("Cancelled."); }, select: async () => { throw new Error("Cancelled."); }, text: async () => { throw new Error("Cancelled."); } };
  assert.equal(await main([...BASE], deps(dir, { ui: cancelUi })), 1);
  assert.ok(out.some((m) => m.includes("Cancelled. Nothing else was changed.")));
  assert.equal(out.some((m) => m.includes("Unexpected error")), false);
});

test("sign-out failing prints one warning line but does not change the exit code", async (t) => {
  const { deps } = await env(t, "approve", 500);
  const dir = fixture({ "package.json": pkg(), "package-lock.json": "{}", "app/layout.tsx": layout, ".gitignore": ".env*.local\n" });
  gitInit(dir);
  const u = ui();
  assert.equal(await main(["--yes", "--no-vercel", ...BASE], deps(dir, { ui: u.ui })), 0);
  assert.ok(u.out.some((m) => m.includes("Could not end the sign-in session; it expires on its own within an hour.")));
});

// Only --yes creates a new site without asking; otherwise the question stays.
test("without --yes, a --site domain the account does not have is still asked about before it is created", async (t) => {
  const { gw, deps } = await env(t);
  const dir = fixture({ "package.json": pkg(), "package-lock.json": "{}", "app/layout.tsx": layout, ".gitignore": ".env*.local\n" });
  gitInit(dir);
  const asked = [];
  const u = ui({ confirm: (m) => { asked.push(m); return true; } });
  assert.equal(await main(["--no-vercel", "--site", "new.example.com", "--skip-check"], deps(dir, { ui: u.ui })), 0);
  assert.ok(asked.includes("No site for new.example.com in your account yet. Create it?"), JSON.stringify(asked));
  assert.equal(gw.calls.filter((c) => c.method === "POST" && c.path === "/v1/wizard/sites").length, 1);
  assert.ok(u.out.some((m) => m.includes("Created the site new.example.com in your Parlox account.")), JSON.stringify(u.out));
});

test("domain normalisation: case, spaces, scheme, path, port, trailing dot and www. are ignored", () => {
  for (const raw of ["shop.example.com", "WWW.Shop.example.com", " https://shop.example.com/a?b#c ", "http://www.shop.example.com:8080/", "shop.example.com."]) {
    assert.equal(normaliseDomain(raw), "shop.example.com", raw);
  }
  assert.equal(normaliseDomain("   "), "");
});

test("step lifecycle: every step that ever goes active ends done, failed or skipped", async (t) => {
  const { deps } = await env(t);

  // (a) a full --yes install
  const dirA = fixture({ "package.json": pkg(), "package-lock.json": "{}", "tsconfig.json": "{}", "app/layout.tsx": layout, ".gitignore": "node_modules\n.env*.local\n" });
  gitInit(dirA);
  const a = stepTracker();
  assert.equal(await main(["--yes", "--no-vercel", ...BASE], deps(dirA, { ui: a.ui })), 0);
  assertStepsResolved(a.steps, "(a) full install");

  // (b) --dry-run
  const dirB = fixture({ "package.json": pkg(), "package-lock.json": "{}", "app/layout.tsx": layout });
  gitInit(dirB);
  const b = stepTracker();
  assert.equal(await main(["--dry-run", ...BASE], deps(dirB, { ui: b.ui })), 0);
  assertStepsResolved(b.steps, "(b) dry run");

  // (c) the already-installed second run
  const dirC = fixture({ "package.json": pkg(), "package-lock.json": "{}", "app/layout.tsx": layout, ".gitignore": ".env*.local\n" });
  gitInit(dirC);
  assert.equal(await main(["--yes", "--no-vercel", ...BASE], deps(dirC, { ui: stepTracker().ui })), 0);
  const p = JSON.parse(read(dirC, "package.json"));
  p.dependencies["@parlox/browser"] = "1.0.3"; p.dependencies["@parlox/server"] = "1.2.0";
  execFileSync("node", ["-e", `require("fs").writeFileSync("package.json", ${JSON.stringify(JSON.stringify(p))})`], { cwd: dirC });
  commitAll(dirC, "installed");
  const c = stepTracker();
  assert.equal(await main(["--yes", "--no-vercel", ...BASE], deps(dirC, { ui: c.ui })), 0);
  assertStepsResolved(c.steps, "(c) already installed");

  // (d) uninstall
  const dirD = fixture({ "package.json": pkg(), "package-lock.json": "{}", "app/layout.tsx": layout, ".gitignore": ".env*.local\n" });
  gitInit(dirD);
  assert.equal(await main(["--yes", "--no-vercel", ...BASE], deps(dirD, { ui: stepTracker().ui })), 0);
  commitAll(dirD, "installed");
  const d = stepTracker();
  assert.equal(await main(["uninstall", "--yes"], deps(dirD, { ui: d.ui })), 0);
  assertStepsResolved(d.steps, "(d) uninstall");
});

test("deliberate stops (a No, or a cancelled prompt) end the active step \"skipped\", never \"active\" or \"failed\"", async (t) => {
  const { deps } = await env(t);
  const lastOf = (steps, id) => steps.filter(([s]) => s === id).at(-1)?.[1];

  // (e) No to "Apply these changes to …?"
  const dirE = fixture({ "package.json": pkg(), "package-lock.json": "{}", "app/layout.tsx": layout, ".gitignore": ".env*.local\n" });
  gitInit(dirE);
  const e = stepTracker({ confirm: (m) => !/^Apply these changes/.test(m) });
  assert.equal(await main(["--no-vercel", ...BASE], deps(dirE, { ui: e.ui })), 1);
  assertStepsResolved(e.steps, "(e) declined apply");
  assert.equal(lastOf(e.steps, "review"), "skipped", `(e) declined apply: ${JSON.stringify(e.steps)}`);

  // (f) the apply prompt cancelled (Ctrl+C / Esc in a clack prompt throws "Cancelled.")
  const dirF = fixture({ "package.json": pkg(), "package-lock.json": "{}", "app/layout.tsx": layout, ".gitignore": ".env*.local\n" });
  gitInit(dirF);
  const f = stepTracker({ confirm: (m) => { if (/^Apply these changes/.test(m)) throw new Error("Cancelled."); return true; } });
  assert.equal(await main(["--no-vercel", ...BASE], deps(dirF, { ui: f.ui })), 1);
  assertStepsResolved(f.steps, "(f) cancelled prompt");
  assert.equal(lastOf(f.steps, "review"), "skipped", `(f) cancelled prompt: ${JSON.stringify(f.steps)}`);

  // (g) No to "Continue anyway?" (not a git repository)
  const dirG = fixture({ "package.json": pkg(), "package-lock.json": "{}", "app/layout.tsx": layout });
  const g = stepTracker({ confirm: (m) => !/^Continue anyway\?/.test(m) });
  assert.equal(await main([...BASE], deps(dirG, { ui: g.ui })), 1);
  assertStepsResolved(g.steps, "(g) declined git gate");
  assert.equal(lastOf(g.steps, "detect"), "skipped", `(g) declined git gate: ${JSON.stringify(g.steps)}`);

  // (h) No to "Remove these?"
  const h = stepTracker({ confirm: (m) => !/^Remove these\?/.test(m) });
  const dirH = fixture({ "package.json": pkg(), "package-lock.json": "{}", "app/layout.tsx": layout, ".gitignore": ".env*.local\n" });
  gitInit(dirH);
  assert.equal(await main(["--yes", "--no-vercel", ...BASE], deps(dirH, { ui: stepTracker().ui })), 0);
  commitAll(dirH, "installed");
  assert.equal(await main(["uninstall"], deps(dirH, { ui: h.ui })), 1);
  assertStepsResolved(h.steps, "(h) declined removal");
  assert.equal(lastOf(h.steps, "review"), "skipped", `(h) declined removal: ${JSON.stringify(h.steps)}`);

  // (i) No to "No site for … in your account yet. Create it?"
  const dirI = fixture({ "package.json": pkg(), "package-lock.json": "{}", "app/layout.tsx": layout, ".gitignore": ".env*.local\n" });
  gitInit(dirI);
  const i = stepTracker({ confirm: (m) => !/^No site for new\.example\.com/.test(m) });
  assert.equal(await main(["--site", "new.example.com", "--skip-check", "--no-vercel"], deps(dirI, { ui: i.ui })), 1);
  assertStepsResolved(i.steps, "(i) declined site creation");
  assert.equal(lastOf(i.steps, "site"), "skipped", `(i) declined site creation: ${JSON.stringify(i.steps)}`);
  assert.ok(i.out.includes("No site chosen. Nothing was changed."), JSON.stringify(i.out));
  assert.equal(i.out.some((m) => m.includes("Unexpected error")), false);
});

test("an interrupted package install: exit 130, the install step fails as 'Interrupted', the command to finish it is shown, nothing after it runs", async (t) => {
  const { auth, deps } = await env(t);
  const dir = fixture({ "package.json": pkg(), "package-lock.json": "{}", "app/layout.tsx": layout, ".gitignore": ".env*.local\n" });
  gitInit(dir);
  const ac = new AbortController();
  const seen = [];
  const run = (cmd, args, opts) => { seen.push(opts); opts.onLine?.("added 1 package"); return { status: null, stdout: "", stderr: "", aborted: true }; };
  const tr = stepTracker();
  const logs = []; const tasks = [];
  const u = { ...tr.ui, log: (l) => logs.push(l), task: (id, status, detail) => tasks.push([id, status, detail]) };
  assert.equal(await main(["--yes", "--no-vercel", ...BASE], deps(dir, { run, ui: u, signal: ac.signal })), 130);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].signal, ac.signal, "the install is abortable through deps.signal");
  assert.equal("inherit" in seen[0], false);
  assert.deepEqual(logs, ["added 1 package"], "the package manager's output goes to ui.log");
  assert.deepEqual(tasks.at(-1), ["install", "failed", "Interrupted"]);
  assert.equal(tr.steps.filter(([id]) => id === "install").at(-1)?.[1], "failed");
  assert.equal(tr.steps.some(([id]) => id === "host" || id === "check"), false, "nothing runs after the interrupted install");
  assert.ok(tr.out.includes("WARN The package install was interrupted. Your files were changed; finish it with: npm install --save-exact @parlox/browser@1.0.3 @parlox/server@1.2.0"), JSON.stringify(tr.out));
  assertStepsResolved(tr.steps, "interrupted install");
  assert.deepEqual(auth.logouts, ["Bearer wizard-token"], "the sign-in session is still ended");
});

test("an interrupted package removal: exit 130, the install step fails as 'Interrupted', the command to finish it is shown", async (t) => {
  const { deps } = await env(t);
  const dir = fixture({ "package.json": pkg(), "package-lock.json": "{}", "app/layout.tsx": layout, ".gitignore": ".env*.local\n" });
  gitInit(dir);
  assert.equal(await main(["--yes", "--no-vercel", ...BASE], deps(dir, { ui: ui().ui })), 0);
  const p = JSON.parse(read(dir, "package.json"));
  p.dependencies["@parlox/browser"] = "1.0.3"; p.dependencies["@parlox/server"] = "1.2.0";
  execFileSync("node", ["-e", `require("fs").writeFileSync("package.json", ${JSON.stringify(JSON.stringify(p))})`], { cwd: dir });
  commitAll(dir, "installed");
  const ac = new AbortController();
  const seen = [];
  const run = (cmd, args, opts) => { seen.push({ cmd, args, opts }); return { status: null, stdout: "", stderr: "", aborted: true }; };
  const tr = stepTracker();
  const tasks = [];
  assert.equal(await main(["uninstall", "--yes"], deps(dir, { run, ui: { ...tr.ui, task: (id, status, detail) => tasks.push([id, status, detail]) }, signal: ac.signal })), 130);
  assert.equal(seen[0].opts.signal, ac.signal);
  assert.equal(typeof seen[0].opts.onLine, "function");
  assert.deepEqual(tasks.at(-1), ["install", "failed", "Interrupted"]);
  assert.ok(tr.out.includes(`WARN The package removal was interrupted. Your files were changed; finish it with: ${seen[0].cmd} ${seen[0].args.join(" ")}`), JSON.stringify(tr.out));
  assertStepsResolved(tr.steps, "interrupted removal");
});

test("a package install stopped by the time limit, or a package manager that cannot start: exit 1, the step fails, the command to finish it is shown", async (t) => {
  const { deps } = await env(t);
  const cases = [
    [{ status: null, stdout: "", stderr: "", timedOut: true }, "WARN The package install stopped after 10 minutes. Finish it with: npm install --save-exact @parlox/browser@1.0.3 @parlox/server@1.2.0"],
    [{ status: null, stdout: "", stderr: "", error: "ENOENT" }, "WARN Could not start npm: it was not found on this computer's PATH."],
  ];
  for (const [result, expected] of cases) {
    const dir = fixture({ "package.json": pkg(), "package-lock.json": "{}", "app/layout.tsx": layout, ".gitignore": ".env*.local\n" });
    gitInit(dir);
    const tr = stepTracker();
    assert.equal(await main(["--yes", "--no-vercel", ...BASE], deps(dir, { run: () => result, ui: tr.ui })), 1);
    assert.ok(tr.out.some((m) => m.startsWith(expected)), `${expected}\n${JSON.stringify(tr.out)}`);
    assert.equal(tr.steps.filter(([id]) => id === "install").at(-1)?.[1], "failed");
    assert.equal(tr.steps.some(([id]) => id === "host"), false, "nothing runs after it");
    assertStepsResolved(tr.steps, JSON.stringify(result));
  }
});

test("a package removal stopped by the time limit, or a package manager that cannot start: exit 1, the step fails, the command to finish it is shown", async (t) => {
  const { deps } = await env(t);
  for (const [result, expected] of [[{ status: null, stdout: "", stderr: "", timedOut: true }, "WARN The package removal stopped after 10 minutes. Finish it with: npm uninstall @parlox/browser @parlox/server"], [{ status: null, stdout: "", stderr: "", error: "ENOENT" }, "WARN Could not start npm: it was not found on this computer's PATH."]]) {
    const dir = fixture({ "package.json": pkg(), "package-lock.json": "{}", "app/layout.tsx": layout, ".gitignore": ".env*.local\n" });
    gitInit(dir);
    assert.equal(await main(["--yes", "--no-vercel", ...BASE], deps(dir, { ui: ui().ui })), 0);
    const p = JSON.parse(read(dir, "package.json"));
    p.dependencies["@parlox/browser"] = "1.0.3"; p.dependencies["@parlox/server"] = "1.2.0";
    execFileSync("node", ["-e", `require("fs").writeFileSync("package.json", ${JSON.stringify(JSON.stringify(p))})`], { cwd: dir });
    commitAll(dir, "installed");
    const tr = stepTracker();
    assert.equal(await main(["uninstall", "--yes"], deps(dir, { run: () => result, ui: tr.ui })), 1);
    assert.ok(tr.out.some((m) => m.startsWith(expected)), `${expected}\n${JSON.stringify(tr.out)}`);
    assert.equal(tr.steps.filter(([id]) => id === "install").at(-1)?.[1], "failed");
    assertStepsResolved(tr.steps, JSON.stringify(result));
  }
});

test("no Vercel: the hand-off prints the link and where to paste; --yes does not open a browser; no key is created", async (t) => {
  const { gw, deps } = await env(t);
  const dir = fixture({ "package.json": pkg(), "package-lock.json": "{}", "app/layout.tsx": layout, "netlify.toml": "", ".gitignore": ".env*.local\n" });
  gitInit(dir);
  const opened = [];
  const u = ui();
  assert.equal(await main(["--yes", ...BASE], deps(dir, { ui: u.ui, open: (url) => { opened.push(url); if (!url.includes("newKey")) fetch(url).catch(() => {}); } })), 0);
  assert.ok(u.out.some((m) => m.includes("https://app.parlox.io/sites/11111111-1111-1111-1111-111111111111?newKey=Netlify%20%C2%B7%20production&scope=fetch#keys")));
  assert.ok(u.out.some((m) => m.includes("Project configuration → Environment variables")));
  assert.deepEqual(opened.filter((u2) => u2.includes("newKey")), []);
  assert.equal(gw.calls.some((c) => c.path.endsWith("/keys")), false);
});

test("interactive run opens the hand-off link in the browser", async (t) => {
  const { deps } = await env(t);
  const dir = fixture({ "package.json": pkg(), "package-lock.json": "{}", "app/layout.tsx": layout, "render.yaml": "", ".gitignore": ".env*.local\n" });
  gitInit(dir);
  const opened = [];
  assert.equal(await main(["--site", "shop.example.com", "--skip-check"], deps(dir, { ui: ui().ui, open: (url) => { opened.push(url); if (!url.includes("newKey")) fetch(url).catch(() => {}); } })), 0);
  assert.ok(opened.some((u2) => u2.includes("newKey=Render%20%C2%B7%20production")));
});

test("--local-key writes a separate local key to .env.local and warns that local visits count", async (t) => {
  const { gw, deps } = await env(t);
  const dir = fixture({ "package.json": pkg(), "package-lock.json": "{}", "app/layout.tsx": layout, ".gitignore": ".env*.local\n" });
  gitInit(dir);
  const u = ui();
  assert.equal(await main(["--yes", "--local-key", ...BASE], deps(dir, { ui: u.ui })), 0);
  assert.equal(gw.state.keys.length, 1);
  assert.match(gw.state.keys[0], /^local dev · /);
  assert.match(read(dir, ".env.local"), /^PARLOX_VERIFY_TOKEN=vt_fake\nPARLOX_SECRET_KEY=sk_parlox_d{64}\n$/);
  if (process.platform !== "win32") assert.equal(statSync(join(dir, ".env.local")).mode & 0o777, 0o600, "created by the wizard: owner-only");
  assert.ok(u.out.some((m) => /appear in the site's real data/.test(m)));
  assert.equal(u.out.some((m) => m.includes("sk_parlox_")), false, "the key is never printed");
});

// An existing .env.local keeps its mode (often 0644, readable by every user of the computer) until the
// wizard writes a secret key into it; from then on only its owner may read it, and the report says so.
test("--local-key into an existing .env.local leaves it readable only by its owner, and says so", async (t) => {
  const { deps } = await env(t);
  const dir = fixture({ "package.json": pkg(), "package-lock.json": "{}", "app/layout.tsx": layout, ".gitignore": ".env*.local\n", ".env.local": "OTHER=1\n" });
  gitInit(dir);
  chmodSync(join(dir, ".env.local"), 0o644);
  const u = ui();
  assert.equal(await main(["--yes", "--local-key", ...BASE], deps(dir, { ui: u.ui })), 0);
  assert.match(read(dir, ".env.local"), /PARLOX_SECRET_KEY=sk_parlox_/);
  if (process.platform !== "win32") {
    assert.equal(statSync(join(dir, ".env.local")).mode & 0o777, 0o600);
    assert.ok(u.out.some((m) => m.includes(".env.local is now readable only by you")), JSON.stringify(u.out));
  }
  assert.match(read(dir, ".env.local"), /^OTHER=1\n/m, "the developer's own variable is kept");
  assert.deepEqual(allFiles(dir).filter((f) => f.startsWith(".env")), [".env.local"], "no temporary file left (residual 1)");
  // Without a key written (already there), the mode is left as it is.
  chmodSync(join(dir, ".env.local"), 0o644);
  const again = ui();
  assert.equal(await main(["--yes", "--local-key", "--allow-dirty", ...BASE], deps(dir, { ui: again.ui })), 0);
  if (process.platform !== "win32") assert.equal(statSync(join(dir, ".env.local")).mode & 0o777, 0o644);
  assert.equal(again.out.some((m) => m.includes("readable only by you")), false, JSON.stringify(again.out));
});

test("--dry-run with --local-key creates nothing and opens nothing", async (t) => {
  const { gw, deps } = await env(t);
  const dir = fixture({ "package.json": pkg(), "package-lock.json": "{}", "app/layout.tsx": layout });
  gitInit(dir);
  const opened = [];
  assert.equal(await main(["--dry-run", "--local-key", ...BASE], deps(dir, { ui: ui().ui, open: (url) => { opened.push(url); fetch(url).catch(() => {}); } })), 0);
  assert.equal(gw.calls.some((c) => c.method === "POST"), false);
  assert.equal(opened.some((u2) => u2.includes("newKey")), false);
  assert.equal(read(dir, ".env.local"), null);
});

const monorepo = () => fixture({ "package.json": JSON.stringify({ name: "m", private: true, workspaces: ["apps/*"] }), "package-lock.json": "{}", ".vercel/project.json": JSON.stringify({ projectName: "mono-web" }), ".gitignore": ".vercel\n.env*.local\n", "apps/web/package.json": pkg(), "apps/web/app/layout.tsx": layout });
const noHandoffBrowser = (opened) => (url) => { opened.push(url); if (!url.includes("newKey")) fetch(url).catch(() => {}); };

// In a monorepo the package manager must run in the app's folder; a command to finish by hand says
// where, when that is not the folder the wizard was started in.
test("a failed or interrupted install started from the workspace root names the app folder to run the command in", async (t) => {
  const { deps } = await env(t);
  const cases = [
    [{ status: 1, stdout: "", stderr: "" }, 1, "WARN The package manager reported an error. Run it yourself in apps/web: npm install --save-exact @parlox/browser@1.0.3 @parlox/server@1.2.0"],
    [{ status: null, stdout: "", stderr: "", timedOut: true }, 1, "WARN The package install stopped after 10 minutes. Finish it in apps/web with: npm install --save-exact @parlox/browser@1.0.3 @parlox/server@1.2.0"],
  ];
  for (const [result, code, expected] of cases) {
    const root = fixture({ "package.json": JSON.stringify({ name: "m", private: true, workspaces: ["apps/*"] }), "package-lock.json": "{}", ".gitignore": ".env*.local\n", "apps/web/package.json": pkg(), "apps/web/app/layout.tsx": layout });
    gitInit(root);
    const u = ui();
    assert.equal(await main(["--yes", "--no-vercel", ...BASE], deps(root, { ui: u.ui, run: () => result })), code);
    assert.ok(u.out.includes(expected), `${expected}\n${JSON.stringify(u.out)}`);
  }
});

// Residual 3: a package install that fails, stops at the time limit, or cannot start ends after the files were
// written, like a stop: it also says the host is not connected and hands off what to set there.
test("a failed, timed-out or unstartable install also says the host is not connected, with the hand-off", async (t) => {
  const { deps } = await env(t);
  for (const result of [{ status: 1, stdout: "", stderr: "" }, { status: null, stdout: "", stderr: "", timedOut: true }, { status: null, stdout: "", stderr: "", error: "ENOENT" }]) {
    const dir = fixture({ "package.json": pkg(), "package-lock.json": "{}", "app/layout.tsx": layout, "netlify.toml": "", ".gitignore": ".env*.local\n" });
    gitInit(dir);
    const u = ui();
    assert.equal(await main(["--yes", ...BASE], deps(dir, { ui: u.ui, run: () => result })), 1, JSON.stringify(result));
    const failed = u.out.findIndex((m) => /^WARN (The package manager reported an error|The package install stopped|Could not start npm)/.test(m));
    const host = u.out.findIndex((m) => m.startsWith("WARN Stopped before your host was connected."));
    const handoff = u.out.findIndex((m) => m.startsWith("Connect your host\nSet on Netlify:\n") && m.includes("  PARLOX_VERIFY_TOKEN=vt_fake"));
    assert.ok(failed >= 0 && host > failed && handoff > host, `${JSON.stringify(result)}\n${JSON.stringify(u.out)}`);
  }
});

test("Vercel linked at the workspace root: even with --vercel, an interactive run asks first (naming the project), then uses that folder", async (t) => {
  const { runs, deps } = await env(t);
  const root = monorepo();
  gitInit(root);
  const cwds = [];
  const run = (cmd, args, opts) => { cwds.push([cmd, args[0], opts.cwd]); runs.push({ cmd, args }); return { status: 0, stdout: args[1] === "ls" ? "" : "ok", stderr: "" }; };
  const asked = [];
  assert.equal(await main(["--vercel", ...BASE], deps(join(root, "apps", "web"), { ui: ui({ confirm: (m) => { asked.push(m); return true; } }).ui, run, open: noHandoffBrowser([]) })), 0);
  assert.ok(asked.some((m) => m.includes('"mono-web"') && /workspace root/.test(m)), JSON.stringify(asked));
  assert.ok(cwds.some(([cmd, sub, cwd]) => cmd === "vercel" && sub === "env" && cwd === root));
});

test("Vercel linked at the workspace root: --yes --vercel does not write there; it hands off and says why", async (t) => {
  const { gw, deps } = await env(t);
  const root = monorepo();
  gitInit(root);
  const calls = [];
  const run = (cmd, args) => { calls.push([cmd, ...args]); return { status: 0, stdout: "", stderr: "" }; };
  const u = ui();
  assert.equal(await main(["--yes", "--vercel", ...BASE], deps(join(root, "apps", "web"), { ui: u.ui, run })), 0);
  assert.equal(calls.some(([cmd]) => cmd === "vercel"), false, JSON.stringify(calls));
  assert.deepEqual(gw.state.keys, []);
  assert.ok(u.out.some((m) => /workspace root/.test(m) && /may belong to another app/.test(m)), JSON.stringify(u.out));
  assert.ok(u.out.some((m) => m.includes("?newKey=Vercel%20%C2%B7%20production&scope=fetch#keys")));
});

test("uninstall leaves a --local-key PARLOX_SECRET_KEY line in .env.local (it could be the merchant's own), never shows it, and says which key to revoke", async (t) => {
  const { deps } = await env(t);
  const dir = fixture({ "package.json": pkg(), "package-lock.json": "{}", "app/layout.tsx": layout, ".gitignore": ".env*.local\n" });
  gitInit(dir);
  assert.equal(await main(["--yes", "--local-key", ...BASE], deps(dir, { ui: ui().ui })), 0);
  assert.match(read(dir, ".env.local"), /PARLOX_SECRET_KEY=sk_parlox_/);
  const p = JSON.parse(read(dir, "package.json"));
  p.dependencies["@parlox/browser"] = "1.0.3"; p.dependencies["@parlox/server"] = "1.2.0";
  execFileSync("node", ["-e", `require("fs").writeFileSync("package.json", ${JSON.stringify(JSON.stringify(p))})`], { cwd: dir });
  commitAll(dir, "installed");
  const u = ui();
  assert.equal(await main(["uninstall", "--yes"], deps(dir, { ui: u.ui })), 0);
  assert.match(read(dir, ".env.local"), /^PARLOX_SECRET_KEY=sk_parlox_[0-9a-f]{64}\n$/);
  assert.ok(u.out.some((m) => m.includes("PARLOX_SECRET_KEY in .env.local was left: the wizard cannot tell whether --local-key wrote it")), JSON.stringify(u.out));
  assert.equal(u.out.some((m) => m.includes("sk_parlox_")), false, "the removal diff is scrubbed");
  // The env file's diff shows Parlox's own line only, never the key's.
  assert.ok(u.out.some((m) => m.includes("-PARLOX_VERIFY_TOKEN=vt_fake")), JSON.stringify(u.out));
  assert.equal(u.out.some((m) => m.includes("PARLOX_SECRET_KEY=")), false, JSON.stringify(u.out));
  assert.ok(u.out.some((m) => m.includes('If you used --local-key, revoke the key named "wizard · local dev · …" in Settings → Keys.')), JSON.stringify(u.out));
});

test("--local-key with PARLOX_SECRET_KEY already in .env.local: no second key is created, the file is unchanged", async (t) => {
  const { gw, deps } = await env(t);
  const dir = fixture({ "package.json": pkg(), "package-lock.json": "{}", "app/layout.tsx": layout, ".gitignore": ".env*.local\n" });
  gitInit(dir);
  assert.equal(await main(["--yes", "--local-key", ...BASE], deps(dir, { ui: ui().ui })), 0);
  const before = read(dir, ".env.local");
  const u = ui();
  assert.equal(await main(["--yes", "--local-key", "--allow-dirty", ...BASE], deps(dir, { ui: u.ui })), 0);
  assert.equal(gw.state.keys.length, 1, "only the first run created a key");
  assert.equal(read(dir, ".env.local"), before);
  assert.ok(u.out.includes("PARLOX_SECRET_KEY is already in .env.local; no new local key was created. To replace it, revoke the old key in Settings → Keys, delete that line, and run again with --local-key."), JSON.stringify(u.out));
});

test("host step: done only when both variables are set; a --local-key failure is a warning, not a failed step", async (t) => {
  const auth = await startFakeAuth({ decide: "approve" });
  const gw = await startFakeGateway({ sites: [{ id: "11111111-1111-1111-1111-111111111111", name: "Shop", domain: "shop.example.com", public_key: "pk_" + "a1".repeat(12), verified: false }], keys: [] }, { keyValue: "not-a-valid-key-shape" });
  t.after(() => { auth.close(); gw.close(); });
  const config = { gateway: gw.url, supabaseUrl: auth.url, clientId: "wiz", apiKey: "test-publishable-key", ports: [53792, 53793], dashboard: "https://app.parlox.io" };
  const dir = fixture({ "package.json": pkg(), "package-lock.json": "{}", "app/layout.tsx": layout, ".gitignore": ".env*.local\n" });
  gitInit(dir);
  const tr = stepTracker();
  assert.equal(await main(["--yes", "--local-key", ...BASE], { cwd: dir, config, open: follow, run: () => ({ status: 0, stdout: "", stderr: "" }), ui: tr.ui }), 0);
  assert.ok(tr.out.some((m) => /unexpected form/.test(m) && m.includes('"wizard · local dev · ')), JSON.stringify(tr.out));
  assert.equal(read(dir, ".env.local"), "PARLOX_VERIFY_TOKEN=vt_fake\n", "nothing but the verify token");
  assert.equal(tr.out.some((m) => m.includes("not-a-valid-key-shape")), false);
  assert.equal(tr.steps.filter(([id]) => id === "host").at(-1)?.[1], "skipped", "the hand-off is still due: the host step is skipped, not failed");
  assertStepsResolved(tr.steps, "local key refused");

  const { deps } = await env(t);
  const vdir = fixture({ "package.json": pkg(), "package-lock.json": "{}", "app/layout.tsx": layout, ".vercel/project.json": JSON.stringify({ projectName: "shop-prod" }), ".gitignore": ".vercel\n.env*.local\n" });
  gitInit(vdir);
  const v = stepTracker();
  assert.equal(await main(["--yes", "--vercel", ...BASE], deps(vdir, { ui: v.ui })), 0);
  assert.equal(v.steps.filter(([id]) => id === "host").at(-1)?.[1], "done");
});

test("Vercel detected without a usable CLI gets the hand-off with Vercel's own instructions; no key is created", async (t) => {
  const { gw, deps } = await env(t);
  const dir = fixture({ "package.json": pkg(), "package-lock.json": "{}", "app/layout.tsx": layout, ".vercel/project.json": JSON.stringify({ projectName: "shop-prod" }), ".gitignore": ".vercel\n.env*.local\n" });
  gitInit(dir);
  const run = (cmd, args) => (cmd === "vercel" ? { status: 1, stdout: "", stderr: "command not found" } : { status: 0, stdout: "", stderr: "" });
  const u = ui();
  assert.equal(await main(["--yes", ...BASE], deps(dir, { run, ui: u.ui })), 0);
  assert.ok(u.out.some((m) => m.includes("?newKey=Vercel%20%C2%B7%20production&scope=fetch#keys") && m.includes("Settings → Environment Variables") && m.includes("https://vercel.com/docs/environment-variables/managing-environment-variables")), JSON.stringify(u.out));
  assert.deepEqual(gw.state.keys, []);
});

test("--local-key with a committed .env.local: a step by hand, and no key is created", async (t) => {
  const { gw, deps } = await env(t);
  const dir = fixture({ "package.json": pkg(), "package-lock.json": "{}", "app/layout.tsx": layout, ".env.local": "OTHER=1\n" });
  gitInit(dir);
  // The file is the app's step by hand, not the end of the run (the run finishes).
  assert.equal(await main(["--yes", "--local-key", ...BASE], deps(dir, { ui: ui().ui })), 0);
  assert.deepEqual(gw.state.keys, []);
  assert.equal(read(dir, ".env.local"), "OTHER=1\n");
});

test("the report's dashboard link is on a line of its own (a link wrapped across lines cannot be copied whole)", async (t) => {
  const { deps } = await env(t);
  const dir = fixture({ "package.json": pkg(), "package-lock.json": "{}", "app/layout.tsx": layout, ".gitignore": ".env*.local\n" });
  gitInit(dir);
  const reports = [];
  const u = { ...ui().ui, report: (lines, title) => reports.push({ lines, title }) };
  assert.equal(await main(["--yes", "--no-vercel", ...BASE], deps(dir, { ui: u })), 0);
  const { lines } = reports.at(-1);
  assert.ok(lines.includes("Next: deploy, then open the dashboard to watch the first reports:"), JSON.stringify(lines));
  assert.ok(lines.includes("  https://app.parlox.io"), JSON.stringify(lines));
  assert.equal(lines.filter((l) => l.includes("https://app.parlox.io")).length, 1);
});

// A stop (deps.signal: a confirmed quit, Ctrl-C, SIGTERM) takes effect before the flow's next side effect: before
// the review is approved nothing is changed, and after it nothing more. The sign-out still runs (cleanup).
test("a stop takes effect before the next side effect: nothing more is written, created, installed or opened; exit 130", async (t) => {
  const { gw, auth, runs, deps } = await env(t);
  const fresh = () => { const d = fixture({ "package.json": pkg(), "package-lock.json": "{}", "app/layout.tsx": layout, ".gitignore": ".env*.local\n" }); gitInit(d); return d; };
  const lastOf = (steps, id) => steps.filter(([s]) => s === id).at(-1)?.[1];

  // (a) The stop comes while "Apply these changes?" is open, and the answer is still Yes (it raced the stop).
  const dirA = fresh();
  const acA = new AbortController();
  const a = stepTracker({ confirm: (m) => { if (/^Apply these changes/.test(m)) acA.abort(); return true; } });
  assert.equal(await main(["--no-vercel", ...BASE], deps(dirA, { ui: a.ui, signal: acA.signal })), 130);
  assert.equal(read(dirA, "app/layout.tsx"), layout, "(a) nothing written");
  assert.equal(read(dirA, ".env.local"), null);
  assert.equal(runs.length, 0, "(a) nothing installed");
  assert.equal(lastOf(a.steps, "review"), "skipped");
  assertStepsResolved(a.steps, "(a)");
  assert.equal(a.out.some((m) => /Server part:|Unexpected error/.test(m)), false, JSON.stringify(a.out));
  assert.equal(auth.logouts.length, 1, "(a) signed out");

  // (b) --local-key: the stop comes during the package install, which still finishes. No key, no hand-off, no
  // browser; the flow says the files stay changed and how to finish.
  const dirB = fresh();
  const acB = new AbortController();
  const openedB = [];
  const b = stepTracker();
  const runB = () => { acB.abort(); return { status: 0, stdout: "", stderr: "" }; };
  assert.equal(await main(["--no-vercel", "--local-key", ...BASE], deps(dirB, { run: runB, ui: b.ui, signal: acB.signal, open: (u) => { openedB.push(u); follow(u); } })), 130);
  assert.deepEqual(gw.state.keys, [], "(b) no key created");
  assert.equal(read(dirB, ".env.local"), "PARLOX_VERIFY_TOKEN=vt_fake\n", "(b) no key written");
  assert.equal(openedB.some((u) => u.includes("newKey")), false, "(b) the dashboard was not opened");
  assert.equal(b.steps.some(([id]) => id === "host" || id === "check"), false, "(b) nothing after the install ran");
  assert.ok(b.out.some((m) => m.startsWith("WARN Stopped before your host was connected.")), JSON.stringify(b.out));
  assertStepsResolved(b.steps, "(b)");

  // (c) --local-key: the stop comes while the local key is being created. The key exists but is not written; the
  // flow names it for revoking.
  const dirC = fresh();
  const acC = new AbortController();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => { if (/\/keys$/.test(String(url))) acC.abort(); return realFetch(url, opts); };
  const c = stepTracker();
  try {
    assert.equal(await main(["--yes", "--no-vercel", "--local-key", ...BASE], deps(dirC, { ui: c.ui, signal: acC.signal })), 130);
  } finally { globalThis.fetch = realFetch; }
  assert.equal(gw.state.keys.length, 1, "(c) the key was created before the stop took effect");
  assert.equal(read(dirC, ".env.local").includes("PARLOX_SECRET_KEY"), false, "(c) but not written");
  assert.ok(c.out.some((m) => /^WARN The local key "wizard · local dev · .*" was created, but the wizard was stopped before writing it to \.env\.local; revoke it in the dashboard \(Settings → Keys\)\.$/.test(m)), JSON.stringify(c.out));
  assert.equal(c.steps.some(([id]) => id === "host"), false, "(c) the host step did not start");
  gw.state.keys.length = 0;

  // (d) The stop comes while "Check the server part now?" is open, answered Yes: no check, no report.
  const dirD = fresh();
  const acD = new AbortController();
  const tasksD = [];
  const d = stepTracker({ confirm: (m) => { if (/^Check the server part/.test(m)) acD.abort(); return true; }, text: "http://127.0.0.1:9" });
  assert.equal(await main(["--no-vercel", "--site", "shop.example.com"], deps(dirD, { ui: { ...d.ui, task: (...args) => tasksD.push(args) }, signal: acD.signal })), 130);
  assert.equal(tasksD.some(([id, , detail]) => id === "check" && /verified locally/.test(detail ?? "")), false, "(d) the check did not run");
  assert.equal(d.out.some((m) => /Server part:/.test(m)), false, "(d) no report");
  assertStepsResolved(d.steps, "(d)");

  // (e) Uninstall: the stop comes while "Remove these?" is open, answered Yes: nothing removed.
  const dirE = fresh();
  assert.equal(await main(["--yes", "--no-vercel", ...BASE], deps(dirE, { ui: ui().ui })), 0);
  commitAll(dirE, "installed");
  const layoutE = read(dirE, "app/layout.tsx");
  const acE = new AbortController();
  const e = stepTracker({ confirm: (m) => { if (/^Remove these/.test(m)) acE.abort(); return true; } });
  runs.length = 0;
  assert.equal(await main(["uninstall"], deps(dirE, { ui: e.ui, signal: acE.signal })), 130);
  assert.equal(read(dirE, "app/layout.tsx"), layoutE, "(e) nothing removed");
  assert.equal(runs.length, 0, "(e) no package removal");
  assert.equal(lastOf(e.steps, "review"), "skipped");
  assertStepsResolved(e.steps, "(e)");
});

// A stop while the site list is loading: the plain face would otherwise go on to ask "Which site is this project?"
// after Ctrl-C. No question comes after a stop.
test("a stop while the sites are loading asks no question; exit 130", async (t) => {
  const { deps } = await env(t);
  const dir = fixture({ "package.json": pkg(), "package-lock.json": "{}", "app/layout.tsx": layout, ".gitignore": ".env*.local\n" });
  gitInit(dir);
  const ac = new AbortController();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => { if (/\/v1\/wizard\/sites$/.test(String(url)) && (opts?.method ?? "GET") === "GET") ac.abort(); return realFetch(url, opts); };
  const asked = [];
  const tr = stepTracker();
  const u = { ...tr.ui, confirm: async (m) => { asked.push(m); return true; }, select: async (m, o) => { asked.push(m); return o[0].value; }, text: async (m) => { asked.push(m); return ""; } };
  try {
    assert.equal(await main(["--no-vercel", "--skip-check"], deps(dir, { ui: u, signal: ac.signal })), 130);
  } finally { globalThis.fetch = realFetch; }
  assert.deepEqual(asked, [], "no question after the stop");
  assert.equal(tr.steps.filter(([id]) => id === "site").at(-1)?.[1], "skipped");
  assertStepsResolved(tr.steps, "stop while loading sites");
});

// A stop during the package install ends through the interrupted-install path; like every stop after the files were
// written, it also says the host is not connected yet and how to finish.
test("a stop during the package install also says the host is not connected yet", async (t) => {
  const { deps } = await env(t);
  const dir = fixture({ "package.json": pkg(), "package-lock.json": "{}", "app/layout.tsx": layout, ".gitignore": ".env*.local\n" });
  gitInit(dir);
  const ac = new AbortController();
  const run = () => { ac.abort(); return { status: null, stdout: "", stderr: "", aborted: true }; };
  const tr = stepTracker();
  assert.equal(await main(["--yes", "--no-vercel", ...BASE], deps(dir, { run, ui: tr.ui, signal: ac.signal })), 130);
  const install = tr.out.findIndex((m) => m.startsWith("WARN The package install was interrupted. Your files were changed; finish it with: npm install"));
  const host = tr.out.findIndex((m) => m.startsWith("WARN Stopped before your host was connected."));
  assert.ok(install >= 0 && host > install, JSON.stringify(tr.out));
  assertStepsResolved(tr.steps, "stop during the install");
});

test("init is accepted as the command, and no command means init", async (t) => {
  const { deps } = await env(t);
  const dir = fixture({ "package.json": pkg(), "package-lock.json": "{}", "app/layout.tsx": layout });
  gitInit(dir);
  assert.equal(await main(["init", "--dry-run", ...BASE], deps(dir, { ui: ui().ui })), 0);
  assert.equal(await main(["--dry-run", ...BASE], deps(dir, { ui: ui().ui })), 0);
  const u = ui();
  assert.equal(await main(["setup"], deps(dir, { ui: u.ui })), 1);
  assert.ok(u.out.some((m) => /Unknown option: setup/.test(m)));
});
