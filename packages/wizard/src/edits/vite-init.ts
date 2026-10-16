import { PUBLIC_KEY_RE } from "./browser.js";
import { browserUses, removedEdit } from "./browser-use.js";
import { addImportLine, dominantSemicolon, identifierUse, insertLineAfter, parseCode, removeImportLine, removeStatement, SpliceError, styleOf, topLevelNames, type Ast, type Node, type SpliceEdit } from "./splice.js";

// The browser part of a Vite app whose framework needs no Parlox component (Vite Vue): `init({ publicKey })` from
// @parlox/browser, the SDK's own usage outside React (its README: `import { init, track } from "@parlox/browser";
// init({ publicKey: "pk_..." });`), as a statement of its own right after the entry's imports. Imports are evaluated
// first, so it runs before createApp(App).mount(…); the tracker starts once per page and follows single-page navigation
// (history.pushState, which Vue Router uses). What is inserted: the fixed import line after the last top-level import
// and the fixed call on the line after it, the validated key the only variable, in the file's own quotes and
// semicolons (edits/splice.ts, styleOf). The edit is made only when removeViteInit gives back the original bytes.
//
// Already installed means the wizard's import (`import { init } from "@parlox/browser"`, not renamed) and one top-level
// call of it with the key written as a string. A file that loads @parlox/browser in any other way is left to the
// developer: it may already start Parlox with options of its own (consent: "required"), and the SDK keeps the first
// init() of a page, so a call of the wizard's that ran first would set those options aside.

const SOURCE = "@parlox/browser";
const NAME = "init";
const importLine = (q: string, semi: string) => `import { ${NAME} } from ${q}${SOURCE}${q}${semi}`;
const callLine = (pk: string, q: string, semi: string) => `${NAME}({ publicKey: ${q}${pk}${q} })${semi}`;
/** The paste-in snippet for a Vite entry the wizard does not edit. */
export const viteInitSnippet = (pk: string) => `${importLine('"', ";")}\n${callLine(pk, '"', ";")}`;
const REMOVE_SNIPPET = `Remove \`${importLine('"', "")}\` and the init({ publicKey: … }) call by hand.`;
const lineOf = (n: Node): number => n.loc?.start?.line ?? 0;

/** The wizard's import: `import { init } from "@parlox/browser"`, one name, not renamed, not a type. */
const isOwnImport = (s: Node): boolean => s.type === "ImportDeclaration" && s.importKind !== "type" && s.source.value === SOURCE && !s.attributes?.length && s.specifiers.length === 1
  && s.specifiers[0].type === "ImportSpecifier" && s.specifiers[0].importKind !== "type" && (s.specifiers[0].imported.name ?? s.specifiers[0].imported.value) === NAME && s.specifiers[0].local.name === NAME;
/** An import or re-export of types only, which TypeScript erases before the code runs. */
const typeOnly = (n: Node): boolean =>
  (n.type === "ImportDeclaration" && (n.importKind === "type" || (n.specifiers.length > 0 && n.specifiers.every((sp: Node) => sp.importKind === "type"))))
  || (n.type === "ExportNamedDeclaration" && (n.exportKind === "type" || (n.specifiers.length > 0 && n.specifiers.every((sp: Node) => sp.exportKind === "type"))));
/** The top-level statements that call `init(…)`. */
const initCalls = (ast: Ast): Node[] => ast.program.body.filter((s) => s.type === "ExpressionStatement" && s.expression.type === "CallExpression" && s.expression.callee.type === "Identifier" && s.expression.callee.name === NAME);
const isPublicKey = (p: Node): boolean => p.type === "ObjectProperty" && !p.computed && ((p.key.type === "Identifier" && p.key.name === "publicKey") || (p.key.type === "StringLiteral" && p.key.value === "publicKey"));
/** The key of `init({ …, publicKey: "<key>", … })` whose options are all plain properties; else null. */
function keyOf(call: Node): string | null {
  const o = call.arguments.length === 1 ? call.arguments[0] : null;
  if (o?.type !== "ObjectExpression" || !o.properties.every((p: Node) => p.type === "ObjectProperty" && !p.computed)) return null;
  const keys = o.properties.filter(isPublicKey);
  return keys.length === 1 && keys[0].value.type === "StringLiteral" ? keys[0].value.value : null;
}
/** The key of the call exactly as the wizard writes it, `init({ publicKey: "<key>" })` and nothing else; else null. */
function exactKey(call: Node): string | null {
  const o = call.arguments.length === 1 ? call.arguments[0] : null;
  return o?.type === "ObjectExpression" && o.properties.length === 1 ? keyOf(call) : null;
}

