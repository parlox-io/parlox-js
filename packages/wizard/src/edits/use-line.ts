import { addImportLine, dominantSemicolon, endsLineOrComment, identifierUse, identifierUsed, indentAt, insertLineAfter, parseCode, removeImportLine, removeStatement, SpliceError, styleOf, topLevelNames, walk, type Ast, type Node, type SpliceEdit } from "./splice.js";

// The server part for Express and Hono: `X.use(parlox());` right after `const X = express()` (or `new Hono(…)`), so it
// runs before every route (Express: "The order of middleware loading is important… If myLogger is loaded after the
// route… the request never reaches it"), and the import in the file's own module system. Routers (express.Router())
// and sub-apps are ignored. Anything the wizard cannot place exactly is a snippet.
//
// What is inserted: the fixed import path and the fixed `.use(parlox())`, the app's name as the parser
// returned it (re-checked to be a plain identifier), indentation copied from the declaration's line, and the file's own
// quote and semicolon characters. The edit is made only when removeUseLine gives back the original bytes.

export type AppKind = "express" | "hono";
export interface AppDecl { name: string; stmt: Node; basePath: string | null }
export interface UseSpec { kind: AppKind; source: string; pkgType: string | undefined }

const NAME = "parlox";
// TypeScript's `import x = require(…)` binds the whole module: in a file written that way, the wizard writes
// `import parloxServer = require("…")` and `.use(parloxServer.parlox())`.
const NS = "parloxServer";
// A name the wizard writes into a file: plain ASCII (a Unicode or escaped name is a snippet).
const PLAIN_IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

const unwrap = (n: Node): Node => (n && (n.type === "TSAsExpression" || n.type === "TSSatisfiesExpression" || n.type === "TSNonNullExpression" || n.type === "ParenthesizedExpression") ? unwrap(n.expression) : n);
const requireOf = (n: Node | null | undefined): string | null => {
  const c = n ? unwrap(n) : null;
  return c?.type === "CallExpression" && c.callee.type === "Identifier" && c.callee.name === "require" && c.arguments[0]?.type === "StringLiteral" ? c.arguments[0].value : null;
};
const lineOf = (n: Node): number => n.loc?.start?.line ?? 0;

// The classes that create a Hono app, by module: Hono itself, and @hono/zod-openapi's OpenAPIHono, which extends it.
const HONO_APPS: Record<string, string> = { hono: "Hono", "hono/tiny": "Hono", "hono/quick": "Hono", "@hono/zod-openapi": "OpenAPIHono" };

// The local names that create an app: express's default or namespace import, its require (TypeScript's
// `import express = require("express")` too); Hono's `Hono` export (OpenAPIHono's).
function bindings(ast: Ast, kind: AppKind): Set<string> {
  const names = new Set<string>();
  const sources = kind === "express" ? ["express"] : Object.keys(HONO_APPS);
  for (const s of ast.program.body) {
    if (kind === "express" && s.type === "TSImportEqualsDeclaration" && s.moduleReference?.type === "TSExternalModuleReference" && s.moduleReference.expression?.value === "express") names.add(s.id.name);
    if (s.type !== "ImportDeclaration" || s.importKind === "type" || !sources.includes(s.source.value)) continue;
    for (const sp of s.specifiers) {
      if (kind === "express" && (sp.type === "ImportDefaultSpecifier" || sp.type === "ImportNamespaceSpecifier")) names.add(sp.local.name);
      if (kind === "hono" && sp.type === "ImportSpecifier" && sp.importKind !== "type" && (sp.imported.name ?? sp.imported.value) === HONO_APPS[s.source.value]) names.add(sp.local.name);
    }
  }
  walk(ast.program, (n) => {
    if (n.type !== "VariableDeclarator") return;
    const src = requireOf(n.init);
    if (!src || !sources.includes(src)) return;
    if (kind === "express" && n.id.type === "Identifier") names.add(n.id.name);
    if (kind === "hono" && n.id.type === "ObjectPattern") for (const p of n.id.properties) if (p.key?.name === HONO_APPS[src] && p.value?.type === "Identifier") names.add(p.value.name);
  });
  return names;
}

