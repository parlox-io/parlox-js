import { posix } from "node:path";
import { parse as parseYaml } from "yaml";

// What runs, or changes the code that runs, when a Vite app's dependencies are installed, before its build: the
// install scripts of the app and of every package of its workspace, the package managers' own files, and where the
// packages the guard trusts by name come from. On Vercel the install runs with the project's variables, the secret key
// among them, so any code that runs there could write it into a file the build then reads. Each is proven safe by a
// short allowlist, never by a search for what is wrong; a file that exists but cannot be read is not proven safe.
// Only reads, through the reader it is given; vite-exposure.ts words the reasons.

export interface InstallReader {
  read: (rel: string) => string | null;
  exists: (rel: string) => boolean;
  /** The names in a folder, a folder's with "/" after it; null when it cannot be listed. */
  list: (rel: string) => string[] | null;
  /** What is at a path, a link never followed (lstat): null when nothing is there. Without it, nothing is known. */
  kind?: (rel: string) => PathKind | null;
}
export type PathKind = "file" | "dir" | "link" | "other";

/** Not proven safe: what was found, as the start of a sentence, and the same without Vercel's name (`offVercel`). */
export interface InstallOff { what: string; offVercel?: string }

/** A package of the workspace: its folder relative to the app folder, and its name. */
export interface WorkspacePackage { dir: string; name: string | null }
/** Every package of the workspace, or why the wizard could not list them all. */
export interface Packages { list: WorkspacePackage[]; notChecked: string | null }

const at = (folder: string, name: string) => (folder === "." ? name : `${folder}/${name}`);
const lineAt = (text: string, index: number) => text.slice(0, index).split("\n").length;
const plainObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const has = (o: Record<string, unknown>, key: string) => Object.prototype.hasOwnProperty.call(o, key);

// npm's install lifecycle (docs.npmjs.com/cli/using-npm/scripts): the package's own scripts `npm install` runs. pnpm,
// yarn and bun run the same names, and pnpm's pnpm:devPreinstall "Runs before any dependency is installed", set in the
// root project's package.json (pnpm.io/scripts, opened 2026-10-01); the guard counts it in every package.json, which
// only makes the check stricter.
export const INSTALL_SCRIPTS = ["preinstall", "install", "postinstall", "prepublish", "preprepare", "prepare", "postprepare", "dependencies", "pnpm:devPreinstall"];
// husky's `prepare` only points git at its hooks folder.
export const HUSKY = /^husky(?: install)?$/;

// Install commands that do what Vercel's own install does (install the lockfile's packages, which run their own
// scripts either way), and two that run fixed tools of their own: patch-package applies the patches in patches/, and
// `prisma generate` writes Prisma's client from the schema. Exact words only: anything chained, or another flag, is not
// on the list.
const INSTALLS = /^(?:npm (?:ci|install)|(?:pnpm|yarn|bun) install(?: --frozen-lockfile)?|yarn install --immutable)$/;
const PATCH_PACKAGE = "patch-package";
const PRISMA_GENERATE = "prisma generate";
const words = (command: string) => command.trim().replace(/\s+/g, " ");

/** Whether `command` is on the list of known-harmless install commands (the checks of its own aside). */
export const harmlessInstall = (command: string): boolean => {
  const c = words(command);
  return INSTALLS.test(c) || c === PATCH_PACKAGE || c === PRISMA_GENERATE;
};

/** The package names in a patch-package file name: `name+1.0.0.patch`, `@scope+name+1.0.0.patch`, and a nested one
 * `parent++child+1.0.0.patch` (patch-package's own scheme). */
function patchedNames(file: string): string[] {
  return file.replace(/\.patch$/, "").split("++").map((part) => {
    const bits = part.split("+");
    return bits[0].startsWith("@") ? `${bits[0]}/${bits[1] ?? ""}` : bits[0];
  });
}

/** Why a patches folder is not proven safe for patch-package: a patch of a package the guard trusts by name, or a
 * folder that cannot be listed. At most 2000 entries are looked at. */
