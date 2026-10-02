import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { Writable } from "node:stream";
import { createElement } from "react";
import { render } from "ink-testing-library";
import { main } from "../dist/cli.js";
import { renderDiff } from "../dist/diff.js";
import { summarizeChanges } from "../dist/ui/summary.js";
import { plainUi } from "../dist/ui/plain.js";
import { summary } from "../dist/start.js";
import { WizardStore } from "../dist/tui/store.js";
import { Review } from "../dist/tui/screens/Review.js";
import { startFakeAuth, startFakeGateway } from "./fake-servers.mjs";
import { fixture, read, ready, until } from "./helpers.mjs";

// An env file holds the developer's own variables beside Parlox's line. The review shows Parlox's line only, and how
// many other lines the file has: never their values, in either face, for an install or an uninstall.

const DB = "DATABASE_URL=postgres://u:hunter2@h/db";
const STRIPE = "STRIPE_SECRET_KEY=sk_live_x";
const SECRETS = ["hunter2", "sk_live_x", "DATABASE_URL", "STRIPE_SECRET_KEY"];
const ENV = `${DB}\n${STRIPE}`;
const leaks = (text) => SECRETS.filter((s) => text.includes(s));

test("an env file's diff shows only PARLOX_VERIFY_TOKEN and a count of the other lines", () => {
  const install = renderDiff([{ path: ".env", before: ENV, after: `${DB}\n${STRIPE}\nPARLOX_VERIFY_TOKEN=vt_fake\n` }]);
  assert.deepEqual(leaks(install), [], install);
  assert.match(install, /^\+PARLOX_VERIFY_TOKEN=vt_fake$/m);
  assert.match(install, /^ 2 other lines in this file, not shown$/m);
  assert.match(install, /^@@ -2,0 \+3,1 @@$/m, "the file's own line numbers, no context lines");
  const uninstall = renderDiff([{ path: "apps/api/.env.local", before: `${DB}\nPARLOX_VERIFY_TOKEN=vt_fake\n`, after: `${DB}\n` }]);
  assert.deepEqual(leaks(uninstall), [], uninstall);
  assert.match(uninstall, /^-PARLOX_VERIFY_TOKEN=vt_fake$/m);
  assert.match(uninstall, /^ 1 other line in this file, not shown$/m);
  // Another line the change would take out is shown as a stand-in, never its value.
  const other = renderDiff([{ path: ".env", before: `PARLOX_VERIFY_TOKEN=vt\n${STRIPE}\n${DB}\n`, after: `PARLOX_VERIFY_TOKEN=vt\n${DB}\n` }]);
  assert.deepEqual(leaks(other), [], other);
  assert.match(other, /^-\[your line 1, not shown\]$/m);
  assert.match(other, /^ 1 other line in this file, not shown$/m);
  // A file Parlox's line was alone in: no count line.
  assert.doesNotMatch(renderDiff([{ path: ".env", before: "PARLOX_VERIFY_TOKEN=vt\n", after: null }]), /other line/);
  // Any other file keeps its full diff.
  assert.match(renderDiff([{ path: "server.js", before: "a\n", after: "a\nb\n" }]), /^ a$/m);
  // The counts in the change list are the shown lines' (the file's own last line gaining a line break is not shown).
  const [row] = summarizeChanges({ changes: [{ path: ".env", before: ENV, after: `${ENV}\nPARLOX_VERIFY_TOKEN=vt\n` }], install: null, manual: [], warnings: [] });
  assert.deepEqual([row.added, row.removed], [1, 0]);
});

test("the full screen's copy of the plan holds no other line of an env file", () => {
  const s = new WizardStore();
  s.changes({ changes: [{ path: ".env", before: ENV, after: `${ENV}\nPARLOX_VERIFY_TOKEN=vt\n` }], install: null, manual: [], warnings: [] }, "api", "install");
  assert.deepEqual(leaks(JSON.stringify(s.getSnapshot())), []);
});

const SITE = { id: "11111111-1111-1111-1111-111111111111", name: "Shop", domain: "shop.example.com", public_key: "pk_" + "a1".repeat(12), verified: false };
const G = ["-c", "user.email=t@t", "-c", "user.name=t"];
const commit = (dir, msg) => { execFileSync("git", [...G, "add", "-A"], { cwd: dir }); execFileSync("git", [...G, "commit", "-qm", msg], { cwd: dir }); };
const api = () => {
  const dir = fixture({
    "package.json": JSON.stringify({ name: "api", type: "module", scripts: { dev: "node server.js" }, dependencies: { express: "^5.1.0", dotenv: "^17.0.0" } }),
    "package-lock.json": "{}", ".gitignore": "node_modules\n.env\n",
    "server.js": "import 'dotenv/config'\nimport express from 'express'\n\nconst app = express()\napp.get('/', (req, res) => res.send('ok'))\napp.listen(3000)\n",
    ".env": ENV,
  });
  execFileSync("git", [...G, "init", "-q"], { cwd: dir });
  commit(dir, "init");
  return dir;
};

