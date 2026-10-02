import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, posix, relative, sep } from "node:path";
import { readViteSettings, VITE_CONFIGS, viteConfigNamesSecretKey, type AppFolders, type SecretExposure } from "../edits/vite-config.js";
import { BY_HAND, viteConfigArgs } from "../edits/vite-exposure.js";
import { globSegments, harmlessInstall, HUSKY, INSTALL_SCRIPTS, type Packages, type PathKind, type WorkspacePackage } from "../edits/vite-install.js";
import { VERCEL_CONFIGS } from "../edits/vite-vercel.js";
import { gitFiles, type GitEntry } from "../git.js";
import { wranglerOf } from "../hosts.js";
import { commandLines, commandWords, importsModule, resolveLocal, withoutEnv } from "../scripts.js";
import { hasDep, readJson, readText, repoTopOf, workspaceGlobs } from "../workspace.js";

// What the Vite checks need of a folder besides its Vite config: whether the folder runs a Vite build (its scripts and
// the commands a host runs), the Vite apps below it, the checks a server integration (Express, Hono) runs on the Vite
// builds its key could reach (folderViteCheck, folderViteNamesSecretKey), and what a check needs of the app's folders
// (appFolders: listing, the workspace, its packages, the repository's top). Read only.

// A command that runs Vite, or a framework CLI that builds with it (React Router's `react-router build`, Astro's
// `astro build`…), anywhere in a script: after a separator, a path, a quote or a backtick (`concurrently "vite build"`),
// with or without @version (`npx vite@7 build`), or as node_modules/vite/bin/vite.js. Not `vitest` or `vite-node`.
const RUNS_VITE = /(?:^|[\s;&|(/"'`])(?:vite|react-router|remix|astro|nuxt|nuxi|vike|vinxi|waku|qwik|rw|redwood)(?:@[^\s"'`;&|)]*|\/bin\/vite\.js)?(?=$|[\s;&|)"'`])/;
// Frameworks that build with Vite, whose package may not declare vite itself (it comes with the framework).
const VITE_FRAMEWORKS = ["astro", "nuxt", "@sveltejs/kit", "@react-router/dev", "@remix-run/dev", "@tanstack/react-start", "@tanstack/start", "vike", "vite-plugin-ssr", "waku", "@redwoodjs/core", "@redwoodjs/vite"];

/** Whether a command runs Vite (RUNS_VITE). */
export const runsVite = (command: unknown): boolean => typeof command === "string" && RUNS_VITE.test(command);

// TOML's escapes in basic strings (toml.io, v1.0.0 and v1.1.0): \b \t \n \f \r \e \" \\ \xHH \uHHHH \UHHHHHHHH, and in
// a multi-line basic string a backslash at the end of a line, which drops that line break and the white space after it.
const TOML_ESCAPES: Record<string, string> = { b: "\b", t: "\t", n: "\n", f: "\f", r: "\r", e: "\x1b", '"': '"', "\\": "\\" };
const TOML_ESCAPE = /\\(?:([btnfre"\\])|x([0-9A-Fa-f]{2})|u([0-9A-Fa-f]{4})|U([0-9A-Fa-f]{8})|[ \t]*\r?\n\s*)/g;

/** A TOML string's value, as written between its delimiters: a literal string ('…' or its multi-line form) as it is, a
 * basic string ("…" or its multi-line form) with its escapes; a multi-line string loses the line break right after its
 * opening delimiter. An escape TOML does not define is left as written (the file then fails to parse for Netlify, which
 * builds nothing). */
function tomlString(raw: string): string {
  const multi = raw.startsWith('"""') || raw.startsWith("'''");
  const body = multi ? raw.slice(3, -3).replace(/^\r?\n/, "") : raw.slice(1, -1);
  if (raw.startsWith("'")) return body;
  return body.replace(TOML_ESCAPE, (all: string, c: string | undefined, x?: string, u?: string, U?: string) => {
    if (c) return TOML_ESCAPES[c];
    const code = x ?? u ?? U;
    if (code === undefined) return "";
    const point = parseInt(code, 16);
    return point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff) ? all : String.fromCodePoint(point);
  });
}

/** The commands netlify.toml sets (`command = "…"` in [build], [context.production] and every other table: each one
 * is a command Netlify may run), as TOML reads them: basic, literal and multi-line strings. The key may be dotted
 * (`build.command = "…"`, `context.production.command`, quoted parts too) or sit in an inline table
 * (`build = { command = "…" }`): TOML reads each the same as `command` in its table. */
export function netlifyCommands(text: string | null): string[] {
  if (text === null) return [];
  const out: string[] = [];
  const re = /(?:^|[{,])[ \t]*(?:(?:[A-Za-z0-9_-]+|"[^"\r\n]*"|'[^'\r\n]*')[ \t]*\.[ \t]*)*(?:command|"command"|'command')[ \t]*=[ \t]*("""[\s\S]*?"""|'''[\s\S]*?'''|"(?:[^"\\\r\n]|\\.)*"|'[^'\r\n]*')/gm;
  for (const m of text.matchAll(re)) out.push(tomlString(m[1]));
  return out;
}

// The scripts a host's build runs by name (Vercel: vercel-build, now-build, then build); with none of them and no
// buildCommand, a host's Vite preset runs `vite build` itself. Heroku runs heroku-postbuild; npm runs the pre and post
// scripts of each.
const NAMED_BUILDS = ["vercel-build", "now-build", "build"];
const BUILD_SCRIPTS = [...NAMED_BUILDS, "heroku-postbuild"].flatMap((b) => [`pre${b}`, b, `post${b}`]);

/** The commands a host may run for this folder. `build`: vercel.json's buildCommand, netlify.toml's commands and the
 * build scripts; `install`: vercel.json's installCommand and the scripts npm, pnpm, yarn and bun run when they install
 * (INSTALL_SCRIPTS); `named`: whether a build command is set at all (else a host's Vite preset may build). */
interface HostCommands { build: string[]; install: string[]; named: boolean }
function hostCommands(pkg: Record<string, any>, read: (rel: string) => string | null): HostCommands {
  let vercel: Record<string, any> | null = null;
  try { vercel = JSON.parse(read("vercel.json") ?? "null"); } catch { /* unreadable: its commands are not known */ }
  const script = (name: string): unknown => (pkg.scripts && typeof pkg.scripts === "object" ? pkg.scripts[name] : undefined);
  const strings = (all: unknown[]) => all.filter((c): c is string => typeof c === "string");
  return {
    build: strings([vercel?.buildCommand, ...netlifyCommands(read("netlify.toml")), ...BUILD_SCRIPTS.map(script)]),
    install: strings([vercel?.installCommand, ...INSTALL_SCRIPTS.map(script)]),
    named: typeof vercel?.buildCommand === "string" || NAMED_BUILDS.some((n) => typeof script(n) === "string"),
  };
}

// Build tools that do not run Vite: a build made only of these, and of the package's own scripts made only of
// them, never builds a Vite config beside it. rollup only with its own config (-c).
const NOT_VITE_TOOLS = new Set(["tsc", "esbuild", "tsup", "swc", "webpack", "babel"]);
const RUNS_OWN_SCRIPT = /^(?:npm run(?:-script)?|pnpm(?: run)?|yarn(?: run)?|bun run) ([\w:.-]+)$/;

/** Whether a command line is shown not to run Vite: each of its commands, and of the scripts it runs (commandLines),
 * is one of NOT_VITE_TOOLS (after env settings, and npx, bunx, pnpm exec or yarn exec), or runs a script of the package
 * by its name alone. Anything else (nx, turbo, make, sh, a command substitution) is not shown. */
function shownNotVite(pkg: Record<string, any>, line: string): boolean {
  const scripts: Record<string, unknown> = pkg.scripts && typeof pkg.scripts === "object" ? pkg.scripts : {};
  return commandLines(pkg, line).every((l) => l.split(/&&|\|\||[;|&\n]/).map(withoutEnv).filter(Boolean).every((command) => {
    if (/`|\$\(/.test(command)) return false;
    const run = RUNS_OWN_SCRIPT.exec(command);
    if (run) return typeof scripts[run[1]] === "string";
    const words = command.split(" ");
    const at = words[0] === "npx" || words[0] === "bunx" ? 1 : (words[0] === "pnpm" || words[0] === "yarn") && words[1] === "exec" ? 2 : 0;
    return NOT_VITE_TOOLS.has(words[at]) || (words[at] === "rollup" && words.slice(at + 1).some((w) => /^(?:-c|--config)(?:=|$)/.test(w)));
  }));
}

