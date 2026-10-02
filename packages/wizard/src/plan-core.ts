import type { PackageManager } from "./workspace.js";
import { deleteInside, removeEmptyDirInside, writeInside } from "./fs-safe.js";

// The plan every integration produces and the flow reviews, applies and reverses. `purpose` says what a change is for
// in the review ("browser part", "server part"); without it the review infers it from the file name (ui/summary.ts).
export interface FileChange {
  path: string; before: string | null; after: string | null; purpose?: string;
  /** For a file deleted: folders (relative to the same root, innermost first) removed once the file is gone, each only
   * when nothing is left in it, as git removes a folder when its last file goes. */
  removeEmptyDirs?: string[];
  /** Set only on what the review shows of an env file (diff.ts, shownChange): how many of its lines are not shown. */
  hiddenLines?: number;
}
export interface PackageStep { command: string; args: string[] }
export interface Plan {
  changes: FileChange[];
  install: PackageStep | null;
  /** Edits the wizard could not make; `part` says which part they belong to when the file alone does not tell.
   * `placeholder`: `file` names no path but a description of one ("your page layout"), for a file the wizard could
   * not find; a run with several apps names its folder after it, never in front of it as if it were a path.
   * `unread` (uninstall): the wizard could not read the file (a link, a file over 1 MB, one it cannot parse that names
   * no Parlox package), so the step is needed only if Parlox's lines are there; it is no evidence by itself that the
   * app has Parlox (apps.ts, parloxIn). */
  manual: Array<{ file: string; reason: string; snippet: string; part?: "browser" | "server"; placeholder?: boolean; unread?: boolean }>;
  warnings: string[];
  /** A run with several apps: one package step per app folder (install is then null). */
  installs?: Array<PackageStep & { dir: string }>;
}
/** A plan the wizard refuses to apply: an env file git tracks, or a change that cannot be written (checked before
 * anything is written). */
export class PlanError extends Error { constructor(readonly code: "env-tracked" | "not-writable", message: string) { super(message); } }

/** An env file the wizard writes (.env.local, .env, .env.development, .env.production.local…), in any app folder:
 * created readable only by its owner. */
export const isEnvFile = (path: string) => /(^|\/)\.env(\.[\w-]+)*$/.test(path);

export const emptyPlan = (): Plan => ({ changes: [], install: null, manual: [], warnings: [] });

export function packageCommand(pm: PackageManager, action: "add" | "remove", packages: string[]): PackageStep {
  if (action === "remove") return { command: pm, args: [pm === "npm" ? "uninstall" : "remove", ...packages] };
  const exact = pm === "npm" || pm === "pnpm" ? "--save-exact" : "--exact";
  return { command: pm, args: [pm === "npm" ? "install" : "add", exact, ...packages] };
}

export function declared(read: (rel: string) => string | null): Record<string, string> {
  const pkg = JSON.parse(read("package.json") ?? "{}");
  return { ...(pkg.devDependencies ?? {}), ...(pkg.dependencies ?? {}) };
}

// An env file can hold a key (--local-key), so when the wizard creates one, only its owner may read it; an existing
// env file keeps whatever mode it has (the key itself is written with writeSecretInside, which makes it owner-only).
export const ENV_FILE_MODE = 0o600;

/** Writes the plan's changes in order. `landed` is called after each one that took effect, so a caller can tell a run
 * that changed nothing (the first write failed) from one that changed some files before a later write failed. */
export function applyPlan(root: string, plan: Plan, landed: () => void = () => {}): void {
  for (const c of plan.changes) {
    if (c.after === null) {
      deleteInside(root, c.path);
      for (const dir of c.removeEmptyDirs ?? []) removeEmptyDirInside(root, dir);
    }
    else writeInside(root, c.path, c.after, isEnvFile(c.path) ? ENV_FILE_MODE : undefined);
    landed();
  }
}

/** One package command for two steps of the same app (same package manager, same action). */
export function mergeInstall(a: PackageStep | null, b: PackageStep | null): PackageStep | null {
  if (!a) return b;
  if (!b) return a;
  return { command: a.command, args: [...a.args, ...b.args.filter((x) => !a.args.includes(x))] };
}

/** Two plans for the same folder, as one: a file both change is changed once (the first plan's before, the second's
 * after). The second plan must have been made reading the first one's result (overlayReader). */
export function combinePlans(a: Plan, b: Plan): Plan {
  if (!a.changes.length && !a.install && !a.manual.length && !a.warnings.length) return b;
  const changes = a.changes.map((c) => ({ ...c }));
  for (const c of b.changes) {
    const same = changes.find((x) => x.path === c.path);
    if (!same) { changes.push(c); continue; }
    same.after = c.after;
    if (c.purpose) same.purpose = c.purpose;
    if (c.removeEmptyDirs) same.removeEmptyDirs = c.removeEmptyDirs;
  }
  return { changes: changes.filter((c) => c.before !== c.after), install: mergeInstall(a.install, b.install), manual: [...a.manual, ...b.manual], warnings: [...a.warnings, ...b.warnings] };
}

/** A reader that sees `plan`'s changes as if they were already written. */
export const overlayReader = (read: (rel: string) => string | null, plan: Plan) => (rel: string): string | null => {
  const c = plan.changes.find((x) => x.path === rel);
  return c ? c.after : read(rel);
};
