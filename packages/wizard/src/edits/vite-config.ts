import { posix } from "node:path";
import * as babel from "@babel/parser";
import { buildFilesExposure, trustedStylePackage } from "./vite-build-files.js";
import { BY_HAND, configExposure, isModuleExports, keyName, lineOf, literalString, notChecked, scriptElsewhere, secretKeyNamed, TRUSTED_PACKAGES, unwrapTs, valueOf, type SecretExposure } from "./vite-exposure.js";
import { vercelBuild } from "./vite-vercel.js";
import type { Packages, PathKind } from "./vite-install.js";
import { cssImports, type AliasTarget, type SourceContext } from "./vite-sources.js";
import { tsconfigChain } from "./tsconfig-chain.js";
import { parseCode, walk, type Ast, type Node } from "./splice.js";
import { fileRelative } from "./views.js";

export { exposesSecret, type SecretExposure } from "./vite-exposure.js";

// What the wizard must know about a Vite app's config, read from its literals (vitejs/vite
// packages/vite/src/node/config.ts and env.ts):
// - envPrefix: Vite exposes the variables whose names start with it to the browser build ("VITE_* variables should not
//   contain sensitive information"), those of the .env files and of process.env alike; default "VITE_".
// - root: where index.html is, and what publicDir is relative to; default the folder Vite runs in.
// - publicDir: copied into the build as is; default "public"; false or "" turns it off.
// Whether PARLOX_SECRET_KEY could reach the browser build (exposure) is vite-exposure.ts's (the config and Vercel's
// build) and vite-build-files.ts's (the other files the build reads); this file reads the settings and hands them the
// config it parsed.
// Only the config object itself counts (the default export, through defineConfig, a const, a function that returns
// it, or module.exports), never a plugin's options that happen to use the same names. A value computed in code, a
// spread (it may set any key), a config object changed or used besides being exported, or a config the wizard cannot
// follow (mergeConfig, an async function) cannot be known without running the config: it is null. A config that exists
// but cannot be read is unknown, not absent.

/** Vite's own order (packages/vite/src/node/constants.ts, DEFAULT_CONFIG_FILES): the first that exists is used. */
export const VITE_CONFIGS = ["vite.config.js", "vite.config.mjs", "vite.config.ts", "vite.config.cjs", "vite.config.mts", "vite.config.cts"];

/** `root` and `publicDir` are relative to the app folder, "/"-separated ("." is the folder itself). null: the wizard
 * cannot tell (computed in code, or a config it cannot follow). */
export interface ViteSettings {
  file: string | null;
  root: string | null;
  envPrefix: string[] | null;
  publicDir: string | false | null;
  /** null only when the config and the scripts show that Vite keeps PARLOX_SECRET_KEY out of the browser build. */
  exposure: SecretExposure | null;
  /** The Yarn release files the install runs, allowed by their standard location (vite-install.ts): for the report. */
  yarnReleases?: string[];
}

/** What the wizard knows about the app's folders besides its files: how to list one, where PostCSS stops looking up
 * for its config, and the workspace the app is in. */
export interface AppFolders {
  /** The names in a folder of the app ("." is the app folder), a folder's with "/" after it; null when it cannot be
   * listed. */
  list: (rel: string) => string[] | null;
  /** Where PostCSS stops looking up for its config (Vite's searchForWorkspaceRoot), relative to the app folder: "." or
   * "../..". */
  postcssTop: string;
  /** The workspace root relative to the app folder ("../.."), whether Vercel is set up there rather than in the app
   * folder (a link or a Vercel config file at the root, no link in the app), and the app folder relative to the root
   * ("apps/web", which the project's Root Directory may name); null outside a workspace. */
  workspace: { root: string; vercel: boolean; app?: string } | null;
  /** Every package of the workspace, with its folder relative to the app folder (none outside a workspace). */
  packages?: Packages;
  /** The top of the app's repository relative to the app folder ("../.."): the package managers' own files are read
   * from the app folder up to there. The workspace root (or the app folder) when not given. */
  repoTop?: string;
  /** What is at a path, a link never followed (lstat); without it, nothing is known of a path but whether it exists. */
  kind?: (rel: string) => PathKind | null;
}

