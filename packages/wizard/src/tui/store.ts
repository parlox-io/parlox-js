import type { Plan } from "../plan.js";
import { shownChange } from "../diff.js";
import { scrub } from "../ui/scrub.js";
import { printable, printableLines } from "../ui/text.js";
import type { Handoff, Status, StepId, TaskId, Ui } from "../ui/types.js";

export const MAX_LOG_LINES = 500;
export const MAX_LINE = 2000;
const MAX_MESSAGES = 50;

type Question =
  | { kind: "confirm"; message: string }
  | { kind: "select"; message: string; options: Array<{ value: unknown; label: string }> }
  | { kind: "multiselect"; message: string; options: Array<{ value: unknown; label: string }> }
  | { kind: "text"; message: string; placeholder?: string };
// `id` tells two questions apart even when their wording is the same (the screen resets its cursor for each one).
export type Prompt = Question & { id: number };

export interface WizardState {
  started: boolean;
  step: StepId | "welcome";
  steps: Record<StepId, Status>;
  facts: Array<{ label: string; value: string }>;
  // `step` is the screen the message came in on, so a screen can leave out what belonged to earlier steps.
  messages: Array<{ kind: "info" | "warn"; text: string; step: StepId | "welcome" }>;
  plan: Plan | null;
  target: string;
  mode: "install" | "uninstall";
  tasks: Record<TaskId, { status: Status; detail?: string }>;
  logs: string[];
  handoff: Handoff | null;
  /** Every hand-off of the run, in order (one per app with a server part); `handoff` is the latest, the one shown. */
  handoffs: Handoff[];
  report: string[] | null;
  reportTitle: string | null;
  prompt: Prompt | null;
  quitAsked: boolean;
  // What the screen says while it waits to close ("Stopping…", "Signing out…"); null while the run is going on.
  closing: string | null;
}

const STEPS: StepId[] = ["detect", "signin", "site", "review", "install", "host", "check", "done"];
const ORDER: Array<StepId | "welcome"> = ["welcome", ...STEPS];

/** The messages that came in on step `from` or a later one. A message whose step is not known is kept: a screen may
 * leave out an earlier step's message, never hide a warning because it cannot tell where it came from. */
export function messagesSince(s: WizardState, from: StepId | "welcome"): WizardState["messages"] {
  const start = ORDER.indexOf(from);
  return s.messages.filter((m) => { const at = ORDER.indexOf(m.step); return at < 0 || at >= start; });
}
// Every string kept for display is scrubbed, then made printable (control and invisible format characters written
// out, tabs expanded), so no screen can draw a key or text that shows differently from what it is.
const show = (s: string) => printableLines(scrub(s));
const clip = (s: string) => printable(scrub(s)).slice(0, MAX_LINE);
const orNull = (s: string | null) => (s === null ? null : show(s));

// The store keeps a display copy of the plan: the flow's own plan (which it applies) is never modified. An uninstall
// diffs .env.local, which can hold a --local-key secret key, so the file contents are scrubbed along with the rest.
// The contents are kept as they are otherwise: the diff is made printable line by line when it is drawn, where the
// column a tab starts at is known.
// An env file is kept only as the review shows it (diff.ts): Parlox's own line and a count of the others, never the
// developer's other variables.
const scrubPlan = (p: Plan): Plan => ({
  changes: p.changes.map(shownChange).map((c) => ({ path: show(c.path), before: c.before === null ? null : scrub(c.before), after: c.after === null ? null : scrub(c.after), ...(c.purpose ? { purpose: show(c.purpose) } : {}), ...(c.hiddenLines !== undefined ? { hiddenLines: c.hiddenLines } : {}) })),
  install: p.install ? { command: show(p.install.command), args: p.install.args.map(show) } : null,
  ...(p.installs ? { installs: p.installs.map((i) => ({ dir: show(i.dir), command: show(i.command), args: i.args.map(show) })) } : {}),
  manual: p.manual.map((m) => ({ file: show(m.file), reason: show(m.reason), snippet: show(m.snippet) })),
  warnings: p.warnings.map(show),
});

const scrubHandoff = (h: Handoff): Handoff => ({ host: show(h.host), url: orNull(h.url), where: show(h.where), docs: orNull(h.docs), variables: h.variables.map(show), ...(h.notes?.length ? { notes: h.notes.map(show) } : {}) });

// The hand-off's wording is every face's (ui/handoff.ts); kept here too for the screens that read it from the store.
export { HANDOFF_TITLE, handoffLines } from "../ui/handoff.js";

/** The full-screen face's single source of truth. The flow calls the Ui methods; the Ink app renders snapshots.
 * Every string is scrubbed as it comes in, so no screen can draw a secret key whatever it chooses to show. */
export class WizardStore implements Ui {
  state: WizardState = {
    started: false, step: "welcome", steps: Object.fromEntries(STEPS.map((s) => [s, "pending"])) as Record<StepId, Status>,
    facts: [], messages: [], plan: null, target: "", mode: "install",
    tasks: { install: { status: "pending" }, host: { status: "pending" }, check: { status: "pending" } },
    logs: [], handoff: null, handoffs: [], report: null, reportTitle: null, prompt: null, quitAsked: false, closing: null,
  };
  private listeners = new Set<() => void>();
  private resolvePrompt: ((v: unknown) => void) | null = null;
  private rejectPrompt: ((e: Error) => void) | null = null;
  private startWaiters: Array<(started: boolean) => void> = [];
  private promptSeq = 0;
  private stopped = false;

  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  getSnapshot = () => this.state;
  private set(patch: Partial<WizardState>) { this.state = { ...this.state, ...patch }; for (const fn of this.listeners) fn(); }

