import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { parseCode, walk, type Node } from "./edits/splice.js";
import { viteConfigArgs } from "./edits/vite-exposure.js";
import { wranglerOf } from "./hosts.js";
import { compiledDirs } from "./scripts.js";
import { readText } from "./workspace.js";

// An app that already reports to Parlox with its own code (its own POST to /v1/s): adding the
// server part beside it would count every crawler visit twice, so the server integrations (Express, Hono) plan no
// server part for it and say where that code is. Read only, and bounded.
//
// What counts, in the app's own source files:
// - a string holding Parlox's server-event path (".../v1/s", alone or before ? or #), in a file that names Parlox
//   anywhere (its gateway, a PARLOX_ variable, a comment), so another API's /v1/s route is not taken for it;
// - a use of PARLOX_SECRET_KEY in code (`process.env.PARLOX_SECRET_KEY`, `env["PARLOX_SECRET_KEY"]`, destructured):
//   that variable is Parlox's, and only @parlox/server reads it.
// Not counted: comments, TypeScript types (a Workers `Bindings` type names the variable without reading it), files
// that import @parlox/server (the SDK reading its own key), declaration files, tests (a test sets the variable; it
// reports nothing), and Vite configs (a build setting, which the Vite checks judge: Vite's default names, and any file
// the package's scripts, vercel.json's buildCommand or wrangler's [build] command give Vite with --config, as
// folderViteNamesSecretKey reads them). A /v1/s hit is named before a
// PARLOX_SECRET_KEY one: it is the reporting call itself. When the app declares @parlox/server, a use of the key alone
// is not own reporting: it is the SDK's documented secretKey option, or an env schema that names the variable.

export interface OwnReport { file: string; line: number }
/** What the scan found, and what it did not read (past its caps), or null when it read the whole app. */
export interface OwnReportScan { found: OwnReport | null; notChecked: string | null }

export const OWN_REPORT_KIND = "own-report";
export const ownReportWarning = (r: OwnReport): string =>
  `This app already reports to Parlox with its own code (${r.file}:${r.line}). Adding the server part would count visits twice: remove that code, then run the wizard again.`;

/** At most this many source files are read, and this many folders opened (here, and for another runtime's imports:
 * integrations/hono.ts). */