/** Whether the guard trusts a package by name (vite-exposure.ts's and vite-build-files.ts's lists). */
const trustedName = (name: string): boolean => TRUSTED_PACKAGES.includes(name) || trustedStylePackage(name);

const DEFAULTS = { root: ".", envPrefix: ["VITE_"], publicDir: "public" as string | false };
const FUNCTIONS = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression", "ObjectMethod", "ClassMethod", "ClassPrivateMethod"]);

/** A relative folder inside the app, normalized ("./static/" is "static"), or null for an absolute path or one that
 * leaves the app. */
function inside(value: string): string | null {
  const p = posix.normalize(value.replace(/\\/g, "/"));
  if (posix.isAbsolute(p) || /^[A-Za-z]:/.test(p) || p === ".." || p.startsWith("../")) return null;
  return p.replace(/\/+$/, "") || ".";
}

const isDefineConfig = (c: Node): boolean => (c.type === "Identifier" && c.name === "defineConfig") || (c.type === "MemberExpression" && !c.computed && c.property?.name === "defineConfig");

/** Every place the file refers to `name` as a value: not a property name, an object key or the declaration itself. */
function references(ast: Ast, name: string): Node[] {
  const out: Node[] = [];
  walk(ast.program, (n, ancestors) => {
    if (n.type !== "Identifier" || n.name !== name) return;
    const parent = ancestors[ancestors.length - 1];
    if (parent?.type === "VariableDeclarator" && parent.id === n) return;
    if ((parent?.type === "MemberExpression" || parent?.type === "OptionalMemberExpression") && parent.property === n && !parent.computed) return;
    if ((parent?.type === "ObjectProperty" || parent?.type === "ObjectMethod") && parent.key === n && !parent.computed) return;
    out.push(n);
  });
  return out;
}

type Config = { objects: Node[]; follow: (id: Node) => Node | null } | { objects: null; why: string };

/** The object literals the config file gives Vite (several when a condition picks one), or why the wizard cannot
 * follow it to them. A top-level const is followed only when the one use is the one being followed: a config object
 * changed later (cfg.envPrefix = …, Object.assign(cfg, …)) or handed to other code could hold anything. */
function readConfig(ast: Ast): Config {
  const body = ast.program.body;
  const consts = new Map<string, Node>();
  for (const raw of body) {
    const s = raw.type === "ExportNamedDeclaration" && raw.declaration ? raw.declaration : raw;
    if (s.type === "VariableDeclaration" && s.kind === "const") for (const d of s.declarations) if (d.id.type === "Identifier" && d.init) consts.set(d.id.name, d.init);
  }
  let why: string | null = null;
  const follow = (id: Node): Node | null => {
    const init = consts.get(id.name);
    if (!init) return null;
    const other = references(ast, id.name).find((r) => r !== id);
    if (other) { why = `its config object ${id.name} is also changed or used on line ${lineOf(other)}`; return null; }
    return init;
  };
  const exported = body.flatMap((s) =>
    s.type === "ExportDefaultDeclaration" ? [s.declaration]
      : s.type === "ExpressionStatement" && s.expression.type === "AssignmentExpression" && isModuleExports(s.expression.left) ? [s.expression.right] : []);
  if (exported.length !== 1) return { objects: null, why: "it has no single default export the wizard can follow" };
  const out: Node[] = [];
  const followed = new Set<string>();
  const resolve = (e: Node | null | undefined): boolean => {
    if (!e) return false;
    switch (e.type) {
      case "ObjectExpression": out.push(e); return true;
      case "TSAsExpression": case "TSSatisfiesExpression": case "TSNonNullExpression": case "TSTypeAssertion": case "ParenthesizedExpression": return resolve(e.expression);
      case "ConditionalExpression": return resolve(e.consequent) && resolve(e.alternate);
      case "Identifier": {
        if (followed.has(e.name)) return false;
        followed.add(e.name);
        return resolve(follow(e));
      }
      case "CallExpression": return isDefineConfig(e.callee) && e.arguments.length === 1 && resolve(e.arguments[0]);
      case "ArrowFunctionExpression": case "FunctionExpression": case "FunctionDeclaration": {
        if (e.async || e.generator) return false;
        if (e.body.type !== "BlockStatement") return resolve(e.body);
        // The function's own return statements, not those of functions inside it.
        const returns: Node[] = [];
        walk(e.body, (n, ancestors) => { if (n.type === "ReturnStatement" && !ancestors.some((a) => FUNCTIONS.has(a.type))) returns.push(n); });
        return returns.length > 0 && returns.every((r) => resolve(r.argument));
      }
      default: return false;
    }
  };
  if (!resolve(exported[0])) return { objects: null, why: why ?? "it is built in code the wizard cannot follow, such as mergeConfig(…) or an async function" };
  const odd = out.flatMap((o) => o.properties).find((p: Node) => p.type === "SpreadElement" || p.computed);
  if (odd) return { objects: null, why: `${odd.type === "SpreadElement" ? "a spread" : "a computed key"} on line ${lineOf(odd)} may set any option` };
  return { objects: out, follow };
}

