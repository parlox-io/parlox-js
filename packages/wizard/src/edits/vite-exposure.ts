import { posix } from "node:path";
import { GUIDE } from "../workspace.js";
import { walk, type Ast, type Node } from "./splice.js";

// Whether PARLOX_SECRET_KEY could reach a Vite app's browser build (the "exposure"), from its config and from how it is
// built. Vite exposes the variables whose names start with envPrefix to the browser build, those of the .env files and
// of process.env alike (vitejs/vite packages/vite/src/node/env.ts), and on Vercel the project's variables are there
// during the build: an exposing config would bundle the key.
// Safe is proven, never assumed: a config is safe only when everything in it is on the allowlist below (unchecked():
// the imports, the plugins and the options each takes, a VITE_ envPrefix, a literal define, literal settings and path
// helpers, functions only where vite build never calls them), and when the build Vercel runs is a plain Vite build
// with no install or npm hook scripts of the app's own (vercelBuild, vite-vercel.ts), with the dashboard commands
// `vercel pull` saved, and with nothing else the install runs (vite-install.ts). The other files the build reads or runs (.env files,
// PostCSS, Tailwind and Svelte configs, the sources and their stylesheets) are vite-build-files.ts's and
// vite-sources.ts's. The checks before the allowlist only give a more precise reason for a config that exposes the
// key; they never make one safe. vite-config.ts reads the settings and calls these.

/** Why PARLOX_SECRET_KEY could end up in the browser build, and what the developer changes so it cannot. */
export interface SecretExposure {
  why: string;
  fix: string;
  /** The fix is to add the server part by hand (the wizard cannot check what the build does), not to run it again. */
  byHand?: boolean;
  /** `why` for an app whose host is not Vercel (another host, or none detected), where `why` says what Vercel does
   * with the app's build: the same facts, without saying that Vercel runs them. */
  offVercel?: string;
}

/** The reason as the app's host reads it: Vercel's words only on Vercel (`onVercel`), the host-neutral ones elsewhere. */
export const whyOn = (e: SecretExposure, onVercel: boolean): string => (onVercel ? e.why : e.offVercel ?? e.why);

const SECRET = "PARLOX_SECRET_KEY";
export const lineOf = (n: Node): number => n.loc?.start?.line ?? 0;
export const isModuleExports = (n: Node): boolean => n.type === "MemberExpression" && !n.computed && n.object.type === "Identifier" && n.object.name === "module" && n.property?.name === "exports";
const calleeNamed = (n: Node, name: string): boolean => n.type === "CallExpression" && ((n.callee.type === "Identifier" && n.callee.name === name) || (n.callee.type === "MemberExpression" && !n.callee.computed && n.callee.property?.name === name));

// TypeScript's own syntax around an expression (`x as T`, `x satisfies T`, `x!`, `<T>x`), erased before the code runs.
const TS_WRAPPERS = new Set(["TSAsExpression", "TSSatisfiesExpression", "TSNonNullExpression", "TSTypeAssertion", "ParenthesizedExpression"]);
/** The expression under TypeScript's assertions, which change nothing at run time. */
export const unwrapTs = (n: Node): Node => (n && TS_WRAPPERS.has(n.type) ? unwrapTs(n.expression) : n);
/** A property's key when it is written as a plain name, string or number, else null. __proto__ is not a plain key: it
 * sets the object's prototype, and Vite (or PostCSS, or Tailwind) would read settings from it. */
export function keyName(p: Node): string | null {
  if (p.type !== "ObjectProperty" || p.computed || !["Identifier", "StringLiteral", "NumericLiteral"].includes(p.key.type)) return null;
  const key = String(p.key.name ?? p.key.value);
  return key === "__proto__" ? null : key;
}
export const keyed = (p: Node): boolean => keyName(p) !== null;
/** Data only: strings, numbers, booleans, null, regular expressions, and arrays and objects of them. */
export function literal(raw: Node): boolean {
  const n = unwrapTs(raw);
  return ["StringLiteral", "NumericLiteral", "BooleanLiteral", "NullLiteral", "RegExpLiteral"].includes(n.type) || (n.type === "TemplateLiteral" && n.expressions.length === 0)
    || (n.type === "UnaryExpression" && n.operator === "-" && n.argument.type === "NumericLiteral")
    || (n.type === "ArrayExpression" && n.elements.every((e: Node | null) => e === null || literal(e)))
    || (n.type === "ObjectExpression" && n.properties.every((p: Node) => keyed(p) && literal(p.value)));
}

/** The text of a string written as a literal ('…', "…" or `…` without ${}), else null. */
export const literalString = (raw: Node): string | null => {
  const n = unwrapTs(raw);
  return n.type === "StringLiteral" ? n.value : n.type === "TemplateLiteral" && n.expressions.length === 0 ? n.quasis[0].value.cooked ?? null : null;
};

/** The value node of `key` in a config object (the last one, as JavaScript takes it; TypeScript's assertions taken
 * off), undefined when it is not set, or null when it is set in a way the wizard does not read (a method, a getter). */
export function valueOf(obj: Node, key: string): Node | null | undefined {
  let found: Node | null | undefined;
  for (const p of obj.properties) {
    if ((p.key?.name ?? p.key?.value) !== key || p.computed) continue;
    found = p.type === "ObjectProperty" ? unwrapTs(p.value) : null;
  }
  return found;
}

/** Whether `node` reads the environment: process.env, import.meta.env, loadEnv(…), or a name bound to one of them. */
function readsEnv(node: Node, envNames: Set<string>): boolean {
  let found = false;
  walk(node, (n, ancestors) => {
    if (found) return;
    if (n.type === "MemberExpression" && !n.computed && n.property?.name === "env" && ((n.object.type === "Identifier" && n.object.name === "process") || n.object.type === "MetaProperty")) found = true;
    else if (calleeNamed(n, "loadEnv")) found = true;
    else if (n.type === "Identifier" && envNames.has(n.name)) {
      const parent = ancestors[ancestors.length - 1];
      if (!((parent?.type === "MemberExpression" || parent?.type === "OptionalMemberExpression") && parent.property === n && !parent.computed) && !(parent?.type === "ObjectProperty" && parent.key === n && !parent.computed)) found = true;
    }
  });
  return found;
}

/** The names the file binds to something that reads the environment (const env = loadEnv(…), const { X } = process.env,
 * and so on, through as many steps as it takes). */
function envBindings(ast: Ast): Set<string> {
  const names = new Set<string>();
  const bind = (id: Node | null | undefined): boolean => {
    let added = false;
    const add = (p: Node | null | undefined): void => {
      if (!p) return;
      if (p.type === "Identifier") { if (!names.has(p.name)) { names.add(p.name); added = true; } }
      else if (p.type === "ObjectPattern") for (const q of p.properties) add(q.type === "RestElement" ? q.argument : q.value);
      else if (p.type === "ArrayPattern") for (const e of p.elements) add(e);
      else if (p.type === "AssignmentPattern") add(p.left);
      else if (p.type === "RestElement") add(p.argument);
    };
    add(id);
    return added;
  };
  for (let changed = true, rounds = 0; changed && rounds < 10; rounds++) {
    changed = false;
    walk(ast.program, (n) => {
      if (n.type === "VariableDeclarator" && n.init && readsEnv(n.init, names)) changed = bind(n.id) || changed;
      else if (n.type === "AssignmentExpression" && readsEnv(n.right, names)) changed = bind(n.left) || changed;
    });
  }
  return names;
}

