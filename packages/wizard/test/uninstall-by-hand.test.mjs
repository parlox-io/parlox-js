import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { render } from "ink-testing-library";
import { main } from "../dist/cli.js";
import { parloxIn, scanApps, unplanUnit } from "../dist/apps.js";
import { readInside } from "../dist/fs-safe.js";
import { App } from "../dist/tui/App.js";
import { WizardStore } from "../dist/tui/store.js";
import { summary } from "../dist/start.js";
import { BROWSER_VERSION, SERVER_VERSION } from "../dist/versions.js";
import { fixture, pkg, read, until } from "./helpers.mjs";

// An uninstall whose only finding is a step by hand (an env file the wizard does not change, a server file it may not
// read) lists the steps and never says "Removed"; in a run with several apps, that app is offered too.

const G = ["-c", "user.email=t@t", "-c", "user.name=t"];
const commit = (dir, msg) => { execFileSync("git", [...G, "add", "-A"], { cwd: dir }); execFileSync("git", [...G, "commit", "-qm", msg], { cwd: dir }); };
// An uninstall signs nothing in; the config only has to be a real one.
const config = { gateway: "http://127.0.0.1:9", supabaseUrl: "http://127.0.0.1:9", clientId: "wiz", apiKey: "k", ports: [53942, 53943], dashboard: "https://app.parlox.io" };
const API = {
  "package.json": JSON.stringify({ name: "api", type: "module", scripts: { dev: "node server.js" }, dependencies: { express: "^5.1.0", dotenv: "^17.0.0" } }),
  "server.js": "import 'dotenv/config'\nimport express from 'express'\n\nconst app = express()\napp.listen(3000)\n",
  // Committed to git (dotenvx's encrypted file, say), with the token added by hand: the wizard does not change it.
  ".env": "PORT=3000\nPARLOX_VERIFY_TOKEN=vt_fake\n",
};
function face() {
  const out = [], reports = [], asked = [];
  return { out, reports, asked, ui: { info: (m) => out.push(m), warn: (m) => out.push(`WARN ${m}`), confirm: async (m) => { asked.push(m); return true; }, select: async (_m, o) => o[0].value, text: async () => "", multiselect: async (m, o) => { asked.push(m); return o.map((x) => x.value); }, report: (lines, title) => reports.push({ lines, title }) } };
}
const STEP = "git tracks this file, so the wizard does not change it: remove the PARLOX_VERIFY_TOKEN line yourself.";

test("one app whose only finding is a step by hand: the step is listed, nothing is said to be removed", async () => {
  const dir = fixture({ "package-lock.json": "{}", ...API });
  execFileSync("git", [...G, "init", "-q"], { cwd: dir });
  commit(dir, "init");
  const f = face();
  assert.equal(await main(["uninstall", "--yes"], { cwd: dir, config, ui: f.ui, open: () => {}, run: () => ({ status: 0, stdout: "", stderr: "" }) }), 0, f.out.join("\n"));
  assert.ok(f.out.some((m) => m.startsWith(`WARN .env: ${STEP}`)), f.out.join("\n"));
  const report = f.reports.at(-1);
  assert.equal(report.title, "Steps by hand");
  assert.ok(report.lines.includes(`.env: ${STEP}`), report.lines.join("\n"));
  assert.equal(report.lines.some((l) => /Removed|Nothing from Parlox was found/.test(l)), false, report.lines.join("\n"));
  assert.equal(read(dir, ".env"), API[".env"]);
});

test("several apps, one with only a step by hand: it is offered, its step is listed, and only the other is said to be removed", async () => {
  const layout = "export default function RootLayout({ children }) {\n  return (\n    <html>\n      <body>{children}</body>\n    </html>\n  );\n}\n";
  const root = fixture({
    "package.json": JSON.stringify({ name: "mono", private: true, workspaces: ["apps/*"] }), "package-lock.json": "{}", ".gitignore": ".env*.local\n",
    ...Object.fromEntries(Object.entries(API).map(([f, c]) => [`apps/api/${f}`, c])),
    "apps/web/package.json": pkg({ next: "16.0.1", react: "19.0.0", "@parlox/browser": BROWSER_VERSION, "@parlox/server": SERVER_VERSION }),
    "apps/web/app/layout.tsx": layout, "apps/web/.env.local": "PARLOX_VERIFY_TOKEN=vt_fake\n",
  });
  execFileSync("git", [...G, "init", "-q"], { cwd: root });
  commit(root, "init");
  const f = face();
  const runs = [];
  assert.equal(await main(["uninstall", "--yes"], { cwd: root, config, ui: f.ui, open: () => {}, run: (cmd, args, o) => { runs.push([o.cwd, cmd, ...args]); return { status: 0, stdout: "", stderr: "" }; } }), 0, f.out.join("\n"));
  assert.deepEqual(f.asked, ["Which apps should Parlox be removed from?"]);
  assert.ok(f.out.some((m) => m.startsWith(`WARN apps/api/.env: ${STEP}`)), f.out.join("\n"));
  const lines = f.reports.at(-1).lines;
  assert.ok(lines.includes("apps/web: removed."), lines.join("\n"));
  assert.ok(lines.includes("apps/api: nothing removed; the steps by hand above are left to do."), lines.join("\n"));
  assert.equal(lines.some((l) => l.startsWith("Removed.")), false, lines.join("\n"));
  assert.deepEqual(runs.map((r) => r[0]), [join(root, "apps/web")]);
  assert.equal(read(root, "apps/api/.env"), API[".env"]);
});

