import { execFileSync } from "node:child_process";
import { lstatSync } from "node:fs";
import { join } from "node:path";
import { childEnv } from "./run.js";

export interface Git { isRepo(): boolean; dirty(): string[]; isTracked(rel: string): boolean; isIgnored(rel: string): boolean }

// git is a real executable on every platform (git.exe on Windows), so no shell is needed. It gets the same
// environment as every other child (childEnv), so nothing it starts looks in the project folder for commands first.
const ok = (dir: string, args: string[]) => { try { execFileSync("git", args, { cwd: dir, stdio: "ignore", env: childEnv() }); return true; } catch { return false; } };

export function gitFor(dir: string): Git {
  return {
    isRepo: () => ok(dir, ["rev-parse", "--is-inside-work-tree"]),
    dirty: () => {
      try { return execFileSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8", env: childEnv() }).split("\n").filter(Boolean).map((l) => l.slice(3)); }
      catch { return []; }
    },
    isTracked: (rel) => ok(dir, ["ls-files", "--error-unmatch", "--", rel]),
    isIgnored: (rel) => ok(dir, ["check-ignore", "-q", "--", rel]),
  };
}

/** A file git lists: its path relative to the folder asked about ("/"-separated), and what it is: a file, a symbolic
 * link (git keeps the link, not what it points to), a submodule git has not checked out, or a git repository of its own
 * inside this one that is not added to it (git lists neither of the last two's files). */
export interface GitEntry { path: string; kind: "file" | "link" | "submodule" | "repository" }

// The most a listing may print: past this git's output is cut, and the caller gets null rather than part of a list.
const LIST_BYTES = 64 * 1024 * 1024;
const lsFiles = (dir: string, args: string[]): string[] =>
  execFileSync("git", ["ls-files", "-z", ...args], { cwd: dir, encoding: "utf8", env: childEnv(), stdio: ["ignore", "pipe", "ignore"], maxBuffer: LIST_BYTES }).split("\0").filter(Boolean);

/** `ls-files --stage` lines as paths and kinds: the mode tells links (120000) and submodules (160000) from files. */
function staged(lines: string[]): Map<string, GitEntry["kind"]> {
  const entries = new Map<string, GitEntry["kind"]>();
  for (const line of lines) {
    const mode = line.slice(0, line.indexOf(" "));
    entries.set(line.slice(line.indexOf("\t") + 1), mode === "120000" ? "link" : mode === "160000" ? "submodule" : "file");
  }
  return entries;
}

/**
 * The files in `dir` that git tracks (the files of checked-out submodules included) or would add (untracked and not
 * ignored), relative to `dir`; null when `dir` is not in a git work tree, git is missing or fails, or the list is
 * longer than git's output may be. -z: names as they are, never quoted.
 * - A submodule that is initialised but never checked out is left out of the recursive listing altogether, so every
 *   submodule the top-level listing names with no file listed under it counts as not checked out.
 * - An untracked folder that is a git repository of its own is listed by its name with a slash after it, and nothing in
 *   it: a "repository". An untracked link is told by lstat.
 */
export function gitFiles(dir: string): GitEntry[] | null {
  try {
    const entries = staged(lsFiles(dir, ["--stage", "--recurse-submodules"]));
    const listed = [...entries.keys()];
    for (const [path, kind] of staged(lsFiles(dir, ["--stage"]))) {
      if (kind === "submodule" && !listed.some((p) => p.startsWith(`${path}/`))) entries.set(path, "submodule");
    }
    for (const path of lsFiles(dir, ["--others", "--exclude-standard"])) {
      if (path.endsWith("/")) { entries.set(path.replace(/\/+$/, ""), "repository"); continue; }
      if (entries.has(path)) continue;
      let link = false;
      try { link = lstatSync(join(dir, path)).isSymbolicLink(); } catch { /* gone since git listed it: a file name */ }
      entries.set(path, link ? "link" : "file");
    }
    return [...entries].map(([path, kind]) => ({ path, kind }));
  } catch { return null; }
}
