import * as recast from "recast";
import { b, ensureNamedImport, n, parse, print, removeNamedImport, type Edit } from "./parse.js";

export const PUBLIC_KEY_RE = /^pk_[A-Za-z0-9]{8,64}$/;
const SOURCE = "@parlox/browser/react";
const NAME = "ParloxAnalytics";

const snippetFor = (kind: "layout" | "app", pk: string) =>
  kind === "layout"
    ? `import { ParloxAnalytics } from "${SOURCE}";\n\n// inside <body>, after {children}:\n<ParloxAnalytics publicKey="${pk}" />`
    : `import { ParloxAnalytics } from "${SOURCE}";\n\n// in the returned JSX, next to <Component {...pageProps} />:\n<>\n  <ParloxAnalytics publicKey="${pk}" />\n  <Component {...pageProps} />\n</>`;

const component = (pk: string) =>
  b.jsxElement(b.jsxOpeningElement(b.jsxIdentifier(NAME), [b.jsxAttribute(b.jsxIdentifier("publicKey"), b.stringLiteral(pk))], true));

function findElements(ast: any, name: string): any[] {
  const found: any[] = [];
  recast.visit(ast, { visitJSXElement(p) { const o = p.node.openingElement.name; if (n.JSXIdentifier.check(o) && o.name === name) found.push(p); this.traverse(p); } });
  return found;
}
const keyOf = (el: any) => el.node.openingElement.attributes.find((a: any) => a.name?.name === "publicKey")?.value?.value;
const isWhitespaceText = (c: any) => n.JSXText.check(c) && !c.value.trim();

/**
 * Inserts `node` as the last real child of a JSX element, without disturbing a trailing whitespace-only
 * JSXText (the indentation before the closing tag, e.g. "\n      " before `</body>`) that must stay last.
 * The new node gets its own line, indented like a sibling: reusing the whitespace of the nearest other
 * whitespace-only text child, so it lines up with elements such as `<header>` or `<footer>` rather than
 * guessing an indent width. `removeBrowser` reverses this exactly: it deletes this node together with the
 * whitespace text immediately before it, leaving the original trailing node untouched.
 */
function insertAsLastChild(children: any[], node: any): void {
  const hasTrailingWhitespace = children.length > 0 && isWhitespaceText(children[children.length - 1]);
  const insertAt = hasTrailingWhitespace ? children.length - 1 : children.length;
  let indent = "\n";
  for (let i = insertAt - 1; i >= 0; i--) {
    if (isWhitespaceText(children[i])) { indent = children[i].value; break; }
  }
  children.splice(insertAt, 0, b.jsxText(indent), node);
}

export function addBrowser(code: string, file: string, kind: "layout" | "app", publicKey: string): Edit {
  if (!PUBLIC_KEY_RE.test(publicKey)) throw new Error("Refusing to write an invalid public key");
  let ast: any;
  try { ast = parse(code, file); } catch { return { ok: false, reason: "The wizard could not read this file.", snippet: snippetFor(kind, publicKey) }; }

  const existing = findElements(ast, NAME);
  if (existing.length) {
    return existing.every((e) => keyOf(e) === publicKey)
      ? { ok: true, code, changed: false }
      : { ok: false, reason: `Parlox is already added here with another key (${keyOf(existing[0]) ?? "unknown"}).`, snippet: snippetFor(kind, publicKey) };
  }

  if (kind === "layout") {
    const bodies = findElements(ast, "body");
    if (bodies.length !== 1) return { ok: false, reason: "No single <body> element found in this layout.", snippet: snippetFor(kind, publicKey) };
    insertAsLastChild(bodies[0].node.children, component(publicKey));
  } else {
    const pages = findElements(ast, "Component");
    if (pages.length !== 1) return { ok: false, reason: "No single <Component /> element found in this _app file.", snippet: snippetFor(kind, publicKey) };
    const page = pages[0];
    page.replace(b.jsxFragment(b.jsxOpeningFragment(), b.jsxClosingFragment(), [b.jsxText("\n"), component(publicKey), b.jsxText("\n"), page.node, b.jsxText("\n")]));
  }
  ensureNamedImport(ast.program, NAME, SOURCE);
  return { ok: true, code: print(ast, code), changed: true };
}

export function removeBrowser(code: string, file: string): Edit {
  let ast: any;
  try { ast = parse(code, file); } catch { return { ok: false, reason: "The wizard could not read this file.", snippet: "Remove the ParloxAnalytics import and element by hand." }; }
  const els = findElements(ast, NAME);
  if (!els.length) return { ok: true, code, changed: false };
  for (const el of els) {
    const parent = el.parent.node;
    if (!n.JSXElement.check(parent) && !n.JSXFragment.check(parent)) {
      return { ok: false, reason: `Parlox is added here in a way the wizard cannot safely remove (not a plain JSX child, e.g. inside a {condition && ...} guard).`, snippet: "Remove the ParloxAnalytics import and element by hand." };
    }
    const idx = parent.children!.indexOf(el.node);
    const drop = new Set([idx]);
    if (idx > 0 && isWhitespaceText(parent.children![idx - 1])) drop.add(idx - 1);
    parent.children = parent.children!.filter((c: any, i: number) => !drop.has(i));
    const real = parent.children!.filter((c: any) => !isWhitespaceText(c));
    if (n.JSXFragment.check(parent) && real.length === 1) el.parent.replace(real[0]);
  }
  removeNamedImport(ast.program, NAME, SOURCE);
  return { ok: true, code: print(ast, code), changed: true };
}
