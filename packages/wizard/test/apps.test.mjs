import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { scanApps, selectUnits, describeUnit, unitFacts } from "../dist/apps.js";
import { nextjs } from "../dist/integrations/nextjs.js";
import { findRoot, pnpmPackages } from "../dist/workspace.js";
import { DetectError } from "../dist/detect.js";
import { fixture, pkg } from "./helpers.mjs";

const layout = "export default function RootLayout({ children }) { return <html><body>{children}</body></html>; }\n";
const next = (extra = {}) => ({ "package.json": pkg(), "app/layout.tsx": layout, ...extra });
const nested = (prefix, files) => Object.fromEntries(Object.entries(files).map(([k, v]) => [`${prefix}/${k}`, v]));
const noQuestion = { multiselect: async () => { throw new Error("no question expected"); } };

test("a single app: one unit, no question", async () => {
  const dir = fixture({ ...next(), "package-lock.json": "{}" });
  const scan = scanApps(dir);
  assert.deepEqual(scan.units.map((u) => u.rel), ["."]);
  assert.equal(scan.units[0].browser.integration, "nextjs");
  assert.equal(scan.units[0].server, scan.units[0].browser);
  assert.equal((await selectUnits(scan, [], noQuestion, "install")).length, 1);
});

test("a workspace root: the root and every package are looked at; apps come sorted; a package that is not an app is left out", () => {
  const root = fixture({
    "package.json": JSON.stringify({ name: "m", private: true, workspaces: ["apps/*", "packages/*"] }), "package-lock.json": "{}",
    ...nested("apps/web", next()), ...nested("apps/shop", next()), "packages/ui/package.json": pkg({ react: "19.0.0" }),
  });
  assert.deepEqual(scanApps(root).units.map((u) => u.rel), ["apps/shop", "apps/web"]);
});

test("started inside one package of a monorepo: only that package, as before", () => {
  const root = fixture({ "package.json": JSON.stringify({ name: "m", private: true, workspaces: ["apps/*"] }), "package-lock.json": "{}", ...nested("apps/web", next()), ...nested("apps/shop", next()) });
  const scan = scanApps(join(root, "apps", "web"));
  assert.deepEqual(scan.units.map((u) => u.rel), ["."]);
  assert.equal(scan.root, root);
});

test("several apps: a multi-select with every app selected; the answer picks the units", async () => {
  const root = fixture({ "package.json": JSON.stringify({ name: "m", private: true, workspaces: ["apps/*"] }), "package-lock.json": "{}", ...nested("apps/web", next()), ...nested("apps/shop", next()) });
  const asked = [];
  const ui = { multiselect: async (m, options, hint) => { asked.push({ m, options, hint }); return ["apps/web"]; } };
  const chosen = await selectUnits(scanApps(root), [], ui, "install");
  assert.deepEqual(chosen.map((u) => u.rel), ["apps/web"]);
  assert.equal(asked[0].m, "Which apps should Parlox be installed in?");
  assert.deepEqual(asked[0].options.map((o) => o.value), ["apps/shop", "apps/web"]);
  assert.deepEqual(asked[0].options.map((o) => o.label), ["apps/shop/ · Next.js · browser and server parts", "apps/web/ · Next.js · browser and server parts"]);
  assert.equal(asked[0].hint, "Run it from the app's own folder, or pass --app <folder> for each app to include (apps/shop, apps/web).");
  await selectUnits(scanApps(root), [], ui, "uninstall");
  assert.equal(asked[1].m, "Which apps should Parlox be removed from?");
});

test("--app picks apps without a question, in the order given, however the folder is written; an unknown folder is refused with the list", async () => {
  const root = fixture({ "package.json": JSON.stringify({ name: "m", private: true, workspaces: ["apps/*"] }), "package-lock.json": "{}", ...nested("apps/web", next()), ...nested("apps/shop", next()) });
  const scan = scanApps(root);
  assert.deepEqual((await selectUnits(scan, ["./apps/web/", "apps/shop", "apps/web"], noQuestion, "install")).map((u) => u.rel), ["apps/web", "apps/shop"]);
  await assert.rejects(selectUnits(scan, ["apps/admin"], noQuestion, "install"), (e) => e instanceof DetectError && e.code === "app-not-found" && /Apps found: apps\/shop, apps\/web\./.test(e.message));
  await assert.rejects(selectUnits(scan, ["../outside"], noQuestion, "install"), (e) => e instanceof DetectError && e.code === "app-not-found");
});

