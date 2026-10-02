import { PUBLIC_KEY_RE } from "./browser.js";
import { addImportLine, applySplices, endsLine, eolOf, identifierUse, indentAt, lineStart, parseCode, removeImportLine, SpliceError, startsLine, styleOf, topLevelNames, walk, type Ast, type Node, type SpliceEdit } from "./splice.js";

// The Vite React browser part: <ParloxAnalytics publicKey="pk_…" /> rendered beside <App /> in the root render(…) call
// (PostHog's guidance: "Integrate PostHog at the root of your app (such as main.jsx for Vite apps)"). The tracker starts
// once per page, so StrictMode's double effect is harmless, and it follows single-page navigation. The edit is a text
// splice at offsets Babel gives (edits/splice.ts): the inserted text is the fixed element with the validated key, the
// fixed import line in the file's own quotes and semicolons, and a line break with the indentation copied from the
// element beside it. It is made only when removeViteEntry gives back the original bytes.

const SOURCE = "@parlox/browser/react";
const NAME = "ParloxAnalytics";
const element = (pk: string) => `<${NAME} publicKey="${pk}" />`;
/** The paste-in snippet for a Vite entry the wizard does not edit. */
export const viteEntrySnippet = (pk: string) => `import { ${NAME} } from "${SOURCE}";\n\n// in the root render(…) call, beside <App />:\n${element(pk)}`;
const REMOVE_SNIPPET = `Remove the ${NAME} import and element by hand.`;

/** The app's entry from index.html: Vite "resolves <script type="module" src="..."> that references your JavaScript
 * source code". Null unless exactly one module script of the app's own is there: a URL, or a source with a scheme
 * (data:, a drive letter), is not the app's own, and a script inside an HTML comment does not count. The path is
 * relative to Vite's root, without its leading "/" or "./", its query or its hash. */
