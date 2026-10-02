import { test } from "node:test";
import assert from "node:assert/strict";
import { addBrowser, removeBrowser } from "../dist/edits/browser.js";
import { parse } from "../dist/edits/parse.js";
import { linesPreserved } from "./helpers.mjs";

const PK = "pk_" + "a1".repeat(12);
const layout = `import "./globals.css";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
`;

// A realistic layout: multiple imports (one type-only), a typed Metadata export, a leading comment, a JSX
// comment inside the body, and a <body> whose last child is the whitespace text before `</body>` — the shape
// that exposed the blank-line bug.
const realisticLayout = `import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Acme",
};

// Root layout: header, content, footer.
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header/>
        {/* nav placeholder */}
        {children}
        <footer>&copy; 2026 Acme</footer>
      </body>
    </html>
  );
}
`;

test("layout: import added after the last import, component is the body's last child", () => {
  const r = addBrowser(layout, "app/layout.tsx", "layout", PK);
  assert.equal(r.ok, true);
  assert.equal(r.changed, true);
  assert.match(r.code, /import "\.\/globals\.css";\nimport \{ ParloxAnalytics \} from "@parlox\/browser\/react";/);
  assert.match(r.code, /\{children\}\s*<ParloxAnalytics publicKey="pk_a1a1[a1]*" \/>\s*<\/body>/);
});

test("running it twice changes nothing the second time", () => {
  const once = addBrowser(layout, "app/layout.tsx", "layout", PK);
  const twice = addBrowser(once.code, "app/layout.tsx", "layout", PK);
  assert.equal(twice.ok, true);
  assert.equal(twice.changed, false);
  assert.equal(twice.code, once.code);
});

test("an existing install with another key is reported, not duplicated", () => {
  const once = addBrowser(layout, "app/layout.tsx", "layout", PK);
  const other = addBrowser(once.code, "app/layout.tsx", "layout", "pk_" + "b2".repeat(12));
  assert.equal(other.ok, false);
  assert.match(other.reason, /already/);
});

test("_app: the page is wrapped in a fragment with the component first", () => {
  const app = `export default function App({ Component, pageProps }) {\n  return <Component {...pageProps} />;\n}\n`;
  const r = addBrowser(app, "pages/_app.jsx", "app", PK);
  assert.equal(r.ok, true);
  assert.match(r.code, /<>\s*<ParloxAnalytics publicKey="[^"]+" \/>\s*<Component \{\.\.\.pageProps\} \/>\s*<\/>/);
});

test("a layout without a <body> element in this file falls back to a snippet", () => {
  const noBody = `import { Shell } from "./shell";\nexport default function RootLayout({ children }) { return <Shell>{children}</Shell>; }\n`;
  const r = addBrowser(noBody, "app/layout.jsx", "layout", PK);
  assert.equal(r.ok, false);
  assert.match(r.snippet, /import \{ ParloxAnalytics \} from "@parlox\/browser\/react";/);
});

test("a file that does not parse falls back to a snippet", () => {
  const r = addBrowser("export default function (", "app/layout.tsx", "layout", PK);
  assert.equal(r.ok, false);
  assert.match(r.reason, /could not read/i);
});

test("an invalid public key is refused before any edit", () => {
  assert.throws(() => addBrowser(layout, "app/layout.tsx", "layout", 'pk_x" onload="alert(1)'), /public key/);
});

test("parser plugins follow the file type: a <T> cast parses in .ts, JSX parses in .js", () => {
  assert.doesNotThrow(() => parse("const x = <string>y;\n", "proxy.ts"));
  assert.doesNotThrow(() => parse("export default () => <div />;\n", "app/layout.js"));
});

test("remove takes out exactly the component and its import", () => {
  const added = addBrowser(layout, "app/layout.tsx", "layout", PK).code;
  const r = removeBrowser(added, "app/layout.tsx");
  assert.equal(r.ok, true);
  assert.equal(r.changed, true);
  assert.doesNotMatch(r.code, /Parlox/);
  assert.match(r.code, /<body className="antialiased">\{children\}\s*<\/body>/);
  const app = addBrowser(`export default function App({ Component, pageProps }) {\n  return <Component {...pageProps} />;\n}\n`, "pages/_app.jsx", "app", PK).code;
  const back = removeBrowser(app, "pages/_app.jsx");
  assert.doesNotMatch(back.code, /Parlox|<>/);
  assert.match(back.code, /return <Component \{\.\.\.pageProps\} \/>;/);
  assert.equal(removeBrowser(layout, "app/layout.tsx").changed, false);
});

