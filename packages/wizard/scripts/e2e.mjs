// The wizard against real installs (CI job wizard-e2e; needs the npm registry and gateway.parlox.io). For each fixture
// with e2e checks: the untouched fixture must pass them first (a failure there is the fixture's, not the wizard's),
// then the wizard's plan is applied, the packages it adds are installed (the SDKs from this commit, packed), and the
// checks run again: the build or type check, a render of the pages (Express), the ownership answer served before any
// route, the ownership file in Vite's output, and no secret key in any Vite build.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { planUnit, scanApps } from "../dist/apps.js";
import { applyPlan } from "../dist/plan-core.js";
import { vercelHost } from "../dist/hosts.js";
import { TAG_INTEGRITY, TAG_URL } from "../dist/versions.js";

const here = resolve(import.meta.dirname, "..");
const repo = resolve(here, "..", "..");
const manifest = JSON.parse(readFileSync(join(here, "test", "fixtures", "manifest.json"), "utf8"));
const win = process.platform === "win32";
const npm = win ? "npm.cmd" : "npm";
const PK = "pk_e2eE2eE2eE2e12";
const TOKEN = "e2etoken0123456789abcdef01234567";
const SECRET = "sk_parlox_" + "f".repeat(64);   // a fake key, planted to prove it never reaches a browser build
const workspaceTsc = join(repo, "node_modules", "typescript", "bin", "tsc");
const git = { isRepo: () => false, dirty: () => [], isTracked: () => false, isIgnored: () => false };
const OTHER = { id: "netlify", label: "Netlify", where: "", docs: null, vercelDir: null };
const reader = (dir) => (rel) => { try { const p = join(dir, rel); return statSync(p).isFile() ? readFileSync(p, "utf8") : null; } catch { return null; } };
const walk = (d, out = []) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); e.isDirectory() ? walk(p, out) : out.push(p); } return out; };
function sh(cmd, args, cwd, env = {}) {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", env: { ...process.env, ...env }, shell: win });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} (in ${cwd}) failed:\n${r.stdout}\n${r.stderr}`);
  return r.stdout;
}

// 1. The pinned tag is exactly the file the gateway serves.
const res = await fetch(TAG_URL);
if (!res.ok) throw new Error(`${TAG_URL} answered ${res.status}`);
const served = Buffer.from(await res.arrayBuffer());
const sri = `sha384-${createHash("sha384").update(served).digest("base64")}`;
if (sri !== TAG_INTEGRITY) throw new Error(`TAG_INTEGRITY in versions.ts is ${TAG_INTEGRITY}; ${TAG_URL} hashes to ${sri}`);
console.log(`ok  the pinned tag matches ${TAG_URL}`);

// 2. The SDKs of this commit, packed the way npm publishes them (@parlox/server 1.2.0 is not on npm while this is being built).
const packs = mkdtempSync(join(tmpdir(), "parlox-e2e-packs-"));
const packOf = (ws) => join(packs, JSON.parse(sh(npm, ["pack", "--json", "--pack-destination", packs, "--workspace", ws], repo))[0].filename);
const tarballs = { "@parlox/server": packOf("packages/server"), "@parlox/browser": packOf("packages/browser") };

function prepare(src, withParlox, host) {
  const dir = mkdtempSync(join(tmpdir(), "parlox-e2e-"));
  cpSync(src, dir, { recursive: true });
  if (withParlox) {
    for (const u of scanApps(dir).units) {
      const plan = planUnit(u, { publicKey: PK, verifyToken: TOKEN, host: host === "vercel" ? vercelHost(null) : OTHER }, { read: reader(u.dir), git });
      applyPlan(u.dir, plan);
      // The packages the plan would install, with this commit's SDKs in place of the published ones.
      const pkg = JSON.parse(readFileSync(join(u.dir, "package.json"), "utf8"));
      pkg.dependencies ??= {};
      for (const a of plan.install?.args ?? []) {
        const m = /^(@?[^@]+)@(.+)$/.exec(a);
        if (m) pkg.dependencies[m[1]] = tarballs[m[1]] ? `file:${tarballs[m[1]]}` : m[2];
      }
      writeFileSync(join(u.dir, "package.json"), JSON.stringify(pkg, null, 2));
    }
  }
  // Install scripts are not run: nothing here needs them (esbuild, rolldown and workerd ship their binaries as
  // optional dependencies), and a CI job should not run third-party install hooks it does not need.
  sh(npm, ["install", "--no-audit", "--no-fund", "--ignore-scripts"], dir);
  return dir;
}

