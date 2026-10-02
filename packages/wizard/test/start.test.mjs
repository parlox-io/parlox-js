import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { start, summary } from "../dist/start.js";
import { main } from "../dist/cli.js";
import { BROWSER_VERSION, SERVER_VERSION } from "../dist/versions.js";
import { WizardStore } from "../dist/tui/store.js";
import { startFakeAuth, startFakeGateway } from "./fake-servers.mjs";
import { fixture, pkg, read } from "./helpers.mjs";

const ENTER_ALT = "\x1b[?1049h", LEAVE_ALT = "\x1b[?1049l";
const OLD_KEY = "sk_" + "e".repeat(64);
const LOCAL_KEY = "sk_parlox_" + "d".repeat(64); // what the fake gateway returns for a new key
const LOG_KEY = "sk_parlox_" + "a".repeat(64);
const layout = `export default function RootLayout({ children }) {\n  return (\n    <html>\n      <body>{children}</body>\n    </html>\n  );\n}\n`;
const G = ["-c", "user.email=t@t", "-c", "user.name=t"];
const gitInit = (dir) => { execFileSync("git", [...G, "init", "-q"], { cwd: dir }); execFileSync("git", [...G, "add", "-A"], { cwd: dir }); execFileSync("git", [...G, "commit", "-qm", "init"], { cwd: dir }); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// A terminal as Ink sees one: a TTY of 120 × 40 that records what is written, and a keyboard the test types on.
class Out extends EventEmitter {
  constructor(tty = true) { super(); this.isTTY = tty; this.columns = 120; this.rows = 40; this.chunks = []; }
  write(d, cb) { this.chunks.push(String(d)); if (typeof cb === "function") cb(); return true; }
  get text() { return this.chunks.join(""); }
  /** What was written after the full screen was left: the plain-text summary. */
  get after() { const t = this.text; const i = t.lastIndexOf(LEAVE_ALT); return i < 0 ? t : t.slice(i + LEAVE_ALT.length); }
}
class In extends EventEmitter {
  constructor(tty = true) { super(); this.isTTY = tty; this.data = null; }
  type(d) { this.data = d; this.emit("readable"); this.emit("data", d); }
  read() { const d = this.data; this.data = null; return d; }
  setEncoding() {} setRawMode() {} resume() {} pause() {} ref() {} unref() {}
}
/** Types `d` once the full screen listens for keys: Ink is loaded only when the full screen starts, and a key typed
 * before the screen is drawn goes nowhere (as in a real terminal). */
function typeWhenReady(stdin, d) {
  let tries = 0;
  const attempt = () => { if (stdin.listenerCount("readable") > 0) stdin.type(d); else if (++tries < 1000) setTimeout(attempt, 10); };
  setTimeout(attempt, 40);
}
/** Types `key` every 20 ms (for at most 10 s) until `done()` is true. The app reads each key with the state it last
 * rendered, so a key sent just after the store changed can be read against the screen before (where these keys do
 * nothing) and has to be sent again. Waiting for the text to be drawn instead would not work under CI=true, where
 * Ink draws nothing until it exits. */
function typeUntil(stdin, key, done) {
  let tries = 0;
  const attempt = () => { if (done() || tries++ >= 500) return; stdin.type(key); setTimeout(attempt, 20); };
  attempt();
}
const io = (tty = true) => ({ stdout: new Out(tty), stdin: new In(tty), env: { TERM: "xterm-256color", ...(process.platform === "win32" ? { WT_SESSION: "1" } : {}) } });
const never = () => { throw new Error("nothing should run"); };

async function servers(t) {
  const auth = await startFakeAuth({ decide: "approve" });
  const gw = await startFakeGateway({ sites: [{ id: "11111111-1111-1111-1111-111111111111", name: "Shop", domain: "shop.example.com", public_key: "pk_" + "a1".repeat(12), verified: false }], keys: [] });
  t.after(() => { auth.close(); gw.close(); });
  const config = { gateway: gw.url, supabaseUrl: auth.url, clientId: "wiz", apiKey: "test-publishable-key", ports: [53794, 53795], dashboard: "https://app.parlox.io" };
  const opened = [];
  const open = (url) => { opened.push(url); if (!url.includes("newKey")) fetch(url).catch(() => {}); };
  return { auth, gw, config, open, opened };
}

/** Types into the full screen as a person would, reacting to what the store shows: Enter to start, Yes to the
 * Apply question, Enter once the done card is drawn. */
function drive(store, { stdin }, extra = () => {}) {
  let seenPrompt = null, finished = false;
  store.subscribe(() => {
    const s = store.getSnapshot();
    if (s.prompt && s.prompt !== seenPrompt) { seenPrompt = s.prompt; if (/^Apply these changes/.test(s.prompt.message)) setTimeout(() => store.answer(true), 20); }
    // Until the app is closing or gone (Enter before the done card is drawn does nothing).
    if (s.step === "done" && !finished) { finished = true; typeUntil(stdin, "\r", () => store.getSnapshot().closing !== null || stdin.listenerCount("readable") === 0); }
    extra(s);
  });
  typeWhenReady(stdin, "\r");
}

test("full screen: the flow runs on the screen; after exit the terminal is restored and the warnings, the report and the hand-off are printed as plain text, each link on a line of its own", async (t) => {
  const { config, open, opened } = await servers(t);
  const dir = fixture({ "package.json": pkg(), "package-lock.json": "{}", "app/layout.tsx": layout, "netlify.toml": "", ".gitignore": ".env*.local\n", ".env.local": `OTHER=${OLD_KEY}\n` });
  gitInit(dir);
  const t0 = io();
  const store = new WizardStore();
  drive(store, t0);
  const run = (_cmd, _args, opts) => { opts.onLine?.(`added 2 packages ${LOG_KEY}`); return { status: 0, stdout: "", stderr: "" }; };
  const code = await start(["--site", "shop.example.com", "--skip-check", "--local-key"], { cwd: dir, config, open, run }, { ...t0, store });
  assert.equal(code, 0);
  const all = t0.stdout.text;
  assert.ok(all.indexOf(ENTER_ALT) >= 0 && all.lastIndexOf(LEAVE_ALT) > all.indexOf(ENTER_ALT), "entered and left the alternate screen");
  for (const key of [OLD_KEY, LOCAL_KEY, LOG_KEY]) assert.equal(all.includes(key), false, "no key anywhere in the output");
  const after = t0.stdout.after;
  const lines = after.split("\n");
  const at = (re) => lines.findIndex((l) => re.test(l));
  assert.ok(at(/^▲ A separate key "wizard · local dev/) >= 0, "the --local-key warning");
  assert.ok(at(/^Parlox is installed$/) > at(/^▲ /), "the report after the warnings");
  assert.ok(at(/^Server part: not checked\.$/) > at(/^Parlox is installed$/));
  assert.ok(at(/^Connect your host$/) > at(/^Server part/), "the hand-off after the report");
  assert.ok(lines.includes("Set on Netlify:"));
  assert.ok(lines.includes("Create the secret key here (shown once):"));
  const link = "https://app.parlox.io/sites/11111111-1111-1111-1111-111111111111?newKey=Netlify%20%C2%B7%20production&scope=fetch#keys";
  assert.ok(lines.some((l) => l.trim() === link), "the key link alone on its line");
  assert.ok(lines.some((l) => l.trim() === "https://docs.netlify.com/build/environment-variables/get-started/"), "the docs link alone on its line");
  assert.ok(lines.includes("Where to paste: Project configuration → Environment variables"));
  assert.ok(lines.some((l) => l.trim() === "https://app.parlox.io"), "the report's dashboard link alone on its line");
  assert.ok(opened.includes(link), "the hand-off link was opened in the browser");
  assert.equal(after.includes("\x1b["), false, "plain text: no escape codes after the screen is restored");
});

test("full screen: q then y during the package install stops it; the command to finish it is printed", async (t) => {
  const { config, open } = await servers(t);
  const dir = fixture({ "package.json": pkg(), "package-lock.json": "{}", "app/layout.tsx": layout, "netlify.toml": "", ".gitignore": ".env*.local\n" });
  gitInit(dir);
  const t0 = io();
  const store = new WizardStore();
  let typed = false;
  drive(store, t0, (s) => {
    if (!typed && s.tasks.install.status === "active") { typed = true; setTimeout(() => { t0.stdin.type("q"); typeUntil(t0.stdin, "y", () => store.getSnapshot().closing !== null); }, 30); }
  });
  const run = (_cmd, _args, opts) => new Promise((resolve) => opts.signal.addEventListener("abort", () => resolve({ status: null, stdout: "", stderr: "", aborted: true }), { once: true }));
  const code = await start(["--site", "shop.example.com", "--skip-check"], { cwd: dir, config, open, run }, { ...t0, store });
  assert.equal(code, 130);
  assert.match(t0.stdout.after, /▲ The package install was interrupted\. Your files were changed; finish it with: npm install --save-exact @parlox\/browser@/);
  assert.match(t0.stdout.after, /Stopped\. The changes already applied stay; the lines above say what is left\./);
});

// One contract for both faces: a cancelled question is a stop, never an answer. After the files were
// written it says what is left (the host) with the hand-off, and ends "Stopped. The changes already applied stay.";
// before, nothing was changed.
const vercelApp = () => {
  const dir = fixture({ "package.json": pkg(), "package-lock.json": "{}", "app/layout.tsx": layout, ".vercel/project.json": JSON.stringify({ projectName: "shop-prod" }), ".gitignore": ".vercel\n.env*.local\n" });
  gitInit(dir);
  return dir;
};
const VERCEL_QUESTION = /^Set PARLOX_SECRET_KEY and PARLOX_VERIFY_TOKEN on the Vercel project/;

test("full screen: q at the Vercel question after the files were written prints what is left: the host warning and the hand-off", async (t) => {
  const { gw, config, open } = await servers(t);
  const dir = vercelApp();
  const t0 = io();
  const store = new WizardStore();
  let typed = false;
  drive(store, t0, (s) => {
    if (!typed && s.prompt && VERCEL_QUESTION.test(s.prompt.message)) { typed = true; typeUntil(t0.stdin, "q", () => store.getSnapshot().prompt === null); }
  });
  const code = await start(["--site", "shop.example.com", "--skip-check"], { cwd: dir, config, open, run: ok }, { ...t0, store });
  assert.equal(code, 1);
  assert.deepEqual(gw.state.keys, [], "no key created");
  const after = t0.stdout.after;
  assert.match(after, /^▲ Stopped before your host was connected\./m);
  assert.match(after, /^Connect your host$/m);
  assert.match(after, /^Set on Vercel:$/m);
  assert.match(after, /^ {2}PARLOX_VERIFY_TOKEN=vt_fake$/m);
  assert.match(after, /Stopped\. The changes already applied stay\.\n$/);
  assert.doesNotMatch(after, /Nothing else was changed/);
});

test("plain face: a cancelled Vercel question after the files were written prints the same, and says the changes stay", async (t) => {
  const { gw, config, open } = await servers(t);
  const dir = vercelApp();
  const out = [];
  const ui = { info: (m) => out.push(m), warn: (m) => out.push(`WARN ${m}`), confirm: async (m) => { if (VERCEL_QUESTION.test(m)) throw new Error("Cancelled."); return true; }, select: async (_m, o) => o[0].value, text: async () => "" };
  const t0 = io(false);
  const code = await start(["--yes", "--site", "shop.example.com", "--skip-check"], { ui, cwd: dir, config, open, run: ok }, t0);
  assert.equal(code, 1);
  assert.deepEqual(gw.state.keys, []);
  assert.ok(out.some((m) => m.startsWith("WARN Stopped before your host was connected.")), JSON.stringify(out));
  assert.ok(out.some((m) => m.startsWith("Connect your host\nSet on Vercel:\n") && m.includes("  PARLOX_VERIFY_TOKEN=vt_fake")), JSON.stringify(out));
  assert.equal(out.some((m) => /Nothing else was changed/.test(m)), false, JSON.stringify(out));
  assert.match(t0.stdout.text, /Stopped\. The changes already applied stay\./);
});

test("both faces: a question cancelled before the files were written changes nothing and says so", async (t) => {
  const { config, open } = await servers(t);
  // Plain (--plain in a terminal): the Apply question cancelled.
  {
    const dir = vercelApp();
    const out = [];
    const ui = { info: (m) => out.push(m), warn: (m) => out.push(`WARN ${m}`), confirm: async (m) => { if (/^Apply these changes/.test(m)) throw new Error("Cancelled."); return true; }, select: async (_m, o) => o[0].value, text: async () => "" };
    const t0 = io();
    assert.equal(await start(["--plain", "--site", "shop.example.com", "--skip-check"], { ui, cwd: dir, config, open, run: never }, t0), 1);
    assert.equal(read(dir, "app/layout.tsx"), layout);
    assert.ok(out.includes("Cancelled. Nothing else was changed."), JSON.stringify(out));
    assert.equal(out.some((m) => /host was connected|Connect your host/.test(m)), false, JSON.stringify(out));
    assert.match(t0.stdout.text, /Stopped\. Nothing else was changed\./);
    assert.doesNotMatch(t0.stdout.text, /already applied/);
  }
  // Full screen: q at the Apply question.
  {
    const dir = vercelApp();
    const t0 = io();
    const store = new WizardStore();
    let typed = false;
    store.subscribe(() => {
      const p = store.getSnapshot().prompt;
      if (!typed && p && /^Apply these changes/.test(p.message)) { typed = true; typeUntil(t0.stdin, "q", () => store.getSnapshot().prompt === null); }
    });
    typeWhenReady(t0.stdin, "\r");
    assert.equal(await start(["--site", "shop.example.com", "--skip-check"], { cwd: dir, config, open, run: never }, { ...t0, store }), 1);
    assert.equal(read(dir, "app/layout.tsx"), layout);
    assert.match(t0.stdout.after, /Stopped\. Nothing else was changed\.\n$/);
    assert.doesNotMatch(t0.stdout.after, /host was connected|already applied/);
  }
});

// The plain face runs the install in the terminal itself (the package manager may ask); the full
// screen owns the terminal and keeps the pipe, and when the install fails there, the command to run by hand is printed.
test("plain face: the package install runs in the terminal itself; the full screen keeps it piped", async (t) => {
  const { config, open } = await servers(t);
  const seen = [];
  const run = (cmd, args, opts) => { seen.push({ cmd, args, opts }); return { status: 0, stdout: "", stderr: "" }; };
  const quiet = { info() {}, warn() {}, confirm: async () => true, select: async (_m, o) => o[0].value, text: async () => "" };
  const dir = fixture({ "package.json": pkg(), "package-lock.json": "{}", "app/layout.tsx": layout, ".gitignore": ".env*.local\n" });
  gitInit(dir);
  assert.equal(await start(["--yes", "--no-vercel", "--site", "shop.example.com", "--skip-check"], { ui: quiet, cwd: dir, config, open, run }, io(false)), 0);
  const install = seen.find((c) => c.cmd === "npm" && c.args[0] === "install");
  assert.equal(install.opts.interactive, true, "the plain face's install is interactive");

  const full = fixture({ "package.json": pkg(), "package-lock.json": "{}", "app/layout.tsx": layout, "netlify.toml": "", ".gitignore": ".env*.local\n" });
  gitInit(full);
  seen.length = 0;
  const failing = (cmd, args, opts) => { seen.push({ cmd, args, opts }); return { status: 1, stdout: "", stderr: "ERR_PNPM_SOMETHING" }; };
  const t0 = io();
  const store = new WizardStore();
  drive(store, t0);
  assert.equal(await start(["--site", "shop.example.com", "--skip-check"], { cwd: full, config, open, run: failing }, { ...t0, store }), 1);
  assert.equal(seen[0].opts.interactive, undefined, "the full screen keeps the pipe");
  assert.match(t0.stdout.after, /^▲ The package manager reported an error\. Run it yourself: npm install --save-exact @parlox\/browser@\S+ @parlox\/server@\S+$/m);
});

// Residual 4: the closing line says the changes stay only when files were actually written. A target that cannot be
// written (here a read-only layout) is refused by the check before the first write, so nothing is
// changed. A write that fails after the check has passed (here .env.local, made read-only once the layout has landed)
// leaves the earlier changes in place.
test("both faces: a target the check refuses changes nothing; a write that fails after the check says the changes stay", { skip: process.platform === "win32" || process.getuid?.() === 0 }, async (t) => {
  const { config, open } = await servers(t);
  const app = (readOnly) => {
    const dir = fixture({ "package.json": pkg(), "package-lock.json": "{}", "app/layout.tsx": layout, "netlify.toml": "", ".gitignore": ".env*.local\n", ...(readOnly === ".env.local" ? { ".env.local": "OTHER=1\n" } : {}) });
    gitInit(dir);
    // Read-only from the start: the check refuses it.
    if (readOnly === "app/layout.tsx") chmodSync(join(dir, readOnly), 0o444);
    return dir;
  };
  // Makes .env.local read-only once the first change has landed ("review" done): the check has passed by then, and
  // .env.local is written after the layout.
  const afterCheck = (dir, readOnly) => { let done = readOnly !== ".env.local"; return () => { if (!done) { done = true; chmodSync(join(dir, ".env.local"), 0o444); } }; };
  const quiet = { info() {}, warn() {}, confirm: async () => true, select: async (_m, o) => o[0].value, text: async () => "" };
  for (const [readOnly, closing] of [["app/layout.tsx", /Stopped\. Nothing else was changed\./], [".env.local", /Stopped\. The changes already applied stay\./]]) {
    // Plain face (no terminal, --yes).
    const dir = app(readOnly);
    const inject = afterCheck(dir, readOnly);
    const t0 = io(false);
    const ui = { ...quiet, step: (id, status) => { if (id === "review" && status === "done") inject(); } };
    assert.equal(await start(["--yes", "--site", "shop.example.com", "--skip-check"], { ui, cwd: dir, config, open, run: ok }, t0), 1);
    assert.match(t0.stdout.text, closing, `plain, ${readOnly}`);
    if (readOnly === "app/layout.tsx") assert.doesNotMatch(t0.stdout.text, /already applied/);
    // Full screen.
    const full = app(readOnly);
    const injectFull = afterCheck(full, readOnly);
    const t1 = io();
    const store = new WizardStore();
    store.subscribe(() => { if (store.getSnapshot().steps.review === "done") injectFull(); });
    drive(store, t1);
    assert.equal(await start(["--site", "shop.example.com", "--skip-check"], { cwd: full, config, open, run: ok }, { ...t1, store }), 1);
    assert.match(t1.stdout.after, closing, `full screen, ${readOnly}`);
    if (readOnly === "app/layout.tsx") {
      assert.doesNotMatch(t1.stdout.after, /already applied|host was connected/);
      assert.match(t1.stdout.after, /Cannot write app\/layout\.tsx \(permission denied\)\. Nothing was changed/, "refused by the check");
    } else assert.match(t1.stdout.after, /Could not write \.env\.local \(permission denied\)\. The changes before it were written/, "failed after the check");
  }
});

test("full screen: q on the welcome screen changes nothing and restores the terminal", async () => {
  const t0 = io();
  const store = new WizardStore();
  typeWhenReady(t0.stdin, "q");
  const code = await start([], { run: never, open: never }, { ...t0, store });
  assert.equal(code, 0);
  assert.ok(t0.stdout.text.includes(LEAVE_ALT));
  assert.match(t0.stdout.after, /Stopped\. Nothing was changed\./);
});

test("full screen: the welcome screen knows --local-key was given", async () => {
  const t0 = io();
  typeWhenReady(t0.stdin, "q");
  assert.equal(await start(["--local-key"], { run: never, open: never }, { ...t0, store: new WizardStore() }), 0);
  const drawn = t0.stdout.text.slice(0, t0.stdout.text.lastIndexOf(LEAVE_ALT)).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\s+/g, " ");
  assert.match(drawn, /because you asked \(--local-key\)/);
});

test("full screen: SIGTERM restores the terminal and exits 143", async () => {
  const t0 = io();
  const store = new WizardStore();
  const before = process.listenerCount("SIGTERM");
  const send = () => (t0.stdin.listenerCount("readable") > 0 ? process.emit("SIGTERM") : setTimeout(send, 10));
  setTimeout(send, 40);
  const code = await start([], { run: never, open: never }, { ...t0, store });
  assert.equal(code, 143);
  assert.ok(t0.stdout.text.includes(LEAVE_ALT));
  assert.equal(process.listenerCount("SIGTERM"), before, "start removed its own handler");
});

test("plain face when not a terminal, or with --plain; --plain is removed before the arguments are parsed", async () => {
  // The not-a-terminal case also needs --yes: without a terminal and without it, start() now refuses before
  // parsing reaches "--bogus" at all (the no-terminal guard, tested on its own below).
  for (const [tty, argv] of [[false, ["--yes", "--bogus"]], [true, ["--plain", "--bogus"]]]) {
    const t0 = io(tty);
    const out = [];
    const ui = { info: (m) => out.push(m), warn: (m) => out.push(`WARN ${m}`), confirm: async () => true, select: async (_m, o) => o[0].value, text: async () => "" };
    const code = await start(argv, { ui, run: never, open: never }, t0);
    assert.equal(code, 1);
    assert.equal(t0.stdout.text.includes(ENTER_ALT), false, "no full screen");
    assert.ok(out.some((m) => /Unknown option: --bogus/.test(m)), JSON.stringify(out));
    assert.equal(out.some((m) => /Unknown option: --plain/.test(m)), false);
  }
});

// The no-terminal guard lives in start(), next to the face choice: nothing can answer a question if stdin is not a
// terminal, so it refuses at once, before sign-in, before any network call, and before the face is even chosen —
// for install, uninstall and --dry-run alike. Same principle as the Vercel CLI, which refuses a confirmation
// without a TTY ("requires confirmation. Use option --yes").
test("no terminal to answer in, and no --yes: refused at once, for install, uninstall and --dry-run alike; no network call", async (t) => {
  const { auth, gw, config, open } = await servers(t);
  const dir = fixture({ "package.json": pkg(), "package-lock.json": "{}", "app/layout.tsx": layout, ".gitignore": ".env*.local\n" });
  gitInit(dir);
  for (const argv of [[], ["uninstall"], ["--dry-run"]]) {
    const t0 = io(false);
    const code = await start(argv, { cwd: dir, config, open: never, run: never }, t0);
    assert.equal(code, 1, JSON.stringify(argv));
    // --yes alone is not enough when a question remains; the message names what else to pass.
    assert.equal(t0.stdout.text, NO_TERMINAL, JSON.stringify(argv));
    assert.equal(t0.stdout.text.includes(ENTER_ALT), false, "no full screen");
  }
  assert.equal(auth.tokenRequests.length, 0, "no sign-in request reached the fake auth server");
  assert.equal(gw.calls.length, 0, "no request reached the fake gateway");
});

// With no terminal, a question is never waited on. The plain face's questions refuse at once, naming
// the question and what to pass instead; nothing is created.
const NO_TERMINAL = "No terminal to answer questions in. Run it in a terminal, or unattended with --yes --site <domain> (the site is created if your account does not have it) and, if the project is linked to Vercel, --vercel or --no-vercel; in a monorepo, run it from the app's own folder or pass --app <folder> for each app to include. A question left to answer stops an unattended run.\n";
test("no terminal, --yes, but a question remains: it is refused at once with what to pass; nothing is created", async (t) => {
  const { gw, config, open } = await servers(t);
  const vercel = { ".vercel/project.json": JSON.stringify({ projectName: "shop-prod" }), ".gitignore": ".vercel\n.env*.local\n" };
  const cases = [
    // The site: the account has sites, and no --site says which.
    [["--yes", "--no-vercel", "--skip-check"], {}, "No terminal to answer: Which site is this project? Pass --site <domain>."],
    // The Vercel question: a linked, logged-in project, and neither --vercel nor --no-vercel.
    [["--yes", "--site", "shop.example.com", "--skip-check"], vercel, 'No terminal to answer: Set PARLOX_SECRET_KEY and PARLOX_VERIFY_TOKEN on the Vercel project "shop-prod" (production)? Pass --vercel or --no-vercel.'],
  ];
  for (const [argv, files, message] of cases) {
    const dir = fixture({ "package.json": pkg(), "package-lock.json": "{}", "app/layout.tsx": layout, ".gitignore": ".env*.local\n", ...files });
    gitInit(dir);
    const t0 = io(false);
    const code = await start(argv, { cwd: dir, config, open, run: ok }, t0);
    assert.equal(code, 1, message);
    assert.ok(t0.stdout.text.includes(message), `${message}\n${t0.stdout.text}`);
    assert.deepEqual(gw.state.keys, [], "no key created");
  }
  assert.equal(gw.calls.some((c) => c.method === "POST"), false, "no site or key created");
  // The app: a monorepo with two apps, started at its root.
  const mono = fixture({ "package.json": JSON.stringify({ name: "m", private: true, workspaces: ["apps/*"] }), "package-lock.json": "{}", ".gitignore": ".env*.local\n", "apps/web/package.json": pkg(), "apps/web/app/layout.tsx": layout, "apps/shop/package.json": pkg(), "apps/shop/app/layout.tsx": layout });
  gitInit(mono);
  const t1 = io(false);
  assert.equal(await start(["--yes", "--no-vercel", "--site", "shop.example.com", "--skip-check"], { cwd: mono, config, open: never, run: never }, t1), 1);
  assert.ok(t1.stdout.text.includes("No terminal to answer: Which apps should Parlox be installed in? Run it from the app's own folder, or pass --app <folder> for each app to include (apps/shop, apps/web)."), t1.stdout.text);
});

// Under --yes, --site with a domain the account does not have creates that site without asking
// (Vercel's precedent: `vercel link --yes` creates the project it does not find), named after the domain.
test("no terminal, --yes --site <new domain>: the site is created without a question, and the report says so", async (t) => {
  const { gw, config, open } = await servers(t);
  const dir = fixture({ "package.json": pkg(), "package-lock.json": "{}", "app/layout.tsx": layout, ".gitignore": ".env*.local\n" });
  gitInit(dir);
  const t0 = io(false);
  const code = await start(["--yes", "--no-vercel", "--site", "new.example.com", "--skip-check"], { cwd: dir, config, open, run: ok }, t0);
  assert.equal(code, 0, t0.stdout.text);
  assert.deepEqual(gw.calls.filter((c) => c.method === "POST" && c.path === "/v1/wizard/sites").map((c) => c.body), [{ name: "new.example.com", domain: "new.example.com" }]);
  assert.ok(t0.stdout.text.includes("Created the site new.example.com in your Parlox account."), t0.stdout.text);
  assert.doesNotMatch(t0.stdout.text, /No terminal to answer/);
});

test("no terminal to answer in, but --yes: runs as before", async (t) => {
  const { auth, config, open } = await servers(t);
  const dir = fixture({ "package.json": pkg(), "package-lock.json": "{}", "app/layout.tsx": layout, ".gitignore": ".env*.local\n" });
  gitInit(dir);
  const out = [];
  const ui = { info: (m) => out.push(m), warn: (m) => out.push(`WARN ${m}`), confirm: async () => true, select: async (_m, o) => o[0].value, text: async () => "", report: (lines, title) => out.push(title, ...lines) };
  const code = await start(["--yes", "--no-vercel", "--site", "shop.example.com", "--skip-check"], { ui, cwd: dir, config, open, run: ok }, io(false));
  assert.equal(code, 0);
  assert.ok(auth.tokenRequests.length > 0, "sign-in reached the fake auth server");
  assert.ok(out.includes("Parlox is installed"), JSON.stringify(out));
});

test("a TTY is present: the no-terminal guard does not apply, even without --yes", async (t) => {
  const { config, open } = await servers(t);
  const dir = fixture({ "package.json": pkg(), "package-lock.json": "{}", "app/layout.tsx": layout, ".gitignore": ".env*.local\n" });
  gitInit(dir);
  const t0 = io();
  const store = new WizardStore();
  drive(store, t0);
  const code = await start(["--site", "shop.example.com", "--skip-check"], { cwd: dir, config, open, run: ok }, { ...t0, store });
  assert.equal(code, 0);
  assert.ok(t0.stdout.text.includes(ENTER_ALT), "the full screen ran (not refused)");
});

test("after the full screen: a stop says what it left, in the plain face's words", () => {
  const s = new WizardStore();
  s.warn("This build of the wizard is missing its OAuth client id or Supabase key.");
  assert.equal(summary(s.getSnapshot(), 1), "▲ This build of the wizard is missing its OAuth client id or Supabase key.\n\nStopped. Nothing else was changed.\n");
  const q = new WizardStore(); q.step("review", "active");
  q.changes({ changes: [{ path: "app/layout.tsx", before: "a\n", after: "a\nb\n" }], install: null, manual: [], warnings: [] }, "shop", "install");
  assert.equal(summary(q.getSnapshot(), 130), "Stopped. Nothing was changed.\n");
  q.step("review", "done");
  assert.equal(summary(q.getSnapshot(), 143), "Stopped. The changes already applied stay; the lines above say what is left.\n");
  const done = new WizardStore(); done.report(["Nothing was changed."], "Dry run");
  assert.equal(summary(done.getSnapshot(), 0), "Dry run\nNothing was changed.\n");
});

// The review step can end "done" with nothing applied (the app was already installed): a stop after it changed
// nothing in this run. A run that reached the done card finished: no "Stopped" line, unless the person left while
// it was still signing out.
test("after the full screen: 'the changes already applied stay' only when this run applied some", () => {
  const already = new WizardStore(); already.step("review", "active"); already.info("Parlox is already installed in this app. Nothing to change."); already.step("review", "done");
  assert.equal(summary(already.getSnapshot(), 130), "● Parlox is already installed in this app. Nothing to change.\n\nStopped. Nothing was changed.\n");
  const done = new WizardStore(); done.report(["Server part: not checked."], "Parlox is installed"); done.step("done", "done");
  assert.equal(summary(done.getSnapshot(), 0), "Parlox is installed\nServer part: not checked.\n");
  assert.equal(summary(done.getSnapshot(), 130), "Parlox is installed\nServer part: not checked.\n\nStopped while signing out; the sign-in session expires on its own within an hour.\n");
});

// The sign-in link is a live instruction; once the wizard has closed, the sign-in it belonged to has ended
// (the loopback server is gone), so it is not printed after the full screen, however the run ended.
test("after the full screen: the sign-in link is not printed again", () => {
  const link = "Approve access in your browser. If it did not open, open this link on this computer:\nhttps://auth.example/oauth/authorize?client_id=wiz";
  const s = new WizardStore(); s.step("signin", "active"); s.info(link);
  assert.equal(summary(s.getSnapshot(), 130), "Stopped. Nothing was changed.\n");
  assert.equal(summary(s.getSnapshot(), 143), "Stopped. Nothing was changed.\n");
  s.warn("Sign-in was not completed in time. Run the wizard again.");
  assert.equal(summary(s.getSnapshot(), 1), "▲ Sign-in was not completed in time. Run the wizard again.\n\nStopped. Nothing else was changed.\n");
  const later = new WizardStore(); later.step("signin", "active"); later.info(link);
  later.step("review", "active"); later.info("Parlox is already installed in this app. Nothing to change.");
  assert.equal(summary(later.getSnapshot(), 130), "● Parlox is already installed in this app. Nothing to change.\n\nStopped. Nothing was changed.\n", "other information is still printed");
});

// The review screen lists the edits the wizard could not make with "(add by hand; shown in the summary)", and the
// report says "add it by hand (above)": the code to add is printed with the warnings, before the report. Only once
// the review is done: before it, or after a No, nothing is being installed.
test("after the full screen: the edits to make by hand are printed once the review is done, before the report", () => {
  const s = new WizardStore(); s.step("review", "active");
  s.changes({ changes: [], install: null, manual: [{ file: "proxy.ts", reason: "No middleware export found.", snippet: "export default withParlox(middleware);" }], warnings: [] }, "shop", "install");
  assert.equal(summary(s.getSnapshot(), 130), "Stopped. Nothing was changed.\n");
  s.step("review", "skipped");
  assert.equal(summary(s.getSnapshot(), 1), "Stopped. Nothing else was changed.\n");
  s.step("review", "done"); s.warn("A warning.");
  s.report(["Server part: add it by hand (above)."], "Parlox is installed"); s.step("done", "done");
  assert.equal(summary(s.getSnapshot(), 0), "▲ A warning.\n▲ proxy.ts: No middleware export found.\nAdd this by hand:\nexport default withParlox(middleware);\n\nParlox is installed\nServer part: add it by hand (above).\n");
  const u = new WizardStore(); u.step("review", "active");
  u.changes({ changes: [{ path: "app/layout.tsx", before: "a\nb\n", after: "a\n" }], install: null, manual: [{ file: "proxy.ts", reason: "This file was created for Parlox and then edited; remove it or its withParlox() line by hand.", snippet: "" }], warnings: [] }, "shop", "uninstall");
  u.step("review", "done");
  assert.match(summary(u.getSnapshot(), 0), /^▲ proxy\.ts: This file was created for Parlox and then edited; remove it or its withParlox\(\) line by hand\.\n(?!Add this by hand)/, "no empty snippet");
});

// The plan's own warnings (the middleware matcher, say) are printed with the other warnings once the
// review is done, scrubbed, and once only when the flow also sent them as messages.
test("after the full screen: the plan's warnings are printed with the other warnings, once each", () => {
  const warning = "proxy.ts: This file has its own matcher; make sure it covers /.well-known/parlox-verify.";
  const plan = { changes: [{ path: "proxy.ts", before: "a\n", after: "a\nb\n" }], install: null, manual: [], warnings: [warning, `key ${LOG_KEY}`] };
  const s = new WizardStore(); s.step("review", "active"); s.changes(plan, "shop", "install");
  assert.doesNotMatch(summary(s.getSnapshot(), 130), /matcher/, "before the review is done, nothing is being installed");
  s.step("review", "done"); s.warn("Another warning.");
  const out = summary(s.getSnapshot(), 1);
  assert.equal(out.split("\n").filter((l) => l === `▲ ${warning}`).length, 1, out);
  assert.ok(out.includes("▲ key [hidden]"), out);
  assert.equal(out.includes(LOG_KEY), false);
  const twice = new WizardStore(); twice.step("review", "active"); twice.changes(plan, "shop", "install"); twice.warn(warning); twice.step("review", "done");
  assert.equal(summary(twice.getSnapshot(), 1).split("\n").filter((l) => l === `▲ ${warning}`).length, 1, "not repeated when also sent as a message");
});

/** Holds requests whose URL contains `part` until `release()` is true (checked every 10 ms, for at most 10 s),
 * calling `onRequest` as each one starts. A gate, not a delay: the test does not depend on how fast the machine is. */
function holdFetch(t, part, release, onRequest = () => {}) {
  const real = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes(part)) {
      onRequest();
      for (let i = 0; i < 1000 && !release(); i++) await wait(10);
    }
    return real(url, opts);
  };
  t.after(() => { globalThis.fetch = real; });
}
const ok = () => ({ status: 0, stdout: "", stderr: "" });
const follow = (url) => { if (!url.includes("newKey")) fetch(url).catch(() => {}); };

