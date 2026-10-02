import { test } from "node:test";
import assert from "node:assert/strict";
import { diffLines } from "diff";
import { addServer, removeServer, MIDDLEWARE_TEMPLATE } from "../dist/edits/server.js";
import { parse } from "../dist/edits/parse.js";
import { linesPreserved } from "./helpers.mjs";

const WITHPARLOX_IMPORT = 'import { withParlox } from "@parlox/server/next";';

/**
 * Diffs `updated` against `originalWithImport` (the source with Parlox's import already prepended, so
 * the diff isolates the declaration/config region from the separately-tested import insertion) and
 * asserts the shape a merchant should see: exactly one changed line (the declaration, now without
 * "export") and one added line, with at most one added blank line around it — never a reformatted
 * function body or a relocated config block.
 */
function assertMinimalDiff(originalWithImport, updated, changedLine) {
  const changes = diffLines(originalWithImport, updated);
  const removed = changes.filter((c) => c.removed);
  const added = changes.filter((c) => c.added);
  assert.deepEqual(removed.map((c) => c.value), [`${changedLine}\n`]);
  assert.equal(added.length, 2);
  assert.deepEqual(added[0].value.split("\n").slice(0, -1), ["function middleware(req) {"]);
  assert.deepEqual(added[1].value.split("\n").slice(0, -1), ["export default withParlox(middleware);", ""]);
}

// The line addServer rewraps (the "export default function middleware..." signature, here) is expected
// to change — that is the edit. Every OTHER line (the body, blank lines, an unrelated matcher config)
// must come through unchanged: recast must not fall back to reprinting the whole touched function with
// its own defaults (4-space indent, LF), which would turn a tab-indented or CRLF file into a whole-file
// diff even though only Parlox's lines changed.
const CHANGED_LINE = 'export default function middleware(req: NextRequest) {';

test("no file: the template, which reaches pages and the ownership path but not assets or API routes", () => {
  const r = addServer(null, "proxy.ts");
  assert.equal(r.ok, true);
  assert.equal(r.code, MIDDLEWARE_TEMPLATE);
  assert.match(r.code, /export default withParlox\(\);/);
  assert.equal(r.matcherWarning, undefined);
});

test("export default function: kept, wrapped; an existing matcher is untouched and flagged", () => {
  const src = `import { NextResponse, type NextRequest } from "next/server";\n\nexport default function middleware(req: NextRequest) {\n  return NextResponse.next();\n}\n\nexport const config = { matcher: ["/shop/:path*"] };\n`;
  const r = addServer(src, "middleware.ts");
  assert.equal(r.ok, true);
  assert.match(r.code, /import \{ withParlox \} from "@parlox\/server\/next";/);
  assert.match(r.code, /^function middleware\(req: NextRequest\)/m);
  assert.match(r.code, /export default withParlox\(middleware\);/);
  assert.match(r.code, /matcher: \["\/shop\/:path\*"\]/);
  assert.match(r.matcherWarning, /well-known\/parlox-verify/);
});

test("named export middleware (Next 13-15) and proxy (Next 16)", () => {
  for (const name of ["middleware", "proxy"]) {
    const r = addServer(`export function ${name}(req) { return undefined; }\n`, `${name}.js`);
    assert.equal(r.ok, true, name);
    assert.match(r.code, new RegExp(`^function ${name}\\(req\\)`, "m"));
    assert.match(r.code, new RegExp(`export default withParlox\\(${name}\\);`));
  }
  const arrow = addServer(`export const middleware = (req) => undefined;\n`, "middleware.js");
  assert.match(arrow.code, /^const middleware = \(req\) => undefined;/m);
  assert.match(arrow.code, /export default withParlox\(middleware\);/);
});

test("export default <expression> is wrapped in place", () => {
  const r = addServer(`import { auth } from "./auth";\nexport default auth((req) => undefined);\n`, "middleware.ts");
  assert.match(r.code, /export default withParlox\(auth\(\(req\) => undefined\)\);/);
});

test("export { x as default } becomes a wrapped default export", () => {
  const r = addServer(`function mw(req) { return undefined; }\nexport { mw as default };\n`, "middleware.js");
  assert.match(r.code, /export default withParlox\(mw\);/);
  assert.doesNotMatch(r.code, /as default/);
});

test("already wrapped: unchanged", () => {
  const once = addServer(`export function middleware(req) { return undefined; }\n`, "middleware.js");
  assert.equal(addServer(once.code, "middleware.js").changed, false);
  assert.equal(addServer(MIDDLEWARE_TEMPLATE, "proxy.ts").changed, false);
});

test("Next's own boilerplate (named export): the added line sits between the function and config, not after it", () => {
  const src = 'export function middleware(req) {\n  return undefined;\n}\n\nexport const config = { matcher: ["/shop/:path*"] };\n';
  const r = addServer(src, "middleware.js");
  assert.equal(r.ok, true);
  assert.equal(
    r.code,
    'import { withParlox } from "@parlox/server/next";\n\nfunction middleware(req) {\n  return undefined;\n}\n\nexport default withParlox(middleware);\n\nexport const config = { matcher: ["/shop/:path*"] };\n',
  );
  assertMinimalDiff(`${WITHPARLOX_IMPORT}\n\n${src}`, r.code, "export function middleware(req) {");
});

