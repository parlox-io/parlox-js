import * as babel from "@babel/parser";

// The new integrations edit JavaScript and TypeScript by splicing text at offsets Babel's syntax tree gives: the tree
// finds the place, the inserted text is a fixed template, and nothing else in the file is reprinted. Removing an
// insertion deletes exactly the text that was inserted, so an uninstall gives back the original bytes. (A reprinting
// editor cannot promise that: recast drops the blank line after an import block when it reprints the statement below
// it.) The Next.js integration keeps its recast edits (edits/browser.ts, edits/server.ts) unchanged.

export type Node = { type: string; start: number; end: number; [key: string]: any };
export type Ast = { program: Node & { body: Node[] }; comments?: Node[] };
export interface Splice { start: number; end: number; text: string }
export type SpliceEdit = { ok: true; code: string; changed: boolean; warning?: string } | { ok: false; reason: string; snippet: string };

/** An insertion the wizard will not make, because the line it would go on is inside a comment or a statement (a
 * template string or a block comment that runs on past the anchor's line). The caller shows its snippet instead. */
export class SpliceError extends Error {}

function pluginsFor(file: string): babel.ParserPlugin[] {
  if (/\.tsx$/.test(file)) return ["typescript", "jsx"];
  if (/\.(ts|mts|cts)$/.test(file)) return ["typescript"];
  return ["jsx"];
}

/** The file's syntax tree, or null when it does not parse (the caller then shows a snippet). */
export function parseCode(code: string, file: string): Ast | null {
  try {
    return babel.parse(code, { sourceType: "unambiguous", plugins: pluginsFor(file), allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true }) as unknown as Ast;
  } catch { return null; }
}

const SKIP = new Set(["loc", "extra", "leadingComments", "trailingComments", "innerComments", "comments", "tokens"]);
/** Every node under `root`, depth first. `ancestors` is the path from `root` (nearest last), valid during the call only. */
export function walk(root: Node, visit: (node: Node, ancestors: readonly Node[]) => void): void {
  const path: Node[] = [];
  const go = (node: Node): void => {
    visit(node, path);
    path.push(node);
    for (const key of Object.keys(node)) {
      if (SKIP.has(key)) continue;
      const v = node[key];
      if (Array.isArray(v)) { for (const c of v) if (c && typeof c.type === "string") go(c); }
      else if (v && typeof v === "object" && typeof v.type === "string") go(v);
    }
    path.pop();
  };
  go(root);
}

export const eolOf = (code: string): string => (code.includes("\r\n") ? "\r\n" : "\n");

// The line primitives know two line breaks, \n and \r\n. JavaScript also ends a line at a lone \r and at U+2028 and
// U+2029: a text holding one of those would have its lines counted wrong (an insertion "after a line" could land
// lines later), so every primitive refuses it with a SpliceError, and the caller shows its snippet.
const OTHER_BREAK = /\r(?!\n)|[\u2028\u2029]/;
let checked: string | null = null;
function checkBreaks(code: string): void {
  if (code === checked) return;
  const m = OTHER_BREAK.exec(code);
  if (m) {
    const line = code.slice(0, m.index).split("\n").length;
    throw new SpliceError(`This file has a line break the wizard does not edit around on line ${line} (${m[0] === "\r" ? "a carriage return without a line feed" : "a Unicode line separator"}).`);
  }
  checked = code;
}

/** The offset where the line holding `i` starts. */
export function lineStart(code: string, i: number): number { checkBreaks(code); return i <= 0 ? 0 : code.lastIndexOf("\n", i - 1) + 1; }
/** The offset of the line break ending the line holding `i` (before its \r), or the text's length. */
export function lineEnd(code: string, i: number): number {
  checkBreaks(code);
  const n = code.indexOf("\n", i);
  if (n < 0) return code.length;
  return code[n - 1] === "\r" ? n - 1 : n;
}
export const indentAt = (code: string, i: number): string => /^[ \t]*/.exec(code.slice(lineStart(code, i)))![0];
export const startsLine = (code: string, start: number): boolean => code.slice(lineStart(code, start), start).trim() === "";
export const endsLine = (code: string, end: number): boolean => code.slice(end, lineEnd(code, end)).trim() === "";
export const endsLineOrComment = (code: string, end: number): boolean => /^\s*(\/\/.*|\/\*.*\*\/\s*)?$/.test(code.slice(end, lineEnd(code, end)));
const breakAt = (code: string, e: number): number => (code.startsWith("\r\n", e) ? 2 : 1);
/** A byte-order mark stays the first character of the file. */
const bomOf = (code: string): number => (code.charCodeAt(0) === 0xfeff ? 1 : 0);
/** Where the line after the one holding `at` starts (the text's length on the last line). */
const nextLineStart = (code: string, at: number): number => { const e = lineEnd(code, at); return e === code.length ? e : e + breakAt(code, e); };

