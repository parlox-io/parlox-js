import { diffLines } from "diff";
import type { Plan } from "../plan.js";
import { renderDiff, shownChange } from "../diff.js";
import { scrub } from "./scrub.js";
import { printable } from "./text.js";

export interface ChangeRow { path: string; kind: "created" | "edited" | "deleted"; added: number; removed: number; purpose: string }

export function purposeOf(path: string): string {
  const base = path.split("/").pop() ?? path;
  if (/^layout\.(tsx|ts|jsx|js)$/.test(base) || /^_app\.(tsx|ts|jsx|js)$/.test(base)) return "browser part";
  if (/^(proxy|middleware)\.(ts|js)$/.test(base)) return "server part";
  if (base === ".env.local") return "ownership token";
  if (base === ".gitignore") return "keeps .env.local out of git";
  return "";
}

/** The change list's rows: lines added and removed as the review shows them (an env file's other lines are not). */
export function summarizeChanges(plan: Plan): ChangeRow[] {
  return plan.changes.map((change) => {
    const c = shownChange(change);
    let added = 0, removed = 0;
    for (const part of diffLines(c.before ?? "", c.after ?? "")) {
      const lines = part.count ?? 0;
      if (part.added) added += lines;
      else if (part.removed) removed += lines;
    }
    return { path: c.path, kind: c.before === null ? "created" : c.after === null ? "deleted" : "edited", added, removed, purpose: c.purpose || purposeOf(c.path) };
  });
}

/** The plan's unified diff as lines to print: scrubbed first (a secret is always contiguous in the diff, one line of
 * file content, so it is hidden whole), then each line made printable, so the diff shows exactly what is written
 * (escape codes, carriage returns and invisible format characters written out; tabs left to the terminal). A face
 * colours these lines afterwards, so an escape code can never split "[hidden]". */
export function printableDiff(plan: Plan): string[] {
  return scrub(renderDiff(plan.changes)).split("\n").map((line) => printable(line, { keepTabs: true }));
}
