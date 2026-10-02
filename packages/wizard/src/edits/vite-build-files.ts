import { posix } from "node:path";
import { parse as parseYaml } from "yaml";
import { parseCode, type Ast, type Node } from "./splice.js";
import { isModuleExports, keyName, lineOf, literal, notChecked, unwrapTs, type SecretExposure } from "./vite-exposure.js";
import { sourcesOff, STYLE_PLUGIN_PACKAGES, type SourceContext } from "./vite-sources.js";

// Besides its config, what Vite reads or runs when it builds that could bring PARLOX_SECRET_KEY into the browser code,
// each proven safe by an allowlist, never by a search for what is wrong:
// - the .env files: Vite's loadEnv expands $NAME and ${NAME} in their values from the build's environment, which holds
//   the key on Vercel, before it keeps the VITE_ variables (vitejs/vite packages/vite/src/node/env.ts, opened at 8.3.1);
//   and, when Bun runs the build, the ones Bun loads by itself and expands the same way (envFilesExposure);
// - the PostCSS config, which Vite looks for from its root up to the workspace root (postcss-load-config 6, through
//   lilconfig; Vite passes stopDir: searchForWorkspaceRoot(root)), and whose plugins PostCSS requires by name;
// - Tailwind's config (tailwindcss 3 loads tailwind.config.* from the folder the build runs in);
// - the sources the build can process, and what in them loads code (vite-sources.ts): Tailwind's @plugin and @config,
//   Less's @plugin, Stylus's use(), a component template in another language.
// A file that exists but cannot be read is not proven safe either.

export interface BuildFileReader {
  read: (rel: string) => string | null;
  exists: (rel: string) => boolean;
  /** The names in a folder ("." is the app folder), a folder's with "/" after it; null when it cannot be listed. */
  list: (rel: string) => string[] | null;
}

export interface BuildFileContext extends SourceContext {
  /** Vite's root, relative to the app folder ("." is the folder itself). */
  root: string;
  /** Where PostCSS stops looking up for its config, relative to the app folder ("." or "../.."). */
  postcssTop: string;
  /** The modes the build runs in: production, and a --mode the build command names. */
  modes: string[];
  /** Whether Bun may run the build (vite-vercel.ts, VercelBuild.bun): the .env files it loads are checked too. */
  bun?: boolean;
}

const at = (folder: string, name: string) => (folder === "." ? name : `${folder}/${name}`);
const lineAt = (text: string, index: number) => text.slice(0, index).split("\n").length;
type Off = { what: string; at: Node | null };

// The files Bun reads by itself, "listed in order of increasing precedence": .env; .env.production, .env.development or
// .env.test "depending on the value of NODE_ENV"; .env.local ("not loaded when NODE_ENV=test"); and
// .env.production.local, .env.development.local or .env.test.local. Bun "automatically expands environment variables"
// in them, `$` escaped with a backslash excepted (bun.com/docs/runtime/environment-variables, opened 2026-10-02). The
// NODE_ENV a host gives the build is not visible here, so all of them count. Vite's loadEnv then keeps every variable
// in the environment that starts with its prefix ("check if there are actual env variables starting with VITE_*",
// vitejs/vite packages/vite/src/node/env.ts, opened at 8.3.1).
const BUN_ENV_FILES = [".env", ".env.production", ".env.development", ".env.test", ".env.local", ".env.production.local", ".env.development.local", ".env.test.local"];

/** .env, .env.local, .env.<mode> and .env.<mode>.local in Vite's root (envDir is not allowed by the config check),
 * for every mode the build runs in; when Bun runs the build, also every file Bun loads (BUN_ENV_FILES) in the app
 * folder (Bun's page does not name the folder it reads them from; Vercel runs the build in the app folder). Any $ is
 * not proven safe: telling a $ that dotenv-expand (or Bun) expands from one it leaves would mean following its own
 * parsing (quotes, escapes, multi-line values). */