test("Next's own boilerplate (export default function): the added line sits between the function and config, not after it", () => {
  const src = 'export default function middleware(req) {\n  return undefined;\n}\n\nexport const config = { matcher: ["/shop/:path*"] };\n';
  const r = addServer(src, "middleware.js");
  assert.equal(r.ok, true);
  assert.equal(
    r.code,
    'import { withParlox } from "@parlox/server/next";\n\nfunction middleware(req) {\n  return undefined;\n}\n\nexport default withParlox(middleware);\n\nexport const config = { matcher: ["/shop/:path*"] };\n',
  );
  assertMinimalDiff(`${WITHPARLOX_IMPORT}\n\n${src}`, r.code, "export default function middleware(req) {");
});

test("removeServer on both boilerplates: no Parlox references remain, and the file still parses", () => {
  for (const src of [
    'export function middleware(req) {\n  return undefined;\n}\n\nexport const config = { matcher: ["/shop/:path*"] };\n',
    'export default function middleware(req) {\n  return undefined;\n}\n\nexport const config = { matcher: ["/shop/:path*"] };\n',
  ]) {
    const added = addServer(src, "middleware.js").code;
    const back = removeServer(added, "middleware.js");
    assert.equal(back.ok, true);
    assert.doesNotMatch(back.code, /withParlox|@parlox/);
    assert.doesNotThrow(() => parse(back.code, "middleware.js"));
  }
});

// placeNewDefaultLine locates the statement it just inserted by re-parsing the printed output and
// finding its ExportDefaultDeclaration node (there is exactly one, by construction) — never by
// searching the printed text for the literal statement text, which text belonging to the merchant's
// own code could also match, corrupting it. These fixtures contain that exact text elsewhere in the
// file (inside a template literal and inside a comment) to prove it is left untouched, byte for byte.
const MARKER_TEXT = "export default withParlox(middleware);";

test("a template literal containing the inserted line's exact text is left untouched, byte for byte", () => {
  // The fake occurrence sits BEFORE the function in the file, so a first-match text search (rather
  // than a structural one) would find it instead of the real inserted line and corrupt it.
  const src = [
    "const USAGE = `",
    "Usage:",
    MARKER_TEXT,
    "`;",
    "",
    "export function middleware(req) {",
    "  return undefined;",
    "}",
    "",
    'export const config = { matcher: ["/shop/:path*"] };',
    "",
  ].join("\n");
  const r = addServer(src, "middleware.js");
  assert.equal(r.ok, true);
  // The template literal's own source text, including the line that matches the marker exactly, is
  // unchanged — no blank line was spliced into it.
  assert.match(r.code, /const USAGE = `\nUsage:\nexport default withParlox\(middleware\);\n`;/);
  // The real inserted line still gets its own correct blank-line placement, right after the function.
  assert.match(r.code, /^}\n\nexport default withParlox\(middleware\);\n\nexport const config/m);
  // The template literal's runtime value is exactly what it was in the source (parsed back out).
  const ast = parse(r.code, "middleware.js");
  const usageDecl = ast.program.body.find((s) => s.declarations?.[0]?.id?.name === "USAGE");
  assert.equal(usageDecl.declarations[0].init.quasis[0].value.cooked, `\nUsage:\n${MARKER_TEXT}\n`);
});

test("a comment containing the inserted line's exact text is left untouched, byte for byte", () => {
  // A block comment whose own interior line, unprefixed, is exactly the target text — so it sits before
  // the function and is a byte-for-byte match for a naive text search, not just a substring of one.
  const src = [
    "/*",
    MARKER_TEXT,
    "*/",
    "const NOTE = 1;",
    "",
    "export function middleware(req) {",
    "  return undefined;",
    "}",
    "",
    'export const config = { matcher: ["/shop/:path*"] };',
    "",
  ].join("\n");
  const r = addServer(src, "middleware.js");
  assert.equal(r.ok, true);
  assert.ok(r.code.includes(`/*\n${MARKER_TEXT}\n*/`), "the comment's exact text was not preserved");
  assert.match(r.code, /^}\n\nexport default withParlox\(middleware\);\n\nexport const config/m);
});

// Babel (and so recast) attaches a comment written above, below or beside an `export ...` statement to
// that outer export node, never to the declaration it wraps — confirmed by inspecting the parsed AST
// directly. Splicing the export statement out and keeping only its inner declaration must carry the
// comment across, or it silently disappears from the merchant's file.
test("a JSDoc block comment above `export function middleware` survives addServer and addServer→removeServer", () => {
  const jsdoc = "/**\n * Handles requests.\n */";
  const src = `${jsdoc}\nexport function middleware(req) {\n  return undefined;\n}\n\nexport const config = { matcher: ["/shop/:path*"] };\n`;
  const r = addServer(src, "middleware.js");
  assert.equal(r.ok, true);
  assert.ok(r.code.includes(jsdoc), "JSDoc comment missing after addServer");
  const back = removeServer(r.code, "middleware.js");
  assert.equal(back.ok, true);
  assert.ok(back.code.includes(jsdoc), "JSDoc comment missing after removeServer");
});

