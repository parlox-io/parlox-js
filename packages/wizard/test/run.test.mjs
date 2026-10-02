import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSpec } from "../dist/run.js";

test("POSIX: no shell; Windows: the .cmd shim through the shell, arguments unchanged", () => {
  assert.deepEqual(spawnSpec("npm", ["install", "--save-exact", "@parlox/browser@1.0.3"], "linux"), { file: "npm", args: ["install", "--save-exact", "@parlox/browser@1.0.3"], shell: false });
  assert.deepEqual(spawnSpec("vercel", ["env", "add", "PARLOX_SECRET_KEY", "production", "--sensitive"], "win32"), { file: "vercel.cmd", args: ["env", "add", "PARLOX_SECRET_KEY", "production", "--sensitive"], shell: true });
});

test("only known commands and plain arguments are accepted", () => {
  assert.throws(() => spawnSpec("rm", ["-rf", "/"], "linux"), /not allowed/);
  assert.throws(() => spawnSpec("npm", ["install", "a & calc"], "win32"), /argument/);
  assert.throws(() => spawnSpec("npm", ["install", "$(id)"], "linux"), /argument/);
});

import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { makeRunner } from "../dist/run.js";

function fakeSpawn(script) {
  const calls = [];
  const spawnImpl = (file, args, opts) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    const chunks = []; child.stdin = new PassThrough(); child.stdin.on("data", (d) => chunks.push(String(d)));
    child.killed = false; child.kill = (sig) => { child.killed = sig; setImmediate(() => child.emit("close", null, sig)); return true; };
    calls.push({ file, args, opts, child, input: () => chunks.join("") });
    setImmediate(() => script(child));
    return child;
  };
  return { spawnImpl, calls };
}

test("the runner does not block: a timer ticks while the child is still running", async () => {
  const { spawnImpl } = fakeSpawn((child) => setTimeout(() => { child.stdout.end("done\n"); child.stderr.end(); child.emit("close", 0, null); }, 60));
  let ticks = 0; const t = setInterval(() => ticks++, 10);
  const r = await makeRunner(spawnImpl)("npm", ["install", "a@1"], { cwd: "/tmp" });
  clearInterval(t);
  assert.equal(r.status, 0);
  assert.ok(ticks >= 3, `timer ticked ${ticks} times`);
});

test("output lines stream to onLine, split across chunks, and are collected", async () => {
  const { spawnImpl } = fakeSpawn((child) => { child.stdout.write("added 2 pack"); child.stdout.write("ages\nfinished\n"); child.stdout.end(); child.stderr.end("warn x\n"); child.emit("close", 0, null); });
  const lines = [];
  const r = await makeRunner(spawnImpl)("npm", ["install", "a@1"], { cwd: "/tmp", onLine: (l) => lines.push(l) });
  assert.deepEqual(lines.sort(), ["added 2 packages", "finished", "warn x"].sort());
  assert.match(r.stdout, /added 2 packages/);
});

test("input goes to standard input, never the arguments", async () => {
  const { spawnImpl, calls } = fakeSpawn((child) => { child.stdout.end(); child.stderr.end(); child.emit("close", 0, null); });
  const secret = "sk_parlox_" + "e".repeat(64);
  await makeRunner(spawnImpl)("vercel", ["env", "add", "PARLOX_SECRET_KEY", "production", "--sensitive"], { cwd: "/tmp", input: secret });
  assert.equal(calls[0].input(), secret);
  assert.equal(JSON.stringify(calls[0].args).includes(secret), false);
});

test("aborting terminates the child and reports aborted", async () => {
  const { spawnImpl, calls } = fakeSpawn(() => {});
  const ac = new AbortController();
  const p = makeRunner(spawnImpl, { platform: "linux" })("npm", ["install", "a@1"], { cwd: "/tmp", signal: ac.signal });
  setTimeout(() => ac.abort(), 20);
  const r = await p;
  assert.equal(r.aborted, true);
  assert.equal(calls[0].child.killed, "SIGTERM");
});

