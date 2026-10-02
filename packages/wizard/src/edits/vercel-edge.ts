import { posix } from "node:path";
import { declared, type FileChange, type Plan } from "../plan-core.js";
import { VERCEL_FUNCTIONS_VERSION } from "../versions.js";
import { hasDep } from "../workspace.js";
import { addImportLine, applySplices, endsLine, identifierUse, parseCode, removeStatement, SpliceError, startsLine, styleOf, topLevelNames, walk, type Ast, type Node, type SpliceEdit } from "./splice.js";

// Vercel Routing Middleware for a static site on Vercel: Vercel runs a middleware.ts or middleware.js next
// to package.json, or the file vercel.json's proxy.entrypoint names, for any framework without its own routing
// middleware. The matcher keeps it off static assets (Vite builds them into /assets/) and Vercel's own /_vercel/ paths
// (analytics, speed insights), because Routing Middleware otherwise "will be invoked for every route in your project",
// and each run is billed. It is the matcher @parlox/server's README shows for this adapter, character for character.

export const VERCEL_MATCHER = "/((?!assets/|_vercel/|favicon\\.ico|.*\\.(?:png|jpe?g|gif|svg|webp|avif|ico|css|js|map|woff2?)$).*)";

export const vercelMiddlewareTemplate = (): string => `import { next } from "@vercel/functions";
import { withParlox } from "@parlox/server/vercel";

export default withParlox({ next });
export const config = { matcher: [${JSON.stringify(VERCEL_MATCHER)}] };
`;