export function moduleEntry(html: string): string | null {
  const srcs: string[] = [];
  // A tag's attributes, where a quoted value may hold ">".
  for (const m of html.replace(/<!--[\s\S]*?-->/g, "").matchAll(/<script\b((?:[^>"']|"[^"]*"|'[^']*')*)>/gi)) {
    const attrs = m[1];
    if (!/(?:^|\s)type\s*=\s*(?:"module"|'module'|module(?=[\s/]|$))/i.test(attrs)) continue;
    const s = /(?:^|\s)src\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i.exec(attrs);
    const src = s ? (s[1] ?? s[2] ?? s[3]).replace(/[?#].*$/, "") : null;
    if (src && !/^\/\//.test(src) && !/^[a-z][a-z0-9+.-]*:/i.test(src)) srcs.push(src);
  }
  return srcs.length === 1 ? srcs[0].replace(/^\.?\//, "") : null;
}

function jsxName(n: Node): string | null {
  const id = n.openingElement?.name;
  if (id?.type === "JSXIdentifier") return id.name;
  if (id?.type === "JSXMemberExpression" && id.object.type === "JSXIdentifier") return `${id.object.name}.${id.property.name}`;
  return null;
}

// createRoot(…).render(…) or ReactDOM.createRoot(…).render(…).
function renderCalls(ast: Ast): Node[] {
  const found: Node[] = [];
  walk(ast.program, (n) => {
    if (n.type !== "CallExpression" || n.callee.type !== "MemberExpression" || n.callee.property?.name !== "render") return;
    const root = n.callee.object;
    if (root?.type !== "CallExpression") return;
    const c = root.callee;
    if ((c.type === "Identifier" && c.name === "createRoot") || (c.type === "MemberExpression" && c.property?.name === "createRoot")) found.push(n);
  });
  return found;
}

function parloxElements(ast: Ast): Array<{ el: Node; parent: Node | null }> {
  const out: Array<{ el: Node; parent: Node | null }> = [];
  walk(ast.program, (n, ancestors) => { if (n.type === "JSXElement" && jsxName(n) === NAME) out.push({ el: n, parent: ancestors[ancestors.length - 1] ?? null }); });
  return out;
}
/** The wizard's import line (or the same written by hand): `import { ParloxAnalytics } from "@parlox/browser/react"`. */
const hasOwnImport = (ast: Ast): boolean => ast.program.body.some((s) => s.type === "ImportDeclaration" && s.importKind !== "type" && s.source.value === SOURCE
  && s.specifiers.some((sp: Node) => sp.type === "ImportSpecifier" && sp.importKind !== "type" && (sp.imported.name ?? sp.imported.value) === NAME && sp.local.name === NAME));
const keyOf = (el: Node): string | null => {
  const a = el.openingElement.attributes.find((x: Node) => x.type === "JSXAttribute" && x.name?.name === "publicKey");
  return a?.value?.type === "StringLiteral" ? a.value.value : null;
};
const lineOf = (n: Node): number => n.loc?.start?.line ?? 0;

const BROWSER_PACKAGE = /^@parlox\/browser(\/|$)/;
/** The first place the file loads @parlox/browser (an import or re-export, require(), import()). */
function browserUse(ast: Ast | null): Node | null {
  let found: Node | null = null;
  const named = (lit: Node | undefined) => lit?.type === "StringLiteral" && BROWSER_PACKAGE.test(lit.value);
  if (!ast) return null;
  walk(ast.program, (n) => {
    if (found) return;
    if ((n.type === "ImportDeclaration" || n.type === "ExportNamedDeclaration" || n.type === "ExportAllDeclaration") && named(n.source)) found = n;
    else if (n.type === "CallExpression" && ((n.callee.type === "Identifier" && n.callee.name === "require") || n.callee.type === "Import") && named(n.arguments[0])) found = n;
    else if (n.type === "ImportExpression" && named(n.source)) found = n;
  });
  return found;
}
/** The edit's result, with a warning naming a line that still loads @parlox/browser: the uninstall removes the
 * package, so that line would break the build. */
function removed(code: string, out: string, file: string): SpliceEdit {
  const left = browserUse(parseCode(out, file));
  const warning = left ? `Line ${lineOf(left)} still uses @parlox/browser, which the uninstall removes; remove that line by hand.` : undefined;
  return { ok: true, code: out, changed: out !== code, ...(warning ? { warning } : {}) };
}

export function addViteEntry(code: string, file: string, publicKey: string): SpliceEdit {
  if (!PUBLIC_KEY_RE.test(publicKey)) throw new Error("Refusing to write an invalid public key");
  const refuse = (reason: string): SpliceEdit => ({ ok: false, reason, snippet: viteEntrySnippet(publicKey) });
  const ast = parseCode(code, file);
  if (!ast) return refuse("The wizard could not read this file.");
  const calls = renderCalls(ast);
  const arg: Node | undefined = calls.length === 1 ? calls[0].arguments[0] : undefined;
  // Already installed means the wizard's own shape: its import, and one element with this key in the root render call.
  const existing = parloxElements(ast);
  if (existing.length) {
    if (!existing.every((e) => keyOf(e.el) === publicKey)) return refuse(`Parlox is already added here with another key (${keyOf(existing[0].el) ?? "unknown"}).`);
    const outside = existing.find((e) => !arg || e.el.start < arg.start || e.el.end > arg.end);
    if (outside) return refuse(`This file already has a ${NAME} element on line ${lineOf(outside.el)} outside the root render(…) call; the wizard leaves it as it is.`);
    if (existing.length > 1) return refuse(`${NAME} appears more than once in the root render(…) call.`);
    if (!hasOwnImport(ast)) return refuse(`${NAME} is in the root render(…) call, but not imported from ${SOURCE}.`);
    return { ok: true, code, changed: false };
  }
  if (topLevelNames(ast).has(NAME)) return refuse(`This file already has something named ${NAME}.`);
  // Not scope-aware (edits/splice.ts): any binding of the name would make the element refer to it, not the import.
  const local = identifierUse(ast, NAME);
  if (local) return refuse(`This file uses the name ${NAME} on line ${lineOf(local)}, so the wizard's import could not be told apart from it.`);
  if (calls.length !== 1) return refuse("No single createRoot(…).render(…) call found in this file.");
  const strict = arg?.type === "JSXElement" && (jsxName(arg) === "StrictMode" || jsxName(arg) === "React.StrictMode");
  let out: string;
  try {
    let splices;
    if (strict || arg?.type === "JSXFragment") {
      // Beside the last element inside <StrictMode> (or a fragment): on its own line, at its indentation, when that
      // element is alone on its line.
      const kids = arg!.children.filter((c: Node) => c.type === "JSXElement");
      if (!kids.length) return refuse("The root render(…) call renders nothing the wizard can sit beside.");
      const last = kids[kids.length - 1];
      const own = startsLine(code, last.start) && endsLine(code, last.end);
      splices = [{ start: last.end, end: last.end, text: own ? `${eolOf(code)}${indentAt(code, last.start)}${element(publicKey)}` : element(publicKey) }];
    } else if (arg?.type === "JSXElement") {
      // A bare <App /> (or another element) becomes <><App /><ParloxAnalytics … /></>.
      splices = [{ start: arg.start, end: arg.start, text: "<>" }, { start: arg.end, end: arg.end, text: `${element(publicKey)}</>` }];
    } else return refuse("The root render(…) call does not render a JSX element.");
    out = applySplices(code, splices);
    const parsed = parseCode(out, file);
    if (!parsed) return refuse("The file would not parse with Parlox added.");
    const { q, semi } = styleOf(out, parsed);
    out = addImportLine(out, parsed, `import { ${NAME} } from ${q}${SOURCE}${q}${semi}`);
  } catch (err) {
    if (err instanceof SpliceError) return refuse(err.message);
    throw err;
  }
  // An inline fragment around one element (<><App /></>) would read as the wizard's own fragment, and the uninstall
  // would take it out too: only an edit that comes out exactly is made.
  const back = removeViteEntry(out, file);
  if (!back.ok || back.code !== code) return refuse("The wizard could not add it in a way it can take out again exactly.");
  return { ok: true, code: out, changed: true };
}

/** The fragment addViteEntry makes around a bare element: exactly `<>` + that element + ours + `</>`. */
function isOurFragment(code: string, parent: Node | null, el: Node): boolean {
  if (parent?.type !== "JSXFragment" || parent.children.length !== 2 || parent.children[1] !== el) return false;
  const inner = parent.children[0];
  return inner.type === "JSXElement" && inner.end === el.start && code.slice(parent.start, inner.start) === "<>" && code.slice(el.end, parent.end) === "</>";
}

/** The exact inverse of addViteEntry. A lone import of the wizard's (its element removed by hand) goes too: once the
 * package is removed, it would break the build. Any other use of @parlox/browser left in the file is named in
 * `warning`. */
export function removeViteEntry(code: string, file: string): SpliceEdit {
  const manual = (reason: string): SpliceEdit => ({ ok: false, reason, snippet: REMOVE_SNIPPET });
  const ast = parseCode(code, file);
  if (!ast) return manual("The wizard could not read this file.");
  try {
    const found = parloxElements(ast);
    if (!found.length) {
      return removed(code, identifierUse(ast, NAME) ? code : removeImportLine(code, ast, SOURCE, [NAME]), file);
    }
    if (found.length > 1) return manual(`${NAME} appears more than once here.`);
    const { el, parent } = found[0];
    let out: string;
    if (isOurFragment(code, parent, el)) {
      const inner = parent!.children[0];
      out = applySplices(code, [{ start: parent!.start, end: inner.start, text: "" }, { start: inner.end, end: parent!.end, text: "" }]);
    } else if (parent?.type === "JSXElement" || parent?.type === "JSXFragment") {
      const s = lineStart(code, el.start);
      const alone = s > 0 && startsLine(code, el.start) && endsLine(code, el.end);
      const from = alone ? s - (code.slice(0, s).endsWith("\r\n") ? 2 : 1) : el.start;
      out = code.slice(0, from) + code.slice(el.end);
    } else return manual("Parlox is added here in a way the wizard cannot safely remove (not a plain JSX child).");
    const ast2 = parseCode(out, file);
    if (!ast2) return manual("The file would not parse without Parlox.");
    return removed(code, removeImportLine(out, ast2, SOURCE, [NAME]), file);
  } catch (err) {
    if (err instanceof SpliceError) return manual(err.message);
    throw err;
  }
}