function envFilesExposure(f: BuildFileReader, root: string, modes: string[], bun: boolean): SecretExposure | null {
  const vite = [...new Set(modes.flatMap((m) => [".env", ".env.local", `.env.${m}`, `.env.${m}.local`]))].map((name) => ({ rel: at(root, name), by: "vite" as const }));
  const byBun = bun ? BUN_ENV_FILES.filter((name) => !vite.some((v) => v.rel === name)).map((rel) => ({ rel, by: "bun" as const })) : [];
  for (const { rel, by } of [...vite, ...byBun]) {
    if (!f.exists(rel)) continue;
    const text = f.read(rel);
    if (text === null) return notChecked(by === "vite" ? `${rel} exists, but the wizard cannot read it, and Vite loads it when it builds` : `${rel} exists, but the wizard cannot read it, and Bun loads it when it runs the build`);
    const dollar = text.indexOf("$");
    if (dollar >= 0) {
      const expands = (holds: string) => by === "vite"
        ? `${rel} has a $ (line ${lineAt(text, dollar)}): Vite expands $NAME in .env values from the build's environment, which holds the secret key ${holds}, before it keeps the VITE_ variables, so the key could reach the browser code.`
        : `${rel} has a $ (line ${lineAt(text, dollar)}): Bun expands $NAME in the .env files it loads, from the build's environment, which holds the secret key ${holds}, and Vite keeps the VITE_ variables it finds there, so the key could reach the browser code.`;
      return { why: expands("on Vercel"), fix: `remove the $ from ${rel}`, offVercel: expands("when the host gives the build its variables") };
    }
  }
  return null;
}

/** The value a JS or TS config file exports, when the file is only imports, at most one const that is the export, and
 * the export. `allowImport` decides which value imports may stay; type-only imports are erased before the file runs.
 * Returns the exported expression and the names the imports bind (local name → package), or what is off. */
function exportedValue(ast: Ast, allowImport: (source: string) => boolean, named: Map<string, Set<string>> = new Map()): { value: Node; imports: Map<string, string> } | Off {
  const imports = new Map<string, string>();
  let declared: { name: string; init: Node } | null = null;
  let exported: Node | null = null;
  for (const s of ast.program.body) {
    if (s.type === "ImportDeclaration") {
      if (s.importKind === "type") continue;
      // `named`: the named imports a file may take from a package (local name → "source#name").
      const names = named.get(s.source.value);
      if (names && s.specifiers.length > 0 && s.specifiers.every((sp: Node) => sp.type === "ImportSpecifier" && (sp.importKind === "type" || names.has(sp.imported.name ?? sp.imported.value)))) {
        for (const sp of s.specifiers) if (sp.importKind !== "type") imports.set(sp.local.name, `${s.source.value}#${sp.imported.name ?? sp.imported.value}`);
        continue;
      }
      if (!allowImport(s.source.value) || s.specifiers.length !== 1 || s.specifiers[0].type !== "ImportDefaultSpecifier") return { what: `the import of ${s.source.value}`, at: s };
      imports.set(s.specifiers[0].local.name, s.source.value);
    } else if (s.type === "VariableDeclaration" && s.kind === "const" && s.declarations.length === 1 && s.declarations[0].id.type === "Identifier" && s.declarations[0].init && !declared) {
      declared = { name: s.declarations[0].id.name, init: s.declarations[0].init };
    } else if (!exported && (s.type === "ExportDefaultDeclaration" || (s.type === "ExpressionStatement" && s.expression.type === "AssignmentExpression" && s.expression.operator === "=" && isModuleExports(s.expression.left)))) {
      exported = s.type === "ExportDefaultDeclaration" ? s.declaration : s.expression.right;
    } else return { what: "code besides the imports and the export", at: s };
  }
  if (!exported) return { what: "no default export", at: null };
  let value = unwrapTs(exported);
  // const config = { … }; export default config: the const is the config, and nothing else.
  if (declared) {
    if (value.type !== "Identifier" || value.name !== declared.name) return { what: "code besides the imports and the export", at: declared.init };
    value = unwrapTs(declared.init);
  }
  return { value, imports };
}

