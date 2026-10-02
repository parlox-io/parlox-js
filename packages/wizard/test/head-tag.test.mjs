import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, existsSync, readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { addHtmlHeadTag, addJsHeadTag, addPugHeadTag, addPageTag, headTag, HTML_MARKER, JSX_MARKER, PUG_MARKER, pugTag, removeHtmlHeadTag, removePageTag, removePugHeadTag } from "../dist/edits/head-tag.js";
import { findExpressPages, markedFiles, walkFiles } from "../dist/edits/views.js";
import { viteOutDir } from "../dist/edits/vite-config.js";
import { express } from "../dist/integrations/express.js";
import { BROWSER_VERSION, TAG_INTEGRITY, TAG_URL, TAG_VERSION } from "../dist/versions.js";
import { readText } from "../dist/workspace.js";
import { readInside } from "../dist/fs-safe.js";
import { describeUnit, planUnit, scanApps } from "../dist/apps.js";
import { main } from "../dist/cli.js";
import { startFakeAuth, startFakeGateway } from "./fake-servers.mjs";
import { fixture } from "./helpers.mjs";

const PK = "pk_" + "a1".repeat(12);
const TAG = headTag(PK);
// The tag the wizard writes carries a marker in the file's own comment syntax.
const M = HTML_MARKER;
// Layouts exactly as express-generator 4.16.1 writes them.
const LAYOUT_PUG = "doctype html\nhtml\n  head\n    title= title\n    link(rel='stylesheet', href='/stylesheets/style.css')\n  body\n    block content\n";
const LAYOUT_HBS = "<!DOCTYPE html>\n<html>\n  <head>\n    <title>{{title}}</title>\n    <link rel='stylesheet' href='/stylesheets/style.css' />\n  </head>\n  <body>\n    {{{body}}}\n  </body>\n</html>\n";
const INDEX_EJS = "<!DOCTYPE html>\n<html>\n  <head>\n    <title><%= title %></title>\n    <link rel='stylesheet' href='/stylesheets/style.css' />\n  </head>\n  <body>\n    <h1><%= title %></h1>\n    <p>Welcome to <%= title %></p>\n  </body>\n</html>\n";
const STATIC_HTML = "<html>\n\n<head>\n  <title>Express</title>\n  <link rel=\"stylesheet\" href=\"/stylesheets/style.css\">\n</head>\n\n<body>\n  <h1>Express</h1>\n  <p>Welcome to Express</p>\n</body>\n\n</html>\n";
// create-hono 0.19.5, template cloudflare-pages: src/renderer.tsx.
const RENDERER = "import { jsxRenderer } from 'hono/jsx-renderer'\n\nexport const renderer = jsxRenderer(({ children }) => {\n  return (\n    <html>\n      <head>\n        <link href=\"/static/style.css\" rel=\"stylesheet\" />\n      </head>\n      <body>{children}</body>\n    </html>\n  )\n})\n";

test("the tag is the dashboard's pinned tag: the release this wizard installs, its integrity, the public key", () => {
  assert.equal(TAG_VERSION, BROWSER_VERSION, "the tag and the npm package are the same release");
  assert.equal(TAG_URL, `https://gateway.parlox.io/sdk/${TAG_VERSION}/parlox.js`);
  assert.match(TAG_INTEGRITY, /^sha384-[A-Za-z0-9+/]{64}$/);
  assert.equal(TAG, `<script async src="${TAG_URL}" integrity="${TAG_INTEGRITY}" crossorigin="anonymous" data-key="${PK}"></script>`);
  assert.throws(() => addHtmlHeadTag(LAYOUT_HBS, "pk_bad key"), /invalid public key/);
});

test("HTML-like files: right after the single <head>, at its children's indentation; removal gives back the bytes", () => {
  for (const [text, line] of [[LAYOUT_HBS, `  <head>\n    ${M}\n    ${TAG}\n    <title>`], [INDEX_EJS, `  <head>\n    ${M}\n    ${TAG}\n    <title>`], [STATIC_HTML, `<head>\n  ${M}\n  ${TAG}\n  <title>`]]) {
    const e = addHtmlHeadTag(text, PK);
    assert.ok(e.code.includes(line), e.code);
    assert.equal(addHtmlHeadTag(e.code, PK).changed, false, "a second run changes nothing");
    assert.equal(removeHtmlHeadTag(e.code).code, text);
  }
  const minified = "<!doctype html><html><head><title>x</title></head><body></body></html>";
  assert.equal(addHtmlHeadTag(minified, PK).code, `<!doctype html><html><head>${M}${TAG}<title>x</title></head><body></body></html>`);
  assert.equal(removeHtmlHeadTag(addHtmlHeadTag(minified, PK).code).code, minified);
  const crlf = LAYOUT_HBS.replace(/\n/g, "\r\n");
  assert.equal(removeHtmlHeadTag(addHtmlHeadTag(crlf, PK).code).code, crlf);
});

test("<header> is not <head>; two heads, none, or another key is a snippet; a Parlox tag already there is left alone", () => {
  assert.equal(addHtmlHeadTag("<header></header><head></head>", PK).code, `<header></header><head>${M}${TAG}</head>`);
  assert.match(addHtmlHeadTag("<head></head><head></head>", PK).reason, /more than one <head>/);
  assert.match(addHtmlHeadTag("<body></body>", PK).reason, /no <head>/);
  assert.match(addHtmlHeadTag(`<head>${M}${headTag("pk_other12345")}</head>`, PK).reason, /another key/);
  const latest = '<head><script async src="https://gateway.parlox.io/sdk/parlox.js" data-key="pk_x1234567"></script></head>';
  const e = addHtmlHeadTag(latest, PK);
  assert.deepEqual([e.changed, e.code], [false, latest]);
  assert.match(e.warning, /already in this file/);
});

test("Pug and Jade: the first child of the single head block, at its indentation", () => {
  const e = addPugHeadTag(LAYOUT_PUG, PK);
  assert.equal(e.code, `doctype html\nhtml\n  head\n    ${PUG_MARKER}\n    ${pugTag(PK)}\n    title= title\n    link(rel='stylesheet', href='/stylesheets/style.css')\n  body\n    block content\n`);
  assert.equal(removePugHeadTag(e.code).code, LAYOUT_PUG);
  assert.equal(addPugHeadTag(e.code, PK).changed, false);
  assert.equal(addPugHeadTag("html\n\thead\n\tbody\n", PK).code, `html\n\thead\n\t\t${PUG_MARKER}\n\t\t${pugTag(PK)}\n\tbody\n`, "a head with no children takes the file's tab");
  assert.match(addPugHeadTag("extends layout\n\nblock content\n  h1= title\n", PK).reason, /no head block/);
});

