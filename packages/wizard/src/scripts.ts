import { posix } from "node:path";
import { parseCode, walk, type Ast } from "./edits/splice.js";
import { readJsonc } from "./workspace.js";

// Which file a server app runs, found the way a developer would: the start or dev script, then package.json's main,
// then the usual file names. Nothing is run. Compiled output is never the answer, wherever it is reached from: a path
// into it stands for the source it is built from (tsconfig's outDir back to its rootDir), and a .js beside its own .ts
// (tsc run in place) stands for the .ts.

const RUNNERS = new Set(["node", "nodemon", "tsx", "ts-node", "ts-node-dev", "bun", "node-dev"]);
export const NODE_VALUE_FLAGS = new Set(["-r", "--require", "--import", "--loader", "--experimental-loader", "--env-file", "--env-file-if-exists", "--watch-path", "--inspect-port", "-C", "--conditions", "--input-type", "--title", "--stack-size", "--preload", "--tsconfig"]);
const NODEMON_VALUE_FLAGS = new Set(["-w", "--watch", "-e", "--ext", "-x", "--exec", "-i", "--ignore", "-d", "--delay", "-s", "--signal", "--config"]);
const INLINE = new Set(["-e", "--eval", "-p", "--print"]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * The file a package.json script runs with node, tsx, ts-node, nodemon or bun ("node ./bin/www", "tsx watch
 * src/index.ts", "node --watch --env-file=.env server.js", "bun run --hot src/index.ts"), relative to the package; null
 * when it runs something else (a build tool, a framework CLI, inline code). Only the first command of a chain counts.
 */
export function scriptFile(script: string): string | null {
  const first = script.split(/&&|\|\||;|\|/)[0].trim();
  const words = (first.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((w) => w.replace(/^(["'])(.*)\1$/, "$2"));
  let i = 0;
  const skipAssignments = () => { while (i < words.length && ASSIGNMENT.test(words[i])) i++; };
  skipAssignments();
  if (words[i] === "cross-env") { i++; skipAssignments(); }
  if ((words[i] === "dotenvx" && words[i + 1] === "run") || words[i] === "dotenv") {
    const dashes = words.indexOf("--", i);
    if (dashes < 0) return null;
    i = dashes + 1;
  }
  const runner = words[i];
  if (!runner || !RUNNERS.has(runner)) return null;
  i++;
  if ((runner === "tsx" && words[i] === "watch") || (runner === "bun" && words[i] === "run")) i++;
  const valueFlags = runner === "nodemon" ? NODEMON_VALUE_FLAGS : NODE_VALUE_FLAGS;
  for (; i < words.length; i++) {
    const w = words[i];
    if (runner !== "nodemon" && INLINE.has(w)) return null;
    if (w.startsWith("-")) { if (!w.includes("=") && valueFlags.has(w)) i++; continue; }
    return w.replace(/^\.\//, "");
  }
  return null;
}

const EXTS = ["", ".ts", ".tsx", ".js", ".mjs", ".cjs", ".mts", ".cts", "/index.ts", "/index.js", "/index.mjs", "/index.cjs"];

/** A relative path resolved to a file of the app, trying the extensions Node and TypeScript try (a TypeScript file
 * imported as "./app.js" is ./app.ts). Null when nothing matches, or the path leaves the app. */
export function resolveLocal(read: (rel: string) => string | null, fromDir: string, spec: string): string | null {
  const base = posix.normalize(posix.join(fromDir || ".", spec));
  if (base === ".." || base.startsWith("../") || posix.isAbsolute(base)) return null;
  for (const stem of [...new Set([base, base.replace(/\.(m|c)?js$/, "")])]) {
    for (const ext of EXTS) { const f = posix.normalize(stem + ext); if (read(f) !== null) return f; }
  }
  return null;
}

/** The relative specifiers a file imports or requires ("./app", "../lib/server.js"). */
export function localImports(ast: Ast): string[] {
  const specs: string[] = [];
  walk(ast.program, (n) => {
    const s = n.type === "ImportDeclaration" ? n.source?.value
      : n.type === "CallExpression" && ((n.callee.type === "Identifier" && n.callee.name === "require") || n.callee.type === "Import") && n.arguments[0]?.type === "StringLiteral" ? n.arguments[0].value
      : n.type === "ImportExpression" && n.source?.type === "StringLiteral" ? n.source.value : null;
    if (typeof s === "string" && /^\.\.?\//.test(s)) specs.push(s);
  });
  return specs;
}

/** Whether a file imports or requires one of `names` (whole module names: "express", not "express-session"), with
 * import() too. */
export function importsModule(code: string, file: string, names: string[]): boolean {
  if (!names.some((n) => code.includes(n))) return false;
  const ast = parseCode(code, file);
  if (!ast) return false;
  let found = false;
  walk(ast.program, (n) => {
    if (found) return;
    const s = n.type === "ImportDeclaration" ? n.source?.value
      : n.type === "CallExpression" && ((n.callee.type === "Identifier" && n.callee.name === "require") || n.callee.type === "Import") && n.arguments[0]?.type === "StringLiteral" ? n.arguments[0].value
      : n.type === "ImportExpression" && n.source?.type === "StringLiteral" ? n.source.value : null;
    if (typeof s === "string" && names.includes(s)) found = true;
  });
  return found;
}

// Where compiled output goes: these folders, tsconfig's outDir, and any folder at the top whose name starts with a dot
// (.build, .output: generated).
const BUILD_DIRS = ["dist", "build", "out"];
const SOURCE_EXTS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", "/index.ts", "/index.tsx", "/index.js", "/index.mjs", "/index.cjs"];
const TS_TWINS: Record<string, string[]> = { ".js": [".ts", ".tsx"], ".jsx": [".tsx"], ".mjs": [".mts"], ".cjs": [".cts"] };

/** A folder of compiled output, and the folder it is compiled from (tsconfig's rootDir; null: not set). */
export interface CompiledDir { out: string; root: string | null }

const cleanDir = (p: unknown): string | null => {
  if (typeof p !== "string" || !p.trim()) return null;
  const n = posix.normalize(p.trim().replace(/\\/g, "/")).replace(/\/+$/, "");
  return n === "" || n === ".." || n.startsWith("../") || posix.isAbsolute(n) ? null : n;
};

/** The app's compiled-output folders: dist, build, out, and tsconfig.json's outDir (with its rootDir). tsconfig's
 * `extends` is not followed. */
export function compiledDirs(read: (rel: string) => string | null): CompiledDir[] {
  const options = readJsonc(read("tsconfig.json"))?.compilerOptions;
  const outDir = cleanDir(options?.outDir);
  const rootDir = cleanDir(options?.rootDir);
  const dirs: CompiledDir[] = BUILD_DIRS.map((out) => ({ out, root: out === outDir ? rootDir : null }));
  if (outDir && outDir !== "." && !BUILD_DIRS.includes(outDir)) dirs.unshift({ out: outDir, root: rootDir });
  return dirs;
}

/** The compiled-output folder `path` is in, or null. */
export function compiledIn(path: string, dirs: CompiledDir[]): CompiledDir | null {
  const top = path.split("/")[0];
  if (top.startsWith(".") && top !== "." && top !== "..") return { out: top, root: null };
  return dirs.find((d) => path === d.out || path.startsWith(`${d.out}/`)) ?? null;
}

/** The .ts beside a .js of the same name (tsc run in place writes one next to the other), else the file itself. */
function preferSource(read: (rel: string) => string | null, file: string): string {
  const ext = posix.extname(file);
  for (const twin of TS_TWINS[ext] ?? []) { const f = file.slice(0, -ext.length) + twin; if (read(f) !== null) return f; }
  return file;
}

/** The source a compiled path is built from: the same path under rootDir (src/, then the app's folder, when tsconfig
 * does not say), with a source extension. Null when there is none. */
function sourceOf(read: (rel: string) => string | null, path: string, dir: CompiledDir, dirs: CompiledDir[]): string | null {
  const rest = path === dir.out ? "" : path.slice(dir.out.length + 1);
  if (!rest) return null;
  const stem = rest.replace(/\.(?:[cm]?js|jsx)$/, "");
  for (const root of dir.root !== null ? [dir.root] : ["src", "."]) {
    for (const ext of SOURCE_EXTS) {
      const f = posix.normalize(`${root}/${stem}${ext}`);
      if (!compiledIn(f, dirs) && read(f) !== null) return preferSource(read, f);
    }
  }
  return null;
}

/** A path the app runs or imports, as the file to edit: resolved like resolveLocal, compiled output mapped back to its
 * source, a .js replaced by its own .ts. Null when there is no such source file. */
export function sourceFile(read: (rel: string) => string | null, fromDir: string, spec: string, dirs: CompiledDir[] = compiledDirs(read)): string | null {
  const base = posix.normalize(posix.join(fromDir || ".", spec));
  if (base === ".." || base.startsWith("../") || posix.isAbsolute(base)) return null;
  const built = compiledIn(base, dirs);
  if (built) return sourceOf(read, base, built, dirs);
  const f = resolveLocal(read, fromDir, spec);
  if (f === null) return null;
  const inBuild = compiledIn(f, dirs);
  return inBuild ? sourceOf(read, f, inBuild, dirs) : preferSource(read, f);
}

// `npm run serve`, `pnpm watch`, `yarn run dev`, `bun run dev`: another script of the same package.
const RUNS_SCRIPT = /^(?:npm\s+(?:run|run-script)|pnpm(?:\s+run)?|yarn(?:\s+run)?|bun\s+run)\s+([^\s&|;-][^\s&|;]*)/;

/** A command without what only sets its environment: `NODE_ENV=production`, `cross-env …`. */
export function withoutEnv(command: string): string {
  const words = command.trim().split(/\s+/);
  let i = 0;
  const skipAssignments = () => { while (i < words.length && ASSIGNMENT.test(words[i])) i++; };
  skipAssignments();
  if (words[i] === "cross-env") { i++; skipAssignments(); }
  return words.slice(i).join(" ");
}

/** The files a command line runs, command by command (`npm run build && npm run serve`): each command's own file
 * (scriptFile), and, for a command that runs another script of the package, that script's files, and so on (at most
 * 5 scripts; one that runs itself ends). Paths as written, relative to the package. */
function commandFiles(pkg: Record<string, any>, line: string, seen = new Set<string>()): string[] {
  const out: string[] = [];
  for (const command of line.split(/&&|\|\||;|\|/)) {
    const own = scriptFile(command);
    if (own) out.push(own);
    const next = RUNS_SCRIPT.exec(withoutEnv(command));
    if (next) out.push(...scriptFiles(pkg, next[1], seen));
  }
  return out;
}

/** The files the script `name` runs (commandFiles). */
function scriptFiles(pkg: Record<string, any>, name: string, seen = new Set<string>()): string[] {
  const script = pkg.scripts?.[name];
  if (typeof script !== "string" || seen.has(name) || seen.size >= 5) return [];
  seen.add(name);
  return commandFiles(pkg, script, seen);
}

// A script of the package run anywhere in a command line, quoted too (`concurrently "npm run a" "pnpm b"`). `pnpm x`
// and `yarn x` run the script x when there is one.
const RUNS_SCRIPT_ANYWHERE = /(?:^|[\s;&|("'`])(?:npm\s+(?:run|run-script)|pnpm(?:\s+run)?|yarn(?:\s+run)?|bun\s+run)\s+([^\s&|;"'`()-][^\s&|;"'`()]*)/g;
const hasOwn = (o: Record<string, unknown>, key: string) => Object.prototype.hasOwnProperty.call(o, key);

/** A command line, then every script of the package it runs, each once, with the pre and post scripts npm runs beside
 * it (`npm run bundle`: prebundle, bundle, postbundle), and the scripts those run. Every script is visited at most
 * once, so a script that runs itself ends. */
export function commandLines(pkg: Record<string, any>, line: string): string[] {
  const scripts: Record<string, unknown> = pkg.scripts && typeof pkg.scripts === "object" ? pkg.scripts : {};
  const out = [line];
  const seen = new Set<string>();
  for (let i = 0; i < out.length; i++) {
    for (const m of out[i].matchAll(RUNS_SCRIPT_ANYWHERE)) {
      if (seen.has(m[1])) continue;
      seen.add(m[1]);
      for (const name of [`pre${m[1]}`, m[1], `post${m[1]}`]) if (hasOwn(scripts, name) && typeof scripts[name] === "string") out.push(scripts[name] as string);
    }
  }
  return out;
}

/** The words of a command line that could name a file it runs, wherever they are (`npx tsx scripts/b.ts`, `sh -c "node
 * x.mjs"`, `--import=./y.mjs`): split at spaces, quotes, the shell's separators and `=`; flags left out. */
export function commandWords(line: string): string[] {
  return line.split(/[\s;&|()<>`"'=]+/).filter((w) => w !== "" && !w.startsWith("-"));
}

/** In order: the files the start and dev scripts run (following `npm run <script>`), package.json's main, then
 * server, index and app in the folder and in src/ (.ts, .js, .mjs, .cjs). Compiled output (dist/, build/, out/,
 * tsconfig's outDir, dot-folders, and `built`: output an integration knows of, as wrangler's [build] bundle) is never a
 * candidate: a path into it stands for its source. */
export function serverFileCandidates(read: (rel: string) => string | null, pkg: Record<string, any>, built: CompiledDir[] = []): string[] {
  const dirs = [...compiledDirs(read), ...built];
  const out: string[] = [];
  const add = (f: string | null) => { if (f && !out.includes(f) && !compiledIn(f, dirs)) out.push(f); };
  for (const name of ["start", "dev"]) for (const f of scriptFiles(pkg, name)) add(sourceFile(read, "", f, dirs));
  if (typeof pkg.main === "string") add(sourceFile(read, "", pkg.main, dirs));
  for (const dir of ["", "src/"]) for (const base of ["server", "index", "app"]) for (const ext of ["ts", "js", "mjs", "cjs"]) {
    const f = `${dir}${base}.${ext}`;
    if (read(f) !== null) add(preferSource(read, f));
  }
  return out;
}

/** The first candidate for which `isServer` holds, or a file it imports locally (up to two steps: express-generator's
 * bin/www requires ../app). An import of compiled output (`built` too) is followed to its source. */
export function findServerFile(read: (rel: string) => string | null, candidates: string[], isServer: (code: string, file: string) => boolean, built: CompiledDir[] = []): { file: string; code: string } | null {
  const dirs = [...compiledDirs(read), ...built];
  const seen = new Set<string>();
  const visit = (f: string, depth: number): { file: string; code: string } | null => {
    if (seen.has(f) || compiledIn(f, dirs)) return null;
    seen.add(f);
    const code = read(f);
    if (code === null) return null;
    if (isServer(code, f)) return { file: f, code };
    if (depth >= 2) return null;
    const ast = parseCode(code, f);
    if (!ast) return null;
    const from = posix.dirname(f) === "." ? "" : posix.dirname(f);
    for (const spec of localImports(ast)) {
      const next = sourceFile(read, from, spec, dirs);
      const r = next ? visit(next, depth + 1) : null;
      if (r) return r;
    }
    return null;
  };
  for (const c of candidates) { const r = visit(c, 0); if (r) return r; }
  return null;
}