const readable = (p: string) => (p === "" ? 'an empty prefix ("")' : p);

function prefixExposure(file: string, prefixes: string[] | null): SecretExposure | null {
  if (prefixes === null) return { why: `The wizard cannot read envPrefix in ${file} (it is computed in code), so it cannot tell whether Vite would bundle the secret key into the browser code.`, fix: "set envPrefix to plain strings" };
  const bad = prefixes.find((p) => SECRET.startsWith(p));
  if (bad === undefined) return null;
  return { why: `Your Vite config lists ${readable(bad)} in envPrefix, so the secret key would be bundled into the browser code.`, fix: `remove ${bad === "" ? "the empty prefix" : bad} from envPrefix` };
}

/** define's values are put into the browser code as they are: none may come from the environment. */
function defineExposure(file: string, objects: Node[], follow: (id: Node) => Node | null, envNames: Set<string>): SecretExposure | null {
  const exposure = (n: Node): SecretExposure => ({ why: `${file} passes environment values to the browser code through define (line ${lineOf(n)}), so the secret key could be bundled with them.`, fix: "give define only literal values (or JSON.stringify of one)" });
  for (const o of objects) {
    const v = valueOf(o, "define");
    if (v === undefined) continue;
    const prop = o.properties.find((p: Node) => (p.key?.name ?? p.key?.value) === "define");
    const value = v?.type === "Identifier" ? follow(v) : v;
    if (value?.type !== "ObjectExpression") return exposure(v ?? prop);
    for (const p of value.properties) if (p.type !== "ObjectProperty" || p.computed || readsEnv(p.value, envNames)) return exposure(p);
  }
  return null;
}

/** loadEnv(mode, dir, prefixes) returns the variables whose names start with a prefix; with '' (or a prefix
 * PARLOX_SECRET_KEY starts with) the config holds the key, and any option may hand it to the browser build. */
function loadEnvExposure(file: string, ast: Ast): SecretExposure | null {
  let found: SecretExposure | null = null;
  const fix = BY_HAND;
  walk(ast.program, (n) => {
    if (found || !calleeNamed(n, "loadEnv") || n.arguments.length < 3) return;
    const a: Node = n.arguments[2];
    const list = a.type === "StringLiteral" ? [a.value as string] : a.type === "ArrayExpression" && a.elements.every((e: Node | null) => e?.type === "StringLiteral") ? a.elements.map((e: Node) => e.value as string) : null;
    const bad = list?.find((p: string) => SECRET.startsWith(p));
    if (list && bad === undefined) return;
    const what = !list ? "calls loadEnv with a prefix computed in code" : bad === "" ? "loads every variable with loadEnv(…, '')" : `loads the variables starting with ${bad} with loadEnv`;
    found = { why: `${file} ${what} (line ${lineOf(n)}), so the secret key could reach the browser code through the config.`, fix, byHand: true };
  });
  return found;
}

function mentionExposure(file: string, ast: Ast): SecretExposure | null {
  let at: Node | null = null;
  walk(ast.program, (n) => {
    if (!at && ((n.type === "Identifier" && n.name === SECRET) || (n.type === "StringLiteral" && n.value === SECRET) || (n.type === "TemplateElement" && n.value?.cooked?.includes(SECRET)))) at = n;
  });
  return at ? { why: `${file} names PARLOX_SECRET_KEY (line ${lineOf(at)}), so the secret key could be bundled into the browser code.`, fix: "remove it from the Vite config" } : null;
}

/** A config that names PARLOX_SECRET_KEY in its code (define, loadEnv, process.env, the environment plugin): it holds
 * the key whatever runs it (a build, the dev server, a test runner), so it withholds the key even where Vite is neither
 * declared nor run; an envPrefix exposes only through a Vite build, which the other checks find (apps.ts). Comments do
 * not count. */
export function secretKeyNamed(file: string, ast: Ast): SecretExposure | null {
  let named: Node | null = null;
  walk(ast.program, (n) => {
    const text = n.type === "Identifier" ? n.name : n.type === "StringLiteral" ? n.value : n.type === "TemplateElement" ? n.value?.cooked ?? n.value?.raw : null;
    if (!named && typeof text === "string" && text.includes(SECRET)) named = n;
  });
  const at = named as Node | null;
  return at ? { why: `${file} names ${SECRET} (line ${lineOf(at)}), so the build was set up to read Parlox's variables and could bundle the secret key into the browser code.`, fix: "remove it from the Vite config" } : null;
}

