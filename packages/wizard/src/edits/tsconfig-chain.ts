import { posix } from "node:path";
import { readJsonc } from "../workspace.js";

// A tsconfig file with every file it extends and references, as TypeScript reads them: `extends` (a string or a list)
// with ".json" added when it is left off, a package's from node_modules (at the file's folder, the app folder or the
// repository's top); `references[].path`, a folder meaning its tsconfig.json. Only reads.

export interface TsconfigFile { rel: string; json: Record<string, any> }

/** The files from `start` (relative to the app folder), or { unread } naming the first one the wizard cannot read or
 * find. A missing `start` is no files at all. */
export function tsconfigChain(read: (rel: string) => string | null, start: string, top: string): TsconfigFile[] | { unread: string } {
  const out: TsconfigFile[] = [];
  const seen = new Set<string>();
  const visit = (rel: string, depth: number, optional: boolean): string | null => {
    if (seen.has(rel)) return null;
    seen.add(rel);
    const text = read(rel);
    if (text === null) return optional ? null : rel;
    const json = readJsonc(text);
    if (!json || depth > 8) return rel;
    out.push({ rel, json });
    const dir = posix.dirname(rel);
    for (const e of Array.isArray(json.extends) ? json.extends : json.extends === undefined ? [] : [json.extends]) {
      if (typeof e !== "string") return rel;
      const name = e.endsWith(".json") ? e : `${e}.json`;
      const candidates = e.startsWith(".") ? [posix.normalize(posix.join(dir, name))] : [dir, ".", top].flatMap((d) => [posix.join(d, "node_modules", name), posix.join(d, "node_modules", e, "tsconfig.json")]);
      const found = candidates.find((c) => read(c) !== null);
      if (!found) return `${rel}'s extends ${JSON.stringify(e)}`;
      const off = visit(found, depth + 1, false);
      if (off) return off;
    }
    for (const r of Array.isArray(json.references) ? json.references : []) {
      if (typeof r?.path !== "string") continue;
      const p = posix.normalize(posix.join(dir, r.path));
      const off = visit(p.endsWith(".json") ? p : posix.join(p, "tsconfig.json"), depth + 1, false);
      if (off) return off;
    }
    return null;
  };
  const off = visit(start, 0, true);
  return off ? { unread: off } : out;
}
