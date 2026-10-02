import { readdirSync } from "node:fs";
import { join, posix } from "node:path";
import { compiledDirs, compiledIn } from "../scripts.js";
import { foreignTagLine, foreignTagWarning, htmlHeads, isHtmlPage, isPugPage, MARKER_TEXT, pugHeads } from "./head-tag.js";
import { parseCode, walk, type Node } from "./splice.js";

// Which pages an Express app serves, read from its server file: app.set("view engine", …) and app.set("views", …) give
// the views folder, and app.use(express.static(dir)) the static folders. Every template in the views folder and every
// .html file in a static folder is read: each one with a single <head> (a layout, a page, a partial that holds the
// head) gets the tag, up to MAX_PAGES in the app; a page the wizard cannot edit is a step by hand; a fragment (a view
// that extends a layout, a partial, no <html>, doctype or <body>) is left alone. A Parlox tag the wizard did not write
// anywhere in the views (a child view, a partial) means no tag is added to them. A value computed in code cannot be
// followed: that part is a snippet. Build output (dist/, build/, out/, tsconfig's outDir, dot-folders: scripts.ts, and
// another build's output folder) is never edited, as for the server file.

export const HTML_ENGINES = new Set(["ejs", "hbs", "handlebars", "html", "htm", "mustache", "njk", "nunjucks", "eta", "liquid"]);
export const PUG_ENGINES = new Set(["pug", "jade"]);
/** The most pages the wizard edits in one app (each shown in the diff). */
export const MAX_PAGES = 20;
/** Pages deeper than this many folders below a views or static folder are named as steps by hand, not edited. */
export const MAX_DEPTH = 5;
/** The most folders looked through below one views or static folder. */
export const MAX_FOLDERS = 500;
/** The most page files read in one app (fragments too). */
const MAX_READS = 2000;
/** The files a page may be: what uninstall reads in the views and static folders. */
const PAGE_FILE = new RegExp(`\\.(?:${["html", "htm", ...HTML_ENGINES, ...PUG_ENGINES].join("|")})$`, "i");

export interface ExpressPages {
  engine: string | null;
  views: string | null;
  files: string[];
  /** What the developer adds by hand, and why; `pug`: in a Pug template (the snippet is written in Pug). */
  manual: Array<{ file: string; reason: string; pug?: boolean }>;
  /** Parlox tags the wizard did not write, by file and line, and what the wizard left out because of them. */
  warnings: string[];
  /** For the report: pages with no <head> of their own that take it from a partial the wizard tags. */
  notes: string[];
  /** The views and static folders the pages come from: uninstall looks through all of them. */
  folders: string[];
  summary: string | null;
}

const inside = (p: string) => !(p === ".." || p.startsWith("../") || posix.isAbsolute(p));
const isDirname = (n: Node | undefined) => (n?.type === "Identifier" && n.name === "__dirname") || (n?.type === "MemberExpression" && n.object?.type === "MetaProperty" && n.property?.name === "dirname");

const relOf = (base: string, values: string[], outside = false): string | "unknown" => {
  const p = posix.normalize(posix.join(base, ...values.map((x) => x.replace(/\\/g, "/")))).replace(/\/$/, "");
  return posix.isAbsolute(p) || /^[A-Za-z]:/.test(p) || (!outside && !inside(p)) ? "unknown" : p;
};
const isImportMetaUrl = (n: Node | undefined) => n?.type === "MemberExpression" && n.object?.type === "MetaProperty" && n.property?.name === "url";
const calleeName = (c: Node | undefined): string | null => (c?.type === "MemberExpression" ? c.property?.name ?? null : c?.type === "Identifier" ? c.name : null);
const plainParts = (values: string[]) => values.every((v) => !/^(?:[A-Za-z]:)?[\\/]/.test(v));

/** A folder given relative to the file it is written in, or null when `n` is not written that way: __dirname (or
 * import.meta.dirname) itself, path.join/resolve(__dirname, "…"), __dirname + "/…", `${__dirname}/…`, and
 * fileURLToPath(new URL("…", import.meta.url)). "unknown": that form, with a part the wizard cannot follow. With
 * `outside`, the folder may lie above the file's own (a Vite config's "../public"). */
