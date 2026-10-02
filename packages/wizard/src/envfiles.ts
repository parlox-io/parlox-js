import { addGitignoreLine, hasEnvValue, removeEnvValue, setEnvValue } from "./edits/env.js";
import { parseCode, walk, type Node } from "./edits/splice.js";
import { PathError } from "./fs-safe.js";
import type { LocalCheck, PlanInput, PlanIo } from "./integrations/types.js";
import type { FileChange, Plan } from "./plan-core.js";
import { commandLines, NODE_VALUE_FLAGS } from "./scripts.js";
import { hasDep, type PackageManager } from "./workspace.js";

// Whether a server app loads a .env file itself. Next.js loads .env.local on its own; Express and Hono do
// not, so the wizard writes PARLOX_VERIFY_TOKEN (and, under --local-key, the local key) to a .env only when the project
// already loads one. Otherwise the report says what was looked at and what to set, and no dependency is added
// (PostHog's wizard installs dotenv; this one adds no package the developer did not ask for). What counts, each from
// the tool's own docs or source:
// - in the script that starts the app (dev, else start, and the scripts it runs): --env-file and --env-file-if-exists
//   among node's, bun's or tsx's own options (before the file they run); a preloaded dotenv/config (-r, --require,
//   --import, there too); dotenv-cli (`dotenv -e <file> --`, default .env, its cli.js); env-cmd (`env-cmd -f <file>`,
//   default ./.env; with -e or -r it reads an rc file of environments, never written); dotenv's own
//   `dotenv run -f <file>` and `dotenvx run -f <file>` (default .env, commas for several files);
// - in the file the server part goes in: import "dotenv/config", require("dotenv/config"), dotenv's or dotenvx's
//   config() however it is bound (its `path` when written as a literal or a list of them), process.loadEnvFile();
// - Bun, which reads .env by itself unless the command names its files (--env-file replaces them) or turns that off
//   (--no-env-file, bunfig.toml's `env = false`): a fact when the start script runs bun, an inference when only the
//   integration says the app is on Bun (Hono's target, from @types/bun);
// - else a dotenv or dotenvx dependency: an inference (it is most likely loaded somewhere), and `how` says so.
// dotenv's default file can be moved by DOTENV_CONFIG_PATH (read by the preload in dotenv 16 and 17, lib/env-options.js,
// and by config() too in 18, lib/config-options.js), DOTENV_PATH (18) or a dotenv_config_path= argument (the preload
// in 16 and 17, lib/cli-options.js; gone in 18). Which applies depends on the installed version, so the wizard does not
// follow them: a start script that sets one makes dotenv's default file unknown.
// The wizard writes only .env, .env.<name> or .env.<name>.local in the app's own folder. A loader of any other file
// (outside the folder, another name, an rc file, a path computed in code) is said as it is, never as "no loader".

/** A file the app loads its variables from, and how the wizard knows (the basis). `file` null: the wizard cannot tell
 * which file (a path computed in code, or `why`). `why`: why the wizard does not write it (an rc file), or why it
 * cannot tell (a variable it does not follow). */
export interface EnvSource { file: string | null; how: string; why?: string }

export interface EnvLoading {
  /** The env file the wizard writes (one the app loads, in its own folder), or null. */
  file: string | null;
  /** How the app loads it, as the Env fact shows it, or null. */
  how: string | null;
  /** With no file: the first loader seen whose file the wizard does not write. */
  elsewhere?: EnvSource;
  /** With no file and no loader: what was looked at ('the script "dev", server.js or the dependencies'). */
  checked?: string;
}

const NONE: EnvLoading = { file: null, how: null };
const DOTENV = ["dotenv", "@dotenvx/dotenvx"];
const DOTENV_CONFIG = ["dotenv/config", "@dotenvx/dotenvx/config"];
// env-cmd reads .json and .js files as JSON or modules: a name with a data or code extension is not a dotenv file.
const NOT_DOTENV = /\.(?:json|[cm]?[jt]s|ya?ml|toml)$/;
const RC_FILE = "env-cmd reads it as an rc file of environments, not as a .env file";