/** Whether a package.json declares Vite: vite, or a framework built on it, as a dependency, or a script that runs Vite
 * (`npx vite build` with vite installed nowhere in the package). */
const declaresVite = (pkg: Record<string, any> | null): boolean => !!pkg && (hasDep(pkg, "vite") || VITE_FRAMEWORKS.some((name) => hasDep(pkg, name))
  || Object.values(pkg.scripts && typeof pkg.scripts === "object" ? pkg.scripts : {}).some(runsVite));

/** Whether this folder runs a Vite build, whatever the framework, and whether or not it declares vite itself (in a
 * workspace it is often only at the root):
 * - a script, or a command the host runs (vercel.json's buildCommand and installCommand, netlify.toml's commands), runs
 *   Vite or a framework CLI built on it;
 * - a framework built on Vite is a dependency;
 * - there is a Vite config, Vite is declared here or at the workspace root (`rootPkg`), and the build is not shown to
 *   leave Vite out: no build command is set (a host's Vite preset then runs `vite build`), or one of the build or
 *   install commands is not made only of known non-Vite tools (shownNotVite; `nx build`, `turbo run build`, `make` may
 *   run Vite, and Vercel runs the install with the project's variables too); husky's `prepare` is allowed. */
export function runsViteBuild(pkg: Record<string, any>, exists: (rel: string) => boolean, read: (rel: string) => string | null, rootPkg: Record<string, any> | null = null): boolean {
  const host = hostCommands(pkg, read);
  const scripts: unknown[] = pkg.scripts && typeof pkg.scripts === "object" ? Object.values(pkg.scripts) : [];
  if ([...scripts, ...host.build, ...host.install].some(runsVite)) return true;
  if (VITE_FRAMEWORKS.some((name) => hasDep(pkg, name))) return true;
  const shown = host.named && host.build.every((c) => shownNotVite(pkg, c)) && host.install.every((c) => HUSKY.test(c.trim()) || harmlessInstall(c) || shownNotVite(pkg, c));
  return (declaresVite(pkg) || declaresVite(rootPkg)) && VITE_CONFIGS.some(exists) && !shown;
}

