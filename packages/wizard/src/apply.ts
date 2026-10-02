import { accessSync, constants as fsConstants, existsSync, realpathSync } from "node:fs";
import { dirname } from "node:path";
import { mergePlans, type AppUnit } from "./apps.js";
import type { CliDeps } from "./deps.js";
import { resolveInside } from "./fs-safe.js";
import type { RunNames } from "./names.js";
import { notRun, runAllPackages, type AppStep, type PackageWhat } from "./packages.js";
import { applyPlan, PlanError, type Plan } from "./plan-core.js";
import { scrub } from "./ui/scrub.js";
import type { Ui } from "./ui/types.js";
import { isInside } from "./workspace.js";

// What an install and an uninstall share once the apps are chosen: each app's own plan, the one review of them all,
// then, after the one Yes, a check of every app before anything is written, the writes (each app's own plan in its own
// folder), and each app's package step. A run with several apps is never left half-written without being told so.

export interface Planned { unit: AppUnit; plan: Plan }
export interface RunPlan {
  /** Each app's own plan, its paths relative to the app's folder. */
  planned: Planned[];
  /** What the review shows: the one app's plan, or every app's merged (paths from the start folder). */
  review: Plan;
  /** Each app's package step, in the apps' order. */
  steps: AppStep[];
}

export function planRun(units: AppUnit[], planOne: (u: AppUnit) => Plan): RunPlan {
  const planned = units.map((u) => ({ unit: u, plan: planOne(u) }));
  return {
    planned,
    review: planned.length === 1 ? planned[0].plan : mergePlans(planned),
    steps: planned.flatMap((p) => (p.plan.install ? [{ unit: p.unit, step: p.plan.install }] : [])),
  };
}

const errorText = (err: unknown) => scrub(err instanceof Error ? err.message : String(err));
const reasonOf = (err: unknown): string => {
  const code = (err as NodeJS.ErrnoException)?.code;
  return code === "EACCES" || code === "EPERM" ? "permission denied" : code === "EROFS" ? "read-only file system" : errorText(err);
};

/** Why the app's folder can no longer be written, or null. The scan took only app folders whose real folder is inside
 * the repository; a folder linked elsewhere since (its symlink moved) would have the wizard write outside it. */
function movedOut(u: AppUnit): string | null {
  try {
    const real = realpathSync(u.dir);
    return isInside(realpathSync(u.root), real) ? null : `it now points outside the repository (to ${real})`;
  } catch (err) {
    return reasonOf(err);
  }
}

/** Why `rel` (a change in the app at `dir`) cannot be made, or null: the path must stay inside the app without a
 * symlink (resolveInside), an existing file must be writable, and so must the folder a new file goes in (the nearest
 * one that exists) or the one a file is deleted from. */
function unwritable(dir: string, rel: string, removing: boolean): string | null {
  try {
    const p = resolveInside(dir, rel);
    if (existsSync(p)) accessSync(removing ? dirname(p) : p, fsConstants.W_OK);
    else if (!removing) {
      let d = dirname(p);
      while (!existsSync(d)) d = dirname(d);
      accessSync(d, fsConstants.W_OK);
    }
    return null;
  } catch (err) {
    return reasonOf(err);
  }
}

/** Refuses, before anything is written, a run that could not be written whole: an app folder moved out of the
 * repository since the scan, or any change of any app that cannot be made. Every app is checked before the first
 * write, and every problem found is named. */
export function preflight(run: RunPlan, names: RunNames): void {
  const problems: string[] = [];
  for (const { unit, plan } of run.planned) {
    const out = movedOut(unit);
    if (out) { problems.push(`${names.app(unit)}: ${out}`); continue; }
    for (const c of plan.changes) {
      const why = unwritable(unit.dir, c.path, c.after === null);
      if (why) problems.push(`${names.file(unit, c.path)} (${why})`);
    }
  }
  if (!problems.length) return;
  const what = problems.length === 1 ? problems[0] : `these:\n${problems.map((p) => `  ${p}`).join("\n")}\n`;
  throw new PlanError("not-writable", `Cannot write ${what}${problems.length === 1 ? ". " : ""}Nothing was changed: fix that, then run the wizard again.`);
}

/** The command that runs the wizard again for one app, from the folder this run was started in. */
const againCommand = (u: AppUnit, what: PackageWhat) => `npx parlox ${what === "install" ? "init" : "uninstall"}${u.rel === "." ? "" : ` --app ${u.rel}`}`;