/** A require('<name>') call, with its name, or null. */
const requireOf = (n: Node, imports: Map<string, string>): string | null =>
  n.type === "CallExpression" && n.callee.type === "Identifier" && n.callee.name === "require" && !imports.has("require") && n.arguments.length === 1 && n.arguments[0].type === "StringLiteral" ? n.arguments[0].value : null;

/** A plugin in a list: require('<name>'), require('<name>')(options), an imported name, or an imported name called
 * with options. Its package and its options node (null when none), or null when it is none of these. */
function listedPlugin(raw: Node, imports: Map<string, string>): { name: string; options: Node | null } | null {
  const n = unwrapTs(raw);
  const required = requireOf(n, imports);
  if (required !== null) return { name: required, options: null };
  if (n.type === "Identifier" && imports.has(n.name)) return { name: imports.get(n.name)!, options: null };
  if (n.type !== "CallExpression" || n.arguments.length > 1) return null;
  const callee = unwrapTs(n.callee);
  const name = requireOf(callee, imports) ?? (callee.type === "Identifier" ? imports.get(callee.name) ?? null : null);
  return name === null ? null : { name, options: n.arguments[0] ? unwrapTs(n.arguments[0]) : null };
}

// The PostCSS plugins a config may name, and the options each may take (literal values only; from their published
// types and sources, opened at tailwindcss 3.4.19, @tailwindcss/postcss 4.3.3, autoprefixer 10.6.1, postcss-nesting
// 14.0.2 and postcss-import 17.0.0). Left out: tailwindcss's config (a JavaScript file to load), and postcss-import's
// plugins, resolve, load, filter and nameLayer (code).
const POSTCSS_PLUGINS = new Map<string, Set<string>>([
  ["tailwindcss", new Set()],
  ["@tailwindcss/postcss", new Set(["base", "optimize", "transformAssetUrls"])],
  ["autoprefixer", new Set(["overrideBrowserslist", "browsers", "env", "ignoreUnknownVersions", "stats", "cascade", "add", "remove", "supports", "flexbox", "grid"])],
  ["postcss-nesting", new Set(["edition", "noIsPseudoSelector", "silenceAtNestWarning"])],
  ["postcss-import", new Set(["path", "root", "skipDuplicates", "addModulesDirectories", "warnOnEmpty"])],
]);
/** The packages the build-file checks trust by name (each must come from the npm registry, vite-install.ts): PostCSS
 * and its plugins on the list, the Tailwind plugins, and the stylesheet preprocessors Vite loads. */
export const STYLE_PACKAGES = ["postcss", ...POSTCSS_PLUGINS.keys(), ...STYLE_PLUGIN_PACKAGES, "sass", "sass-embedded", "less", "stylus", "lightningcss"];
export const trustedStylePackage = (name: string): boolean => STYLE_PACKAGES.includes(name) || name.startsWith("@tailwindcss/");
// postcss-load-config's searchPlaces, in its order; package.json counts only when it has a "postcss" field.
const POSTCSS_PLACES = ["package.json", ".postcssrc", ".postcssrc.json", ".postcssrc.yaml", ".postcssrc.yml", ".postcssrc.ts", ".postcssrc.cts", ".postcssrc.mts", ".postcssrc.js", ".postcssrc.cjs", ".postcssrc.mjs", "postcss.config.ts", "postcss.config.cts", "postcss.config.mts", "postcss.config.js", "postcss.config.cjs", "postcss.config.mjs"];
const DATA_PLACES = new Set([".postcssrc", ".postcssrc.json", ".postcssrc.yaml", ".postcssrc.yml"]);

/** Options for a PostCSS plugin given as code: none, true or false, or an object of its own options with literal
 * values. */