const MAX_FILES = 200;
const MAX_FOLDERS = 500;
const NOT_CHECKED = `Not checked for code of its own that reports to Parlox past the first ${MAX_FILES} source files and ${MAX_FOLDERS} folders of this app: if it has such code, remove it, or visits will be counted twice.`;
const MAX_BYTES = 1_000_000;
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "out", "test", "tests", "__tests__", "__mocks__"]);
const SOURCE = /\.(?:js|jsx|mjs|cjs|ts|tsx|mts|cts)$/;
// A Vite config is not reporting code: one that names PARLOX_SECRET_KEY is the Vite checks' (vite-exposure.ts), which
// withhold the server part with the reason.
const NOT_CODE = /\.d\.[cm]?ts$|\.(?:test|spec)\.[cm]?[jt]sx?$|^vite\.config\.[cm]?[jt]s$/;
const KEY = "PARLOX_SECRET_KEY";
const ENDPOINT = /\/v1\/s(?:$|[?#])/;
const ENDPOINT_TEXT = /\/v1\/s(?:$|[?#"'`])/m;
const SDK = /^@parlox\/server(?:\/|$)/;
// TypeScript nodes that hold a value (`x as string`, `x!`), not a type.
const VALUE_TS = new Set(["TSAsExpression", "TSSatisfiesExpression", "TSNonNullExpression", "TSTypeAssertion", "TSInstantiationExpression", "TSParameterProperty", "TSExportAssignment"]);

/** The app's own source files, "/"-separated, in the order they are read: the app's folder first, then its folders by
 * name, breadth first. Skipped: node_modules, build output (tsconfig's outDir too), tests, dot-folders, links, and
 * folders with their own package.json (another package). At most MAX_FILES files and MAX_FOLDERS folders; `complete`
 * is false when the walk stopped at either with more left. */
export function appSourceFiles(dir: string): { files: string[]; complete: boolean } {
  const built = new Set(compiledDirs(readText(dir)).map((d) => d.out));
  const files: string[] = [];
  const queue = [""];
  let opened = 0;
  while (queue.length) {
    if (files.length >= MAX_FILES || opened >= MAX_FOLDERS) return { files, complete: false };
    const folder = queue.shift()!;
    opened++;
    let entries;
    try { entries = readdirSync(join(dir, folder), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)); }
    catch { continue; }
    const rel = (name: string) => (folder ? `${folder}/${name}` : name);
    if (folder && entries.some((e) => e.name === "package.json")) continue;
    const source = entries.filter((e) => e.isFile() && SOURCE.test(e.name) && !NOT_CODE.test(e.name));
    for (const e of source) {
      if (files.length >= MAX_FILES) return { files, complete: false };
      files.push(rel(e.name));
    }
    for (const e of entries) if (e.isDirectory() && !e.name.startsWith(".") && !SKIP_DIRS.has(e.name) && !built.has(rel(e.name))) queue.push(rel(e.name));
  }
  return { files, complete: true };
}

const loadsSdk = (n: Node): boolean => {
  const lit = n.type === "ImportDeclaration" || n.type === "ExportNamedDeclaration" || n.type === "ExportAllDeclaration" ? n.source
    : n.type === "CallExpression" && ((n.callee.type === "Identifier" && n.callee.name === "require") || n.callee.type === "Import") ? n.arguments[0]
    : n.type === "ImportExpression" ? n.source : null;
  return lit?.type === "StringLiteral" && SDK.test(lit.value);
};

/** The first endpoint string and the first use of the key in one file's code, by line; "sdk" when it loads the SDK. */
function hitsIn(text: string, file: string): { endpoint: number | null; key: number | null } | "sdk" {
  const names = /parlox/i.test(text);
  const ast = parseCode(text, file);
  if (!ast) {
    // Unreadable as code: its text decides, so a file the parser cannot read is not a way past the check.
    if (text.includes("@parlox/server")) return "sdk";
    const lines = text.split(/\r\n|\n|\r/);
    const at = (test: (l: string) => boolean) => { const i = lines.findIndex(test); return i < 0 ? null : i + 1; };
    return { endpoint: names ? at((l) => ENDPOINT_TEXT.test(l)) : null, key: at((l) => l.includes(KEY)) };
  }
  let sdk = false;
  let endpoint: number | null = null;
  let key: number | null = null;
  const first = (cur: number | null, n: Node) => { const line = n.loc?.start?.line ?? 1; return cur === null ? line : Math.min(cur, line); };
  walk(ast.program, (n, ancestors) => {
    if (sdk) return;
    if (loadsSdk(n)) { sdk = true; return; }
    if (ancestors.some((a) => a.type.startsWith("TS") && !VALUE_TS.has(a.type))) return;
    if (names && (n.type === "StringLiteral" && ENDPOINT.test(n.value) || n.type === "TemplateElement" && ENDPOINT.test(n.value?.cooked ?? n.value?.raw ?? ""))) endpoint = first(endpoint, n);
    if ((n.type === "Identifier" && n.name === KEY) || (n.type === "StringLiteral" && n.value === KEY)) key = first(key, n);
  });
  return sdk ? "sdk" : { endpoint, key };
}

/** The files the app's commands give Vite with --config (or -c), "/"-separated relative to `dir`: the package's
 * scripts, vercel.json's buildCommand and wrangler's [build] command. */
function viteConfigFiles(dir: string): Set<string> {
  const read = readText(dir);
  const json = (rel: string): Record<string, any> | null => { try { const v = JSON.parse((read(rel) ?? "null").replace(/^\uFEFF/, "")); return v && typeof v === "object" ? v : null; } catch { return null; } };
  const scripts = json("package.json")?.scripts;
  const commands = [...(scripts && typeof scripts === "object" ? Object.values(scripts) : []), json("vercel.json")?.buildCommand, wranglerOf(read)?.build];
  const out = new Set<string>();
  for (const c of commands) if (typeof c === "string") for (const f of viteConfigArgs(c)) out.add(posix.normalize(f.replace(/\\/g, "/")));
  return out;
}

/** Whether the app at `dir` declares @parlox/server (dependencies or devDependencies). */
function declaresSdk(dir: string): boolean {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    return Boolean(pkg?.dependencies?.["@parlox/server"] || pkg?.devDependencies?.["@parlox/server"]);
  } catch { return false; }
}

/** Where the app at `dir` reports to Parlox with its own code (null: not in the files read), and what was not read. */
export function ownReporting(dir: string): OwnReportScan {
  const keyCounts = !declaresSdk(dir);
  const { files, complete } = appSourceFiles(dir);
  const viteConfigs = viteConfigFiles(dir);
  let keyHit: OwnReport | null = null;
  for (const file of files) {
    if (viteConfigs.has(file)) continue;
    let text: string;
    try {
      const p = join(dir, file);
      if (lstatSync(p).size > MAX_BYTES) continue;
      text = readFileSync(p, "utf8");
    } catch { continue; }
    if (!text.includes(KEY) && !text.includes("/v1/s")) continue;
    const hits = hitsIn(text, file);
    if (hits === "sdk") continue;
    if (hits.endpoint !== null) return { found: { file, line: hits.endpoint }, notChecked: null };
    if (keyCounts && hits.key !== null && !keyHit) keyHit = { file, line: hits.key };
  }
  return { found: keyHit, notChecked: keyHit || complete ? null : NOT_CHECKED };
}
