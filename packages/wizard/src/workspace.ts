import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { parseDocument } from "yaml";
import { globSegments } from "./edits/vite-install.js";

// What every integration shares about a project: where its workspace root is, which workspace packages exist, and
// which package manager it uses. Nothing here writes.

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";
export type DetectCode = "no-package-json" | "not-next" | "old-next" | "unknown-next" | "lockfiles" | "no-entry" | "not-supported" | "no-app" | "app-not-found" | "declined" | "workspace-file";
export class DetectError extends Error {
  constructor(readonly code: DetectCode, message: string) { super(message); }
}

export const GUIDE = "https://gateway.parlox.io/install.md";
const LOCKFILES: Array<[string, PackageManager]> = [["package-lock.json", "npm"], ["pnpm-lock.yaml", "pnpm"], ["yarn.lock", "yarn"], ["bun.lock", "bun"], ["bun.lockb", "bun"]];

export const readJson = (p: string) => JSON.parse(readFileSync(p, "utf8")) as Record<string, any>;

/** JSON with comments and trailing commas, as tsconfig.json and wrangler.jsonc are written; null for no text, text
 * that is not such JSON, or a value that is not an object. Comments and commas inside strings are kept. */
export function readJsonc(text: string | null): Record<string, any> | null {
  if (text === null) return null;
  const src = text.replace(/^﻿/, "");
  // One pass: strings are copied as they are; comments go; a comma goes when only a } or ] (after spaces and
  // comments) follows it.
  const after = (i: number): number => {
    for (;;) {
      while (i < src.length && /\s/.test(src[i])) i++;
      if (src.startsWith("//", i)) { const n = src.indexOf("\n", i); i = n < 0 ? src.length : n; continue; }
      if (src.startsWith("/*", i)) { const n = src.indexOf("*/", i + 2); if (n < 0) return src.length; i = n + 2; continue; }
      return i;
    }
  };
  let out = "";
  for (let i = 0; i < src.length; ) {
    const c = src[i];
    if (c === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== '"') j += src[j] === "\\" ? 2 : 1;
      out += src.slice(i, j + 1);
      i = j + 1;
    } else if (src.startsWith("//", i) || src.startsWith("/*", i)) {
      out += " ";
      i = after(i);
    } else if (c === "," && (src[after(i + 1)] === "}" || src[after(i + 1)] === "]")) {
      i++;
    } else {
      out += c;
      i++;
    }
  }
  try {
    const v = JSON.parse(out);
    return v !== null && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch { return null; }
}
export const isInside = (root: string, p: string) => { const r = relative(root, p); return r === "" || (!r.startsWith("..") && !isAbsolute(r)); };
export const hasDep = (pkg: Record<string, any>, name: string) => Boolean(pkg.dependencies?.[name] || pkg.devDependencies?.[name]);

/** The `packages` list of a pnpm-workspace.yaml, [] when it has none. pnpm also keeps settings in that file
 * (onlyBuiltDependencies, catalogs, overrides; create-hono's templates hold only those), and they are not workspace
 * packages. Read with a YAML parser (every valid way of writing the list counts: flow or block, a quoted key, a
 * byte-order mark); a file that does not parse is refused, naming `file`, rather than guessed at. */
export function pnpmPackages(text: string, file = "pnpm-workspace.yaml"): string[] {
  const refused = (message: string) => new DetectError("workspace-file", `${file} could not be read: ${message.split("\n")[0].replace(/:$/, "")}. Fix it, then run the wizard again.`);
  const doc = parseDocument(text);
  if (doc.errors.length) throw refused(doc.errors[0].message);
  let data: unknown;
  // toJS() refuses a document that expands aliases past the parser's limit.
  try { data = doc.toJS(); } catch (err) { throw refused(err instanceof Error ? err.message : String(err)); }
  const packages = data !== null && typeof data === "object" ? (data as Record<string, unknown>).packages : undefined;
  return Array.isArray(packages) && packages.every((p) => typeof p === "string") ? packages : [];
}
const pnpmPackagesIn = (dir: string): string[] => {
  const file = join(dir, "pnpm-workspace.yaml");
  return existsSync(file) ? pnpmPackages(readFileSync(file, "utf8"), file) : [];
};