// `express()`; `new Hono(…)` (type arguments included), or `new Hono(…).basePath("/api")`.
function created(init: Node, kind: AppKind, names: Set<string>): { basePath: string | null } | null {
  const n = unwrap(init);
  if (kind === "express") return n.type === "CallExpression" && n.callee.type === "Identifier" && names.has(n.callee.name) && n.arguments.length === 0 ? { basePath: null } : null;
  if (n.type === "NewExpression" && n.callee.type === "Identifier" && names.has(n.callee.name)) return { basePath: null };
  if (n.type === "CallExpression" && n.callee.type === "MemberExpression" && n.callee.property?.name === "basePath" && n.arguments[0]?.type === "StringLiteral" && created(n.callee.object, kind, names)?.basePath === null) return { basePath: n.arguments[0].value };
  return null;
}

/** Every `const|let|var X = express()` (or `new Hono(…)`) that is a statement of the file or of a function body. */
export function findAppDeclarations(ast: Ast, kind: AppKind): AppDecl[] {
  const names = bindings(ast, kind);
  const out: AppDecl[] = [];
  if (!names.size) return out;
  walk(ast.program, (n, ancestors) => {
    if (n.type !== "VariableDeclarator" || n.id.type !== "Identifier" || !n.init) return;
    const made = created(n.init, kind, names);
    if (!made) return;
    const decl = ancestors[ancestors.length - 1];
    const holder = ancestors[ancestors.length - 2];
    const stmt = holder?.type === "ExportNamedDeclaration" ? holder : decl;
    const list = holder?.type === "ExportNamedDeclaration" ? ancestors[ancestors.length - 3] : holder;
    if (decl?.type !== "VariableDeclaration" || (list?.type !== "Program" && list?.type !== "BlockStatement")) return;
    out.push({ name: n.id.name, stmt, basePath: made.basePath });
  });
  return out;
}

/** The file's module system: .mjs/.mts and .cjs/.cts decide; then its own imports or requires; then package.json's
 * type (TypeScript files write import either way: the compiler turns it into require where needed). */
export function moduleSystemOf(file: string, ast: Ast, pkgType: string | undefined): "esm" | "cjs" {
  if (/\.(mjs|mts)$/.test(file)) return "esm";
  if (/\.(cjs|cts)$/.test(file)) return "cjs";
  if (ast.program.body.some((s) => s.type === "ImportDeclaration" || s.type === "ExportNamedDeclaration" || s.type === "ExportDefaultDeclaration")) return "esm";
  let required = false;
  walk(ast.program, (n) => { if (!required && requireOf(n) !== null) required = true; });
  if (required) return "cjs";
  return pkgType === "module" || /\.tsx?$/.test(file) ? "esm" : "cjs";
}

/** A top-level statement that loads a module, as styleOf reads its style from: an import, a require, an import-equals. */
const moduleLine = (s: Node): boolean => s.type === "ImportDeclaration"
  || (s.type === "VariableDeclaration" && s.declarations[0]?.init?.type === "CallExpression" && requireOf(s.declarations[0].init) !== null)
  || (s.type === "TSImportEqualsDeclaration" && s.moduleReference?.type === "TSExternalModuleReference");

const equalsOf = (s: Node, source?: string): boolean => s.type === "TSImportEqualsDeclaration" && !s.isExport && s.importKind !== "type"
  && s.moduleReference?.type === "TSExternalModuleReference" && (source === undefined || s.moduleReference.expression?.value === source);

/** The wizard's own import: `import { parlox } from "<source>"`, `const { parlox } = require("<source>")` (the name may
 * have been renamed by hand; then that name is what .use() calls), or `import X = require("<source>")` (`member`: then
 * .use() calls X.parlox()). */
function importOf(ast: Ast, source: string): { local: string; stmt: Node; member: boolean } | null {
  for (const s of ast.program.body) {
    if (equalsOf(s, source)) return { local: s.id.name, stmt: s, member: true };
    if (s.type === "ImportDeclaration" && s.importKind !== "type" && s.source.value === source) {
      const sp = s.specifiers.find((x: Node) => x.type === "ImportSpecifier" && x.importKind !== "type" && (x.imported.name ?? x.imported.value) === NAME);
      if (sp) return { local: sp.local.name, stmt: s, member: false };
    }
    if (s.type === "VariableDeclaration" && s.declarations.length === 1 && requireOf(s.declarations[0].init) === source && s.declarations[0].id.type === "ObjectPattern") {
      const p = s.declarations[0].id.properties.find((x: Node) => x.key?.name === NAME && x.value?.type === "Identifier");
      if (p) return { local: p.value.name, stmt: s, member: false };
    }
  }
  return null;
}