/** Inserts `line` (no line break) as a new line right after the line holding offset `at`, with the file's line breaks. */
export function insertLineAfter(code: string, at: number, line: string): string {
  const end = lineEnd(code, at);
  if (end === code.length) return `${code}${eolOf(code)}${line}`;
  const next = end + breakAt(code, end);
  return code.slice(0, next) + line + eolOf(code) + code.slice(next);
}
/** Inserts `line` as a new line starting at `at`, which is the start of a line (or just after a byte-order mark). */
export function insertLineAt(code: string, at: number, line: string): string {
  checkBreaks(code);
  return code.slice(0, at) + line + eolOf(code) + code.slice(at);
}
/** Removes the lines from `start`'s to `end`'s with one line break (the one after them; on a last line without a
 * break, the one before). A byte-order mark before them stays. The exact inverse of insertLineAfter and insertLineAt. */
export function removeLines(code: string, start: number, end: number): string {
  const bom = bomOf(code);
  const first = lineStart(code, start);
  const s = first === 0 && start >= bom ? bom : first;
  const e = lineEnd(code, end);
  if (e < code.length) return code.slice(0, s) + code.slice(e + breakAt(code, e));
  if (s <= bom) return code.slice(0, s) + code.slice(e);
  const before = s - (code.slice(0, s).endsWith("\r\n") ? 2 : 1);
  return code.slice(0, before) + code.slice(e);
}
/** Removes a statement: its whole line(s) when it is alone on them, otherwise only its own text. */
export function removeStatement(code: string, s: Node): string {
  return startsLine(code, s.start) && endsLine(code, s.end) ? removeLines(code, s.start, s.end) : code.slice(0, s.start) + code.slice(s.end);
}
/** Applies replacements given against one text, from the last to the first, so every offset stays valid. Insertions at
 * one offset end up in the order given. Overlapping replacements are a mistake in the caller and are refused. */
export function applySplices(code: string, splices: Splice[]): string {
  const ordered = splices.map((s, i) => ({ ...s, i })).sort((a, b) => a.start - b.start || a.i - b.i);
  for (let k = 1; k < ordered.length; k++) {
    if (ordered[k].start < ordered[k - 1].end) throw new Error(`Splices overlap at ${ordered[k].start}`);
  }
  return ordered.reverse().reduce((c, s) => c.slice(0, s.start) + s.text + c.slice(s.end), code);
}

const requireCall = (n: Node | null | undefined): Node | null =>
  n?.type === "CallExpression" && n.callee.type === "Identifier" && n.callee.name === "require" && n.arguments[0]?.type === "StringLiteral" ? n : null;

/** The quote most of the file's strings use (directives such as 'use strict' included); double quotes on a tie or with
 * no strings. */
function dominantQuote(code: string, ast: Ast): string {
  let single = 0, double = 0;
  walk(ast.program, (n) => {
    if (n.type !== "StringLiteral" && n.type !== "DirectiveLiteral") return;
    if (code[n.start] === "'") single++;
    else if (code[n.start] === '"') double++;
  });
  return single > double ? "'" : '"';
}

// Statements that end with a semicolon in a file that writes them (a declaration in a for(…) head is not one).
const ENDS_STATEMENT = new Set(["ExpressionStatement", "VariableDeclaration", "ReturnStatement", "ThrowStatement", "BreakStatement", "ContinueStatement", "DebuggerStatement", "ImportDeclaration", "ExportAllDeclaration", "TSImportEqualsDeclaration"]);
/** Whether most of the file's statements end with a semicolon: ";" when they do (or on a tie, or with none), "" when
 * the file leaves them out. */
export function dominantSemicolon(code: string, ast: Ast): string {
  let withSemi = 0, without = 0;
  walk(ast.program, (n, ancestors) => {
    if (!ENDS_STATEMENT.has(n.type)) return;
    const parent = ancestors[ancestors.length - 1];
    if (n.type === "VariableDeclaration" && (parent?.type === "ForStatement" || parent?.type === "ForInStatement" || parent?.type === "ForOfStatement" || parent?.type === "ExportNamedDeclaration")) return;
    if (code[n.end - 1] === ";") withSemi++;
    else without++;
  });
  return without > withSemi ? "" : ";";
}

