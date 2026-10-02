import { readdirSync } from "node:fs";
import { join, posix } from "node:path";
import { addPageTag, foreignTagLine, foreignTagWarning, headsIn, htmlSnippet, jsxHeadIn, jsxSnippet, MARKER_TEXT, REMOVE_TAG_SNIPPET, removePageTag, wizardTagIn, type JsxTypes } from "../edits/head-tag.js";
import { parseCode, walk, type Node } from "../edits/splice.js";
import { findAppDeclarations, removeUseLine } from "../edits/use-line.js";
import { MAX_FOLDERS, walkFiles } from "../edits/views.js";
import { envLoading, envNotes, localCheckFor, planEnvToken, unplanEnv, WORKER_LOCAL_SKIP, type EnvLoading } from "../envfiles.js";
import { appSourceFiles, OWN_REPORT_KIND, ownReporting, ownReportWarning, type OwnReport } from "../own-reporting.js";
import { combinePlans, declared, emptyPlan, overlayReader, packageCommand, type Plan } from "../plan-core.js";
import { compiledDirs, compiledIn, findServerFile, importsModule, serverFileCandidates, sourceFile, type CompiledDir } from "../scripts.js";
import { otherHostFile, WORKERS_RUNTIME_SECRET, wranglerOf, type HostId, type Wrangler } from "../hosts.js";
import { DetectError, GUIDE, hasDep, packageManagerOf, readJson, readJsonc, readText, type PackageManager } from "../workspace.js";
import { CDN_NOTE, envText, viteBuildOutputs } from "./express.js";
import { serverPackageKept } from "../sdk-use.js";
import { planUseLine, shutdownNote, tryRead } from "./server-part.js";
import type { Detection, Integration, PlanInput } from "./types.js";

// Hono. The server part: `app.use(parlox())` right after `const app = new Hono()` (or @hono/zod-openapi's
// `new OpenAPIHono()`, which extends it), before every route, as Hono's own middleware is added
// (`app.use('*', sentry())`), with the import from @parlox/server/hono. The browser part: the dashboard's pinned tag in
// the one source file with a page <head> (a JSX layout such as jsxRenderer's, or an html`…` template), through the
// tag editor (edits/head-tag.ts), spelled for the JSX types the file is checked with. The runtime (the target) names the app and chooses
// the notes (on Cloudflare Workers, that the key is a runtime secret); a Vite build beside the app is checked on every
// target (apps.ts). The adapter finds the runtime's waitUntil and variables itself, at run time. Covered: Node.js, Bun,
// Cloudflare Workers and Pages, Vercel, AWS Lambda (create-hono's templates); Deno and Fastly are not yet;
// Lambda@Edge (no environment variables) and HonoX (its app comes from createApp) are declined. An app that already
// reports to Parlox with its own code (its own POST to /v1/s) gets no server part (own-reporting.ts); a Parlox tag the
// wizard did not write anywhere in the app's source means no second tag. Build output is never edited: dist/, build/
// and out/ wherever they are, tsconfig's outDir, Vite's outDir, and the bundle wrangler's [build] command makes.
// Uninstall removes the use line and every tag the wizard wrote (found by its marker), byte for byte, and never a tag
// pasted by hand. Local variables: on Node.js and Bun, PARLOX_VERIFY_TOKEN goes in the .env the app already loads
// (envfiles.ts), else the report says what to set; Workers, Pages, Vercel and Lambda keep their variables with the
// platform, and the wizard writes none of those locally.

export type HonoTarget = "nodejs" | "bun" | "cloudflare-workers" | "cloudflare-pages" | "vercel" | "aws-lambda" | "unknown";
/** Runtimes the wizard does not install into (yet). */
type DeclinedTarget = "deno" | "fastly" | "lambda-edge";
export interface HonoData {
  appFile: string | null;
  reason: string | null;
  pkgType: string | undefined;
  target: HonoTarget;
  basePath: string | null;
  /** The one source file with a page <head>, or null. */
  layout: string | null;
  /** The JSX types a JSX layout is checked with (null: not known, a snippet); "hono" (HTML's spelling) for an html`…`
   * template. */
  layoutJsx: JsxTypes;
  /** Why the browser part is a step by hand (several files with a page <head>, or the scan stopped), or null. */
  layoutReason: string | null;
  /** The first file with a Parlox tag the wizard did not write, or null. With one, no tag is added anywhere. */
  tagAlready: string | null;
  /** Those tags by file and line, and what pages were not looked at: for the review and the report. */
  pageNotes: string[];
  /** Where the app reports to Parlox with its own code, or null; and what that scan did not read. */
  ownReport: OwnReport | null;
  ownReportNotChecked: string | null;
  /** The folders searched for pages: uninstall looks for the wizard's marked tag in all of them, with no cap. */
  folders: string[];
  /** What the report says about local variables when the wizard adds the server part (envfiles.ts). */
  envNotes: string[];
}