test("JavaScript: a JSX <head> element (Hono's jsxRenderer) or an html`…` template with one <head>; a plain string is not a page", () => {
  const j = addJsHeadTag(RENDERER, "src/renderer.tsx", PK);
  assert.ok(j.code.includes(`      <head>\n        ${JSX_MARKER}\n        ${TAG}\n        <link href="/static/style.css"`), j.code);
  assert.equal(removeHtmlHeadTag(j.code).code, RENDERER);
  const tpl = "import { html } from 'hono/html'\n\nexport const layout = (body) => html`<!doctype html><html><head><meta charset=\"utf-8\"><title>${'x'}</title></head><body>${body}</body></html>`\n";
  const t = addJsHeadTag(tpl, "src/html.ts", PK);
  assert.ok(t.code.includes(`<head>${M}${TAG}<meta charset="utf-8">`));
  assert.equal(removeHtmlHeadTag(t.code).code, tpl);
  const plain = "export const layout = (b) => `<!doctype html><html><head><title>x</title></head><body>${b}</body></html>`\n";
  assert.match(addJsHeadTag(plain, "src/html.mjs", PK).reason, /no JSX <head> element and no html`…` template/);
});

test("addPageTag and removePageTag pick the editor from the file name", () => {
  assert.equal(addPageTag("views/layout.jade", LAYOUT_PUG, PK).code, addPugHeadTag(LAYOUT_PUG, PK).code);
  assert.equal(addPageTag("src/renderer.tsx", RENDERER, PK).code, addJsHeadTag(RENDERER, "src/renderer.tsx", PK).code);
  assert.equal(removePageTag("views/layout.pug", addPugHeadTag(LAYOUT_PUG, PK).code).code, LAYOUT_PUG);
});

const GEN_APP = (engine) => `var express = require('express');\nvar path = require('path');\n\nvar app = express();\n\n${engine ? `app.set('views', path.join(__dirname, 'views'));\napp.set('view engine', '${engine}');\n\n` : ""}app.use(express.static(path.join(__dirname, 'public')));\n\nmodule.exports = app;\n`;
const expressApp = (engine, files) => fixture({
  "package.json": JSON.stringify({ scripts: { start: "node ./bin/www" }, dependencies: { express: "~4.16.1" } }), "package-lock.json": "{}",
  "bin/www": "var app = require('../app');\n", "app.js": GEN_APP(engine), "public/stylesheets/style.css": "body {}\n", ...files,
});

test("Express views: the layout express-generator makes (pug, jade, hbs); views with their own <head> when there is no layout (ejs)", () => {
  for (const [engine, files, expected] of [
    ["pug", { "views/layout.pug": LAYOUT_PUG, "views/index.pug": "extends layout\n" }, ["views/layout.pug"]],
    ["jade", { "views/layout.jade": LAYOUT_PUG }, ["views/layout.jade"]],
    ["hbs", { "views/layout.hbs": LAYOUT_HBS, "views/index.hbs": "<h1>{{title}}</h1>\n" }, ["views/layout.hbs"]],
    ["ejs", { "views/index.ejs": INDEX_EJS, "views/error.ejs": "<h1><%= message %></h1>\n" }, ["views/index.ejs"]],
  ]) {
    const dir = expressApp(engine, files);
    const read = readText(dir);
    assert.deepEqual(findExpressPages(dir, read, "app.js", read("app.js"), "app").files, expected, engine);
  }
  // express-handlebars' own example names the engine with its dot, and its layout is layouts/main.
  const dotted = expressApp(".hbs", { "views/layouts/main.hbs": LAYOUT_HBS, "views/home.hbs": "<h1>x</h1>\n" });
  assert.deepEqual(findExpressPages(dotted, readText(dotted), "app.js", readText(dotted)("app.js"), "app").files, ["views/layouts/main.hbs"]);
  const twig = expressApp("twig", { "views/layout.twig": "<head></head>" });
  assert.match(findExpressPages(twig, readText(twig), "app.js", readText(twig)("app.js"), "app").manual[0].reason, /does not edit twig templates/);
});

test("Express static HTML: every .html page with one <head>, at most 20; more is a snippet", () => {
  const dir = expressApp(null, { "public/index.html": STATIC_HTML, "public/about/index.html": STATIC_HTML, "public/fragment.html": "<div></div>\n" });
  const pages = findExpressPages(dir, readText(dir), "app.js", readText(dir)("app.js"), "app");
  assert.deepEqual(pages.files.sort(), ["public/about/index.html", "public/index.html"]);
  assert.deepEqual(pages.manual.map((m) => m.file), [], "a fragment (no <html>, doctype or <body>) is left alone");
  assert.deepEqual(express.detect(dir, dir).facts[1], ["Views", "public/: 2 HTML pages"], "the fact line names the folder and the count");
  const many = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`public/p${i}.html`, STATIC_HTML]));
  const big = expressApp(null, many);
  const p = findExpressPages(big, readText(big), "app.js", readText(big)("app.js"), "app");
  assert.deepEqual(p.files, []);
  assert.match(p.manual[0].reason, /More than 20 HTML files/);
});

test("the Express plan: the layout gets the tag, the report's pure-API note only when the app has no pages", () => {
  const git = { isRepo: () => false, dirty: () => [], isTracked: () => false, isIgnored: () => false };
  const reader = (dir) => (rel) => (existsSync(join(dir, rel)) ? readFileSync(join(dir, rel), "utf8") : null);
  const dir = expressApp("pug", { "views/layout.pug": LAYOUT_PUG });
  const d = express.detect(dir, dir);
  assert.deepEqual(d.facts[1], ["Views", "pug (views/layout.pug)"]);
  const plan = express.plan(d, { publicKey: PK, verifyToken: "vt", host: { id: "unknown" }, versions: { browser: BROWSER_VERSION, server: "1.1.0" }, parts: { browser: true, server: true }, read: reader(dir), git });
  assert.deepEqual(plan.changes.map((c) => [c.path, c.purpose]), [["app.js", "server part"], ["views/layout.pug", "browser part"]]);
  assert.deepEqual(plan.install.args, ["install", "--save-exact", "@parlox/server@1.1.0"], "the tag needs no package");
  const api = fixture({ "package.json": JSON.stringify({ dependencies: { express: "^5.1.0" } }), "package-lock.json": "{}", "server.js": "const express = require('express');\nconst app = express();\napp.get('/api/x', h);\n" });
  const a = express.detect(api, api);
  assert.equal(a.parts.browser, null);
  assert.match(express.hostNotes(a, { id: "unknown" }, { browser: false, server: true, unitHasBrowser: false }).join("\n"), /the browser part belongs in your frontend/);
  assert.doesNotMatch(express.hostNotes(d, { id: "unknown" }, { browser: true, server: true, unitHasBrowser: true }).join("\n"), /belongs in your frontend/);
});

// ---- Template syntax, line breaks, heads that are not markup, existing tags, Express pages ----

const git = { isRepo: () => false, dirty: () => [], isTracked: () => false, isIgnored: () => false };
const reader = (dir) => (rel) => (existsSync(join(dir, rel)) ? readFileSync(join(dir, rel), "utf8") : null);
const planInput = (dir, extra = {}) => ({ publicKey: PK, verifyToken: "vt", host: { id: "unknown" }, versions: { browser: BROWSER_VERSION, server: "1.1.0" }, parts: { browser: true, server: true }, read: reader(dir), git, ...extra });