/** Whether the file loads `source` at all: an import or re-export, require(), import(). */
function loads(ast: Ast, source: string): boolean {
  let found = false;
  const named = (lit: Node | undefined) => lit?.type === "StringLiteral" && lit.value === source;
  walk(ast.program, (n) => {
    if (found) return;
    if ((n.type === "ImportDeclaration" || n.type === "ExportNamedDeclaration" || n.type === "ExportAllDeclaration") && named(n.source)) found = true;
    else if (n.type === "CallExpression" && ((n.callee.type === "Identifier" && n.callee.name === "require") || n.callee.type === "Import") && named(n.arguments[0])) found = true;
    else if (n.type === "ImportExpression" && named(n.source)) found = true;
    else if (n.type === "TSImportEqualsDeclaration" && named(n.moduleReference?.expression)) found = true;
  });
  return found;
}

/** The `.use(parlox(…))` statements (`.use(X.parlox(…))` for an import-equals import). */
function useCalls(ast: Ast, imp: { local: string; member: boolean }): Node[] {
  const out: Node[] = [];
  const calls = (f: Node): boolean => (imp.member
    ? f.type === "MemberExpression" && !f.computed && f.object.type === "Identifier" && f.object.name === imp.local && f.property.type === "Identifier" && f.property.name === NAME
    : f.type === "Identifier" && f.name === imp.local);
  walk(ast.program, (n) => {
    if (n.type !== "ExpressionStatement" || n.expression.type !== "CallExpression") return;
    const c = n.expression;
    const arg = c.arguments[0];
    if (c.callee.type === "MemberExpression" && c.callee.property?.name === "use" && c.arguments.length === 1 && arg?.type === "CallExpression" && calls(arg.callee)) out.push(n);
  });
  return out;
}

// A require goes with the others: after the last top-level require (or import-equals) before the app is created.
function lastRequireBefore(ast: Ast, pos: number): Node | null {
  let last: Node | null = null;
  for (const s of ast.program.body) if (s.end <= pos && ((s.type === "VariableDeclaration" && s.declarations.some((d: Node) => requireOf(d.init) !== null)) || equalsOf(s))) last = s;
  return last;
}

const WHAT = { express: "express() call", hono: "new Hono() call" } as const;
/** The paste-in snippet for the server part, when the wizard does not edit the file itself. */
export const useSnippet = (kind: AppKind, source: string): string => kind === "express"
  ? `import { parlox } from "${source}";   // CommonJS: const { parlox } = require("${source}");\napp.use(parlox());   // right after \`const app = express()\`, before your routes`
  : `import { parlox } from "${source}";\napp.use(parlox());   // right after \`const app = new Hono()\`, before your routes`;