const SOURCE = "@parlox/server/hono";
const HONO = ["hono", "hono/tiny", "hono/quick", "@hono/zod-openapi"];
const LABELS: Record<HonoTarget, string> = { nodejs: "Node.js", bun: "Bun", "cloudflare-workers": "Cloudflare Workers", "cloudflare-pages": "Cloudflare Pages", vercel: "Vercel", "aws-lambda": "AWS Lambda", unknown: "runtime not detected" };
const NOT_FOUND = "No Hono app file found: the wizard looked at wrangler's main, the files the start and dev scripts run, main, server, index and app files in the folder and in src/, api/, and src/index.";
const LAMBDA_SKIP = "an AWS Lambda function has no local server to check";
// What @parlox/server does on Lambda (packages/server/src/platform.ts, isLambda; core.ts, deliver and report): each
// report is sent on its own, but its request starts after an asynchronous hash, so after the handler has returned, and
// Lambda freezes the instance then. Worded as the server package's README words it.
const LAMBDA_NOTE = "On AWS Lambda each report is sent on its own, never queued, but its request to Parlox starts only after your handler has returned, and Lambda then freezes the function: the report is usually delayed to the next invocation of the same warm instance, and lost when the instance is frozen and then recycled.";
const CLOUDFLARE_NOTE = "On Cloudflare the adapter reads PARLOX_SECRET_KEY and PARLOX_VERIFY_TOKEN from the Worker's variables (c.env).";
const NO_PAGES = "This app serves no pages the wizard can see (no JSX <head>, no html`…` template with a <head>): the browser part belongs in your frontend.";
const PLAIN = "The page's <head> is in a plain string, which the wizard does not edit (it edits a JSX <head> or an html`…` template): add the tag to it by hand.";
const basePathNote = (base: string) => `The app is mounted under ${base}: the server part sees only requests there, and the ownership check at /.well-known/parlox-verify does not reach it. Prove ownership with the DNS record or the tag instead (the dashboard lists both).`;
const ignoredReason = (file: string, what: string) => `git ignores ${file}, so it is likely built or generated, and a change there would not be kept; add ${what} to the source it comes from.`;
/** The most source files read for a page <head> at install (uninstall reads every one). */
const MAX_SCAN = 300;
// The app's own code, not its tests, type declarations or build output (dist/, build/, out/ at any depth).
const CODE = /\.[cm]?[jt]sx?$/;
const TYPESCRIPT = /\.[cm]?tsx?$/;
const NOT_CODE = /\.d\.[cm]?ts$|\.(?:test|spec)\.[cm]?[jt]sx?$/;
const NOT_SOURCE_DIR = /(?:^|\/)(?:test|tests|__tests__|__mocks__|dist|build|out)\//;
// Vercel's function for every path below api/: api/index, or a catch-all route ([...path], [[...route]]).
const MAIN_ROUTE = /^api\/(?:index|\[\[?\.\.\.[^\]/]+\]\]?)\.[cm]?[jt]sx?$/;
const DECLINED: Record<DeclinedTarget, string> = {
  deno: `Hono on Deno is not covered by the wizard yet. Add the server part by hand: ${GUIDE}`,
  fastly: `Hono on Fastly Compute is not covered by the wizard yet. Add the server part by hand: ${GUIDE}`,
  // "Lambda environment variables" are among the Lambda features Lambda@Edge does not support
  // (docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/lambda-at-edge-function-restrictions.html, opened
  // 2026-10-01), and the server part reads its key from one.
  "lambda-edge": `Hono on Lambda@Edge is not covered by the wizard: Lambda@Edge does not support environment variables, where the server part reads its key. See ${GUIDE}`,
};

export { readJsonc };

/** A folder with deno.json or deno.jsonc and no package.json (apps.ts asks): Deno is not covered yet. */
export function denoProject(dir: string): DetectError | null {
  const read = readText(dir);
  const config = read("deno.json") ?? read("deno.jsonc");
  if (config === null) return null;
  return new DetectError("declined", /hono/i.test(config) ? DECLINED.deno : `This is a Deno project (deno.json), and the wizard covers projects with a package.json. For other stacks see ${GUIDE}`);
}

/** wrangler's main when something builds it, as compiled output (the folder of a JavaScript main; main itself at the
 * top), with what builds it: wrangler's [build] command, or a package.json script that names main or its folder as an
 * output (esbuild's --outfile, --outdir). A TypeScript main is source wrangler bundles itself, whatever else runs. */
function wranglerBundle(w: Wrangler | null, pkg: Record<string, any>): (CompiledDir & { by: string }) | null {
  if (!w?.main || !/\.[cm]?js$/.test(w.main)) return null;
  const main = posix.normalize(w.main.replace(/\\/g, "/"));
  if (posix.isAbsolute(main) || main.startsWith("../")) return null;
  const folder = posix.dirname(main);
  const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // main after an output-file flag (esbuild's --outfile, rollup's --file or -o), or its folder after an output-folder
  // flag (esbuild's --outdir, tsc's --outDir, babel's --out-dir or -d).
  const output = new RegExp(String.raw`(?:(?:--out-?file|--file|-o)(?:=|\s+)["']?(?:\./)?${esc(main)}|(?:--out-?[dD]ir|-d)(?:=|\s+)["']?(?:\./)?${esc(folder)}/?)(?=$|[\s"';&|])`);
  const script = Object.entries((pkg.scripts ?? {}) as Record<string, unknown>).find(([, c]) => typeof c === "string" && folder !== "." && output.test(c))?.[0];
  const by = w.build !== null ? "its [build] command builds it" : script ? `the package.json script "${script}" names it as an output` : null;
  return by ? { out: folder === "." ? main : folder, root: null, by } : null;
}
/** Whether the app file's text imports or requires `module` (a label only: it names the runtime). */
const loads = (code: string | null, module: string) => new RegExp(String.raw`(?:from|require\()\s*["']${module}["']`).test(code ?? "");