/** Whether `dir` is a workspace root: a pnpm-workspace.yaml that lists packages, or package.json `workspaces`. */
export function hasWorkspaces(dir: string): boolean {
  if (pnpmPackagesIn(dir).length > 0) return true;
  const p = join(dir, "package.json");
  if (!existsSync(p)) return false;
  const w = readJson(p).workspaces;
  return Array.isArray(w) || Array.isArray(w?.packages);
}

/** The top of the repository the app at `dir` is in: the nearest folder above it (or itself) with a .git, but never
 * below the workspace root `root`; `root` when there is no .git above. */
export function repoTopOf(dir: string, root: string): string {
  const atOrAbove = (d: string) => { const r = relative(d, root); return r === "" || (r !== ".." && !r.startsWith(`..${sep}`) && !isAbsolute(r)); };
  for (let d = dir; ; d = dirname(d)) {
    if (existsSync(join(d, ".git"))) return atOrAbove(d) ? d : root;
    if (dirname(d) === d) return root;
  }
}

/** The nearest ancestor (or start itself) that defines workspaces; start when there is none. */
export function findRoot(start: string): string {
  let dir = start;
  for (;;) {
    if (hasWorkspaces(dir)) return dir;
    const up = dirname(dir);
    if (up === dir) return start;
    dir = up;
  }
}

export function packageManagerOf(dir: string, root: string): PackageManager {
  for (const d of dir === root ? [dir] : [dir, root]) {
    const field = existsSync(join(d, "package.json")) ? String(readJson(join(d, "package.json")).packageManager ?? "") : "";
    const m = field.match(/^(npm|pnpm|yarn|bun)@/);
    if (m) return m[1] as PackageManager;
  }
  for (const d of dir === root ? [dir] : [dir, root]) {
    const found = [...new Set(LOCKFILES.filter(([f]) => existsSync(join(d, f))).map(([, pm]) => pm))];
    if (found.length > 1) throw new DetectError("lockfiles", `Found lockfiles for ${found.join(" and ")} in ${d}. Remove the ones you do not use, or set "packageManager" in package.json, then run the wizard again.`);
    if (found.length === 1) return found[0];
  }
  return "npm";
}

/** A reader for detection: the text of a regular file inside `dir` (a directory, a missing file, or one over 1 MB
 * reads as null). Detection only reads; writes go through fs-safe.ts. */
export const readText = (dir: string) => (rel: string): string | null => {
  try {
    const p = join(dir, rel);
    const st = statSync(p);
    return st.isFile() && st.size <= 1_000_000 ? readFileSync(p, "utf8") : null;
  } catch { return null; }
};

/** The major version of `name` installed for this app, else the one its package.json range names, else null. */
export function installedMajor(dir: string, pkg: Record<string, any>, name: string): number | null {
  try {
    const installed = createRequire(join(dir, "package.json")).resolve(`${name}/package.json`);
    const m = String(readJson(installed).version).match(/^(\d+)\./);
    if (m) return Number(m[1]);
  } catch { /* not installed: fall back to the declared range */ }
  const m = String(pkg.dependencies?.[name] ?? pkg.devDependencies?.[name] ?? "").match(/(\d+)(?:\.|$)/);
  return m ? Number(m[1]) : null;
}

