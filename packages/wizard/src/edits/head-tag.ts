import { TAG_INTEGRITY, TAG_URL } from "../versions.js";
import { PUBLIC_KEY_RE } from "./browser.js";
import { endsLine, eolOf, indentAt, insertLineAfter, lineEnd, lineStart, parseCode, removeLines, SpliceError, walk, type SpliceEdit } from "./splice.js";

// The dashboard's pinned tag, inserted at one unique anchor: right after the single <head> ("immediately after the
// opening <head>", as GA4 and PostHog place theirs), or as the first child of the single Pug `head` block. Right before
// it goes a marker in the file's own comment syntax, so an uninstall removes only what the wizard wrote and never a tag
// pasted by hand: <!-- parlox:wizard --> in HTML, EJS, Handlebars and html`…` templates, //- parlox:wizard in Pug and
// Jade (a comment Pug does not write out), {/* parlox:wizard */} in JSX. The text holds only the validated key, the
// pinned URL and integrity (versions.ts) and fixed text: no template syntax of any engine (<% %>, {{ }}, {% %}, #{ },
// ${ }, backticks, backslashes), so every engine writes it out as it is. An edit is offered only when its remover gives
// back the original bytes.

export const headTag = (pk: string) => `<script async src="${TAG_URL}" integrity="${TAG_INTEGRITY}" crossorigin="anonymous" data-key="${pk}"></script>`;
/** The tag as React's JSX types spell it: a React-typed TSX file does not compile with `crossorigin` (TS2322), and
 * React renders `crossOrigin` as the HTML attribute crossorigin. hono/jsx takes the HTML spelling (headTag). */
export const reactHeadTag = (pk: string) => headTag(pk).replace(" crossorigin=", " crossOrigin=");
/** Which JSX types a file is checked with: hono/jsx's, React's, or null when the wizard cannot tell. */
export type JsxTypes = "hono" | "react" | null;
export const pugTag = (pk: string) => `script(async, src="${TAG_URL}", integrity="${TAG_INTEGRITY}", crossorigin="anonymous", data-key="${pk}")`;
export const HTML_MARKER = "<!-- parlox:wizard -->";
export const PUG_MARKER = "//- parlox:wizard";
export const JSX_MARKER = "{/* parlox:wizard */}";
/** In a file at all: whether it may hold a tag the wizard wrote. */
export const MARKER_TEXT = "parlox:wizard";

// The tag in either syntax, any release and any key (group: the key).
const TAG = String.raw`<script async src="https:\/\/gateway\.parlox\.io\/sdk\/\d+\.\d+\.\d+\/parlox\.js" integrity="sha384-[A-Za-z0-9+/=]+" cross[oO]rigin="anonymous" data-key="(pk_[A-Za-z0-9]{8,64})"><\/script>`;
const PUG_TAG = String.raw`script\(async, src="https:\/\/gateway\.parlox\.io\/sdk\/\d+\.\d+\.\d+\/parlox\.js", integrity="sha384-[A-Za-z0-9+/=]+", crossorigin="anonymous", data-key="(pk_[A-Za-z0-9]{8,64})"\)`;
// What the wizard wrote: a marker, then (on the next line, or right after it) the tag.
const MARKED_RE = new RegExp(String.raw`(?:<!-- parlox:wizard -->|\{\/\* parlox:wizard \*\/\})(\r?\n[ \t]*)?${TAG}`, "g");
const PUG_MARKED_RE = new RegExp(String.raw`^[ \t]*\/\/- parlox:wizard[ \t]*\r?\n[ \t]*${PUG_TAG}[ \t]*$`, "gm");
const MARKERS_RE = /<!-- parlox:wizard -->|\{\/\* parlox:wizard \*\/\}/g;
const PUG_MARKERS_RE = /^[ \t]*\/\/- parlox:wizard[ \t]*$/gm;
/** Any Parlox tag at all (pinned, the latest-release tag, a key in the URL, any file under the gateway's /sdk/, the
 * React component): the page already has Parlox. */
