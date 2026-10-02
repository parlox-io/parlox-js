import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { addVercelEdge, edgeRefusal, existingMiddleware, planVercelEdge, removeVercelEdge, unplanVercelEdge, vercelMiddlewareTemplate, VERCEL_MATCHER } from "../dist/edits/vercel-edge.js";
import { parseCode } from "../dist/edits/splice.js";
import { SERVER_VERSION, VERCEL_FUNCTIONS_VERSION } from "../dist/versions.js";
import { applyPlan, emptyPlan } from "../dist/plan-core.js";
import { fixture, read } from "./helpers.mjs";

const readerOf = (files) => (rel) => (rel in files ? files[rel] : null);
const MODULE_PKG = JSON.stringify({ type: "module" });

test("the new middleware is the wizard's template, byte for byte, with Vercel's own /_vercel/ paths left out", () => {
  assert.equal(vercelMiddlewareTemplate(), `import { next } from "@vercel/functions";
import { withParlox } from "@parlox/server/vercel";

export default withParlox({ next });
export const config = { matcher: ["/((?!assets/|_vercel/|favicon\\\\.ico|.*\\\\.(?:png|jpe?g|gif|svg|webp|avif|ico|css|js|map|woff2?)$).*)"] };
`);
});

test("the template's matcher line is the one in @parlox/server's README, character for character", () => {
  const readme = readFileSync(new URL("../../server/README.md", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const line = vercelMiddlewareTemplate().split("\n").find((l) => l.startsWith("export const config"));
  assert.ok(readme.includes(`${line}\n`), "packages/server/README.md shows the same matcher");
});

test("the matcher keeps the middleware off Vite's assets, static files and /_vercel/, and on pages and the ownership check", () => {
  const ast = parseCode(vercelMiddlewareTemplate(), "middleware.ts");
  let value = null;
  const visit = (n) => { if (!n || typeof n !== "object") return; if (n.type === "StringLiteral" && n.value.startsWith("/((?!")) value = n.value; for (const k of Object.keys(n)) if (k !== "loc") { const v = n[k]; if (Array.isArray(v)) v.forEach(visit); else if (v && typeof v.type === "string") visit(v); } };
  visit(ast.program);
  assert.equal(value, VERCEL_MATCHER);
  const re = new RegExp(`^${VERCEL_MATCHER}$`);
  for (const p of ["/", "/products/tent", "/.well-known/parlox-verify", "/robots.txt", "/llms.txt", "/sitemap.xml"]) assert.ok(re.test(p), `runs for ${p}`);
  for (const p of ["/assets/index-4f2a.js", "/assets/logo-9c.svg", "/favicon.ico", "/logo.png", "/app.css", "/fonts/a.woff2", "/_vercel/insights/script.js", "/_vercel/speed-insights/vitals"]) assert.equal(re.test(p), false, `not for ${p}`);
});

test("no middleware yet: middleware.ts (or .js without TypeScript) is created; @parlox/server and @vercel/functions are added", () => {
  const ts = planVercelEdge(readerOf({ "package.json": "{}" }), true, SERVER_VERSION);
  assert.deepEqual(ts.changes.map((c) => [c.path, c.before, c.after]), [["middleware.ts", null, vercelMiddlewareTemplate()]]);
  assert.deepEqual(ts.packages, [`@parlox/server@${SERVER_VERSION}`, `@vercel/functions@${VERCEL_FUNCTIONS_VERSION}`]);
  assert.deepEqual([ts.manual, ts.warnings], [[], []]);
  assert.equal(planVercelEdge(readerOf({ "package.json": MODULE_PKG }), false, SERVER_VERSION).changes[0].path, "middleware.js");
  const has = planVercelEdge(readerOf({ "package.json": JSON.stringify({ dependencies: { "@vercel/functions": "^3.0.0" } }) }), true, SERVER_VERSION);
  assert.deepEqual(has.packages, [`@parlox/server@${SERVER_VERSION}`], "the project's own @vercel/functions is left as it is");
  const pinned = planVercelEdge(readerOf({ "package.json": JSON.stringify({ dependencies: { "@parlox/server": SERVER_VERSION, "@vercel/functions": "3.9.9" } }) }), true, SERVER_VERSION);
  assert.deepEqual(pinned.packages, []);
});

test("a JavaScript middleware is created only in an ES module package (Vercel: add \"type\": \"module\" or use .mjs); otherwise a snippet", () => {
  const plan = planVercelEdge(readerOf({ "package.json": "{}" }), false, SERVER_VERSION);
  assert.deepEqual(plan.changes, []);
  assert.equal(plan.manual.length, 1);
  assert.deepEqual([plan.manual[0].file, plan.manual[0].part, plan.manual[0].snippet], ["middleware.js", "server", vercelMiddlewareTemplate()]);
  assert.match(plan.manual[0].reason, /"type": "module"/);
});

test("an existing middleware: its default export is wrapped, never replaced; uninstall gives back the exact bytes", () => {
  const cases = [
    ["middleware.ts", `import { geolocation } from "@vercel/functions";\n\nexport default function middleware(request: Request) {\n  return geolocation(request).country === "XX" ? new Response("no", { status: 403 }) : undefined;\n}\n`],
    ["middleware.js", "import { next } from '@vercel/functions'\nimport { auth } from './auth'\n\nexport default auth\n"],
    ["middleware.ts", "const handler = (req: Request) => new Response(null);\r\nexport default handler;\r\n"],
  ];
  for (const [file, code] of cases) {
    const e = addVercelEdge(code, file);
    assert.equal(e.ok, true, `${file}: ${e.reason}`);
    assert.match(e.code, /export default withParlox\(/);
    assert.match(e.code, /from ["']@parlox\/server\/vercel["']/);
    assert.equal((e.code.match(/import \{ next \}/g) ?? []).length, 1, "next is imported once, reused when already there");
    assert.ok(parseCode(e.code, file), "the result parses");
    assert.equal(addVercelEdge(e.code, file).changed, false, "a second run changes nothing");
    const r = removeVercelEdge(e.code, file);
    assert.equal(r.code, code, `${file}: back to the original bytes`);
  }
  const single = addVercelEdge("import { next } from '@vercel/functions'\nimport { auth } from './auth'\n\nexport default auth\n", "middleware.js").code;
  assert.match(single, /import \{ withParlox \} from '@parlox\/server\/vercel'\n/, "the file's quotes, no semicolons");
});

test("the wrap is exactly two splices around the default export and two import lines below the last import", () => {
  const code = "import { auth } from \"./auth\";\n\nexport default auth;\n";
  assert.equal(addVercelEdge(code, "middleware.ts").code, "import { auth } from \"./auth\";\nimport { withParlox } from \"@parlox/server/vercel\";\nimport { next } from \"@vercel/functions\";\n\nexport default withParlox(auth, { next });\n");
  const bare = "export default (req: Request) => new Response(null);";
  assert.equal(addVercelEdge(bare, "middleware.ts").code, "import { withParlox } from \"@parlox/server/vercel\";\nimport { next } from \"@vercel/functions\";\nexport default withParlox((req: Request) => new Response(null), { next });");
});

test("round trips are byte-exact across line breaks, indentation, a missing final line break and a byte-order mark", () => {
  const bodies = [
    ["import { auth } from './auth'", "", "export default function middleware(req) {", "\treturn auth(req)", "}"],
    ["// @ts-check", "export default async (req) => {", "    return undefined;", "};"],
    ["\"use strict\";", "export default (auth);"],
    ["import { rewrite } from \"@vercel/functions\";", "export default function (req) {", "  return rewrite(new URL(\"/x\", req.url));", "}", "export const config = { runtime: \"nodejs\" };"],
    ["export default (req) => undefined;"],
  ];
  for (const eol of ["\n", "\r\n"]) for (const lines of bodies) for (const final of [true, false]) for (const bom of ["", "\uFEFF"]) {
    const code = bom + lines.join(eol) + (final ? eol : "");
    const e = addVercelEdge(code, "middleware.js");
    assert.equal(e.ok, true, `${JSON.stringify(code)}: ${e.reason}`);
    assert.equal(e.code.startsWith(bom), true, "the byte-order mark stays first");
    if (code.includes("\n")) assert.equal(e.code.split("\r\n").join("").includes(eol === "\r\n" ? "\n" : "\r"), false, `only the file's own line breaks in ${JSON.stringify(e.code)}`);
    assert.equal(removeVercelEdge(e.code, "middleware.js").code, code, JSON.stringify(code));
  }
});

test("the project's own next import is never taken out on uninstall, even when it is the last import and unused", () => {
  const code = "import { auth } from './auth'\nimport { next } from '@vercel/functions'\n\nexport default auth\n";
  const e = addVercelEdge(code, "middleware.js");
  assert.equal(e.code, "import { auth } from './auth'\nimport { next } from '@vercel/functions'\nimport { withParlox } from '@parlox/server/vercel'\n\nexport default withParlox(auth, { next })\n");
  assert.equal(removeVercelEdge(e.code, "middleware.js").code, code);
});

test("a next import the wizard added stays on uninstall once the developer's own code uses it", () => {
  const e = addVercelEdge("export default (r) => r;\n", "middleware.js");
  const used = `${e.code}export const later = () => next();\n`;
  const r = removeVercelEdge(used, "middleware.js");
  assert.equal(r.ok, true);
  assert.equal(r.code, "import { next } from \"@vercel/functions\";\nexport default (r) => r;\nexport const later = () => next();\n");
  assert.match(r.warning, /import of next from @vercel\/functions on line 2 stays: next is used on line 4/);
  const u = unplanVercelEdge(readerOf({ "middleware.js": used }));
  assert.deepEqual([u.changes.length, u.manual.length, u.manual[0]?.file, u.manual[0]?.part], [1, 1, "middleware.js", "server"]);
});

test("a function's own name inside its body does not stop the wrap", () => {
  const code = "export default function mw(req, n = 0) {\n  return n > 1 ? undefined : mw(req, n + 1);\n}\n";
  const e = addVercelEdge(code, "middleware.js");
  assert.equal(e.ok, true, e.reason);
  assert.equal(removeVercelEdge(e.code, "middleware.js").code, code);
});

test("vercel.json proxy.entrypoint names the file to wrap; a file there that does not exist yet is created", () => {
  const files = { "package.json": "{}", "vercel.json": JSON.stringify({ proxy: { entrypoint: "./src/edge.ts" } }), "src/edge.ts": "export default (req: Request) => new Response(null);\n" };
  assert.equal(existingMiddleware(readerOf(files)), "src/edge.ts");
  const p = planVercelEdge(readerOf(files), true, SERVER_VERSION);
  assert.equal(p.changes[0].path, "src/edge.ts");
  assert.match(p.changes[0].after, /export default withParlox\(\(req: Request\) => new Response\(null\), \{ next \}\);/);
  const { "src/edge.ts": _edge, ...withoutFile } = files;
  const missing = planVercelEdge(readerOf(withoutFile), true, SERVER_VERSION);
  assert.deepEqual([missing.changes[0].path, missing.changes[0].before, missing.changes[0].after], ["src/edge.ts", null, vercelMiddlewareTemplate()]);
  assert.deepEqual(unplanVercelEdge(readerOf({ ...withoutFile, "src/edge.ts": vercelMiddlewareTemplate() })).changes.map((c) => [c.path, c.after]), [["src/edge.ts", null]]);
  assert.equal(existingMiddleware(readerOf({ "middleware.js": "x" })), "middleware.js");
  assert.equal(existingMiddleware(readerOf({ "package.json": "{}" })), null);
});

test("a vercel.json that does not parse, or a proxy.entrypoint Vercel would not accept or outside the folder, is a snippet, never a guess", () => {
  const bad = [
    ["{ proxy: ", /not valid JSON/],
    [JSON.stringify({ proxy: { entrypoint: "../edge.ts" } }), /inside this folder/],
    [JSON.stringify({ proxy: { entrypoint: "/abs/edge.ts" } }), /inside this folder/],
    [JSON.stringify({ proxy: { entrypoint: "edge.mjs" } }), /\.js or \.ts/],
    [JSON.stringify({ proxy: { entrypoint: 42 } }), /entrypoint/],
    [JSON.stringify({ proxy: "edge.ts" }), /proxy/],
  ];
  for (const [json, reason] of bad) {
    const plan = planVercelEdge(readerOf({ "package.json": "{}", "vercel.json": json, "middleware.ts": "export default (r) => r;\n" }), true, SERVER_VERSION);
    assert.deepEqual(plan.changes, [], json);
    assert.equal(plan.manual.length, 1, json);
    assert.equal(plan.manual[0].file, "vercel.json");
    assert.match(plan.manual[0].reason, reason, json);
    assert.deepEqual(unplanVercelEdge(readerOf({ "vercel.json": json, "middleware.ts": "x" })).changes, [], json);
  }
});

test("vercel.json's proxy.matcher: kept, with a warning to check it; a file still to be created there becomes a snippet (Vercel takes one matcher or the other)", () => {
  const vercel = JSON.stringify({ proxy: { entrypoint: "proxy.ts", matcher: ["/shop/:path*"] } });
  const wrapped = planVercelEdge(readerOf({ "package.json": "{}", "vercel.json": vercel, "proxy.ts": "export default (r: Request) => undefined;\n" }), true, SERVER_VERSION);
  assert.equal(wrapped.changes.length, 1);
  assert.equal(wrapped.warnings.length, 1);
  assert.match(wrapped.warnings[0], /^vercel\.json: .*proxy\.matcher/);
  const create = planVercelEdge(readerOf({ "package.json": "{}", "vercel.json": vercel }), true, SERVER_VERSION);
  assert.deepEqual(create.changes, []);
  assert.match(create.manual[0].reason, /proxy\.matcher/);
});

test("both middleware.ts and middleware.js: the wizard cannot tell which one Vercel runs, so it edits neither", () => {
  const plan = planVercelEdge(readerOf({ "package.json": "{}", "middleware.ts": "export default (r: Request) => undefined;\n", "middleware.js": "export default (r) => undefined;\n" }), true, SERVER_VERSION);
  assert.deepEqual(plan.changes, []);
  assert.equal(plan.manual.length, 1);
  assert.match(plan.manual[0].reason, /Both middleware\.ts and middleware\.js/);
});

test("what cannot be wrapped safely becomes a snippet: unreadable, no default export, a class, a name taken, a used function name", () => {
  const bad = [
    "export default function (",
    "export const config = {};\n",
    "export default class Mw {}\n",
    "const next = 1;\nexport default (r) => r;\n",
    "export default function middleware(r) { return r; }\nexport const again = middleware;\n",
  ];
  for (const code of bad) {
    const e = addVercelEdge(code, "middleware.js");
    assert.equal(e.ok, false, code);
    assert.match(e.snippet, /withParlox\(yourMiddleware, \{ next \}\)/);
  }
  const plan = planVercelEdge(readerOf({ "package.json": "{}", "middleware.js": bad[2] }), false, SERVER_VERSION);
  assert.deepEqual(plan.changes, []);
  assert.equal(plan.manual[0].part, "server");
});

test("more that is refused rather than guessed at: an export list, a type-only or renamed next, another withParlox, a line that would join the wrap, an import that would land in a string", () => {
  const bad = [
    ["const mw = (r) => r;\nexport { mw as default };\n", /export list/],
    ["import type { next } from '@vercel/functions';\nexport default (r) => r;\n", /named next/],
    ["import { next } from '@vercel/edge';\nexport default (r) => r;\n", /named next/],
    ["import { withParlox } from './mine';\nexport default (r) => r;\n", /withParlox/],
    ["export default function mw(r) { return r }\n(globalThis).ready = true;\n", /join onto the wrap/],
    ["import a from './a'; const page = `\n<p>\n`;\nexport default (r) => r;\n", /inside a comment or a statement/],
    ["export default auth satisfies Middleware;\n", /not a function the wizard can wrap/],
  ];
  for (const [code, reason] of bad) {
    const file = code.includes("satisfies") || code.includes("import type") ? "middleware.ts" : "middleware.js";
    const e = addVercelEdge(code, file);
    assert.equal(e.ok, false, code);
    assert.match(e.reason, reason, code);
    assert.match(e.snippet, /withParlox\(yourMiddleware, \{ next \}\)/);
  }
});

test("already installed is left alone; a file that uses @parlox/server some other way is a snippet, so visits are not reported twice", () => {
  assert.deepEqual(addVercelEdge(vercelMiddlewareTemplate(), "middleware.ts"), { ok: true, code: vercelMiddlewareTemplate(), changed: false });
  const half = "import { withParlox } from \"@parlox/server/vercel\";\nexport default (r) => r;\n";
  const e = addVercelEdge(half, "middleware.js");
  assert.equal(e.ok, false);
  assert.match(e.reason, /already uses @parlox\/server/);
  for (const other of ["import { parloxFetch } from \"@parlox/server/fetch\";\nexport default (r) => r;\n", "import { withParlox as wp } from \"@parlox/server/vercel\";\nexport default wp((r) => r, { next: () => new Response() });\n"]) {
    const o = addVercelEdge(other, "middleware.js");
    assert.equal(o.ok, false, other);
    assert.match(o.reason, /reported twice/, other);
  }
  const files = { "package.json": "{}", "middleware.ts": vercelMiddlewareTemplate() };
  const again = planVercelEdge(readerOf(files), true, SERVER_VERSION);
  assert.deepEqual([again.changes, again.manual], [[], []], "planned again after install: nothing left to change");
});

test("an existing matcher is kept, with a warning to check it", () => {
  const code = "export default (r) => r;\nexport const config = { matcher: ['/shop/:path*'] };\n";
  const e = addVercelEdge(code, "middleware.js");
  assert.match(e.warning, /own matcher/);
  assert.match(e.code, /matcher: \['\/shop\/:path\*'\]/);
  assert.equal(addVercelEdge("export default (r) => r;\nexport const config = { runtime: 'nodejs' };\n", "middleware.js").warning, undefined, "a config without a matcher runs everywhere: nothing to check");
});

test("Next.js and Astro projects, and projects that deploy Storybook, are refused (Vercel does not run a root middleware file there)", () => {
  const none = readerOf({});
  assert.match(edgeRefusal({ dependencies: { next: "16.0.0" } }, none), /Next\.js/);
  assert.match(edgeRefusal({ dependencies: { astro: "5.0.0" } }, none), /Astro/);
  assert.equal(edgeRefusal({ dependencies: { react: "19.0.0", vite: "8.0.0" } }, none), null);
  for (const build of ["storybook build", "storybook build -o dist", "npx storybook@9 build", "tsc && storybook build", "build-storybook -c .storybook"]) {
    assert.match(edgeRefusal({ devDependencies: { storybook: "9.0.0" }, scripts: { build } }, none), /build script runs Storybook/, build);
  }
  assert.match(edgeRefusal({ dependencies: { react: "19.0.0", vite: "8.0.0" } }, readerOf({ "vercel.json": JSON.stringify({ framework: "storybook" }) })), /"framework": "storybook"/);
});

test("a storybook dependency alone is not refused: a Vite app that keeps Storybook as a tool deploys the app", () => {
  const pkg = { dependencies: { react: "19.0.0" }, devDependencies: { vite: "8.0.0", storybook: "9.0.0", "@storybook/react-vite": "9.0.0" }, scripts: { build: "vite build", "build-storybook": "storybook build", storybook: "storybook dev -p 6006" } };
  assert.equal(edgeRefusal(pkg, readerOf({ "vercel.json": JSON.stringify({ framework: "vite" }) })), null);
  assert.equal(edgeRefusal(pkg, readerOf({ "vercel.json": "{ not json" })), null, "an unreadable vercel.json is planVercelEdge's to report");
  assert.equal(edgeRefusal({ ...pkg, scripts: { build: "vite build && echo storybook-build-done" } }, readerOf({})), null);
});

test("uninstall: the created file is deleted, also after a CRLF checkout; an edited created file is left for the developer", () => {
  assert.deepEqual(unplanVercelEdge(readerOf({ "middleware.ts": vercelMiddlewareTemplate() })).changes.map((c) => [c.path, c.before, c.after]), [["middleware.ts", vercelMiddlewareTemplate(), null]]);
  const crlf = vercelMiddlewareTemplate().replace(/\n/g, "\r\n");
  assert.deepEqual(unplanVercelEdge(readerOf({ "middleware.ts": crlf })).changes.map((c) => [c.path, c.before, c.after]), [["middleware.ts", crlf, null]]);
  const edited = vercelMiddlewareTemplate().replace("export default withParlox({ next });", "export default withParlox({ next, includeApi: true });");
  const u = unplanVercelEdge(readerOf({ "middleware.ts": edited }));
  assert.deepEqual(u.changes, []);
  assert.equal(u.manual.length, 1);
  assert.equal(u.manual[0].part, "server");
});

test("uninstall of a wrap the developer changed, or of a withParlox used elsewhere, is left for the developer; a file without Parlox is untouched", () => {
  const e = addVercelEdge("import { auth } from './auth'\nexport default auth\n", "middleware.js");
  for (const changed of [e.code.replace(", { next })", ", { next, includeApi: true })"), `${e.code}export const other = withParlox(auth, { next })\n`]) {
    const r = removeVercelEdge(changed, "middleware.js");
    assert.equal(r.ok, false, changed);
    assert.match(r.snippet, /by hand/);
  }
  const plain = "export default (r) => r;\n";
  assert.deepEqual(removeVercelEdge(plain, "middleware.js"), { ok: true, code: plain, changed: false });
  assert.deepEqual(unplanVercelEdge(readerOf({ "middleware.js": plain })), { changes: [], manual: [] });
  assert.deepEqual(unplanVercelEdge(readerOf({ "package.json": "{}" })), { changes: [], manual: [] });
});

test("on disk: apply, then uninstall, leaves every file byte for byte as it was (a created file is gone, a wrapped CRLF file is back)", () => {
  const original = "import { auth } from './auth'\r\n\r\nexport default auth\r\n";
  for (const files of [{ "package.json": MODULE_PKG }, { "package.json": MODULE_PKG, "middleware.js": original }, { "package.json": "{}", "vercel.json": JSON.stringify({ proxy: { entrypoint: "src/edge.ts" } }) }]) {
    const dir = fixture(files);
    const reader = (rel) => read(dir, rel);
    const plan = planVercelEdge(reader, false, SERVER_VERSION);
    assert.equal(plan.changes.length, 1, JSON.stringify(Object.keys(files)));
    applyPlan(dir, { ...emptyPlan(), changes: plan.changes });
    assert.deepEqual(planVercelEdge(reader, false, SERVER_VERSION).changes, [], "planned again: nothing left");
    applyPlan(dir, { ...emptyPlan(), changes: unplanVercelEdge(reader).changes });
    for (const [rel, text] of Object.entries(files)) assert.equal(read(dir, rel), text, rel);
    for (const rel of ["middleware.js", "middleware.ts", "src/edge.ts"]) if (!(rel in files)) assert.equal(existsSync(join(dir, rel)), false, `${rel} is removed`);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("uninstall removes the next import only when it is the line the wizard writes, right below its withParlox line, and nothing uses next any more", () => {
  // The wizard's own two lines, reordered by an import sorter: both go.
  const sorted = "import { withParlox } from '@parlox/server/vercel'\nimport { next } from '@vercel/functions'\nimport { auth } from './auth'\n\nexport default withParlox(auth, { next })\n";
  const s = removeVercelEdge(sorted, "middleware.js");
  assert.deepEqual([s.ok, s.code, s.warning], [true, "import { auth } from './auth'\n\nexport default auth\n", undefined]);
  // The developer's own next import, used by their code, sorted directly under the wizard's line: it stays, and the report says so.
  const own = "import { next } from '@vercel/functions'\nimport { auth } from './auth'\n\nexport default (req) => auth(req) ?? next()\n";
  const wrapped = addVercelEdge(own, "middleware.js").code;
  assert.equal((wrapped.match(/import \{ next \}/g) ?? []).length, 1, "the project's next import is reused");
  const ownSorted = "import { withParlox } from '@parlox/server/vercel'\nimport { next } from '@vercel/functions'\nimport { auth } from './auth'\n\nexport default withParlox((req) => auth(req) ?? next(), { next })\n";
  const o = removeVercelEdge(ownSorted, "middleware.js");
  assert.equal(o.code, "import { next } from '@vercel/functions'\nimport { auth } from './auth'\n\nexport default (req) => auth(req) ?? next()\n");
  assert.match(o.warning, /line 2 stays: next is used on line 5/);
  // A next import right below that is not written the way the wizard writes it (other quotes, a semicolon) stays too.
  const other = "import { withParlox } from '@parlox/server/vercel'\nimport { next } from \"@vercel/functions\";\n\nexport default withParlox((r) => r, { next })\n";
  const t = removeVercelEdge(other, "middleware.js");
  assert.equal(t.code, "import { next } from \"@vercel/functions\";\n\nexport default (r) => r\n");
  assert.match(t.warning, /line 2 stays: it is not written the way the wizard writes it/);
});

test("uninstall names what it leaves: the wizard's next import with a line put between, and a created middleware.ts once vercel.json names another file", () => {
  const w = addVercelEdge("import { auth } from './auth'\n\nexport default auth\n", "middleware.js").code;
  const between = w.replace("import { next }", "import x from './x'\nimport { next }");
  const r = removeVercelEdge(between, "middleware.js");
  assert.equal(r.code, "import { auth } from './auth'\nimport x from './x'\nimport { next } from '@vercel/functions'\n\nexport default auth\n");
  assert.match(r.warning, /import of next from @vercel\/functions on line 4 stays: it is not right below the withParlox import/);
  const u = unplanVercelEdge(readerOf({ "middleware.js": between }));
  assert.deepEqual([u.changes.length, u.manual.length], [1, 1]);
  const later = unplanVercelEdge(readerOf({ "vercel.json": JSON.stringify({ proxy: { entrypoint: "p.ts" } }), "p.ts": "export default (r: Request) => undefined;\n", "middleware.ts": vercelMiddlewareTemplate() }));
  assert.deepEqual(later.changes, []);
  assert.equal(later.manual.length, 1);
  assert.equal(later.manual[0].file, "middleware.ts");
  assert.match(later.manual[0].reason, /proxy\.entrypoint names p\.ts/);
});

test("uninstall of Parlox the wizard did not write (a renamed or namespace import, another adapter) is a manual step naming the line, never silence", () => {
  for (const [code, line] of [
    ["import { withParlox as wp } from \"@parlox/server/vercel\";\nimport { next } from \"@vercel/functions\";\nexport default wp((r) => r, { next });\n", 1],
    ["import { next } from \"@vercel/functions\";\nimport * as p from \"@parlox/server/vercel\";\nexport default p.withParlox((r) => r, { next });\n", 2],
    ["import { parloxFetch } from \"@parlox/server/fetch\";\nexport default (r) => r;\n", 1],
  ]) {
    const r = removeVercelEdge(code, "middleware.ts");
    assert.equal(r.ok, false, code);
    assert.match(r.reason, new RegExp(`line ${line}\\b`, "i"), code);
    const u = unplanVercelEdge(readerOf({ "middleware.ts": code }));
    assert.deepEqual([u.changes, u.manual.map((m) => [m.file, m.part])], [[], [["middleware.ts", "server"]]], code);
  }
  // The wizard's wrap is taken out; another @parlox/server import left in the file is named.
  const w = addVercelEdge("export default (r) => r;\n", "middleware.js").code;
  const extra = `import { flush } from "@parlox/server";\n${w}`;
  const r = removeVercelEdge(extra, "middleware.js");
  assert.deepEqual([r.ok, r.code], [true, "import { flush } from \"@parlox/server\";\nexport default (r) => r;\n"]);
  assert.match(r.warning, /Line 1 still uses @parlox\/server/);
});

test("a local next or withParlox: the snippet's reason names the identifier and its line (the check does not follow scopes)", () => {
  const cases = [
    ["export default function middleware(req) {\n  const next = () => undefined;\n  return next();\n}\n", /name next on line 2/],
    ["export default function mw(r) {\n  const withParlox = 1;\n  return r;\n}\n", /name withParlox on line 2/],
    ["const next = 1;\nexport default (r) => r;\n", /named next \(line 1\)/],
    ["export default function mw(r: Request) { return undefined; }\ntype M = typeof mw;\n", /mw is also used on line 2/],
  ];
  for (const [code, reason] of cases) {
    const e = addVercelEdge(code, "middleware.ts");
    assert.equal(e.ok, false, code);
    assert.match(e.reason, reason, code);
  }
  const w = addVercelEdge("import { auth } from './auth'\nexport default auth\n", "middleware.js").code;
  assert.match(removeVercelEdge(`${w}export const b = withParlox\n`, "middleware.js").reason, /withParlox is also used on line 5/);
});

test("a file with a lone \\r or a Unicode line separator is a snippet on install and a manual step on uninstall", () => {
  for (const code of ["export default (r) => r\r", "import a from './a'\rexport default a\r", "export default (r) => r\u2028"]) {
    const e = addVercelEdge(code, "middleware.js");
    assert.equal(e.ok, false, JSON.stringify(code));
    assert.match(e.reason, /line break/, JSON.stringify(code));
  }
  const w = addVercelEdge("import { auth } from './auth'\nexport default auth\n", "middleware.js").code.replace(/\n/g, "\r");
  const r = removeVercelEdge(w, "middleware.js");
  assert.equal(r.ok, false);
  assert.match(r.reason, /line break/);
});

test("existingMiddleware agrees with planVercelEdge: no file when vercel.json cannot be read or two root files exist", () => {
  const mw = "export default (r) => r;\n";
  const problems = [
    { "vercel.json": "{ proxy: ", "middleware.ts": mw },
    { "vercel.json": JSON.stringify({ proxy: { entrypoint: "../x.ts" } }), "middleware.ts": mw },
    { "vercel.json": "[]", "middleware.ts": mw },
    { "vercel.json": "null" },
    { "middleware.ts": mw, "middleware.js": mw },
  ];
  for (const files of problems) {
    const all = { "package.json": "{}", ...files };
    assert.equal(existingMiddleware(readerOf(all)), null, JSON.stringify(files));
    const plan = planVercelEdge(readerOf(all), true, SERVER_VERSION);
    assert.deepEqual([plan.changes, plan.manual.length], [[], 1], JSON.stringify(files));
  }
});

test("a created middleware that an editor saved with a byte-order mark is still the wizard's file, and is deleted", () => {
  const withBom = `\uFEFF${vercelMiddlewareTemplate()}`;
  assert.deepEqual(unplanVercelEdge(readerOf({ "middleware.ts": withBom })).changes.map((c) => [c.path, c.after]), [["middleware.ts", null]]);
});