test("the inserted tag is inert in every template language edited: no EJS, Handlebars, Nunjucks or JavaScript template syntax", () => {
  for (const t of [TAG, pugTag(PK)]) {
    for (const s of ["<%", "%>", "{{", "}}", "{%", "{#", "${", "`", "\\", "#{", "!{"]) assert.equal(t.includes(s), false, `${s} in ${t}`);
  }
  // In Pug the tag is Pug syntax, so the engine writes the same <script> element.
  assert.equal(pugTag(PK), `script(async, src="${TAG_URL}", integrity="${TAG_INTEGRITY}", crossorigin="anonymous", data-key="${PK}")`);
});

test("CRLF files get CRLF lines (HTML-like, Pug, JSX), and removal restores the exact bytes", () => {
  const html = LAYOUT_HBS.replace(/\n/g, "\r\n");
  const h = addHtmlHeadTag(html, PK);
  assert.equal(/[^\r]\n/.test(h.code), false, "every line break is CRLF");
  assert.ok(h.code.includes(`  <head>\r\n    ${M}\r\n    ${TAG}\r\n    <title>`), h.code);
  const pug = LAYOUT_PUG.replace(/\n/g, "\r\n");
  const p = addPugHeadTag(pug, PK);
  assert.equal(/[^\r]\n/.test(p.code), false);
  assert.ok(p.code.includes(`  head\r\n    ${PUG_MARKER}\r\n    ${pugTag(PK)}\r\n    title= title`), p.code);
  assert.equal(removePugHeadTag(p.code).code, pug);
  const jsx = RENDERER.replace(/\n/g, "\r\n");
  const j = addJsHeadTag(jsx, "src/renderer.tsx", PK);
  assert.equal(/[^\r]\n/.test(j.code), false);
  assert.equal(removeHtmlHeadTag(j.code).code, jsx);
});

test("a line break the wizard does not edit around (a lone CR, U+2028) is a snippet with the reason, never an error", () => {
  const cr = "<html>\r<head>\n</head>\n</html>\n";
  const e = addHtmlHeadTag(cr, PK);
  assert.equal(e.ok, false);
  assert.match(e.reason, /carriage return without a line feed/);
  assert.ok(e.snippet.includes(TAG));
  assert.match(addPugHeadTag("html\r  head\n", PK).reason, /carriage return/);
  assert.match(addJsHeadTag(`const a = "\u2028"\nexport const r = () => <html><head></head></html>\n`, "r.jsx", PK).reason, /Unicode line separator/);
  // Removing: the same reason, as a step by hand.
  const r = removeHtmlHeadTag(`<head>\n  ${M}\n  ${TAG}\r</head>\n`);
  assert.equal(r.ok, false);
  assert.match(r.reason, /carriage return/);
  assert.match(removePugHeadTag(`head\n  ${PUG_MARKER}\n  ${pugTag(PK)}\n\u2029`).reason, /Unicode line separator/);
});

test("a <head> that is not markup is not the anchor: in a comment, a script, a style, or a template tag", () => {
  assert.equal(addHtmlHeadTag("<!-- <head> -->\n<html><head></head></html>", PK).code, `<!-- <head> -->\n<html><head>${M}${TAG}</head></html>`);
  assert.match(addHtmlHeadTag("<!-- <head></head> -->\n<body></body>", PK).reason, /no <head>/);
  const script = "<head><script>document.write('<head>')</script></head>";
  assert.equal(addHtmlHeadTag(script, PK).code, `<head>${M}${TAG}<script>document.write('<head>')</script></head>`);
  assert.match(addHtmlHeadTag("<style>/* <head> */</style><body></body>", PK).reason, /no <head>/);
  assert.match(addHtmlHeadTag("<%# <head> %>\n{{!-- <head> --}}\n{# <head> #}\n<body></body>", PK).reason, /no <head>/);
  // A template expression inside the <head …> tag is skipped over: the tag goes after the element's own '>'.
  assert.equal(addHtmlHeadTag("<head <%- attrs %>></head>", PK).code, `<head <%- attrs %>>${M}${TAG}</head>`);
  // A ">" inside a quoted attribute value does not end the tag; a quote left open is no anchor.
  assert.equal(addHtmlHeadTag(`<head data-x="a>b"></head>`, PK).code, `<head data-x="a>b">${M}${TAG}</head>`);
  assert.match(addHtmlHeadTag(`<head data-x="a>\n</head>\n`, PK).reason, /no <head>/);
  // An html`…` template: a <head> in its comment is not counted.
  const tpl = "const p = () => html`<!-- <head> --><html><head></head></html>`\n";
  assert.equal(addJsHeadTag(tpl, "p.js", PK).code, `const p = () => html\`<!-- <head> --><html><head>${M}${TAG}</head></html>\`\n`);
});

test("Pug: a head inside a comment or a text block is not the head block; two head blocks are a snippet", () => {
  assert.match(addPugHeadTag("html\n  //\n    head\n  body\n", PK).reason, /no head block/);
  assert.match(addPugHeadTag("html\n  body\n    p.\n      head\n", PK).reason, /no head block/);
  assert.match(addPugHeadTag("html\n  :markdown-it\n    head\n", PK).reason, /no head block/);
  const commented = "html\n  //- old\n    head\n  head\n    title x\n";
  assert.equal(addPugHeadTag(commented, PK).code, `html\n  //- old\n    head\n  head\n    ${PUG_MARKER}\n    ${pugTag(PK)}\n    title x\n`);
  assert.match(addPugHeadTag("html\n  if a\n    head\n  else\n    head\n", PK).reason, /more than one head block/);
  // head with attributes, and a CRLF head line.
  assert.equal(addPugHeadTag("html\n  head(lang='en')\n    title x\n", PK).code, `html\n  head(lang='en')\n    ${PUG_MARKER}\n    ${pugTag(PK)}\n    title x\n`);
});

test("an existing Parlox tag (any gateway /sdk/ script, a ParloxAnalytics element) is left alone, with a warning that names its line", () => {
  const withKey = "<!doctype html>\n<html>\n<head>\n<script async src=\"https://gateway.parlox.io/sdk/1.0.3/parlox.js?key=pk_x1234567\"></script>\n</head>\n</html>\n";
  const e = addHtmlHeadTag(withKey, PK);
  assert.deepEqual([e.ok, e.changed, e.code], [true, false, withKey]);
  assert.match(e.warning, /line 4/);
  const pug = "html\n  head\n    script(src='https://gateway.parlox.io/sdk/parlox.js', data-key='pk_x1234567')\n";
  assert.deepEqual([addPugHeadTag(pug, PK).changed, addPugHeadTag(pug, PK).code], [false, pug]);
  assert.match(addPugHeadTag(pug, PK).warning, /line 3/);
  const jsx = "export const L = () => <html><head><ParloxAnalytics publicKey=\"pk_x1234567\" /></head></html>\n";
  assert.match(addJsHeadTag(jsx, "l.jsx", PK).warning, /already in this file, on line 1/);
  // The wizard's own (marked) tag with another key is a snippet, in Pug too.
  assert.match(addPugHeadTag(`html\n  head\n    ${PUG_MARKER}\n    ${pugTag("pk_other12345")}\n`, PK).reason, /another key \(pk_other12345\)/);
});