/** An app where Parlox is already installed (files written, packages in package.json, committed): a new run has
 * nothing to review and goes straight on to the local key and the host. */
async function installedApp(config) {
  const dir = fixture({ "package.json": pkg(), "package-lock.json": "{}", "app/layout.tsx": layout, "netlify.toml": "", ".gitignore": ".env*.local\n" });
  gitInit(dir);
  const quiet = { info() {}, warn() {}, confirm: async () => true, select: async (_m, o) => o[0].value, text: async () => "" };
  assert.equal(await main(["--site", "shop.example.com", "--skip-check", "--yes", "--no-vercel"], { cwd: dir, config, open: follow, run: ok, ui: quiet }), 0);
  const p = JSON.parse(read(dir, "package.json"));
  p.dependencies["@parlox/browser"] = BROWSER_VERSION; p.dependencies["@parlox/server"] = SERVER_VERSION;
  writeFileSync(join(dir, "package.json"), JSON.stringify(p));
  execFileSync("git", [...G, "add", "-A"], { cwd: dir }); execFileSync("git", [...G, "commit", "-qm", "installed"], { cwd: dir });
  return dir;
}

// "Before the review is approved, quitting changes nothing." Here there is nothing left to review,
// so after the quit the flow would have gone on to create a local key, write it and open the dashboard.
test("full screen: a quit confirmed before the review changes nothing: no key, .env.local untouched, no browser, 130", async (t) => {
  const { gw, auth, config, open, opened } = await servers(t);
  const dir = await installedApp(config);
  const envBefore = read(dir, ".env.local");
  const posts = gw.calls.filter((c) => c.method === "POST").length;
  const t0 = io();
  const store = new WizardStore();
  // q, then y to "Quit now?", while the verify-token request is on its way (held until the quit is confirmed).
  holdFetch(t, "/verify-token", () => store.getSnapshot().closing === "Stopping…", () => { t0.stdin.type("q"); typeUntil(t0.stdin, "y", () => store.getSnapshot().closing !== null); });
  typeWhenReady(t0.stdin, "\r");
  const code = await start(["--site", "shop.example.com", "--skip-check", "--local-key"], { cwd: dir, config, open, run: never }, { ...t0, store });
  assert.equal(code, 130);
  assert.equal(gw.calls.filter((c) => c.method === "POST").length, posts, "no key or site created");
  assert.deepEqual(gw.state.keys, []);
  assert.equal(read(dir, ".env.local"), envBefore, ".env.local untouched");
  assert.equal(opened.some((u) => u.includes("newKey")), false, "the dashboard was not opened");
  assert.doesNotMatch(t0.stdout.after, /Parlox is installed/);
  assert.match(t0.stdout.after, /Stopped\. Nothing was changed\./);
  assert.equal(auth.logouts.length, 2, "the sign-in session was still ended (it is cleanup, not a change)");
});

