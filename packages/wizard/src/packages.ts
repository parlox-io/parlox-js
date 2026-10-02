import type { AppUnit } from "./apps.js";
import type { CliDeps } from "./deps.js";
import type { RunNames } from "./names.js";
import type { PackageStep } from "./plan-core.js";
import type { RunResult } from "./run.js";
import type { Ui } from "./ui/types.js";

// The package step: each app's install or removal, run by the app's own package manager in the app's own folder.

export type PackageWhat = "install" | "removal";
export interface AppStep { unit: AppUnit; step: PackageStep }

// A stop that came after the files were written but before the package manager started: reported as an interrupted
// install or removal (the files are changed, and the same command finishes it).
const NOT_RUN: RunResult = { status: null, stdout: "", stderr: "", aborted: true };

const commandLine = (step: PackageStep) => `${step.command} ${step.args.join(" ")}`;

/** A package step the run ended before, with where and how to finish it by hand. */
export const notRun = (a: AppStep, what: PackageWhat, names: RunNames): string =>
  `The package ${what} did not run${names.runIn(a.unit)}; run it yourself: ${commandLine(a.step)}`;

/**
 * The package manager did not run to its own end: interrupted (the signal), stopped by the time limit, or never
 * started. Closes the install step as failed, says how to finish by hand, and returns the exit code to stop with
 * (130, the shell's code for Ctrl+C, when interrupted); null when it ran to completion, successfully or not.
 * The files are already written at this point; only the package step is incomplete.
 */
function unfinished(r: RunResult, what: PackageWhat, pm: PackageStep, ui: Ui, inFolder: string): number | null {
  const line = commandLine(pm);
  let detail: string, message: string, code = 1;
  if (r.aborted) { detail = "Interrupted"; code = 130; message = `The package ${what} was interrupted. Your files were changed; finish it${inFolder} with: ${line}`; }
  else if (r.timedOut) { detail = "Stopped after 10 minutes"; message = `The package ${what} stopped after 10 minutes. Finish it${inFolder} with: ${line}`; }
  else if (r.error) {
    detail = `Could not start ${pm.command}`;
    message = r.error === "ENOENT" ? `Could not start ${pm.command}: it was not found on this computer's PATH.` : `Could not start ${pm.command} (${r.error}).`;
    message += ` Your files were changed; once it runs, finish${inFolder} with: ${line}`;
  } else return null;
  ui.task("install", "failed", detail);
  ui.step("install", "failed");
  ui.warn(message);
  return code;
}

/** "@parlox/browser and @parlox/server": the packages a step adds or removes, without versions. */
function packageNames(step: PackageStep): string {
  const names = step.args.filter((a) => !a.startsWith("-") && !["install", "add", "uninstall", "remove"].includes(a)).map((a) => a.replace(/(?<=.)@[^@/]+$/, ""));
  return names.length <= 2 ? names.join(" and ") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** One app's package install or removal, run in the app's own folder (the package manager finds its own workspace
 * root from there: pnpm takes the nearest pnpm-workspace.yaml, which need not be the one the wizard scanned from).
 * Returns the exit code to stop with, or null when it finished well. */
async function runPackages({ unit: u, step }: AppStep, what: PackageWhat, names: RunNames, deps: CliDeps, ui: Ui): Promise<number | null> {
  const pkgs = packageNames(step);
  const inApp = names.inApp(u);
  ui.task("install", "active", `${what === "install" ? "Installing" : "Removing"} ${pkgs}${inApp}`);
  const r = deps.signal?.aborted ? NOT_RUN : await deps.run(step.command, step.args, { cwd: u.dir, onLine: (l) => ui.log(l), signal: deps.signal, ...(deps.interactive ? { interactive: true } : {}) });
  const stop = unfinished(r, what, step, ui, names.runIn(u));
  if (stop !== null) return stop;
  if (r.status === 0) { ui.task("install", "done", `${what === "install" ? "Packages installed" : "Packages removed"}${inApp}`); return null; }
  if (what === "install") {
    ui.task("install", "failed", "The package manager reported an error");
    ui.step("install", "failed");
    // In the full screen its output went to the Logs tab, which is gone once it closes: running the same command by
    // hand, in the same folder, shows the error again and finishes the install.
    ui.warn(`The package manager reported an error. Run it yourself${names.runIn(u)}: ${commandLine(step)}`);
  } else {
    ui.task("install", "failed", `The package manager reported an error; remove ${pkgs} by hand.`);
    ui.step("install", "failed");
    ui.warn(`The package manager reported an error; remove ${pkgs} by hand.`);
  }
  return 1;
}

/** Every app's package step in turn, under the install step. A step that fails or is stopped ends the run there: each
 * step after it is named with its folder and the command that finishes it (every app's files are already written).
 * Returns the exit code to stop with, or null when every step finished well. */
export async function runAllPackages(steps: AppStep[], what: PackageWhat, names: RunNames, deps: CliDeps, ui: Ui): Promise<number | null> {
  if (!steps.length) return null;
  ui.step("install", "active");
  for (const [n, a] of steps.entries()) {
    const code = await runPackages(a, what, names, deps, ui);
    if (code === null) continue;
    for (const rest of steps.slice(n + 1)) ui.warn(notRun(rest, what, names));
    return code;
  }
  ui.step("install", "done");
  return null;
}