/** The file's own quotes and semicolons, from its first top-level import or require of a module (TypeScript's
 * `import x = require(…)` too); without one, the quote most of its strings use, and semicolons. */
export function styleOf(code: string, ast: Ast): { q: string; semi: string } {
  for (const s of ast.program.body) {
    const lit = s.type === "ImportDeclaration" ? s.source
      : s.type === "VariableDeclaration" ? requireCall(s.declarations[0]?.init)?.arguments[0]
      : s.type === "TSImportEqualsDeclaration" && s.moduleReference?.type === "TSExternalModuleReference" ? s.moduleReference.expression : null;
    if (lit) return { q: code[lit.start] === "'" ? "'" : '"', semi: code[s.end - 1] === ";" ? ";" : "" };
  }
  return { q: dominantQuote(code, ast), semi: ";" };
}

// TypeScript declarations that bind a name at the top of a module; an import of the same name would conflict with them.
const TS_NAMED = new Set(["TSEnumDeclaration", "TSTypeAliasDeclaration", "TSInterfaceDeclaration", "TSModuleDeclaration", "TSImportEqualsDeclaration", "TSDeclareFunction"]);

/** The names bound at the top of the module: imports, declarations (destructured too), functions, classes, and
 * TypeScript's enums, types, interfaces, namespaces and import-equals. */
export function topLevelNames(ast: Ast): Set<string> {
  const names = new Set<string>();
  const add = (p: Node | null | undefined): void => {
    if (!p) return;
    if (p.type === "Identifier") names.add(p.name);
    else if (p.type === "ObjectPattern") for (const prop of p.properties) add(prop.type === "RestElement" ? prop.argument : prop.value);
    else if (p.type === "ArrayPattern") for (const e of p.elements) add(e);
    else if (p.type === "AssignmentPattern") add(p.left);
    else if (p.type === "RestElement") add(p.argument);
  };
  for (const raw of ast.program.body) {
    const s = (raw.type === "ExportNamedDeclaration" || raw.type === "ExportDefaultDeclaration") && raw.declaration ? raw.declaration : raw;
    if (s.type === "ImportDeclaration") for (const sp of s.specifiers) names.add(sp.local.name);
    else if (s.type === "VariableDeclaration") for (const d of s.declarations) add(d.id);
    else if ((s.type === "FunctionDeclaration" || s.type === "ClassDeclaration") && s.id) names.add(s.id.name);
    else if (TS_NAMED.has(s.type) && s.id?.type === "Identifier") names.add(s.id.name);
  }
  return names;
}

const KEYED = new Set(["ObjectProperty", "ObjectMethod", "ClassProperty", "ClassMethod", "ClassAccessorProperty", "ClassPrivateProperty", "TSPropertySignature", "TSMethodSignature", "TSEnumMember"]);
/** Whether an identifier names the binding `parent` sees, rather than a property, a key or a label. */
function isReference(n: Node, parent: Node | undefined): boolean {
  if (!parent) return true;
  if ((parent.type === "MemberExpression" || parent.type === "OptionalMemberExpression") && parent.property === n) return !!parent.computed;
  if (KEYED.has(parent.type) && parent.key === n) return !!parent.computed || !!parent.shorthand;
  if ((parent.type === "LabeledStatement" || parent.type === "BreakStatement" || parent.type === "ContinueStatement") && parent.label === n) return false;
  if (parent.type === "ExportSpecifier" && parent.exported === n) return parent.local === n;
  if (parent.type === "TSQualifiedName" && parent.right === n) return false;
  return true;
}

/** The first identifier named `name` outside import declarations (and outside `except` when it is given) that is not
 * a property name, a key or a label, or null. This does not follow scopes: a local variable of that name counts too,
 * which errs on the side of "used" (Babel's scope analysis is in @babel/traverse, which the wizard does not ship). */
export function identifierUse(ast: Ast, name: string, except?: Node): Node | null {
  let found: Node | null = null;
  walk(ast.program, (n, ancestors) => {
    if (found || n.type !== "Identifier" || n.name !== name) return;
    if (except && n.start >= except.start && n.end <= except.end) return;
    if (ancestors.some((a) => a.type === "ImportDeclaration")) return;
    if (isReference(n, ancestors[ancestors.length - 1])) found = n;
  });
  return found;
}
/** Whether identifierUse finds `name`. */
export const identifierUsed = (ast: Ast, name: string, except?: Node): boolean => identifierUse(ast, name, except) !== null;