test("the Express plan: the warning about an existing tag goes in the review and the report (plan.warnings and d.notes), naming the file and line", () => {
  const page = "<html>\n<head>\n  <script async src=\"https://gateway.parlox.io/sdk/parlox.js\" data-key=\"pk_x1234567\"></script>\n</head>\n</html>\n";
  const dir = expressApp(null, { "public/index.html": page });
  const d = express.detect(dir, dir);
  const plan = express.plan(d, planInput(dir));
  const warning = plan.warnings.find((w) => w.startsWith("public/index.html: "));
  assert.ok(warning, plan.warnings.join("\n"));
  assert.match(warning, /line 3/);
  assert.ok(d.notes.includes(warning), d.notes.join("\n"));
  assert.deepEqual(plan.changes.map((c) => c.path), ["app.js"], "no second tag");
});

test("Express static pages: compiled output (dist/, build/) is never edited, a page git ignores is a step by hand, a symlinked page is refused", { skip: process.platform === "win32" }, () => {
  const built = fixture({
    "package.json": JSON.stringify({ dependencies: { express: "^5.1.0" } }), "package-lock.json": "{}",
    "server.js": "const express = require('express');\nconst app = express();\napp.use(express.static('dist'));\n", "dist/index.html": STATIC_HTML,
  });
  const b = express.detect(built, built);
  assert.deepEqual(b.data.pages.files, []);
  assert.deepEqual(b.data.pages.manual.map((m) => m.file), ["dist/"]);
  assert.match(b.data.pages.manual[0].reason, /^dist\/ is build output: the next build would replace a change there/);
  const dir = expressApp(null, { "public/index.html": STATIC_HTML, "public/kept.html": STATIC_HTML });
  const ignored = { ...git, isRepo: () => true, isIgnored: (rel) => rel === "public/kept.html" };
  const plan = express.plan(express.detect(dir, dir), planInput(dir, { git: ignored }));
  assert.deepEqual(plan.changes.map((c) => c.path), ["app.js", "public/index.html"]);
  assert.match(plan.manual.find((m) => m.file === "public/kept.html").reason, /^git ignores public\/kept\.html/);
  assert.ok(plan.manual.find((m) => m.file === "public/kept.html").snippet.includes(TAG));
  // A page reached through a symlink: refused by the reader the run uses, a step by hand, never the end of the run.
  const linked = expressApp(null, { "elsewhere/page.html": STATIC_HTML });
  symlinkSync(join(linked, "elsewhere/page.html"), join(linked, "public/page.html"));
  const d = express.detect(linked, linked);
  assert.deepEqual(d.data.pages.files, ["public/page.html"]);
  const io = { read: (rel) => readInside(linked, rel), git };
  const p = express.plan(d, planInput(linked, io));
  assert.deepEqual(p.changes.map((c) => c.path), ["app.js"]);
  assert.match(p.manual.find((m) => m.file === "public/page.html").reason, /^Refusing public\/page\.html/);
  // Uninstall reads only pages with the wizard's marker: a linked page that has one is a step by hand.
  assert.equal(express.unplan(d, io).manual.some((m) => m.file === "public/page.html"), false, "no marker: nothing to remove");
  writeFileSync(join(linked, "elsewhere/page.html"), addHtmlHeadTag(STATIC_HTML, PK).code);
  assert.match(express.unplan(d, io).manual.find((m) => m.file === "public/page.html").reason, /^Refusing public\/page\.html/);
});

test("Express folders: a literal, __dirname + '/…', `${__dirname}/…` and path.join from src/ are followed; one computed in code, or outside the app, is a snippet", () => {
  const pages = (server, file = "app.js") => {
    const dir = fixture({ "package.json": JSON.stringify({ dependencies: { express: "^5.1.0" } }), [file]: server, "public/index.html": STATIC_HTML, "src/views/layout.ejs": INDEX_EJS });
    return findExpressPages(dir, readText(dir), file, server, "app");
  };
  const head = "const express = require('express');\nconst path = require('path');\nconst app = express();\n";
  for (const arg of ["'public'", "'./public/'", "__dirname + '/public'", "`${__dirname}/public`", "path.join(__dirname, 'public')", "path.resolve('public')"]) {
    assert.deepEqual(pages(`${head}app.use(express.static(${arg}));\n`).files, ["public/index.html"], arg);
  }
  assert.deepEqual(pages(`${head}app.set('views', path.join(__dirname, 'views'));\napp.set('view engine', 'ejs');\n`, "src/app.js").files, ["src/views/layout.ejs"]);
  for (const arg of ["process.env.STATIC_DIR", "path.join(process.cwd(), 'public')", "path.resolve(__dirname, '/srv/public')", "'../public'"]) {
    const p = pages(`${head}app.use(express.static(${arg}));\n`);
    assert.deepEqual(p.files, [], arg);
    assert.match(p.manual[0].reason, /A static folder is computed in code/, arg);
  }
});