function patchesOff(f: InstallReader, folder: string, trusted: (name: string) => boolean): string | null {
  const dir = at(folder, "patches");
  if (!f.exists(dir)) return null;
  const queue = [dir];
  let seen = 0;
  while (queue.length) {
    const d = queue.shift()!;
    const names = f.list(d);
    if (names === null) return `${d} cannot be listed, and patch-package applies the patches in it`;
    for (const name of names) {
      if (++seen > 2000) return `${dir} holds more than 2000 entries, more than the wizard reads`;
      if (name.endsWith("/")) { queue.push(at(d, name.slice(0, -1))); continue; }
      if (!name.endsWith(".patch")) continue;
      const touched = patchedNames(name).find(trusted);
      if (touched) return `${at(d, name)} changes ${touched}, which the build runs`;
    }
  }
  return null;
}

// Prisma's generators: "A generator determines which assets are created when you run the `prisma generate` command";
// prisma-client and prisma-client-js are Prisma's own, and "you can configure any npm package that complies with our
// generator specification" (prisma.io/docs/orm/prisma-schema/overview/generators, opened 2026-10-01): another provider
// is code of the app's choosing.
const PRISMA_PROVIDERS = new Set(["prisma-client-js", "prisma-client"]);
const PRISMA_CONFIGS = ["ts", "mts", "cts", "js", "mjs", "cjs"].map((e) => `prisma.config.${e}`);

/** Why `prisma generate` in `folder` is not proven safe: a prisma.config file (code prisma runs), a schema somewhere
 * the wizard does not look (package.json's "prisma" field), a schema it cannot read, or a generator whose provider is
 * not Prisma's own. */
function prismaOff(f: InstallReader, folder: string): string | null {
  const config = PRISMA_CONFIGS.find((c) => f.exists(at(folder, c)));
  if (config) return `${at(folder, config)} is code prisma runs`;
  let pkg: unknown = null;
  try { pkg = JSON.parse((f.read(at(folder, "package.json")) ?? "null").replace(/^﻿/, "")); } catch { /* read as absent: the scripts came from it */ }
  if (plainObject(pkg) && pkg.prisma !== undefined) return `${at(folder, "package.json")}'s "prisma" field sets where prisma reads its settings, which the wizard does not follow`;
  const schemas: string[] = [];
  for (const rel of [at(folder, "prisma/schema.prisma"), at(folder, "schema.prisma")]) if (f.exists(rel)) schemas.push(rel);
  const multi = at(folder, "prisma/schema");
  if (f.exists(multi)) {
    const names = f.list(multi);
    if (names === null) return `${multi} cannot be listed, and prisma reads the schema files in it`;
    for (const name of names) if (name.endsWith(".prisma")) schemas.push(at(multi, name));
  }
  for (const rel of schemas) {
    const text = f.read(rel);
    if (text === null) return `${rel} exists, but the wizard cannot read it, and prisma generate reads it`;
    for (const m of text.matchAll(/^[ \t]*generator\s+\w+\s*\{([^}]*)\}/gm)) {
      const p = /^[ \t]*provider\s*=\s*(?:"([^"\n]*)"|(\S+))/m.exec(m[1]);
      const provider = p ? p[1] ?? p[2] : null;
      if (provider === null || !PRISMA_PROVIDERS.has(provider)) {
        const where = m.index! + m[0].indexOf(m[1]) + (p?.index ?? 0) + (p ? p[0].search(/\S/) : 0);
        return `${rel} names the generator provider ${provider === null ? "(none)" : JSON.stringify(provider)} (line ${lineAt(text, where)}), which runs code the wizard does not check`;
      }
    }
  }
  return null;
}

/** Why a known-harmless install command is not proven safe after all (patch-package's patches, prisma's generators),
 * or null. `folder`: where it runs. */
export function harmlessInstallOff(command: string, folder: string, f: InstallReader, trusted: (name: string) => boolean): string | null {
  const c = words(command);
  if (c === PATCH_PACKAGE) return patchesOff(f, folder, trusted);
  if (c === PRISMA_GENERATE) return prismaOff(f, folder);
  return null;
}