// The full screen draws the report on its done card before anything is printed, so the card never points "above" to
// the steps by hand: they are printed, before the report, when the wizard closes.
const PARLOX_API = {
  ...API,
  "package.json": JSON.stringify({ name: "api", type: "module", scripts: { dev: "node server.js" }, dependencies: { express: "^5.1.0", dotenv: "^17.0.0", "@parlox/server": SERVER_VERSION } }),
  "server.js": "import 'dotenv/config'\nimport express from 'express'\nimport { parlox } from '@parlox/server/express'\n\nconst app = express()\napp.use(parlox())\napp.listen(3000)\n",
};
async function doneCard(store) {
  const { lastFrame, unmount } = render(createElement(App, { store }));
  try {
    await until(() => /Press Enter to finish/.test(lastFrame() ?? ""), "the done card");
    return lastFrame().replace(/\s*│\s*/g, " ").replace(/\s+/g, " ");
  } finally { unmount(); }
}

test("full screen: an uninstall's done card says the steps by hand are printed when the wizard closes, never 'above'; the summary prints them first", async () => {
  const dir = fixture({ "package-lock.json": "{}", ...PARLOX_API });
  execFileSync("git", [...G, "init", "-q"], { cwd: dir });
  commit(dir, "init");
  const store = new WizardStore(); store.start();
  assert.equal(await main(["uninstall", "--yes"], { cwd: dir, config, ui: store, open: () => {}, run: () => ({ status: 0, stdout: "", stderr: "" }) }), 0);
  assert.ok(store.getSnapshot().report.some((l) => l.startsWith("Removed, except the steps by hand")), store.getSnapshot().report.join("\n"));
  const card = await doneCard(store);
  assert.doesNotMatch(card, /above/);
  assert.match(card, /Removed, except the steps by hand \(printed when you close the wizard\)\./);
  // Printed after the screen is gone: the step comes before the report that points "above" to it.
  const printed = summary(store.getSnapshot(), 0);
  const step = printed.indexOf(`▲ .env: ${STEP}`);
  assert.ok(step >= 0 && step < printed.indexOf("Removed, except the steps by hand above."), printed);

  // Several apps: each app's line says the same.
  const root = fixture({
    "package.json": JSON.stringify({ name: "mono", private: true, workspaces: ["apps/*"] }), "package-lock.json": "{}",
    ...Object.fromEntries(Object.entries(API).map(([f, c]) => [`apps/api/${f}`, c])),
    ...Object.fromEntries(Object.entries(PARLOX_API).map(([f, c]) => [`apps/shop/${f}`, c])),
  });
  execFileSync("git", [...G, "init", "-q"], { cwd: root });
  commit(root, "init");
  const many = new WizardStore(); many.start();
  assert.equal(await main(["uninstall", "--yes", "--app", "apps/api", "--app", "apps/shop"], { cwd: root, config, ui: many, open: () => {}, run: () => ({ status: 0, stdout: "", stderr: "" }) }), 0);
  const cards = await doneCard(many);
  assert.doesNotMatch(cards, /above/);
  assert.match(cards, /apps\/api: nothing removed; the steps by hand \(printed when you close the wizard\) are left to do\./);
  assert.match(cards, /apps\/shop: removed, except the steps by hand \(printed when you close the wizard\)\./);
});

