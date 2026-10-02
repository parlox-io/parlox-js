import { execFile, spawn, type ChildProcess } from "node:child_process";

// interactive: the child uses the terminal itself (inherited stdin, stdout and stderr), so it can ask its own
// questions and its output appears as it writes it (the plain face's package install). Its output is then neither
// collected nor passed to onLine, and it takes no `input`.
export interface RunOptions { cwd: string; input?: string; onLine?: (line: string) => void; signal?: AbortSignal; interactive?: boolean }
// aborted: ended by the signal; timedOut: ended by the time limit; error: the command could not be started (its
// error code, such as "ENOENT" when it is not on the PATH).
export interface RunResult { status: number | null; stdout: string; stderr: string; aborted?: boolean; timedOut?: boolean; error?: string }
// A runner may answer synchronously (test fakes) or with a promise (the real one); every call site awaits it.
export type Runner = (cmd: string, args: string[], opts: RunOptions) => Promise<RunResult> | RunResult;

const ALLOWED = new Set(["npm", "pnpm", "yarn", "bun", "vercel"]);
const PLAIN_ARG = /^[A-Za-z0-9@._\/:=-]+$/;

// On Windows these tools are .cmd shims, which Node starts only through the shell (CVE-2024-27980). The shell is
// safe here because the command is one of five names and every argument is a plain token checked below; secrets
// never appear in arguments, only on standard input.
export function spawnSpec(cmd: string, args: string[], platform: NodeJS.Platform = process.platform): { file: string; args: string[]; shell: boolean } {
  if (!ALLOWED.has(cmd)) throw new Error(`Command not allowed: ${cmd}`);
  for (const a of args) if (!PLAIN_ARG.test(a)) throw new Error(`Refusing an unexpected argument: ${a}`);
  return platform === "win32" && cmd !== "bun" ? { file: `${cmd}.cmd`, args, shell: true } : { file: cmd, args, shell: false };
}


/** The environment every child starts with: the wizard's own, plus NoDefaultCurrentDirectoryInExePath. On Windows,
 * cmd.exe (which starts the .cmd shims) otherwise looks for a command in the current folder before PATH, so a
 * project could shadow npm.cmd or vercel.cmd with a file of its own. Set on every platform; elsewhere it does nothing. */
export const childEnv = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({ ...process.env, NoDefaultCurrentDirectoryInExePath: "1", ...extra });

export type ExecFileLike = (file: string, args: string[], opts: { windowsHide: boolean }, done: (err: Error | null) => void) => unknown;

// Ends the child and everything it started. On Windows the child is cmd.exe running the .cmd shim, so child.kill()
// would end only cmd.exe and leave npm running (holding the output pipes open); taskkill /T ends the whole tree.
// taskkill is called by its absolute path with fixed arguments; the pid is a number Node assigned.
export function killTree(child: ChildProcess, platform: NodeJS.Platform, execFileImpl: ExecFileLike = execFile): void {
  if (platform !== "win32") { child.kill("SIGTERM"); return; }
  if (typeof child.pid !== "number") return; // never started: nothing to end
  const taskkill = `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\taskkill.exe`;
  // The callback swallows taskkill's own failure (the tree already gone, say); the backstop below still settles.
  execFileImpl(taskkill, ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true }, () => {});
}

export interface RunnerOptions {
  platform?: NodeJS.Platform;
  execFileImpl?: ExecFileLike;
  timeoutMs?: number; // the time limit for one command
  graceMs?: number; // after a kill, how long to wait for the child to close before settling anyway
  forceKillMs?: number; // after a kill, when to send SIGKILL (not Windows, where taskkill /F is already forceful)
}