test("plain face: Ctrl-C before the review changes nothing: no key, .env.local untouched, no browser, 130", async (t) => {
  const { gw, config, open, opened } = await servers(t);
  const dir = await installedApp(config);
  const envBefore = read(dir, ".env.local");
  const posts = gw.calls.filter((c) => c.method === "POST").length;
  const out = [];
  const ui = { info: (m) => out.push(m), warn: (m) => out.push(`WARN ${m}`), confirm: async () => true, select: async (_m, o) => o[0].value, text: async () => "", report: (lines, title) => out.push(title, ...lines) };
  holdFetch(t, "/verify-token", () => true, () => process.emit("SIGINT"));
  // --yes: without a terminal, start()'s no-terminal guard would otherwise refuse before this test's Ctrl-C ever
  // has anything to interrupt.
  const code = await start(["--yes", "--site", "shop.example.com", "--skip-check", "--local-key"], { ui, cwd: dir, config, open, run: never }, io(false));
  assert.equal(code, 130);
  assert.equal(gw.calls.filter((c) => c.method === "POST").length, posts, "no key or site created");
  assert.equal(read(dir, ".env.local"), envBefore, ".env.local untouched");
  assert.equal(opened.some((u) => u.includes("newKey")), false, "the dashboard was not opened");
  assert.equal(out.includes("Parlox is installed"), false, JSON.stringify(out));
});