/** The file as the wizard writes it (".env.local" for "./.env.local"), or null when it is not one it writes: .env,
 * .env.<name> or .env.<name>.local in the app's own folder. */
export function writableEnvFile(file: string): string | null {
  const p = file.replace(/\\/g, "/").replace(/^(?:\.\/)+/, "");
  return /^\.env(?:\.[\w-]+(?:\.local)?)?$/.test(p) && !NOT_DOTENV.test(p) ? p : null;
}

/** The local check's reason when no loader was found, saying what was looked at. */
export const notLoaded = (checked: string): string => `the wizard found no .env loader in ${checked}, so PARLOX_VERIFY_TOKEN is not loaded locally; check it after you deploy`;
/** The report's note when no loader was found, saying what was looked at. */
export const noEnvNote = (checked: string): string => `The wizard found no .env loader in ${checked}, so it wrote nothing for local use and added no package. To check the server part on your computer, start it with PARLOX_VERIFY_TOKEN set to the same value as on your host.`;
/** The local check of a Worker (Hono or Express under wrangler): its local variables are wrangler's, not a .env. */
export const WORKER_LOCAL_SKIP = "the wizard does not write the Worker's local variables; check it after you deploy";

const NOTHING = "so nothing was written for local use and no package was added";
/** The report's note for an app that loads its variables from a file the wizard does not write. */
export function elsewhereNote(e: EnvSource): string {
  const check = "To check the server part on your computer,";
  if (e.file !== null && e.why) return `The app loads its variables from ${e.file} (${e.how}), which the wizard does not write: ${e.why}. Nothing was written for local use and no package was added. ${check} set PARLOX_VERIFY_TOKEN there, with the same value as on your host.`;
  if (e.file !== null) return `The app loads its variables from ${e.file} (${e.how}), which the wizard does not write (it writes only .env, .env.<name> or .env.<name>.local in the app's own folder), ${NOTHING}. ${check} add PARLOX_VERIFY_TOKEN to ${e.file}, with the same value as on your host.`;
  if (e.why) return `The app loads its variables through ${e.how}, but ${e.why}, ${NOTHING}. ${check} add PARLOX_VERIFY_TOKEN to the file it names, with the same value as on your host.`;
  return `The app loads its variables from a file whose path is computed in code (${e.how}), which the wizard does not follow, ${NOTHING}. ${check} add PARLOX_VERIFY_TOKEN to that file, with the same value as on your host.`;
}
const elsewhereSkip = (e: EnvSource): string =>
  e.file !== null ? `the app loads its variables from ${e.file}, which the wizard does not write; check it after you deploy`
    : e.why ? `${e.why}; check it after you deploy`
    : "the app loads its variables from a path computed in code, which the wizard does not follow; check it after you deploy";

/** The report's notes about local variables, for an app whose server part the wizard adds (hostNotes): none when the
 * token goes in a .env. */
export const envNotes = (env: EnvLoading): string[] => (env.file ? [] : [env.elsewhere ? elsewhereNote(env.elsewhere) : noEnvNote(env.checked ?? "the app")]);