const SOURCE = "@parlox/server/vercel";
const NEXT_SOURCE = "@vercel/functions";
const PARLOX_SERVER = /^@parlox\/server(\/|$)/;
// The only text the wrap inserts around the default export; removal takes out exactly these two pieces.
const WRAP_OPEN = "withParlox(";
const WRAP_CLOSE = ", { next })";
// The withParlox line as the wizard writes it: the file's own quote and semicolon, which its next line shares.
const OUR_LINE = /^import \{ withParlox \} from (["'])@parlox\/server\/vercel\1(;?)$/;
const ROOT_FILES = ["middleware.ts", "middleware.js"];

const SNIPPET = `import { next } from "@vercel/functions";\nimport { withParlox } from "@parlox/server/vercel";\n\n// wrap your middleware's default export:\nexport default withParlox(yourMiddleware, { next });`;
const REMOVE_SNIPPET = "Remove withParlox(…, { next }) and its import by hand.";
const LEFTOVER_SNIPPET = "Remove the line named above by hand, unless something else in the file needs it.";
const MATCHER_WARNING = "This file has its own matcher. Parlox's server part only runs where it matches: make sure it includes /.well-known/parlox-verify and your pages.";
const PROXY_MATCHER_WARNING = "This file sets proxy.matcher. Parlox's server part only runs where it matches: make sure it includes /.well-known/parlox-verify and your pages.";
const PURPOSE = "server part (Vercel Routing Middleware)";

const lineOf = (n: Node): number => n.loc?.start?.line ?? 0;

/** vercel.json as an object; null when there is none; a string saying why it cannot be read as one. */
function vercelJson(read: (rel: string) => string | null): Record<string, any> | string | null {
  const text = read("vercel.json");
  if (text === null) return null;
  let json: unknown;
  try { json = JSON.parse(text.replace(/^\uFEFF/, "")); } catch { return "vercel.json is not valid JSON"; }
  return json !== null && typeof json === "object" && !Array.isArray(json) ? (json as Record<string, any>) : "vercel.json is not a JSON object";
}

// Storybook's build command: `storybook build` (Storybook 7 and later, also run through npx or with a version) or
// `build-storybook` (Storybook 6).
const STORYBOOK_BUILD = /(?:^|[\s;&|(])(?:storybook(?:@\S+)?\s+build|build-storybook)(?=$|[\s;&|)])/;

/**
 * Why a root middleware would not run here, or null. Vercel: "You can't use `proxy` with frameworks that build their
 * own routing middleware, such as Next.js and Astro"; vercel/vercel frameworks.ts gives Storybook
 * disableRootMiddleware. A `storybook` package alone is not a Storybook deployment (frameworks.ts: "Storybook is a
 * devDependency of many apps that deploy something else entirely"), so only a project that deploys Storybook is
 * refused: its build script runs Storybook's build, or vercel.json sets "framework": "storybook".
 */
export function edgeRefusal(pkg: Record<string, any>, read: (rel: string) => string | null): string | null {
  if (hasDep(pkg, "next")) return "Next.js builds its own middleware (the wizard's Next.js install covers it).";
  if (hasDep(pkg, "astro")) return "Astro builds its own routing middleware, so Vercel does not run a root middleware file here.";
  const build = pkg.scripts?.build;
  if (typeof build === "string" && STORYBOOK_BUILD.test(build)) return "The build script runs Storybook's build, and Vercel builds Storybook projects without a root middleware (disableRootMiddleware), so the file might never run.";
  const vercel = vercelJson(read);
  if (vercel !== null && typeof vercel === "object" && vercel.framework === "storybook") return "vercel.json sets \"framework\": \"storybook\", and Vercel builds Storybook projects without a root middleware (disableRootMiddleware), so the file would not run.";
  return null;
}

interface Proxy { entry: string | null; matcher: boolean; problem: string | null }

/** vercel.json's proxy setting. Vercel: "entrypoint (required): The path to your Routing Middleware file, relative to
 * your project root. Must end in .js or .ts"; "matcher (optional)". Anything the wizard cannot read for certain is a
 * problem, never a guess. */
function proxyOf(read: (rel: string) => string | null): Proxy {
  const none: Proxy = { entry: null, matcher: false, problem: null };
  const problem = (why: string): Proxy => ({ ...none, problem: why });
  const json = vercelJson(read);
  if (json === null) return none;
  if (typeof json === "string") return problem(`${json}, so the wizard cannot tell which file Vercel runs as the middleware.`);
  const proxy = json.proxy;
  if (proxy === undefined || proxy === null) return none;
  if (typeof proxy !== "object" || Array.isArray(proxy)) return problem("vercel.json's proxy setting is not an object with an entrypoint, so the wizard cannot tell which file Vercel runs.");
  const entry = proxy.entrypoint;
  if (typeof entry !== "string" || !entry.trim()) return problem("vercel.json's proxy setting has no entrypoint file path (Vercel requires one).");
  const rel = posix.normalize(entry.trim());
  if (posix.isAbsolute(rel) || rel === ".." || rel.startsWith("../") || rel.includes("\\") || /^[A-Za-z]:/.test(rel)) return problem("vercel.json's proxy.entrypoint is not a relative path inside this folder, so the wizard does not edit it.");
  if (!/\.(js|ts)$/.test(rel)) return problem("vercel.json's proxy.entrypoint does not end in .js or .ts, which Vercel requires, so Vercel would not build it.");
  return { entry: rel, matcher: proxy.matcher !== undefined, problem: null };
}

/** Which file the Vercel server part goes in: vercel.json's proxy.entrypoint (which may not exist yet), else the one
 * of middleware.ts and middleware.js that exists (null: neither does), or why the wizard edits none. */
type Target = { file: string | null; matcher: boolean; problem: null } | { file: null; matcher: boolean; problem: { file: string; reason: string } };
function targetOf(read: (rel: string) => string | null): Target {
  const proxy = proxyOf(read);
  if (proxy.problem) return { file: null, matcher: false, problem: { file: "vercel.json", reason: proxy.problem } };
  if (proxy.entry) return { file: proxy.entry, matcher: proxy.matcher, problem: null };
  const present = ROOT_FILES.filter((f) => read(f) !== null);
  if (present.length > 1) return { file: null, matcher: false, problem: { file: present[0], reason: `Both ${present.join(" and ")} exist, and Vercel runs one middleware file; the wizard cannot tell which.` } };
  return { file: present[0] ?? null, matcher: false, problem: null };
}

/** The file planVercelEdge wraps, or creates at vercel.json's proxy.entrypoint: that entrypoint, else middleware.ts or
 * middleware.js. null when there is none, and when planVercelEdge edits no file (vercel.json cannot be read, or both
 * root files exist). */
export function existingMiddleware(read: (rel: string) => string | null): string | null {
  return targetOf(read).file;
}

const defaultExport = (ast: Ast): Node | undefined => ast.program.body.find((s) => s.type === "ExportDefaultDeclaration");
const isWrap = (n: Node | null | undefined): boolean => n?.type === "CallExpression" && n.callee.type === "Identifier" && n.callee.name === "withParlox";
const plainSpecifier = (sp: Node, name: string): boolean =>
  sp.type === "ImportSpecifier" && sp.importKind !== "type" && (sp.imported.name ?? sp.imported.value) === name && sp.local.name === name;
/** A value import of `name` (not renamed) from `source`. */
const valueImport = (ast: Ast, source: string, name: string): Node | undefined =>
  ast.program.body.find((s) => s.type === "ImportDeclaration" && s.importKind !== "type" && s.source.value === source && s.specifiers.some((sp: Node) => plainSpecifier(sp, name)));
/** Exactly `import { name } from "source"`, the line the wizard writes. */
const onlyImport = (s: Node | undefined, source: string, name: string): boolean =>
  s?.type === "ImportDeclaration" && s.importKind !== "type" && s.source.value === source && s.specifiers.length === 1 && plainSpecifier(s.specifiers[0], name);

/** The first place the file loads @parlox/server (an import or re-export, require(), import(), import = require()),
 * other than `except`. */
function parloxUse(ast: Ast, except?: Node): Node | null {
  let found: Node | null = null;
  const named = (lit: Node | undefined) => lit?.type === "StringLiteral" && PARLOX_SERVER.test(lit.value);
  walk(ast.program, (n) => {
    if (found || n === except) return;
    if ((n.type === "ImportDeclaration" || n.type === "ExportNamedDeclaration" || n.type === "ExportAllDeclaration") && named(n.source)) found = n;
    else if (n.type === "CallExpression" && ((n.callee.type === "Identifier" && n.callee.name === "require") || n.callee.type === "Import") && named(n.arguments[0])) found = n;
    else if (n.type === "ImportExpression" && named(n.source)) found = n;
    else if (n.type === "TSExternalModuleReference" && named(n.expression)) found = n;
  });
  return found;
}

/** The first identifier of that name anywhere (imports included), for a reason that names its line. */
function mention(ast: Ast, name: string): Node | null {
  let found: Node | null = null;
  walk(ast.program, (n) => { if (!found && n.type === "Identifier" && n.name === name) found = n; });
  return found;
}

/** Whether the file exports a config the wizard cannot prove has no matcher. */
function hasOwnMatcher(ast: Ast): boolean {
  for (const s of ast.program.body) {
    if (s.type !== "ExportNamedDeclaration") continue;
    if (s.specifiers?.some((sp: Node) => (sp.exported?.name ?? sp.exported?.value) === "config")) return true;
    if (s.declaration?.type !== "VariableDeclaration") continue;
    for (const d of s.declaration.declarations) {
      if (d.id?.name !== "config") continue;
      if (d.init?.type !== "ObjectExpression") return true;
      if (d.init.properties.some((p: Node) => p.type === "SpreadElement" || p.computed || (p.key?.name ?? p.key?.value) === "matcher")) return true;
    }
  }
  return false;
}

const WRAPPABLE = new Set(["Identifier", "MemberExpression", "CallExpression", "ArrowFunctionExpression", "FunctionExpression", "FunctionDeclaration"]);

/** Whether `out` is `code` with its default export wrapped exactly as the wizard means: withParlox(<the same text>,
 * { next }). A line after a wrapped function declaration that starts with ( [ ` + - or / would have joined onto it. */
function wrapsAsMeant(out: string, file: string, inner: string): boolean {
  const ast = parseCode(out, file);
  const call = ast ? defaultExport(ast)?.declaration : null;
  if (!isWrap(call) || call.arguments.length !== 2) return false;
  const [a] = call.arguments;
  return out.slice(call.start, a.start) === WRAP_OPEN && out.slice(a.start, a.end) === inner && out.slice(a.end, call.end) === WRAP_CLOSE;
}

function addLine(code: string, file: string, line: string): string {
  const ast = parseCode(code, file);
  if (!ast) throw new SpliceError("The file would not parse once wrapped.");
  return addImportLine(code, ast, line);
}

/** Wraps the file's default export: `export default withParlox(<what was there>, { next })`, with the two imports as
 * new lines below the last import (the `next` import right below the withParlox one, and only when the file does not
 * import `next` from @vercel/functions already). Offered only when removeVercelEdge gives back this exact text. */
export function addVercelEdge(code: string, file: string): SpliceEdit {
  const refuse = (reason: string): SpliceEdit => ({ ok: false, reason, snippet: SNIPPET });
  const ast = parseCode(code, file);
  if (!ast) return refuse("The wizard could not read this file.");
  const def = defaultExport(ast);
  const d: Node | undefined = def?.declaration;
  // A file that already uses @parlox/server is left as it is, unless it is the wizard's own wrap: a second withParlox
  // (or withParlox beside another adapter) would report every visit twice.
  const parlox = parloxUse(ast);
  if (parlox) {
    return valueImport(ast, SOURCE, "withParlox") && isWrap(d) ? { ok: true, code, changed: false } : refuse(`This file already uses @parlox/server (line ${lineOf(parlox)}), but its default export is not wrapped with withParlox; the wizard leaves it as it is, so visits are not reported twice.`);
  }
  if (!d) {
    const listed = ast.program.body.some((s) => s.type === "ExportNamedDeclaration" && s.specifiers?.some((sp: Node) => (sp.exported?.name ?? sp.exported?.value) === "default"));
    return refuse(listed ? "The default export is given in an export list (export { … as default }); the wizard wraps only an `export default …` statement." : "No default export found (Vercel runs the middleware's default export).");
  }
  if (!WRAPPABLE.has(d.type)) return refuse("The default export is not a function the wizard can wrap.");
  // Once wrapped, a function declaration becomes an expression: its name then exists only inside its own body.
  const own = d.type === "FunctionDeclaration" && d.id ? identifierUse(ast, d.id.name, d) : null;
  if (own) return refuse(`The function ${d.id.name} is also used on line ${lineOf(own)}; wrapping it would hide that name.`);
  const names = topLevelNames(ast);
  const nextImported = !!valueImport(ast, NEXT_SOURCE, "next");
  if (!nextImported && names.has("next")) return refuse(`This file already has something named next (line ${lineOf(mention(ast, "next")!)}), so next cannot be imported from @vercel/functions.`);
  if (names.has("withParlox")) return refuse(`This file already has something named withParlox (line ${lineOf(mention(ast, "withParlox")!)}).`);
  // The uninstall takes out the wizard's `next` import only when nothing else uses the name, and withParlox only when
  // the wrap is its one use; these checks do not follow scopes, so a local of either name stops the wrap here, with its
  // line, rather than later as an uninstall that cannot be exact.
  const localNext = nextImported ? null : identifierUse(ast, "next");
  if (localNext) return refuse(`This file uses the name next on line ${lineOf(localNext)}; the wizard's own import of next could not be told apart from it on uninstall.`);
  const localWrap = identifierUse(ast, "withParlox");
  if (localWrap) return refuse(`This file uses the name withParlox on line ${lineOf(localWrap)}; the wizard's withParlox could not be told apart from it on uninstall.`);
  const { q, semi } = styleOf(code, ast);
  let out: string;
  try {
    out = applySplices(code, [{ start: d.start, end: d.start, text: WRAP_OPEN }, { start: d.end, end: d.end, text: WRAP_CLOSE }]);
    out = addLine(out, file, `import { withParlox } from ${q}${SOURCE}${q}${semi}`);
    if (!nextImported) out = addLine(out, file, `import { next } from ${q}${NEXT_SOURCE}${q}${semi}`);
  } catch (err) {
    if (err instanceof SpliceError) return refuse(err.message);
    throw err;
  }
  if (!wrapsAsMeant(out, file, code.slice(d.start, d.end))) return refuse("Once wrapped, the default export would not read as meant: the line after it would join onto the wrap.");
  const back = removeVercelEdge(out, file);
  if (!back.ok || back.code !== code || back.warning) return refuse("The wizard could not wrap the default export in a way it can take out again exactly.");
  return { ok: true, code: out, changed: true, ...(hasOwnMatcher(ast) ? { warning: MATCHER_WARNING } : {}) };
}

/** The file the wizard created from the template, also after a checkout that turned its line breaks into CRLF or an
 * editor that saved it with a byte-order mark. */
const isTemplate = (code: string): boolean => code.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n") === vercelMiddlewareTemplate();

/** The exact inverse of addVercelEdge; a file the wizard created from the template is deleted. What it cannot take out
 * exactly is a manual step; what it leaves in a file it did change (a next import it cannot prove is its own, another
 * @parlox/server import) is named in `warning`, which unplanVercelEdge makes a manual step. */
export function removeVercelEdge(code: string, file: string): SpliceEdit & { deleteFile?: boolean } {
  if (isTemplate(code)) return { ok: true, code: "", changed: true, deleteFile: true };
  const manual = (reason: string): SpliceEdit => ({ ok: false, reason, snippet: REMOVE_SNIPPET });
  const ast = parseCode(code, file);
  if (!ast) return manual("The wizard could not read this file.");
  try {
    const call: Node | undefined = defaultExport(ast)?.declaration;
    if (!valueImport(ast, SOURCE, "withParlox") || !isWrap(call)) {
      // Not the wizard's wrap. Any other use of @parlox/server stays, and is named: the uninstall removes the package.
      const use = parloxUse(ast);
      if (!use) return { ok: true, code, changed: false };
      return manual(`Line ${lineOf(use)} uses @parlox/server in a way the wizard does not write (it wraps the default export with withParlox(…, { next })), so the wizard leaves it; remove Parlox from this file by hand.`);
    }
    if (call!.arguments.length === 1) return manual("This file is not the middleware the wizard creates as it was written (it was changed since); remove it, or its withParlox line, by hand.");
    const inner: Node = call!.arguments[0];
    if (call!.arguments.length !== 2 || code.slice(call!.start, inner.start) !== WRAP_OPEN || code.slice(inner.end, call!.end) !== WRAP_CLOSE) {
      return manual("The withParlox(…, { next }) wrap was changed after the wizard added it.");
    }
    const unwrapped = applySplices(code, [{ start: call!.start, end: inner.start, text: "" }, { start: inner.end, end: call!.end, text: "" }]);
    const ast2 = parseCode(unwrapped, file);
    if (!ast2) return manual("The file would not parse without the wrap.");
    const wrapUse = identifierUse(ast2, "withParlox");
    if (wrapUse) return manual(`withParlox is also used on line ${lineOf(wrapUse)} of this file.`);
    const body = ast2.program.body;
    const i = body.findIndex((s) => onlyImport(s, SOURCE, "withParlox"));
    if (i < 0) return manual("The withParlox import was changed after the wizard added it.");
    const ours = body[i];
    const notes: string[] = [];
    // The `next` import goes only when it is the line the wizard writes (its withParlox line's quote and semicolon),
    // right below that line, and nothing uses next any more. Otherwise it stays, and the note says why.
    const style = OUR_LINE.exec(unwrapped.slice(ours.start, ours.end));
    const nextLine = style ? `import { next } from ${style[1]}${NEXT_SOURCE}${style[1]}${style[2]}` : null;
    const below = body[i + 1];
    const adjacent = onlyImport(below, NEXT_SOURCE, "next") && /^\r?\n$/.test(unwrapped.slice(ours.end, below.start)) && startsLine(unwrapped, ours.start) && endsLine(unwrapped, below.end);
    const nextUse = identifierUse(ast2, "next");
    let out = unwrapped;
    if (adjacent) {
      const written = unwrapped.slice(below.start, below.end) === nextLine;
      if (written && !nextUse) out = removeStatement(out, below);
      else notes.push(`The import of next from @vercel/functions on line ${lineOf(below)} stays: ${nextUse ? `next is used on line ${lineOf(nextUse)}` : "it is not written the way the wizard writes it"}. If the wizard added it and nothing needs it, remove it.`);
    } else if (!nextUse) {
      // The wizard writes its next line right below its withParlox line; one further down (a line was put between) may
      // be the wizard's. One above is the project's own (the withParlox line goes below the last import).
      const stray = body.slice(i + 1).find((s) => onlyImport(s, NEXT_SOURCE, "next"));
      if (stray) notes.push(`The import of next from @vercel/functions on line ${lineOf(stray)} stays: it is not right below the withParlox import, so the wizard cannot tell whether it added it. Nothing in the file uses next; remove it if nothing else needs it.`);
    }
    out = removeStatement(out, ours);
    const left = parloxUse(ast2, ours);
    if (left) notes.push(`Line ${lineOf(left)} still uses @parlox/server; the uninstall removes the package, so remove that line by hand.`);
    return { ok: true, code: out, changed: true, ...(notes.length ? { warning: notes.join(" ") } : {}) };
  } catch (err) {
    if (err instanceof SpliceError) return manual(err.message);
    throw err;
  }
}

export interface EdgeResult { changes: FileChange[]; manual: Plan["manual"]; warnings: string[]; packages: string[] }

/** Why the wizard will not create `path` from the template, or null. The template uses import statements: in a .js
 * file they need an ES module package (Vercel: "you must either add "type": "module" to your package.json or change
 * your JavaScript Functions' file extensions from .js to .mjs", and a middleware file must end in .js or .ts). */
function createRefusal(path: string, read: (rel: string) => string | null): string | null {
  if (path.endsWith(".ts")) return null;
  let type: unknown;
  try { type = JSON.parse(read("package.json") ?? "{}")?.type; } catch { type = undefined; }
  return type === "module" ? null : `package.json has no "type": "module", which Vercel needs for a JavaScript middleware with import statements. Add "type": "module" to package.json and run the wizard again, or save this as a .ts file.`;
}

/** The Vercel server part for a static site: the middleware file (created, or the existing one wrapped) and the
 * packages to add. The caller has checked edgeRefusal. */
export function planVercelEdge(read: (rel: string) => string | null, typescript: boolean, serverVersion: string): EdgeResult {
  const out: EdgeResult = { changes: [], manual: [], warnings: [], packages: [] };
  const manual = (file: string, reason: string, snippet = SNIPPET) => out.manual.push({ file, reason, snippet, part: "server" });
  const target = targetOf(read);
  if (target.problem) manual(target.problem.file, target.problem.reason);
  else {
    const before = target.file ? read(target.file) : null;
    if (before === null) {
      const path = target.file ?? (typescript ? "middleware.ts" : "middleware.js");
      const why = target.matcher ? "vercel.json sets proxy.matcher, and the new file would bring its own matcher (Vercel takes one or the other)." : createRefusal(path, read);
      if (why) manual(path, why, vercelMiddlewareTemplate());
      else out.changes.push({ path, before: null, after: vercelMiddlewareTemplate(), purpose: PURPOSE });
    } else {
      const file = target.file!;
      const e = addVercelEdge(before, file);
      if (!e.ok) manual(file, e.reason, e.snippet);
      else if (e.changed) {
        out.changes.push({ path: file, before, after: e.code, purpose: PURPOSE });
        if (e.warning) out.warnings.push(`${file}: ${e.warning}`);
        if (target.matcher) out.warnings.push(`vercel.json: ${PROXY_MATCHER_WARNING}`);
      }
    }
  }
  const have = declared(read);
  if (have["@parlox/server"] !== serverVersion) out.packages.push(`@parlox/server@${serverVersion}`);
  if (!have["@vercel/functions"]) out.packages.push(`@vercel/functions@${VERCEL_FUNCTIONS_VERSION}`);
  return out;
}

/** Undoes planVercelEdge's file change (packages are the caller's): in the file vercel.json names, else in
 * middleware.ts and middleware.js. Whatever holds Parlox and is not taken out is a manual step. */
export function unplanVercelEdge(read: (rel: string) => string | null): { changes: FileChange[]; manual: Plan["manual"] } {
  const out: { changes: FileChange[]; manual: Plan["manual"] } = { changes: [], manual: [] };
  const proxy = proxyOf(read);
  // A step only if Parlox is there: vercel.json does not say which file is the middleware, or the file does not parse
  // and names no Parlox package (uninstall, apps.ts parloxIn).
  if (proxy.problem) out.manual.push({ file: "vercel.json", reason: `${proxy.problem} If the middleware it names holds withParlox, remove it there by hand.`, snippet: REMOVE_SNIPPET, part: "server", unread: true });
  for (const file of proxy.entry ? [proxy.entry] : ROOT_FILES) {
    const code = read(file);
    if (code === null) continue;
    const r = removeVercelEdge(code, file);
    if (!r.ok) out.manual.push({ file, reason: r.reason, snippet: r.snippet, part: "server", ...(code.includes("@parlox/server") ? {} : { unread: true }) });
    else {
      if (r.changed) out.changes.push({ path: file, before: code, after: r.deleteFile ? null : r.code, purpose: PURPOSE });
      if (r.warning) out.manual.push({ file, reason: r.warning, snippet: LEFTOVER_SNIPPET, part: "server" });
    }
  }
  // A root middleware the wizard made before vercel.json named another file: Vercel builds that file instead.
  if (proxy.entry) {
    for (const file of ROOT_FILES.filter((f) => f !== proxy.entry)) {
      const code = read(file);
      if (code === null) continue;
      const ast = isTemplate(code) ? null : parseCode(code, file);
      if (isTemplate(code) || (ast && parloxUse(ast))) {
        out.manual.push({ file, reason: `${file} holds Parlox's middleware, but vercel.json's proxy.entrypoint names ${proxy.entry} as the middleware file, so the wizard leaves ${file} as it is. Delete it, or remove withParlox from it, by hand.`, snippet: REMOVE_SNIPPET, part: "server" });
      }
    }
  }
  return out;
}