/**
 * One workspace package list, as its package manager reads it: the patterns that add folders (`include`) and those
 * that take folders out (`exclude`). A pattern with an odd number of leading "!" takes out, an even number adds, and a
 * leading "./" or "/" is dropped, as npm reads them (@npmcli/map-workspaces 4.0.2, lib/index.js, appendNegatedPatterns).
 * The negations apply after every pattern that adds, wherever they are listed:
 * - package.json's workspaces (npm): a negation is dropped when a pattern after it, which it matches, adds the folder
 *   back (['apps/*', '!apps/old-*', 'apps/old-shop'] keeps apps/old-shop), the same function;
 * - pnpm-workspace.yaml's packages (pnpm 9.15, findPackages, through fast-glob): every negation applies to every
 *   pattern, whatever the order.
 * Both checked against npm 10.9.7 (`npm pkg get name --workspaces`) and pnpm 9.15.0 (`pnpm ls -r --depth -1`).
 */
interface PackageList { include: string[]; exclude: string[] }
function packageList(patterns: unknown[], laterAddsBack: boolean): PackageList {
  const include: string[] = [];
  let exclude: string[] = [];
  for (const raw of patterns) {
    if (typeof raw !== "string") continue;
    const bangs = /^!*/.exec(raw)![0].length;
    const pattern = raw.slice(bangs).replace(/^\.?\/+/, "");
    if (!pattern) continue;
    if (bangs % 2 === 1) { exclude.push(pattern); continue; }
    if (laterAddsBack) exclude = exclude.filter((n) => !globMatches(pattern, n));
    include.push(pattern);
  }
  return { include, exclude };
}

/** Whether the "/"-separated `path` is matched by the workspace glob `glob` (a name, `*`, `**`, a name with `*` in it:
 * globSegments). A glob the wizard does not read (braces, ?, [ ]) matches nothing, so its folders stay listed. */
function globMatches(path: string, glob: string): boolean {
  const segs = globSegments(glob);
  if (!segs) return false;
  const parts = path.replace(/\/+$/, "").split("/");
  const at = (i: number, j: number): boolean => {
    if (j === segs.length) return i === parts.length;
    const s = segs[j];
    if ("deep" in s) return at(i, j + 1) || (i < parts.length && at(i + 1, j));
    if (i === parts.length) return false;
    const ok = "name" in s ? s.name === parts[i] : "any" in s ? true : s.re.test(parts[i]);
    return ok && at(i + 1, j + 1);
  };
  return at(0, 0);
}

/** The workspace's package lists: package.json's workspaces (read as npm reads them) and pnpm-workspace.yaml's packages
 * (as pnpm does). */
function workspaceLists(root: string): PackageList[] {
  const pkg = existsSync(join(root, "package.json")) ? readJson(join(root, "package.json")) : {};
  const ws = Array.isArray(pkg.workspaces) ? pkg.workspaces : Array.isArray(pkg.workspaces?.packages) ? pkg.workspaces.packages : [];
  return [packageList(ws, true), packageList(pnpmPackagesIn(root), false)];
}

/** The patterns that add workspace folders, negations left out (a list that holds every package, and perhaps more). */
export function workspaceGlobs(root: string): string[] {
  return workspaceLists(root).flatMap((l) => l.include);
}

/** Folders (relative to root, "/"-separated) of every workspace package with a package.json inside the root, in the
 * order the workspace lists them, without those a negated pattern takes out. The loop is the one findNextApps had. */
export function workspaceDirs(root: string): string[] {
  const realRoot = realpathSync(root);
  const dirs = new Set<string>();
  for (const list of workspaceLists(root)) {
    for (const g of list.include) {
      const clean = g.replace(/\/\*\*?$/, "").replace(/\/$/, "");
      const parent = join(root, clean);
      const candidates = g.endsWith("*") && existsSync(parent) && statSync(parent).isDirectory() ? readdirSync(parent).map((d) => join(parent, d)) : [join(root, clean)];
      for (const d of candidates) {
        if (!existsSync(join(d, "package.json")) || !isInside(realRoot, realpathSync(d))) continue;
        const rel = relative(root, d).split("\\").join("/");
        if (!list.exclude.some((n) => globMatches(rel, n))) dirs.add(rel);
      }
    }
  }
  return [...dirs];
}