test("full screen: SIGTERM at 'Apply these changes?' ends the flow at once, still signs out, changes nothing, 143", async (t) => {
  const { auth, config, open } = await servers(t);
  const dir = fixture({ "package.json": pkg(), "package-lock.json": "{}", "app/layout.tsx": layout, "netlify.toml": "", ".gitignore": ".env*.local\n" });
  gitInit(dir);
  const t0 = io();
  const store = new WizardStore();
  let sent = false;
  store.subscribe(() => {
    const p = store.getSnapshot().prompt;
    if (!sent && p && /^Apply these changes/.test(p.message)) { sent = true; setTimeout(() => process.emit("SIGTERM"), 20); }
  });
  typeWhenReady(t0.stdin, "\r");
  const code = await start(["--site", "shop.example.com", "--skip-check"], { cwd: dir, config, open, run: never }, { ...t0, store });
  assert.equal(code, 143);
  // Both hold only if the flow unwound (its question was cancelled) rather than being left behind after the grace.
  assert.equal(store.getSnapshot().steps.review, "skipped", "the flow ended its review step");
  assert.deepEqual(auth.logouts, ["Bearer wizard-token"], "signed out before start returned");
  assert.equal(read(dir, "app/layout.tsx"), layout, "nothing written");
  assert.match(t0.stdout.after, /Stopped\. Nothing was changed\./);
});