export function addViteInit(code: string, file: string, publicKey: string): SpliceEdit {
  if (!PUBLIC_KEY_RE.test(publicKey)) throw new Error("Refusing to write an invalid public key");
  const refuse = (reason: string): SpliceEdit => ({ ok: false, reason, snippet: viteInitSnippet(publicKey) });
  const ast = parseCode(code, file);
  if (!ast) return refuse("The wizard could not read this file.");
  if (ast.program.body.some(isOwnImport)) {
    const calls = initCalls(ast);
    const key = calls.length === 1 && !identifierUse(ast, NAME, calls[0]) ? keyOf(calls[0].expression) : null;
    if (key === null) return refuse(`Parlox's init is imported here, but not called once as its own statement with the key written out (init({ publicKey: "pk_…" })); the wizard leaves it as it is.`);
    return key === publicKey ? { ok: true, code, changed: false } : refuse(`Parlox is already added here with another key (${key}).`);
  }
  const other = browserUses(ast).find((n) => !typeOnly(n));
  if (other) return refuse(`This file already loads @parlox/browser on line ${lineOf(other)} in a way the wizard did not write (not \`${importLine('"', "")}\`), so Parlox may already start here with options of its own; the wizard leaves it as it is. Check that init({ publicKey }) runs once, with this site's key.`);
  const rename = `Add Parlox under another name: import { init as initParlox } from "${SOURCE}", then initParlox({ publicKey: "${publicKey}" }) right after the imports.`;
  if (topLevelNames(ast).has(NAME)) return refuse(`This file already has something named init, so the wizard's import of init would clash with it. ${rename}`);
  // Not scope-aware (edits/splice.ts): any binding of the name would make the call refer to it, not to the import.
  const local = identifierUse(ast, NAME);
  if (local) return refuse(`This file uses the name init on line ${lineOf(local)}, so the wizard's import of init could not be told apart from it. ${rename}`);
  // The quote and semicolon of the file's first import; without one, those most of the file uses.
  const style = styleOf(code, ast);
  const semi = ast.program.body.some((s) => s.type === "ImportDeclaration") ? style.semi : dominantSemicolon(code, ast);
  const imp = importLine(style.q, semi), call = callLine(publicKey, style.q, semi);
  let out: string;
  try {
    out = addImportLine(code, ast, imp);
    const withImport = parseCode(out, file);
    const added = withImport?.program.body.find(isOwnImport);
    if (!added) return refuse("The file would not parse with Parlox added.");
    out = insertLineAfter(out, added.end, call);
  } catch (err) {
    if (err instanceof SpliceError) return refuse(err.message);
    throw err;
  }
  // Without semicolons, a line that starts with ( [ or ` continues the one before it: each added line must be a
  // statement of its own, exactly as written.
  const after = parseCode(out, file);
  if (!after) return refuse("The file would not parse with Parlox added.");
  const own = after.program.body.filter(isOwnImport);
  const calls = initCalls(after);
  if (own.length !== 1 || out.slice(own[0].start, own[0].end) !== imp || calls.length !== 1 || out.slice(calls[0].start, calls[0].end) !== call) return refuse("A line the wizard would add would run into the line after it (the file leaves out semicolons, and that line starts with a bracket or a backtick).");
  const back = removeViteInit(out, file);
  if (!back.ok || back.code !== code) return refuse("The wizard could not add it in a way it can take out again exactly.");
  return { ok: true, code: out, changed: true };
}

/** The exact inverse of addViteInit: the call and the import, each with its own line, wherever the developer moved
 * them. A lone import of the wizard's (its call removed by hand) goes too: once the package is removed, it would break
 * the build. Any other use of @parlox/browser left in the file is named in `warning`. */
export function removeViteInit(code: string, file: string): SpliceEdit {
  const manual = (reason: string): SpliceEdit => ({ ok: false, reason, snippet: REMOVE_SNIPPET });
  const ast = parseCode(code, file);
  if (!ast) return manual("The wizard could not read this file.");
  try {
    const calls = initCalls(ast);
    if (!ast.program.body.some(isOwnImport)) {
      // The wizard's call left behind without its import, the name bound to nothing in the file.
      const orphan = topLevelNames(ast).has(NAME) ? undefined : calls.find((c) => PUBLIC_KEY_RE.test(exactKey(c.expression) ?? ""));
      if (orphan) return manual(`Line ${lineOf(orphan)} calls init({ publicKey: … }), Parlox's call, without the wizard's import of it, so it calls a name that is not there; remove that line by hand.`);
      return removedEdit(code, code, file);
    }
    if (calls.length > 1 || (calls.length === 1 && exactKey(calls[0].expression) === null) || identifierUse(ast, NAME, calls[0])) return manual("Parlox's init is called here in a way the wizard did not write (with options of your own, more than once, or inside other code); remove it and its import by hand.");
    let out = calls.length ? removeStatement(code, calls[0]) : code;
    const after = parseCode(out, file);
    if (!after) return manual("The file would not parse without Parlox.");
    out = removeImportLine(out, after, SOURCE, [NAME]);
    return removedEdit(code, out, file);
  } catch (err) {
    if (err instanceof SpliceError) return manual(err.message);
    throw err;
  }
}
