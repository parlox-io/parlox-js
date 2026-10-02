import * as recast from "recast";
import * as babel from "@babel/parser";

// recast keeps the original formatting of every node we do not touch. Babel's plugins follow the file type: JSX and
// TypeScript together would misread <T>x casts in .ts files.
export const b = recast.types.builders;
export const n = recast.types.namedTypes;

function pluginsFor(file: string): babel.ParserPlugin[] {
  if (/\.tsx$/.test(file)) return ["typescript", "jsx"];
  if (/\.(ts|mts|cts)$/.test(file)) return ["typescript"];
  return ["jsx"];
}

export function parse(code: string, file: string) {
  return recast.parse(code, {
    parser: { parse: (src: string) => babel.parse(src, { sourceType: "module", plugins: pluginsFor(file), tokens: true }) },
  });
}

/**
 * Recast reuses the original source text for nodes it does not touch, but a node it does touch (or
 * has to reprint wholesale, e.g. because it moved position) is rendered with recast's own defaults:
 * 4-space indentation, "\n" line endings. On a tab-indented or CRLF file that turns an edit meant to
 * touch one or two lines into a whole-function diff, which is what a merchant reviews before
 * installing. Detecting the source's own style and passing it through keeps a reprinted node visually
 * indistinguishable from the surrounding, untouched code.
 */
function detectStyle(originalCode: string): { lineTerminator: string; useTabs: boolean; tabWidth: number } {
  const lineTerminator = originalCode.includes("\r\n") ? "\r\n" : "\n";
  const indentedLines = originalCode.split(/\r\n|\n/).filter((line) => /^[ \t]/.test(line) && line.trim().length > 0);
  const useTabs = indentedLines.length > 0 && indentedLines[0][0] === "\t";
  if (useTabs) {
    // Recast's own pretty-printer always reasons about indentation in units of 4 spaces, then turns
    // each `tabWidth`-many spaces into one tab. A tabWidth of anything but 4 here would print two (or
    // half a) tab per source indentation level instead of one, on any node recast has to reprint.
    return { lineTerminator, useTabs, tabWidth: 4 };
  }
  let smallest = 0;
  for (const line of indentedLines) {
    const width = /^ +/.exec(line)?.[0].length ?? 0;
    if (width > 0 && (smallest === 0 || width < smallest)) smallest = width;
  }
  return { lineTerminator, useTabs, tabWidth: smallest || 2 };
}

export function print(ast: unknown, originalCode: string): string {
  const { lineTerminator, useTabs, tabWidth } = detectStyle(originalCode);
  return recast.print(ast as recast.types.ASTNode, { quote: "double", reuseWhitespace: false, lineTerminator, useTabs, tabWidth }).code;
}
export type Edit = { ok: true; code: string; changed: boolean } | { ok: false; reason: string; snippet: string };

/** Adds `import { name } from "source";` after the last import unless one importing that name exists. */
export function ensureNamedImport(program: any, name: string, source: string): void {
  const body = program.body as any[];
  const has = body.some((s) => n.ImportDeclaration.check(s) && s.source.value === source && s.specifiers?.some((sp: any) => sp.imported?.name === name));
  if (has) return;
  const decl = b.importDeclaration([b.importSpecifier(b.identifier(name))], b.stringLiteral(source));
  let last = -1;
  body.forEach((s, i) => { if (n.ImportDeclaration.check(s)) last = i; });
  body.splice(last + 1, 0, decl);
}

/** Removes the named import from `source`, and the declaration if it becomes empty. */
export function removeNamedImport(program: any, name: string, source: string): boolean {
  let changed = false;
  program.body = (program.body as any[]).filter((s) => {
    if (!n.ImportDeclaration.check(s) || (s as any).source.value !== source) return true;
    const before = (s as any).specifiers.length;
    (s as any).specifiers = (s as any).specifiers.filter((sp: any) => sp.imported?.name !== name);
    if ((s as any).specifiers.length !== before) changed = true;
    return (s as any).specifiers.length > 0;
  });
  return changed;
}