// The done card appears before the flow has signed out (up to 10 s). Closing it waits for that; it is not a quit.
test("full screen: Enter on the done card while signing out waits for the sign-out; the exit code is the flow's", async (t) => {
  const { auth, config, open } = await servers(t);
  const dir = fixture({ "package.json": pkg(), "package-lock.json": "{}", "app/layout.tsx": layout, "netlify.toml": "", ".gitignore": ".env*.local\n" });
  gitInit(dir);
  const t0 = io();
  const store = new WizardStore();
  // The sign-out is held until the screen says it is signing out: the done card is closed while it is pending.
  holdFetch(t, "/auth/v1/logout", () => store.getSnapshot().closing === "Signing out…");
  let signingOut = false;
  drive(store, t0, (s) => { if (s.closing === "Signing out…") signingOut = true; });
  const code = await start(["--site", "shop.example.com", "--skip-check"], { cwd: dir, config, open, run: ok }, { ...t0, store });
  assert.equal(code, 0);
  assert.equal(auth.logouts.length, 1, "the sign-out finished before the app closed");
  assert.ok(signingOut, "the screen said it was signing out");
  assert.match(t0.stdout.after, /^Parlox is installed$/m);
  assert.doesNotMatch(t0.stdout.after, /Stopped/);
});

test("full screen: a second SIGTERM during the grace restores the terminal and exits 143 at once", { timeout: 20_000 }, async () => {
  const outFile = join(mkdtempSync(join(tmpdir(), "wizard-child-")), "out.txt");
  writeFileSync(outFile, "");
  const child = spawn(process.execPath, [resolve(import.meta.dirname, "start-child.mjs"), outFile, "SIGTERM"], { stdio: "ignore" });
  const [exitCode, sig] = await new Promise((r) => child.on("exit", (c, s) => r([c, s])));
  const text = readFileSync(outFile, "utf8");
  assert.equal(sig, null, "ended by the wizard, not killed by the signal");
  assert.equal(exitCode, 143);
  assert.equal(text.includes("start() returned"), false, "left at once, without waiting for the grace to end");
  assert.ok(text.lastIndexOf(LEAVE_ALT) > text.indexOf(ENTER_ALT) && text.indexOf(ENTER_ALT) >= 0, "the terminal was restored");
});