// The modules that run a Hono app on a runtime other than Cloudflare Workers: Hono's adapters (@hono/aws-lambda is the
// Lambda one as its own package), Node's server, srvx (one serve() for Node.js, Deno and Bun, which says nothing of
// which), and other platforms' function packages: @vercel/node (Vercel's Node.js runtime), @netlify/functions and
// serverless-http ("existing web application frameworks in serverless environments", which names no one platform).
const OTHER_RUNTIMES = ["@hono/node-server", "hono/vercel", "hono/aws-lambda", "@hono/aws-lambda", "hono/bun", "hono/deno", "hono/lambda-edge", "hono/netlify", "srvx", "@vercel/node", "@netlify/functions", "serverless-http"];
// Declared in package.json, each counts as an import of it; the vercel CLI too, which deploys to Vercel.
const OTHER_RUNTIME_PACKAGES = ["@hono/node-server", "@hono/aws-lambda", "srvx", "@vercel/node", "@netlify/functions", "serverless-http", "vercel"];
const runtimeModule = (source: string): string | null => OTHER_RUNTIMES.find((m) => source === m || source.startsWith(`${m}/`)) ?? null;
// The servers Bun and Deno start themselves, with no module to import: Bun.serve() and Deno.serve(), given the app as
// `{ fetch: app.fetch }` or `app.fetch`.
type ServeCall = "Bun.serve" | "Deno.serve";
const SERVE_TEXT = /\b(Bun|Deno)\s*(?:\?\.|\.)\s*serve\s*\(/g;

/** Whether the package.json says Bun runs the app: Bun's types (@types/bun, or bun-types), or a dev or start script that
 * runs `bun` (create-hono's Bun template has both: `bun run --hot src/index.ts`). */
const bunDeclared = (pkg: Record<string, any>): boolean =>
  hasDep(pkg, "@types/bun") || hasDep(pkg, "bun-types") || /(?:^|\s)bun\s/.test(`${pkg.scripts?.dev ?? ""} ${pkg.scripts?.start ?? ""}`);

/** What says that an app with wrangler's config (not Pages) runs somewhere other than Cloudflare Workers: another
 * host's file or link up to the top of the repository, the modules of other runtimes its source files load, and the
 * Bun.serve() or Deno.serve() calls in them (each with the first file that has it). Bun's own signs in package.json are
 * read beside it (bunDeclared). It names the target and the notes only: a Vite build is checked on every target. */
export interface NotWorkers { hostFile: { path: string; host: HostId } | null; imports: Map<string, string>; calls: Map<ServeCall, string> }

/** "Bun.serve" or "Deno.serve" for a call of either, as `Bun.serve(…)`, `Bun?.serve(…)`, `Bun["serve"](…)` or through a
 * global object (`globalThis.Bun.serve(…)`); else null. */
function serveCall(n: Node): ServeCall | null {
  const member = (x: Node | undefined) => x?.type === "MemberExpression" || x?.type === "OptionalMemberExpression";
  const keyOf = (m: Node): string | null => (m.computed ? (m.property.type === "StringLiteral" ? m.property.value : null) : m.property.type === "Identifier" ? m.property.name : null);
  if ((n.type !== "CallExpression" && n.type !== "OptionalCallExpression") || !member(n.callee) || keyOf(n.callee) !== "serve") return null;
  const obj = n.callee.object as Node;
  const runtime: string | null = obj.type === "Identifier" ? obj.name : member(obj) ? keyOf(obj) : null;
  return runtime === "Bun" ? "Bun.serve" : runtime === "Deno" ? "Deno.serve" : null;
}

/** The modules of other runtimes (OTHER_RUNTIMES) that the app's own source files load (an import, an `export … from`,
 * require() or import()), and the Bun.serve() and Deno.serve() calls in them, anywhere in the app (own-reporting.ts's
 * bounded walk). A file that does not parse counts by its text, so it is not a way past the check. */
function otherRuntimeCode(dir: string): { imports: Map<string, string>; calls: Map<ServeCall, string> } {
  const { files } = appSourceFiles(dir);
  const read = readText(dir);
  const imports = new Map<string, string>();
  const calls = new Map<ServeCall, string>();
  for (const file of files) {
    const text = read(file);
    if (text === null) continue;
    if (!OTHER_RUNTIMES.some((m) => text.includes(m)) && !/\b(?:Bun|Deno)\b/.test(text)) continue;
    const ast = parseCode(text, file);
    if (!ast) {
      for (const m of OTHER_RUNTIMES) if (text.includes(m) && !imports.has(m)) imports.set(m, file);
      for (const [, runtime] of text.matchAll(SERVE_TEXT)) { const call: ServeCall = runtime === "Bun" ? "Bun.serve" : "Deno.serve"; if (!calls.has(call)) calls.set(call, file); }
      continue;
    }
    walk(ast.program, (n) => {
      const lit = n.type === "ImportDeclaration" || n.type === "ExportNamedDeclaration" || n.type === "ExportAllDeclaration" ? n.source
        : n.type === "CallExpression" && ((n.callee.type === "Identifier" && n.callee.name === "require") || n.callee.type === "Import") ? n.arguments[0]
        : n.type === "ImportExpression" ? n.source : null;
      const m = lit?.type === "StringLiteral" ? runtimeModule(lit.value) : null;
      if (m && !imports.has(m)) imports.set(m, file);
      const call = serveCall(n);
      if (call && !calls.has(call)) calls.set(call, file);
    });
  }
  return { imports, calls };
}

/** NotWorkers for the app at `dir`, with `pkg` its package.json: each of OTHER_RUNTIME_PACKAGES among its dependencies or
 * devDependencies counts as an import of it. */
function notWorkers(dir: string, root: string, pkg: Record<string, any>): NotWorkers {
  const scan = otherRuntimeCode(dir);
  for (const m of OTHER_RUNTIME_PACKAGES) if (hasDep(pkg, m) && !scan.imports.has(m)) scan.imports.set(m, "package.json");
  return { hostFile: otherHostFile(dir, root), ...scan };
}

/** Where the key goes on Cloudflare Workers, said in the report and the hand-off: a Hono server part on the Workers
 * target. Instructions only; the Vite build beside it is checked as on every other target (apps.ts). */
const onWorkers = (d: Detection): boolean => d.parts.server?.kind === "hono" && (d.data as HonoData).target === "cloudflare-workers";

/** The runtime, from the files and packages each runtime's own create-hono template brings. A deploy target named in
 * a file (wrangler's config, a Vercel link or vercel.json) wins over @hono/node-server in devDependencies, which is a
 * local dev server (an app may serve itself with it locally and deploy on Vercel), and so does Hono's AWS Lambda
 * adapter, which runs only on Lambda, whatever else is there. Cloudflare Workers only when nothing else says otherwise
 * (`others`, read for an app with wrangler's config: another host's file or link up to the top of the repository,
 * another runtime in its dependencies or anywhere in its code, Bun's types or a script that runs bun); with such
 * evidence, the target is the one it names, in the order below (@vercel/node and the vercel CLI name Vercel), and
 * "unknown" where it names none (srvx, @netlify/functions, serverless-http, a Procfile). */
export function honoTarget(read: (rel: string) => string | null, pkg: Record<string, any>, appCode: string | null, others: NotWorkers | null = null): HonoTarget | DeclinedTarget {
  const scanned = (module: string) => others?.imports.has(module) ?? false;
  const called = (fn: ServeCall) => others?.calls.has(fn) ?? false;
  const uses = (module: string) => loads(appCode, module) || scanned(module);
  if (read("deno.json") !== null || read("deno.jsonc") !== null || scanned("hono/deno") || called("Deno.serve")) return "deno";
  if (hasDep(pkg, "@fastly/js-compute") || hasDep(pkg, "@fastly/hono-fastly-compute")) return "fastly";
  if (hasDep(pkg, "@hono/lambda-edge") || uses("hono/lambda-edge")) return "lambda-edge";
  const wrangler = wranglerOf(read);
  if (wrangler?.pages || hasDep(pkg, "@hono/vite-cloudflare-pages")) return "cloudflare-pages";
  if (hasDep(pkg, "@hono/aws-lambda") || uses("hono/aws-lambda") || uses("@hono/aws-lambda")) return "aws-lambda";
  const bun = bunDeclared(pkg) || scanned("hono/bun") || called("Bun.serve");
  if (wrangler && !others?.hostFile && !others?.imports.size && !others?.calls.size && !bun) return "cloudflare-workers";
  if (pkg.dependencies?.["@hono/node-server"]) return "nodejs";
  if (read(".vercel/project.json") !== null || read("vercel.json") !== null || uses("hono/vercel") || scanned("@vercel/node") || scanned("vercel") || others?.hostFile?.host === "vercel") return "vercel";
  if (bun) return "bun";
  if (hasDep(pkg, "@hono/node-server") || scanned("@hono/node-server")) return "nodejs";
  return "unknown";
}

const appsIn = (code: string, file: string): number => { const ast = parseCode(code, file); return ast ? findAppDeclarations(ast, "hono").length : 0; };

/** The Hono app file. In order: wrangler's main (the file Workers runs; its source, when a [build] command bundles it),
 * the start and dev scripts, main, and server, index and app files in the folder and in src/ (serverFileCandidates);
 * then Vercel's api/ functions, api/index and catch-all routes first (several others creating an app is a question
 * the wizard cannot answer); then src/index with the other extensions (Cloudflare Pages' src/index.tsx). First the file
 * that creates the app, then the first that imports hono, so the snippet can say what it found there. */
function findApp(dir: string, read: (rel: string) => string | null, pkg: Record<string, any>, wrangler: Wrangler | null, bundle: (CompiledDir & { by: string }) | null): { found: { file: string; code: string } | null; reason: string | null } {
  const built = bundle ? [bundle] : [];
  const dirs = [...compiledDirs(read), ...built];
  const first: string[] = [];
  const add = (list: string[], f: string | null) => { if (f && !first.includes(f) && !list.includes(f) && !compiledIn(f, dirs)) list.push(f); };
  if (wrangler?.main) add(first, sourceFile(read, "", wrangler.main, dirs));
  for (const f of serverFileCandidates(read, pkg, built)) add(first, f);
  const api: string[] = [];
  try { for (const f of readdirSync(join(dir, "api")).sort()) if (CODE.test(f) && !NOT_CODE.test(f) && read(`api/${f}`) !== null) add(api, `api/${f}`); } catch { /* no api folder */ }
  api.sort((a, b) => Number(MAIN_ROUTE.test(b)) - Number(MAIN_ROUTE.test(a)));
  const rest: string[] = [];
  for (const ext of ["tsx", "jsx", "mts", "cts"]) if (read(`src/index.${ext}`) !== null) add(rest, `src/index.${ext}`);

  const isHono = (code: string, file: string) => importsModule(code, file, HONO);
  const creates = (code: string, file: string) => isHono(code, file) && appsIn(code, file) > 0;
  const lead = findServerFile(read, first, creates, built);
  if (lead) return { found: lead, reason: null };
  const fromApi = api.map((f) => ({ from: f, hit: findServerFile(read, [f], creates, built) })).filter((x): x is { from: string; hit: { file: string; code: string } } => x.hit !== null);
  const routes = [...new Set(fromApi.map((x) => x.hit.file))];
  if (fromApi.length && (MAIN_ROUTE.test(fromApi[0].from) || routes.length === 1)) return { found: fromApi[0].hit, reason: null };
  if (routes.length > 1) return { found: null, reason: `More than one file in api/ creates a Hono app (${routes.join(", ")}), and none is api/index or a catch-all route, so the wizard cannot tell which one serves the site.` };
  const found = findServerFile(read, rest, creates, built) ?? findServerFile(read, [...first, ...api, ...rest], isHono, built);
  if (found) return { found, reason: null };
  const main = wrangler?.main ? posix.normalize(wrangler.main) : null;
  return { found: null, reason: bundle && main ? `wrangler's main, ${main}, is build output (${bundle.by}), and the wizard found no source for it (it edits only source files): add this to the source the bundle is built from.` : NOT_FOUND };
}

// ---- Which JSX types a layout is checked with ----

/** hono/jsx's types or React's, for a JSX import source (tsconfig's jsxImportSource, a @jsxImportSource comment). */
const typesOfSource = (source: string): JsxTypes => (/^hono\/jsx(?:\/|$)/.test(source) ? "hono" : source === "react" ? "react" : null);
/** What an import says about the file's JSX: hono/jsx and its renderer, or React and @hono/react-renderer. */
const typesOfImport = (source: string): JsxTypes => (/^hono\/jsx(?:$|\/|-renderer$)/.test(source) ? "hono" : /^(?:react|react-dom(?:\/.*)?|@hono\/react-renderer)$/.test(source) ? "react" : null);

/** The JSX import source the TypeScript config for `file` sets: the nearest tsconfig.json from the file's folder up to
 * the app's, with a relative `extends` followed (at most 5 steps). jsxImportSource, else "react" for the automatic
 * runtime (react-jsx, TypeScript's default source). null: a config that does not say, or extends a package's;
 * undefined: no tsconfig.json. */
function tsconfigJsx(read: (rel: string) => string | null, file: string): string | null | undefined {
  const own = (rel: string, depth: number): { source?: string; runtime?: string; unknown?: boolean } => {
    const json = readJsonc(read(rel));
    if (!json || depth > 5) return { unknown: true };
    const o = json.compilerOptions ?? {};
    const out: { source?: string; runtime?: string; unknown?: boolean } = {};
    // TypeScript applies each config of `extends` in order, then the file's own options over them.
    for (const ext of (Array.isArray(json.extends) ? json.extends : json.extends === undefined ? [] : [json.extends]) as unknown[]) {
      if (typeof ext !== "string" || !ext.startsWith(".")) { out.unknown = true; continue; }
      const next = posix.normalize(posix.join(posix.dirname(rel), ext.endsWith(".json") ? ext : `${ext}.json`));
      Object.assign(out, own(next, depth + 1));
    }
    if (typeof o.jsxImportSource === "string") { out.source = o.jsxImportSource; out.unknown = false; }
    if (typeof o.jsx === "string") out.runtime = o.jsx;
    return out;
  };
  for (let d = posix.dirname(file); ; d = posix.dirname(d)) {
    const rel = d === "." ? "tsconfig.json" : `${d}/tsconfig.json`;
    if (read(rel) !== null) {
      const c = own(rel, 0);
      if (c.source) return c.source;
      if (c.unknown) return null;
      return c.runtime === "react-jsx" || c.runtime === "react-jsxdev" ? "react" : null;
    }
    if (d === ".") return undefined;
  }
}

/** The JSX types `file` is checked with: its @jsxImportSource comment; else tsconfig's (which its JSX imports must not
 * contradict); else what its JSX imports say. null: the wizard cannot tell. */
function jsxTypesOf(read: (rel: string) => string | null, file: string, code: string): JsxTypes {
  const ast = parseCode(code, file);
  if (!ast) return null;
  const pragma = (ast.comments ?? []).map((c) => /@jsxImportSource\s+(\S+)/.exec(c.value)?.[1]).find((x): x is string => !!x);
  if (pragma) return typesOfSource(pragma);
  const imported = new Set(ast.program.body.filter((s) => s.type === "ImportDeclaration").map((s) => typesOfImport(s.source.value)).filter((t): t is "hono" | "react" => t !== null));
  const config = tsconfigJsx(read, file);
  if (typeof config === "string") { const t = typesOfSource(config); return t && [...imported].every((x) => x === t) ? t : null; }
  return imported.size === 1 ? [...imported][0] : null;
}

/** Whether a <head> in `code` is in a plain string or template (not JSX, not an html`…` template): a page the wizard
 * does not edit. */
function plainHead(code: string, file: string): boolean {
  if (!/<head/i.test(code)) return false;
  const ast = parseCode(code, file);
  if (!ast) return false;
  let found = false;
  walk(ast.program, (n, ancestors) => {
    if (found) return;
    const parent = ancestors[ancestors.length - 1];
    const html = parent?.type === "TaggedTemplateExpression" && parent.tag.type === "Identifier" && parent.tag.name === "html";
    const text = n.type === "StringLiteral" ? n.value : n.type === "TemplateLiteral" && !html ? n.quasis.map((q: { value: { cooked?: string; raw: string } }) => q.value.cooked ?? q.value.raw).join(" ") : null;
    if (typeof text === "string" && /<head(?=[\s>/])/i.test(text)) found = true;
  });
  return found;
}

/** The app's source files that could hold a page: under src/, api/ and the app file's folder (its own folder alone is
 * not searched when that is the app's root, only the app file), not tests, type declarations or build output. At most
 * `cap` files (`capped`: there were more). */
function sourceFiles(dir: string, read: (rel: string) => string | null, folders: string[], appFile: string | null, cap: number, built: CompiledDir[]): { files: string[]; capped: boolean } {
  const dirs = [...compiledDirs(read), ...built];
  const files = new Set<string>(appFile ? [appFile] : []);
  let capped = false;
  for (const folder of folders) {
    const walked = walkFiles(dir, folder, (n) => CODE.test(n) && !NOT_CODE.test(n), cap === Infinity ? Infinity : MAX_FOLDERS);
    capped ||= walked.capped;
    for (const f of walked.files) {
      if (compiledIn(f.rel, dirs) || NOT_SOURCE_DIR.test(f.rel) || files.has(f.rel)) continue;
      if (files.size >= cap) { capped = true; break; }
      files.add(f.rel);
    }
  }
  return { files: [...files], capped };
}

interface Pages { layout: string | null; layoutReason: string | null; tagAlready: string | null; notes: string[] }

/** The page layout: the one source file with a page <head>. A Parlox tag the wizard did not write in any of them means
 * no tag at all (a page may show it already), with a warning naming each file and line. A Vite build's output is not a
 * page layout; where the wizard cannot read where a Vite build writes, a JavaScript layout could be its output (a step
 * by hand), a TypeScript one never is. */
function findPages(dir: string, read: (rel: string) => string | null, folders: string[], appFile: string | null, built: CompiledDir[]): Pages {
  const { files, capped } = sourceFiles(dir, read, folders, appFile, MAX_SCAN, built);
  const foreign: Array<{ file: string; line: number }> = [];
  let withHead: string[] = [];
  const tagged = new Set<string>();
  for (const f of files) {
    const text = read(f);
    if (text === null) continue;
    const line = foreignTagLine(f, text);
    if (line !== null) { foreign.push({ file: f, line }); continue; }
    // A file that does not parse but names a <head>, or one whose <head> is in a plain string, counts: its edit is then
    // a step by hand, with the reason.
    const heads = headsIn(text, f);
    if (heads === null || heads.length || plainHead(text, f)) withHead.push(f);
    if (wizardTagIn(f, text)) tagged.add(f);
  }
  const where = folders.map((f) => `${f}/`).join(", ");
  let unread: string | null = null;
  if (withHead.length) {
    const vite = viteBuildOutputs(dir);
    const outs = vite.outs.filter((o) => o.out !== "unknown" && o.out !== ".").map((o) => o.out);
    withHead = withHead.filter((f) => !outs.some((o) => f === o || f.startsWith(`${o}/`))).sort();
    const js = withHead.filter((f) => !TYPESCRIPT.test(f));
    const unknown = vite.outs.find((o) => o.out === "unknown" || o.out === ".");
    if (js.length && unknown) unread = `The wizard could not read where ${unknown.config} builds to (its build.outDir is computed in code, or written in a way the wizard does not follow), so it cannot tell whether ${js.join(", ")} is that build's output, where an edit would be lost at the next build; add the tag to the layout your pages use.`;
    else if (js.length && vite.notChecked) unread = `The wizard could not look through every folder of this app for a Vite build, so it cannot tell whether ${js.join(", ")} is one's output, where an edit would be lost at the next build; add the tag to the layout your pages use.`;
  }
  if (foreign.length) {
    const others = withHead.filter((f) => !tagged.has(f));
    const tail = others.length ? `, and the wizard adds no tag to ${others.join(", ")}, which may show it.` : ".";
    return { layout: null, layoutReason: null, tagAlready: foreign[0].file, notes: foreign.map((t) => `${t.file}: ${foreignTagWarning(t.line).replace(/\.$/, tail)}`) };
  }
  if (withHead.length > 1) return { layout: null, layoutReason: `More than one file has a page <head> (${withHead.join(", ")}); add the tag to the one your pages use.`, tagAlready: null, notes: [] };
  if (capped && withHead.length) return { layout: null, layoutReason: `The wizard read the first ${MAX_SCAN} source files in ${where} and stopped, so it cannot tell whether ${withHead[0]} is the only file with a page <head>; add the tag to the one your pages use.`, tagAlready: null, notes: [] };
  if (unread) return { layout: null, layoutReason: unread, tagAlready: null, notes: [] };
  if (capped) return { layout: null, layoutReason: null, tagAlready: null, notes: [`Not checked for a page <head> past the first ${MAX_SCAN} source files in ${where}: if your pages have one there, add the tag to it by hand.`] };
  return { layout: withHead[0] ?? null, layoutReason: null, tagAlready: null, notes: [] };
}

export const hono: Integration = {
  id: "hono",
  label: "Hono",
  detect(dir, root) {
    const read = readText(dir);
    if (read("package.json") === null) return null;
    const pkg = readJson(join(dir, "package.json"));
    if (!hasDep(pkg, "hono")) return null;
    if (hasDep(pkg, "honox")) throw new DetectError("declined", `HonoX is not covered by the wizard yet (its app is created by createApp, not new Hono()). Add the server part by hand: ${GUIDE}`);
    const wrangler = wranglerOf(read);
    const bundle = wranglerBundle(wrangler, pkg);
    const app = findApp(dir, read, pkg, wrangler, bundle);
    const found = app.found;
    // A Worker by wrangler's config only when nothing else names another host or runtime.
    const others = wrangler && !wrangler.pages ? notWorkers(dir, root, pkg) : null;
    const target = honoTarget(read, pkg, found?.code ?? null, others);
    if (target in DECLINED) throw new DetectError("declined", DECLINED[target as DeclinedTarget]);
    const runtime = target as HonoTarget;
    const packageManager = packageManagerOf(dir, root);
    let reason = app.reason;
    let basePath: string | null = null;
    if (found) {
      const ast = parseCode(found.code, found.file);
      const apps = ast ? findAppDeclarations(ast, "hono") : [];
      if (!ast) reason = `The wizard could not read ${found.file}.`;
      else if (apps.length === 1) basePath = apps[0].basePath;
    }
    const appDir = found ? posix.dirname(found.file) : ".";
    const folders = [...new Set(["src", "api", appDir === "." ? "src" : appDir])];
    const { notes: pageNotes, ...pages } = findPages(dir, read, folders, found?.file ?? null, bundle ? [bundle] : []);
    const layoutText = pages.layout ? read(pages.layout) : null;
    const layoutJsx = pages.layout && layoutText !== null && jsxHeadIn(layoutText, pages.layout) ? jsxTypesOf(read, pages.layout, layoutText) : "hono";
    const scan = ownReporting(dir);
    const ownReport = scan.found;
    // Node.js and Bun read a local .env the way Express does (an app that reports with its own code gets no server part,
    // so nothing local).
    const local = (runtime === "nodejs" || runtime === "bun" || runtime === "unknown") && !ownReport;
    const env: EnvLoading = local ? envLoading(pkg, found?.code ?? null, found?.file ?? null, runtime === "bun", read("bunfig.toml")) : { file: null, how: null };
    const localCheck = runtime === "aws-lambda" ? { skip: LAMBDA_SKIP }
      : runtime === "cloudflare-workers" || runtime === "cloudflare-pages" ? { skip: WORKER_LOCAL_SKIP }
      : runtime === "vercel" ? { skip: "check it after you deploy" }
      // The check asks for /.well-known/parlox-verify, which an app mounted under a base path never sees (basePathNote).
      : basePath && env.file ? { skip: `the app is mounted under ${basePath}, so /.well-known/parlox-verify does not reach it` }
      : localCheckFor(pkg, packageManager, found?.code ?? null, found?.file ?? null, env, envText(dir, env.file));
    const data: HonoData = { appFile: found?.file ?? null, reason, pkgType: pkg.type, target: runtime, basePath, ...pages, layoutJsx, pageNotes, ownReport, ownReportNotChecked: scan.notChecked, folders, envNotes: local ? envNotes(env) : [] };
    return {
      integration: "hono", dir, root, packageManager,
      parts: {
        browser: data.layout ? { file: data.layout, kind: "hono-layout" } : data.layoutReason ? { file: null, kind: "hono-layout", manualReason: data.layoutReason } : null,
        server: ownReport ? { file: ownReport.file, kind: OWN_REPORT_KIND } : { file: data.appFile, kind: "hono", ...(reason ? { manualReason: reason } : {}) },
      },
      facts: [
        ["Found", `Hono · ${data.appFile ?? "app file not found"} · ${LABELS[runtime]} · ${packageManager}`],
        ...(data.layout ? [["Pages", data.layout] as [string, string]] : []),
        ...(env.file ? [["Env", `${env.file} (${env.how})`] as [string, string]] : []),
      ],
      // Said in the review too (plan.warnings), and again in the report.
      notes: [
        ...(ownReport ? [ownReportWarning(ownReport)] : scan.notChecked ? [scan.notChecked] : []),
        ...(basePath && !ownReport ? [basePathNote(basePath)] : []),
        ...data.pageNotes,
      ],
      envFile: env.file,
      localCheck,
      data,
    };
  },

  plan(d, input) {
    const data = d.data as HonoData;
    const server = emptyPlan();
    if (input.parts.server) {
      planServer(d.packageManager, data, input, server);
      if (d.envFile) { const e = planEnvToken(input, d.envFile); server.changes.push(...e.changes); server.manual.push(...e.manual); }
    }
    // The browser part reads the server part's result: a layout that is the app file itself is changed once.
    const pages = emptyPlan();
    pages.warnings.push(...data.pageNotes);
    if (input.parts.browser) planLayout(data, { ...input, read: overlayReader(input.read, server) }, pages);
    return bothParts(server, pages);
  },

  unplan(d, io) {
    const data = d.data as HonoData;
    const server = emptyPlan();
    const got = data.appFile ? tryRead(io.read, data.appFile) : { text: null };
    // A file it may not read, or one it cannot parse that does not name the adapter: a step only if Parlox is there.
    if ("refused" in got) server.manual.push({ file: data.appFile!, reason: got.refused, snippet: `Remove .use(parlox()) and the import of ${SOURCE} by hand.`, part: "server", unread: true });
    else if (data.appFile && got.text !== null) {
      const r = removeUseLine(got.text, data.appFile, SOURCE);
      if (!r.ok) server.manual.push({ file: data.appFile, reason: r.reason, snippet: r.snippet, part: "server", ...(got.text.includes(SOURCE) ? {} : { unread: true }) });
      else if (r.changed) server.changes.push({ path: data.appFile, before: got.text, after: r.code, purpose: "server part" });
    }
    if (d.envFile) { const e = unplanEnv(io, d.envFile); server.changes.push(...e.changes); server.manual.push(...e.manual); server.warnings.push(...(e.warnings ?? [])); }
    // Every tag the wizard wrote, found by its marker in each source file, whatever detection finds today.
    const pages = emptyPlan();
    const read = overlayReader(io.read, server);
    const detected = readText(d.dir);
    for (const file of sourceFiles(d.dir, detected, data.folders, data.appFile, Infinity, []).files) {
      if (!detected(file)?.includes(MARKER_TEXT)) continue;
      const page = tryRead(read, file);
      if ("refused" in page) { pages.manual.push({ file, reason: page.refused, snippet: REMOVE_TAG_SNIPPET, part: "browser" }); continue; }
      if (page.text === null) continue;
      const r = removePageTag(file, page.text);
      if (!r.ok) pages.manual.push({ file, reason: r.reason, snippet: r.snippet, part: "browser" });
      else if (r.changed && parseCode(page.text, file) && !parseCode(r.code, file)) pages.manual.push({ file, reason: "The file would not parse without the tag.", snippet: REMOVE_TAG_SNIPPET, part: "browser" });
      else if (r.changed) pages.changes.push({ path: file, before: page.text, after: r.code, purpose: "browser part" });
    }
    const plan = bothParts(server, pages);
    // The package stays while the app's own code imports it (purchase() for orders, say).
    if (declared(io.read)["@parlox/server"]) {
      const kept = serverPackageKept(d.dir, io.read, plan, d.packageManager, io.others);
      if (kept) plan.warnings.push(kept);
      else plan.install = packageCommand(d.packageManager, "remove", ["@parlox/server"]);
    }
    return plan;
  },

  // No key and no hand-off for an app that reports with its own code.
  hostStep: (d) => d.parts.server?.kind === "hono",

  // Where the key is set on Workers: as a runtime secret (hosts.ts). Never on Pages, and never where another host's file
  // or another runtime says the app runs elsewhere (the target is then not Workers).
  handoffNotes: (d) => (onWorkers(d) ? [WORKERS_RUNTIME_SECRET] : []),

  hostNotes(d, host, role) {
    const data = d.data as HonoData;
    if (!role.server || d.parts.server?.kind !== "hono") return [];
    const cloudflare = data.target === "cloudflare-workers" || data.target === "cloudflare-pages";
    // On Node.js or Bun (or a runtime not detected) on a host that keeps the server running: the shutdown snippet.
    const shutdown = data.target === "nodejs" || data.target === "bun" || data.target === "unknown" ? shutdownNote(host) : null;
    return [
      // "Cloudflare Workers run before the cache" (developers.cloudflare.com/workers/reference/how-the-cache-works/,
      // opened 2026-10-01); elsewhere a cache in front can answer before the app does.
      ...(cloudflare ? [] : [CDN_NOTE]),
      ...(data.target === "aws-lambda" ? [LAMBDA_NOTE] : []),
      ...(cloudflare ? [CLOUDFLARE_NOTE] : []),
      // Workers keep build and runtime variables apart; Pages does not (hosts.ts).
      ...(onWorkers(d) ? [WORKERS_RUNTIME_SECRET] : []),
      // The pure-API note: nothing in the app takes a browser part (pages that already have a tag are said instead).
      ...(role.unitHasBrowser || data.tagAlready ? [] : [NO_PAGES]),
      // Only where the wizard plans the server part (a withheld one has no local variables to talk about).
      ...data.envNotes,
      ...(shutdown ? [shutdown] : []),
    ];
  },
};

/** The server part and the browser part as one plan; a file both change is one change, for both parts. */
function bothParts(server: Plan, pages: Plan): Plan {
  const plan = combinePlans(server, pages);
  for (const c of plan.changes) if (server.changes.some((s) => s.path === c.path) && pages.changes.some((p) => p.path === c.path)) c.purpose = "server and browser parts";
  return plan;
}

/** The server part: `app.use(parlox())` in the app file, and the package. */
function planServer(pm: PackageManager, data: HonoData, input: PlanInput, plan: Plan): void {
  planUseLine(pm, { kind: "hono", source: SOURCE, file: data.appFile, placeholder: "your Hono app file", reason: data.reason, notFound: NOT_FOUND, pkgType: data.pkgType, ownReport: data.ownReport, ownReportNotChecked: data.ownReportNotChecked }, input, plan);
}

/** The browser part: the pinned tag in the layout (shown in the diff), or a step by hand. The tag needs no package. */
function planLayout(data: HonoData, input: PlanInput, plan: Plan): void {
  const pk = input.publicKey;
  if (data.tagAlready) return;
  if (data.layoutReason) { plan.manual.push({ file: "your page layout", reason: data.layoutReason, snippet: htmlSnippet(pk), part: "browser", placeholder: true }); return; }
  const file = data.layout;
  if (!file) return;
  const snippet = jsxSnippet(pk, data.layoutJsx);
  const got = tryRead(input.read, file);
  if ("refused" in got) { plan.manual.push({ file, reason: got.refused, snippet, part: "browser" }); return; }
  if (got.text === null) return;
  if (input.git.isRepo() && input.git.isIgnored(file)) { plan.manual.push({ file, reason: ignoredReason(file, "the tag"), snippet, part: "browser" }); return; }
  if (!headsIn(got.text, file)?.length && plainHead(got.text, file)) { plan.manual.push({ file, reason: PLAIN, snippet: htmlSnippet(pk), part: "browser" }); return; }
  const e = addPageTag(file, got.text, pk, data.layoutJsx);
  if (!e.ok) plan.manual.push({ file, reason: e.reason, snippet: e.snippet, part: "browser" });
  else {
    if (e.changed) plan.changes.push({ path: file, before: got.text, after: e.code, purpose: "browser part" });
    if (e.warning) plan.warnings.push(`${file}: ${e.warning}`);
  }
}