/** The file a host's build or install command runs that loads Vite's JavaScript API (`import { build } from "vite"`),
 * or null: such a build's settings are in code the wizard does not read. Every word of the command, and of the scripts
 * it runs, that names a file of the app is read, whatever runs it (node, npx tsx, pnpm exec tsx, vite-node, esno…). */
function viteApiBuild(pkg: Record<string, any>, read: (rel: string) => string | null, host: HostCommands): { file: string; when: "build" | "install" } | null {
  const checked = new Set<string>();
  for (const when of ["build", "install"] as const) {
    for (const command of host[when]) for (const line of commandLines(pkg, command)) for (const word of commandWords(line)) {
      const file = resolveLocal(read, "", word);
      if (!file || checked.has(file)) continue;
      checked.add(file);
      const code = read(file);
      if (code !== null && importsModule(code, file, ["vite"])) return { file, when };
    }
  }
  return null;
}

// Script runners that run other scripts of the package by name or by pattern, which the wizard does not follow: run-s,
// run-p and npm-run-all (`run-s build:*`), and the npm:, pnpm:, yarn: and bun: shorthands of concurrently.
const UNFOLLOWED_RUNNER = /(?:^|[\s;&|("'`/])(?:run-s|run-p|npm-run-all)(?=$|[\s;&|)"'`])|(?:^|[\s"'])(?:npm|pnpm|yarn|bun):[^\s"']/;

/** Whether a host's build or install command, or a script it runs, runs scripts through a runner the wizard does not
 * follow: what it runs is unknown. */
const runsUnfollowed = (pkg: Record<string, any>, host: HostCommands): boolean =>
  [...host.build, ...host.install].some((c) => commandLines(pkg, c).some((line) => UNFOLLOWED_RUNNER.test(line)));

// Folders below the app that are walked for Vite apps of their own (client/ built with `npm run build --prefix
// client`), at most this many when the app is not in a git repository.
const MAX_VITE_FOLDERS = 1000;
// Folders never walked: dependencies and dot-folders (.git, .cache, .vercel…).
const skipped = (name: string) => name === "node_modules" || name.startsWith(".");
export type ViteFolder = { rel: string; declares: boolean; config: boolean };
/** The Vite folders found below the app, and why the wizard could not look everywhere (null: it did). */
export type Below = { folders: ViteFolder[]; notChecked: string | null };

const NOT_PROVEN = "so it cannot prove that no Vite build there reads PARLOX_SECRET_KEY.";
const linkedNote = (rel: string) => `The wizard did not look inside ${rel}/, a link to another folder, ${NOT_PROVEN}`;
const closedNote = (rel: string) => `The wizard could not open ${rel || "."}/, ${NOT_PROVEN}`;
const isFolder = (p: string) => { try { return statSync(p).isDirectory(); } catch { return false; } };

/** A folder below the app as a Vite folder (a package.json that declares Vite, or a Vite config), null when it is
 * neither, or why it is not checked (a package.json there that cannot be read; one that is not JSON declares nothing,
 * since no package manager can run it). */
function viteFolder(dir: string, rel: string, names: Set<string>): ViteFolder | string | null {
  let pkg: Record<string, any> | null = null;
  if (names.has("package.json")) {
    try { const v = JSON.parse(readFileSync(join(dir, rel, "package.json"), "utf8")); pkg = v && typeof v === "object" ? v : null; }
    catch (err) { if (!(err instanceof SyntaxError)) return `The wizard could not read ${rel}/package.json, ${NOT_PROVEN}`; }
  }
  const declares = declaresVite(pkg);
  const config = VITE_CONFIGS.some((c) => names.has(c));
  return declares || config ? { rel, declares, config } : null;
}

/** The folder walk outside git: breadth first, by name, at most MAX_VITE_FOLDERS folders. A link to a folder, or a
 * folder that cannot be opened, ends it as not checked. */
function walkDisk(dir: string): Below {
  const folders: ViteFolder[] = [];
  const queue = [""];
  let opened = 0;
  while (queue.length) {
    if (opened >= MAX_VITE_FOLDERS) return { folders, notChecked: `The wizard did not look for a Vite build past the first ${MAX_VITE_FOLDERS} folders of this app, so it cannot prove that no build there reads PARLOX_SECRET_KEY.` };
    const folder = queue.shift()!;
    opened++;
    let entries;
    try { entries = readdirSync(join(dir, folder), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)); }
    catch { return { folders, notChecked: closedNote(folder) }; }
    const names = new Set<string>();
    for (const e of entries) {
      const rel = folder ? `${folder}/${e.name}` : e.name;
      if (e.isDirectory()) { if (!skipped(e.name)) queue.push(rel); }
      else if (e.isSymbolicLink() && !skipped(e.name) && isFolder(join(dir, rel))) return { folders, notChecked: linkedNote(rel) };
      else names.add(e.name);
    }
    if (!folder) continue;
    const found = viteFolder(dir, folder, names);
    if (typeof found === "string") return { folders, notChecked: found };
    if (found) folders.push(found);
  }
  return { folders, notChecked: null };
}

/** Breadth-first order: shallower first, then by name, folder by folder. */
const walkOrder = (a: string, b: string): number => {
  const x = a.split("/"), y = b.split("/");
  if (x.length !== y.length) return x.length - y.length;
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
};

/** The walk in a git repository: the files git lists (tracked, or untracked and not ignored), with no cap. A link to a
 * folder, a submodule that is not checked out, a git repository of its own inside this one, or a folder with a
 * package.json or a Vite config that cannot be opened, is not checked. */
function walkGit(dir: string, listed: GitEntry[]): Below {
  const byFolder = new Map<string, Set<string>>();
  let notChecked: string | null = null;
  for (const { path, kind } of listed) {
    const parts = path.split("/");
    if (parts.some(skipped)) continue;
    if (kind === "submodule") { notChecked ??= `The wizard did not look inside ${path}/, a git submodule that is not checked out, ${NOT_PROVEN}`; continue; }
    if (kind === "repository") { notChecked ??= `The wizard did not look inside ${path}/, a git repository of its own that this one does not list, ${NOT_PROVEN}`; continue; }
    if (kind === "link" && isFolder(join(dir, path))) { notChecked ??= linkedNote(path); continue; }
    const folder = parts.slice(0, -1).join("/");
    if (!byFolder.has(folder)) byFolder.set(folder, new Set());
    byFolder.get(folder)!.add(parts[parts.length - 1]);
  }
  const folders: ViteFolder[] = [];
  for (const rel of [...byFolder.keys()].filter(Boolean).sort(walkOrder)) {
    const names = byFolder.get(rel)!;
    if (!names.has("package.json") && !VITE_CONFIGS.some((c) => names.has(c))) continue;
    try { readdirSync(join(dir, rel)); } catch { notChecked ??= closedNote(rel); continue; }
    const found = viteFolder(dir, rel, names);
    if (typeof found === "string") notChecked ??= found;
    else if (found) folders.push(found);
  }
  return { folders, notChecked };
}

/** The folders below `dir` (not node_modules, not dot-folders) with a package.json that declares Vite or with a Vite
 * config. In a git repository, from the files git lists: a host builds from the repository, and a tree git ignores
 * (uploads/) is never in it, so it costs nothing however large. Elsewhere, or when the app itself is not in the
 * repository yet (its package.json not listed), the folders on disk, at most MAX_VITE_FOLDERS. */
export function viteFoldersBelow(dir: string): Below {
  const listed = gitFiles(dir);
  return listed?.some((e) => e.path === "package.json") ? walkGit(dir, listed) : walkDisk(dir);
}

/** The exposure with `prefix` before its reason, in both of its wordings (SecretExposure.offVercel). */
const within = (prefix: string, e: SecretExposure): SecretExposure => ({ ...e, why: `${prefix}${e.why}`, ...(e.offVercel ? { offVercel: `${prefix}${e.offVercel}` } : {}) });

/** What the server part of an app in `dir` needs to know about Vite builds that could see its key. */
export interface FolderVite {
  /** Why a Vite build here could bundle PARLOX_SECRET_KEY (or cannot be proven not to), or null. */
  exposure: SecretExposure | null;
  /** Whether Vite is part of this app at all (declared here, at the workspace root or below, or run by a build). */
  seen: boolean;
  /** The Yarn release files the guarded builds' installs run, allowed by their standard location (vite-install.ts),
   * from this folder: for the report. */
  yarnReleases?: string[];
}

/** The Vite builds a server's key could reach, whatever their framework (Vue, Svelte, React Router…):
 * - a build or install command that drives Vite's JavaScript API (its settings are in code: unknown);
 * - this folder's own Vite build, when it runs one (runsViteBuild), or when a build or install command runs scripts
 *   through a runner the wizard does not follow (run-s, npm-run-all, concurrently npm:…) and Vite is declared
 *   anywhere, through the Vite config guard (readViteSettings);
 * - when this folder runs Vite, or any package.json here, at the workspace root or below declares it (a dependency, or
 *   a script that runs it), every Vite app found below this folder (a client/ built with `npm run build --prefix
 *   client`, a client/ with only a Vite config), each through the same guard.
 * Settings the wizard fails to read are not proven safe, and nor is a folder it could not look into: a link to another
 * folder, one it cannot open, or the walk's cap outside git (a key is never set where the
 * answer is "not checked"). */
export function folderViteCheck(dir: string, root: string): FolderVite {
  const existsIn = (base: string) => (rel: string) => { try { lstatSync(join(base, rel)); return true; } catch { return false; } };
  const unknown = (what: string): SecretExposure => ({ why: `The wizard could not read ${what}, so it cannot prove that this folder's Vite build keeps the secret key out of the browser code.`, fix: BY_HAND, byHand: true });
  const yarnReleases: string[] = [];
  const guard = (base: string): SecretExposure | null => {
    try {
      const s = readViteSettings(readText(base), existsIn(base), appFolders(base, root));
      const from = relative(dir, base).split(sep).join("/");
      for (const r of s.yarnReleases ?? []) { const p = posix.normalize(posix.join(from || ".", r)); if (!yarnReleases.includes(p)) yarnReleases.push(p); }
      return s.exposure;
    } catch (err) { return unknown(`the Vite settings (${err instanceof Error ? err.message : String(err)})`); }
  };
  const read = readText(dir);
  let pkg: Record<string, any>;
  try { pkg = readJson(join(dir, "package.json")); } catch { return { exposure: unknown("package.json"), seen: true }; }
  let rootPkg: Record<string, any> | null = null;
  if (root !== dir) { try { rootPkg = readJson(join(root, "package.json")); } catch { rootPkg = null; } }

  const host = hostCommands(pkg, read);
  const api = viteApiBuild(pkg, read, host);
  if (api) return { exposure: { why: `The ${api.when} runs ${api.file}, which uses Vite's JavaScript API, so the wizard cannot read the settings it builds with.`, fix: BY_HAND, byHand: true }, seen: true };
  const below = viteFoldersBelow(dir);
  const declared = declaresVite(pkg) || declaresVite(rootPkg) || below.folders.some((f) => f.declares);
  // A command run through a script runner the wizard does not follow is unknown: with Vite declared anywhere, it may
  // build with Vite here, so this folder's build goes through the guard.
  const own = runsViteBuild(pkg, existsIn(dir), read, rootPkg) || (declared && runsUnfollowed(pkg, host));
  if (own) { const e = guard(dir); if (e) return { exposure: e, seen: true }; }
  if (own || declared) {
    for (const f of below.folders) {
      const e = guard(join(dir, f.rel));
      if (e) return { exposure: within(`In ${f.rel}/: `, e), seen: true };
    }
  }
  if (below.notChecked) return { exposure: { why: below.notChecked, fix: BY_HAND, byHand: true }, seen: true };
  return { exposure: null, seen: own || declared || below.folders.length > 0, ...(yarnReleases.length ? { yarnReleases } : {}) };
}

/** Whether a Vite config in or below the folder, or one a command gives Vite with --config, names PARLOX_SECRET_KEY
 * (secretKeyNamed): for every server part beside Vite, such a config withholds the key whether or not Vite is declared
 * or run, beside folderViteCheck, which checks the builds that run. */
export function folderViteNamesSecretKey(dir: string): SecretExposure | null {
  const existsIn = (base: string) => (rel: string) => { try { lstatSync(join(base, rel)); return true; } catch { return false; } };
  const read = readText(dir);
  const own = viteConfigNamesSecretKey(read, existsIn(dir));
  if (own) return own;
  // A config the package's scripts, vercel.json's buildCommand or wrangler's [build] command give Vite with --config.
  let pkg: Record<string, any> = {};
  try { pkg = readJson(join(dir, "package.json")); } catch { /* none: no scripts */ }
  let vercel: Record<string, any> | null = null;
  try { vercel = JSON.parse(read("vercel.json") ?? "null"); } catch { vercel = null; }
  const commands: Array<[string, unknown]> = [
    ...Object.entries((pkg.scripts ?? {}) as Record<string, unknown>).map(([name, c]): [string, unknown] => [`the script "${name}"`, c]),
    ["vercel.json's buildCommand", vercel?.buildCommand],
    ["wrangler's [build] command", wranglerOf(read)?.build],
  ];
  for (const [who, command] of commands) {
    for (const config of typeof command === "string" ? viteConfigArgs(command) : []) {
      const e = viteConfigNamesSecretKey(read, existsIn(dir), config);
      if (e) return within(`${config} (${who} gives it to Vite with --config): `, e);
    }
  }
  for (const f of viteFoldersBelow(dir).folders) {
    if (!f.config) continue;
    const base = join(dir, f.rel);
    const e = viteConfigNamesSecretKey(readText(base), existsIn(base));
    if (e) return within(`In ${f.rel}/: `, e);
  }
  return null;
}

/** Whether a JSON file has `field` (false when it is missing or not JSON). */
const jsonHas = (file: string, field: string): boolean => { try { const v = JSON.parse(readFileSync(file, "utf8")); return Boolean(v && v[field]); } catch { return false; } };
/** Where Vite stops looking up for a PostCSS config (vitejs/vite packages/vite/src/node/server/searchRoot.ts,
 * searchForWorkspaceRoot, opened at 8.3.1): the nearest folder with pnpm-workspace.yaml or lerna.json, a package.json
 * with workspaces, or a deno.json with workspace; else the app's own folder. */
function viteWorkspaceRoot(dir: string): string {
  for (let d = dir; ; d = dirname(d)) {
    if (["pnpm-workspace.yaml", "lerna.json"].some((f) => existsSync(join(d, f))) || jsonHas(join(d, "package.json"), "workspaces") || ["deno.json", "deno.jsonc"].some((f) => jsonHas(join(d, f), "workspace"))) return d;
    if (dirname(d) === d) return dir;
  }
}
// At most this many folders are opened to expand the workspace's package list.
const MAX_WORKSPACE_FOLDERS = 5000;
/** Every package of the workspace at `root` (folders relative to `dir`, the app's), from its package list (package.json's
 * workspaces, pnpm-workspace.yaml's packages): a name, `*`, `**` (any depth) and names with `*` in them. A pattern the
 * wizard does not expand, a folder it cannot open, or more folders than it opens, is said. Negated patterns are left
 * out, so the list holds every package and perhaps more. */
function workspacePackages(dir: string, root: string): Packages {
  const list: WorkspacePackage[] = [];
  const seen = new Set<string>();
  const rel = (abs: string) => relative(dir, abs).split(sep).join("/") || ".";
  const cannot = (why: string): Packages => ({ list, notChecked: `${why}, and the install runs the scripts of every package of a workspace` });
  let globs: string[];
  try { globs = workspaceGlobs(root); } catch (err) { return cannot(`The wizard could not read the workspace's package list (${err instanceof Error ? err.message : String(err)})`); }
  let opened = 0;
  const add = (abs: string) => {
    const r = rel(abs);
    if (seen.has(r) || !existsSync(join(abs, "package.json"))) return;
    seen.add(r);
    let name: string | null = null;
    try { const v = readJson(join(abs, "package.json")); name = typeof v.name === "string" ? v.name : null; } catch { /* its scripts are read later, and an unreadable package.json is said there */ }
    list.push({ dir: r, name });
  };
  const children = (abs: string): string[] | string => {
    if (++opened > MAX_WORKSPACE_FOLDERS) return `The workspace's package list reaches more than ${MAX_WORKSPACE_FOLDERS} folders, more than the wizard opens`;
    try { return readdirSync(abs, { withFileTypes: true }).filter((e) => (e.isDirectory() || (e.isSymbolicLink() && isFolder(join(abs, e.name)))) && e.name !== "node_modules" && !e.name.startsWith(".")).map((e) => e.name).sort(); }
    catch (err) { return (err as NodeJS.ErrnoException).code === "ENOENT" ? [] : `The wizard could not open ${rel(abs)}/, a folder of the workspace's package list`; }
  };
  for (const glob of globs) {
    const segs = globSegments(glob);
    if (!segs) return cannot(`The workspace lists packages with a pattern the wizard does not expand (${glob})`);
    const stack: Array<[string, number]> = [[root, 0]];
    while (stack.length) {
      const [abs, i] = stack.pop()!;
      if (i === segs.length) { add(abs); continue; }
      const seg = segs[i];
      if ("name" in seg) { stack.push([join(abs, seg.name), i + 1]); continue; }
      const names = children(abs);
      if (typeof names === "string") return cannot(names);
      if ("deep" in seg) { stack.push([abs, i + 1]); for (const n of names) stack.push([join(abs, n), i]); }
      else for (const n of names) if ("any" in seg || ("re" in seg && seg.re.test(n))) stack.push([join(abs, n), i + 1]);
    }
  }
  return { list, notChecked: null };
}


/** What the Vite checks need of the app's folders besides reading files (AppFolders in vite-config.ts). */
export function appFolders(dir: string, root: string): AppFolders {
  const rel = (to: string) => relative(dir, to).split(sep).join("/") || ".";
  const list = (folder: string): string[] | null => {
    try {
      return readdirSync(join(dir, folder), { withFileTypes: true }).map((e) => {
        let isDir = e.isDirectory();
        if (e.isSymbolicLink()) { try { isDir = statSync(join(dir, folder, e.name)).isDirectory(); } catch { isDir = false; } }
        return isDir ? `${e.name}/` : e.name;
      });
    } catch { return null; }
  };
  const linked = (d: string) => existsSync(join(d, ".vercel", "project.json"));
  const vercelAtRoot = !linked(dir) && (linked(root) || ["vercel.json", ...VERCEL_CONFIGS].some((f) => existsSync(join(root, f))));
  const kind = (path: string): PathKind | null => {
    try {
      const st = lstatSync(join(dir, path));
      return st.isSymbolicLink() ? "link" : st.isFile() ? "file" : st.isDirectory() ? "dir" : "other";
    } catch { return null; }
  };
  return {
    list, kind, postcssTop: rel(viteWorkspaceRoot(dir)), workspace: root === dir ? null : { root: rel(root), vercel: vercelAtRoot, app: relative(root, dir).split(sep).join("/") },
    packages: root === dir ? { list: [], notChecked: null } : workspacePackages(dir, root), repoTop: rel(repoTopOf(dir, root)),
  };
}