test("nothing found: the one app's own refusal as before; no package.json; a stack the wizard does not cover", async () => {
  const old = fixture({ "package.json": pkg({ next: "12.3.0" }), "package-lock.json": "{}", "pages/_app.js": "" });
  await assert.rejects(selectUnits(scanApps(old), [], noQuestion, "install"), (e) => e.code === "old-next");
  await assert.rejects(selectUnits(scanApps(fixture({ "README.md": "" })), [], noQuestion, "install"), (e) => e.code === "no-package-json");
  await assert.rejects(selectUnits(scanApps(fixture({ "package.json": pkg({ lodash: "4.0.0" }) })), [], noQuestion, "install"), (e) => e.code === "not-supported" && /Next\.js/.test(e.message));
  const emptyMono = fixture({ "package.json": JSON.stringify({ name: "m", workspaces: ["apps/*"] }), "apps/a/package.json": pkg({ lodash: "4.0.0" }) });
  await assert.rejects(selectUnits(scanApps(emptyMono), [], noQuestion, "install"), (e) => e.code === "no-app");
});

test("facts: one app shows its integration's own lines; several apps show one line each", () => {
  const dir = fixture({ ...next(), "package-lock.json": "{}", "tsconfig.json": "{}" });
  const [u] = scanApps(dir).units;
  assert.deepEqual(unitFacts(u, true), [["Found", "Next.js 16 · App Router · TypeScript · npm"]]);
  assert.deepEqual(unitFacts(u, false), [["App", describeUnit(u)]]);
  assert.equal(describeUnit(u), "./ · Next.js · browser and server parts");
});

// create-hono and pnpm 10 write a pnpm-workspace.yaml that holds settings only.
test("a pnpm-workspace.yaml without packages: is not a workspace root; its settings are not package globs", () => {
  assert.deepEqual(pnpmPackages("onlyBuiltDependencies:\n  - esbuild\n  - workerd\nallowBuilds:\n  esbuild: true\n"), []);
  assert.deepEqual(pnpmPackages("packages:\n  - 'apps/*'\n  - \"packages/*\" # libs\nonlyBuiltDependencies:\n  - esbuild\n"), ["apps/*", "packages/*"]);
  assert.deepEqual(pnpmPackages("packages:\n- apps/*\n- tools/cli\n"), ["apps/*", "tools/cli"]);
  assert.deepEqual(pnpmPackages("packages: ['apps/*', 'libs/*']\n"), ["apps/*", "libs/*"]);
  const root = fixture({
    "package.json": JSON.stringify({ name: "m", private: true }), "pnpm-workspace.yaml": "packages:\n  - 'apps/*'\n", "pnpm-lock.yaml": "",
    ...nested("apps/web", { ...next(), "pnpm-workspace.yaml": "onlyBuiltDependencies:\n  - esbuild\n" }),
  });
  const web = join(root, "apps", "web");
  assert.equal(findRoot(web), root, "the app's settings-only file does not stop the search");
  const [u] = scanApps(web).units;
  assert.equal(u.root, root);
  assert.equal(u.browser.packageManager, "pnpm", "the monorepo's lockfile is found");
});

// The file is read with a YAML parser (the `yaml` package), so every valid way of writing the list counts.
const pnpmMono = (workspaceYaml) => fixture({
  "package.json": JSON.stringify({ name: "m", private: true }), "pnpm-workspace.yaml": workspaceYaml, "pnpm-lock.yaml": "",
  ...nested("apps/web", next()), ...nested("apps/shop", next()),
});

test("pnpm-workspace.yaml: a flow list over several lines, a byte-order mark and a quoted key are all read; run from apps/web, pnpm and the monorepo's root are found", () => {
  for (const text of ["packages: [\n  'apps/*'\n]\n", "﻿packages:\n  - 'apps/*'\n", "\"packages\":\n  - \"apps/*\"\n"]) {
    assert.deepEqual(pnpmPackages(text), ["apps/*"], JSON.stringify(text));
    const root = pnpmMono(text);
    const web = join(root, "apps", "web");
    assert.equal(findRoot(web), root, JSON.stringify(text));
    const [u] = scanApps(web).units;
    assert.equal(u.root, root);
    assert.equal(u.browser.packageManager, "pnpm", JSON.stringify(text));
    assert.deepEqual(scanApps(root).units.map((x) => x.rel), ["apps/shop", "apps/web"], JSON.stringify(text));
  }
});