test("Express: a pug app without a layout is a step by hand naming the views folder, in Pug syntax", () => {
  const dir = expressApp("pug", { "views/index.pug": "extends layout\n" });
  const d = express.detect(dir, dir);
  assert.equal(d.parts.browser.file, null);
  assert.match(d.parts.browser.manualReason, /No layout\.pug and no view with a single <head> in views\//);
  const plan = express.plan(d, planInput(dir));
  const m = plan.manual.find((x) => x.part === "browser");
  assert.equal(m.file, "views/");
  assert.ok(m.snippet.includes(pugTag(PK)), m.snippet);
});

test("Express in a unit: describeUnit and planUnit carry the browser part; uninstall gives every edited file back byte for byte", () => {
  const dir = expressApp("hbs", { "views/layout.hbs": LAYOUT_HBS.replace(/\n/g, "\r\n"), "public/index.html": STATIC_HTML });
  const [u] = scanApps(dir).units;
  assert.equal(describeUnit(u), "./ · Express · browser and server parts");
  assert.deepEqual(u.detections[0].facts[1], ["Views", "hbs (views/layout.hbs); public/: 1 HTML page"]);
  const plan = planUnit(u, { publicKey: PK, verifyToken: "vt", host: { id: "unknown" } }, { read: reader(dir), git });
  assert.deepEqual(plan.changes.map((c) => [c.path, c.purpose]), [["app.js", "server part"], ["views/layout.hbs", "browser part"], ["public/index.html", "browser part"]]);
  for (const c of plan.changes) writeFileSync(join(dir, c.path), c.after);
  const back = express.unplan(express.detect(dir, dir), { read: reader(dir), git });
  assert.deepEqual(back.changes.map((c) => c.path), ["app.js", "views/layout.hbs", "public/index.html"]);
  for (const c of back.changes) assert.equal(c.after, plan.changes.find((x) => x.path === c.path).before, c.path);
});

test("install, then uninstall, end to end: the layout and the static page get the tag, and come back byte for byte", async (t) => {
  const auth = await startFakeAuth({ decide: "approve" });
  const gw = await startFakeGateway({ sites: [{ id: "11111111-1111-1111-1111-111111111111", name: "Shop", domain: "shop.example.com", public_key: PK, verified: false }], keys: [] });
  t.after(() => { auth.close(); gw.close(); });
  const dir = expressApp("pug", { "views/layout.pug": LAYOUT_PUG, "public/index.html": STATIC_HTML });
  const original = Object.fromEntries(["app.js", "views/layout.pug", "public/index.html"].map((f) => [f, readFileSync(join(dir, f), "utf8")]));
  const out = [];
  const ui = { info: (m) => out.push(m), warn: (m) => out.push(`WARN ${m}`), confirm: async () => true, select: async (_m, o) => o[0].value, text: async () => "" };
  const config = { gateway: gw.url, supabaseUrl: auth.url, clientId: "wiz", apiKey: "test-publishable-key", ports: [53832, 53833], dashboard: "https://app.parlox.io" };
  const deps = { cwd: dir, config, ui, open: (url) => { fetch(url).catch(() => {}); }, run: () => ({ status: 0, stdout: "", stderr: "" }) };
  assert.equal(await main(["--yes", "--allow-no-git", "--no-vercel", "--site", "shop.example.com", "--skip-check"], deps), 0, out.join("\n"));
  assert.ok(readFileSync(join(dir, "views/layout.pug"), "utf8").includes(`  head\n    ${PUG_MARKER}\n    ${pugTag(PK)}\n`));
  assert.ok(readFileSync(join(dir, "public/index.html"), "utf8").includes(`<head>\n  ${M}\n  ${TAG}\n`));
  assert.ok(out.at(-1).includes("Browser part: added to your code"), out.at(-1));
  assert.equal(await main(["uninstall", "--yes", "--allow-no-git"], deps), 0, out.join("\n"));
  for (const [f, text] of Object.entries(original)) assert.equal(readFileSync(join(dir, f), "utf8"), text, f);
});

// ---- Every template with one head, pages it cannot edit, Pug heads, a tag anywhere in the views ----

const pagesOf = (dir) => findExpressPages(dir, readText(dir), "app.js", readText(dir)("app.js"), "app");
const HBS_APP = (body) => `const express = require('express');\nconst path = require('path');\nconst app = express();\n${body}\nmodule.exports = app;\n`;
const app = (server, files) => fixture({ "package.json": JSON.stringify({ dependencies: { express: "^4.21.0" } }), "package-lock.json": "{}", "app.js": server, ...files });
const EJS_PAGE = "<!DOCTYPE html>\n<html>\n<head>\n  <title><%= title %></title>\n</head>\n<body></body>\n</html>\n";

test("every template in the views folder with one <head> gets the tag: other layouts, standalone pages, express-handlebars layouts, pages in subfolders", () => {
  const cases = [
    ["pug", { "views/layout.pug": LAYOUT_PUG, "views/admin/layout.pug": LAYOUT_PUG, "views/index.pug": "extends layout\n", "views/admin/index.pug": "extends layout\n" }, ["views/layout.pug", "views/admin/layout.pug"]],
    ["pug", { "views/layout.pug": LAYOUT_PUG, "views/landing.pug": LAYOUT_PUG }, ["views/landing.pug", "views/layout.pug"]],
    ["pug", { "views/layout.pug": LAYOUT_PUG, "views/layout-admin.pug": LAYOUT_PUG }, ["views/layout-admin.pug", "views/layout.pug"]],
    ["handlebars", { "views/layouts/main.handlebars": LAYOUT_HBS, "views/layouts/admin.handlebars": LAYOUT_HBS, "views/home.handlebars": "<h1>x</h1>\n" }, ["views/layouts/admin.handlebars", "views/layouts/main.handlebars"]],
    ["handlebars", { "views/layouts/base.handlebars": LAYOUT_HBS, "views/home.handlebars": "<h1>x</h1>\n" }, ["views/layouts/base.handlebars"]],
    ["ejs", { "views/index.ejs": EJS_PAGE, "views/admin/index.ejs": EJS_PAGE, "views/admin/users.ejs": EJS_PAGE }, ["views/index.ejs", "views/admin/index.ejs", "views/admin/users.ejs"]],
    // The head lives in a partial every page includes: the partial gets the tag, the pages are fragments.
    ["ejs", { "views/partials/header.ejs": "<!DOCTYPE html>\n<html>\n<head>\n  <title>x</title>\n</head>\n<body>\n", "views/index.ejs": "<%- include('partials/header') %>\n<h1>x</h1>\n" }, ["views/partials/header.ejs"]],
  ];
  for (const [engine, files, expected] of cases) {
    const p = pagesOf(expressApp(engine, files));
    assert.deepEqual([p.files, p.manual], [expected, []], `${engine}: ${Object.keys(files).join(", ")}`);
  }
});

test("a page or layout the wizard cannot edit is a step by hand: two heads, no head of its own, more than 20 in the app", () => {
  const p = pagesOf(expressApp("ejs", {
    "views/head.ejs": "<head>\n  <title>x</title>\n</head>\n",
    // A head from a partial the wizard tags is covered (a note); one it cannot follow stays a step.
    "views/page.ejs": "<!DOCTYPE html>\n<html>\n<%- include(headFile) %>\n<body></body>\n</html>\n",
    "views/twice.ejs": "<html><head></head><head></head><body></body></html>\n",
  }));
  assert.deepEqual(p.files, ["views/head.ejs"]);
  assert.deepEqual(p.manual.map((m) => [m.file, m.reason.split(",")[0]]), [["views/twice.ejs", "This page has more than one <head>."], ["views/page.ejs", "This page has no <head> of its own"]]);
  const many = pagesOf(expressApp("ejs", Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`views/p${String(i).padStart(2, "0")}.ejs`, EJS_PAGE]))));
  assert.deepEqual(many.files, []);
  assert.match(many.manual[0].reason, /^More than 20 templates with a <head> in this app \(views\/p00\.ejs, .*views\/p19\.ejs, and 1 more\)/);
});

test("a Pug head whose attributes run over several lines, or with content on its line, is a snippet, never an edit inside the attribute list", () => {
  const multi = "doctype html\nhtml\n  head(\n    lang='en'\n  )\n    title x\n  body\n";
  const e = addPugHeadTag(multi, PK);
  assert.equal(e.ok, false);
  assert.match(e.reason, /attributes run over several lines/);
  assert.match(addPugHeadTag("doctype html\nhtml\n  head: title x\n  body\n", PK).reason, /a form the wizard does not edit/);
  assert.match(addPugHeadTag("html\n  head(\n    lang='en'\n  )\n  head\n", PK).reason, /more than one head block/, "a multi-line head still counts");
  // As a layout in an app: a step by hand, in Pug syntax.
  const d = express.detect(...[expressApp("pug", { "views/layout.pug": multi })].flatMap((x) => [x, x]));
  assert.deepEqual(d.data.pages.files, ["views/layout.pug"]);
  const plan = express.plan(d, planInput(d.dir));
  assert.match(plan.manual.find((m) => m.file === "views/layout.pug").snippet, /^As the first line inside the head block/);
  assert.equal(plan.changes.some((c) => c.path === "views/layout.pug"), false);
});

