import { parseCode, walk, type Ast, type Node, type SpliceEdit } from "./splice.js";

// Where a file loads @parlox/browser (or one of its entry points), for the Vite entry edits: what an uninstall leaves
// behind is named, since it removes the package.

const BROWSER_PACKAGE = /^@parlox\/browser(\/|$)/;
const lineOf = (n: Node): number => n.loc?.start?.line ?? 0;

/** Every place the file loads @parlox/browser (an import or re-export, require(), import()), in order. */
export function browserUses(ast: Ast | null): Node[] {
  const found: Node[] = [];
  const named = (lit: Node | undefined) => lit?.type === "StringLiteral" && BROWSER_PACKAGE.test(lit.value);
  if (!ast) return found;
  walk(ast.program, (n) => {
    if ((n.type === "ImportDeclaration" || n.type === "ExportNamedDeclaration" || n.type === "ExportAllDeclaration") && named(n.source)) found.push(n);
    else if (n.type === "CallExpression" && ((n.callee.type === "Identifier" && n.callee.name === "require") || n.callee.type === "Import") && named(n.arguments[0])) found.push(n);
    else if (n.type === "ImportExpression" && named(n.source)) found.push(n);
  });
  return found;
}

/** The first place the file loads @parlox/browser, or null. */
export const browserUse = (ast: Ast | null): Node | null => browserUses(ast)[0] ?? null;

/** An uninstall edit's result, with a warning naming a line that still loads @parlox/browser: the uninstall removes the
 * package, so that line would break the build. */
export function removedEdit(code: string, out: string, file: string): SpliceEdit {
  const left = browserUse(parseCode(out, file));
  const warning = left ? `Line ${lineOf(left)} still uses @parlox/browser, which the uninstall removes; remove that line by hand.` : undefined;
  return { ok: true, code: out, changed: out !== code, ...(warning ? { warning } : {}) };
}
