import type { Plan } from "../plan.js";
import { HANDOFF_TITLE, handoffLines } from "./handoff.js";
import { scrub } from "./scrub.js";
import { printableDiff } from "./summary.js";

export type StepId = "detect" | "signin" | "site" | "review" | "install" | "host" | "check" | "done";
export type Status = "pending" | "active" | "done" | "failed" | "skipped";
export type TaskId = "install" | "host" | "check";
/** `notes`: what to know where the variables are set, beside them (a Worker's key is a runtime secret). */
export interface Handoff { host: string; url: string | null; where: string; docs: string | null; variables: string[]; notes?: string[] }

// Each question may carry a `hint`: how to answer it without a terminal (a flag to pass, say). The plain face gives it
// when there is no terminal to ask in; the full screen, which only runs in a terminal, ignores it.
export interface Ui {
  info(msg: string): void;
  warn(msg: string): void;
  confirm(msg: string, hint?: string): Promise<boolean>;
  select<T>(msg: string, options: Array<{ value: T; label: string }>, hint?: string): Promise<T>;
  /** Several choices; every option starts selected and at least one must stay selected. Resolves the chosen values,
   * in the options' order. */
  multiselect<T>(msg: string, options: Array<{ value: T; label: string }>, hint?: string): Promise<T[]>;
  text(msg: string, placeholder?: string, hint?: string): Promise<string>;
  step(id: StepId, status: Status): void;
  fact(label: string, value: string): void;
  changes(plan: Plan, target: string, mode: "install" | "uninstall"): void;
  task(id: TaskId, status: Status, detail?: string): void;
  log(line: string): void;
  handoff(h: Handoff): void;
  report(lines: string[], title?: string): void;
}
export type BasicUi = Pick<Ui, "info" | "warn" | "confirm" | "select" | "text"> & Partial<Ui>;

/** A question with no terminal to answer it in (stdin is not a TTY: CI, a pipe). Nothing can answer it, so it is
 * refused at once rather than waited on (in CI, until the job times out): the message names the question and how to
 * answer it without a terminal. Same principle as the Vercel CLI, which refuses a confirmation without a TTY. */
export class NoTerminalError extends Error {
  constructor(question: string, hint = "Run it in a terminal.") {
    super(`No terminal to answer: ${question}${/[.?!:]$/.test(question) ? "" : "."} ${hint}`);
  }
}

/** The sign-in step's instruction, followed on the next line by the link. It is live only while the sign-in waits
 * (approving redirects the browser to a server this process runs), so the full screen shows it on the sign-in
 * screen only and does not print it again after it closes. */
export const SIGNIN_LINK_INTRO = "Approve access in your browser. If it did not open, open this link on this computer:";
export const isSigninLink = (text: string) => text.startsWith(SIGNIN_LINK_INTRO);

/** The report's pointer to code the wizard could not add itself. Wherever the report is printed, that code has been
 * printed before it (the plain face shows it at the review; the full screen prints it with the warnings when it
 * closes). The done card is drawn before anything is printed, so it says when instead. */
export const BY_HAND = "add it by hand (above)";
export const BY_HAND_ON_CARD = "add it by hand (the code is printed when you close the wizard)";
/** The same for an uninstall's steps by hand ("Removed, except the steps by hand above."). */
export const STEPS_ABOVE = "the steps by hand above";
export const STEPS_ON_CARD = "the steps by hand (printed when you close the wizard)";

/** The display methods a minimal UI (tests, scripts) does not implement: progress is silent; changes, the hand-off
 * and the report print through info/warn exactly as the wizard printed them before these methods existed. */
export function withDefaults(u: BasicUi): Ui {
  return {
    info: (m) => u.info(m),
    warn: (m) => u.warn(m),
    confirm: (m, h) => u.confirm(m, h),
    select: (m, o, h) => u.select(m, o, h),
    // A minimal UI that cannot ask it refuses it, as a face with no terminal does.
    multiselect: u.multiselect ? (m, o, h) => u.multiselect!(m, o, h) : (m, _o, h) => Promise.reject(new NoTerminalError(scrub(m), h)),
    text: (m, p, h) => u.text(m, p, h),
    step: u.step?.bind(u) ?? (() => {}),
    fact: u.fact?.bind(u) ?? (() => {}),
    task: u.task?.bind(u) ?? (() => {}),
    log: u.log?.bind(u) ?? (() => {}),
    // Scrubbed like every face: an uninstall diff of .env.local can hold a --local-key secret key.
    changes: u.changes?.bind(u) ?? ((plan) => {
      if (plan.changes.length) u.info(printableDiff(plan).join("\n"));
      if (plan.install) u.info(`Will run: ${plan.install.command} ${plan.install.args.join(" ")}`);
      for (const i of plan.installs ?? []) u.info(`Will run in ${i.dir}: ${i.command} ${i.args.join(" ")}`);
      for (const w of plan.warnings) u.warn(scrub(w));
      for (const m of plan.manual) u.warn(scrub(`${m.file}: ${m.reason}\nAdd this by hand:\n${m.snippet}`));
    }),
    // In the wording every face uses (ui/handoff.ts), which scrubs each line.
    handoff: u.handoff?.bind(u) ?? ((h) => u.info([HANDOFF_TITLE, ...handoffLines(h)].join("\n"))),
    report: u.report?.bind(u) ?? ((lines) => u.info(lines.join("\n"))),
  };
}