test("a Parlox tag anywhere in the views (a child view, a partial) means no second tag in them, with a warning naming the file and line", () => {
  const child = expressApp("pug", { "views/layout.pug": LAYOUT_PUG, "views/index.pug": "extends layout\nblock content\n  script(async, src='https://gateway.parlox.io/sdk/parlox.js', data-key='pk_x1234567')\n" });
  const d = express.detect(child, child);
  const warning = "views/index.pug: A Parlox tag is already in this file, on line 3; it was left as it is, and the wizard adds no tag to the other views in views/, which may show it.";
  assert.deepEqual([d.data.pages.files, d.data.pages.manual, d.data.pages.warnings], [[], [], [warning]]);
  assert.ok(d.notes.includes(warning), "in the report");
  const plan = express.plan(d, planInput(child));
  assert.deepEqual(plan.changes.map((c) => c.path), ["app.js"], "no second tag");
  assert.ok(plan.warnings.includes(warning), "in the review");
  assert.doesNotMatch(express.hostNotes(d, { id: "unknown" }, { browser: false, server: true, unitHasBrowser: false }).join("\n"), /serves no pages/, "its pages are there, with Parlox already");
  const partial = app(HBS_APP("app.set('view engine', 'hbs');"), { "views/layout.hbs": LAYOUT_HBS.replace("<title>", "{{> analytics}}\n    <title>"), "views/partials/analytics.hbs": '<script async src="https://gateway.parlox.io/sdk/parlox.js" data-key="pk_x1234567"></script>\n' });
  const p = pagesOf(partial);
  assert.deepEqual(p.files, []);
  assert.match(p.warnings[0], /^views\/partials\/analytics\.hbs: A Parlox tag is already in this file, on line 1;/);
  // A static page is whole: its own tag leaves the layout and the other pages to the wizard.
  const mixed = app(HBS_APP("app.set('view engine', 'hbs');\napp.use(express.static(path.join(__dirname, 'public')));"), { "views/layout.hbs": LAYOUT_HBS, "public/a.html": STATIC_HTML.replace("<title>", '<script async src="https://gateway.parlox.io/sdk/parlox.js" data-key="pk_x1234567"></script>\n  <title>'), "public/b.html": STATIC_HTML });
  const m = pagesOf(mixed);
  assert.deepEqual(m.files, ["views/layout.hbs", "public/b.html"]);
  assert.deepEqual(m.warnings, ["public/a.html: A Parlox tag is already in this file, on line 4; it was left as it is."]);
});

test("the marker in each syntax round-trips byte for byte (LF, CRLF, tabs, a byte-order mark, the last line), and a second run changes nothing", () => {
  const html = [LAYOUT_HBS, LAYOUT_HBS.replace(/\n/g, "\r\n"), "﻿<!DOCTYPE html>\r\n<html>\r\n\t<head>\r\n\t\t<meta charset=\"utf-8\">\r\n\t</head>\r\n</html>", "<html><head>", "<html>\n<head>\n", "﻿<head><title>x</title></head>"];
  for (const t of html) {
    const e = addHtmlHeadTag(t, PK);
    assert.ok(e.ok && e.changed && e.code.includes(`${M}`), JSON.stringify(t));
    assert.equal(removeHtmlHeadTag(e.code).code, t, JSON.stringify(t));
    assert.equal(addHtmlHeadTag(e.code, PK).changed, false);
  }
  const pug = [LAYOUT_PUG, LAYOUT_PUG.replace(/\n/g, "\r\n"), "doctype html\nhtml\n\thead\n\t\ttitle x\n", "html\n  head", "﻿head\n  title x\n"];
  for (const t of pug) {
    const e = addPugHeadTag(t, PK);
    assert.ok(e.ok && e.changed && e.code.includes(PUG_MARKER), JSON.stringify(t));
    assert.equal(removePugHeadTag(e.code).code, t, JSON.stringify(t));
    assert.equal(addPugHeadTag(e.code, PK).changed, false);
  }
  for (const t of [RENDERER, RENDERER.replace(/\n/g, "\r\n"), "export const A = () => <html><head><title>x</title></head></html>\n"]) {
    const e = addJsHeadTag(t, "a.tsx", PK);
    assert.ok(e.ok && e.changed && e.code.includes(JSX_MARKER), JSON.stringify(t));
    assert.equal(removeHtmlHeadTag(e.code).code, t);
  }
  assert.equal(addJsHeadTag("export const A = () => <html><head><title>x</title></head></html>\n", "a.jsx", PK).code, `export const A = () => <html><head>${JSX_MARKER}${TAG}<title>x</title></head></html>\n`);
});

test("a tag pasted by hand (no marker) is never removed; a marker without its tag is a step by hand, never a guess", () => {
  const pasted = STATIC_HTML.replace("<title>", `${TAG}\n  <title>`);
  const e = addHtmlHeadTag(pasted, PK);
  assert.deepEqual([e.changed, e.code], [false, pasted]);
  assert.match(e.warning, /already in this file, on line 4/);
  assert.deepEqual(removeHtmlHeadTag(pasted), { ok: true, code: pasted, changed: false });
  const pugPasted = `html\n  head\n    ${pugTag(PK)}\n`;
  assert.deepEqual(removePugHeadTag(pugPasted), { ok: true, code: pugPasted, changed: false });
  const stray = `<head>\n  ${M}\n  <title>x</title>\n</head>\n`;
  assert.match(removeHtmlHeadTag(stray).reason, /on line 2 is not right before the tag/);
  assert.match(addHtmlHeadTag(stray, PK).reason, /on line 2 is not right before the tag/);
  assert.match(removePugHeadTag(`html\n  head\n    ${PUG_MARKER}\n    title x\n`).reason, /on line 3/);
});