// postcss-import resolves @import from these folders besides the stylesheet's own (postcss-import 17.0.0's path, root and
// addModulesDirectories): a folder outside the app could hold a stylesheet the walk never reads, so each must be a
// relative folder inside it.
const FOLDER_OPTIONS = new Set(["path", "root", "addModulesDirectories"]);
const insideFolder = (v: unknown): boolean => {
  if (Array.isArray(v)) return v.every(insideFolder);
  if (typeof v !== "string") return false;
  const p = posix.normalize(v.replace(/\\/g, "/"));
  return !posix.isAbsolute(p) && !/^[A-Za-z]:/.test(p) && p !== ".." && !p.startsWith("../");
};
/** A literal's value, for the folder check: a string, a list of strings, or undefined for anything else. */
const literalValue = (raw: Node): unknown => {
  const n = unwrapTs(raw);
  return n.type === "StringLiteral" ? n.value : n.type === "ArrayExpression" ? n.elements.map((e: Node | null) => (e ? literalValue(e) : undefined)) : undefined;
};
function postcssOptionsOff(name: string, options: Node | null): string | null {
  if (options === null || ((options.type === "BooleanLiteral" || options.type === "NullLiteral"))) return null;
  if (options.type !== "ObjectExpression") return `the options of ${name}`;
  for (const p of options.properties) {
    const key = keyName(p);
    if (key === null || !POSTCSS_PLUGINS.get(name)!.has(key) || !literal(p.value) || (name === "postcss-import" && FOLDER_OPTIONS.has(key) && !insideFolder(literalValue(p.value)))) return `the option ${key ?? "written in code"} of ${name}`;
  }
  return null;
}

/** What is off in a PostCSS config written in JavaScript or TypeScript: a literal object whose only key is plugins,
 * an object of package names or a list of them (required, or imported), each from POSTCSS_PLUGINS. */
function postcssModuleOff(text: string, rel: string): Off | null {
  const ast = parseCode(text, rel);
  if (!ast) return { what: "code the wizard cannot parse", at: null };
  const got = exportedValue(ast, (source) => POSTCSS_PLUGINS.has(source));
  if ("what" in got) return got;
  const { value, imports } = got;
  if (value.type !== "ObjectExpression") return { what: "a config that is not one object", at: value };
  for (const p of value.properties) {
    const key = keyName(p);
    if (key === null) return { what: "a key written in code", at: p };
    if (key !== "plugins") return { what: `the option ${key}`, at: p };
    const plugins = unwrapTs(p.value);
    if (plugins.type === "ObjectExpression") {
      for (const q of plugins.properties) {
        const name = keyName(q);
        if (name === null) return { what: "a key written in code", at: q };
        if (!POSTCSS_PLUGINS.has(name)) return { what: `the plugin ${name}`, at: q };
        const off = postcssOptionsOff(name, unwrapTs(q.value));
        if (off) return { what: off, at: q };
      }
    } else if (plugins.type === "ArrayExpression") {
      for (const e of plugins.elements) {
        const plugin = e && listedPlugin(e, imports);
        if (!plugin) return { what: "a plugin", at: e ?? plugins };
        if (!POSTCSS_PLUGINS.has(plugin.name)) return { what: `the plugin ${plugin.name}`, at: e };
        const off = postcssOptionsOff(plugin.name, plugin.options);
        if (off) return { what: off, at: e };
      }
    } else return { what: "plugins written in code", at: p };
  }
  return null;
}

const plainObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
/** What is off in a PostCSS config given as data (JSON or YAML, or package.json's "postcss" field): an object whose
 * only key is plugins, an object of package names from POSTCSS_PLUGINS with their own options. */
function postcssDataOff(config: unknown): string | null {
  if (!plainObject(config)) return "a config that is not one object";
  for (const [key, plugins] of Object.entries(config)) {
    if (key !== "plugins") return `the option ${key}`;
    if (!plainObject(plugins)) return "plugins that are not an object of package names";
    for (const [name, options] of Object.entries(plugins)) {
      const allowed = POSTCSS_PLUGINS.get(name);
      if (!allowed) return `the plugin ${name}`;
      if (options === true || options === false || options === null) continue;
      if (!plainObject(options)) return `the options of ${name}`;
      const bad = Object.keys(options).find((k) => !allowed.has(k) || (name === "postcss-import" && FOLDER_OPTIONS.has(k) && !insideFolder(options[k])));
      if (bad !== undefined) return `the option ${bad} of ${name}`;
    }
  }
  return null;
}