export function fileRelative(n: Node | undefined, fileDir: string, outside = false): string | "unknown" | null {
  if (!n) return null;
  const from = (values: string[]) => (plainParts(values) ? relOf(fileDir || ".", values, outside) : "unknown");
  if (isDirname(n)) return from([]);
  // __dirname + "/public": the string goes on the end of the folder's name, so it must start with a separator.
  const after = (v: unknown) => (typeof v === "string" && /^[\\/]/.test(v) ? from([v.replace(/^[\\/]+/, "")]) : "unknown");
  if (n.type === "BinaryExpression" && n.operator === "+" && isDirname(n.left)) return after(n.right.type === "StringLiteral" ? n.right.value : null);
  if (n.type === "TemplateLiteral" && n.expressions.length === 1 && isDirname(n.expressions[0]) && n.quasis[0].value.cooked === "") return after(n.quasis[1].value.cooked);
  const fn = n.type === "CallExpression" ? calleeName(n.callee) : null;
  if ((fn === "join" || fn === "resolve") && isDirname(n.arguments[0])) {
    const rest = (n.arguments as Node[]).slice(1);
    if (!rest.every((a) => a.type === "StringLiteral")) return "unknown";
    // resolve() starts again at an absolute part; join() does not.
    return fn === "resolve" ? from(rest.map((a) => a.value)) : from(rest.map((a) => a.value.replace(/^[\\/]+/, "")));
  }
  if (fn === "fileURLToPath" && n.arguments.length === 1) {
    const u = n.arguments[0];
    if (u?.type !== "NewExpression" || calleeName(u.callee) !== "URL" || u.arguments.length !== 2 || !isImportMetaUrl(u.arguments[1])) return "unknown";
    const [url] = u.arguments;
    // A URL relative to the file's own: no scheme, no leading slash, no escapes, query or fragment.
    return url.type === "StringLiteral" && !/^[a-z][\w+.-]*:|^\/|[%?#\\]/i.test(url.value) ? from([url.value]) : "unknown";
  }
  return null;
}

/** A folder an Express call names: a string literal (relative to where the app starts, taken to be its package folder),
 * a folder relative to the server file (fileRelative), or path.join/resolve of literals; "unknown" for anything else,
 * or a folder outside the app. */
export function pathOf(n: Node | undefined, fileDir: string): string | "unknown" {
  if (!n) return "unknown";
  if (n.type === "StringLiteral") return relOf(".", [n.value]);
  const own = fileRelative(n, fileDir);
  if (own !== null) return own;
  const fn = n.type === "CallExpression" ? calleeName(n.callee) : null;
  if (fn !== "join" && fn !== "resolve") return "unknown";
  const parts = n.arguments as Node[];
  if (!parts.every((a) => a.type === "StringLiteral")) return "unknown";
  if (fn === "resolve" && !plainParts(parts.map((a) => a.value))) return "unknown";
  return relOf(".", parts.map((a) => a.value));
}

export interface WalkedFile { rel: string; depth: number }

/** The files below `rel` whose name `accept`s, with their depth (0: in `rel` itself), breadth first and by name; dot
 * folders, node_modules and folders reached through a link are skipped. At most `maxFolders` folders are opened
 * (`capped`: there were more). */
export function walkFiles(dir: string, rel: string, accept: (name: string) => boolean, maxFolders = MAX_FOLDERS): { files: WalkedFile[]; capped: boolean } {
  const files: WalkedFile[] = [];
  const queue: WalkedFile[] = [{ rel, depth: 0 }];
  let opened = 0;
  while (queue.length) {
    if (opened >= maxFolders) return { files, capped: true };
    const folder = queue.shift()!;
    opened++;
    let entries;
    try { entries = readdirSync(join(dir, folder.rel), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)); }
    catch { continue; }
    for (const e of entries) {
      if (e.name.startsWith(".") || e.name === "node_modules") continue;
      const r = folder.rel === "." ? e.name : `${folder.rel}/${e.name}`;
      if (e.isDirectory()) queue.push({ rel: r, depth: folder.depth + 1 });
      else if ((e.isFile() || e.isSymbolicLink()) && accept(e.name)) files.push({ rel: r, depth: folder.depth });
    }
  }
  return { files, capped: false };
}

/** The .html files under `rel` (sorted, at most `limit` + 1, at most MAX_DEPTH folders deep). */
export const htmlFiles = (dir: string, rel: string, limit: number): string[] =>
  walkFiles(dir, rel, (n) => /\.html?$/i.test(n)).files.filter((f) => f.depth <= MAX_DEPTH).map((f) => f.rel).slice(0, limit + 1);

