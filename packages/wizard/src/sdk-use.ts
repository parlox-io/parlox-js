import { lstatSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseCode, walk, type Node } from "./edits/splice.js";
import { PathError } from "./fs-safe.js";
import { packageCommand, type Plan } from "./plan-core.js";
import { compiledDirs } from "./scripts.js";
import { readText, type PackageManager } from "./workspace.js";

// Uninstall removes @parlox/server only when nothing in the app still imports it once the wizard's own lines are gone.
// The merchant's own code may use it: purchase() for confirmed orders (`createParlox` from "@parlox/server"), a flush()
// before shutdown, a type. Removing the package would break that code's build, so the package stays, and the review and
// the report say which file keeps it. Read only, and bounded like the own-reporting scan (own-reporting.ts); a scan that
// stops at its bounds cannot tell, so the package stays then too (an unused package breaks nothing). So does a scan
// that passed over part of the app's source: a source file over 1 MB, one the wizard may not read, a link to a source
// file or to a folder (the wizard never follows a link). Each could import the package.
//
// What is read: the app's own source files (not node_modules, build output, dot-folders, or folders with their own
// package.json, which are other packages), tests included, since a test that imports the package would fail too.
// - A file the uninstall changes is read as it will be (its text after the change): the wizard's lines are gone, and
//   whatever else imports the package counts.
// - A file whose Parlox lines the developer removes by hand (the uninstall's steps by hand), and a file another
//   integration of the same app edits (`others`, its server file): there the import of the adapter the wizard writes
//   is the wizard's own line and does not count; any other import of the package does.

