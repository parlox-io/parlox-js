import { posix } from "node:path";
import { tsconfigChain } from "./tsconfig-chain.js";
import { notChecked, type SecretExposure } from "./vite-exposure.js";
import { foldersUp, harmlessInstall, harmlessInstallOff, installConfigOff, installScriptsOff, provenanceOff, type InstallOff, type InstallReader, type Packages, type PathKind } from "./vite-install.js";

// What Vercel's build of a Vite app runs before and around Vite, for the guard in vite-exposure.ts: the install, the
// build command and its npm hooks, the Vercel config files and vercel.json's keys, the project settings `vercel pull`
// saved, and, in a workspace, where Vercel builds. Only reads, through the reader it is given.

// How Vercel builds the app (vercel/vercel, opened at @vercel/static-build 14.0.0 and @vercel/build-utils 14.14.0):
// - the install first: vercel.json's installCommand, else `npm install` (or pnpm's, yarn's, bun's), which runs the
//   package's own install scripts; the Vercel dashboard can set one too, which the wizard sees only as `vercel pull`
//   saved it (ProjectSettings below);
// - then vercel.json's buildCommand, else the first of the "vercel-build", "now-build" and "build" scripts
//   (getScriptName: the first name `in` scripts), run as `<package manager> run <name>`, and npm runs that script's
//   "pre" and "post" scripts with it; else the Vite preset's own `vite build` (frameworks.ts);
// - vercel.json's ignoreCommand runs before both, and its builds key replaces the whole build with other builders.
// Vercel also reads vercel.ts, .mts, .js, .mjs, .cjs and .toml, which the wizard does not read: any of them is a build
// it cannot check. The builds it can vouch for are create-vite's own scripts and the type checks people put before
// them: tsc (with --noEmit, -b, --build or -p <file>), then vite build, with at most these options, each once and
// literal (plainBuild): --mode <name> (it only chooses the .env files, which vite-build-files.ts checks), --outDir
// <folder> and --base <path> (where the output goes and the public path it is served from: neither changes what goes
// into the bundle), and --emptyOutDir.
// vue-tsc (create-vite's vue-ts template: `vue-tsc -b && vite build`) is tsc with Vue's language plugin; it also loads
// the plugins a tsconfig names in vueCompilerOptions.plugins (@vue/language-core 3.3.11, lib/compilerOptions.js:117-131,
// for every file in the extends chain), so a build with it is plain only when none of its tsconfig files names one.
const TSC_STEP = String.raw`(?:vue-)?tsc(?: (?:--noEmit|-b|--build|-p [\w.][\w./-]*))*`;
const VITE_BUILD = new RegExp(String.raw`^(?:${TSC_STEP} && )?vite build((?: \S+)*)$`);
// A mode's name; a folder inside the project (no .. part, not absolute, not the project folder itself); a public path
// (absolute or relative, no .. part). None of them starts like an option.
const MODE_VALUE = /^(?!-)[A-Za-z0-9_.-]+$/;
const OUT_DIR_VALUE = /^(?![-/])(?!\.\/?$)(?!(?:.*\/)?\.\.(?:\/|$))[\w./-]+$/;
const BASE_VALUE = /^(?!-)(?!(?:.*\/)?\.\.(?:\/|$))[\w./-]+$/;
const VALUE_OPTIONS: Record<string, { name: string; value: RegExp }> = {
  "--mode": { name: "mode", value: MODE_VALUE }, "-m": { name: "mode", value: MODE_VALUE },
  "--outDir": { name: "outDir", value: OUT_DIR_VALUE }, "--base": { name: "base", value: BASE_VALUE },
};
/** A plain Vite build (above), and the mode it names; null for anything else: another option, one given twice, a value
 * that is not a literal of its kind (a variable, a quote, a .. part). */
