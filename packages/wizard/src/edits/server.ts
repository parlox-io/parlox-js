import { b, ensureNamedImport, n, parse, print, removeNamedImport, type Edit } from "./parse.js";

const SOURCE = "@parlox/server/next";
const NAME = "withParlox";
const MIDDLEWARE_NAMES = new Set(["middleware", "proxy"]);

// Same matcher as the install guide: pages, robots.txt, llms.txt, sitemaps and /.well-known/parlox-verify run it;
// static assets and API routes do not.
export const MIDDLEWARE_TEMPLATE = `import { withParlox } from "@parlox/server/next";

export default withParlox();

export const config = {
  matcher: ["/((?!_next/static|_next/image|api/|favicon.ico|.*\\\\.(?:png|jpe?g|gif|svg|webp|avif|ico|css|js|map|woff2?)$).*)"],
};
`;

const SNIPPET = `import { withParlox } from "@parlox/server/next";\n\n// wrap your existing middleware's default export:\nexport default withParlox(yourMiddleware);`;
const MATCHER_WARNING = "This file has its own matcher. Parlox's server part only runs where it matches: make sure it includes /.well-known/parlox-verify and your pages (the local check below confirms the first).";
const isWrapped = (expr: any): boolean => n.CallExpression.check(expr) && n.Identifier.check(expr.callee) && expr.callee.name === NAME;
const wrap = (expr: any) => b.callExpression(b.identifier(NAME), [expr]);

/** True only for a `matcher` property inside the object of an exported `config` declaration — the
 * shape Next.js's own middleware config uses — not any property named `matcher` anywhere in the file. */
function hasMatcher(ast: any): boolean {
  for (const s of ast.program.body as any[]) {
    if (!n.ExportNamedDeclaration.check(s)) continue;
    const d = (s as any).declaration;
    if (!n.VariableDeclaration.check(d)) continue;
    for (const decl of d.declarations as any[]) {
      if (decl.id?.name !== "config" || !n.ObjectExpression.check(decl.init)) continue;
      if ((decl.init.properties as any[]).some((p) => (p.key?.name ?? p.key?.value) === "matcher")) return true;
    }
  }
  return false;
}

/**
 * Recast gives a brand-new statement no blank-line context of its own, and its behaviour when one is
 * spliced next to reused statements is inconsistent (sometimes a blank line before, never one after).
 * So the exact blank-line layout around the inserted `export default withParlox(...)` line is set here,
 * by hand, once printing is done: one blank line before it always, and the blank line that used to
 * follow the declaration it wraps (if there was one) after it — so the diff a merchant reviews is
 * exactly "export removed from the declaration" plus "one line added, with a blank line before it".
 *
 * The inserted statement is located by re-parsing the freshly printed code and finding its
 * ExportDefaultDeclaration — there is exactly one, by construction, on every path that calls this —
 * never by searching the printed text for the statement's own source text. A text search would also
 * match (and corrupt) that same text if it happened to appear inside a string, template literal or
 * comment written elsewhere in the file.
 */
function placeNewDefaultLine(code: string, file: string, hadBlankLineAfter: boolean): string {
  const nl = code.includes("\r\n") ? "\r\n" : "\n";
  let reparsed: any;
  try { reparsed = parse(code, file); } catch { return code; }
  const stmt = (reparsed.program.body as any[]).find((s) => n.ExportDefaultDeclaration.check(s) && isWrapped(s.declaration));
  if (!stmt?.loc) return code;
  const lines = code.split(nl);
  let i = stmt.loc.start.line - 1;
  if (i > 0 && lines[i - 1] !== "") {
    lines.splice(i, 0, "");
    i += 1;
  }
  const hasBlankAfter = i + 1 < lines.length && lines[i + 1] === "";
  if (hadBlankLineAfter && !hasBlankAfter) lines.splice(i + 1, 0, "");
  if (!hadBlankLineAfter && hasBlankAfter) lines.splice(i + 1, 1);
  return lines.join(nl);
}

/** Whether there was a blank source line between `stmt` and the statement right after it (before any
 * of this edit's splicing), from their original parsed positions. */
const hadBlankLineAfter = (stmt: any, next: any): boolean =>
  !!(stmt?.loc && next?.loc && next.loc.start.line - stmt.loc.end.line > 1);

/**
 * Babel (and so recast) always attaches a comment written above, below or beside an `export ...`
 * statement to that outer export node, never to the declaration it wraps. Splicing the export
 * statement out of the body and keeping only its inner declaration would silently drop the comment
 * unless it is moved across first.
 */