// Runs one allowed command without blocking the process, so a full-screen display keeps drawing while npm works.
// Output is collected, and streamed line by line to onLine; standard input carries `input` (secrets go only there).
// Aborting (the signal) or the time limit ends the child's whole process tree, and the promise always settles, even
// when the child does not close after that.
export function makeRunner(spawnImpl: typeof spawn = spawn, o: RunnerOptions = {}): Runner {
  const platform = o.platform ?? process.platform;
  const { timeoutMs = 10 * 60_000, graceMs = 2_000, forceKillMs = 5_000 } = o;
  return (cmd, args, opts) => new Promise<RunResult>((resolve) => {
    // Throws (rejecting this promise) before anything is spawned when the command or an argument is not allowed.
    const s = spawnSpec(cmd, args, platform);
    // A secret goes only on standard input; a child reading the terminal would never get it.
    if (opts.interactive && opts.input !== undefined) throw new Error("An interactive command takes no input.");
    const base = { cwd: opts.cwd, env: childEnv({ FORCE_COLOR: "0" }), stdio: opts.interactive ? ("inherit" as const) : (["pipe", "pipe", "pipe"] as ("pipe")[]) };
    // Node deprecates (DEP0190) passing an argument array together with `shell: true`. Every argument already
    // matched PLAIN_ARG (no spaces or shell metacharacters), so joining them with spaces is exactly as safe.
    const child = s.shell ? spawnImpl([s.file, ...s.args].join(" "), { ...base, shell: true }) : spawnImpl(s.file, s.args, { ...base, shell: false });
    let stdout = "", stderr = "", settled = false, closed = false, killing = false;
    let aborted = false, timedOut = false, error: string | undefined;
    let grace: NodeJS.Timeout | undefined;
    const pending = { out: "", err: "" };
    const feed = (which: "out" | "err", chunk: string) => {
      if (which === "out") stdout += chunk; else stderr += chunk;
      const parts = (pending[which] + chunk).split(/\r?\n/);
      pending[which] = parts.pop() ?? "";
      for (const line of parts) if (line.trim()) opts.onLine?.(line);
    };
    // Decoding as a stream keeps a multi-byte character split across two chunks intact.
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (d: string) => feed("out", d));
    child.stderr?.on("data", (d: string) => feed("err", d));
    const finish = (status: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(limit);
      clearTimeout(grace);
      opts.signal?.removeEventListener("abort", onAbort);
      for (const which of ["out", "err"] as const) if (pending[which].trim()) opts.onLine?.(pending[which]);
      resolve({ status, stdout, stderr, ...(aborted ? { aborted: true } : {}), ...(timedOut ? { timedOut: true } : {}), ...(error ? { error } : {}) });
    };
    const end = () => {
      if (killing) return;
      killing = true;
      killTree(child, platform, o.execFileImpl);
      // Backstop: if the child has not closed within graceMs (a grandchild still holding the pipes, say), stop
      // reading its output and settle anyway, so the wizard never waits on a process it has already ended.
      grace = setTimeout(() => { child.stdout?.destroy(); child.stderr?.destroy(); finish(null); }, graceMs);
      if (platform !== "win32") {
        // A child that ignores SIGTERM gets SIGKILL. Unref'd: this timer alone never keeps the wizard running.
        const force = setTimeout(() => { if (!closed) child.kill("SIGKILL"); }, forceKillMs);
        force.unref();
      }
    };
    const onAbort = () => { aborted = true; end(); };
    const limit = setTimeout(() => { timedOut = true; end(); }, timeoutMs);
    if (opts.signal?.aborted) onAbort(); else opts.signal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", (e: NodeJS.ErrnoException) => {
      // Only a failure to start (no pid) ends the run here; a failed kill is left to the backstop above.
      if (typeof child.pid === "number") return;
      error = e.code ?? "UNKNOWN";
      finish(null);
    });
    child.on("close", (code: number | null) => { closed = true; finish(code); });
    // A child that exits without reading its input makes this write fail with EPIPE; the exit status already
    // reports the outcome, so the write error must not crash the wizard.
    child.stdin?.on("error", () => {});
    child.stdin?.end(opts.input ?? "");
  });
}

export const defaultRunner: Runner = makeRunner();