function plainBuild(command: string): { mode: string | null } | null {
  const m = VITE_BUILD.exec(command);
  if (!m) return null;
  const tokens = m[1].split(" ").filter(Boolean);
  const seen = new Set<string>();
  let mode: string | null = null;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === "--emptyOutDir") { if (seen.has(token)) return null; seen.add(token); continue; }
    const eq = token.indexOf("=");
    const option = VALUE_OPTIONS[eq > 0 ? token.slice(0, eq) : token];
    if (!option || seen.has(option.name)) return null;
    seen.add(option.name);
    const value = eq > 0 ? token.slice(eq + 1) : tokens[++i];
    if (value === undefined || !option.value.test(value)) return null;
    if (option.name === "mode") mode = value;
  }
  return { mode };
}
// Only an explicit `run` names a script: `pnpm install` or `yarn add` is the package manager's own command. `bun run`
// prefers the package.json script of that name to a file, and runs its pre and post scripts, as npm does
// (bun.com/docs/cli/run, opened 2026-10-02); a name with no such script is not followed (resolveRuns). Bun also loads
// .env files by itself when it runs (VercelBuild.bun).
const RUN_SCRIPT = /^(npm run(?:-script)?|pnpm run|yarn run|bun run)\s+([\w:.-]+)$/;
const BUILD_SCRIPTS = ["vercel-build", "now-build", "build"];
export const VERCEL_CONFIGS = ["vercel.ts", "vercel.mts", "vercel.js", "vercel.mjs", "vercel.cjs", "vercel.toml"];
const VERCEL_RUNS = ["installCommand", "ignoreCommand", "builds"];
// The vercel.json keys that change nothing about what Vercel's build runs or gives the build (vercel.json's schema,
// openapi.vercel.sh/vercel.json, opened 2026-10-01): routing, headers, the output folder, function regions, images,
// crons (they call functions, after the build), git and CLI settings, and the middleware's own entry (proxy).
// buildCommand is read below; framework only as "vite" (Vercel's Vite preset runs `vite build`) or null. Every other
// key (functions, build.env, env, routes, builds, a key Vercel adds later) is not proven safe.
const VERCEL_KEYS = new Set(["$schema", "buildCommand", "devCommand", "outputDirectory", "cleanUrls", "trailingSlash", "headers", "redirects", "rewrites", "regions", "functionFailoverRegions", "passiveRegions", "images", "crons", "git", "github", "proxy", "framework", "scope", "name", "alias", "version", "fluid", "skipMiddlewareRequestBody"]);
const vercelKeyOff = (vercel: Record<string, unknown>, key: string): boolean => !VERCEL_KEYS.has(key) || (key === "framework" && vercel.framework !== null && vercel.framework !== "vite");
// The install lifecycle scripts, husky's `prepare` and the known-harmless install commands are vite-install.ts's.
const has = (o: Record<string, unknown>, key: string) => Object.prototype.hasOwnProperty.call(o, key);

/** A command with its `npm run X` / `pnpm run X` / `yarn run X` / `bun run X` parts replaced by those scripts, or null
 * when one cannot be. Every script it reaches is added to `reached`, and each runner that runs one ("bun run") to
 * `runners`. */
function resolveRuns(command: string, scripts: Record<string, unknown>, reached: string[], runners: Set<string>, depth = 0): string | null {
  if (depth > 5) return null;
  const parts: string[] = [];
  for (const raw of command.split("&&")) {
    const part = raw.trim().replace(/\s+/g, " ");
    const m = RUN_SCRIPT.exec(part);
    if (!m) { parts.push(part); continue; }
    if (!has(scripts, m[2])) return null;
    reached.push(m[2]);
    runners.add(m[1]);
    const target = scripts[m[2]];
    const inner = typeof target === "string" ? resolveRuns(target, scripts, reached, runners, depth + 1) : null;
    if (inner === null) return null;
    parts.push(inner);
  }
  return parts.join(" && ");
}

/** A JSON file's object: null when there is no such file, "unreadable" when it exists but cannot be read or parsed. */
function jsonFile(read: (rel: string) => string | null, exists: (rel: string) => boolean, rel: string): Record<string, any> | null | "unreadable" {
  if (!exists(rel)) return null;
  try {
    const v = JSON.parse((read(rel) ?? "").replace(/^\uFEFF/, ""));
    return v && typeof v === "object" && !Array.isArray(v) ? v : "unreadable";
  } catch { return "unreadable"; }
}

/** What Vercel's build runs, and the modes it builds in (production, and a --mode it names). `build`: the folder's own
 * build, a plain Vite build ("vite"), none set (Vercel's preset decides: "preset") or another ("other"). `rootBuild`:
 * the root's build when Vercel builds the project at the workspace root, else null. */
