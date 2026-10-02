import type { Instance } from "ink";
import * as clack from "@clack/prompts";
import { main, type CliDeps } from "./cli.js";
import { chooseFace } from "./face.js";
import { plainUi } from "./ui/plain.js";
import { scrub } from "./ui/scrub.js";
import { HANDOFF_TITLE, handoffLines } from "./ui/handoff.js";
import { isSigninLink, withDefaults, type Ui } from "./ui/types.js";
import type { Plan } from "./plan.js";
import { WizardStore, type WizardState } from "./tui/store.js";

const ENTER_ALT = "\x1b[?1049h", LEAVE_ALT = "\x1b[?1049l";
// After a stop (a confirmed quit, Ctrl-C, SIGTERM), how long the flow gets to record what the interruption left
// behind (for example the command that finishes the install); the package runner settles within 2 s of an abort.
const STOP_GRACE_MS = 3000;

/** The terminal to run in. `store` lets a caller (a test) watch and answer the full screen. */
export interface StartIo { stdout: NodeJS.WriteStream; stdin: NodeJS.ReadStream; env?: NodeJS.ProcessEnv; store?: WizardStore }

/** Waits for `p`, but no longer than `ms`; the timer never outlives the wait. */
async function within<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;
  try { return await Promise.race([p, new Promise<undefined>((r) => { timer = setTimeout(() => r(undefined), ms); })]); }
  finally { clearTimeout(timer); }
}

/** What stays on the terminal once the full screen is gone: warnings and the edits to make by hand, then the report
 * (or, without one, the messages), then the hand-off, then how it stopped. Plain text, one link per line. The sign-in
 * link is left out: it was an instruction for the sign-in, which has ended by now. */
export function summary(s: WizardState, code: number): string {
  const out: string[] = [];
  const warned = new Set<string>();
  for (const m of s.messages) if (m.kind === "warn") { out.push(`▲ ${m.text}`); warned.add(m.text); }
  // The plan's own warnings (a middleware matcher to check, say) and the edits to make by hand: the review screen
  // says the latter are "shown in the summary", and the report points "above" to them. Only once the review is done:
  // before it, or after a No, nothing is being installed or removed. The plain face's wording; a warning the flow also
  // sent as a message is printed once.
  if (s.steps.review === "done" && s.plan) {
    for (const w of s.plan.warnings) if (!warned.has(w)) out.push(`▲ ${w}`);
    for (const m of s.plan.manual) out.push(`▲ ${m.file}: ${m.reason}`, ...(m.snippet ? ["Add this by hand:", m.snippet] : []));
  }
  if (s.report) out.push("", ...(s.reportTitle ? [s.reportTitle] : []), ...s.report);
  // String(): this also runs after a screen failed to draw, possibly because of what the state holds.
  else for (const m of s.messages) if (m.kind === "info" && !isSigninLink(String(m.text))) out.push(`● ${m.text}`);
  // Every hand-off of the run (one per app with a server part); the screen showed the latest.
  for (const h of s.handoffs?.length ? s.handoffs : s.handoff ? [s.handoff] : []) out.push("", HANDOFF_TITLE, ...handoffLines(h));
  const stopped = code === 130 || code === 143;
  const applied = changedFiles(s.steps.review === "done", s.plan);
  // The closing line, as the plain face's outro says it (a No, a cancelled question, a refusal or an error ends with
  // code 1). A run that reached the done card finished: only leaving while it was still signing out has something to
  // add.
  if (s.steps.done === "done") { if (stopped) out.push("", "Stopped while signing out; the sign-in session expires on its own within an hour."); }
  else if (stopped) out.push("", applied ? "Stopped. The changes already applied stay; the lines above say what is left." : "Stopped. Nothing was changed.");
  else if (code !== 0) out.push("", applied ? "Stopped. The changes already applied stay." : "Stopped. Nothing else was changed.");
  while (out[0] === "") out.shift();
  return out.length ? `${out.map(scrub).join("\n")}\n` : "";
}

/** Whether this run changed the project's files: the review was approved ("done") with something to apply. An app
 * already installed has a review that ends "done" with nothing applied, and a dry run applies nothing. Both faces read
 * it from what the flow showed, for their closing line. */
function changedFiles(reviewDone: boolean, plan: Plan | null): boolean {
  return reviewDone && !!plan && (plan.changes.length > 0 || !!plan.install || !!plan.installs?.length);
}