test("uninstall reads every page in the views and static folders, with no cap: 21 tagged pages, a layout added later, a page pasted by hand", () => {
  const files = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`public/s${i % 3}/p${i}.html`, STATIC_HTML]));
  const dir = expressApp(null, { ...files, "public/pasted.html": STATIC_HTML.replace("<title>", `${TAG}\n  <title>`) });
  for (const f of Object.keys(files)) writeFileSync(join(dir, f), addHtmlHeadTag(STATIC_HTML, PK).code);
  const d = express.detect(dir, dir);
  assert.equal(markedFiles(dir, d.data.pages.folders, readText(dir)).length, 21);
  const back = express.unplan(d, { read: reader(dir), git });
  assert.equal(back.changes.length, 21);
  for (const c of back.changes) assert.equal(c.after, STATIC_HTML, c.path);
  assert.equal(back.changes.some((c) => c.path === "public/pasted.html"), false, "a tag pasted by hand stays");
  // Views with their own <head>, installed; a layout added since does not hide them.
  const views = expressApp("ejs", { "views/index.ejs": EJS_PAGE, "views/about.ejs": EJS_PAGE });
  const plan = express.plan(express.detect(views, views), planInput(views));
  assert.deepEqual(plan.changes.map((c) => c.path), ["app.js", "views/about.ejs", "views/index.ejs"]);
  for (const c of plan.changes) writeFileSync(join(views, c.path), c.after);
  writeFileSync(join(views, "views/layout.ejs"), EJS_PAGE);
  const undo = express.unplan(express.detect(views, views), { read: reader(views), git });
  assert.deepEqual(undo.changes.map((c) => c.path).sort(), ["app.js", "views/about.ejs", "views/index.ejs"]);
  for (const c of undo.changes) assert.equal(c.after, plan.changes.find((x) => x.path === c.path).before, c.path);
});

test("attribute values and the text of <template>, <noscript>, <textarea>, <title>, CDATA and <?…?> are not markup", () => {
  for (const t of [
    "<html><body><button onclick=\"x('<head>')\">b</button></body></html>",
    "<template><head><p>x</p></head></template>",
    "<noscript><head></head></noscript><body></body>",
    "<html><body><textarea><head></textarea></body></html>",
    "<title><head></title><body></body>",
    "<svg><![CDATA[ <head> ]]></svg><body></body>",
    "<?php echo '<head>'; ?>\n<body></body>",
  ]) assert.match(addHtmlHeadTag(t, PK).reason, /no <head>/, t);
  assert.equal(addHtmlHeadTag("<template><head></head></template>\n<html><head></head></html>", PK).code, `<template><head></head></template>\n<html><head>${M}${TAG}</head></html>`);
});