test("the allowlist and argument rules still apply before anything is spawned", async () => {
  const { spawnImpl, calls } = fakeSpawn(() => {});
  await assert.rejects(Promise.resolve().then(() => makeRunner(spawnImpl)("rm", ["-rf", "/"], { cwd: "/tmp" })), /not allowed/);
  await assert.rejects(Promise.resolve().then(() => makeRunner(spawnImpl)("npm", ["install", "a & calc"], { cwd: "/tmp" })), /argument/);
  assert.equal(calls.length, 0);
});

test("Windows: aborting ends the whole process tree with taskkill (absolute path, fixed arguments), not child.kill", async () => {
  const { spawnImpl, calls } = fakeSpawn(() => {});
  const execs = [];
  const execFileImpl = (file, args, opts, cb) => { execs.push({ file, args, opts }); setImmediate(() => { calls[0].child.emit("close", 1, null); cb(null); }); };
  const origPid = 4242;
  const wrapped = (...a) => { const c = spawnImpl(...a); c.pid = origPid; return c; };
  const ac = new AbortController();
  const p = makeRunner(wrapped, { platform: "win32", execFileImpl })("npm", ["install", "a@1"], { cwd: "C:\\app", signal: ac.signal });
  setTimeout(() => ac.abort(), 10);
  const r = await p;
  assert.equal(r.aborted, true);
  assert.equal(calls[0].child.killed, false, "child.kill would end only cmd.exe and leave npm running");
  assert.equal(execs.length, 1);
  assert.equal(execs[0].file, `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\taskkill.exe`);
  assert.deepEqual(execs[0].args, ["/pid", "4242", "/T", "/F"]);
  assert.equal(execs[0].opts.windowsHide, true);
});

test("a child that never closes after it is killed still settles, and is sent SIGKILL later", async () => {
  const { spawnImpl, calls } = fakeSpawn(() => {});
  const neverCloses = (...a) => { const c = spawnImpl(...a); c.kill = (sig) => { c.killed = sig; return true; }; return c; };
  const ac = new AbortController();
  const started = Date.now();
  const p = makeRunner(neverCloses, { platform: "linux", graceMs: 20, forceKillMs: 40 })("npm", ["install", "a@1"], { cwd: "/tmp", signal: ac.signal });
  setTimeout(() => ac.abort(), 5);
  const r = await p;
  assert.equal(r.aborted, true);
  assert.ok(Date.now() - started < 1000, "settled by the backstop, not by the child");
  assert.equal(calls[0].child.stdout.destroyed, true);
  await new Promise((res) => setTimeout(res, 60));
  assert.equal(calls[0].child.killed, "SIGKILL");
});

test("the time limit ends the child and reports timedOut", async () => {
  const { spawnImpl, calls } = fakeSpawn(() => {});
  const r = await makeRunner(spawnImpl, { platform: "linux", timeoutMs: 20 })("npm", ["install", "a@1"], { cwd: "/tmp" });
  assert.equal(r.timedOut, true);
  assert.equal(r.aborted, undefined);
  assert.equal(calls[0].child.killed, "SIGTERM");
});

test("Windows: the time limit ends the whole process tree with taskkill and reports timedOut, not child.kill", async () => {
  const { spawnImpl, calls } = fakeSpawn(() => {});
  const execs = [];
  const execFileImpl = (file, args, opts, cb) => { execs.push({ file, args, opts }); setImmediate(() => { calls[0].child.emit("close", 1, null); cb(null); }); };
  const wrapped = (...a) => { const c = spawnImpl(...a); c.pid = 4243; return c; };
  const r = await makeRunner(wrapped, { platform: "win32", execFileImpl, timeoutMs: 20 })("npm", ["install", "a@1"], { cwd: "C:\\app" });
  assert.equal(r.timedOut, true);
  assert.equal(r.aborted, undefined);
  assert.equal(calls[0].child.killed, false, "child.kill would end only cmd.exe and leave npm running");
  assert.equal(execs.length, 1);
  assert.equal(execs[0].file, `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\taskkill.exe`);
  assert.deepEqual(execs[0].args, ["/pid", "4243", "/T", "/F"]);
});