/** The config's syntax tree, also for a config that imports JSON with the older `assert { type: "json" }` syntax (Node
 * 20 and 22 still take it), which the edits' parser does not read. */
function parseConfig(text: string, file: string): Ast | null {
  const ast = parseCode(text, file);
  if (ast || !/\bassert\s*\{/.test(text)) return ast;
  try {
    const plugins = [...(/\.[mc]?ts$/.test(file) ? ["typescript"] : []), "deprecatedImportAssert"] as babel.ParserPlugin[];
    return babel.parse(text, { sourceType: "unambiguous", plugins }) as unknown as Ast;
  } catch { return null; }
}

/** Where one alias leads (AliasTarget in vite-sources.ts): a literal path or a path helper, a package name, or null. */
function aliasTarget(v: Node | null | undefined): AliasTarget {
  if (!v) return null;
  if (v.type === "StringLiteral") {
    const value = (v.value as string).replace(/\\/g, "/");
    if (/^[A-Za-z]:/.test(value)) return null;
    // A replacement from / is resolved against Vite's root, inside the app; ./ and ../ from the app folder.
    if (value.startsWith("/")) return { path: posix.normalize(value.slice(1)) || "." };
    if (value === "." || value === ".." || value.startsWith("./") || value.startsWith("../")) return { path: posix.normalize(value) };
    return { bare: value };
  }
  const rel = fileRelative(v, "", true);
  return rel === null || rel === "unknown" ? null : { path: rel };
}

/** resolve.alias in the config objects, by key with where each leads, or "any" when an alias may match any name (a
 * RegExp `find`, or aliases written in code). */
function aliasesOf(objects: Node[]): Map<string, AliasTarget> | "any" {
  const out = new Map<string, AliasTarget>();
  for (const o of objects) {
    const resolve = valueOf(o, "resolve");
    if (resolve === undefined) continue;
    const alias = resolve?.type === "ObjectExpression" ? valueOf(resolve, "alias") : null;
    if (alias === undefined) continue;
    if (alias?.type === "ObjectExpression") {
      for (const p of alias.properties) { const key = keyName(p); if (key === null) return "any"; out.set(key, aliasTarget(p.type === "ObjectProperty" ? unwrapTs(p.value) : null)); }
    } else if (alias?.type === "ArrayExpression") {
      for (const e of alias.elements) { const find = e?.type === "ObjectExpression" ? valueOf(e, "find") : null; if (find?.type !== "StringLiteral") return "any"; out.set(find.value, aliasTarget(valueOf(e, "replacement"))); }
    } else return "any";
  }
  return out;
}

/** A path a config setting gives (a literal or a path helper), relative to the app folder, or "unknown". */
function pathOfSetting(v: Node | null | undefined): string | "unknown" {
  if (v?.type === "StringLiteral") return /^(?:[A-Za-z]:)?[\\/]/.test(v.value) ? "unknown" : posix.normalize(v.value.replace(/\\/g, "/"));
  const rel = v ? fileRelative(v, "", true) : null;
  return rel === null ? "unknown" : rel;
}
/** The files and folders the config gives the build besides what its sources import: build.rollupOptions.input (and
 * rolldownOptions), build.lib.entry, the stylesheet preprocessors' load paths (css.preprocessorOptions.*'s loadPaths,
 * includePaths and paths) and what their additionalData imports; "unknown" when one is written in code or absolute. */
function entriesOf(objects: Node[]): string[] | "unknown" {
  const out: string[] = [];
  const add = (v: Node | null | undefined): boolean => {
    const n = v ? unwrapTs(v) : v;
    if (n === undefined) return true;
    if (n?.type === "ArrayExpression") return n.elements.every((e: Node | null) => e !== null && add(e));
    if (n?.type === "ObjectExpression") return n.properties.every((p: Node) => p.type === "ObjectProperty" && add(p.value));
    const p = pathOfSetting(n);
    if (p === "unknown") return false;
    out.push(p);
    return true;
  };
  const obj = (o: Node | null | undefined, key: string): Node | null | undefined => (o?.type === "ObjectExpression" ? valueOf(o, key) : undefined);
  for (const o of objects) {
    const build = valueOf(o, "build");
    for (const bundler of ["rollupOptions", "rolldownOptions"]) if (!add(obj(obj(build, bundler), "input"))) return "unknown";
    if (!add(obj(obj(build, "lib"), "entry"))) return "unknown";
    const pre = obj(valueOf(o, "css"), "preprocessorOptions");
    if (pre?.type === "ObjectExpression") for (const lang of pre.properties) {
      if (lang.type !== "ObjectProperty") return "unknown";
      for (const key of ["loadPaths", "includePaths", "paths"]) if (!add(obj(unwrapTs(lang.value), key))) return "unknown";
      // What additionalData (a stylesheet put before every one) imports by a relative path, from the app folder.
      const data = obj(unwrapTs(lang.value), "additionalData");
      const text = data ? literalString(data) : null;
      for (const { spec } of text ? cssImports(text) : []) if (spec.startsWith("./") || spec.startsWith("../")) out.push(posix.normalize(spec));
    }
  }
  return out;
}

/** Where the build writes, relative to the app folder, when every object agrees (viteOutDir's reading), else null. */
function outDirOf(objects: Node[]): string | null {
  const out = outDirFrom(objects);
  return out === "unknown" ? null : out;
}

/** Whether Vite resolves imports through tsconfig paths: the config imports vite-tsconfig-paths, or sets
 * resolve.tsconfigPaths (Vite's own option). */
function usesTsconfigPaths(ast: Ast, objects: Node[]): boolean {
  if (ast.program.body.some((s) => s.type === "ImportDeclaration" && s.importKind !== "type" && s.source.value === "vite-tsconfig-paths")) return true;
  return objects.some((o) => { const r = valueOf(o, "resolve"); const t = r?.type === "ObjectExpression" ? valueOf(r, "tsconfigPaths") : undefined; return t !== undefined && !(t?.type === "BooleanLiteral" && t.value === false); });
}

/** The tsconfig paths Vite would resolve through: tsconfig.json and the files it references and extends
 * (tsconfig-chain.ts), each pattern with its targets relative to the app folder, and a baseUrl as "*". "unknown" when
 * one cannot be read. */
function tsconfigPathsOf(read: (rel: string) => string | null, top: string): NonNullable<SourceContext["tsconfigPaths"]> {
  const chain = tsconfigChain(read, "tsconfig.json", top);
  if (!Array.isArray(chain)) return "unknown";
  const out: Array<{ pattern: string; targets: string[]; baseUrl?: boolean }> = [];
  for (const { rel, json } of chain) {
    const dir = posix.dirname(rel);
    const co = json.compilerOptions;
    const base = typeof co?.baseUrl === "string" ? posix.normalize(posix.join(dir, co.baseUrl)) : null;
    if (co?.paths && typeof co.paths === "object") {
      for (const [pattern, targets] of Object.entries(co.paths)) {
        if (!Array.isArray(targets) || !targets.every((t) => typeof t === "string")) return "unknown";
        out.push({ pattern, targets: (targets as string[]).map((t) => posix.normalize(posix.join(base ?? dir, t))) });
      }
    }
    if (base) out.push({ pattern: "*", targets: [`${base}/*`], baseUrl: true });
  }
  return out;
}

/** `read` gives a file's text (null when it is missing or cannot be read); `exists` whether the file is there at all
 * (lstat), so that a file that is there but cannot be read is unknown rather than absent; `app` the rest of what the
 * build may read (AppFolders). */
export function readViteSettings(read: (rel: string) => string | null, exists: (rel: string) => boolean, app: AppFolders): ViteSettings {
  // The config Vite loads is the first that exists; one that exists but cannot be read is unknown, never absent.
  const file = VITE_CONFIGS.find(exists) ?? null;
  // Vite run with another config or root: nothing read here is what Vite uses.
  const elsewhere = scriptElsewhere(read);
  if (elsewhere) return { file, root: null, envPrefix: null, publicDir: null, exposure: elsewhere };
  // What Vercel's build runs, then what it reads in Vite's root besides the config. A root the wizard cannot read
  // hides those files.
  const build = vercelBuild(read, exists, app, trustedName);
  const rootGuard = build.exposure ? null : workspaceRootBuild(read, exists, app, build.rootBuild ?? null);
  const repoTop = app.repoTop ?? app.workspace?.root ?? ".";
  type Sources = Omit<SourceContext, "root" | "packages" | "repoTop" | "pkgFolders">;
  const pkgFolders = [...new Set([".", app.workspace?.root ?? ".", repoTop])];
  const outside = (root: string | null, sources: Sources): SecretExposure | null => build.exposure ?? rootGuard
    ?? (root === null ? notChecked(`The wizard cannot read Vite's root from ${file} (it is computed in code, outside this folder, or not the same in every branch of the config), so it cannot check the files the build reads there`)
      : buildFilesExposure({ read, exists, list: app.list }, { root, postcssTop: app.postcssTop, modes: build.modes, bun: build.bun === true, packages: app.packages?.list ?? [], repoTop, pkgFolders, ...sources }));
  // Only when there is one: a release file trusted by its location.
  const yarnReleases = build.yarnReleases?.length ? { yarnReleases: build.yarnReleases } : {};
  if (!file) return { file, ...DEFAULTS, exposure: outside(".", { outDir: "dist", publicDir: DEFAULTS.publicDir, aliases: new Map(), tsconfigPaths: null, entries: [] }), ...yarnReleases };
  const text = read(file);
  if (text === null) return { file, root: null, envPrefix: null, publicDir: null, exposure: { why: `${file} exists, but the wizard cannot read it (a file it may open, of at most 1 MB), so it cannot prove that Vite keeps the secret key out of the browser code.`, fix: BY_HAND, byHand: true } };
  const ast = parseConfig(text, file);
  const config: Config = ast ? readConfig(ast) : { objects: null, why: "it does not parse" };
  if (!config.objects) {
    return { file, root: null, envPrefix: null, publicDir: null, exposure: build.exposure ?? rootGuard ?? { why: `The wizard cannot read ${file} to the end (${config.why}), so it cannot prove that Vite keeps the secret key out of the browser code.`, fix: BY_HAND, byHand: true } };
  }
  const { objects, follow } = config;
  // Every object the config may give must agree; otherwise the wizard cannot know which one Vite uses.
  const setting = <T,>(key: string, fallback: T, literal: (v: Node) => T | undefined): T | null => {
    const all = objects.map((o) => { const v = valueOf(o, key); return v === undefined ? fallback : v === null ? undefined : literal(v); });
    return all.every((x) => x !== undefined && JSON.stringify(x) === JSON.stringify(all[0])) ? (all[0] as T) : null;
  };
  const envPrefix = setting<string[]>("envPrefix", DEFAULTS.envPrefix, (v) =>
    v.type === "StringLiteral" ? [v.value as string]
      : v.type === "ArrayExpression" && v.elements.every((e: Node | null) => e?.type === "StringLiteral") ? v.elements.map((e: Node) => e.value as string) : undefined);
  const root = setting<string>("root", DEFAULTS.root, (v) => (v.type === "StringLiteral" ? inside(v.value) ?? undefined : undefined));
  // publicDir is relative to root: joined with it first, then checked to be inside the app.
  const raw = setting<string | false>("publicDir", DEFAULTS.publicDir, (v) =>
    (v.type === "BooleanLiteral" && v.value === false) || (v.type === "StringLiteral" && v.value === "") ? false
      : v.type === "StringLiteral" && !posix.isAbsolute(v.value.replace(/\\/g, "/")) && !/^[A-Za-z]:/.test(v.value) ? v.value : undefined);
  const publicDir = typeof raw !== "string" ? raw : root === null ? null : inside(posix.join(root, raw.replace(/\\/g, "/")));
  const sources: Sources = { outDir: outDirOf(objects), publicDir, aliases: aliasesOf(objects), tsconfigPaths: usesTsconfigPaths(ast!, objects) ? tsconfigPathsOf(read, repoTop) : null, entries: entriesOf(objects) };
  const exposure = configExposure(file, ast!, objects, follow, envPrefix, build.modes, outside(root, sources));
  return { file, root, envPrefix, publicDir, exposure, ...yarnReleases };
}

/** When Vercel builds the project at the workspace root, and that build is Vite's (a plain `vite build`, or no build
 * command with Vite at the root, which Vercel's Vite preset then builds), the root's Vite config and build files go
 * through the same guard as the app's: the key set on that project is in that build. */
function workspaceRootBuild(read: (rel: string) => string | null, exists: (rel: string) => boolean, app: AppFolders, rootBuild: "vite" | "preset" | "other" | null): SecretExposure | null {
  const ws = app.workspace;
  if (!ws || !rootBuild || rootBuild === "other") return null;
  const up = (rel: string) => posix.normalize(posix.join(ws.root, rel));
  const declaresVite = (): boolean => {
    try {
      const pkg = JSON.parse((read(up("package.json")) ?? "null").replace(/^\uFEFF/, ""));
      return Boolean(pkg?.dependencies?.vite || pkg?.devDependencies?.vite);
    } catch { return false; }
  };
  if (rootBuild === "preset" && !VITE_CONFIGS.some((c) => exists(up(c))) && !declaresVite()) return null;
  // The app's paths, from the root instead: the app folder itself is `ws.app` there.
  const BASE = `/${Array.from({ length: 64 }, (_, i) => `d${i}`).join("/")}`;
  const fromRoot = (rel: string) => (rel === "." && ws.app !== undefined ? ws.app : posix.relative(posix.join(BASE, ws.root), posix.join(BASE, rel)) || ".");
  const packages = { list: (app.packages?.list ?? []).map((p) => ({ dir: fromRoot(p.dir), name: p.name })), notChecked: null };
  const kind = app.kind;
  const e = readViteSettings((rel) => read(up(rel)), (rel) => exists(up(rel)), { list: (rel) => app.list(up(rel)), postcssTop: ".", workspace: null, packages, repoTop: fromRoot(app.repoTop ?? ws.root), ...(kind ? { kind: (rel: string) => kind(up(rel)) } : {}) }).exposure;
  if (!e) return null;
  const at = `In ${ws.root}/ (the workspace root, where Vercel builds): `;
  return { ...e, why: `${at}${e.why}`, ...(e.offVercel ? { offVercel: `${at}${e.offVercel}` } : {}) };
}

/** Whether the Vite config in a folder (or `given`, one a command names with --config) names PARLOX_SECRET_KEY in its
 * code (secretKeyNamed). A config that cannot be read is not shown not to; one that does not parse is judged by its
 * text. null: no config, or one that does not name the key. */
export function viteConfigNamesSecretKey(read: (rel: string) => string | null, exists: (rel: string) => boolean, given?: string): SecretExposure | null {
  // `given`: a config a command names with --config, instead of Vite's default one.
  const file = given ?? VITE_CONFIGS.find(exists) ?? null;
  if (!file) return null;
  const text = posix.isAbsolute(file.replace(/\\/g, "/")) || /^[A-Za-z]:/.test(file) ? null : read(file);
  if (text === null) return { why: `The wizard cannot read ${file} (it is missing, outside the app, larger than 1 MB, or not a file it may open), so it cannot tell whether the build reads Parlox's variables.`, fix: BY_HAND, byHand: true };
  const ast = parseConfig(text, file);
  if (ast) return secretKeyNamed(file, ast);
  const at = text.split(/\r\n|\n|\r/).findIndex((l) => l.includes("PARLOX_SECRET_KEY"));
  return at < 0 ? null : { why: `${file} does not parse, and line ${at + 1} names PARLOX_SECRET_KEY, so the wizard cannot tell whether the build reads Parlox's variables.`, fix: BY_HAND, byHand: true };
}

/** Where the Vite build configured in a folder writes, relative to that folder ("/"-separated, possibly outside it, as
 * a client's `build.outDir: '../public'`): Vite resolves `build.outDir` (default "dist") against `root`, so a literal
 * is taken under root, and a folder written from the config's own (path.resolve(__dirname, …),
 * fileURLToPath(new URL(…, import.meta.url))) as it is. "unknown" when the config exists but the wizard cannot read one
 * value that every branch agrees on (computed in code, absolute, a config it cannot follow); null when there is none. */
export function viteOutDir(read: (rel: string) => string | null, exists: (rel: string) => boolean): { file: string; outDir: string | "unknown" } | null {
  const file = VITE_CONFIGS.find(exists) ?? null;
  if (!file) return null;
  const text = read(file);
  const ast = text === null ? null : parseConfig(text, file);
  const config = ast ? readConfig(ast) : null;
  if (!config?.objects) return { file, outDir: "unknown" };
  return { file, outDir: outDirFrom(config.objects) };
}

/** Whether `vite build` copies the public folder into the build's output: build.copyPublicDir, true unless set to
 * false; null when the config cannot be read, or sets it in a way the wizard does not read. */
export function viteCopiesPublicDir(read: (rel: string) => string | null, exists: (rel: string) => boolean): boolean | null {
  const file = VITE_CONFIGS.find(exists) ?? null;
  if (!file) return true;
  const text = read(file);
  const ast = text === null ? null : parseConfig(text, file);
  const config = ast ? readConfig(ast) : null;
  if (!config?.objects) return null;
  const all = config.objects.map((o) => {
    const build = valueOf(o, "build");
    if (build === undefined) return true;
    if (build?.type !== "ObjectExpression") return null;
    const v = valueOf(build, "copyPublicDir");
    return v === undefined ? true : v?.type === "BooleanLiteral" ? (v.value as boolean) : null;
  });
  return all.every((x) => x === all[0]) ? all[0] : null;
}

/** Where the config objects' build writes (viteOutDir), or "unknown" when they do not agree or it is computed. */
function outDirFrom(objects: Node[]): string | "unknown" {
  // A folder setting: under `base` for a relative literal, from the config's folder for a file-relative form.
  const folder = (v: Node | null | undefined, fallback: string, base: string): string | "unknown" => {
    if (v === undefined) return posix.join(base, fallback);
    if (v?.type === "StringLiteral") return /^(?:[A-Za-z]:)?[\\/]/.test(v.value) ? "unknown" : posix.join(base, v.value.replace(/\\/g, "/"));
    return v ? fileRelative(v, "", true) ?? "unknown" : "unknown";
  };
  const outs = objects.map((o) => {
    const root = folder(valueOf(o, "root"), ".", ".");
    const build = valueOf(o, "build");
    if (root === "unknown" || (build !== undefined && build?.type !== "ObjectExpression")) return "unknown";
    const out = folder(build ? valueOf(build, "outDir") : undefined, "dist", root);
    return out === "unknown" ? out : posix.normalize(out).replace(/\/+$/, "");
  });
  return outs.every((x) => x === outs[0]) ? outs[0] : "unknown";
}