  // welcome screen
  start() { if (!this.state.started) { this.set({ started: true }); for (const w of this.startWaiters.splice(0)) w(true); } }
  quit() { for (const w of this.startWaiters.splice(0)) w(false); }
  waitForStart(): Promise<boolean> { return this.state.started ? Promise.resolve(true) : new Promise((r) => this.startWaiters.push(r)); }
  /** q / Ctrl-C: a pending prompt is cancelled (the flow reports it); otherwise the app asks before quitting. */
  requestQuit() { if (this.state.prompt) this.cancelPrompt(); else this.set({ quitAsked: true }); }
  dismissQuit() { this.set({ quitAsked: false }); }
  /** The run was stopped (a confirmed quit, Ctrl-C, SIGTERM): the open question is cancelled and every later one is
   * refused at once ("Cancelled."), so the flow unwinds to its next check instead of waiting for an answer nobody
   * will give. */
  stop() {
    this.stopped = true;
    this.cancelPrompt();
    // A stop is deliberate: what was still running ends "skipped", as a declined step does, and without the running
    // line ("Installing …"), which no longer describes it. What the flow reports afterwards replaces this.
    const skip = <T extends { status: Status }>(x: T) => (x.status === "active" ? { status: "skipped" as const } : x);
    const steps = Object.fromEntries(STEPS.map((id) => [id, this.state.steps[id] === "active" ? "skipped" : this.state.steps[id]])) as Record<StepId, Status>;
    const tasks = { install: skip(this.state.tasks.install), host: skip(this.state.tasks.host), check: skip(this.state.tasks.check) };
    this.set({ quitAsked: false, closing: "Stopping…", steps, tasks });
  }
  /** What the screen says while it waits to close, for example "Signing out…" after the done card is closed. */
  showClosing(message: string) { this.set({ closing: show(message) }); }

  // Ui
  info = (m: string) => this.set({ messages: [...this.state.messages, { kind: "info" as const, text: show(m), step: this.state.step }].slice(-MAX_MESSAGES) });
  warn = (m: string) => this.set({ messages: [...this.state.messages, { kind: "warn" as const, text: show(m), step: this.state.step }].slice(-MAX_MESSAGES) });
  step = (id: StepId, status: Status) => this.set({ steps: { ...this.state.steps, [id]: status }, ...(status === "active" || id === "done" ? { step: id } : {}) });
  fact = (label: string, value: string) => this.set({ facts: [...this.state.facts, { label: show(label), value: show(value) }] });
  changes = (plan: Plan, target: string, mode: "install" | "uninstall") => this.set({ plan: scrubPlan(plan), target: show(target), mode });
  task = (id: TaskId, status: Status, detail?: string) => this.set({ tasks: { ...this.state.tasks, [id]: { status, ...(detail ? { detail: show(detail) } : {}) } } });
  log = (line: string) => this.set({ logs: [...this.state.logs, clip(line)].slice(-MAX_LOG_LINES) });
  handoff = (h: Handoff) => { const shown = scrubHandoff(h); this.set({ handoff: shown, handoffs: [...this.state.handoffs, shown] }); };
  report = (lines: string[], title?: string) => this.set({ report: lines.map(show), reportTitle: title ? show(title) : null });

  private ask<T>(question: Question): Promise<T> {
    if (this.stopped) return Promise.reject(new Error("Cancelled."));
    // One question at a time: a question asked while another is open cancels the older one, which would otherwise
    // wait forever for an answer that can no longer be given.
    const older = this.rejectPrompt;
    return new Promise<T>((resolve, reject) => {
      this.resolvePrompt = resolve as (v: unknown) => void;
      this.rejectPrompt = reject;
      this.set({ prompt: { ...question, id: ++this.promptSeq, message: show(question.message) } });
      older?.(new Error("Cancelled."));
    });
  }
  confirm = (message: string) => this.ask<boolean>({ kind: "confirm", message });
  // Only the labels are drawn; the values (site ids, folder names) go back to the flow unchanged.
  select = <T,>(message: string, options: Array<{ value: T; label: string }>) => this.ask<T>({ kind: "select", message, options: options.map((o) => ({ value: o.value, label: show(o.label) })) });
  // Every option starts selected (Prompt.tsx); the values go back to the flow unchanged, only the labels are drawn.
  multiselect = <T,>(message: string, options: Array<{ value: T; label: string }>) => this.ask<T[]>({ kind: "multiselect", message, options: options.map((o) => ({ value: o.value, label: show(o.label) })) });
  // The placeholder is only shown, never returned: an empty answer is "" (as in the plain face), and the flow applies
  // its own default.
  text = (message: string, placeholder?: string) => this.ask<string>({ kind: "text", message, ...(placeholder !== undefined ? { placeholder: show(placeholder) } : {}) });
  /** `id` is the question the answer was given to: a key handled by a question already answered (the screen had not
   * redrawn yet) carries that question's id and is dropped, so it never answers the next question unseen. */
  answer(value: unknown, id?: number) {
    if (id !== undefined && id !== this.state.prompt?.id) return;
    const r = this.resolvePrompt; this.resolvePrompt = this.rejectPrompt = null; this.set({ prompt: null }); r?.(value);
  }
  cancelPrompt() { const r = this.rejectPrompt; this.resolvePrompt = this.rejectPrompt = null; this.set({ prompt: null }); r?.(new Error("Cancelled.")); }
}