// Ink ends by itself when a screen throws while drawing (its error boundary unmounts the app).
test("full screen: if the screen fails, the flow is stopped, the terminal restored and the error printed; exit 1", async (t) => {
  const { config, open } = await servers(t);
  const dir = fixture({ "package.json": pkg(), "package-lock.json": "{}", "app/layout.tsx": layout, "netlify.toml": "", ".gitignore": ".env*.local\n" });
  gitInit(dir);
  const t0 = io();
  const store = new WizardStore();
  let broken = false;
  store.subscribe(() => {
    const p = store.getSnapshot().prompt;
    if (broken || !p || !/^Apply these changes/.test(p.message)) return;
    broken = true;
    // A message no screen can draw (an object where text belongs): the next render throws.
    setTimeout(() => { store.state = { ...store.state, messages: [...store.state.messages, { kind: "info", text: { not: "text" } }] }; store.fact("x", "y"); }, 20);
  });
  typeWhenReady(t0.stdin, "\r");
  const code = await start(["--site", "shop.example.com", "--skip-check"], { cwd: dir, config, open, run: never }, { ...t0, store });
  assert.equal(code, 1);
  assert.equal(store.getSnapshot().steps.review, "skipped", "the flow was stopped, not left waiting on its question");
  assert.equal(read(dir, "app/layout.tsx"), layout, "nothing written");
  assert.ok(t0.stdout.text.lastIndexOf(LEAVE_ALT) > t0.stdout.text.indexOf(ENTER_ALT));
  assert.match(t0.stdout.after, /The screen stopped unexpectedly: /);
});