const RUNNER = `const http = require("http"); const app = require(process.argv[2]);
const server = http.createServer(app).listen(0, "127.0.0.1", async () => {
  const base = "http://127.0.0.1:" + server.address().port; const out = {};
  for (const p of JSON.parse(process.argv[3])) { const r = await fetch(base + p, { headers: { "user-agent": "curl/8" } }); out[p] = { status: r.status, body: await r.text() }; }
  console.log("PARLOX_E2E " + JSON.stringify(out)); server.close(); process.exit(0);
});`;
const runner = join(packs, "runner.cjs");
writeFileSync(runner, RUNNER);

function check(dir, f, withParlox) {
  const e = f.e2e;
  if (e.build) {
    // Vite reads .env; a planted secret must never reach the browser build.
    writeFileSync(join(dir, ".env"), `PARLOX_SECRET_KEY=${SECRET}\nVITE_SHOP=1\n`);
    sh(e.build[0] === "npm" ? npm : e.build[0], e.build.slice(1), dir, { PARLOX_SECRET_KEY: SECRET });
    const leaked = walk(join(dir, e.dist)).filter((p) => readFileSync(p).includes("sk_parlox_"));
    if (leaked.length) throw new Error(`${f.name}: a secret key is in the build: ${leaked.join(", ")}`);
  }
  if (withParlox && e.verifyFile && readFileSync(join(dir, e.verifyFile), "utf8") !== `${TOKEN}\n`) throw new Error(`${f.name}: ${e.verifyFile} is not in the build`);
  const tsc = existsSync(join(dir, "node_modules", "typescript", "bin", "tsc")) ? join(dir, "node_modules", "typescript", "bin", "tsc") : workspaceTsc;
  if (e.typecheck) sh(process.execPath, [tsc, "--noEmit", "-p", "."], dir);
  if (withParlox && e.typecheckFile) {
    writeFileSync(join(dir, "tsconfig.parlox-e2e.json"), JSON.stringify({ compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, module: "esnext", moduleResolution: "bundler", target: "es2022", lib: ["es2022", "dom"] }, files: [e.typecheckFile] }));
    sh(process.execPath, [tsc, "-p", "tsconfig.parlox-e2e.json"], dir);
  }
  if (e.serve) {
    const out = sh(process.execPath, [runner, join(dir, e.serve.entry), JSON.stringify(["/.well-known/parlox-verify", ...e.serve.pages])], dir, { PARLOX_VERIFY_TOKEN: TOKEN });
    const got = JSON.parse(out.split("\n").find((l) => l.startsWith("PARLOX_E2E ")).slice(11));
    for (const p of e.serve.pages) {
      if (got[p].status !== 200) throw new Error(`${f.name}: ${p} answered ${got[p].status}`);
      if (withParlox && !got[p].body.includes(`data-key="${PK}"`)) throw new Error(`${f.name}: ${p} does not carry the tag`);
    }
    // Answered even though the app has a 404 handler after its routes: the middleware runs before them.
    if (withParlox && got["/.well-known/parlox-verify"].body !== TOKEN) throw new Error(`${f.name}: the ownership check was not answered`);
  }
}

// A fixture's copy (with its node_modules) is removed once its checks pass; a failing one is kept, and named, so it can
// be looked at.
function run(src, f, withParlox) {
  const dir = prepare(src, withParlox, f.host);
  try { check(dir, f, withParlox); }
  catch (err) { err.message += `\n(kept for inspection: ${dir})`; throw err; }
  rmSync(dir, { recursive: true, force: true });
}

let failed = 0;
for (const f of manifest.fixtures.filter((x) => x.e2e)) {
  const src = join(here, "test", "fixtures", f.dir);
  try {
    run(src, f, false);
  } catch (err) { failed++; console.error(`FIXTURE PROBLEM ${f.name} (the untouched fixture fails its own checks):\n${err.message}`); continue; }
  try {
    run(src, f, true);
    console.log(`ok  ${f.name}${f.e2e.typecheck === false ? ` (no type check: ${f.e2e.why})` : ""}`);
  } catch (err) { failed++; console.error(`FAIL ${f.name}:\n${err.message}`); }
}
if (!failed) rmSync(packs, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