export interface VercelBuild {
  exposure: SecretExposure | null; modes: string[]; build?: "vite" | "preset" | "other"; rootBuild?: "vite" | "preset" | "other" | null;
  /** Whether Bun may run the app folder's build, and so load its .env files by itself (vite-build-files.ts): a
   * `bun run` the build command reaches, or the build script (or Vercel's preset) run with the project's package
   * manager when that is Bun (bunProject). */
  bun?: boolean;
  /** The Yarn release files the install runs, allowed by their standard location (vite-install.ts), from the app folder. */
  yarnReleases?: string[];
}

/** Vercel's project settings as the Vercel CLI saves them: `vercel pull` writes .vercel/project.json with `settings`
 * (createdAt, framework, devCommand, installCommand, buildCommand, outputDirectory, rootDirectory, directoryListing,
 * nodeVersion: vercel/vercel packages/cli/src/util/projects/project-settings.ts, writeProjectSettings, opened at
 * c628be7, and the same in the published vercel 62.1.0); `vercel link` alone writes the ids only. The dashboard can
 * change them after the pull, and the Ignored Build Step is not among them. */
export interface ProjectSettings { file: string; rootDirectory: unknown; buildCommand: unknown; installCommand: unknown; framework: unknown }
const SETTINGS = (file: string) => `Vercel's project settings (${file}, saved by \`vercel pull\`)`;
function projectSettings(f: InstallReader, folder: string): ProjectSettings | null | "unreadable" {
  const file = folder === "." ? ".vercel/project.json" : `${folder}/.vercel/project.json`;
  const json = jsonFile(f.read, f.exists, file);
  if (json === "unreadable") return "unreadable";
  const s = json?.settings;
  if (!s || typeof s !== "object" || Array.isArray(s)) return null;
  return { file, rootDirectory: s.rootDirectory, buildCommand: s.buildCommand, installCommand: s.installCommand, framework: s.framework };
}

/** Where Vercel builds a project set up at the workspace root (`workspace.vercel`): in the app folder, when the
 * settings `vercel pull` saved give it as the Root Directory; at the root, when they give none; elsewhere, when they give
 * another folder; and not known without them (a link alone, or a vercel.json). `why` says why a middleware in the app
 * folder would not, or might not, be the project's root middleware (Vercel runs only the one in the folder it builds). */