async function plain(args: string[], overrides: Partial<CliDeps>, io: StartIo): Promise<number> {
  const output = io.stdout;
  const controller = new AbortController();
  clack.intro("Parlox · Your next customer is software.", { output });
  // A stop: Ctrl-C while no question is open (an open question takes Ctrl-C itself, as a cancel), or SIGTERM (CI runs
  // the plain face, and a cancelled job sends it). The flow halts before its next side effect (a running package
  // install is stopped, an open question ends) and says what is left, and the sign-in session is still ended. What
  // does not listen for the signal (waiting for the browser sign-in, say) is left after STOP_GRACE_MS. Both handlers
  // go at the first signal: a second one ends the process at once.
  let signalCode: number | null = null;
  let grace: NodeJS.Timeout | undefined;
  let interrupted!: (code: number) => void;
  const stopped = new Promise<number>((r) => (interrupted = r));
  const onStop = (code: number) => {
    process.off("SIGINT", onInt);
    process.off("SIGTERM", onTerm);
    signalCode = code;
    controller.abort();
    grace = setTimeout(() => interrupted(code), STOP_GRACE_MS);
  };
  const onInt = () => onStop(130);
  const onTerm = () => onStop(143);
  process.on("SIGINT", onInt);
  process.on("SIGTERM", onTerm);
  // What the closing line needs to know (changedFiles), read from what the flow shows, whichever Ui shows it.
  const seen: { plan: Plan | null; reviewDone: boolean } = { plan: null, reviewDone: false };
  const shown = withDefaults(overrides.ui ?? plainUi(io.stdout, controller.signal, io.stdin));
  const ui: Ui = {
    ...shown,
    changes: (plan, target, mode) => { seen.plan = plan; shown.changes(plan, target, mode); },
    step: (id, status) => { if (id === "review") seen.reviewDone = status === "done"; shown.step(id, status); },
  };
  let code: number;
  try {
    // The package manager runs in the terminal itself here, as it always did in the plain face: it may ask.
    code = await Promise.race([main(args, { interactive: true, ...overrides, ui, signal: controller.signal }), stopped]);
  } finally {
    clearTimeout(grace);
    process.off("SIGINT", onInt);
    process.off("SIGTERM", onTerm);
  }
  // After a signal the exit code is the signal's (130 for Ctrl-C, 143 for SIGTERM), whatever the flow answered on its
  // way out (a question ended by the stop is a cancel). A run that finished (0; a stop never returns 0, the signal came
  // during the sign-out, say) keeps its code, as in the full face.
  if (signalCode !== null && code !== 0) code = signalCode;
  const applied = changedFiles(seen.reviewDone, seen.plan);
  clack.outro(code === 0 ? "Done." : applied ? "Stopped. The changes already applied stay." : code === 130 || code === 143 ? "Interrupted." : "Stopped. Nothing else was changed.", { output });
  return code;
}