// pnpm 9.15.0, observed: with `packages: []` at the root, `pnpm install` run in apps/web writes apps/web/pnpm-lock.yaml;
// apps/web is not a package of that workspace.
test("pnpm-workspace.yaml with an empty packages list: not a workspace root, like a settings-only file", () => {
  assert.deepEqual(pnpmPackages("packages: []\n"), []);
  const root = pnpmMono("packages: []\n");
  const web = join(root, "apps", "web");
  assert.equal(findRoot(web), web);
  assert.equal(scanApps(web).units[0].root, web);
  assert.deepEqual(scanApps(root).units, []);
});

test("a pnpm-workspace.yaml that does not parse is refused, naming the file and giving the parser's message; nothing is guessed", () => {
  const root = pnpmMono("packages:\n  - 'apps/*\n");
  const file = join(root, "pnpm-workspace.yaml");
  const refused = (e) => e instanceof DetectError && e.code === "workspace-file" && e.message.includes(file) && /Missing closing 'quote at line \d+, column \d+/.test(e.message) && !e.message.includes("\n");
  assert.throws(() => findRoot(join(root, "apps", "web")), refused);
  assert.throws(() => scanApps(join(root, "apps", "web")), refused);
  assert.throws(() => scanApps(root), refused);
  assert.throws(() => pnpmPackages("packages: [apps/*\n"), (e) => e instanceof DetectError && e.code === "workspace-file" && e.message.startsWith("pnpm-workspace.yaml"));
});

test("--app started inside one package: the list of apps found names it ./", async () => {
  const root = fixture({ "package.json": JSON.stringify({ name: "m", private: true, workspaces: ["apps/*"] }), "package-lock.json": "{}", ...nested("apps/web", next()) });
  const scan = scanApps(join(root, "apps", "web"));
  await assert.rejects(selectUnits(scan, ["apps/admin"], noQuestion, "install"), (e) => e.code === "app-not-found" && e.message.endsWith("Apps found: ./."));
});

test("a UI that answers with no app, or with apps that were not offered, is refused: a run never goes on with nothing selected", async () => {
  const root = fixture({ "package.json": JSON.stringify({ name: "m", private: true, workspaces: ["apps/*"] }), "package-lock.json": "{}", ...nested("apps/web", next()), ...nested("apps/shop", next()) });
  const scan = scanApps(root);
  for (const answer of [[], ["apps/admin"]]) {
    await assert.rejects(selectUnits(scan, [], { multiselect: async () => answer }, "install"), (e) => e instanceof DetectError && e.code === "declined" && /No app was chosen/.test(e.message), JSON.stringify(answer));
  }
});

test("a refusal beside a match is kept as a warning on the app, in either order and beside Next.js; alone it is the folder's problem, as before", () => {
  const dir = fixture({ ...next(), "package-lock.json": "{}" });
  const refuses = { id: "express", label: "Express", detect: () => { throw new DetectError("not-supported", "NestJS is not covered by the wizard."); } };
  const matches = { id: "hono", label: "Hono", detect: (d, r) => ({ ...nextjs.detect(d, r), integration: "hono" }) };
  for (const order of [[refuses, matches], [matches, refuses]]) {
    const [u] = scanApps(dir, order).units;
    assert.deepEqual(u.detections.map((d) => d.integration), ["hono"]);
    assert.deepEqual(u.warnings, ["Express: NestJS is not covered by the wizard."]);
  }
  const [withNext] = scanApps(dir, [refuses, nextjs]).units;
  assert.equal(withNext.browser.integration, "nextjs");
  assert.deepEqual(withNext.warnings, ["Express: NestJS is not covered by the wizard."]);
  assert.deepEqual(scanApps(dir).units[0].warnings, []);
  const alone = scanApps(dir, [refuses]);
  assert.deepEqual(alone.units, []);
  assert.equal(alone.problems[0].error.message, "NestJS is not covered by the wizard.");
});