export type VercelRoot = { builds: "app"; settings: ProjectSettings } | { builds: "root" | "elsewhere" | "unknown"; settings: ProjectSettings | null; why: string };
export function vercelRootOf(read: (rel: string) => string | null, exists: (rel: string) => boolean, workspace: { root: string; vercel: boolean; app?: string } | null): VercelRoot | null {
  if (!workspace?.vercel) return null;
  const f: InstallReader = { read, exists, list: () => null };
  const root = workspace.root;
  const settings = projectSettings(f, root);
  const not = "a middleware in this folder is not the project's root middleware";
  if (settings === "unreadable") return { builds: "unknown", settings: null, why: `${root}/.vercel/project.json exists, but the wizard cannot read it, so it cannot tell where Vercel builds this project: if Vercel builds at the root, ${not}, so Vercel would not run it.` };
  if (!settings) {
    const what = [".vercel/project.json", "vercel.json", ...VERCEL_CONFIGS].map((c) => `${root}/${c}`).find(exists) ?? `${root}/.vercel/project.json`;
    return { builds: "unknown", settings: null, why: `Vercel is set up at the workspace root (${what}), and the wizard cannot tell whether the project's Root Directory is this folder: if Vercel builds at the root, ${not}, so Vercel would not run it. Run \`vercel pull\` at the workspace root (it saves the project's Root Directory in .vercel/project.json), or \`vercel link\` in this folder, then run the wizard again.` };
  }
  const dir = typeof settings.rootDirectory === "string" ? posix.normalize(settings.rootDirectory.replace(/\\/g, "/")).replace(/^\.\//, "").replace(/\/+$/, "") : "";
  if (dir === "" || dir === ".") return { builds: "root", settings, why: `Vercel builds this project at the workspace root (${settings.file}, saved by \`vercel pull\`, gives no Root Directory), so ${not}, and Vercel would not run it. If the project's Root Directory is this folder, run \`vercel pull\` at the workspace root again, or \`vercel link\` in this folder, then run the wizard again.` };
  if (workspace.app !== undefined && dir === workspace.app) return { builds: "app", settings };
  return { builds: "elsewhere", settings, why: `The Vercel project linked at the workspace root builds ${dir} (its Root Directory in ${settings.file}, saved by \`vercel pull\`), not this folder, so a middleware here would not run. Link this folder with \`vercel link\` if it is a project of its own, then run the wizard again.` };
}

/** The project settings `vercel pull` saved that apply to the app folder's build: its own link's, or, when the project
 * is linked at the workspace root with this folder as its Root Directory, the root's. */
export function appSettingsOf(read: (rel: string) => string | null, exists: (rel: string) => boolean, workspace: { root: string; vercel: boolean; app?: string } | null): ProjectSettings | null {
  const own = projectSettings({ read, exists, list: () => null }, ".");
  if (own && own !== "unreadable") return own;
  const where = vercelRootOf(read, exists, workspace);
  return where?.builds === "app" ? where.settings : null;
}

/** Whether the project's package manager is Bun, by what Bun leaves in it: bun.lock or bun.lockb, or a packageManager
 * field naming bun, in the app folder or any folder above it up to `top` (where a workspace keeps its lockfile). Vercel
 * runs a build script as `<package manager> run <name>` (above); any of these is taken as Bun, so its .env files are
 * checked whenever Bun might run the build. */
function bunProject(f: InstallReader, top: string): boolean {
  return foldersUp(top).some((d) => {
    const at = (name: string) => (d === "." ? name : `${d}/${name}`);
    if (f.exists(at("bun.lock")) || f.exists(at("bun.lockb"))) return true;
    const pkg = jsonFile(f.read, f.exists, at("package.json"));
    return !!pkg && pkg !== "unreadable" && typeof pkg.packageManager === "string" && /^bun@/.test(pkg.packageManager);
  });
}

/** Why the vue-tsc in a plain build (`command`, run in `folder`) is not proven safe: a tsconfig it reads (tsconfig.json,
 * a -p file, what they extend and reference) names vueCompilerOptions.plugins, or cannot be read. */
function vueTscOff(f: InstallReader, folder: string, command: string, top: string): string | null {
  const at = (name: string) => (folder === "." ? name : `${folder}/${name}`);
  const starts = ["tsconfig.json", ...[...command.matchAll(/-p ([\w.][\w./-]*)/g)].map((m) => m[1])];
  for (const start of starts) {
    const chain = tsconfigChain(f.read, at(start), top);
    if (!Array.isArray(chain)) return `vue-tsc runs in the build, and the wizard cannot read ${chain.unread}, where vue-tsc may find language plugins to load`;
    const named = chain.find(({ json }) => { const p = json.vueCompilerOptions?.plugins; return p !== undefined && !(Array.isArray(p) && p.length === 0); });
    if (named) return `${named.rel} sets vueCompilerOptions.plugins, code vue-tsc loads when the build runs it`;
  }
  return null;
}

function folderBuild(f: InstallReader, folder: string, build: boolean, trusted: (name: string) => boolean, settings: ProjectSettings | null = null, top = "."): VercelBuild {
  const { read, exists } = f;
  const at = (name: string) => (folder === "." ? name : `${folder}/${name}`);
  const done = (exposure: SecretExposure | null, modes = ["production"], kind: VercelBuild["build"] = "other", bun = false): VercelBuild => ({ exposure, modes, build: kind, ...(bun ? { bun } : {}) });
  const config = build ? VERCEL_CONFIGS.find((c) => exists(at(c))) : undefined;
  if (config) return done(notChecked(`Vercel reads ${at(config)}, which the wizard does not check`, `${at(config)} is a build configuration file the wizard does not check`));
  const vercel = build ? jsonFile(read, exists, at("vercel.json")) : null;
  if (vercel === "unreadable") return done(notChecked(`${at("vercel.json")} exists, but the wizard cannot read it`));
  const pkg = jsonFile(read, exists, at("package.json"));
  if (pkg === "unreadable") return done(notChecked(`${at("package.json")} exists, but the wizard cannot read it`));
  // A known-harmless installCommand (npm ci, pnpm install…) does what Vercel's own install does.
  const install = vercel?.installCommand;
  if (typeof install === "string" && harmlessInstall(install)) {
    const off = harmlessInstallOff(install, folder, f, trusted);
    if (off) return done(notChecked(`${at("vercel.json")}'s installCommand runs ${install.trim()}, and ${off}`));
  }
  const runs = vercel ? VERCEL_RUNS.find((k) => has(vercel, k) && !(k === "installCommand" && typeof install === "string" && harmlessInstall(install))) : undefined;
  if (runs) return done(notChecked(`${at("vercel.json")} sets ${runs}, which Vercel runs in the build and the wizard does not check`, `${at("vercel.json")} sets ${runs}, a build step the wizard does not check`));
  // A VERCEL_RUNS key that reaches here is a known-harmless installCommand.
  const other = vercel ? Object.keys(vercel).find((k) => !VERCEL_RUNS.includes(k) && vercelKeyOff(vercel, k)) : undefined;
  if (other) {
    const what = `${at("vercel.json")} sets ${other}${other === "framework" ? ` to ${JSON.stringify(vercel!.framework)}` : ""}`;
    return done(notChecked(`${what}, which the wizard does not check, and it may change how Vercel builds this app`, `${what}, a build setting the wizard does not check`));
  }
  // The dashboard's settings, as `vercel pull` saved them; vercel.json's own commands come first.
  if (settings) {
    const fw = settings.framework;
    if (fw !== null && fw !== undefined && fw !== "vite") return done(notChecked(`${SETTINGS(settings.file)} name the framework ${JSON.stringify(fw)}, whose build the wizard does not check`));
    const cmd = settings.installCommand;
    if (typeof cmd === "string" && cmd.trim() && vercel?.installCommand === undefined) {
      if (!harmlessInstall(cmd)) return done(notChecked(`${SETTINGS(settings.file)} set the Install Command ${JSON.stringify(cmd)}, which Vercel runs in the build and the wizard does not check`));
      const off = harmlessInstallOff(cmd, folder, f, trusted);
      if (off) return done(notChecked(`${SETTINGS(settings.file)} set the Install Command ${cmd.trim()}, and ${off}`));
    }
  }
  const scripts: Record<string, unknown> = pkg?.scripts && typeof pkg.scripts === "object" && !Array.isArray(pkg.scripts) ? pkg.scripts : {};
  const scriptOff = installScriptsOff(f, folder, scripts, trusted);
  if (scriptOff) return done(notChecked(scriptOff.what, scriptOff.offVercel));
  if (!build) return done(null);
  const set = vercel?.buildCommand;
  const dashboard = settings?.buildCommand;
  const named = BUILD_SCRIPTS.find((n) => has(scripts, n));
  let source: string, command: string;
  // Whether Vercel runs a build script itself, with the project's package manager (not a command it was given).
  let byScript = false;
  const reached: string[] = [];
  if (typeof set === "string" && set.trim()) [source, command] = [`${at("vercel.json")}'s buildCommand`, set];
  else if (typeof dashboard === "string" && dashboard.trim()) [source, command] = [`the Build Command in ${SETTINGS(settings!.file)}`, dashboard];
  else if (named) {
    const where = folder === "." ? "" : ` in ${at("package.json")}`;
    if (typeof scripts[named] !== "string") return done(notChecked(`The "${named}" script${where} is not a command`));
    [source, command] = [`the "${named}" script${where}`, scripts[named] as string];
    reached.push(named);
    byScript = true;
  } else return done(null, undefined, "preset", bunProject(f, top));
  const runners = new Set<string>();
  const resolved = resolveRuns(command, scripts, reached, runners);
  const hook = reached.flatMap((n) => [`pre${n}`, `post${n}`]).find((h) => has(scripts, h));
  // Off Vercel the host's own build command is not visible here: the build may run this one.
  const builds = (who: string) => `${who} ${source} (${JSON.stringify(command)})`;
  if (hook) return done(notChecked(`${builds("Vercel builds this app with")}, and npm also runs the "${hook}" script with it, which the wizard does not check`, `${builds("The build may run")}, and npm also runs the "${hook}" script with it, which the wizard does not check`));
  const plain = resolved === null ? null : plainBuild(resolved);
  const checks = "which is not one of the builds the wizard checks (vite build, alone or after tsc, optionally with --mode <name>, --outDir <folder>, --base <path> or --emptyOutDir)";
  if (!plain) return done(notChecked(`${builds("Vercel builds this app with")}, ${checks}`, `${builds("The build may run")}, ${checks}`));
  const vueTsc = /\bvue-tsc\b/.test(resolved!) ? vueTscOff(f, folder, resolved!, top) : null;
  if (vueTsc) return done(notChecked(vueTsc));
  // Bun runs the build: through a `bun run` it reaches, or as the package manager Vercel runs the build script with.
  const bun = runners.has("bun run") || (byScript && bunProject(f, top));
  return done(null, [...new Set(["production", plain.mode ?? "production"])], "vite", bun);
}

/** What the guard needs of the app's folders for the build and the install (AppFolders in vite-config.ts). */
export interface BuildFolders {
  list: (rel: string) => string[] | null;
  /** `app`: the app folder relative to the root ("apps/web"), which a Root Directory names. */
  workspace: { root: string; vercel: boolean; app?: string } | null;
  /** Every package of the workspace (none outside one). */
  packages?: Packages;
  /** The top of the app's repository, relative to the app folder: the package managers' files are read up to there.
   * The workspace root (or the app folder) when not given. */
  repoTop?: string;
  /** What is at a path, a link never followed (InstallReader.kind). */
  kind?: (rel: string) => PathKind | null;
}

/** What Vercel's build and its install run: the app folder's install scripts, Vercel config and build command; the
 * package managers' own files from the app folder up to the top of its repository; where the packages the guard
 * trusts by name come from (`trusted`); and, in a workspace, the install scripts of every package (the install runs at
 * the workspace root) and the root's, with its build when Vercel is set up there (`workspace.vercel`). A command set in
 * the Vercel dashboard is not seen here. */
export function vercelBuild(read: (rel: string) => string | null, exists: (rel: string) => boolean, folders: BuildFolders, trusted: (name: string) => boolean): VercelBuild {
  const f: InstallReader = { read, exists, list: folders.list, kind: folders.kind };
  const ws = folders.workspace;
  const packages = folders.packages ?? { list: [], notChecked: null };
  // The settings `vercel pull` saved for the app's own link may hold dashboard commands: one that cannot be read is
  // not proven to hold none.
  if (projectSettings(f, ".") === "unreadable") return { exposure: notChecked(".vercel/project.json exists, but the wizard cannot read it, and it may hold the project's Build and Install Commands"), modes: ["production"] };
  const where = vercelRootOf(read, exists, ws);
  const top = folders.repoTop ?? ws?.root ?? ".";
  const app = folderBuild(f, ".", true, trusted, appSettingsOf(read, exists, ws), top);
  if (app.exposure) return app;
  const off = (o: InstallOff | null): VercelBuild | null => (o ? { exposure: notChecked(o.what, o.offVercel), modes: app.modes } : null);
  const install = installConfigOff(f, foldersUp(top));
  const config = off(install.off);
  if (config) return config;
  const { yarnReleases } = install;
  const others = packages.list.map((p) => p.dir).filter((d) => d !== "." && d !== ws?.root);
  const provenance = off(provenanceOff(f, [".", ...(ws ? [ws.root] : []), ...others], ws?.root ?? ".", packages, trusted));
  if (provenance) return provenance;
  const yarn = yarnReleases.length ? { yarnReleases } : {};
  if (!ws) return { ...app, ...yarn };
  if (packages.notChecked) return { exposure: notChecked(packages.notChecked), modes: app.modes };
  for (const dir of others) {
    const sibling = folderBuild(f, dir, false, trusted);
    if (sibling.exposure) return sibling;
  }
  // Vercel builds at the root when it is set up there and its settings do not name another folder (the app's own, or
  // one elsewhere).
  const atRoot = !!where && where.builds !== "app" && where.builds !== "elsewhere";
  const rootBuild = folderBuild(f, ws.root, atRoot, trusted, atRoot ? where!.settings : null, top);
  return rootBuild.exposure ? rootBuild : { exposure: null, modes: [...new Set([...app.modes, ...rootBuild.modes])], build: app.build, rootBuild: atRoot ? rootBuild.build : null, ...(app.bun ? { bun: true } : {}), ...yarn };
}
