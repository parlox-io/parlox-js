import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { detectApp, findNextApps, findRoot, DetectError } from "../dist/detect.js";
import { fixture, pkg } from "./helpers.mjs";

const layout = "export default function RootLayout({ children }) { return <html><body>{children}</body></html>; }\n";
const code = (fn) => { try { fn(); return "ok"; } catch (e) { assert.ok(e instanceof DetectError, String(e)); return e.code; } };

test("Next 16 App Router, TypeScript, no middleware: target proxy.ts", () => {
  const dir = fixture({ "package.json": pkg(), "package-lock.json": "{}", "tsconfig.json": "{}", "app/layout.tsx": layout });
  const a = detectApp(dir);
  assert.deepEqual({ ...a, dir: undefined, root: undefined }, { dir: undefined, root: undefined, nextMajor: 16, typescript: true, srcDir: false, packageManager: "npm", layoutFile: "app/layout.tsx", appFile: null, middlewareFile: null, middlewareTarget: "proxy.ts" });
});

test("Next 15 with src/, JavaScript, existing middleware.js, pnpm", () => {
  const dir = fixture({ "package.json": pkg({ next: "^15.3.0" }), "pnpm-lock.yaml": "", "src/app/layout.js": layout, "src/middleware.js": "export function middleware() {}\n" });
  const a = detectApp(dir);
  assert.equal(a.nextMajor, 15);
  assert.equal(a.srcDir, true);
  assert.equal(a.typescript, false);
  assert.equal(a.packageManager, "pnpm");
  assert.equal(a.layoutFile, "src/app/layout.js");
  assert.equal(a.middlewareFile, "src/middleware.js");
  assert.equal(a.middlewareTarget, "src/middleware.js");
});

test("the installed next version wins over the range; the packageManager field wins over lockfiles", () => {
  const dir = fixture({ "package.json": pkg({ next: "latest" }, { packageManager: "pnpm@9.15.0" }), "yarn.lock": "", "node_modules/next/package.json": JSON.stringify({ name: "next", version: "16.1.0" }), "app/layout.jsx": layout });
  const a = detectApp(dir);
  assert.equal(a.nextMajor, 16);
  assert.equal(a.packageManager, "pnpm");
});

test("an unknown next version is refused rather than guessed", () => {
  assert.equal(code(() => detectApp(fixture({ "package.json": pkg({ next: "latest" }), "package-lock.json": "{}", "app/layout.tsx": layout }))), "unknown-next");
});

test("Pages Router: _app is the browser entry", () => {
  const dir = fixture({ "package.json": pkg({ next: "14.2.0" }), "bun.lock": "", "pages/_app.tsx": "export default function App({ Component, pageProps }) { return <Component {...pageProps} />; }\n", "tsconfig.json": "{}" });
  const a = detectApp(dir);
  assert.equal(a.appFile, "pages/_app.tsx");
  assert.equal(a.layoutFile, null);
  assert.equal(a.packageManager, "bun");
  assert.equal(a.middlewareTarget, "middleware.ts");
});

test("an existing proxy.ts is used on Next 16", () => {
  const dir = fixture({ "package.json": pkg(), "package-lock.json": "{}", "app/layout.tsx": layout, "proxy.ts": "export default function proxy() {}\n", "tsconfig.json": "{}" });
  assert.equal(detectApp(dir).middlewareFile, "proxy.ts");
});

test("Next 15 with both src/proxy.ts and src/middleware.ts: middleware.ts is used (proxy.* only runs starting Next 16)", () => {
  const dir = fixture({
    "package.json": pkg({ next: "15.3.0" }), "package-lock.json": "{}", "tsconfig.json": "{}",
    "src/app/layout.tsx": layout, "src/proxy.ts": "export default function proxy() {}\n", "src/middleware.ts": "export function middleware() {}\n",
  });
  assert.equal(detectApp(dir).middlewareFile, "src/middleware.ts");
});

test("Next 15 with only proxy.ts: not treated as the middleware file, since it never runs on 15", () => {
  const dir = fixture({
    "package.json": pkg({ next: "15.3.0" }), "package-lock.json": "{}", "tsconfig.json": "{}",
    "app/layout.tsx": layout, "proxy.ts": "export default function proxy() {}\n",
  });
  const a = detectApp(dir);
  assert.equal(a.middlewareFile, null);
  assert.match(a.middlewareTarget, /^middleware\.(ts|js)$/);
});

test("Next 16 with both proxy.ts and middleware.ts: proxy.ts is preferred", () => {
  const dir = fixture({
    "package.json": pkg({ next: "16.0.1" }), "package-lock.json": "{}", "tsconfig.json": "{}",
    "app/layout.tsx": layout, "proxy.ts": "export default function proxy() {}\n", "middleware.ts": "export function middleware() {}\n",
  });
  assert.equal(detectApp(dir).middlewareFile, "proxy.ts");
});

test("refusals", () => {
  assert.equal(code(() => detectApp(fixture({ "README.md": "" }))), "no-package-json");
  assert.equal(code(() => detectApp(fixture({ "package.json": pkg({ react: "19.0.0" }) }))), "not-next");
  assert.equal(code(() => detectApp(fixture({ "package.json": pkg({ next: "12.3.0" }), "package-lock.json": "{}", "pages/_app.js": "" }))), "old-next");
  assert.equal(code(() => detectApp(fixture({ "package.json": pkg(), "package-lock.json": "{}", "yarn.lock": "", "app/layout.tsx": layout }))), "lockfiles");
  assert.equal(code(() => detectApp(fixture({ "package.json": pkg(), "package-lock.json": "{}" }))), "no-entry");
});

test("monorepo started inside apps/web: root, lockfile and hoisted next are found at the workspace root", () => {
  const root = fixture({
    "package.json": JSON.stringify({ name: "mono", private: true }),
    "pnpm-workspace.yaml": "packages:\n  - 'apps/*'\n  - 'packages/*'\n",
    "pnpm-lock.yaml": "",
    "node_modules/next/package.json": JSON.stringify({ name: "next", version: "15.5.0" }),
    "apps/web/package.json": pkg({ next: "catalog:" }), "apps/web/app/layout.tsx": layout,
    "apps/admin/package.json": pkg(), "apps/admin/app/layout.tsx": layout,
    "packages/ui/package.json": pkg({ react: "19.0.0" }),
  });
  const web = join(root, "apps", "web");
  assert.equal(findRoot(web), root);
  assert.deepEqual(findNextApps(root).sort(), ["apps/admin", "apps/web"]);
  const a = detectApp(web, findRoot(web));
  assert.equal(a.packageManager, "pnpm");
  assert.equal(a.nextMajor, 15);
  assert.equal(a.middlewareTarget, "middleware.js");
});

test("a single app lists itself; a workspace pattern leaving the root is ignored", () => {
  assert.deepEqual(findNextApps(fixture({ "package.json": pkg(), "package-lock.json": "{}", "app/layout.tsx": layout })), ["."]);
  const root = fixture({ "package.json": JSON.stringify({ name: "m", workspaces: ["../*", "apps/*"] }), "package-lock.json": "{}", "apps/web/package.json": pkg(), "apps/web/app/layout.tsx": layout });
  assert.deepEqual(findNextApps(root), ["apps/web"]);
});