const postcssOff = (rel: string, what: string, line: number | null) => notChecked(`${rel} uses ${what}${line ? ` (line ${line})` : ""}, which the wizard does not check, and PostCSS runs it when Vite builds`);
/** The PostCSS config Vite would load: from Vite's root up to the workspace root, the first folder that has one (as
 * lilconfig stops there). Every config in that folder is checked, not only the one PostCSS takes first. */
function postcssExposure(f: BuildFileReader, root: string, top: string): SecretExposure | null {
  const folders = [root];
  for (let d = root; d !== top && folders.length < 64;) folders.push(d = posix.normalize(posix.join(d, "..")));
  for (const folder of folders) {
    let found = false;
    for (const place of POSTCSS_PLACES) {
      const rel = at(folder, place);
      if (!f.exists(rel)) continue;
      const text = f.read(rel);
      if (place === "package.json") {
        let pkg: unknown;
        try { pkg = JSON.parse((text ?? "").replace(/^\uFEFF/, "")); } catch { return notChecked(`${rel} exists, but the wizard cannot read it, and PostCSS looks for its config there`); }
        if (!plainObject(pkg) || pkg.postcss == null) continue;
        found = true;
        const off = postcssDataOff(pkg.postcss);
        if (off) return postcssOff(`${rel}'s "postcss" field`, off, null);
        continue;
      }
      found = true;
      if (text === null) return notChecked(`${rel} exists, but the wizard cannot read it, and PostCSS runs it when Vite builds`);
      if (DATA_PLACES.has(place)) {
        let data: unknown;
        try { data = parseYaml(text); } catch { return postcssOff(rel, "text the wizard cannot parse", null); }
        const off = postcssDataOff(data);
        if (off) return postcssOff(rel, off, null);
      } else {
        const off = postcssModuleOff(text, rel);
        if (off) return postcssOff(rel, off.what, off.at ? lineOf(off.at) : null);
      }
    }
    if (found) return null;
  }
  return null;
}

// Tailwind's config: tailwindcss 3 loads it from the folder the build runs in (resolveConfigPath, defaultConfigFiles).
const TAILWIND_CONFIGS = ["js", "cjs", "mjs", "ts", "cts", "mts"].map((e) => `tailwind.config.${e}`);
// The plugins a Tailwind config may name: @tailwindcss/*, and tailwindcss-animate, which Lovable's projects add
// (1.0.7 opened: its only require is tailwindcss/plugin, and it reads no process or env).
const TAILWIND_PLUGIN = /^(?:@tailwindcss\/[a-z0-9][a-z0-9._-]*|tailwindcss-animate)$/;
/** What is off in a Tailwind config: a literal object whose plugins are npm packages from TAILWIND_PLUGIN (required or
 * imported, with literal options at most), and nothing else in it but data. */
function tailwindOff(text: string, rel: string): Off | null {
  const ast = parseCode(text, rel);
  if (!ast) return { what: "code the wizard cannot parse", at: null };
  const got = exportedValue(ast, (source) => TAILWIND_PLUGIN.test(source));
  if ("what" in got) return got;
  const { value, imports } = got;
  if (value.type !== "ObjectExpression") return { what: "a config that is not one object", at: value };
  for (const p of value.properties) {
    const key = keyName(p);
    if (key === null) return { what: "a setting written in code", at: p };
    const v = unwrapTs(p.value);
    if (key !== "plugins") { if (!literal(v)) return { what: `the setting ${key}`, at: p }; continue; }
    if (v.type !== "ArrayExpression") return { what: "the setting plugins", at: p };
    for (const e of v.elements) {
      const plugin = e && listedPlugin(e, imports);
      if (!plugin) return { what: "a plugin", at: e ?? v };
      if (!TAILWIND_PLUGIN.test(plugin.name)) return { what: `the plugin ${plugin.name}`, at: e };
      if (plugin.options && !literal(plugin.options)) return { what: `the options of ${plugin.name}`, at: e };
    }
  }
  return null;
}
function tailwindExposure(f: BuildFileReader, folders: string[]): SecretExposure | null {
  for (const folder of folders) {
    for (const name of TAILWIND_CONFIGS) {
      const rel = at(folder, name);
      if (!f.exists(rel)) continue;
      const text = f.read(rel);
      if (text === null) return notChecked(`${rel} exists, but the wizard cannot read it, and Tailwind runs it when Vite builds`);
      const off = tailwindOff(text, rel);
      if (off) return notChecked(`${rel} uses ${off.what}${off.at ? ` (line ${lineOf(off.at)})` : ""}, which the wizard does not check, and Tailwind runs it when Vite builds`);
    }
  }
  return null;
}