test("a line comment above `export default function middleware` survives addServer and addServer→removeServer", () => {
  const comment = "// Handles requests.";
  const src = `${comment}\nexport default function middleware(req) {\n  return undefined;\n}\n\nexport const config = { matcher: ["/shop/:path*"] };\n`;
  const r = addServer(src, "middleware.js");
  assert.equal(r.ok, true);
  assert.ok(r.code.includes(comment), "leading comment missing after addServer");
  const back = removeServer(r.code, "middleware.js");
  assert.equal(back.ok, true);
  assert.ok(back.code.includes(comment), "leading comment missing after removeServer");
});

test("a trailing comment after the export survives addServer and addServer→removeServer", () => {
  const comment = "// trailing note";
  const src = `export function middleware(req) { return undefined; } ${comment}\n\nexport const config = { matcher: ["/shop/:path*"] };\n`;
  const r = addServer(src, "middleware.js");
  assert.equal(r.ok, true);
  assert.ok(r.code.includes(comment), "trailing comment missing after addServer");
  const back = removeServer(r.code, "middleware.js");
  assert.equal(back.ok, true);
  assert.ok(back.code.includes(comment), "trailing comment missing after removeServer");
});

test("a file with no recognisable middleware export falls back to a snippet", () => {
  const r = addServer(`export const config = { matcher: [] };\n`, "middleware.ts");
  assert.equal(r.ok, false);
  assert.match(r.snippet, /withParlox/);
});

test("tab-indented file: lines other than the rewrapped export are preserved exactly", () => {
  const src = [
    'import { NextResponse, type NextRequest } from "next/server";',
    "",
    CHANGED_LINE,
    "\treturn NextResponse.next();",
    "}",
    "",
    'export const config = { matcher: ["/shop/:path*"] };',
    "",
  ].join("\n");
  const r = addServer(src, "middleware.ts");
  assert.equal(r.ok, true);
  const untouched = src.split("\n").filter((l) => l !== CHANGED_LINE).join("\n");
  assert.equal(linesPreserved(untouched, r.code), true);
  assert.match(r.code, /\n\treturn NextResponse\.next\(\);\n/);
  // The blank line that used to separate the combined declaration from `config` is relocated after the
  // new `export default withParlox(...)` line rather than dropped (addServer places it there by hand;
  // recast gives a brand-new statement no blank-line context of its own).
  assert.match(r.code, /export default withParlox\(middleware\);\n\nexport const config = \{ matcher: \["\/shop\/:path\*"\] \};\n/);
  const back = removeServer(r.code, "middleware.ts");
  assert.equal(back.ok, true);
  assert.doesNotMatch(back.code, /withParlox|@parlox/);
  assert.match(back.code, /\n\treturn NextResponse\.next\(\);\n/);
});

test("CRLF file: lines other than the rewrapped export are preserved exactly", () => {
  const lf = `import { NextResponse, type NextRequest } from "next/server";\n\n${CHANGED_LINE}\n  return NextResponse.next();\n}\n\nexport const config = { matcher: ["/shop/:path*"] };\n`;
  const src = lf.replace(/\n/g, "\r\n");
  const r = addServer(src, "middleware.ts");
  assert.equal(r.ok, true);
  const untouched = src.split("\r\n").filter((l) => l !== CHANGED_LINE).join("\r\n");
  assert.equal(linesPreserved(untouched, r.code), true);
  assert.match(r.code, /\r\n  return NextResponse\.next\(\);\r\n/);
  // See the tab-indented test above: the blank line before `config` is relocated after the new line,
  // with its original \r\n terminator, not dropped.
  assert.match(r.code, /export default withParlox\(middleware\);\r\n\r\nexport const config = \{ matcher: \["\/shop\/:path\*"\] \};\r\n/);
  const back = removeServer(r.code, "middleware.ts");
  assert.equal(back.ok, true);
  assert.doesNotMatch(back.code, /withParlox|@parlox/);
  assert.match(back.code, /\r\n  return NextResponse\.next\(\);\r\n/);
});

test("remove: the created template is deleted; a wrapped middleware is unwrapped", () => {
  const del = removeServer(MIDDLEWARE_TEMPLATE, "proxy.ts");
  assert.equal(del.ok, true);
  assert.equal(del.deleteFile, true);
  const wrapped = addServer(`export function middleware(req) { return undefined; }\n`, "middleware.js").code;
  const back = removeServer(wrapped, "middleware.js");
  assert.equal(back.ok, true);
  assert.doesNotMatch(back.code, /withParlox|@parlox/);
  assert.match(back.code, /export default middleware;/);
  assert.equal(removeServer(`export function middleware() {}\n`, "middleware.js").changed, false);
});