// How a package.json script (or vercel.json's buildCommand) runs Vite: with --config (or -c), or with a root folder
// after the command (vite [root], vite build [root]). Vite's CLI (packages/vite/src/node/cli.ts, parsed by cac) takes
// the next word as the value of every option that is not a boolean one, so only a word no option takes is the root.
const VITE_COMMAND = /(?:^|\/)vite(?:@\S*)?$/;
const SUBCOMMANDS = new Set(["build", "dev", "serve", "preview", "optimize"]);
const CONFIG_FLAG = /^(?:--config(?:=.*)?|-c.*)$/;
const BOOLEAN_FLAGS = new Set(["--clearScreen", "--cors", "--strictPort", "--force", "--experimentalBundle", "--emptyOutDir", "-w", "--watch", "--app"]);
type Elsewhere = { config: true } | { root: string };
function viteElsewhere(command: string): Elsewhere | null {
  let moved: string | null = null;
  for (const segment of command.split(/&&|\|\||[;|&\n]/)) {
    const words = segment.trim().split(/\s+/);
    // cd <folder> before Vite runs: Vite's root is that folder.
    if (words[0] === "cd" && words[1] && (posix.normalize(words[1]).replace(/\/+$/, "") || ".") !== ".") moved = words[1];
    const at = words.findIndex((w) => VITE_COMMAND.test(w));
    if (at < 0) continue;
    if (moved) return { root: moved };
    const args = words.slice(at + 1);
    if (args.some((w) => CONFIG_FLAG.test(w))) return { config: true };
    for (let i = SUBCOMMANDS.has(args[0]) ? 1 : 0; i < args.length; i++) {
      const w = args[i];
      if (/^(\d?[<>]|--$)/.test(w)) break;
      if (w.startsWith("-")) {
        if (!w.includes("=") && !BOOLEAN_FLAGS.has(w) && !w.startsWith("--no-") && args[i + 1] !== undefined && !args[i + 1].startsWith("-")) i++;
        continue;
      }
      const root = w.replace(/^(["'])(.*)\1$/, "$2");
      if ((posix.normalize(root).replace(/\/+$/, "") || ".") !== ".") return { root };
    }
  }
  return null;
}
/** The config files a command gives Vite with --config or -c (`--config x.ts`, `--config=x.ts`, `-c x.ts`), as written
 * (quotes taken off), relative to where the command runs. */
export function viteConfigArgs(command: string): string[] {
  const out: string[] = [];
  for (const segment of command.split(/&&|\|\||[;|&\n]/)) {
    const words = segment.trim().split(/\s+/);
    const at = words.findIndex((w) => VITE_COMMAND.test(w));
    if (at < 0) continue;
    const args = words.slice(at + 1);
    for (let i = 0; i < args.length; i++) {
      const m = /^(?:--config|-c)(?:=(.*))?$/.exec(args[i]);
      const value = m ? m[1] ?? args[++i] : undefined;
      if (value) out.push(value.replace(/^(["'])(.*)\1$/, "$2"));
    }
  }
  return out;
}

/** A script that points Vite at another config or another root folder: the wizard reads only the default config in
 * this folder, so it can know neither the settings Vite uses nor what that config does with the secret key. */
export function scriptElsewhere(read: (rel: string) => string | null): SecretExposure | null {
  const json = (rel: string): Record<string, any> | null => { try { const v = JSON.parse((read(rel) ?? "null").replace(/^\uFEFF/, "")); return v && typeof v === "object" ? v : null; } catch { return null; } };
  const commands: Array<[string, unknown]> = [
    ...Object.entries((json("package.json")?.scripts as Record<string, unknown> | undefined) ?? {}).map(([name, c]): [string, unknown] => [`The script "${name}"`, c]),
    ["vercel.json's buildCommand", json("vercel.json")?.buildCommand],
  ];
  const cannot = "so the wizard cannot tell which config Vite uses, or prove that it keeps the secret key out of the browser code.";
  for (const [who, command] of commands) {
    const e = typeof command === "string" ? viteElsewhere(command) : null;
    if (!e) continue;
    return "config" in e
      ? { why: `${who} runs Vite with --config, ${cannot}`, fix: "let Vite use its default config file (no --config)" }
      : { why: `${who} runs Vite in another folder (${e.root}), ${cannot}`, fix: `run Vite from this folder, without the folder name (${e.root}),` };
  }
  return null;
}

// vite-plugin-environment puts the variables it is given into the browser code ("Expose environment variables to your
// client code"): a list of names, an object of names and default values, or 'all' (every variable).
const ENV_PLUGIN = "vite-plugin-environment";
function envPluginExposure(file: string, ast: Ast): SecretExposure | null {
  const fix = "remove vite-plugin-environment from the Vite config";
  const cannotFollow = (n: Node): SecretExposure => ({ why: `${file} uses vite-plugin-environment (line ${lineOf(n)}) in a way the wizard cannot follow, so it cannot prove the secret key stays out of the browser code.`, fix });
  const names = new Set<string>();
  let odd: Node | null = null;
  for (const s of ast.program.body) {
    if (s.type !== "ImportDeclaration" || s.importKind === "type") continue;
    for (const sp of s.specifiers) if (sp.importKind !== "type" && (s.source.value === ENV_PLUGIN || (sp.imported?.name ?? sp.imported?.value) === "EnvironmentPlugin" || sp.local.name === "EnvironmentPlugin")) names.add(sp.local.name);
  }
  walk(ast.program, (n, ancestors) => {
    if (odd) return;
    const named = (lit: Node | undefined) => lit?.type === "StringLiteral" && lit.value === ENV_PLUGIN;
    if (n.type === "ImportExpression" ? named(n.source) : n.type === "CallExpression" && n.callee.type === "Import" && named(n.arguments[0])) odd = n;
    else if (n.type === "CallExpression" && n.callee.type === "Identifier" && n.callee.name === "require" && named(n.arguments[0])) {
      const parent = ancestors[ancestors.length - 1];
      if (parent?.type === "VariableDeclarator" && parent.init === n && parent.id.type === "Identifier") names.add(parent.id.name);
      else if (parent?.type === "VariableDeclarator" && parent.init === n && parent.id.type === "ObjectPattern" && parent.id.properties.every((p: Node) => p.type === "ObjectProperty" && p.value.type === "Identifier")) for (const p of parent.id.properties) names.add(p.value.name);
      else odd = n;
    }
  });
  if (odd) return cannotFollow(odd);
  const keyOf = (p: Node): string | null => (p.type === "ObjectProperty" && !p.computed ? (p.key.type === "Identifier" ? p.key.name : p.key.type === "StringLiteral" ? p.key.value : null) : null);
  // Every use of those names: each must be a call whose argument the wizard can read.
  const uses: Array<{ ref: Node; parent?: Node; grand?: Node }> = [];
  walk(ast.program, (n, ancestors) => { if (n.type === "Identifier" && names.has(n.name)) uses.push({ ref: n, parent: ancestors[ancestors.length - 1], grand: ancestors[ancestors.length - 2] }); });
  for (const { ref, parent, grand } of uses) {
    // The bindings themselves (the import, the require() and its destructuring), and other things' keys.
    if (parent && /^Import(Default|Namespace)?Specifier$/.test(parent.type)) continue;
    if (parent?.type === "VariableDeclarator" && parent.id === ref) continue;
    if (parent?.type === "ObjectProperty" && (parent.key === ref || grand?.type === "ObjectPattern")) continue;
    if ((parent?.type === "MemberExpression" || parent?.type === "OptionalMemberExpression") && parent.property === ref && !parent.computed) continue;
    // name(…), or ns.default(…) / ns.EnvironmentPlugin(…) for a namespace or a require()d module.
    const call = parent?.type === "CallExpression" && parent.callee === ref ? parent
      : parent?.type === "MemberExpression" && parent.object === ref && grand?.type === "CallExpression" && grand.callee === parent ? grand : null;
    if (!call) return cannotFollow(ref);
    const arg: Node | undefined = call.arguments[0];
    if (arg?.type === "StringLiteral" && arg.value === "all") return { why: `${file} loads EnvironmentPlugin('all') (line ${lineOf(call)}), which puts every environment variable into the browser code, the secret key included.`, fix };
    const keys = arg?.type === "ArrayExpression" && arg.elements.every((e: Node | null) => e?.type === "StringLiteral") ? arg.elements.map((e: Node) => e.value as string)
      : arg?.type === "ObjectExpression" && arg.properties.every((p: Node) => keyOf(p) !== null && !readsEnv(p.value, new Set())) ? arg.properties.map((p: Node) => keyOf(p)!)
      : null;
    if (!keys) return { why: `${file} calls EnvironmentPlugin (line ${lineOf(call)}) with variables the wizard cannot read, so it cannot prove the secret key stays out of the browser code.`, fix };
    const bad = keys.find((k: string) => k.startsWith("PARLOX"));
    if (bad) return { why: `${file} passes ${bad} to EnvironmentPlugin (line ${lineOf(call)}), so it would be bundled into the browser code.`, fix };
  }
  return null;
}

export const BY_HAND = `if nothing in the build puts a PARLOX_ variable into the browser code, add the server part by hand (see ${GUIDE})`;
/** An exposure the wizard can only describe: what it did not check. The developer adds the server part by hand.
 * `offVercel`: the same, for a host that is not Vercel (or none detected), where `what` says what Vercel runs. */
export const notChecked = (what: string, offVercel?: string): SecretExposure => {
  const why = (w: string) => `${w}, so the wizard cannot prove that the build keeps the secret key out of the browser code.`;
  return { why: why(what), fix: BY_HAND, byHand: true, ...(offVercel ? { offVercel: why(offVercel) } : {}) };
};

// What a config may use and still be proven safe. Every import comes from these; plugins are calls of the plugin
// packages' exports (their default, or the Svelte plugin's svelte), with only the options each takes (PLUGINS); @rolldown/plugin-babel and
// reactCompilerPreset are what create-vite's React Compiler templates add (create-vite 9.2.1, setupReactCompiler).
// lovable-tagger is Lovable's default: version 1.3.5 reads only process.env.LOVABLE_DEV_SERVER, and it is
// allowed only behind the development gate Lovable writes, and only in a build whose mode is production (in
// another mode the gate may be open, and the tagger's module runs when the config loads anyway). ./package.json is
// static data, allowed only as JSON.stringify(pkg.<name>) in define. Type-only imports are erased before the config
// runs.
const TAGGER = "lovable-tagger";
const PACKAGE_JSON = "./package.json";
// @vitejs/plugin-vue, @sveltejs/vite-plugin-svelte, @hono/vite-build (its Cloudflare Pages adapter),
// @hono/vite-dev-server (its Cloudflare adapter, which create-hono's Pages template passes it) and
// @cloudflare/vite-plugin: their published code, opened at 6.0.9, 7.3.1, 1.11.1, 0.26.1 and 1.62.5, reads no
// environment variable into the code a build writes for the browser (PLUGINS below says where each reads the
// environment at all, and what the wizard checks of each).
const CLOUDFLARE_PLUGIN = "@cloudflare/vite-plugin";
const PLUGIN_IMPORTS = ["@vitejs/plugin-vue", "@sveltejs/vite-plugin-svelte", "@hono/vite-build", "@hono/vite-build/cloudflare-pages", "@hono/vite-dev-server", "@hono/vite-dev-server/cloudflare", CLOUDFLARE_PLUGIN];
const ALLOWED_IMPORTS = new Set(["vite", "vitest/config", "@vitejs/plugin-react", "@vitejs/plugin-react-swc", "@tailwindcss/vite", "vite-tsconfig-paths", "@rolldown/plugin-babel", "node:path", "path", "node:url", "url", TAGGER, PACKAGE_JSON, ...PLUGIN_IMPORTS]);
const VITE_SOURCES = new Set(["vite", "vitest/config"]);
/** The packages the config guard and the build commands trust by name (each must come from the npm registry,
 * vite-install.ts): the config's imports, the React Compiler, the type checkers the plain builds run, the bundlers Vite
 * itself runs, and the tools the known-harmless install commands run. */
export const TRUSTED_PACKAGES = ["vite", "vitest", "@vitejs/plugin-react", "@vitejs/plugin-react-swc", "@tailwindcss/vite", "vite-tsconfig-paths", "@rolldown/plugin-babel", "lovable-tagger", "babel-plugin-react-compiler", "typescript", "esbuild", "rollup", "rolldown", "husky", "patch-package", "prisma",
  // The new plugins, the compilers they load from the app (vue, svelte), the modules the Cloudflare adapter loads
  // (wrangler, miniflare) and the dev server's (@hono/node-server), and vue-tsc with the tsconfig it extends.
  "@vitejs/plugin-vue", "@sveltejs/vite-plugin-svelte", "@hono/vite-build", "@hono/vite-dev-server", "vue", "svelte", "wrangler", "miniflare", "@hono/node-server", "vue-tsc", "@vue/tsconfig",
  // The Cloudflare Vite plugin and the modules it loads when the config loads (dist/index.mjs:26-37; wrangler and
  // miniflare are above).
  CLOUDFLARE_PLUGIN, "workerd", "unenv", "@cloudflare/unenv-preset", "ws"];
const PATH_PACKAGES = new Set(["node:path", "path"]);
const URL_PACKAGES = new Set(["node:url", "url"]);
const FORBIDDEN = new Set(["process", "env", "loadEnv"]);
const REACT_COMPILER = "babel-plugin-react-compiler";
// The options of each plugin the wizard vouches for, from each package's published types (opened at
// @vitejs/plugin-react 4.7.0 and 6.1.1, @vitejs/plugin-react-swc 4.3.3, @tailwindcss/vite 4.3.3, vite-tsconfig-paths
// 6.1.1, @rolldown/plugin-babel 0.2.4). Each value is literal or a path helper, and Babel's plugins and presets are the
// React Compiler only. Left out, because they load or run code: Babel's extends, overrides and env, a Babel config
// file (babelrc and configFile, unless false; @rolldown/plugin-babel passes extends through to Babel), SWC's plugins,
// vite-tsconfig-paths' logFile, and every function.
//
// The plugins read for this (their published dist, never run):
// - @vitejs/plugin-vue 6.0.9 (dist/index.mjs): its config hook defines only __VUE_OPTIONS_API__,
//   __VUE_PROD_DEVTOOLS__ and __VUE_PROD_HYDRATION_MISMATCH_DETAILS__, from its own features option or the config's
//   define (:1692-1696); it reads process.env.NODE_ENV for isProduction (:1625) and, in its bundled debug logger, DEBUG
//   for stderr (:1037-1040, :1192). Left out: its compiler option (a compiler object to run) and every function
//   (template compiler transforms, isCustomElement, componentIdGenerator, script.fs), which it calls while Vite builds.
//   A <template> in another language (Pug and the like) runs that language's code when it compiles (:229-251, :1464),
//   which vite-sources.ts refuses in .vue files.
// - @sveltejs/vite-plugin-svelte 7.3.1 (src/): no define; it reads NODE_ENV (preprocess.js:119) and DEBUG
//   (index.js:25, plugins/configure.js:43, utils/options.js:166) for logging, and its inspector reads SVELTE_INSPECTOR_*
//   variables, but the inspector plugin runs only in the dev server (plugins/inspector/index.js:42, `apply: 'serve'`;
//   options.js:26). It imports svelte.config.* from Vite's root (utils/load-svelte-config.js:22-27, 59-76), which
//   vite-build-files.ts checks, unless configFile is false. Left out: dynamicCompileOptions and onwarn (functions), a
//   configFile path, and a preprocess other than its own vitePreprocess with boolean options (an object there is a
//   Vite config of its own, preprocess.js:110-125).
// - @hono/vite-build 1.11.1 (dist/base.mjs, adapter/cloudflare-pages/index.mjs, entry/index.mjs): reads no
//   environment at all; it builds the server entry (build.ssr) and writes _routes.json. Left out: apply and the
//   entryContent*Hooks (functions that write the entry's code), and an entry outside the app folder.
// - @hono/vite-dev-server 0.26.1 (dist/dev-server.mjs, adapter/cloudflare.mjs): reads no environment in a build; its
//   adapter and env are used only in the dev server (configureServer, :61-151). The Cloudflare adapter's module loads
//   wrangler and miniflare and sets globalThis.WebSocketPair (adapter/cloudflare.mjs:1-4); getPlatformProxy runs only
//   in the dev server. Left out: env, loadModule and handleHotUpdate (code), and other adapters.
// - @cloudflare/vite-plugin 1.62.5 (dist/index.mjs), with the one wrangler 4.147.0 function a build calls
//   (wrangler-dist/cli.js): the client environment gets only its output folder and optimizeDeps.exclude
//   (getEnvironmentsConfig, :80461-80464); each Worker environment's define is NODE_ENV and, without nodejs_compat,
//   process.env as {} (createCloudflareEnvironmentOptions, :67940-67947; getProcessEnvReplacements, :68016-68029), and
//   wrangler's own define is dropped (:65738-65739). It loads only CLOUDFLARE_ and
//   WRANGLER_HYPERDRIVE_LOCAL_CONNECTION_STRING_ variables, into process.env (resolvePluginConfig, :66003-66004). Beside
//   the Worker's bundle, never in the client's output, a build writes the Worker's wrangler.json and a .dev.vars of its
//   local variables for `vite preview` (output-config, :90204-90264): .dev.vars or .env, and process.env too where the
//   Worker declares secrets or CLOUDFLARE_INCLUDE_PROCESS_ENV is true (getLocalDevVarsForPreview, :80222-80228; wrangler's
//   getVarsForDev, cli.js:186098-186152); the client's .assetsignore lists both (:90233-90240). Allowed: configPath (a
//   wrangler config, which must be .jsonc, .json or .toml, inside the app), viteEnvironment (the Worker's environment
//   name, never "client"), and persistState, inspectorPort and remoteBindings, which only the dev and preview servers use
//   (getDevMiniflareOptions, getPreviewMiniflareOptions). Left out: experimental (newConfig loads cloudflare.config.ts,
//   code, :66024-66040; prerenderWorker adds a Worker built for prerendering, :66052-66071), config and auxiliaryWorkers
//   (Worker configs, functions allowed), assetsOnly (a function allowed), and tunnel; and, beside the plugin, Vite's
//   environments setting, which could put a Worker's output folder, with its .dev.vars, inside the client's.
const HONO_BUILD = new Set(["entry", "output", "outputDir", "external", "minify", "emptyOutDir", "ssrTarget", "staticPaths", "preset"]);
const PLUGINS = new Map<string, Set<string>>([
  ["@vitejs/plugin-react#default", new Set(["include", "exclude", "jsxImportSource", "jsxRuntime", "babel", "reactRefreshHost", "disableOxcRecommendation", "compiler"])],
  ["@vitejs/plugin-react-swc#default", new Set(["jsxImportSource", "tsDecorators", "devTarget", "reactRefreshHost", "disableOxcRecommendation"])],
  ["@tailwindcss/vite#default", new Set(["optimize"])],
  ["vite-tsconfig-paths#default", new Set(["root", "projects", "loose", "parseNative", "ignoreConfigErrors", "configNames", "projectDiscovery"])],
  ["@rolldown/plugin-babel#default", new Set(["presets", "plugins", "include", "exclude", "sourceMap"])],
  ["@vitejs/plugin-vue#default", new Set(["include", "exclude", "isProduction", "script", "template", "style", "features", "customElement"])],
  ["@sveltejs/vite-plugin-svelte#svelte", new Set(["include", "exclude", "emitCss", "disableDependencyReinclusion", "prebundleSvelteLibraries", "inspector", "experimental", "extensions", "compilerOptions", "preprocess", "configFile"])],
  ["@hono/vite-build#default", HONO_BUILD],
  ["@hono/vite-build/cloudflare-pages#default", HONO_BUILD],
  ["@hono/vite-dev-server#default", new Set(["entry", "export", "injectClientScript", "exclude", "ignoreWatching", "base", "adapter"])],
  [`${CLOUDFLARE_PLUGIN}#cloudflare`, new Set(["configPath", "viteEnvironment", "persistState", "inspectorPort", "remoteBindings"])],
]);
const SVELTE = new Set(["@sveltejs/vite-plugin-svelte"]);
const HONO_ADAPTER = new Set(["@hono/vite-dev-server/cloudflare"]);
const BABEL_OPTIONS = new Set(["plugins", "presets", "babelrc", "configFile"]);
// Functions are allowed only in server and preview, only as a proxy's rewrite, configure or bypass (which only the dev
// and preview servers call), and only ones that cannot reach the environment or load code. A getter is not one: reading
// the config runs it.
const DEV_KEYS = new Set(["server", "preview"]);
const PROXY_FUNCTIONS = new Set(["rewrite", "configure", "bypass"]);
const NOT_IN_DEV_FUNCTIONS = new Set(["process", "env", "globalThis", "global", "require", "eval", "Function"]);
// What in a stylesheet loads code: Tailwind's @plugin and @config, Less's @plugin and @import (plugin), Stylus's use().
const STYLE_CODE = /@plugin\b|@config\b|@import\s*\([^)]*\bplugin\b|\buse\s*\(/;
const FUNCTIONS = new Set(["ArrowFunctionExpression", "FunctionExpression", "FunctionDeclaration"]);
type Binding = { source: string; imported: string };

/** The first thing in the config that is not on the wizard's list, or null when everything is. `modes`: the modes the
 * build runs in. */
function unchecked(ast: Ast, modes: string[]): { what: string; at: Node } | null {
  const foreign = ast.program.body.find((s) => s.type === "ImportDeclaration" && s.importKind !== "type" && !ALLOWED_IMPORTS.has(s.source.value));
  if (foreign) return { what: `the import of ${foreign.source.value}`, at: foreign };
  let named: Node | null = null;
  walk(ast.program, (n) => { if (!named && n.type === "Identifier" && FORBIDDEN.has(n.name)) named = n; });
  if (named) return { what: `the name ${(named as Node).name}`, at: named };
  const bindings = new Map<string, Binding>();
  const dirs = new Set(["__dirname", "__filename"]);
  let exported: Node | null = null;
  // The config function's own parameters: mode (only in the development gate) and command ('build' or 'serve').
  const params = new Set<string>();
  const param = (n: Node | undefined, name: string) => n?.type === "Identifier" && n.name === name && params.has(name) && !bindings.has(name);
  const isMeta = (n: Node | undefined, prop: string) => n?.type === "MemberExpression" && !n.computed && n.object.type === "MetaProperty" && n.object.meta?.name === "import" && n.property?.name === prop;
  const bound = (n: Node | undefined, sources: Set<string>, imported: string) => n?.type === "Identifier" && sources.has(bindings.get(n.name)?.source ?? "") && bindings.get(n.name)!.imported === imported;
  // fileURLToPath(import.meta.url) or fileURLToPath(new URL('<literal>', import.meta.url)).
  const fileUrl = (raw: Node): boolean => {
    const n = unwrapTs(raw);
    return n.type === "CallExpression" && n.arguments.length === 1 && (bound(n.callee, URL_PACKAGES, "fileURLToPath") || (n.callee.type === "MemberExpression" && !n.callee.computed && n.callee.property?.name === "fileURLToPath" && (bound(n.callee.object, URL_PACKAGES, "default") || bound(n.callee.object, URL_PACKAGES, "*"))))
      && (isMeta(n.arguments[0], "url") || (n.arguments[0].type === "NewExpression" && n.arguments[0].callee.type === "Identifier" && n.arguments[0].callee.name === "URL" && (!bindings.has("URL") || bound(n.arguments[0].callee, URL_PACKAGES, "URL")) && n.arguments[0].arguments.length === 2 && n.arguments[0].arguments[0].type === "StringLiteral" && isMeta(n.arguments[0].arguments[1], "url")));
  };
  // path.resolve / path.join / path.dirname (or the named imports) of literals, __dirname, import.meta.dirname, and
  // other path helpers.
  const pathArg = (raw: Node): boolean => {
    const n = unwrapTs(raw);
    return n.type === "StringLiteral" || (n.type === "TemplateLiteral" && n.expressions.length === 0) || (n.type === "Identifier" && dirs.has(n.name) && !bindings.has(n.name)) || isMeta(n, "dirname") || pathCall(n) || fileUrl(n);
  };
  const pathCall = (raw: Node): boolean => {
    const n = unwrapTs(raw);
    return n.type === "CallExpression" && n.arguments.length > 0 && n.arguments.every(pathArg)
      && (["resolve", "join", "dirname"].some((f) => bound(n.callee, PATH_PACKAGES, f)) || (n.callee.type === "MemberExpression" && !n.callee.computed && ["resolve", "join", "dirname"].includes(n.callee.property?.name) && (bound(n.callee.object, PATH_PACKAGES, "default") || bound(n.callee.object, PATH_PACKAGES, "*"))));
  };
  // command === 'build' (or 'serve'; ==, !== and != too): Vite's own command, 'build' in every build Vercel runs.
  const commandTest = (raw: Node): boolean => {
    const n = unwrapTs(raw);
    return n.type === "BinaryExpression" && ["===", "==", "!==", "!="].includes(n.operator) && ((param(n.left, "command") && n.right.type === "StringLiteral") || (param(n.right, "command") && n.left.type === "StringLiteral"));
  };
  const setting = (raw: Node): boolean => {
    const n = unwrapTs(raw);
    return literal(n) || pathArg(n)
      || (n.type === "ConditionalExpression" && commandTest(n.test) && setting(n.consequent) && setting(n.alternate))
      || (n.type === "ArrayExpression" && n.elements.every((e: Node | null) => e === null || setting(e)))
      || (n.type === "ObjectExpression" && n.properties.every((p: Node) => keyed(p) && setting(p.value)));
  };
  // A function in server or preview: an arrow, a function or a method (never a getter or a setter), that names none of
  // NOT_IN_DEV_FUNCTIONS and loads nothing (import(), import.meta).
  const devFunction = (n: Node): boolean => {
    const method = n.type === "ObjectMethod" && n.kind === "method" && !n.computed && ["Identifier", "StringLiteral", "NumericLiteral"].includes(n.key.type) && String(n.key.name ?? n.key.value) !== "__proto__";
    if (!method && n.type !== "ArrowFunctionExpression" && n.type !== "FunctionExpression") return false;
    let clean = true;
    walk(n, (m) => { if ((m.type === "Identifier" && NOT_IN_DEV_FUNCTIONS.has(m.name)) || m.type === "Import" || m.type === "ImportExpression" || m.type === "MetaProperty") clean = false; });
    return clean;
  };
  // `path`: the keys from server or preview down to this value. A function is allowed only as a proxy's rewrite,
  // configure or bypass (proxy.<path>.rewrite): elsewhere Vite may call it while it resolves the config, in a build too
  // (server.origin.endsWith, server.fs.allow.map).
  const proxyFunction = (path: string[]) => path.length === 3 && path[0] === "proxy" && PROXY_FUNCTIONS.has(path[2]);
  const devSetting = (raw: Node, path: string[]): boolean => {
    const n = unwrapTs(raw);
    return setting(n) || (proxyFunction(path) && devFunction(n))
      || (n.type === "ArrayExpression" && n.elements.every((e: Node | null) => e === null || setting(e)))
      || (n.type === "ObjectExpression" && n.properties.every((p: Node) => {
        const key = p.type === "ObjectMethod" && !p.computed ? String(p.key.name ?? p.key.value) : keyName(p);
        return key !== null && (p.type === "ObjectMethod" ? proxyFunction([...path, key]) && devFunction(p) : devSetting(p.value, [...path, key]));
      }));
  };
  // Babel's plugins and presets: the React Compiler only.
  const compiler = (raw: Node): boolean => {
    const n = unwrapTs(raw);
    return (n.type === "StringLiteral" && n.value === REACT_COMPILER)
      || (n.type === "ArrayExpression" && n.elements.length >= 1 && n.elements[0]?.type === "StringLiteral" && n.elements[0].value === REACT_COMPILER && n.elements.slice(1).every((e: Node | null) => e !== null && literal(e)))
      || (n.type === "CallExpression" && bound(n.callee, new Set(["@vitejs/plugin-react"]), "reactCompilerPreset") && n.arguments.every(literal));
  };
  const compilerList = (raw: Node): boolean => { const n = unwrapTs(raw); return n.type === "ArrayExpression" && n.elements.every((e: Node | null) => e !== null && compiler(e)); };
  /** The Babel option that is not one the wizard checks (".extends"), "" for the whole object, or null. */
  const babelOff = (n: Node): string | null => {
    if (n.type !== "ObjectExpression") return "";
    for (const p of n.properties) {
      const key = keyName(p);
      if (key === null) return "";
      const v = unwrapTs(p.value);
      if (!BABEL_OPTIONS.has(key) || !(key === "plugins" || key === "presets" ? compilerList(v) : v.type === "BooleanLiteral" && v.value === false)) return `.${key}`;
    }
    return null;
  };
  // vitePreprocess() from the Svelte plugin, with boolean options at most.
  const vitePreprocess = (raw: Node | null): boolean => {
    const n = raw && unwrapTs(raw);
    if (n?.type !== "CallExpression" || !bound(n.callee, SVELTE, "vitePreprocess") || n.arguments.length > 1) return false;
    const o = n.arguments[0] ? unwrapTs(n.arguments[0]) : null;
    return o === null || (o.type === "ObjectExpression" && o.properties.every((p: Node) => (keyName(p) === "script" || keyName(p) === "style") && unwrapTs(p.value).type === "BooleanLiteral"));
  };
  const preprocessList = (raw: Node): boolean => { const n = unwrapTs(raw); return vitePreprocess(n) || (n.type === "ArrayExpression" && n.elements.every(vitePreprocess)); };
  // A path the plugin reads code from: a literal inside the app folder (or a list of them).
  const insidePath = (raw: Node): boolean => {
    const n = unwrapTs(raw);
    if (n.type === "ArrayExpression") return n.elements.every((e: Node | null) => e !== null && insidePath(e));
    if (n.type !== "StringLiteral") return false;
    const p = posix.normalize((n.value as string).replace(/\\/g, "/"));
    return !posix.isAbsolute(p) && !/^[A-Za-z]:/.test(p) && p !== ".." && !p.startsWith("../");
  };
  // The dev server's adapter: the Cloudflare adapter itself, or called with literal options.
  const honoAdapter = (raw: Node): boolean => {
    const n = unwrapTs(raw);
    return bound(n, HONO_ADAPTER, "default") || (n.type === "CallExpression" && bound(n.callee, HONO_ADAPTER, "default") && n.arguments.every(literal));
  };
  // Whether a literal value names Vite's client environment anywhere inside it.
  const namesClient = (raw: Node): boolean => {
    const n = unwrapTs(raw);
    if (n.type === "StringLiteral") return n.value === "client";
    if (n.type === "ArrayExpression") return n.elements.some((e: Node | null) => e !== null && namesClient(e));
    if (n.type === "ObjectExpression") return n.properties.some((p: Node) => p.value && namesClient(p.value));
    return false;
  };
  /** Whether a plugin option the wizard checks has a value it vouches for. */
  const optionOk = (source: string, key: string, v: Node): boolean => {
    if (key === "plugins" || key === "presets") return compilerList(v);
    if (source === "@sveltejs/vite-plugin-svelte" && key === "preprocess") return preprocessList(v);
    if (source === "@sveltejs/vite-plugin-svelte" && key === "configFile") return v.type === "BooleanLiteral" && v.value === false;
    if (source.startsWith("@hono/") && key === "entry") return insidePath(v);
    // A wrangler config the plugin reads: JSON, JSONC or TOML, inside the app.
    if (source === CLOUDFLARE_PLUGIN && key === "configPath") return insidePath(v) && v.type === "StringLiteral" && /\.(jsonc?|toml)$/i.test(v.value as string);
    // The Worker's Vite environment, named by literals and never the client's, whose output the browser downloads.
    if (source === CLOUDFLARE_PLUGIN && key === "viteEnvironment") return setting(v) && !namesClient(v);
    if (source === "@hono/vite-dev-server" && key === "adapter") return honoAdapter(v);
    return setting(v);
  };
  /** Why a plugins entry is not a plugin the wizard checks, with options it checks, or null. */
  const pluginOff = (raw: Node | null): string | null => {
    const n = raw && unwrapTs(raw);
    const b = n?.type === "CallExpression" && n.callee.type === "Identifier" ? bindings.get(n.callee.name) : undefined;
    const allowed = b ? PLUGINS.get(`${b.source}#${b.imported}`) : undefined;
    if (!n || !b || !allowed || n.arguments.length > 1) return "a plugin";
    if (n.arguments.length === 0) return null;
    const o = unwrapTs(n.arguments[0]);
    if (o.type !== "ObjectExpression") return `the options of ${b.source}`;
    for (const p of o.properties) {
      const key = keyName(p);
      if (key === null) return `an option of ${b.source} written in code`;
      const v = unwrapTs(p.value);
      if (!allowed.has(key)) return `the option ${key} of ${b.source}`;
      if (key === "babel") { const sub = babelOff(v); if (sub !== null) return `the option babel${sub} of ${b.source}`; }
      else if (!optionOk(b.source, key, v)) return `the option ${key} of ${b.source}`;
    }
    return null;
  };
  // The function form's `mode`, usable only in the development gate: `mode === "development" && <plugin>`.
  const devTest = (raw: Node): boolean => {
    const n = unwrapTs(raw);
    return n.type === "BinaryExpression" && (n.operator === "===" || n.operator === "==") && param(n.left, "mode") && n.right.type === "StringLiteral" && n.right.value === "development";
  };
  const tagger = (raw: Node): boolean => { const n = unwrapTs(raw); return n.type === "CallExpression" && bound(n.callee, new Set([TAGGER]), "componentTagger") && n.arguments.every(literal); };
  /** Why an entry of plugins is not one the wizard checks, or null: a plugin, the tagger behind Lovable's development
   * gate, or a plugin behind the development gate or a command test. */
  const entryOff = (raw: Node | null): string | null => {
    const n = raw && unwrapTs(raw);
    if (n?.type === "LogicalExpression" && n.operator === "&&") {
      if (devTest(n.left) && tagger(n.right)) return null;
      if (devTest(n.left) || commandTest(n.left)) return pluginOff(n.right);
    }
    return pluginOff(n);
  };
  // [ … ] or [ … ].filter(Boolean).
  const pluginList = (raw: Node): Array<Node | null> | null => {
    const v = unwrapTs(raw);
    if (v.type === "ArrayExpression") return v.elements;
    if (v.type !== "CallExpression" || v.callee.type !== "MemberExpression" || v.callee.computed || v.callee.property?.name !== "filter" || v.arguments.length !== 1 || v.arguments[0].type !== "Identifier" || v.arguments[0].name !== "Boolean" || bindings.has("Boolean")) return null;
    const list = unwrapTs(v.callee.object);
    return list.type === "ArrayExpression" ? list.elements : null;
  };
  const stringify = (raw: Node): boolean => { const n = unwrapTs(raw); return n.type === "CallExpression" && n.callee.type === "MemberExpression" && !n.callee.computed && n.callee.object.type === "Identifier" && n.callee.object.name === "JSON" && !bindings.has("JSON") && n.callee.property?.name === "stringify" && n.arguments.length === 1; };
  const jsonLiteral = (raw: Node): boolean => stringify(raw) && literal(unwrapTs(raw).arguments[0]);
  // JSON.stringify(pkg.<name>): one field of package.json.
  const jsonPackage = (raw: Node): boolean => {
    if (!stringify(raw)) return false;
    const a = unwrapTs(unwrapTs(raw).arguments[0]);
    return a.type === "MemberExpression" && !a.computed && a.property.type === "Identifier" && bound(a.object, new Set([PACKAGE_JSON]), "default");
  };
  const vitePrefix = (raw: Node): boolean => { const n = unwrapTs(raw); return n.type === "StringLiteral" && n.value.startsWith("VITE_"); };
  /** Why the css setting is not one the wizard checks, or null: css.postcss names a PostCSS config of its own;
   * Less's javascriptEnabled runs JavaScript written in a stylesheet; additionalData adds a stylesheet that may load code. */
  const cssOff = (n: Node): string | null => {
    if (n.type === "ObjectExpression" && n.properties.some((q: Node) => (q.key?.name ?? q.key?.value) === "postcss")) return "the setting css.postcss";
    let off: string | null = null;
    walk(n, (m) => {
      if (off || m.type !== "ObjectProperty") return;
      const key = m.computed ? null : (m.key?.name ?? m.key?.value);
      const v = unwrapTs(m.value);
      if (key === "javascriptEnabled" && !(v.type === "BooleanLiteral" && v.value === false)) off = "Less's javascriptEnabled in the setting css";
      else if (key === "additionalData" && (v.type === "StringLiteral" ? STYLE_CODE.test(v.value) : v.type === "TemplateLiteral" && v.quasis.some((q: Node) => STYLE_CODE.test(q.value.cooked ?? q.value.raw)))) off = "a stylesheet that loads code in the setting css";
    });
    return off ?? (setting(n) ? null : "the setting css");
  };

  for (const s of ast.program.body) {
    if (s.type === "ImportDeclaration") {
      if (s.importKind === "type") continue;
      if (!ALLOWED_IMPORTS.has(s.source.value)) return { what: `the import of ${s.source.value}`, at: s };
      // The tagger only in a build whose mode is production.
      const mode = s.source.value === TAGGER ? modes.find((m) => m !== "production") : undefined;
      if (mode) return { what: `lovable-tagger with the build mode ${mode}`, at: s };
      for (const sp of s.specifiers) {
        const imported = sp.type === "ImportDefaultSpecifier" ? "default" : sp.type === "ImportNamespaceSpecifier" ? "*" : (sp.imported.name ?? sp.imported.value);
        // Only the tagger itself, and only package.json's default export.
        if ((s.source.value === TAGGER && (imported !== "componentTagger" || sp.local.name !== "componentTagger")) || (s.source.value === PACKAGE_JSON && imported !== "default")) return { what: `the import of ${s.source.value}`, at: s };
        bindings.set(sp.local.name, { source: s.source.value, imported });
      }
      continue;
    }
    if (s.type === "ExportDefaultDeclaration" || (s.type === "ExpressionStatement" && s.expression.type === "AssignmentExpression" && isModuleExports(s.expression.left))) {
      if (exported) return { what: "a second export", at: s };
      exported = s.type === "ExportDefaultDeclaration" ? s.declaration : s.expression.right;
      continue;
    }
    // const __dirname = dirname(fileURLToPath(import.meta.url)), and __filename likewise.
    const d = s.type === "VariableDeclaration" && s.kind === "const" && s.declarations.length === 1 ? s.declarations[0] : null;
    if (d?.id.type === "Identifier" && dirs.has(d.id.name) && d.init && (pathCall(d.init) || fileUrl(d.init))) continue;
    return { what: "code besides the imports and the export", at: s };
  }
  if (!exported) return { what: "no default export", at: ast.program };
  let e: Node = unwrapTs(exported);
  if (e.type === "CallExpression") {
    // defineConfig from vite or vitest/config, also through a namespace import (vite.defineConfig).
    const viteDefine = bound(e.callee, VITE_SOURCES, "defineConfig") || (e.callee.type === "MemberExpression" && !e.callee.computed && e.callee.property?.name === "defineConfig" && bound(e.callee.object, VITE_SOURCES, "*"));
    if (!viteDefine || e.arguments.length !== 1) return { what: "a config that is not Vite's defineConfig({ … })", at: e };
    e = unwrapTs(e.arguments[0]);
  }
  if (FUNCTIONS.has(e.type)) {
    // A config function, with or without defineConfig: no parameter, or a pattern of mode and command (any other name
    // would shadow an import or a global the checks rely on: react, JSON, __dirname); its body only returns the config.
    const [first, ...more] = e.params as Node[];
    const names = first?.type === "ObjectPattern" && first.properties.every((q: Node) => q.type === "ObjectProperty" && q.shorthand && !q.computed && q.value.type === "Identifier" && (q.value.name === "mode" || q.value.name === "command")) ? first.properties.map((q: Node) => q.value.name as string) : null;
    if (e.async || e.generator || more.length || (first && (!names || new Set(names).size !== names.length))) return { what: "a config function with parameters other than { mode, command }", at: e };
    for (const name of names ?? []) params.add(name);
    const only = e.body.type === "BlockStatement" ? (e.body.body.length === 1 && e.body.body[0].type === "ReturnStatement" ? e.body.body[0].argument : null) : e.body;
    if (!only) return { what: "a config function that does more than return its config", at: e };
    e = unwrapTs(only);
  }
  if (e.type !== "ObjectExpression") return { what: "a config that is not one object", at: e };
  for (const p of e.properties) {
    const key = keyName(p);
    if (key === null) return { what: "a setting written in code", at: p };
    const v: Node = unwrapTs(p.value);
    if (key === "plugins") {
      const list = pluginList(v);
      if (!list) return { what: "the setting plugins", at: p };
      for (const x of list) { const why = entryOff(x); if (why) return { what: why, at: x ?? v }; }
    }
    else if (key === "envPrefix") { if (!(vitePrefix(v) || (v.type === "ArrayExpression" && v.elements.length > 0 && v.elements.every((x: Node | null) => x !== null && vitePrefix(x))))) return { what: "an envPrefix other than VITE_ prefixes", at: p }; }
    else if (key === "define") { if (v.type !== "ObjectExpression" || !v.properties.every((q: Node) => keyed(q) && (literal(q.value) || jsonLiteral(q.value) || jsonPackage(q.value)))) return { what: "a define value that is not a literal", at: p }; }
    // envDir moves the .env files Vite reads, and a mode makes it read .env.<mode> and .env.<mode>.local, which the
    // build-file checks read only for production and a --mode on the build command.
    else if (key === "envDir") return { what: "the setting envDir", at: p };
    else if (key === "mode") { if (literalString(v) !== "production") return { what: "the setting mode", at: p }; }
    else if (key === "css") { const why = cssOff(v); if (why) return { what: why, at: p }; }
    else if (DEV_KEYS.has(key)) { if (!devSetting(v, [])) return { what: `the setting ${key}`, at: p }; }
    // The Cloudflare plugin writes each Worker's local variables beside its output; environments could put that output
    // inside the client's.
    else if (key === "environments" && [...bindings.values()].some((b) => b.source === CLOUDFLARE_PLUGIN)) return { what: `the setting environments beside ${CLOUDFLARE_PLUGIN}`, at: p };
    else if (!setting(v)) return { what: `the setting ${key}`, at: p };
  }
  return null;
}

/** The exposure of a config the wizard parsed and followed to its objects: the precise reasons first, then what lies
 * outside the config (`outside`: the build, the files it reads), then the allowlist. `modes`: the build's modes. */
export function configExposure(file: string, ast: Ast, objects: Node[], follow: (id: Node) => Node | null, envPrefix: string[] | null, modes: string[], outside: SecretExposure | null): SecretExposure | null {
  const envNames = envBindings(ast);
  const precise = prefixExposure(file, envPrefix) ?? defineExposure(file, objects, follow, envNames) ?? loadEnvExposure(file, ast) ?? envPluginExposure(file, ast) ?? mentionExposure(file, ast);
  if (precise || outside) return precise ?? outside;
  const off = unchecked(ast, modes);
  return off ? { why: `${file} uses ${off.what} (line ${lineOf(off.at)}), which the wizard does not check, so it cannot prove that Vite keeps the secret key out of the browser code.`, fix: BY_HAND, byHand: true } : null;
}

/** Whether Vite would put PARLOX_SECRET_KEY into the browser build through envPrefix: an empty prefix, a prefix the
 * name starts with, or a prefix the wizard cannot read. */
export const exposesSecret = (prefixes: string[] | null): boolean =>
  prefixes === null || prefixes.some((p) => SECRET.startsWith(p));
