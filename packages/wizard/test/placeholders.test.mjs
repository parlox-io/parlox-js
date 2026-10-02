import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { mergePlans, scanApps, planUnit } from "../dist/apps.js";
import { fixture } from "./helpers.mjs";

// A step by hand names a real file with its app's folder in front ("apps/api/src/index.ts") in a run with several
// apps; a file the wizard could not find is named in words ("your page layout"), and the folder comes after it.

const git = { isRepo: () => false, dirty: () => [], isTracked: () => false, isIgnored: () => false };
const reader = (dir) => (rel) => (existsSync(join(dir, rel)) ? readFileSync(join(dir, rel), "utf8") : null);
const input = { publicKey: "pk_" + "a1".repeat(12), verifyToken: "vt", host: { id: "render", label: "Render", where: "", docs: null, vercelDir: null } };

test("in a run with several apps, only real paths get the folder in front; a description gets it after", () => {
  const root = fixture({
    "package.json": JSON.stringify({ name: "mono", private: true, workspaces: ["apps/*"] }), "package-lock.json": "{}",
    // Express with no server file the wizard can find.
    "apps/api/package.json": JSON.stringify({ name: "api", dependencies: { express: "^5.1.0" } }),
    // Hono with two files that have a page <head>: the layout is a step by hand.
    "apps/site/package.json": JSON.stringify({ name: "site", dependencies: { hono: "^4.9.0", "@hono/node-server": "^1.19.0" } }),
    "apps/site/src/index.tsx": "import { Hono } from 'hono'\nconst app = new Hono()\nexport default app\n",
    "apps/site/src/a.tsx": "export const A = () => <html><head><title>a</title></head></html>\n",
    "apps/site/src/b.tsx": "export const B = () => <html><head><title>b</title></head></html>\n",
  });
  const { units } = scanApps(root);
  const planned = units.map((u) => ({ unit: u, plan: planUnit(u, input, { read: reader(u.dir), git }) }));
  const files = mergePlans(planned).manual.map((m) => m.file);
  assert.ok(files.includes("your server file in apps/api"), JSON.stringify(files));
  assert.ok(files.includes("your page layout in apps/site"), JSON.stringify(files));
  assert.equal(files.some((f) => /\/your /.test(f)), false, JSON.stringify(files));
  // A real path keeps its folder in front.
  const real = mergePlans([{ unit: { rel: "apps/web", dir: join(root, "apps/web") }, plan: { changes: [], install: null, warnings: [], manual: [{ file: "src/main.tsx", reason: "r", snippet: "s" }] } }]);
  assert.equal(real.manual[0].file, "apps/web/src/main.tsx");
});