function moveComments(from: any, to: any): void {
  if (!from?.comments?.length) return;
  to.comments = [...(to.comments ?? []), ...from.comments];
  from.comments = undefined;
}

export function addServer(existing: string | null, file: string): Edit & { matcherWarning?: string } {
  if (existing === null) return { ok: true, code: MIDDLEWARE_TEMPLATE, changed: true };
  let ast: any;
  try { ast = parse(existing, file); } catch { return { ok: false, reason: "The wizard could not read this file.", snippet: SNIPPET }; }
  const body = ast.program.body as any[];
  const done = (insertedBlankAfter?: boolean): Edit & { matcherWarning?: string } => {
    ensureNamedImport(ast.program, NAME, SOURCE);
    let code = print(ast, existing);
    if (insertedBlankAfter !== undefined) code = placeNewDefaultLine(code, file, insertedBlankAfter);
    return { ok: true, code, changed: true, ...(hasMatcher(ast) ? { matcherWarning: MATCHER_WARNING } : {}) };
  };

  const def = body.findIndex((s) => n.ExportDefaultDeclaration.check(s));
  if (def >= 0) {
    const decl: any = body[def].declaration;
    if (isWrapped(decl)) return { ok: true, code: existing, changed: false };
    const isFnOrClass: boolean = n.FunctionDeclaration.check(decl) || n.ClassDeclaration.check(decl);
    if (isFnOrClass) {
      const name: string = decl.id?.name ?? "middleware";
      if (!decl.id) decl.id = b.identifier(name);
      const blankAfter = hadBlankLineAfter(body[def], body[def + 1]);
      moveComments(body[def], decl);
      body.splice(def, 1, decl, b.exportDefaultDeclaration(wrap(b.identifier(name))));
      return done(blankAfter);
    }
    body[def].declaration = wrap(decl);
    return done();
  }

  for (let i = 0; i < body.length; i++) {
    const s = body[i];
    if (!n.ExportNamedDeclaration.check(s)) continue;
    const d: any = (s as any).declaration;
    const isFnDecl: boolean = n.FunctionDeclaration.check(d);
    const fnName: string | null = isFnDecl && MIDDLEWARE_NAMES.has(d.id?.name) ? d.id.name : null;
    const isVarDecl: boolean = n.VariableDeclaration.check(d) && d.declarations.length === 1;
    const varName: string | null = isVarDecl && MIDDLEWARE_NAMES.has(d.declarations[0].id?.name) ? d.declarations[0].id.name : null;
    const name = fnName ?? varName;
    if (name) {
      const blankAfter = hadBlankLineAfter(s, body[i + 1]);
      moveComments(s, d);
      body.splice(i, 1, d);
      body.splice(i + 1, 0, b.exportDefaultDeclaration(wrap(b.identifier(name))));
      return done(blankAfter);
    }
    const spec = ((s as any).specifiers ?? []).find((sp: any) => sp.exported?.name === "default");
    if (spec && !(s as any).source) {
      const blankAfter = hadBlankLineAfter(s, body[i + 1]);
      (s as any).specifiers = (s as any).specifiers.filter((sp: any) => sp !== spec);
      const newDefault = b.exportDefaultDeclaration(wrap(b.identifier(spec.local.name)));
      if ((s as any).specifiers.length === 0) {
        moveComments(s, newDefault);
        body.splice(i, 1, newDefault);
      } else {
        body.splice(i + 1, 0, newDefault);
      }
      return done(blankAfter);
    }
  }
  return { ok: false, reason: "No middleware export found (a default export, or an exported function named middleware or proxy).", snippet: SNIPPET };
}

export function removeServer(code: string, file: string): Edit & { deleteFile?: boolean } {
  if (code === MIDDLEWARE_TEMPLATE) return { ok: true, code: "", changed: true, deleteFile: true };
  let ast: any;
  try { ast = parse(code, file); } catch { return { ok: false, reason: "The wizard could not read this file.", snippet: "Remove withParlox(…) and its import by hand." }; }
  const def: any = (ast.program.body as any[]).find((s) => n.ExportDefaultDeclaration.check(s));
  if (!def || !isWrapped(def.declaration)) return { ok: true, code, changed: false };
  const inner = def.declaration.arguments[0];
  if (!inner) return { ok: false, reason: "This file was created for Parlox and then edited; remove it or its withParlox() line by hand.", snippet: "" };
  def.declaration = inner;
  removeNamedImport(ast.program, NAME, SOURCE);
  return { ok: true, code: print(ast, code), changed: true };
}