const PACKAGE = /^@parlox\/server(?:\/|$)/;
/** The adapters the wizard's own lines import. */
const WIZARD_SOURCES = new Set(["@parlox/server/express", "@parlox/server/hono", "@parlox/server/next", "@parlox/server/vercel"]);
const SOURCE = /\.(?:[cm]?[jt]sx?|vue|svelte|astro)$/;
const PARSED = /\.[cm]?[jt]sx?$/;
const NOT_CODE = /\.d\.[cm]?ts$/;
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "out"]);
const MAX_FILES = 2000;
const MAX_FOLDERS = 2000;
const MAX_BYTES = 1_000_000;
// An import, export-from, require() or import() of the package, for a file the parser does not read (a .vue file).
const IMPORT_TEXT = /(?:\bfrom\s*|\brequire\s*\(\s*|\bimport\s*\(\s*|\bimport\s+)["'](@parlox\/server(?:\/[^"']*)?)["']/g;

/** A part of the app's source the scan did not read, and why. */
interface Skipped { file: string; why: string }
const LINK = "it is a link, which the wizard never follows";

/** The app's own source files, breadth first, at most MAX_FILES files and MAX_FOLDERS folders (`complete`: all read),
 * and the links among them that the scan does not follow (`skipped`): a link named like a source file, or a link to a
 * folder the walk would have opened. */
function sourceFiles(dir: string): { files: string[]; complete: boolean; skipped: Skipped[] } {
  const built = new Set(compiledDirs(readText(dir)).map((d) => d.out));
  const files: string[] = [];
  const skipped: Skipped[] = [];
  const queue = [""];
  let opened = 0;
  const walked = (name: string, rel: string) => !name.startsWith(".") && !SKIP_DIRS.has(name) && !built.has(rel);
  while (queue.length) {
    if (files.length >= MAX_FILES || opened >= MAX_FOLDERS) return { files, complete: false, skipped };
    const folder = queue.shift()!;
    opened++;
    let entries;
    try { entries = readdirSync(join(dir, folder), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)); }
    catch { return { files, complete: false, skipped }; }
    const rel = (name: string) => (folder ? `${folder}/${name}` : name);
    if (folder && entries.some((e) => e.name === "package.json")) continue;
    for (const e of entries) {
      if (e.isSymbolicLink()) {
        // Only its type is looked at (statSync follows the link); nothing is read through it.
        let target: "dir" | "other" = "other";
        try { if (statSync(join(dir, rel(e.name))).isDirectory()) target = "dir"; } catch { /* a dangling link */ }
        if (target === "dir" ? walked(e.name, rel(e.name)) : SOURCE.test(e.name) && !NOT_CODE.test(e.name)) skipped.push({ file: target === "dir" ? `${rel(e.name)}/` : rel(e.name), why: LINK });
        continue;
      }
      if (!e.isFile() || !SOURCE.test(e.name) || NOT_CODE.test(e.name)) continue;
      if (files.length >= MAX_FILES) return { files, complete: false, skipped };
      files.push(rel(e.name));
    }
    for (const e of entries) if (e.isDirectory() && walked(e.name, rel(e.name))) queue.push(rel(e.name));
  }
  return { files, complete: true, skipped };
}

/** The modules of the package a file's code imports (import, export … from, require(), import()), in order. */
function importsOf(text: string, file: string): string[] {
  const ast = PARSED.test(file) ? parseCode(text, file) : null;
  if (!ast) return [...text.matchAll(IMPORT_TEXT)].map((m) => m[1]);
  const out: string[] = [];
  const lit = (n: Node | null | undefined) => (n?.type === "StringLiteral" && PACKAGE.test(n.value) ? n.value : null);
  walk(ast.program, (n) => {
    const source = n.type === "ImportDeclaration" || n.type === "ExportNamedDeclaration" || n.type === "ExportAllDeclaration" ? lit(n.source)
      : n.type === "CallExpression" && ((n.callee.type === "Identifier" && n.callee.name === "require") || n.callee.type === "Import") ? lit(n.arguments[0])
      : n.type === "ImportExpression" ? lit(n.source)
      : n.type === "TSImportEqualsDeclaration" ? lit(n.moduleReference?.expression)
      : null;
    if (source) out.push(source);
  });
  return out;
}

/**
 * Why @parlox/server must stay in the app at `dir` once `plan` (one integration's uninstall) is applied, or null: it
 * may go. `read` reads the app's files as the uninstall leaves them so far; `others` are the files another integration
 * of this app edits. The reason names the file and the command to remove the package by hand later.
 */
export function serverPackageKept(dir: string, read: (rel: string) => string | null, plan: Plan, pm: PackageManager, others: string[] = []): string | null {
  const changed = new Map(plan.changes.map((c) => [c.path, c.after]));
  const byHand = new Set([...plan.manual.map((m) => m.file), ...others]);
  const command = packageCommand(pm, "remove", ["@parlox/server"]);
  const removal = `${command.command} ${command.args.join(" ")}`;
  const { files, complete, skipped } = sourceFiles(dir);
  for (const file of files) {
    let text: string | null;
    if (changed.has(file)) text = changed.get(file)!;
    else {
      try {
        if (lstatSync(join(dir, file)).size > MAX_BYTES) { skipped.push({ file, why: `it is larger than ${MAX_BYTES} bytes` }); continue; }
        // Read as the uninstall leaves it so far (null: an earlier change deletes it).
        text = read(file);
      } catch (err) {
        // fs-safe.ts refuses a path through a link, and a file over 1 MB.
        skipped.push({ file, why: !(err instanceof PathError) ? "the wizard could not read it" : /larger than/.test(err.message) ? `it is larger than ${MAX_BYTES} bytes` : LINK });
        continue;
      }
    }
    if (text === null || !text.includes("@parlox/server")) continue;
    const used = importsOf(text, file).filter((m) => !(byHand.has(file) && !changed.has(file) && WIZARD_SOURCES.has(m)));
    if (used.length) return `@parlox/server stays installed: ${file} imports ${used[0]}, an import the wizard did not write (your own code, such as purchase() for orders), and removing the package would break it. Once nothing imports it, remove it yourself: ${removal}`;
  }
  if (skipped.length) {
    const more = skipped.length - 1;
    return `@parlox/server stays installed: the wizard did not read ${skipped[0].file} (${skipped[0].why})${more ? ` and ${more} other ${more === 1 ? "file" : "files"}` : ""}, so it cannot tell whether your own code imports it. If nothing does, remove it yourself: ${removal}`;
  }
  if (!complete) return `@parlox/server stays installed: the wizard read the first ${MAX_FILES} source files and ${MAX_FOLDERS} folders of this app and stopped, so it cannot tell whether your own code imports it. If nothing does, remove it yourself: ${removal}`;
  return null;
}