/** Every file in `folders` that may hold a tag the wizard wrote (its marker is in it), with no cap: what uninstall
 * reads. Build output is left out, as the install never writes there. */
export function markedFiles(dir: string, folders: string[], read: (rel: string) => string | null): string[] {
  const built = compiledDirs(read);
  const out = new Set<string>();
  for (const folder of folders) {
    for (const f of walkFiles(dir, folder, (n) => PAGE_FILE.test(n), Infinity).files) {
      if (!compiledIn(f.rel, built) && read(f.rel)?.includes(MARKER_TEXT)) out.add(f.rel);
    }
  }
  return [...out];
}

const BUILT = "is build output: the next build would replace a change there, so the wizard does not edit it. Add the tag to the page it is built from.";
const NO_OWN_HEAD = (what: string, show: string) => `${what}, so the wizard cannot tell whether ${show} the tag. If the head comes from a partial or a layout the wizard edited, nothing more is needed;`;
const listed = (files: string[]) => `${files.slice(0, MAX_PAGES).join(", ")}${files.length > MAX_PAGES ? `, and ${files.length - MAX_PAGES} more` : ""}`;

// The partials a template includes, by name, and where each engine looks for that name: next to the including file
// (EJS and Eta include(…), EJS 1's <% include … %>, Pug's include), in the views folder (Nunjucks and Liquid include and
// render), or as a registered partial in views/partials/ or views/ (Handlebars and Mustache {{> …}}, hbs and
// express-handlebars). A name computed in code is not followed.
const INCLUDES: Array<[RegExp, "file" | "views" | "partial"]> = [
  [/<%[-=~_]?\s*include\s*\(\s*(['"`])(?<name>[^'"`]+)\1/g, "file"],
  [/<%[-=]?\s*include\s+(?<name>[^\s%'"()]+)\s*-?%>/g, "file"],
  [/\{\{~?>\s*(?<name>[\w./-]+)/g, "partial"],
  [/\{%-?\s*(?:include|render)\s+(['"])(?<name>[^'"]+)\1/g, "views"],
];
const PUG_INCLUDE = /^[ \t]*include[ \t]+(?<name>[^\s:][^\s]*)[ \t]*$/gm;

/** The files `rel` may include, by the rules above (each name with and without one of `exts`). */
function includedBy(rel: string, text: string, folder: string, pug: boolean, exts: string[]): string[] {
  const out: string[] = [];
  const add = (p: string) => { for (const f of [p, ...exts.map((e) => `${p}.${e}`)]) out.push(posix.normalize(f)); };
  const found: Array<[string, "file" | "views" | "partial"]> = pug
    ? [...text.matchAll(PUG_INCLUDE)].map((m) => [m.groups!.name, "file"])
    : INCLUDES.flatMap(([re, from]) => [...text.matchAll(re)].map((m) => [m.groups!.name, from] as [string, "file" | "views" | "partial"]));
  for (const [name, from] of found) {
    if (from === "partial") { add(posix.join(folder, "partials", name)); add(posix.join(folder, name)); }
    else if (from === "views" || name.startsWith("/")) add(posix.join(folder, name));
    else add(posix.join(posix.dirname(rel), name));
  }
  return out;
}

/** The tagged file a page's head comes from, through its includes (and theirs), or null when the wizard cannot tell. */
function coveredThrough(page: string, texts: Map<string, string>, tagged: Set<string>, folder: string, pug: boolean, exts: string[]): string | null {
  const queue = [page];
  const seen = new Set(queue);
  while (queue.length && seen.size <= 50) {
    const f = queue.shift()!;
    for (const c of includedBy(f, texts.get(f) ?? "", folder, pug, exts)) {
      if (tagged.has(c)) return c;
      if (texts.has(c) && !seen.has(c)) { seen.add(c); queue.push(c); }
    }
  }
  return null;
}

/** `builtBy(folder)`: why a static folder is another build's output (a Vite build's outDir), or null. */
export function findExpressPages(dir: string, read: (rel: string) => string | null, serverFile: string, code: string, appName: string | null, builtBy: (folder: string) => string | null = () => null): ExpressPages {
  const out: ExpressPages = { engine: null, views: null, files: [], manual: [], warnings: [], notes: [], folders: [], summary: null };
  const ast = parseCode(code, serverFile);
  if (!ast || !appName) return out;
  const fileDir = posix.dirname(serverFile) === "." ? "" : posix.dirname(serverFile);
  const built = compiledDirs(read);
  let engine: string | null = null;
  let views: string | null = null;
  const statics: string[] = [];
  walk(ast.program, (n) => {
    if (n.type !== "CallExpression" || n.callee.type !== "MemberExpression" || n.callee.object?.type !== "Identifier" || n.callee.object.name !== appName) return;
    const method = n.callee.property?.name;
    const [a, b] = n.arguments as Node[];
    // Express adds the dot itself: "hbs" and ".hbs" (express-handlebars' own example) name the same extension.
    if (method === "set" && a?.type === "StringLiteral" && a.value === "view engine") engine = b?.type === "StringLiteral" ? b.value.replace(/^\./, "") : "unknown";
    if (method === "set" && a?.type === "StringLiteral" && a.value === "views") views = pathOf(b, fileDir);
    if (method === "use") for (const arg of n.arguments as Node[]) {
      if (arg.type === "CallExpression" && arg.callee.type === "MemberExpression" && arg.callee.property?.name === "static") statics.push(pathOf(arg.arguments[0], fileDir));
    }
  });

  const seen = new Set<string>();
  let reads = 0;
  let used = 0;
  const summary: string[] = [];
  /** One folder's pages: read, sorted into those to edit, steps by hand and fragments, then held to the app's cap. */
  const pagesIn = (folder: string, walked: ReturnType<typeof walkFiles>, pug: boolean, kind: "views" | "static", exts: string[]): string[] => {
    const edit: string[] = [], byHand: ExpressPages["manual"] = [], foreign: string[] = [], headless: string[] = [];
    const texts = new Map<string, string>();
    for (const f of walked.files) {
      if (seen.has(f.rel)) continue;
      seen.add(f.rel);
      if (++reads > MAX_READS) { byHand.push({ file: `${folder}/`, reason: `The wizard read ${MAX_READS} pages in this app and stopped: pages past those in ${folder}/ are not checked; add the tag to their <head> by hand.`, pug }); break; }
      const text = read(f.rel);
      if (text === null) { byHand.push({ file: f.rel, reason: "The wizard did not read this page (it is larger than 1 MB, or not a regular file).", pug }); continue; }
      texts.set(f.rel, text);
      const line = foreignTagLine(f.rel, text);
      if (line !== null) { foreign.push(`${f.rel}: ${foreignTagWarning(line)}`); continue; }
      const heads = (pug ? pugHeads(text) : htmlHeads(text)).length;
      if (heads === 1 && compiledIn(f.rel, built)) byHand.push({ file: f.rel, reason: `${f.rel} ${BUILT}`, pug });
      else if (heads === 1 && f.depth > MAX_DEPTH) byHand.push({ file: f.rel, reason: `This page is more than ${MAX_DEPTH} folders below ${folder}/, deeper than the wizard edits: add the tag to its <head> by hand.`, pug });
      else if (heads === 1) edit.push(f.rel);
      else if (!(pug ? isPugPage(text) : isHtmlPage(text))) continue;
      else if (heads > 1) byHand.push({ file: f.rel, reason: "This page has more than one <head>.", pug });
      else headless.push(f.rel);
    }
    if (walked.capped) byHand.push({ file: `${folder}/`, reason: `The wizard looked through ${MAX_FOLDERS} folders below ${folder}/ and stopped: pages past those are not checked; add the tag to their <head> by hand.`, pug });
    if (foreign.length) {
      // A view may show a tag from a partial or a child view: the views get no second one. A static page is whole.
      out.warnings.push(...(kind === "views" ? foreign.map((w) => `${w.replace(/\.$/, "")}, and the wizard adds no tag to the other views in ${folder}/, which may show it.`) : foreign));
      if (kind === "views") return [];
    }
    const fits = used + edit.length <= MAX_PAGES;
    // A view with no <head> of its own is covered when its head comes from a partial the wizard tags here (or tagged
    // already): a note. Otherwise the wizard cannot tell, and it is a step by hand.
    const tagged = new Set(fits ? edit : []);
    const via = new Map<string, string[]>();
    const unknown: string[] = [];
    for (const page of headless) {
      const partial = kind === "views" ? coveredThrough(page, texts, tagged, folder, pug, exts) : null;
      if (partial) via.set(partial, [...(via.get(partial) ?? []), page]);
      else unknown.push(page);
    }
    for (const [partial, pages] of via) out.notes.push(`${pages.sort().join(", ")}: covered through ${partial}, which holds ${pages.length === 1 ? "its" : "their"} <head> and the tag.`);
    if (unknown.length === 1) byHand.push({ file: unknown[0], reason: `${NO_OWN_HEAD("This page has no <head> of its own", "it shows")} otherwise add the tag to its <head>.`, pug });
    else if (unknown.length) byHand.push({ file: `${folder}/`, reason: `${NO_OWN_HEAD(`These pages have no <head> of their own (${listed(unknown)})`, "they show")} otherwise add the tag to each one's <head>.`, pug });
    out.manual.push(...byHand);
    if (!fits) {
      out.manual.push({ file: `${folder}/`, reason: `More than ${MAX_PAGES} ${kind === "views" ? "templates" : "HTML files"} with a <head> in this app (${listed(edit)}): add the tag to each page's <head>.`, pug });
      return [];
    }
    used += edit.length;
    out.files.push(...edit);
    return edit;
  };

  const e = engine as string | null;
  const v = views as string | null;
  if (e === "unknown") out.manual.push({ file: serverFile, reason: "The view engine is not named with a literal, so the wizard cannot tell which layout to edit." });
  else if (e) {
    out.engine = e;
    const pug = PUG_ENGINES.has(e);
    const viewsDir = v ?? "views";
    if (viewsDir === "unknown") out.manual.push({ file: serverFile, reason: "The views folder is computed in code, or outside the app's folder, so the wizard cannot find the layout.", pug });
    else if (!HTML_ENGINES.has(e) && !pug) out.manual.push({ file: `${viewsDir}/`, reason: `The wizard does not edit ${e} templates.` });
    else if (compiledIn(viewsDir, built)) out.manual.push({ file: `${viewsDir}/`, reason: `${viewsDir}/ ${BUILT}`, pug });
    else {
      out.views = viewsDir;
      out.folders.push(viewsDir);
      const before = out.manual.length + out.warnings.length;
      // hbs registers .html partials besides .hbs ones (hbs/lib/hbs.js, registerPartials).
      const exts = e === "hbs" ? [e, "html"] : [e];
      const ext = new RegExp(`\\.(?:${exts.join("|")})$`, "i");
      const edited = pagesIn(viewsDir, walkFiles(dir, viewsDir, (n) => ext.test(n)), pug, "views", exts);
      if (edited.length) summary.push(`${e} (${edited.length <= 3 ? edited.join(", ") : `${edited.length} templates with a <head>`})`);
      else if (out.manual.length + out.warnings.length === before) out.manual.push({ file: `${viewsDir}/`, reason: `No layout.${e} and no view with a single <head> in ${viewsDir}/.`, pug });
    }
  }
  for (const s of statics) {
    if (s === "unknown") { out.manual.push({ file: serverFile, reason: "A static folder is computed in code, or outside the app's folder, so the wizard cannot list its pages." }); continue; }
    if (out.folders.includes(s) && s !== out.views) continue;
    const walked = walkFiles(dir, s, (n) => /\.html?$/i.test(n));
    if (!walked.files.length || walked.files.every((f) => seen.has(f.rel))) continue;
    if (s === ".") { out.manual.push({ file: "./", reason: "express.static serves the app's whole folder, so the wizard does not choose pages from it: add the tag to the <head> of each page it serves." }); continue; }
    if (compiledIn(s, built)) { out.manual.push({ file: `${s}/`, reason: `${s}/ ${BUILT}` }); continue; }
    const other = builtBy(s);
    if (other) { out.manual.push({ file: `${s}/`, reason: other }); continue; }
    if (!out.folders.includes(s)) out.folders.push(s);
    const edited = pagesIn(s, walked, false, "static", ["html", "htm"]);
    if (edited.length) summary.push(`${s}/: ${edited.length} HTML page${edited.length === 1 ? "" : "s"}`);
  }
  out.summary = summary.length ? summary.join("; ") : null;
  return out;
}
