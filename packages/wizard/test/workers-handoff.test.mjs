import { test } from "node:test";
import assert from "node:assert/strict";
import { scanApps } from "../dist/apps.js";
import { handoffOf } from "../dist/host-step.js";
import { detectHost } from "../dist/hosts.js";
import { runNames } from "../dist/names.js";
import { handoffLines } from "../dist/ui/handoff.js";
import { WizardStore } from "../dist/tui/store.js";
import { fixture } from "./helpers.mjs";

// On Cloudflare Workers the key is a runtime secret: the hand-off, where the developer adds it, says so for a Hono app on
// the Workers target (every sign says it runs there). Pages, whose variables reach the build too, never shows that
// sentence, and neither does Express under wrangler.

const RUNTIME_SECRET = "Add PARLOX_SECRET_KEY as a runtime secret under Settings → Variables & Secrets, not as a build variable.";
const BASIC = "import { Hono } from 'hono'\n\nconst app = new Hono()\n\napp.get('/', (c) => c.text('Hello Hono!'))\n\nexport default app\n";
const pkg = (deps) => JSON.stringify({ name: "shop", scripts: { dev: "wrangler dev" }, dependencies: deps, devDependencies: { wrangler: "^4.110.0" } });
const lines = (dir) => {
  const [u] = scanApps(dir).units;
  assert.ok(u.server, JSON.stringify(u.warnings));
  const h = handoffOf({ dashboard: "https://app.parlox.io", siteId: "s", verifyToken: "vt", names: runNames([u], dir) }, u, detectHost(u.dir, u.root), { secretDone: false, tokenDone: false, finished: false });
  return { h, text: handoffLines(h) };
};

test("Hono on Workers: the hand-off says the key is a runtime secret; on Pages it does not", () => {
  const workers = lines(fixture({ "package.json": pkg({ hono: "^4.13.11" }), "package-lock.json": "{}", "src/index.ts": BASIC, "wrangler.jsonc": '{\n  "name": "shop",\n  "main": "src/index.ts"\n}\n' }));
  assert.ok(workers.text.includes(RUNTIME_SECRET), workers.text.join("\n"));
  // The full screen keeps it too.
  const s = new WizardStore();
  s.handoff(workers.h);
  assert.ok(s.getSnapshot().handoff.notes.includes(RUNTIME_SECRET));
  const pages = lines(fixture({ "package.json": pkg({ hono: "^4.13.11" }), "package-lock.json": "{}", "functions/[[path]].ts": BASIC, "src/index.ts": BASIC, "wrangler.jsonc": '{\n  "name": "shop",\n  "pages_build_output_dir": "./dist"\n}\n' }));
  assert.equal(pages.text.some((l) => l.includes("runtime secret")), false, pages.text.join("\n"));
});

test("Express under wrangler: the hand-off does not say the key is a runtime secret (the sentence is Hono's Workers target's)", () => {
  const { text } = lines(fixture({
    "package.json": pkg({ express: "^5.1.0" }), "package-lock.json": "{}", "wrangler.jsonc": '{\n  "name": "shop",\n  "main": "server.js"\n}\n',
    "server.js": "import express from 'express'\nconst app = express()\nexport default app\n",
  }));
  assert.equal(text.includes(RUNTIME_SECRET), false, text.join("\n"));
});