export function addUseLine(code: string, file: string, spec: UseSpec): SpliceEdit & { app?: string; basePath?: string | null } {
  const manual = (reason: string) => ({ ok: false as const, reason, snippet: useSnippet(spec.kind, spec.source) });
  const ast = parseCode(code, file);
  if (!ast) return manual("The wizard could not read this file.");
  const existing = importOf(ast, spec.source);
  if (existing) return useCalls(ast, existing).length ? { ok: true, code, changed: false } : manual("Parlox is imported here but not added with .use(parlox()).");
  if (loads(ast, spec.source)) return manual(`Parlox is imported here in a way the wizard did not write (not \`import { parlox } from "${spec.source}"\`); check that the app has .use(parlox()).`);
  const apps = findAppDeclarations(ast, spec.kind);
  if (apps.length !== 1) return manual(apps.length ? `The app is created more than once in this file (${apps.map((a) => a.name).join(", ")}).` : `No ${WHAT[spec.kind]} assigned to a variable found in this file.`);
  const { name, stmt, basePath } = apps[0];
  if (!PLAIN_IDENTIFIER.test(name)) return manual(`The app's name (${name}) is not one the wizard writes into a file (ASCII letters, digits, _ and $ only).`);
  // A TypeScript file that imports with `import x = require(…)` (and no import declarations) gets the same form.
  const equals = /\.[cm]?tsx?$/.test(file) && ast.program.body.some((s) => equalsOf(s)) && !ast.program.body.some((s) => s.type === "ImportDeclaration" && s.importKind !== "type");
  const bound = equals ? NS : NAME;
  let out: string;
  try {
    if (!endsLineOrComment(code, stmt.end)) return manual("The line that creates the app has more code after it.");
    if (topLevelNames(ast).has(bound)) return manual(`This file already has something named ${bound}.`);
    // Not scope-aware (edits/splice.ts): a local or a parameter of that name would make the .use() line call it.
    const taken = identifierUse(ast, bound);
    if (taken) return manual(`This file uses the name ${bound} on line ${lineOf(taken)}, so the wizard's import could not be told apart from it.`);
    // The quote and semicolon of the file's first top-level import or require; without one, those most of the file uses.
    const style = styleOf(code, ast);
    const q = style.q;
    const semi = ast.program.body.some(moduleLine) ? style.semi : dominantSemicolon(code, ast);
    const system = equals ? "cjs" : moduleSystemOf(file, ast, spec.pkgType);
    const use = `${name}.use(${equals ? `${NS}.${NAME}` : NAME}())${semi}`;
    out = insertLineAfter(code, stmt.end, `${indentAt(code, stmt.start)}${use}`);
    const reparsed = parseCode(out, file);
    if (!reparsed) return manual("The file would not parse with Parlox added.");
    const line = equals ? `import ${NS} = require(${q}${spec.source}${q})${semi}`
      : system === "esm" ? `import { ${NAME} } from ${q}${spec.source}${q}${semi}` : `const { ${NAME} } = require(${q}${spec.source}${q})${semi}`;
    out = addImportLine(out, reparsed, line, system === "cjs" ? lastRequireBefore(reparsed, stmt.start) : null);
    // Without semicolons, a line that starts with ( [ or ` continues the one before it: the added lines must each be a
    // statement of their own, as written.
    const added = parseCode(out, file);
    const imp = added ? importOf(added, spec.source) : null;
    const uses = added && imp ? useCalls(added, imp) : [];
    if (!imp || imp.local !== bound || imp.member !== equals || uses.length !== 1 || out.slice(uses[0].start, uses[0].end) !== use) return manual("A line the wizard would add would run into the line after it (the file leaves out semicolons, and that line starts with a bracket).");
  } catch (err) {
    if (err instanceof SpliceError) return manual(err.message);
    throw err;
  }
  const back = removeUseLine(out, file, spec.source);
  if (!back.ok || back.code !== code) return manual("The wizard could not add it in a way it can take out again exactly.");
  return { ok: true, code: out, changed: true, app: name, basePath };
}

/** The exact inverse of addUseLine. A lone import of the wizard's (its .use line removed by hand) goes too: once the
 * package is removed, it would stop the app from starting. */
export function removeUseLine(code: string, file: string, source: string): SpliceEdit {
  const manual = (reason: string) => ({ ok: false as const, reason, snippet: `Remove .use(parlox()) and the import of ${source} by hand.` });
  const ast = parseCode(code, file);
  if (!ast) return manual("The wizard could not read this file.");
  const imp = importOf(ast, source);
  if (!imp) return loads(ast, source) ? manual(`This file loads ${source} in a way the wizard did not write, and the uninstall removes the package.`) : { ok: true, code, changed: false };
  try {
    const all = useCalls(ast, imp);
    const uses = all.filter((u) => u.expression.arguments[0].arguments.length === 0);
    if (uses.length > 1 || all.length !== uses.length) return manual("Parlox is added here in a way the wizard did not write (with options, or more than once).");
    let out = uses.length ? removeStatement(code, uses[0]) : code;
    const after = parseCode(out, file);
    if (!after) return manual("The file would not parse without Parlox.");
    if (identifierUsed(after, imp.local, importOf(after, source)!.stmt)) return manual(`${imp.local} is used elsewhere in this file.`);
    // An import-equals line binds one name only: it goes whole.
    out = imp.member ? removeStatement(out, importOf(after, source)!.stmt) : removeImportLine(out, after, source, [NAME]);
    const left = parseCode(out, file);
    if (!left || loads(left, source)) return manual(`The import of ${source} here is not the one the wizard writes.`);
    return { ok: true, code: out, changed: out !== code };
  } catch (err) {
    if (err instanceof SpliceError) return manual(err.message);
    throw err;
  }
}