/** Whether a new line starting at `pos` would fall inside a statement, a directive or a comment. */
function occupied(ast: Ast, pos: number): boolean {
  const spans: Node[] = [...ast.program.body, ...((ast.program.directives as Node[] | undefined) ?? []), ...(ast.comments ?? [])];
  return spans.some((n) => n.start < pos && pos < n.end);
}

const lineOf = (code: string, i: number): number => { let n = 0; for (let k = code.indexOf("\n"); k >= 0 && k < i; k = code.indexOf("\n", k + 1)) n++; return n; };
// Comments that must stay first: pinned (/*!), TypeScript's triple-slash directives, and pragmas tools read only from
// the top of a file (@ts-check, @ts-nocheck, @jsx…, @flow).
const PINNED = /^(\/\*!|\/\/\/)|@(ts-check|ts-nocheck|jsx|jsxImportSource|jsxRuntime|jsxFrag|flow)\b/;

/** The end of what stays above an import added to a file with no imports or directives: its shebang, and the comments
 * above its first statement that are pinned, a pragma, or a header (a blank line below them); a comment right above
 * the first statement belongs to that statement and stays with it. null: the top of the file. As TypeScript's own
 * auto-import places a first import (getInsertionPositionAtSourceFileTop). */
function topAnchor(code: string, ast: Ast): number | null {
  let end: number | null = (ast.program.interpreter as Node | null | undefined)?.end ?? null;
  const first = ast.program.body[0];
  let pinnedLast = false;
  let last: Node | null = null;
  for (const c of ast.comments ?? []) {
    if (first && c.end > first.start) break;
    if (end !== null && c.start < end) continue;
    if (!endsLine(code, c.end)) break;
    if (PINNED.test(code.slice(c.start, c.end))) { last = c; pinnedLast = true; continue; }
    if (last) {
      if (pinnedLast) break;
      if (lineOf(code, c.start) >= lineOf(code, last.end) + 2) break;
    }
    if (first && lineOf(code, first.start) < lineOf(code, c.end) + 2) break;
    last = c;
    pinnedLast = false;
  }
  if (last) end = last.end;
  return end;
}

/** Adds an import (or require) line: after the last top-level import, else after `after` (the last top-level require
 * of a CommonJS file), else after a directive prologue ("use strict"), else at the top (below a shebang and header
 * comments). Throws SpliceError when the new line would fall inside a comment or a statement, or when the file has a
 * line break other than \n and \r\n (as every line primitive here does). */
export function addImportLine(code: string, ast: Ast, line: string, after?: Node | null): string {
  const imports = ast.program.body.filter((s) => s.type === "ImportDeclaration");
  const directives: Node[] = (ast.program.directives as Node[] | undefined) ?? [];
  const anchor = imports.length ? imports[imports.length - 1].end : after ? after.end : directives.length ? directives[directives.length - 1].end : topAnchor(code, ast);
  const at = anchor === null ? bomOf(code) : nextLineStart(code, anchor);
  if (occupied(ast, at)) throw new SpliceError("The line where the import would go is inside a comment or a statement that continues on the next line.");
  return anchor === null ? insertLineAt(code, at, line) : insertLineAfter(code, anchor, line);
}

/** Removes the import, or top-level `const { … } = require(…)`, of exactly `names` from `source` (not renamed, not
 * type-only), with its line. */
export function removeImportLine(code: string, ast: Ast, source: string, names: string[]): string {
  const same = (got: Array<string | null>) => got.length === names.length && got.every((n) => n !== null && names.includes(n));
  const plain = (sp: Node): string | null => {
    const imported = sp.imported?.name ?? sp.imported?.value;
    return sp.type === "ImportSpecifier" && sp.importKind !== "type" && imported === sp.local.name ? imported : null;
  };
  for (const s of ast.program.body) {
    if (s.type === "ImportDeclaration" && s.importKind !== "type" && s.source.value === source && same(s.specifiers.map(plain))) return removeStatement(code, s);
    if (s.type === "VariableDeclaration" && s.declarations.length === 1) {
      const d = s.declarations[0];
      if (requireCall(d.init)?.arguments[0].value === source && d.id.type === "ObjectPattern" && same(d.id.properties.map((p: Node) => (p.type === "ObjectProperty" && p.shorthand ? p.key.name : null)))) return removeStatement(code, s);
    }
  }
  return code;
}
