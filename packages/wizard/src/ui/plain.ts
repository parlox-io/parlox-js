import * as clack from "@clack/prompts";
import type { Plan } from "../plan.js";
import { color } from "./color.js";
import { HANDOFF_TITLE, handoffParts } from "./handoff.js";
import { scrub } from "./scrub.js";
import { printableDiff, summarizeChanges } from "./summary.js";
import { printable, printableLines } from "./text.js";
import { NoTerminalError, type Handoff, type StepId, type Ui } from "./types.js";

export const STEP_TITLES: Record<StepId, string> = {
  detect: "Checking your project", signin: "Signing in", site: "Choosing the site", review: "Reviewing changes",
  install: "Installing packages", host: "Connecting your host", check: "Checking locally", done: "Done",
};

function changeTable(plan: Plan): string {
  const rows = summarizeChanges(plan);
  const paths = rows.map((r) => printable(scrub(r.path)));
  const width = Math.max(...paths.map((p) => p.length), 4);
  const sign = { created: "+", edited: "~", deleted: "-" } as const;
  return rows.map((r, i) => `${sign[r.kind]} ${paths[i].padEnd(width)}  ${color("green", `+${r.added}`)} ${color("red", `-${r.removed}`)}  ${scrub(r.purpose)}`).join("\n");
}

// Coloured after printableDiff() has scrubbed the lines and made them printable, so an escape code never splits
// "[hidden]" and the diff shows exactly what is written.
function coloredDiff(plan: Plan): string {
  return printableDiff(plan).map((l) => (l.startsWith("+") && !l.startsWith("+++") ? color("green", l) : l.startsWith("-") && !l.startsWith("---") ? color("red", l) : l)).join("\n");
}

/** Runs one question with its own signal, aborted by the run's stop only while the question is open. clack adds an
 * abort listener to the signal it is given and never removes it: on the run's own signal, every question already
 * answered would close again at a stop and print one more line. */
async function asked<T>(stop: AbortSignal | undefined, question: (signal?: AbortSignal) => Promise<T>): Promise<T> {
  if (!stop) return question(undefined);
  const own = new AbortController();
  const onStop = () => own.abort();
  if (stop.aborted) own.abort();
  else stop.addEventListener("abort", onStop, { once: true });
  try { return await question(own.signal); }
  finally { stop.removeEventListener("abort", onStop); }
}

/** The plain step-by-step face: used in CI, piped output, small windows, legacy consoles, --yes and --plain. It writes
 * to `out` and reads its answers from `input`. `stop` is the run's stop signal: it ends an open question at once, as
 * a cancel, so the flow unwinds instead of waiting. With no terminal on `input` (CI, a pipe), a question is never
 * waited on: it is refused at once (NoTerminalError) with its `hint`, how to answer it without a terminal. */
export function plainUi(out: NodeJS.WriteStream = process.stdout, stop?: AbortSignal, input: Pick<NodeJS.ReadStream, "isTTY"> = process.stdin): Ui {
  const o = { output: out };
  // What the flow writes can hold the developer's folder names (the facts, the review, the report, the questions of a
  // run with several apps): scrubbed, then its control characters written out (^[ for an escape), as the full screen
  // does, so no folder name can move the cursor or retitle the terminal.
  const clean = (m: string) => printableLines(scrub(m));
  // A paste-in snippet keeps its tabs: it is code to copy as it is, and the terminal lays tabs out itself.
  const code = (m: string) => scrub(m).split("\n").map((l) => printable(l, { keepTabs: true })).join("\n");
  // A stop ends a question as a cancel, even one that could not have been asked.
  const ask = <T>(message: string, hint: string | undefined, question: (signal?: AbortSignal) => Promise<T | symbol>): Promise<T> => {
    if (stop?.aborted) return Promise.reject(new Error("Cancelled."));
    if (!input.isTTY) return Promise.reject(new NoTerminalError(scrub(message), hint));
    return asked(stop, question).then((v) => { if (clack.isCancel(v)) throw new Error("Cancelled."); return v as T; });
  };
  const io = { input: input as NodeJS.ReadStream, output: out };
  // A label can hold a folder name, which is the developer's: scrubbed, and its control characters written out (^[ for
  // an escape), so it can neither show a key nor move the cursor or retitle the terminal.
  const labelled = <T,>(options: Array<{ value: T; label: string }>) => options.map((o) => ({ value: o.value, label: printable(scrub(o.label)) }));
  return {
    info: (m) => clack.log.info(clean(m), o),
    warn: (m) => clack.log.warn(clean(m), o),
    confirm: async (m, hint) => (await ask<boolean>(m, hint, (signal) => clack.confirm({ message: clean(m), signal, ...io }))) === true,
    select: (m, options, hint) => ask(m, hint, (signal) => clack.select({ message: clean(m), options: labelled(options) as any, signal, ...io })),
    // Every option starts selected; clack refuses Enter with nothing selected (required).
    multiselect: <T,>(m: string, options: Array<{ value: T; label: string }>, hint?: string) => ask<T[]>(m, hint, (signal) => clack.multiselect<T>({
      message: clean(m), options: labelled(options) as any,
      initialValues: options.map((o) => o.value), required: true, signal, ...io,
    })),
    text: async (m, placeholder, hint) => String((await ask<string>(m, hint, (signal) => clack.text({ message: clean(m), placeholder, signal, ...io }))) ?? ""),
    step: (id, status) => { if (status === "active" && id !== "done") clack.log.step(color("accent", STEP_TITLES[id]), o); },
    fact: (label, value) => clack.log.success(`${color("bold", label.padEnd(8))} ${clean(value)}`, o),
    changes: (plan, target, mode) => {
      if (plan.changes.length) {
        clack.note(changeTable(plan), `${mode === "install" ? "Changes" : "Removals"} in ${clean(target)}: ${plan.changes.length} file${plan.changes.length === 1 ? "" : "s"}`, o);
        clack.log.message(coloredDiff(plan), o);
      }
      if (plan.install) clack.log.info(`Will run: ${plan.install.command} ${plan.install.args.join(" ")}`, o);
      for (const i of plan.installs ?? []) clack.log.info(clean(`Will run in ${i.dir}: ${i.command} ${i.args.join(" ")}`), o);
      for (const w of plan.warnings) clack.log.warn(clean(w), o);
      for (const m of plan.manual) clack.log.warn(`${clean(`${m.file}: ${m.reason}`)}\nAdd this by hand:\n${code(m.snippet)}`, o);
    },
    task: (_id, status, detail) => {
      if (!detail) return;
      if (status === "done") clack.log.success(clean(detail), o);
      else if (status === "failed") clack.log.error(clean(detail), o);
      else if (status === "active") clack.log.info(clean(detail), o);
    },
    log: (line) => { out.write(`${color("dim", `  ${scrub(line)}`, out)}\n`); },
    // The links (the dashboard's key link and the host's docs) go after the box, through log.info, which never wraps:
    // the box wraps at the window's width, and a link broken across lines between border characters cannot be
    // copied or clicked. The wording is every face's (ui/handoff.ts).
    handoff: (h: Handoff) => {
      const { what, links } = handoffParts(h);
      clack.note(what.join("\n"), HANDOFF_TITLE, o);
      if (links.length) clack.log.info(links.join("\n"), o);
    },
    report: (lines, title) => clack.note(lines.map(clean).join("\n"), clean(title ?? "Summary"), o),
  };
}