test("the plain face never loads Ink (with DEV=true, loading Ink prints a react-devtools warning)", () => {
  // --yes: stdin is "ignore" (no terminal); without it, start()'s no-terminal guard would refuse before parsing
  // ever reaches "--bogus".
  const r = spawnSync(process.execPath, [resolve(import.meta.dirname, "..", "dist", "bin.js"), "--plain", "--yes", "--bogus"], { encoding: "utf8", env: { ...process.env, DEV: "true" }, stdio: ["ignore", "pipe", "pipe"] });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /Unknown option: --bogus/);
  assert.doesNotMatch(r.stdout + r.stderr, /react-devtools/);
});

// Residual 5: Node's own search for a program to start (git, rundll32) reads the wizard's own environment, so the
// Windows setting is made there too, first: bin.js sets it before any other module is loaded (static imports would
// run before its first line, so everything else is imported after it).
test("bin sets NoDefaultCurrentDirectoryInExePath=1 before loading anything else", () => {
  const binPath = resolve(import.meta.dirname, "..", "dist", "bin.js");
  const code = readFileSync(binPath, "utf8");
  assert.doesNotMatch(code, /^\s*import\s/m, "no static import: it would run first");
  const set = code.indexOf('process.env.NoDefaultCurrentDirectoryInExePath = "1"');
  assert.ok(set >= 0 && set < code.indexOf("import("), code);
  // And it is set in the process that runs the wizard, when it was not set before.
  const probe = join(mkdtempSync(join(tmpdir(), "wizard-probe-")), "probe.mjs");
  writeFileSync(probe, 'process.on("exit", () => process.stderr.write(`\\nPROBE ${process.env.NoDefaultCurrentDirectoryInExePath}\\n`));\n');
  const envNoVar = { ...process.env }; delete envNoVar.NoDefaultCurrentDirectoryInExePath;
  const r = spawnSync(process.execPath, ["--import", pathToFileURL(probe).href, binPath, "--plain", "--yes", "--bogus"], { encoding: "utf8", env: envNoVar, stdio: ["ignore", "pipe", "pipe"] });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /PROBE 1\n/);
});