// An env file the wizard may not read (a link to a shared .env, common in monorepos) is a step by hand only if Parlox
// is in the app: a @parlox/* dependency, or a file the wizard read that holds Parlox's line. Otherwise there is nothing
// to remove, and the run says which file it could not read.
const NEVER = {
  "package.json": JSON.stringify({ name: "api", type: "module", scripts: { dev: "node server.js" }, dependencies: { express: "^5.1.0", dotenv: "^17.0.0" } }),
  "server.js": "import 'dotenv/config'\nimport express from 'express'\n\nconst app = express()\napp.listen(3000)\n",
};
const LINKED = "The wizard does not read or write this file (Refusing .env: it points outside the project folder): remove Parlox's lines from it yourself, if they are there.";
const linkEnv = (dir, to) => { writeFileSync(to, "PORT=3000\n"); symlinkSync(to, join(dir, ".env")); };

test("uninstall in an app that never had Parlox, whose .env is a link: nothing to remove, and the run names the file it could not read", { skip: process.platform === "win32" }, async () => {
  const shared = fixture({ "shared.env": "" });
  const dir = fixture({ "package-lock.json": "{}", ...NEVER });
  linkEnv(dir, join(shared, "shared.env"));
  execFileSync("git", [...G, "init", "-q"], { cwd: dir });
  commit(dir, "init");
  const f = face();
  assert.equal(await main(["uninstall", "--yes"], { cwd: dir, config, ui: f.ui, open: () => {}, run: () => { throw new Error("nothing runs"); } }), 0, f.out.join("\n"));
  const report = f.reports.at(-1);
  assert.equal(report.title, "Nothing to remove");
  assert.deepEqual(report.lines, ["Nothing from Parlox was found to remove.", `.env: ${LINKED}`]);
  assert.equal(f.out.some((m) => /Nothing was removed|Take it out by hand|steps by hand/.test(m)), false, f.out.join("\n"));
});

test("several apps, none ever had Parlox, one with a linked .env: no question, nothing to remove, and that file is named", { skip: process.platform === "win32" }, async () => {
  const root = fixture({
    "package.json": JSON.stringify({ name: "mono", private: true, workspaces: ["apps/*"] }), "package-lock.json": "{}", ".env": "PORT=3000\n",
    ...Object.fromEntries(Object.entries(NEVER).map(([f, c]) => [`apps/api/${f}`, c])),
    "apps/web/package.json": pkg(), "apps/web/app/layout.tsx": "export default function RootLayout({ children }) {\n  return <html><body>{children}</body></html>;\n}\n",
  });
  symlinkSync(join(root, ".env"), join(root, "apps/api/.env"));
  execFileSync("git", [...G, "init", "-q"], { cwd: root });
  commit(root, "init");
  const f = face();
  assert.equal(await main(["uninstall", "--yes"], { cwd: root, config, ui: f.ui, open: () => {}, run: () => { throw new Error("nothing runs"); } }), 0, f.out.join("\n"));
  assert.deepEqual(f.asked, []);
  const report = f.reports.at(-1);
  assert.equal(report.title, "Nothing to remove");
  assert.deepEqual(report.lines, ["Nothing from Parlox was found to remove.", `apps/api/.env: ${LINKED}`]);

  // Beside an app that has Parlox: only that one is offered and removed; the linked file is named all the same.
  const web = JSON.parse(read(root, "apps/web/package.json"));
  web.dependencies["@parlox/browser"] = BROWSER_VERSION;
  writeFileSync(join(root, "apps/web/package.json"), JSON.stringify(web));
  commit(root, "web has Parlox");
  const g = face();
  const runs = [];
  assert.equal(await main(["uninstall", "--yes"], { cwd: root, config, ui: g.ui, open: () => {}, run: (cmd, args, o) => { runs.push([o.cwd, cmd, ...args]); return { status: 0, stdout: "", stderr: "" }; } }), 0, g.out.join("\n"));
  assert.deepEqual(g.asked, [], "one app to remove from: nothing to choose");
  assert.deepEqual(runs.map((r) => r[0]), [join(root, "apps/web")]);
  const lines = g.reports.at(-1).lines;
  assert.ok(lines[0].startsWith("Removed."), lines.join("\n"));
  assert.ok(lines.includes(`apps/api/.env: ${LINKED}`), lines.join("\n"));

  // Named with --app, an app without Parlox is said to have nothing to remove, never "removed".
  const h = face();
  assert.equal(await main(["uninstall", "--yes", "--dry-run", "--app", "apps/api", "--app", "apps/web"], { cwd: root, config, ui: h.ui, open: () => {}, run: () => ({ status: 0, stdout: "", stderr: "" }) }), 0, h.out.join("\n"));
  assert.ok(h.out.some((m) => m === `WARN apps/api/.env: ${LINKED}`), h.out.join("\n"));
  assert.ok(h.out.includes("WARN apps/api: nothing from Parlox was found to remove."), h.out.join("\n"));
  assert.ok(h.out.includes("Will run in apps/web: npm uninstall @parlox/browser"), h.out.join("\n"));
  assert.equal(h.out.some((m) => /Add this by hand/.test(m)), false, h.out.join("\n"));
});