test("a realistic layout: the component lands on its own line after the footer, with the footer's own indentation, no blank line", () => {
  const r = addBrowser(realisticLayout, "app/layout.tsx", "layout", PK);
  assert.equal(r.ok, true);
  assert.match(r.code, /<footer>&copy; 2026 Acme<\/footer>\n        <ParloxAnalytics publicKey="[^"]+" \/>\n      <\/body>/);
});

test("add then remove restores a realistic layout and the bare layout exactly, byte for byte", () => {
  const addedRealistic = addBrowser(realisticLayout, "app/layout.tsx", "layout", PK).code;
  assert.equal(removeBrowser(addedRealistic, "app/layout.tsx").code, realisticLayout);

  const addedBare = addBrowser(layout, "app/layout.tsx", "layout", PK).code;
  assert.equal(removeBrowser(addedBare, "app/layout.tsx").code, layout);
});

test("running it twice on a realistic layout changes nothing the second time", () => {
  const once = addBrowser(realisticLayout, "app/layout.tsx", "layout", PK);
  const twice = addBrowser(once.code, "app/layout.tsx", "layout", PK);
  assert.equal(twice.ok, true);
  assert.equal(twice.changed, false);
  assert.equal(twice.code, once.code);
});

// Whitespace-preservation: recast can fall back to reprinting a whole touched node with its own
// defaults (4-space indent, LF), which would turn every line of a tab-indented or CRLF file into a
// diff even though only Parlox's lines changed. print() must carry the source's own style through.

test("tab-indented realistic layout: only added lines change, and add then remove is byte for byte", () => {
  const tabLayout = realisticLayout.replace(/^( {2})+/gm, (m) => "\t".repeat(m.length / 2));
  const added = addBrowser(tabLayout, "app/layout.tsx", "layout", PK);
  assert.equal(added.ok, true);
  assert.equal(linesPreserved(tabLayout, added.code), true);
  assert.match(added.code, /\n\t\t\t\t<footer>&copy; 2026 Acme<\/footer>\n\t\t\t\t<ParloxAnalytics publicKey="[^"]+" \/>\n\t\t\t<\/body>/);
  assert.equal(removeBrowser(added.code, "app/layout.tsx").code, tabLayout);
});

test("CRLF realistic layout: only added lines change, and add then remove is byte for byte", () => {
  const crlfLayout = realisticLayout.replace(/\n/g, "\r\n");
  const added = addBrowser(crlfLayout, "app/layout.tsx", "layout", PK);
  assert.equal(added.ok, true);
  assert.equal(linesPreserved(crlfLayout, added.code), true);
  assert.match(added.code, /\r\n {8}<footer>&copy; 2026 Acme<\/footer>\r\n {8}<ParloxAnalytics publicKey="[^"]+" \/>\r\n {6}<\/body>/);
  assert.equal(removeBrowser(added.code, "app/layout.tsx").code, crlfLayout);
});

// A hand-written guard: the element's immediate parent in the AST is the LogicalExpression's `right`
// operand, not a JSXElement/JSXFragment, since the whole `{cond && <Tag/>}` sits inside one JSXExpressionContainer.
const guardedLayout = `import { ParloxAnalytics } from "@parlox/browser/react";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="antialiased">
        {children}
        {process.env.NODE_ENV === "production" && <ParloxAnalytics publicKey="${PK}" />}
      </body>
    </html>
  );
}
`;

test("removeBrowser on a hand-written {cond && <ParloxAnalytics />} guard returns ok:false instead of throwing", () => {
  let r;
  assert.doesNotThrow(() => { r = removeBrowser(guardedLayout, "app/layout.tsx"); });
  assert.equal(r.ok, false);
  assert.match(r.snippet ?? "", /by hand/i);
});

test("addBrowser treats that same hand-written guard, with the matching key, as already installed", () => {
  const r = addBrowser(guardedLayout, "app/layout.tsx", "layout", PK);
  assert.equal(r.ok, true);
  assert.equal(r.changed, false);
});

test("two <body> elements in one file: refuses rather than guessing which one to use", () => {
  const twoBodies = `export default function Weird({ children }) {\n  return (\n    <>\n      <body>{children}</body>\n      <body>oops</body>\n    </>\n  );\n}\n`;
  const r = addBrowser(twoBodies, "app/layout.jsx", "layout", PK);
  assert.equal(r.ok, false);
  assert.match(r.snippet, /import \{ ParloxAnalytics \} from "@parlox\/browser\/react";/);
});