/** The first install script of a package.json in `folder` that is not proven safe, worded for the reason, or null. */
export function installScriptsOff(f: InstallReader, folder: string, scripts: Record<string, unknown>, trusted: (name: string) => boolean): InstallOff | null {
  const pkg = at(folder, "package.json");
  for (const name of INSTALL_SCRIPTS) {
    if (!has(scripts, name)) continue;
    const command = scripts[name];
    if (typeof command === "string" && name === "prepare" && HUSKY.test(command.trim())) continue;
    if (typeof command === "string" && harmlessInstall(command)) {
      const off = harmlessInstallOff(command, folder, f, trusted);
      if (off) return { what: `${pkg}'s "${name}" script runs ${words(command)}, and ${off}` };
      continue;
    }
    const script = `${pkg} has a "${name}" script, which runs when`;
    return { what: `${script} Vercel installs the dependencies, and the wizard does not check it`, offVercel: `${script} the dependencies are installed, and the wizard does not check it` };
  }
  return null;
}

// node-options (npm's .npmrc, pnpm's nodeOptions) is passed to every Node.js process the package manager starts for a
// script; a flag that loads code (--require, --import, --loader) would run it in the install and in the build. Only
// these flags, which change memory and warnings, are allowed.
const NODE_FLAG = /^(?:--(?:max[-_]old[-_]space[-_]size|max[-_]semi[-_]space[-_]size|stack[-_]size)=\d+|--no-warnings|--no-deprecation|--trace-warnings|--trace-deprecation|--enable-source-maps)$/;
const nodeOptionsOff = (value: string) => value.trim() !== "" && !value.trim().split(/\s+/).every((flag) => NODE_FLAG.test(flag));
const unquote = (v: string) => v.trim().replace(/^(["'])(.*)\1$/, "$2");

/** What in an .npmrc (npm's, pnpm's and yarn classic's settings file) runs code: node-options with a flag that loads
 * code, script-shell, a pnpmfile, npm's onload-script. */
function npmrcOff(rel: string, text: string): string | null {
  for (const raw of text.split(/\r\n|\n|\r/)) {
    const line = raw.trim();
    if (!line || line.startsWith(";") || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim().toLowerCase().replace(/_/g, "-");
    const value = unquote(line.slice(eq + 1));
    if (key === "node-options" && nodeOptionsOff(value)) return `${rel} sets node-options to ${JSON.stringify(value)}, which the wizard does not check, and npm passes it to every script of the install and the build`;
    if (key === "script-shell") return `${rel} sets script-shell, the program that runs every script of the install and the build`;
    if (key === "pnpmfile" || key === "global-pnpmfile") return `${rel} sets ${key}, a file of code pnpm runs when it installs`;
    if (key === "onload-script") return `${rel} sets onload-script, code npm runs when it starts`;
  }
  return null;
}

/** A YAML file's top-level object, null when it is absent, or "unreadable". */
function yamlFile(f: InstallReader, rel: string): Record<string, unknown> | null | "unreadable" {
  if (!f.exists(rel)) return null;
  const text = f.read(rel);
  if (text === null) return "unreadable";
  try {
    const v = parseYaml(text);
    return v === null || v === undefined ? {} : plainObject(v) ? v : "unreadable";
  } catch { return "unreadable"; }
}
const unreadable = (rel: string) => `${rel} exists, but the wizard cannot read it, and the package manager reads it when it installs`;

// Yarn 2 and later run the release file .yarnrc.yml's yarnPath names in place of the yarn installed on the machine.
// `yarn set version` saves the release as .yarn/releases/yarn-<version>.cjs in the project folder and writes yarnPath
// as that path, relative to the project folder, into the .yarnrc.yml there (@yarnpkg/plugin-essentials 4.6.2,
// lib/commands/set/version.js:180-181 and :202-204); Yarn's docs ask projects to keep .yarn/releases in git ("You will
// want to keep them versioned", yarnpkg.com/getting-started/qa, opened 2026-10-01). There it is Yarn itself: the guard
// allows exactly that path, when the file is there, a file and not a link, in folders that are not links. It does not
// read the file, so the report says it was trusted by where it is (yarnReleaseNote).
const YARN_RELEASE = /^\.yarn\/releases\/yarn-\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?\.cjs$/;
/** The report's line for a Yarn release file the guard trusted by its location (`path`, from the app folder). */
export const yarnReleaseNote = (path: string): string => `Yarn's own release file (${path}) runs at install; the wizard trusted it by its standard location, not by reading it.`;

/** Why .yarnrc.yml's yarnPath (in `folder`) is not proven safe, or the release file it names (from the app folder). */
function yarnPathOf(f: InstallReader, folder: string, value: unknown): { off: string } | { release: string } {
  const shown = typeof value === "string" ? value : JSON.stringify(value);
  if (typeof value !== "string" || !YARN_RELEASE.test(value)) return { off: `${shown} is not where \`yarn set version\` puts Yarn's own release (.yarn/releases/yarn-<version>.cjs)` };
  const path = at(folder, value);
  if (!f.kind) return { off: `the wizard cannot check that ${path} is a file in the repository` };
  for (const dir of [at(folder, ".yarn"), at(folder, ".yarn/releases")]) {
    const k = f.kind(dir);
    if (k === "link") return { off: `${dir} is a link` };
    if (k !== "dir") return { off: `${path} is not there` };
  }
  const k = f.kind(path);
  if (k === null) return { off: `${path} is not there` };
  if (k === "link") return { off: `${path} is a link` };
  if (k !== "file") return { off: `${path} is not a file` };
  return { release: path };
}

/** What the package managers' own files in `folders` (the app folder up to the top of its repository) run when they
 * install: .npmrc's node-options, script-shell and pnpmfile; pnpm-workspace.yaml's settings of the same; a
 * .pnpmfile; .yarnrc.yml's yarnPath (but Yarn's own release, see yarnPathOf) and plugins; yarn classic's yarn-path;
 * bunfig.toml's preload. `yarnReleases`: the Yarn release files allowed, for the report. */
export function installConfigOff(f: InstallReader, folders: string[]): { off: InstallOff | null; yarnReleases: string[] } {
  const yarnReleases: string[] = [];
  const off = (what: string) => ({ off: { what }, yarnReleases });
  for (const folder of folders) {
    const npmrc = at(folder, ".npmrc");
    if (f.exists(npmrc)) {
      const text = f.read(npmrc);
      if (text === null) return off(unreadable(npmrc));
      const why = npmrcOff(npmrc, text);
      if (why) return off(why);
    }
    for (const name of [".pnpmfile.cjs", ".pnpmfile.mjs"]) if (f.exists(at(folder, name))) return off(`${at(folder, name)} exists, and pnpm runs it when it installs`);
    const pnpm = at(folder, "pnpm-workspace.yaml");
    const ws = yamlFile(f, pnpm);
    if (ws === "unreadable") return off(unreadable(pnpm));
    if (ws) {
      for (const key of ["pnpmfile", "globalPnpmfile"]) if (ws[key] !== undefined && ws[key] !== null) return off(`${pnpm} sets ${key}, a file of code pnpm runs when it installs`);
      if (ws.scriptShell !== undefined && ws.scriptShell !== null) return off(`${pnpm} sets scriptShell, the program that runs every script of the install and the build`);
      if (ws.nodeOptions !== undefined && ws.nodeOptions !== null && (typeof ws.nodeOptions !== "string" || nodeOptionsOff(ws.nodeOptions))) return off(`${pnpm} sets nodeOptions to ${JSON.stringify(ws.nodeOptions)}, which the wizard does not check, and pnpm passes it to every script of the install and the build`);
    }
    const berry = at(folder, ".yarnrc.yml");
    const yarnrc = yamlFile(f, berry);
    if (yarnrc === "unreadable") return off(unreadable(berry));
    if (yarnrc) {
      if (yarnrc.yarnPath !== undefined && yarnrc.yarnPath !== null) {
        const yarn = yarnPathOf(f, folder, yarnrc.yarnPath);
        if ("off" in yarn) return off(`${berry} sets yarnPath, a file Yarn runs in its own place when it installs, and ${yarn.off}`);
        if (!yarnReleases.includes(yarn.release)) yarnReleases.push(yarn.release);
      }
      if (Array.isArray(yarnrc.plugins) ? yarnrc.plugins.length > 0 : yarnrc.plugins !== undefined && yarnrc.plugins !== null) return off(`${berry} sets plugins, code Yarn loads when it installs`);
    }
    const classic = at(folder, ".yarnrc");
    if (f.exists(classic)) {
      const text = f.read(classic);
      if (text === null) return off(unreadable(classic));
      if (/^[ \t]*["']?(?:yarn-path|--yarn-path)["']?[ \t=]/m.test(text)) return off(`${classic} sets yarn-path, a file Yarn runs in its own place when it installs`);
    }
    const bunfig = at(folder, "bunfig.toml");
    if (f.exists(bunfig)) {
      const text = f.read(bunfig);
      if (text === null) return off(unreadable(bunfig));
      const m = /(?:^|[{,.])[ \t]*["']?preload["']?[ \t]*=/m.exec(text);
      if (m) return off(`${bunfig} sets preload (line ${lineAt(text, m.index + m[0].search(/p/))}), code Bun runs before the scripts it runs`);
    }
  }
  return { off: null, yarnReleases };
}

// What a package.json declares, and where it may be changed: dependency sections, then the package managers'
// overrides (npm's overrides, yarn's resolutions, pnpm's overrides, patchedDependencies and packageExtensions, bun's
// overrides and patchedDependencies).
const DEP_FIELDS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];
const OVERRIDE_FIELDS: Array<[string, (pkg: Record<string, any>) => unknown]> = [
  ["overrides", (p) => p.overrides],
  ["resolutions", (p) => p.resolutions],
  ["pnpm.overrides", (p) => p.pnpm?.overrides],
  ["pnpm.patchedDependencies", (p) => p.pnpm?.patchedDependencies],
  ["pnpm.packageExtensions", (p) => p.pnpm?.packageExtensions],
  ["patchedDependencies", (p) => p.patchedDependencies],
];
// Where the version is a path, not a version (patches), or an object of dependencies (extensions).
const PATH_VALUES = new Set(["pnpm.patchedDependencies", "patchedDependencies"]);

/** Whether a dependency's version names a version from the npm registry: a version, a range or a dist-tag; `npm:` with
 * the same name. Not: a folder (file:, link:, portal:, a path), a workspace package, git, a URL, patch:, or another
 * package under this name. */
function registry(name: string, spec: string): boolean {
  const s = spec.trim();
  const npm = /^npm:(.*)$/.exec(s);
  if (npm) {
    // npm:<name>, npm:<name>@<version> (npm's alias), or npm:<range> (Yarn's own way of writing a range).
    const rest = npm[1];
    if (rest === name) return true;
    if (rest.startsWith(`${name}@`)) return registry(name, rest.slice(name.length + 1));
    return /^[\d^~<>=*]/.test(rest) && registry(name, rest);
  }
  return s === "" || (/^[\w\s.*^~<>=|+-]+$/.test(s) && !s.startsWith("."));
}

/** The names an override key names: `vite`, `vite@8`, `parent>vite` (pnpm), `**\/vite` and `parent/vite` (yarn). */
function namesIn(key: string): string[] {
  const out: string[] = [];
  for (const part of key.split(">")) {
    const segs = part.replace(/^\*\*\//, "").split("/");
    for (let i = 0; i < segs.length; i++) {
      let s = segs[i];
      if (s === "**" || s === "") continue;
      if (s.startsWith("@") && i + 1 < segs.length) s = `${s}/${segs[++i]}`;
      out.push(s.replace(/^(@?[^@]+)@.*$/, "$1"));
    }
  }
  return out;
}

type Catalogs = { lookup: (name: string, catalog: string) => { spec: string; from: string } | null };
/** pnpm's catalogs (pnpm-workspace.yaml's catalog and catalogs), and bun's (package.json's catalog, catalogs, and the
 * same under workspaces), at the workspace root. */
function catalogsAt(f: InstallReader, root: string): Catalogs {
  const sources: Array<{ from: string; get: (catalog: string) => unknown }> = [];
  const ws = yamlFile(f, at(root, "pnpm-workspace.yaml"));
  if (plainObject(ws)) sources.push({ from: `${at(root, "pnpm-workspace.yaml")}'s catalog`, get: (c) => (c === "default" ? ws.catalog ?? (ws.catalogs as any)?.default : (ws.catalogs as any)?.[c]) });
  let pkg: any = null;
  try { pkg = JSON.parse((f.read(at(root, "package.json")) ?? "null").replace(/^﻿/, "")); } catch { pkg = null; }
  if (plainObject(pkg)) {
    for (const base of [pkg, pkg.workspaces]) if (plainObject(base)) sources.push({ from: `${at(root, "package.json")}'s catalog`, get: (c) => (c === "default" ? base.catalog ?? (base.catalogs as any)?.default : (base.catalogs as any)?.[c]) });
  }
  return {
    lookup(name, catalog) {
      for (const s of sources) {
        const entries = s.get(catalog);
        if (plainObject(entries) && typeof entries[name] === "string") return { spec: entries[name] as string, from: s.from };
      }
      return null;
    },
  };
}

/** The first override in `overrides` (a field of `who`) that is not proven safe: one that patches, extends, removes or
 * re-points a trusted package (patches, package extensions, pnpm's "-", npm's "$name"), or replaces any package with
 * something other than a version from the npm registry. An override (npm's overrides, yarn's resolutions, pnpm's
 * overrides) that pins a package, trusted or not, to a registry version or range is allowed: it is still the npm
 * package of that name, as when the package.json declares that version itself. `parent`: the package an npm override's
 * "." key sets the version of. */
function overridesOff(who: string, field: string, overrides: unknown, trusted: (name: string) => boolean, parent = "x"): string | null {
  if (!plainObject(overrides)) return null;
  const changed = (name: string) => `${who}'s ${field} change ${name}, which the build runs`;
  for (const [key, value] of Object.entries(overrides)) {
    const names = key === "." ? [parent] : namesIn(key);
    // The package the override replaces: the last name of a selector (pnpm's parent>child, yarn's parent/child).
    const target = names[names.length - 1] ?? key;
    const touched = names.find(trusted);
    // Patches and package extensions change the code of what they name: never proven safe for a trusted package.
    if (touched && (PATH_VALUES.has(field) || field.endsWith("packageExtensions"))) return changed(touched);
    if (PATH_VALUES.has(field)) continue;
    if (field.endsWith("packageExtensions")) {
      for (const deps of plainObject(value) ? Object.values(value) : []) {
        if (!plainObject(deps)) continue;
        for (const [dep, spec] of Object.entries(deps)) {
          if (trusted(dep)) return changed(dep);
          if (typeof spec === "string" && !registry(dep, spec)) return `${who}'s ${field} add ${dep} as ${JSON.stringify(spec)}, not a version from the npm registry`;
        }
      }
      continue;
    }
    if (plainObject(value)) {
      const inner = overridesOff(who, field, value, trusted, target);
      if (inner) return inner;
      continue;
    }
    if (typeof value !== "string") continue;
    // "$name" takes the root's own version of that dependency (npm); "-" removes it (pnpm). Neither is a version the
    // wizard reads here: allowed for other packages, as before, not for a trusted one.
    if (value.startsWith("$") || value === "-") {
      if (touched) return changed(touched);
      continue;
    }
    if (!registry(target, value)) return `${who}'s ${field} replace ${key === "." ? parent : key} with ${JSON.stringify(value)}, not a version from the npm registry`;
  }
  return null;
}

/** Where the packages the guard trusts by name come from (`trusted`), in every package.json of `folders` (the app,
 * the workspace root and every package of the workspace) and in the root's pnpm-workspace.yaml: each must be a
 * version from the npm registry (catalog entries read where pnpm and bun keep them), an override may pin one only to
 * a registry version, nothing may patch or extend one, nothing may replace any package with local code, and no
 * workspace package may carry one's name. */
export function provenanceOff(f: InstallReader, folders: string[], root: string, packages: Packages, trusted: (name: string) => boolean): InstallOff | null {
  const catalogs = catalogsAt(f, root);
  for (const folder of folders) {
    const rel = at(folder, "package.json");
    let pkg: unknown;
    try { pkg = JSON.parse((f.read(rel) ?? "null").replace(/^﻿/, "")); } catch { continue; }
    if (!plainObject(pkg)) continue;
    for (const field of DEP_FIELDS) {
      const deps = pkg[field];
      if (!plainObject(deps)) continue;
      for (const [name, spec] of Object.entries(deps)) {
        if (!trusted(name) || typeof spec !== "string") continue;
        const catalog = /^catalog:(.*)$/.exec(spec.trim());
        if (catalog) {
          const found = catalogs.lookup(name, catalog[1] || "default");
          if (!found) return { what: `${rel} declares ${name} as ${JSON.stringify(spec)}, and the wizard finds no such catalog entry` };
          if (!registry(name, found.spec)) return { what: `${rel} declares ${name} as ${JSON.stringify(spec)}, which ${found.from} gives as ${JSON.stringify(found.spec)}, not a version from the npm registry` };
          continue;
        }
        if (!registry(name, spec)) return { what: `${rel} declares ${name} as ${JSON.stringify(spec)}, not a version from the npm registry, so the build could run other code under that name` };
      }
    }
    for (const [field, get] of OVERRIDE_FIELDS) {
      const off = overridesOff(rel, field, get(pkg as Record<string, any>), trusted);
      if (off) return { what: off };
    }
  }
  const ws = yamlFile(f, at(root, "pnpm-workspace.yaml"));
  if (plainObject(ws)) {
    for (const field of ["overrides", "patchedDependencies", "packageExtensions"]) {
      const off = overridesOff(at(root, "pnpm-workspace.yaml"), field, ws[field], trusted);
      if (off) return { what: off };
    }
  }
  for (const p of packages.list) {
    if (p.name !== null && trusted(p.name)) return { what: `${at(p.dir, "package.json")} is a workspace package named ${p.name}, so the build could run it in the place of the npm package` };
  }
  return null;
}

/** The folders from the app folder (".") up to `top` ("../..", relative to the app folder). */
export function foldersUp(top: string): string[] {
  const out = ["."];
  const steps = top === "." ? 0 : top.split("/").filter((s) => s === "..").length;
  for (let i = 1; i <= steps; i++) out.push(Array(i).fill("..").join("/"));
  return out;
}

/** One part of a workspace glob: a folder name, `*` (any one folder), `**` (any depth), or a name with `*` in it. */
export type GlobSegment = { name: string } | { any: true } | { deep: true } | { re: RegExp };
/** A workspace glob as the parts the walk follows, or null for what the wizard does not expand (braces, ?, [ ], an
 * extglob, a folder above the workspace root). */
export function globSegments(glob: string): GlobSegment[] | null {
  const clean = posix.normalize(glob.replace(/\\/g, "/").replace(/^\.\//, "")).replace(/\/+$/, "");
  if (/[{}?[\]()!+]/.test(clean) || clean.startsWith("../") || clean === "..") return null;
  return clean.split("/").map((s): GlobSegment => (s === "**" ? { deep: true } : s === "*" ? { any: true } : s.includes("*") ? { re: new RegExp(`^${s.replace(/[.^$|\\]/g, "\\$&").replace(/\*/g, "[^/]*")}$`) } : { name: s }));
}