// CI runs the plain face, and a CI job being cancelled sends SIGTERM: the flow stops as on Ctrl-C (a running package
// manager is stopped, nothing more is changed) and still ends the sign-in session.
test("plain face: SIGTERM stops the flow like Ctrl-C: nothing written, the sign-in session ended, 143; handlers removed", async (t) => {
  const { auth, config, open } = await servers(t);
  const dir = fixture({ "package.json": pkg(), "package-lock.json": "{}", "app/layout.tsx": layout, "netlify.toml": "", ".gitignore": ".env*.local\n" });
  gitInit(dir);
  // Ink, loaded by the tests above, leaves a signal-exit listener that ends the process on a signal nobody else
  // handles; this no-op keeps the test process alive whatever the face does.
  const keepAlive = () => {};
  process.on("SIGTERM", keepAlive);
  t.after(() => process.off("SIGTERM", keepAlive));
  const before = { term: process.listenerCount("SIGTERM"), int: process.listenerCount("SIGINT") };
  const out = [];
  const ui = { info: (m) => out.push(m), warn: (m) => out.push(`WARN ${m}`), confirm: async () => true, select: async (_m, o) => o[0].value, text: async () => "", report: (lines, title) => out.push(title, ...lines) };
  holdFetch(t, "/verify-token", () => true, () => process.emit("SIGTERM"));
  // --yes: without a terminal, start()'s no-terminal guard would otherwise refuse before the SIGTERM has anything
  // to stop.
  const code = await start(["--yes", "--site", "shop.example.com", "--skip-check"], { ui, cwd: dir, config, open, run: never }, io(false));
  assert.equal(code, 143);
  assert.equal(read(dir, "app/layout.tsx"), layout, "nothing written");
  assert.deepEqual(auth.logouts, ["Bearer wizard-token"], "signed out");
  assert.equal(out.includes("Parlox is installed"), false, JSON.stringify(out));
  assert.deepEqual({ term: process.listenerCount("SIGTERM"), int: process.listenerCount("SIGINT") }, before, "the face removed its handlers");
});

// A signal that arrives once the run has finished (here, while it is signing out) does not turn it into a stop: the
// exit code is the run's (0), as in the full face. A stop never makes the flow return 0.
test("plain face: Ctrl-C during the sign-out after a finished run: exit 0 and 'Done.', not 'Interrupted.'", async (t) => {
  const { auth, config, open } = await servers(t);
  const dir = fixture({ "package.json": pkg(), "package-lock.json": "{}", "app/layout.tsx": layout, "netlify.toml": "", ".gitignore": ".env*.local\n" });
  gitInit(dir);
  const out = [];
  const ui = { info: (m) => out.push(m), warn: (m) => out.push(`WARN ${m}`), confirm: async () => false, select: async (_m, o) => o[0].value, text: async () => "", report: (lines, title) => out.push(title, ...lines) };
  holdFetch(t, "/auth/v1/logout", () => true, () => process.emit("SIGINT"));
  const t0 = io(false);
  const code = await start(["--yes", "--no-vercel", "--site", "shop.example.com", "--skip-check"], { ui, cwd: dir, config, open, run: ok }, t0);
  assert.ok(out.includes("Parlox is installed"), JSON.stringify(out));
  assert.equal(code, 0);
  assert.equal(auth.logouts.length, 1);
  assert.match(t0.stdout.text, /Done\./);
  assert.doesNotMatch(t0.stdout.text, /Interrupted\./);
});
