import { createTwoFilesPatch } from "diff";
import { isEnvFile, type FileChange } from "./plan-core.js";

// An env file holds the developer's own variables (a database URL, a payment key) beside Parlox's line, so the review
// never shows it whole: only Parlox's own line, PARLOX_VERIFY_TOKEN (public by design), and how many other lines the
// file has. Their values never reach a screen, a terminal's scrollback or a CI log. Both faces and the change list
// read changes through shownChange().
const PARLOX_LINE = /^\s*(?:export\s+)?PARLOX_VERIFY_TOKEN\s*=/;

const linesOf = (text: string | null): string[] => {
  if (!text) return [];
  const lines = text.split(/\r?\n/);
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
};

/** A change as the review shows it: an env file (isEnvFile) with each of its lines other than Parlox's own replaced by
 * a numbered stand-in (the same line, the same number, so a diff still lines up and keeps the file's line numbers),
 * and the number of those lines (after the change; before it, for a file the change deletes) in `hiddenLines`. Any
 * other file, or a change already reduced, as it is. */
export function shownChange(c: FileChange): FileChange {
  if (c.hiddenLines !== undefined || !isEnvFile(c.path)) return c;
  const ids = new Map<string, number>();
  const stand = (l: string) => { if (!ids.has(l)) ids.set(l, ids.size + 1); return `[your line ${ids.get(l)}, not shown]`; };
  const shown = (text: string | null) => (text === null ? null : linesOf(text).map((l) => `${PARLOX_LINE.test(l) ? l : stand(l)}\n`).join(""));
  const hiddenLines = linesOf(c.after ?? c.before).filter((l) => !PARLOX_LINE.test(l)).length;
  return { ...c, before: shown(c.before), after: shown(c.after), hiddenLines };
}

const otherLines = (n: number) => ` ${n} other line${n === 1 ? "" : "s"} in this file, not shown`;

export function renderDiff(changes: FileChange[]): string {
  return changes.map((change) => {
    const c = shownChange(change);
    // An env file's diff has no context lines: only the lines the change adds or removes, then the count of the rest.
    const patch = createTwoFilesPatch(c.before === null ? "/dev/null" : `a/${c.path}`, c.after === null ? "/dev/null" : `b/${c.path}`, c.before ?? "", c.after ?? "", "", "", { context: c.hiddenLines === undefined ? 3 : 0 });
    return c.hiddenLines ? `${patch}${otherLines(c.hiddenLines)}\n` : patch;
  }).join("\n");
}