// The Svelte plugin imports svelte.config.js, .ts, .mjs or .mts from Vite's root when Vite builds
// (@sveltejs/vite-plugin-svelte 7.3.1, src/utils/load-svelte-config.js:10-12 and 22-27). It may hold only data, and its
// own vitePreprocess() with boolean options (create-vite 9.2.1's template-svelte writes `export default {}`).
const SVELTE_CONFIGS = ["js", "ts", "mjs", "mts"].map((e) => `svelte.config.${e}`);
const SVELTE_KEYS = new Set(["extensions", "compilerOptions", "preprocess", "vitePlugin"]);
function svelteOff(text: string, rel: string): Off | null {
  const ast = parseCode(text, rel);
  if (!ast) return { what: "code the wizard cannot parse", at: null };
  const got = exportedValue(ast, () => false, new Map([["@sveltejs/vite-plugin-svelte", new Set(["vitePreprocess"])]]));
  if ("what" in got) return got;
  const { value, imports } = got;
  if (value.type !== "ObjectExpression") return { what: "a config that is not one object", at: value };
  const preprocess = (raw: Node | null): boolean => {
    const n = raw && unwrapTs(raw);
    if (n?.type !== "CallExpression" || n.callee.type !== "Identifier" || imports.get(n.callee.name) !== "@sveltejs/vite-plugin-svelte#vitePreprocess" || n.arguments.length > 1) return false;
    const o = n.arguments[0] ? unwrapTs(n.arguments[0]) : null;
    return o === null || (o.type === "ObjectExpression" && o.properties.every((p: Node) => (keyName(p) === "script" || keyName(p) === "style") && unwrapTs(p.value).type === "BooleanLiteral"));
  };
  for (const p of value.properties) {
    const key = keyName(p);
    if (key === null) return { what: "a setting written in code", at: p };
    const v = unwrapTs(p.value);
    const ok = key === "preprocess" ? preprocess(v) || (v.type === "ArrayExpression" && v.elements.every(preprocess)) : SVELTE_KEYS.has(key) && literal(v);
    if (!ok) return { what: `the setting ${key}`, at: p };
  }
  return null;
}
function svelteExposure(f: BuildFileReader, root: string): SecretExposure | null {
  for (const name of SVELTE_CONFIGS) {
    const rel = at(root, name);
    if (!f.exists(rel)) continue;
    const text = f.read(rel);
    if (text === null) return notChecked(`${rel} exists, but the wizard cannot read it, and the Svelte plugin runs it when Vite builds`);
    const off = svelteOff(text, rel);
    if (off) return notChecked(`${rel} uses ${off.what}${off.at ? ` (line ${lineOf(off.at)})` : ""}, which the wizard does not check, and the Svelte plugin runs it when Vite builds`);
  }
  return null;
}

/** Whether what the build reads besides the Vite config could bring PARLOX_SECRET_KEY into the browser code: the .env
 * files, the PostCSS config, Tailwind's config, the Svelte config, and the sources the build can process
 * (vite-sources.ts), in that order. null only when each is proven safe. */
export function buildFilesExposure(f: BuildFileReader, c: BuildFileContext): SecretExposure | null {
  const sources = (): SecretExposure | null => { const off = sourcesOff(f, c); return off ? notChecked(off) : null; };
  return envFilesExposure(f, c.root, c.modes, c.bun === true)
    ?? postcssExposure(f, c.root, c.postcssTop)
    ?? tailwindExposure(f, c.root === "." ? ["."] : [".", c.root])
    ?? svelteExposure(f, c.root)
    ?? sources();
}