test("pages deeper than 5 folders are named; the 20-page cap is per app; fragments are left alone; another build's output folder is not edited", () => {
  const deep = pagesOf(expressApp(null, { "public/a/b/c/d/e/f/index.html": STATIC_HTML, "public/index.html": STATIC_HTML }));
  assert.deepEqual(deep.files, ["public/index.html"]);
  assert.deepEqual(deep.manual.map((m) => m.file), ["public/a/b/c/d/e/f/index.html"]);
  assert.match(deep.manual[0].reason, /more than 5 folders below public\//);
  // Two folders, 15 pages each: the first is edited, the second would pass 20 in the app.
  const two = app(HBS_APP("app.use(express.static('public'));\napp.use('/docs', express.static('docs'));"), {
    ...Object.fromEntries(Array.from({ length: 15 }, (_, i) => [`public/p${i}.html`, STATIC_HTML])), ...Object.fromEntries(Array.from({ length: 15 }, (_, i) => [`docs/d${i}.html`, STATIC_HTML])),
  });
  const t = pagesOf(two);
  assert.equal(t.files.length, 15);
  assert.ok(t.files.every((f) => f.startsWith("public/")));
  assert.deepEqual(t.manual.map((m) => m.file), ["docs/"]);
  assert.match(t.manual[0].reason, /^More than 20 HTML files with a <head> in this app/);
  // A layout counts too: the layout and 19 pages fit, a 20th page does not.
  const layoutPlus = (n) => pagesOf(expressApp("hbs", { "views/layout.hbs": LAYOUT_HBS, ...Object.fromEntries(Array.from({ length: n }, (_, i) => [`public/p${i}.html`, STATIC_HTML])) })).files.length;
  assert.deepEqual([layoutPlus(19), layoutPlus(20)], [20, 1]);
  // Fragments (no <html>, doctype or <body>): left alone, not listed.
  const frag = pagesOf(expressApp(null, { "public/index.html": STATIC_HTML, "public/tpl/a.html": "<div>a</div>\n", "public/google1234.html": "google-site-verification: google1234.html" }));
  assert.deepEqual([frag.files, frag.manual], [["public/index.html"], []]);
  // A client whose Vite build writes into the folder Express serves.
  const vite = app(HBS_APP("app.use(express.static(path.join(__dirname, 'public')));"), {
    "public/index.html": STATIC_HTML, "client/index.html": STATIC_HTML, "client/vite.config.js": "export default { build: { outDir: '../public' } }\n",
    "client/package.json": JSON.stringify({ scripts: { build: "vite build" }, devDependencies: { vite: "^6.0.0" } }),
  });
  const v = express.detect(vite, vite);
  assert.deepEqual(v.data.pages.files, []);
  assert.deepEqual(v.data.pages.manual.map((m) => m.file), ["public/"]);
  assert.match(v.data.pages.manual[0].reason, /^public\/ is where the Vite build of client\/vite\.config\.js writes \(its build\.outDir\)/);
  // express.static(__dirname): the app's whole folder is not combed for pages.
  const root = pagesOf(app(HBS_APP("app.use(express.static(__dirname));"), { "index.html": STATIC_HTML, "coverage/index.html": STATIC_HTML }));
  assert.deepEqual([root.files, root.manual.map((m) => m.file)], [[], ["./"]]);
});

test("the walk opens at most its folder cap and says so; dot-folders, node_modules and linked folders are skipped", { skip: process.platform === "win32" }, () => {
  const dir = fixture({ "public/a/x.html": "", "public/b/y.html": "", "public/c/z.html": "", "public/.hidden/h.html": "", "public/node_modules/m.html": "", "elsewhere/l.html": "" });
  symlinkSync(join(dir, "elsewhere"), join(dir, "public/linked"));
  const all = walkFiles(dir, "public", (n) => n.endsWith(".html"));
  assert.deepEqual([all.files.map((f) => [f.rel, f.depth]), all.capped], [[["public/a/x.html", 1], ["public/b/y.html", 1], ["public/c/z.html", 1]], false]);
  const capped = walkFiles(dir, "public", (n) => n.endsWith(".html"), 2);
  assert.deepEqual([capped.files.map((f) => f.rel), capped.capped], [["public/a/x.html"], true]);
});

// ---- A Vite build's outDir, heads from partials ----

const VITE_CLIENT = (config) => app(HBS_APP("app.use(express.static(path.join(__dirname, 'public')));"), {
  "public/index.html": STATIC_HTML, "client/index.html": STATIC_HTML, "client/vite.config.js": config,
  "client/package.json": JSON.stringify({ scripts: { build: "vite build" }, devDependencies: { vite: "^6.0.0" } }),
});

test("a Vite build's outDir written with __dirname or import.meta.url is followed; one the wizard cannot read is a step by hand, never an edit", () => {
  for (const config of [
    "import path from 'node:path';\nexport default { build: { outDir: path.resolve(__dirname, '../public') } }\n",
    "import { fileURLToPath, URL } from 'node:url';\nexport default { build: { outDir: fileURLToPath(new URL('../public', import.meta.url)) } }\n",
    "import { defineConfig } from 'vite';\nexport default defineConfig({ root: 'src', build: { outDir: '../../public', emptyOutDir: true } })\n",
  ]) {
    const v = express.detect(...[VITE_CLIENT(config)].flatMap((x) => [x, x]));
    assert.deepEqual(v.data.pages.files, [], config);
    assert.match(v.data.pages.manual.find((m) => m.file === "public/").reason, /^public\/ is where the Vite build of client\/vite\.config\.js writes/, config);
  }
  for (const config of [
    "export default { build: { outDir: process.env.OUT_DIR ?? '../public' } }\n",
    "import { mergeConfig } from 'vite';\nimport base from './base.js';\nexport default mergeConfig(base, { build: { outDir: '../public' } })\n",
  ]) {
    const v = express.detect(...[VITE_CLIENT(config)].flatMap((x) => [x, x]));
    assert.deepEqual(v.data.pages.files, [], config);
    assert.match(v.data.pages.manual.find((m) => m.file === "public/").reason, /^The wizard could not read where client\/vite\.config\.js builds to/, config);
  }
  // A build that writes elsewhere leaves public/ to the wizard.
  assert.deepEqual(express.detect(...[VITE_CLIENT("export default { build: { outDir: 'dist' } }\n")].flatMap((x) => [x, x])).data.pages.files, ["public/index.html"]);
  const read = (files) => (rel) => files[rel] ?? null;
  const exists = (files) => (rel) => rel in files;
  const of = (text) => viteOutDir(read({ "vite.config.ts": text }), exists({ "vite.config.ts": text }));
  assert.deepEqual(of("export default { root: 'web', build: { outDir: 'out' } }\n"), { file: "vite.config.ts", outDir: "web/out" });
  assert.deepEqual(of("export default { root: 'web', build: { outDir: path.join(__dirname, 'out') } }\n"), { file: "vite.config.ts", outDir: "out" }, "a path from the config's folder ignores root, as path.resolve(root, outDir) does");
  assert.deepEqual(of("export default { build: { outDir: '/srv/www' } }\n"), { file: "vite.config.ts", outDir: "unknown" });
  assert.equal(viteOutDir(read({}), exists({})), null);
  // The same forms for Express's own static folder (an ES module app).
  const esm = app(HBS_APP("import { fileURLToPath } from 'node:url';\napp.use(express.static(fileURLToPath(new URL('./public', import.meta.url))));"), { "public/index.html": STATIC_HTML });
  assert.deepEqual(pagesOf(esm).files, ["public/index.html"]);
});

test("a page whose <head> comes from a partial the wizard tags is covered (a note, no step); one it cannot follow stays a step", () => {
  const head = "<head>\n  <meta charset=\"utf-8\">\n  <title><%= title %></title>\n</head>\n";
  const page = "<!DOCTYPE html>\n<html>\n<%- include('partials/head') %>\n<body>\n  <h1>x</h1>\n</body>\n</html>\n";
  const dir = expressApp("ejs", { "views/partials/head.ejs": head, "views/index.ejs": page, "views/about.ejs": page });
  const d = express.detect(dir, dir);
  const note = "views/about.ejs, views/index.ejs: covered through views/partials/head.ejs, which holds their <head> and the tag.";
  assert.deepEqual([d.data.pages.files, d.data.pages.manual, d.data.pages.notes], [["views/partials/head.ejs"], [], [note]]);
  assert.ok(d.notes.includes(note), "said in the report");
  const plan = express.plan(d, planInput(dir));
  assert.deepEqual(plan.manual.filter((m) => m.part === "browser"), [], "no step by hand");
  assert.deepEqual(plan.changes.map((c) => c.path), ["app.js", "views/partials/head.ejs"]);
  // A second run: the partial already has the wizard's tag; the pages are still covered.
  for (const c of plan.changes) writeFileSync(join(dir, c.path), c.after);
  assert.deepEqual(express.detect(dir, dir).data.pages.notes, [note]);
  assert.deepEqual(express.plan(express.detect(dir, dir), planInput(dir)).manual, []);
  // Handlebars: a layout whose head is the {{> head}} partial (hbs and express-handlebars look in views/partials/).
  const hbs = expressApp("hbs", { "views/partials/head.hbs": "<head>\n  <title>{{title}}</title>\n</head>\n", "views/layout.hbs": "<!DOCTYPE html>\n<html>\n{{> head}}\n<body>{{{body}}}</body>\n</html>\n" });
  const h = pagesOf(hbs);
  assert.deepEqual([h.files, h.manual, h.notes], [["views/partials/head.hbs"], [], ["views/layout.hbs: covered through views/partials/head.hbs, which holds its <head> and the tag."]]);
  // Through a partial that includes the head partial; Pug's include.
  const nested = pagesOf(expressApp("ejs", { "views/partials/head.ejs": head, "views/partials/top.ejs": "<%- include('head') %>\n", "views/index.ejs": "<!DOCTYPE html>\n<html>\n<%- include('partials/top') %>\n<body></body>\n</html>\n" }));
  assert.deepEqual([nested.manual, nested.notes], [[], ["views/index.ejs: covered through views/partials/head.ejs, which holds its <head> and the tag."]]);
  const pug = pagesOf(expressApp("pug", { "views/includes/head.pug": "head\n  title x\n", "views/index.pug": "doctype html\nhtml\n  include includes/head\n  body\n" }));
  assert.deepEqual([pug.files, pug.manual, pug.notes], [["views/includes/head.pug"], [], ["views/index.pug: covered through views/includes/head.pug, which holds its <head> and the tag."]]);
  // Not covered: a partial named in code, or a head partial past the cap (not tagged).
  const dynamic = pagesOf(expressApp("ejs", { "views/partials/head.ejs": head, "views/index.ejs": "<!DOCTYPE html>\n<html>\n<%- include(headFile) %>\n<body></body>\n</html>\n" }));
  assert.deepEqual([dynamic.notes, dynamic.manual.map((m) => m.file)], [[], ["views/index.ejs"]]);
  const capped = pagesOf(expressApp("ejs", { "views/partials/head.ejs": head, "views/index.ejs": page, ...Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`views/p${i}.ejs`, EJS_PAGE])) }));
  assert.deepEqual(capped.notes, []);
  assert.deepEqual(capped.manual.map((m) => m.file), ["views/index.ejs", "views/"]);
});

test("hbs registers .html partials too: a tag pasted in views/partials/a.html means no second tag", () => {
  const p = pagesOf(expressApp("hbs", { "views/layout.hbs": LAYOUT_HBS, "views/partials/a.html": `${TAG}\n` }));
  assert.deepEqual(p.files, []);
  assert.deepEqual(p.warnings, ["views/partials/a.html: A Parlox tag is already in this file, on line 1; it was left as it is, and the wizard adds no tag to the other views in views/, which may show it."]);
  // Another engine does not read .html files in its views folder: they are not its templates.
  assert.deepEqual(pagesOf(expressApp("ejs", { "views/index.ejs": EJS_PAGE, "views/partials/a.html": `${TAG}\n` })).files, ["views/index.ejs"]);
});