async function full(args: string[], overrides: Partial<CliDeps>, io: StartIo): Promise<number> {
  // Loaded here, not at the top: the plain face never loads Ink or React (with DEV=true, loading Ink alone prints a
  // react-devtools warning).
  const [{ createElement }, { render }, { App }] = await Promise.all([import("react"), import("ink"), import("./tui/App.js")]);
  const controller = new AbortController();
  const store = io.store ?? new WizardStore();
  // How the full screen is asked to end; the first request counts:
  // - stop: a confirmed quit, Ctrl-C sent from outside the app (in the app, Ctrl-C is a key), SIGTERM;
  // - finish: the done card closed (Enter, q, Esc, Ctrl-C): the run is over, and the exit code is the flow's;
  // - crash: Ink ended by itself (a screen failed to draw).
  type End = { stop: number } | { finish: true } | { crash: unknown };
  let end!: (e: End) => void;
  const ended = new Promise<End>((r) => (end = r));
  let app: Instance | undefined;
  let entered = false, restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    try { app?.unmount(); } catch { /* already unmounted */ }
    if (entered) io.stdout.write(LEAVE_ALT);
  };
  // A second stop while the first is being handled (the flow has STOP_GRACE_MS; a sign-out up to 10 s) leaves at
  // once, with the terminal restored and what is known printed.
  let requested = false;
  const request = (e: End) => {
    if (!requested) { requested = true; end(e); return; }
    if ("stop" in e) { restore(); io.stdout.write(summary(store.getSnapshot(), e.stop)); process.exit(e.stop); }
  };
  const onFatal = (err: unknown) => { restore(); io.stdout.write(`${scrub(err instanceof Error ? err.message : String(err))}\n`); process.exit(1); };
  const onTerm = () => request({ stop: 143 });
  const onInt = () => request({ stop: 130 });
  // Kept until the terminal is restored: a second signal must find them (without them, it would end the process
  // with the full screen still up).
  process.once("uncaughtException", onFatal);
  process.on("SIGTERM", onTerm);
  process.on("SIGINT", onInt);
  let code: number;
  let crash: { err: unknown } | undefined;
  try {
    io.stdout.write(ENTER_ALT);
    entered = true;
    app = render(createElement(App, { store, localKey: args.includes("--local-key"), onFinish: () => request({ finish: true }), onQuit: () => request({ stop: 130 }) }), { stdout: io.stdout, stdin: io.stdin, exitOnCtrlC: false, patchConsole: false });
    // Ink ends by itself only when a screen throws while drawing; its own unmount (in restore) is not a crash.
    app.waitUntilExit().then(() => { if (!restored) request({ crash: undefined }); }, (err: unknown) => { if (!restored) request({ crash: err }); });

    const first = await Promise.race([store.waitForStart().then((go) => ({ go })), ended]);
    if ("go" in first && !first.go) { restore(); io.stdout.write("Stopped. Nothing was changed.\n"); return 0; }
    if (!("go" in first)) {
      restore();
      if ("crash" in first) io.stdout.write(crashLine(first.crash));
      io.stdout.write("Stopped. Nothing was changed.\n");
      return "stop" in first ? first.stop : 1;
    }

    const running = main(args, { ...overrides, ui: store, signal: controller.signal });
    const outcome = await Promise.race([running.then((c) => ({ code: c })), ended]);
    // Only the done card is left once the flow has shown it: a stop there (a signal) closes it like Enter does.
    const atDone = () => store.getSnapshot().step === "done";
    if ("code" in outcome) {
      code = outcome.code;
      // Wait on the done card only when the flow reached it and ended well; an error or an early stop exits at once.
      if (code === 0 && atDone()) { const e = await ended; if ("crash" in e) { code = 1; crash = { err: e.crash }; } }
    } else if ("finish" in outcome || ("stop" in outcome && atDone())) {
      // The done card was closed while the flow was still signing out: wait for it; the exit code is the flow's.
      store.showClosing("Signing out…");
      code = await running;
    } else {
      code = "stop" in outcome ? outcome.stop : 1;
      if ("crash" in outcome) crash = { err: outcome.crash };
      // The flow halts at its next side effect (the open question is cancelled, later ones are refused); give it time
      // to record what the stop left behind (for example the command that finishes the install) and to sign out.
      controller.abort();
      store.stop();
      await within(running.catch(() => 1), STOP_GRACE_MS);
    }
  } finally {
    restore();
    process.off("uncaughtException", onFatal);
    process.off("SIGTERM", onTerm);
    process.off("SIGINT", onInt);
  }
  io.stdout.write(`${crash ? crashLine(crash.err) : ""}${summary(store.getSnapshot(), code)}`);
  return code;
}

/** Ink ended by itself (a screen failed to draw): said once, before what the run did. */
function crashLine(err: unknown): string {
  return err === undefined ? "The screen stopped unexpectedly.\n" : `The screen stopped unexpectedly: ${scrub(err instanceof Error ? err.message : String(err))}\n`;
}

// Nothing can answer a question without a terminal: the flow would otherwise wait forever at the first one (in CI,
// until the job times out). --yes accepts the diff and the install without asking, so without it a run with no
// terminal is refused here, before anything happens. --yes alone is not always enough: the site (--site, which also
// creates a site the account does not have yet), a Vercel link (--vercel or --no-vercel) and a monorepo's apps (run
// from the app's folder, or --app) are still questions, and the plain face refuses each one it cannot ask, saying
// what to pass. Same principle as the Vercel CLI, which refuses a confirmation without a TTY ("requires confirmation.
// Use option --yes"). Applies to install, uninstall and --dry-run alike: none of them is exempt.
const NO_TERMINAL = "No terminal to answer questions in. Run it in a terminal, or unattended with --yes --site <domain> (the site is created if your account does not have it) and, if the project is linked to Vercel, --vercel or --no-vercel; in a monorepo, run it from the app's own folder or pass --app <folder> for each app to include. A question left to answer stops an unattended run.\n";

/** Chooses the face, runs the wizard, and always leaves the terminal as it found it, with the outcome in plain text.
 * `--plain` only chooses the face; it is removed before the flow parses the arguments. */
export async function start(argv: string[], overrides: Partial<CliDeps> = {}, io: StartIo = { stdout: process.stdout, stdin: process.stdin }): Promise<number> {
  // Checked here, next to the face choice, before either face starts (before sign-in, before any network call).
  if (!io.stdin.isTTY && !argv.includes("--yes")) {
    io.stdout.write(NO_TERMINAL);
    return 1;
  }
  const env = io.env ?? process.env;
  const args = argv.filter((a) => a !== "--plain");
  const face = chooseFace({ stdoutTTY: !!io.stdout.isTTY, stdinTTY: !!io.stdin.isTTY, columns: io.stdout.columns ?? 0, rows: io.stdout.rows ?? 0, env, platform: process.platform, argv });
  return face === "plain" ? plain(args, overrides, io) : full(args, overrides, io);
}