async function env(t) {
  const auth = await startFakeAuth({ decide: "approve" });
  const gw = await startFakeGateway({ sites: [{ ...SITE }], keys: [] });
  t.after(() => { auth.close(); gw.close(); });
  const config = { gateway: gw.url, supabaseUrl: auth.url, clientId: "wiz", apiKey: "test-publishable-key", ports: [53872, 53873], dashboard: "https://app.parlox.io" };
  return (dir, ui) => ({ cwd: dir, config, ui, open: (url) => { fetch(url).catch(() => {}); }, run: () => ({ status: 0, stdout: "", stderr: "" }) });
}

/** The plain face, writing to a buffer; its questions answered Yes (with --yes nothing is asked). */
function plain() {
  let text = "";
  const out = new Writable({ write(c, _e, cb) { text += c.toString(); cb(); } });
  out.isTTY = false; out.columns = 120;
  const face = plainUi(out, undefined, { isTTY: false });
  return { text: () => text, ui: { ...face, confirm: async () => true, multiselect: async (_m, o) => o.map((x) => x.value) } };
}

/** The full screen's store, its questions answered Yes; what it draws: the review with each file's diff opened, and
 * what is printed when it closes. */
function screen() {
  const s = new WizardStore();
  s.start();
  s.confirm = async () => true;
  return {
    ui: s,
    async drawn() {
      const frames = [];
      const { lastFrame, stdin, unmount } = render(createElement(Review, { state: s.getSnapshot(), width: 120, rows: 60 }));
      await ready(stdin);
      for (let i = 0; i < s.getSnapshot().plan.changes.length; i++) {
        stdin.write("d");
        await until(() => /d or Esc back/.test(lastFrame()), "a diff");
        frames.push(lastFrame());
        stdin.write("\u001B");
        await until(() => !/d or Esc back/.test(lastFrame()), "the list");
        stdin.write("\u001B[B");
        await new Promise((r) => setImmediate(r));
      }
      unmount();
      return [...frames, summary(s.getSnapshot(), 0)].join("\n");
    },
  };
}

for (const yes of [true, false]) {
  test(`install and uninstall${yes ? " with --yes" : ""}: neither face shows the developer's own env values`, async (t) => {
    const deps = await env(t);
    const dir = api();
    const p = plain();
    assert.equal(await main([...(yes ? ["--yes"] : []), "--site", "shop.example.com", "--skip-check"], deps(dir, p.ui)), 0, p.text());
    assert.match(p.text(), /\+PARLOX_VERIFY_TOKEN=vt_fake/, "Parlox's own line is shown");
    assert.match(p.text(), /2 other lines in this file, not shown/);
    assert.deepEqual(leaks(p.text()), [], p.text());
    assert.equal(read(dir, ".env"), `${ENV}\nPARLOX_VERIFY_TOKEN=vt_fake\n`, "the file itself keeps every line");

    commit(dir, "installed");
    const q = plain();
    assert.equal(await main(["uninstall", ...(yes ? ["--yes"] : [])], deps(dir, q.ui)), 0, q.text());
    assert.match(q.text(), /-PARLOX_VERIFY_TOKEN=vt_fake/);
    assert.deepEqual(leaks(q.text()), [], q.text());
    assert.equal(read(dir, ".env"), `${ENV}\n`);

    // The full screen, on the same app.
    const fresh = api();
    const s = screen();
    assert.equal(await main([...(yes ? ["--yes"] : []), "--site", "shop.example.com", "--skip-check"], deps(fresh, s.ui)), 0);
    const shown = await s.drawn();
    assert.match(shown, /\+PARLOX_VERIFY_TOKEN=vt_fake/, shown);
    assert.deepEqual(leaks(shown), [], shown);
    assert.deepEqual(leaks(JSON.stringify(s.ui.getSnapshot())), []);
    commit(fresh, "installed");
    const u = screen();
    assert.equal(await main(["uninstall", ...(yes ? ["--yes"] : [])], deps(fresh, u.ui)), 0);
    const removed = await u.drawn();
    assert.match(removed, /-PARLOX_VERIFY_TOKEN=vt_fake/, removed);
    assert.deepEqual(leaks(removed), [], removed);
    assert.deepEqual(leaks(JSON.stringify(u.ui.getSnapshot())), []);
  });
}

test("--debug prints an error's stack, never file content: an env value is not in it", async (t) => {
  const deps = await env(t);
  const dir = api();
  const p = plain();
  // A gateway that cannot be reached after the sign-in: the run ends with an error, printed with its stack.
  const d = deps(dir, p.ui);
  assert.equal(await main(["--yes", "--debug", "--site", "shop.example.com", "--skip-check"], { ...d, config: { ...d.config, gateway: "http://127.0.0.1:1" } }), 1);
  assert.deepEqual(leaks(p.text()), [], p.text());
});