test("the real step by hand: an app with Parlox whose .env is a link still lists that step", { skip: process.platform === "win32" }, async () => {
  const shared = fixture({ "shared.env": "" });
  const dir = fixture({
    "package-lock.json": "{}", ...NEVER,
    "package.json": JSON.stringify({ name: "api", type: "module", scripts: { dev: "node server.js" }, dependencies: { express: "^5.1.0", dotenv: "^17.0.0", "@parlox/server": SERVER_VERSION } }),
    // The app's own order code keeps the package, so the env file's step is all that is left.
    "src/orders.js": "import { createParlox } from '@parlox/server'\nexport const orders = createParlox({ secretKey: process.env.PARLOX_ORDERS_KEY })\n",
  });
  linkEnv(dir, join(shared, "shared.env"));
  execFileSync("git", [...G, "init", "-q"], { cwd: dir });
  commit(dir, "init");
  const f = face();
  assert.equal(await main(["uninstall", "--yes"], { cwd: dir, config, ui: f.ui, open: () => {}, run: () => { throw new Error("nothing runs"); } }), 0, f.out.join("\n"));
  const report = f.reports.at(-1);
  assert.equal(report.title, "Steps by hand");
  assert.ok(report.lines.includes(`.env: ${LINKED}`), report.lines.join("\n"));
  assert.ok(report.lines[0].startsWith("Nothing was removed: what is left of Parlox is in files the wizard does not change."), report.lines.join("\n"));

  // In a run with several apps, that app is offered.
  const root = fixture({
    "package.json": JSON.stringify({ name: "mono", private: true, workspaces: ["apps/*"] }), "package-lock.json": "{}", ".env": "PORT=3000\n",
    ...Object.fromEntries(Object.entries({ ...NEVER, "package.json": read(dir, "package.json"), "src/orders.js": read(dir, "src/orders.js") }).map(([p, c]) => [`apps/api/${p}`, c])),
    "apps/web/package.json": pkg({ next: "16.0.1", react: "19.0.0", "@parlox/browser": BROWSER_VERSION }), "apps/web/app/layout.tsx": "export default function RootLayout({ children }) {\n  return <html><body>{children}</body></html>;\n}\n",
  });
  symlinkSync(join(root, ".env"), join(root, "apps/api/.env"));
  execFileSync("git", [...G, "init", "-q"], { cwd: root });
  commit(root, "init");
  const g = face();
  assert.equal(await main(["uninstall", "--yes"], { cwd: root, config, ui: g.ui, open: () => {}, run: () => ({ status: 0, stdout: "", stderr: "" }) }), 0, g.out.join("\n"));
  assert.deepEqual(g.asked, ["Which apps should Parlox be removed from?"]);
  assert.ok(g.reports.at(-1).lines.includes("apps/api: nothing removed; the steps by hand above are left to do."), g.reports.at(-1).lines.join("\n"));
});

test("a file the uninstall cannot parse is evidence of Parlox only when it names a Parlox package", () => {
  const git = { isRepo: () => false, dirty: () => [], isTracked: () => false, isIgnored: () => false };
  const BROKEN = "import express from 'express'\nconst app = express(\n";
  for (const [text, found] of [[BROKEN, false], [`import { parlox } from '@parlox/server/express'\n${BROKEN}`, true]]) {
    const dir = fixture({ "package-lock.json": "{}", ...NEVER });
    const [u] = scanApps(dir).units;
    writeFileSync(join(dir, "server.js"), text);
    const plan = unplanUnit(u, { read: (f) => readInside(dir, f), git });
    assert.equal(plan.manual.length, 1, JSON.stringify(plan.manual));
    assert.equal(!!plan.manual[0].unread, !found, text);
    assert.equal(parloxIn(plan, (f) => readInside(dir, f)), found, text);
  }
  // A @parlox/* dependency is evidence by itself.
  const dep = fixture({ "package-lock.json": "{}", ...NEVER, "package.json": JSON.stringify({ name: "api", dependencies: { express: "^5.1.0", "@parlox/browser": BROWSER_VERSION } }) });
  assert.equal(parloxIn({ changes: [], install: null, manual: [{ file: ".env", reason: "r", snippet: "s", unread: true }], warnings: [] }, (f) => readInside(dep, f)), true);
});