/** What an app that a failed write left unfinished is to do: run the wizard again, which finds what was already
 * changed. A removal is never finished by hand with the package command: files not yet changed may still import the
 * packages, and removing them would break the app's build. */
function finishNote(u: AppUnit, partly: boolean, what: PackageWhat, names: RunNames): string {
  const app = names.single ? "" : ` for ${names.app(u)}`;
  if (what === "removal") return `Run the uninstall again${app} (${againCommand(u, what)}): ${partly ? "the app was partly changed, and the files not changed yet" : "none of the app's files were changed, and they"} may still import the Parlox packages, so remove no package by hand before then.`;
  return partly
    ? `Run the wizard again${app} (${againCommand(u, what)}) to finish: it finds the changes already made.`
    : `Run the wizard again${app} (${againCommand(u, what)}): none of its changes were written.`;
}

/** A write that failed after the check (a disk that filled up, a file changed meanwhile): which apps were written,
 * and, when anything was, the package command of each app whose files are all as the run meant them (for an install,
 * also of an app partly changed, whose written files already import the package), and for every other app, to run
 * the wizard again. The review step ends failed when nothing was written; otherwise it is already done. Returns the
 * apps that had changes to make and got none of them. */
function writeFailed(run: RunPlan, at: number, written: number, err: unknown, what: PackageWhat, names: RunNames, ui: Ui): AppUnit[] {
  const { unit, plan } = run.planned[at];
  const file = names.file(unit, plan.changes[written]?.path ?? "");
  const anything = written > 0 || run.planned.slice(0, at).some((p) => p.plan.changes.length > 0);
  // Each app's files: all written (an app with none to write is complete too), some of them, or none of them.
  const stateOf = (i: number): "complete" | "partly" | "untouched" =>
    i < at || !run.planned[i].plan.changes.length ? "complete" : i === at && written > 0 ? "partly" : "untouched";
  const untouched = run.planned.filter((_, i) => stateOf(i) === "untouched").map((p) => p.unit);
  let state: string;
  if (!anything) state = "Nothing was changed.";
  else if (names.single) state = "The changes before it were written; the others were not.";
  else {
    const list = (label: string, ps: Planned[]) => (ps.length ? [`${label}: ${ps.map((p) => names.app(p.unit)).join(", ")}.`] : []);
    const before = run.planned.slice(0, at).filter((p) => p.plan.changes.length > 0);
    const after = [...(written > 0 ? [] : [run.planned[at]]), ...run.planned.slice(at + 1)];
    state = [...list("Changed", before), ...list("Partly changed", written > 0 ? [run.planned[at]] : []), ...list("Not changed", after)].join(" ");
  }
  ui.warn(`Could not write ${file} (${reasonOf(err)}). ${state}`);
  if (!anything) { ui.step("review", "failed"); return untouched; }
  for (const s of run.steps) {
    const st = stateOf(run.planned.findIndex((p) => p.unit === s.unit));
    if (st === "complete" || (what === "install" && st === "partly")) ui.warn(notRun(s, what, names));
  }
  for (const [i, p] of run.planned.entries()) if (stateOf(i) !== "complete") ui.warn(finishNote(p.unit, stateOf(i) === "partly", what, names));
  return untouched;
}

/** How the apply ended: the exit code to stop with (null: all of it finished well), and the apps that had changes to
 * make and got none of them (a write failed first), which have no Parlox code to connect a host for. */
export interface ApplyResult { code: number | null; untouched: AppUnit[] }

/** After the Yes: the check, the writes (each app's own plan, in its own folder, in the review's order) and the package
 * steps. `landed` is called after each change that took effect, and once before the package steps. */
export async function applyRun(run: RunPlan, what: PackageWhat, names: RunNames, deps: CliDeps, ui: Ui, landed: () => void): Promise<ApplyResult> {
  preflight(run, names);
  for (const [n, { unit, plan }] of run.planned.entries()) {
    let written = 0;
    try {
      // Checked again right before its own writes: the check above ran for every app first.
      const out = movedOut(unit);
      if (out) throw new PlanError("not-writable", `${names.app(unit)}: ${out}`);
      applyPlan(unit.dir, plan, () => { written++; landed(); });
    } catch (err) {
      return { code: 1, untouched: writeFailed(run, n, written, err, what, names, ui) };
    }
  }
  // A plan with only package steps is done once they are about to run.
  landed();
  return { code: await runAllPackages(run.steps, what, names, deps, ui), untouched: [] };
}