export const ANY_PARLOX_TAG_RE = /gateway\.parlox\.io\/sdk\/|\/sdk\/(?:\d+\.\d+\.\d+\/)?parlox\.js|<ParloxAnalytics\b/;
// <head …>, to its own closing ">": a ">" inside a quoted attribute value does not close it, and a quote left open on
// its line is no tag the wizard edits after.
const HEAD_RE = /<head(?=[\s>/])(?:[^<>"']|"[^"<\r\n]*"|'[^'<\r\n]*')*>/gi;
// A Pug `head` the wizard edits: alone on its line, or with its attributes closed on that line (a byte-order mark may
// come before it on the first line).
const PUG_HEAD_RE = /^\ufeff?([ \t]*)head(\([^)\r\n]*\))?[ \t]*$/gm;
// Any Pug head element: `head`, `head(…`, `head.`, `head: …`, `head text`, `head#id`, `head&attributes(…)`, `head/`.
const PUG_ANY_HEAD_RE = /^\ufeff?([ \t]*)head(?=$|[\s(.:#&/])/gm;

export const htmlSnippet = (pk: string) => `As the first line inside <head>:\n${headTag(pk)}`;
export const pugSnippet = (pk: string) => `As the first line inside the head block, one step deeper:\n${pugTag(pk)}`;
export const REMOVE_TAG_SNIPPET = "Remove the Parlox script tag (https://gateway.parlox.io/sdk/…/parlox.js) and the parlox:wizard comment before it from the page's head by hand.";
const UNDO = "The wizard could not add it in a way it can take out again exactly.";

const lineNo = (text: string, i: number) => text.slice(0, i).split("\n").length;
const blank = (s: string) => s.replace(/[^\r\n]/g, " ");
const isPug = (file: string) => /\.(pug|jade)$/i.test(file);
const isJs = (file: string) => /\.(js|jsx|ts|tsx|mjs|cjs|mts|cts)$/i.test(file);

function checkKey(pk: string): void { if (!PUBLIC_KEY_RE.test(pk)) throw new Error("Refusing to write an invalid public key"); }

/** The line of a Parlox tag in `text` that the wizard did not write (the marked tags it wrote are left out), or null.
 * Such a tag is never removed, and no second tag is added beside it. */
export const foreignTagLine = (file: string, text: string): number | null => foreignLine(text, isPug(file));
function foreignLine(text: string, pug: boolean): number | null {
  const m = ANY_PARLOX_TAG_RE.exec(text.replace(pug ? PUG_MARKED_RE : MARKED_RE, blank));
  return m ? lineNo(text, m.index) : null;
}
/** Whether `text` holds a tag the wizard wrote (with its marker). */
export const wizardTagIn = (file: string, text: string): boolean => [...text.matchAll(isPug(file) ? PUG_MARKED_RE : MARKED_RE)].length > 0;
export const foreignTagWarning = (line: number) => `A Parlox tag is already in this file, on line ${line}; it was left as it is.`;

// Where "<head>" is text, not the page's markup: HTML comments, CDATA, processing instructions (<?php ?>), the contents
// of <script>, <style>, <template>, <noscript>, <textarea> and <title>, and template tags (EJS and Eta <% %>, Handlebars
// and Mustache {{ }}, Nunjucks, Liquid and Twig {% %} and {# #}), each to its end or to the end of the text; then the
// quoted attribute values of every tag left. Blanked out with spaces, so an offset in the result is the same offset in
// the file.
const NOT_MARKUP = /<!--[\s\S]*?(?:-->|$)|<!\[CDATA\[[\s\S]*?(?:\]\]>|$)|<\?[\s\S]*?(?:\?>|$)|<%[\s\S]*?(?:%>|$)|\{\{[\s\S]*?(?:\}\}|$)|\{[%#][\s\S]*?(?:[%#]\}|$)|<(script|style|template|noscript|textarea|title)\b(?:[^>"']|"[^"]*"|'[^']*')*>[\s\S]*?(?:<\/\1\s*>|$)/gi;
const START_TAG = /<[A-Za-z][^\s/>]*(?:[^>"']|"[^"]*"|'[^']*')*>/g;
const markupOf = (text: string) => text.replace(NOT_MARKUP, blank).replace(START_TAG, (t) => t.replace(/"[^"]*"|'[^']*'/g, (q) => q[0] + " ".repeat(q.length - 2) + q[0]));

/** Offsets right after each <head …> of the page's markup (not in a comment, a raw-text element, a template tag or an
 * attribute value). */
export function htmlHeads(text: string): number[] {
  return [...markupOf(text).matchAll(HEAD_RE)].map((m) => m.index! + m[0].length);
}
/** Whether an HTML-like file is a page (it has <html>, a doctype or <body> in its markup) rather than a fragment. */
export const isHtmlPage = (text: string): boolean => /<html(?=[\s>/])|<!doctype\b|<body(?=[\s>/])/i.test(markupOf(text));

// A Pug line whose indented lines are text or code, not tags: a comment (// and //-), a tag ending in "." (script., p.),
// a filter (:markdown-it) and an unbuffered code block (a lone -).
const PUG_TEXT_PARENT = /^(?:\/\/|:|-$|[^\s(]*(?:\([^)]*\))?\.$)/;
function inPugText(text: string, at: number, indent: number): boolean {
  let depth = indent;
  for (const line of text.slice(0, at).split(/\r?\n/).reverse()) {
    if (!line.trim()) continue;
    const own = /^[ \t]*/.exec(line)![0].length;
    if (own >= depth) continue;
    if (PUG_TEXT_PARENT.test(line.trim())) return true;
    depth = own;
    if (depth === 0) return false;
  }
  return false;
}
const pugLines = (text: string, re: RegExp): RegExpMatchArray[] => [...text.matchAll(re)].filter((m) => !inPugText(text, m.index!, m[1].length));

/** The head elements of a Pug template, in any form, outside comments, text blocks and code blocks. */
export const pugHeads = (text: string): RegExpMatchArray[] => pugLines(text, PUG_ANY_HEAD_RE);
/** Whether a Pug template is a page (doctype, html or body) rather than a fragment (a view that extends a layout, an
 * include). */
export const isPugPage = (text: string): boolean => pugLines(text, /^\ufeff?([ \t]*)(?:doctype|html|body)(?=$|[\s(.:#&/])/gm).length > 0;

/** One indentation step in the file's own character: a tab when its lines are indented with tabs. */
const stepOf = (text: string) => (/^\t/m.test(text) ? "\t" : "  ");

/** The marker and the tag after `<head>` (at offset `at`): when nothing else follows it on its line, each on a new line
 * at the head's children's indentation; otherwise both right there (a minified page stays on one line). */
function insertTag(text: string, at: number, marker: string, tag: string): string {
  const end = lineEnd(text, at);
  if (text.slice(at, end).trim()) return text.slice(0, at) + marker + tag + text.slice(at);
  const following = end === text.length ? "" : text.slice(end).split(/\r?\n/).slice(1).find((l) => l.trim()) ?? "";
  const childIndent = /^[ \t]*/.exec(following)![0];
  const headIndent = indentAt(text, at);
  const indent = childIndent.length > headIndent.length ? childIndent : headIndent + stepOf(text);
  const eol = eolOf(text);
  return text.slice(0, end) + eol + indent + marker + eol + indent + tag + text.slice(end);
}

const refuse = (reason: string, snippet: string): SpliceEdit => ({ ok: false, reason, snippet });

/** Runs an edit; a line break the line primitives refuse (splice.ts) becomes the snippet, with the reason. */
function guarded(snippet: string, edit: () => SpliceEdit): SpliceEdit {
  try { return edit(); }
  catch (err) {
    if (err instanceof SpliceError) return refuse(err.message, snippet);
    throw err;
  }
}

/** A marker that is not right before a tag the wizard wrote: the line of the first, or null. */
function strayMarker(text: string, pug: boolean): number | null {
  const tags = new Set([...text.matchAll(pug ? PUG_MARKED_RE : MARKED_RE)].map((m) => m.index!));
  const lone = [...text.matchAll(pug ? PUG_MARKERS_RE : MARKERS_RE)].find((m) => !tags.has(m.index!));
  return lone ? lineNo(text, lone.index!) : null;
}

/** The wizard's own marked tag already here: nothing to do with this key, a snippet with another (never a second tag).
 * Any other Parlox tag: left as it is, with a warning. Null: no Parlox tag. */
function already(text: string, pug: boolean, pk: string, snippet: string): SpliceEdit | null {
  const mine = [...text.matchAll(pug ? PUG_MARKED_RE : MARKED_RE)].map((m) => m[pug ? 1 : 2]);
  const other = mine.find((k) => k !== pk);
  if (other) return refuse(`Parlox is already here with another key (${other}).`, snippet);
  const stray = strayMarker(text, pug);
  if (stray !== null) return refuse(`A parlox:wizard comment on line ${stray} is not right before the tag the wizard writes; remove it, then run the wizard again.`, snippet);
  const foreign = foreignLine(text, pug);
  if (mine.length || foreign !== null) return { ok: true, code: text, changed: false, ...(foreign !== null ? { warning: foreignTagWarning(foreign) } : {}) };
  return null;
}

/** The edited text, offered only when the remover gives back `text` exactly. */
function undoable(text: string, out: string, remove: (t: string) => SpliceEdit, snippet: string): SpliceEdit {
  const back = remove(out);
  return back.ok && back.code === text ? { ok: true, code: out, changed: true } : refuse(UNDO, snippet);
}

export function addHtmlHeadTag(text: string, pk: string): SpliceEdit {
  checkKey(pk);
  const snippet = htmlSnippet(pk);
  return guarded(snippet, () => {
    const done = already(text, false, pk, snippet);
    if (done) return done;
    const heads = htmlHeads(text);
    if (heads.length !== 1) return refuse(heads.length ? "This file has more than one <head>." : "This file has no <head>.", snippet);
    return undoable(text, insertTag(text, heads[0], HTML_MARKER, headTag(pk)), removeHtmlHeadTag, snippet);
  });
}

/** Removes every marked tag the wizard wrote, with the marker, the line breaks and the indentation it added. For
 * HTML-like and JS files. A tag without the marker (pasted by hand) stays; a marker without its tag is a step by hand. */
export function removeHtmlHeadTag(text: string): SpliceEdit {
  if (!text.includes(MARKER_TEXT)) return { ok: true, code: text, changed: false };
  const stray = strayMarker(text, false);
  if (stray !== null) return refuse(`The parlox:wizard comment on line ${stray} is not right before the tag the wizard wrote, so the wizard does not remove it.`, REMOVE_TAG_SNIPPET);
  const found = [...text.matchAll(MARKED_RE)];
  return guarded(REMOVE_TAG_SNIPPET, () => {
    let out = text;
    for (const m of found.reverse()) {
      const start = m.index!, end = start + m[0].length;
      const s = lineStart(out, start);
      const alone = m[1] !== undefined && s > 0 && out.slice(s, start).trim() === "" && endsLine(out, end);
      const from = alone ? s - (out.slice(0, s).endsWith("\r\n") ? 2 : 1) : start;
      out = out.slice(0, from) + out.slice(end);
    }
    return { ok: true, code: out, changed: found.length > 0 };
  });
}

export function addPugHeadTag(text: string, pk: string): SpliceEdit {
  checkKey(pk);
  const snippet = pugSnippet(pk);
  return guarded(snippet, () => {
    const done = already(text, true, pk, snippet);
    if (done) return done;
    const heads = pugHeads(text);
    if (heads.length !== 1) return refuse(heads.length ? "This file has more than one head block." : "This file has no head block (a template that extends a layout has its head there).", snippet);
    const m = pugLines(text, PUG_HEAD_RE).find((h) => h.index === heads[0].index);
    if (!m) return refuse("The head block is written in a form the wizard does not edit (its attributes run over several lines, or it has content on its own line).", snippet);
    const headIndent = m[1];
    const after = text.slice(lineEnd(text, m.index!)).split(/\r?\n/).slice(1).find((l) => l.trim()) ?? "";
    const nextIndent = /^[ \t]*/.exec(after)![0];
    // Pug forbids mixing tabs and spaces: a head with no children takes the file's own step.
    const indent = nextIndent.length > headIndent.length ? nextIndent : headIndent + stepOf(text);
    const lines = `${indent}${PUG_MARKER}${eolOf(text)}${indent}${pugTag(pk)}`;
    return undoable(text, insertLineAfter(text, m.index!, lines), removePugHeadTag, snippet);
  });
}

export function removePugHeadTag(text: string): SpliceEdit {
  if (!text.includes(MARKER_TEXT)) return { ok: true, code: text, changed: false };
  const stray = strayMarker(text, true);
  if (stray !== null) return refuse(`The parlox:wizard comment on line ${stray} is not right before the tag the wizard wrote, so the wizard does not remove it.`, REMOVE_TAG_SNIPPET);
  const found = [...text.matchAll(PUG_MARKED_RE)];
  return guarded(REMOVE_TAG_SNIPPET, () => {
    let out = text;
    for (const m of found.reverse()) out = removeLines(out, m.index!, m.index! + m[0].length);
    return { ok: true, code: out, changed: found.length > 0 };
  });
}

/** Each page <head> in a JS file, with the syntax around it: a JSX <head> element, or `<head>` in an html`…` template
 * (hono/html), read with its ${…} parts blanked out. A plain string or template literal is not counted: nothing says it
 * is a page. Null: it did not parse. */
function jsHeads(code: string, file: string): Array<{ at: number; jsx: boolean }> | null {
  if (!/<head/i.test(code)) return [];
  const ast = parseCode(code, file);
  if (!ast) return null;
  const at: Array<{ at: number; jsx: boolean }> = [];
  walk(ast.program, (n) => {
    if (n.type === "JSXElement" && n.openingElement.name.type === "JSXIdentifier" && n.openingElement.name.name === "head" && !n.openingElement.selfClosing) at.push({ at: n.openingElement.end, jsx: true });
    if (n.type === "TaggedTemplateExpression" && n.tag.type === "Identifier" && n.tag.name === "html") {
      const first = n.quasi.quasis[0].start;
      let body = "";
      for (const q of n.quasi.quasis) body = body.padEnd(q.start - first, " ") + code.slice(q.start, q.end);
      at.push(...htmlHeads(body).map((i) => ({ at: first + i, jsx: false })));
    }
  });
  return at.sort((a, b) => a.at - b.at);
}

/** Whether a page <head> in a JS file is a JSX element (its tag is then spelled for the file's JSX types). */
export const jsxHeadIn = (code: string, file: string): boolean => jsHeads(code, file)?.some((h) => h.jsx) ?? false;

/** Offsets right after each page <head> in a JS file (jsHeads). Null: it did not parse. */
export function headsIn(code: string, file: string): number[] | null {
  return jsHeads(code, file)?.map((h) => h.at) ?? null;
}

/** The snippet for a JSX <head>, in the spelling of the file's JSX types; both spellings when they are not known. */
export const jsxSnippet = (pk: string, jsx: JsxTypes): string => (jsx === "react" ? `As the first line inside <head>:\n${reactHeadTag(pk)}`
  : jsx === "hono" ? htmlSnippet(pk) : `As the first line inside <head>, with hono/jsx's types:\n${headTag(pk)}\nwith React's types (crossOrigin):\n${reactHeadTag(pk)}`);
const JSX_UNKNOWN = "The wizard cannot tell whether this file's JSX is typed by hono/jsx or by React (tsconfig's jsxImportSource, a @jsxImportSource comment, or an import from hono/jsx or @hono/react-renderer would say), and each spells the tag's crossorigin attribute its own way.";

/** `jsx`: the JSX types the file is checked with (a JSX <head> gets the tag in their spelling; when they are not known,
 * a snippet). An html`…` template is HTML whatever they are. */
export function addJsHeadTag(code: string, file: string, pk: string, jsx: JsxTypes = "hono"): SpliceEdit {
  checkKey(pk);
  const snippet = htmlSnippet(pk);
  return guarded(snippet, () => {
    const done = already(code, false, pk, snippet);
    if (done) return done;
    const heads = jsHeads(code, file);
    if (heads === null) return refuse("The wizard could not read this file.", snippet);
    // A JSX <head>'s snippet is spelled for the file's JSX types.
    const own = heads.some((h) => h.jsx) ? jsxSnippet(pk, jsx) : snippet;
    if (heads.length !== 1) return refuse(heads.length ? "This file has more than one <head>." : "This file has no JSX <head> element and no html`…` template with a <head>.", own);
    if (heads[0].jsx && jsx === null) return refuse(JSX_UNKNOWN, own);
    const out = insertTag(code, heads[0].at, heads[0].jsx ? JSX_MARKER : HTML_MARKER, heads[0].jsx && jsx === "react" ? reactHeadTag(pk) : headTag(pk));
    if (!parseCode(out, file)) return refuse("The file would not parse with Parlox added.", own);
    return undoable(code, out, removeHtmlHeadTag, own);
  });
}

/** The editor for a page file, chosen by its name: .pug and .jade are Pug, JavaScript and TypeScript files are JS,
 * anything else is HTML-like (HTML, EJS, Handlebars, Mustache, Nunjucks, Eta, Liquid). */
export const addPageTag = (file: string, text: string, pk: string, jsx?: JsxTypes): SpliceEdit => (isPug(file) ? addPugHeadTag(text, pk) : isJs(file) ? addJsHeadTag(text, file, pk, jsx) : addHtmlHeadTag(text, pk));
export const removePageTag = (file: string, text: string): SpliceEdit => (isPug(file) ? removePugHeadTag(text) : removeHtmlHeadTag(text));