/** Whether Bun reads .env by itself in this app: bunfig.toml's top-level `env = false` turns that off. */
export function bunLoadsEnv(bunfig: string | null): boolean {
  const top = (bunfig ?? "").split(/^[ \t]*\[/m)[0];
  return !/^[ \t]*env[ \t]*=[ \t]*false[ \t]*(?:#.*)?$/m.test(top);
}

/** The script the local check starts the app with: dev, else start. */
const startScript = (pkg: Record<string, any>): string | null =>
  typeof pkg.scripts?.dev === "string" ? "dev" : typeof pkg.scripts?.start === "string" ? "start" : null;

// ---- Loaders in a package.json script ----

const unquote = (w: string): string => w.replace(/^(["'])(.*)\1$/, "$2");
const wordsOf = (command: string): string[] => (command.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map(unquote);
const baseName = (w: string): string => w.replace(/\\/g, "/").split("/").pop() ?? w;
/** The value of `flags` at words[i] (`--file x`, `--file=x`; `-e=x` and `-e.x` for a one-letter flag, as minimist
 * reads them), and how many words it took; null when words[i] is not that flag. */
function flagValue(words: string[], i: number, flags: string[]): { value: string; used: number } | null {
  const w = words[i];
  for (const f of flags) {
    if (w === f) return i + 1 < words.length ? { value: words[i + 1], used: 2 } : null;
    if (w.startsWith(`${f}=`)) return { value: unquote(w.slice(f.length + 1)), used: 1 };
    if (/^-\w$/.test(f) && w.length > 2 && w.startsWith(f) && /^\W/.test(w.slice(2))) return { value: unquote(w.slice(2)), used: 1 };
  }
  return null;
}
/** A tool's options from words[from]: up to `--`, and (when `toCommand`) up to the first word that is not an option
 * or an option's value (`valued`: the options that take one). Returns the options' words and where they end. */
function optionsAt(words: string[], from: number, valued: string[], toCommand: boolean): { options: string[]; end: number } {
  let i = from;
  for (; i < words.length && words[i] !== "--"; i++) {
    if (toCommand && !words[i].startsWith("-")) break;
    if (valued.includes(words[i])) i++;
  }
  return { options: words.slice(from, i), end: i };
}
/** Every value of `flags` among a tool's options, split at commas when `commas`. */
function valuesOf(options: string[], flags: string[], commas = false): string[] {
  const out: string[] = [];
  for (let i = 0; i < options.length; i++) {
    const v = flagValue(options, i, flags);
    if (!v) continue;
    out.push(...(commas ? v.value.split(",").filter(Boolean) : [v.value]));
    i += v.used - 1;
  }
  return out;
}

const ENV_FILE = ["--env-file", "--env-file-if-exists"];
const DOTENV_RUN = ["-f", "--file"];
const DOTENVX_RUN = ["-f", "--env-file"];
const DOTENVX_VALUED = ["-f", "--env-file", "-fk", "--env-keys-file", "-e", "--env", "--convention", "-l", "--log-level"];
const ENV_CMD_FILE = ["-f", "--file"];
const ENV_CMD_RC = ["-e", "--environments", "-r", "--rc-file"];
const PRELOAD = ["-r", "--require", "--import"];
/** The runtimes whose own --env-file counts, and bun's subcommands that run no file of the app. */
const RUNTIMES = new Set(["node", "bun", "tsx"]);
const BUN_SUBCOMMANDS = new Set(["install", "i", "add", "a", "remove", "rm", "update", "outdated", "link", "unlink", "pm", "x", "build", "test", "create", "init", "upgrade", "publish", "patch", "audit", "info", "why", "exec", "repl"]);
// What moves dotenv's default file (not followed: see the top of the file).
const DOTENV_PATH = /^(DOTENV_PATH|DOTENV_CONFIG_PATH|dotenv_config_path)=/;

/** dotenv's default file in this app: .env, or unknown (`why`) when a start script sets what moves it. */
interface DotenvDefault { why: string | null }
const byDefault = (dotenv: DotenvDefault, how: string): EnvSource => (dotenv.why ? { file: null, how, why: dotenv.why } : { file: ".env", how });

/** What one command of a script says: the files it loads, in order (`script` names it in `how`), and, when it runs a
 * file with Bun, whether Bun's own .env loading is replaced (--env-file) or off (--no-env-file). */
interface CommandEnv { sources: EnvSource[]; bun: { replaced: boolean; off: boolean } | null }
function commandEnv(words: string[], script: string, scripts: Record<string, unknown>, dotenv: DotenvDefault): CommandEnv {
  const sources: EnvSource[] = [];
  let bun: CommandEnv["bun"] = null;
  const how = (tool: string) => `${tool} in the script "${script}"`;
  const add = (files: string[], fallback: EnvSource, tool: string) => { for (const s of files.length ? files.map((file) => ({ file, how: how(tool) })) : [fallback]) sources.push(s); };
  for (let i = 0; i < words.length; i++) {
    const tool = baseName(words[i]);
    if (RUNTIMES.has(tool)) {
      // Only the runtime's own options count: what comes after the file it runs is the app's.
      let k = i + 1;
      const sub = (tool === "tsx" && words[k] === "watch") || (tool === "bun" && words[k] === "run");
      if (sub) k++;
      let replaced = false, off = false;
      for (; k < words.length && words[k].startsWith("-") && words[k] !== "--"; k++) {
        const envFile = flagValue(words, k, ENV_FILE);
        if (envFile) { sources.push({ file: envFile.value, how: how("--env-file") }); replaced = true; k += envFile.used - 1; continue; }
        const preload = flagValue(words, k, PRELOAD);
        if (preload) { if (DOTENV_CONFIG.includes(preload.value)) sources.push(byDefault(dotenv, how(`${preload.value} preloaded`))); k += preload.used - 1; continue; }
        if (words[k] === "--no-env-file") off = true;
        if (!words[k].includes("=") && NODE_VALUE_FLAGS.has(words[k])) k++;
      }
      // bun with a file of the app (not a script of the package, not one of its own subcommands) runs it on Bun.
      const target = words[k];
      if (tool === "bun" && !bun && target && typeof scripts[target] !== "string" && (sub || !BUN_SUBCOMMANDS.has(target))) bun = { replaced, off };
      i = k;
      continue;
    }
    if ((tool === "dotenv" || tool === "dotenvx") && words[i + 1] === "run") {
      const { options, end } = optionsAt(words, i + 2, tool === "dotenv" ? DOTENV_RUN : DOTENVX_VALUED, true);
      add(valuesOf(options, tool === "dotenv" ? DOTENV_RUN : DOTENVX_RUN, true), tool === "dotenv" ? byDefault(dotenv, how("dotenv run")) : { file: ".env", how: how("dotenvx run") }, `${tool} run`);
      i = end - 1;
    } else if (tool === "dotenv") {
      // dotenv-cli reads its options with minimist, up to `--` (without one, the command's words are read too).
      const { options, end } = optionsAt(words, i + 1, [], false);
      add(valuesOf(options, ["-e"]), { file: ".env", how: how("dotenv-cli") }, "dotenv-cli");
      if (words[end] === "--") i = end;
    } else if (tool === "env-cmd") {
      const { options, end } = optionsAt(words, i + 1, [...ENV_CMD_FILE, ...ENV_CMD_RC], true);
      // With -e (or -r) the variables come from an rc file of environments (-f then names it), never a .env file.
      const rc = options.some((_, k) => flagValue(options, k, ENV_CMD_RC) !== null);
      const file = valuesOf(options, ENV_CMD_FILE)[0];
      sources.push(rc ? { file: file ?? ".env-cmdrc", how: how("env-cmd"), why: RC_FILE } : { file: file ?? ".env", how: how("env-cmd") });
      i = end - 1;
    }
  }
  return { sources, bun };
}

// ---- Loaders in the server file ----

const literal = (n: Node | null | undefined): string | null =>
  n?.type === "StringLiteral" ? n.value : n?.type === "TemplateLiteral" && n.expressions.length === 0 ? n.quasis[0].value.cooked ?? null : null;
const required = (n: Node | null | undefined): string | null =>
  n?.type === "CallExpression" && n.callee.type === "Identifier" && n.callee.name === "require" ? literal(n.arguments[0]) : null;
const keyName = (p: Node): string | undefined => (p.computed ? undefined : p.key?.name ?? p.key?.value);

/** The files a config() call loads: its `path` (a literal or a list of them), else dotenv's default; a path the
 * wizard cannot read (computed, or options it cannot see) is a source with no file. */
function configSources(call: Node, dotenv: DotenvDefault, how: string): EnvSource[] {
  const opts = call.arguments[0];
  if (opts === undefined) return [byDefault(dotenv, how)];
  if (opts.type !== "ObjectExpression") return [{ file: null, how }];
  const prop = opts.properties.find((p: Node) => p.type === "ObjectProperty" && keyName(p) === "path");
  if (!prop) return [opts.properties.some((p: Node) => p.type === "SpreadElement") ? { file: null, how } : byDefault(dotenv, how)];
  const one = literal(prop.value);
  if (one !== null) return [{ file: one, how }];
  const list = prop.value.type === "ArrayExpression" ? prop.value.elements.map((e: Node | null) => literal(e)) : [null];
  return list.length && list.every((f: string | null) => f !== null) ? list.map((file: string) => ({ file, how })) : [{ file: null, how }];
}

/** The files the server file loads, in the order its code names them. */
function codeSources(code: string, file: string, dotenv: DotenvDefault): EnvSource[] {
  const ast = parseCode(code, file);
  if (!ast) return [];
  // The names the file gives dotenv's module (import dotenv, import * as, const x = require("dotenv")) and its config
  // function (import { config }, const { config } = require("dotenv")): only those calls are dotenv's.
  const modules = new Map<string, string>();
  const configs = new Map<string, string>();
  walk(ast.program, (n) => {
    if (n.type === "ImportDeclaration" && DOTENV.includes(n.source.value)) {
      for (const s of n.specifiers) {
        if (s.type !== "ImportSpecifier") modules.set(s.local.name, n.source.value);
        else if ((s.imported.name ?? s.imported.value) === "config") configs.set(s.local.name, n.source.value);
      }
    } else if (n.type === "VariableDeclarator") {
      const m = required(n.init);
      if (!m || !DOTENV.includes(m)) return;
      if (n.id.type === "Identifier") modules.set(n.id.name, m);
      else if (n.id.type === "ObjectPattern") for (const p of n.id.properties) if (p.type === "ObjectProperty" && keyName(p) === "config" && p.value.type === "Identifier") configs.set(p.value.name, m);
    }
  });
  const out: EnvSource[] = [];
  walk(ast.program, (n) => {
    if (n.type === "ImportDeclaration" && DOTENV_CONFIG.includes(n.source.value)) { out.push(byDefault(dotenv, `import "${n.source.value}"`)); return; }
    if (n.type !== "CallExpression") return;
    const req = required(n);
    if (req !== null && DOTENV_CONFIG.includes(req)) { out.push(byDefault(dotenv, `require("${req}")`)); return; }
    const c = n.callee;
    const member = c.type === "MemberExpression" && !c.computed ? c : null;
    if (member?.object.type === "Identifier" && member.object.name === "process" && member.property.name === "loadEnvFile") {
      const arg = n.arguments[0];
      out.push({ file: arg === undefined ? ".env" : literal(arg), how: "process.loadEnvFile()" });
      return;
    }
    const from = member?.property.name === "config" ? (member.object.type === "Identifier" ? modules.get(member.object.name) : required(member.object)) : c.type === "Identifier" ? configs.get(c.name) : undefined;
    if (from && DOTENV.includes(from)) out.push(...configSources(n, dotenv, `${from === "dotenv" ? "dotenv" : "dotenvx"}'s config()`));
  });
  return out;
}

/** "a, b or c". */
const orList = (items: string[]): string => (items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} or ${items[items.length - 1]}`);

/** The env file the app loads, from the script that starts it, then the server file (`serverCode`, `serverFile`: the
 * file the server part goes in), then Bun (run by the start script, or `bun`: the integration says the app is on Bun,
 * an inference; `bunfig`: bunfig.toml's text), then a dotenv dependency (inferred). The first file the wizard can write
 * wins; with none, the first other loader is `elsewhere`; with no loader at all, `checked` says what was looked at. */
export function envLoading(pkg: Record<string, any>, serverCode: string | null, serverFile: string | null, bun = false, bunfig: string | null = null): EnvLoading {
  const script = startScript(pkg);
  const scripts: Record<string, unknown> = pkg.scripts && typeof pkg.scripts === "object" ? pkg.scripts : {};
  // The start script and every script it runs, each named by its own name.
  const commands = script ? commandLines(pkg, scripts[script] as string).flatMap((line) => {
    const name = line === scripts[script] ? script : Object.keys(scripts).find((k) => scripts[k] === line) ?? script;
    return line.split(/&&|\|\||;|\|/).map((c) => ({ name, words: wordsOf(c) }));
  }) : [];
  const moved = commands.flatMap((c) => c.words.map((w) => DOTENV_PATH.exec(w)?.[1]).filter((v): v is string => !!v).map((v) => `the script "${c.name}" ${v === "dotenv_config_path" ? "passes" : "sets"} ${v}, which the wizard does not follow`));
  const dotenv: DotenvDefault = { why: moved[0] ?? null };
  const parsed = commands.map((c) => ({ name: c.name, ...commandEnv(c.words, c.name, scripts, dotenv) }));
  const found = [...parsed.flatMap((c) => c.sources), ...(serverCode && serverFile ? codeSources(serverCode, serverFile, dotenv) : [])];
  for (const s of found) {
    const file = s.file === null || s.why ? null : writableEnvFile(s.file);
    if (file) return { file, how: s.how };
  }
  // Bun: a fact when the start script runs bun, else an inference from the integration's reading.
  const run = parsed.find((c) => c.bun);
  const bunOn = bunLoadsEnv(bunfig);
  let bunOff: string | null = null;
  if (run?.bun) {
    if (run.bun.off) bunOff = `--no-env-file in the script "${run.name}"`;
    else if (!bunOn) bunOff = "bunfig.toml";
    else if (!run.bun.replaced) return { file: ".env", how: `Bun reads .env by itself: the script "${run.name}" runs bun` };
  } else if (bun) {
    const dep = ["@types/bun", "bun-types"].find((d) => hasDep(pkg, d));
    if (!bunOn) bunOff = "bunfig.toml";
    else return { file: ".env", how: `Bun reads .env by itself; ${dep ? `Bun inferred from the ${dep} dependency` : "that the app runs on Bun is inferred"}` };
  }
  if (found.length) return { ...NONE, elsewhere: found[0] };
  for (const name of DOTENV) {
    if (!hasDep(pkg, name)) continue;
    const how = `inferred from the ${name} dependency`;
    return dotenv.why ? { ...NONE, elsewhere: { file: null, how, why: dotenv.why } } : { file: ".env", how };
  }
  const looked = orList([...(script ? [`the script "${script}"`] : []), ...(serverFile ? [serverFile] : []), "the dependencies"]);
  return { ...NONE, checked: `${looked}${script ? "" : " (the app has no dev or start script)"}${bunOff ? `; Bun's own .env loading is turned off (${bunOff})` : ""}` };
}

// ---- The local check ----

/** The variable `process.env.NAME` (or process.env["NAME"]) reads, or null. */
function envName(n: Node | null | undefined): string | null {
  if (n?.type !== "MemberExpression") return null;
  const o = n.object;
  const isEnv = o.type === "MemberExpression" && !o.computed && o.object.type === "Identifier" && o.object.name === "process" && o.property.name === "env";
  if (!isEnv) return null;
  return !n.computed && n.property.type === "Identifier" ? n.property.name : n.computed ? literal(n.property) : null;
}

/** The value `key` has in a .env text (the last line that sets it; quotes and an unquoted # comment taken off). */
function envValue(text: string | null, key: string): string | null {
  let value: string | null = null;
  for (const line of (text ?? "").split(/\r?\n/)) {
    const m = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=\\s*(.*)$`).exec(line);
    if (!m) continue;
    const raw = m[1].trim();
    const quoted = /^(["'])(.*?)\1/.exec(raw);
    value = quoted ? quoted[2] : raw.replace(/\s+#.*$/, "").trim();
  }
  return value;
}

/** A port number written in the code: 4000, "4000", process.env.PORT (its value in `envText`, the .env being edited)
 * || 4000 (?? too), Number(…) and parseInt(…) of one, or a variable declared with one (at most 3 steps). */
function portOf(n: Node | null | undefined, bindings: Map<string, Node>, envText: string | null, depth = 0): number | null {
  if (!n || depth > 3) return null;
  if (n.type === "NumericLiteral") return n.value;
  if (n.type === "StringLiteral") return /^\d{1,5}$/.test(n.value) ? Number(n.value) : null;
  const name = envName(n);
  if (name) { const v = envValue(envText, name); return v !== null && /^\d{1,5}$/.test(v) ? Number(v) : null; }
  if (n.type === "LogicalExpression" && (n.operator === "||" || n.operator === "??")) return portOf(n.left, bindings, envText, depth + 1) ?? portOf(n.right, bindings, envText, depth + 1);
  if (n.type === "CallExpression" && n.callee.type === "Identifier" && ["Number", "parseInt"].includes(n.callee.name)) return portOf(n.arguments[0], bindings, envText, depth + 1);
  if (n.type === "Identifier") return portOf(bindings.get(n.name), bindings, envText, depth + 1);
  return null;
}

/** The port the server listens on, from its code: app.listen(<port>), or the `port` of the options given to serve()
 * (@hono/node-server, Bun.serve) or of the default export (Bun). */
function listenPort(code: string | null, file: string | null, envText: string | null): number | null {
  const ast = code && file ? parseCode(code, file) : null;
  if (!ast) return null;
  const bindings = new Map<string, Node>();
  walk(ast.program, (n) => { if (n.type === "VariableDeclarator" && n.id.type === "Identifier" && n.init && !bindings.has(n.id.name)) bindings.set(n.id.name, n.init); });
  let port: number | null = null;
  walk(ast.program, (n, ancestors) => {
    if (port !== null) return;
    if (n.type === "CallExpression" && n.callee.type === "MemberExpression" && !n.callee.computed && n.callee.property.name === "listen") port = portOf(n.arguments[0], bindings, envText);
    else if (n.type === "ObjectProperty" && keyName(n) === "port") {
      const holder = ancestors[ancestors.length - 2];
      const serve = holder?.type === "CallExpression" && ((holder.callee.type === "Identifier" && holder.callee.name === "serve") || (holder.callee.type === "MemberExpression" && holder.callee.property?.name === "serve"));
      if (serve || holder?.type === "ExportDefaultDeclaration") port = portOf(n.value, bindings, envText);
    }
  });
  return port !== null && Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
}

const runScript = (pm: PackageManager, name: string): string =>
  pm === "npm" ? (name === "start" ? "npm start" : `npm run ${name}`) : pm === "bun" ? `bun run ${name}` : `${pm} ${name}`;

/** The local check for a server app whose .env is loaded: the port its code listens on (a PORT it reads from the .env
 * being edited, `envText`, else the literal; else 3000, express-generator's and create-hono's Node default) and the
 * script that starts it. Without a loaded .env the token is not there, so there is nothing to check. */
export function localCheckFor(pkg: Record<string, any>, pm: PackageManager, serverCode: string | null, serverFile: string | null, env: EnvLoading, envText: string | null = null): LocalCheck {
  if (!env.file) return { skip: env.elsewhere ? elsewhereSkip(env.elsewhere) : notLoaded(env.checked ?? "the app") };
  const port = listenPort(serverCode, serverFile, envText) ?? 3000;
  const script = startScript(pkg);
  return { url: `http://localhost:${port}`, start: script ? runScript(pm, script) : serverFile ? `node ${serverFile}` : "your server" };
}

// ---- The plan ----

type EnvPlan = Pick<Plan, "changes" | "manual">;
/** A read that turns a refusal (a link, a file over 1 MB: fs-safe.ts) into its message. */
export function readOrRefusal(read: (rel: string) => string | null, rel: string): { text: string | null } | { refused: string } {
  try { return { text: read(rel) }; }
  catch (err) {
    if (err instanceof PathError) return { refused: err.message };
    throw err;
  }
}

/** PARLOX_VERIFY_TOKEN in the app's own env file, with .gitignore covering it. Paths are relative to the app's folder.
 * An env file the wizard may not write is a step by hand with the line (the token is public by design), never the end
 * of the run: one git tracks (the wizard never writes a committed env file; dotenvx keeps an encrypted .env in git on
 * purpose), one it may not read (a link, which is never followed), or one whose .gitignore it may not read (a .env is
 * written only where git ignores it). */
/** Why an env file git tracks is a step by hand at install (`shown`: the file as the review names it), both ways out. */
export const trackedEnvReason = (shown: string): string => `git tracks this file, so the wizard does not write to it. Remove it from git (git rm --cached ${shown}) and run the wizard again; or, if it is meant to be in git (dotenvx's encrypted .env, say), set PARLOX_VERIFY_TOKEN in the environment you start the server with instead.`;
/** Why an env file the wizard may not read (a link, a file over 1 MB) is a step by hand at install. */
export const refusedEnvReason = (refused: string): string => `The wizard does not read or write this file (${refused}): add the line to it yourself.`;
/** Why an env file is a step by hand when git does not ignore it yet and the wizard may not read .gitignore (a link, a
 * file over 1 MB) to add it there: an env file is written only where git ignores it. */
export const ignoreRefusedReason = (refused: string): string => `The wizard writes this file only when .gitignore keeps it out of git, and it does not read .gitignore (${refused}): add the line to this file yourself, and make sure git ignores it.`;
/** The env file's text, or why the wizard may not read it (a link is never followed, a file over 1 MB is not read). */
export const readEnvFile = (read: (rel: string) => string | null, file: string) => readOrRefusal(read, file);

export function planEnvToken(input: PlanInput, file: string): EnvPlan {
  const shown = input.shown?.(file) ?? file;
  const byHand = (reason: string): EnvPlan => ({ changes: [], manual: [{ file, reason, snippet: `PARLOX_VERIFY_TOKEN=${input.verifyToken}` }] });
  if (input.git.isRepo() && input.git.isTracked(file)) return byHand(trackedEnvReason(shown));
  const got = readOrRefusal(input.read, file);
  if ("refused" in got) return byHand(refusedEnvReason(got.refused));
  const changes: FileChange[] = [];
  const env = setEnvValue(got.text, "PARLOX_VERIFY_TOKEN", input.verifyToken);
  if (env.changed) changes.push({ path: file, before: got.text, after: env.content, purpose: "ownership token" });
  if (input.git.isRepo() && !input.git.isIgnored(file)) {
    const ignore = readOrRefusal(input.read, ".gitignore");
    if ("refused" in ignore) return byHand(ignoreRefusedReason(ignore.refused));
    const gi = addGitignoreLine(ignore.text, file);
    if (gi.changed) changes.push({ path: ".gitignore", before: ignore.text, after: gi.content, purpose: `keeps ${file} out of git` });
  }
  return { changes, manual: [] };
}

/** What uninstall says about a PARLOX_SECRET_KEY line it leaves in an env file. */
const keyLeft = (shown: string): string => `PARLOX_SECRET_KEY in ${shown} was left: the wizard cannot tell whether --local-key wrote it or it is your own key (for orders, say). If --local-key wrote it, delete that line and revoke the key named "wizard · local dev · …" in Settings → Keys.`;

/** PARLOX_VERIFY_TOKEN out of the env file (the file goes when nothing else is left in it); a file the wizard may not
 * read is a step by hand. A PARLOX_SECRET_KEY line stays: the wizard cannot tell a key --local-key wrote from the
 * merchant's own (purchase() reads the same variable), so it says how to remove a local one instead (`warnings`). */
export function unplanEnv(io: Pick<PlanIo, "read" | "shown"> & { git?: PlanIo["git"] }, file: string): EnvPlan & { warnings?: string[] } {
  const shown = io.shown?.(file) ?? file;
  const got = readOrRefusal(io.read, file);
  if ("refused" in got) return { changes: [], manual: [{ file, reason: `The wizard does not read or write this file (${got.refused}): remove Parlox's lines from it yourself, if they are there.`, snippet: `Remove the PARLOX_VERIFY_TOKEN line. If --local-key wrote a PARLOX_SECRET_KEY line, remove it too and revoke that key ("wizard · local dev · …") in Settings → Keys.`, unread: true }] };
  const env = removeEnvValue(got.text, "PARLOX_VERIFY_TOKEN");
  // A file git tracks is never written, at uninstall as at install: its line is a step by hand.
  const tracked = env.changed && !!io.git?.isRepo() && io.git.isTracked(file);
  const plan: EnvPlan & { warnings?: string[] } = tracked
    ? { changes: [], manual: [{ file, reason: "git tracks this file, so the wizard does not change it: remove the PARLOX_VERIFY_TOKEN line yourself.", snippet: "Remove the PARLOX_VERIFY_TOKEN line." }] }
    : { changes: env.changed ? [{ path: file, before: got.text, after: env.content, purpose: "ownership token" }] : [], manual: [] };
  if (hasEnvValue(got.text, "PARLOX_SECRET_KEY")) plan.warnings = [keyLeft(shown)];
  return plan;
}