test("a command that cannot be started reports its error code", async () => {
  const { spawnImpl } = fakeSpawn((child) => child.emit("error", Object.assign(new Error("spawn npm ENOENT"), { code: "ENOENT" })));
  const r = await makeRunner(spawnImpl)("npm", ["install", "a@1"], { cwd: "/tmp" });
  assert.equal(r.status, null);
  assert.equal(r.error, "ENOENT");
});

// On Windows, cmd.exe looks in the current folder before PATH, so a project could shadow npm.cmd or
// vercel.cmd with its own file. Every child is started with NoDefaultCurrentDirectoryInExePath set (harmless
// elsewhere), on every platform so the behaviour is the same everywhere.
test("every child gets NoDefaultCurrentDirectoryInExePath=1, with and without the shell", async (t) => {
  // Not inherited by chance: some environments already set it (the test would then pass without the fix).
  const saved = process.env.NoDefaultCurrentDirectoryInExePath;
  delete process.env.NoDefaultCurrentDirectoryInExePath;
  t.after(() => { if (saved !== undefined) process.env.NoDefaultCurrentDirectoryInExePath = saved; });
  for (const platform of ["linux", "win32"]) {
    const { spawnImpl, calls } = fakeSpawn((child) => { child.stdout.end(); child.stderr.end(); child.emit("close", 0, null); });
    await makeRunner(spawnImpl, { platform })("npm", ["install", "a@1"], { cwd: "/tmp" });
    // Through the shell (Windows), the command line is one string and the options come second.
    const opts = platform === "win32" ? calls[0].args : calls[0].opts;
    assert.equal(opts.env.NoDefaultCurrentDirectoryInExePath, "1", platform);
    assert.equal(opts.env.FORCE_COLOR, "0", platform);
    // On Windows the environment's names are case-insensitive, and the copy keeps the stored name (Path).
    const pathKey = (env) => Object.keys(env).find((k) => k.toLowerCase() === "path");
    assert.ok(pathKey(opts.env), `${platform}: PATH is in the child's environment`);
    assert.equal(opts.env[pathKey(opts.env)], process.env[pathKey(process.env)], `${platform}: the rest of the environment is kept`);
  }
});

// The plain face runs the package manager in the terminal itself (as before the full screen existed),
// so a package manager that asks (pnpm: "The modules directory will be removed… Proceed?") can be answered.
test("an interactive run gives the child the terminal (inherited stdio); it takes no input", async () => {
  const { spawnImpl, calls } = fakeSpawn((child) => child.emit("close", 0, null));
  const r = await makeRunner(spawnImpl, { platform: "linux" })("pnpm", ["add", "a@1"], { cwd: "/tmp", interactive: true });
  assert.equal(r.status, 0);
  assert.equal(calls[0].opts.stdio, "inherit");
  await assert.rejects(Promise.resolve().then(() => makeRunner(spawnImpl, { platform: "linux" })("vercel", ["env", "add", "X", "production"], { cwd: "/tmp", interactive: true, input: "secret" })), /no input/);
  assert.equal(calls.length, 1, "nothing spawned for the refused run");
  const piped = fakeSpawn((child) => { child.stdout.end(); child.stderr.end(); child.emit("close", 0, null); });
  await makeRunner(piped.spawnImpl, { platform: "linux" })("pnpm", ["add", "a@1"], { cwd: "/tmp" });
  assert.deepEqual(piped.calls[0].opts.stdio, ["pipe", "pipe", "pipe"], "otherwise piped, as the full screen needs");
});
