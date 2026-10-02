import { test } from "node:test";
import assert from "node:assert/strict";
import { describeUnit, hostStepFor, scanApps } from "../dist/apps.js";
import { handoffOf } from "../dist/host-step.js";
import { detectHost } from "../dist/hosts.js";
import { runNames } from "../dist/names.js";
import { handoffLines } from "../dist/ui/handoff.js";
import { fixture } from "./helpers.mjs";

// The Cloudflare Vite plugin (@cloudflare/vite-plugin) is one the Vite guard reads as safe: in a build it gives the
// client build its output folder only, and the Worker's build no environment value. Its options that load or run code,
// or that the wizard does not follow, are left out. The configurations below are shapes the guard reads; none is ever
// built.

const RUNTIME_SECRET = "Add PARLOX_SECRET_KEY as a runtime secret under Settings → Variables & Secrets, not as a build variable.";
// Cloudflare's "Vite React Template" (React, Vite, Hono and Cloudflare Workers; github.com/cloudflare/templates,
// vite-react-template, opened 2026-10-02), the files the wizard reads.
const TEMPLATE = {
  "package.json": JSON.stringify({
    name: "vite-react-template", description: "A template for building a React application with Vite, Hono, and Cloudflare Workers",
    dependencies: { hono: "4.11.1", react: "19.2.1", "react-dom": "19.2.1" },
    devDependencies: { "@cloudflare/vite-plugin": "1.52.1", "@types/node": "24.10.1", "@types/react": "19.2.7", "@types/react-dom": "19.2.3", "@vitejs/plugin-react": "5.1.1", typescript: "5.9.3", vite: "^7.0.0", wrangler: "4.136.1" },
    private: true,
    scripts: { build: "tsc -b && vite build", "cf-typegen": "wrangler types", check: "tsc && vite build && wrangler deploy --dry-run", deploy: "wrangler deploy", dev: "vite", preview: "npm run build && vite preview" },
    type: "module",
  }, null, "\t"),
  "package-lock.json": "{}",
  "vite.config.ts": 'import { defineConfig } from "vite";\nimport react from "@vitejs/plugin-react";\nimport { cloudflare } from "@cloudflare/vite-plugin";\n\nexport default defineConfig({\n\tplugins: [react(), cloudflare()],\n});\n',
  "wrangler.json": '{\n\t"$schema": "node_modules/wrangler/config-schema.json",\n\t"name": "vite-react-template",\n\t"main": "./src/worker/index.ts",\n\t"compatibility_date": "2025-10-08",\n\t"compatibility_flags": ["nodejs_compat"],\n\t"observability": {\n\t\t"enabled": true\n\t},\n\t"upload_source_maps": true,\n\t"assets": {\n\t\t"directory": "./dist/client",\n\t\t"not_found_handling": "single-page-application"\n\t}\n}\n',
  "src/worker/index.ts": 'import { Hono } from "hono";\nconst app = new Hono<{ Bindings: Env }>();\n\napp.get("/api/", (c) => c.json({ name: "Cloudflare" }));\n\nexport default app;\n',
  "index.html": '<!doctype html>\n<html lang="en">\n\t<head>\n\t\t<meta charset="UTF-8" />\n\t\t<link rel="icon" type="image/svg+xml" href="/vite.svg" />\n\t\t<meta name="viewport" content="width=device-width, initial-scale=1.0" />\n\t\t<title>Vite + React + TS</title>\n\t</head>\n\n\t<body>\n\t\t<div id="root"></div>\n\t\t<script type="module" src="/src/react-app/main.tsx"></script>\n\t</body>\n</html>\n',
  "src/react-app/main.tsx": 'import { StrictMode } from "react";\nimport { createRoot } from "react-dom/client";\nimport "./index.css";\nimport App from "./App.tsx";\n\ncreateRoot(document.getElementById("root")!).render(\n\t<StrictMode>\n\t\t<App />\n\t</StrictMode>,\n);\n',
  "src/react-app/index.css": ":root { color-scheme: light dark; }\n",
  "src/react-app/App.tsx": "export default function App() {\n\treturn <h1>Shop</h1>;\n}\n",
  "tsconfig.json": '{\n\t"files": [],\n\t"references": [\n\t\t{ "path": "./tsconfig.app.json" },\n\t\t{ "path": "./tsconfig.node.json" },\n\t\t{ "path": "./tsconfig.worker.json" }\n\t]\n}\n',
};
const withConfig = (plugins, extra = "") => ({ ...TEMPLATE, "vite.config.ts": `import { defineConfig } from "vite";\nimport react from "@vitejs/plugin-react";\nimport { cloudflare } from "@cloudflare/vite-plugin";\n\nexport default defineConfig({\n\tplugins: [react(), ${plugins}],${extra}\n});\n` });
const unitOf = (files) => { const [u] = scanApps(fixture(files)).units; assert.ok(u, "no app"); return u; };

test("Cloudflare's Vite React template (cloudflare() beside plugin-react, with Hono as the Worker): the Vite build is checked and proven safe, so the server part is planned, with the runtime-secret line", () => {
  const u = unitOf(TEMPLATE);
  assert.equal(u.server?.integration, "hono", u.warnings.join("\n"));
  assert.equal(u.withheld, null);
  assert.equal(u.browser?.integration, "vite-react");
  assert.equal(u.viteBeside, true, "the Vite build was checked");
  assert.equal(u.server.data.appFile, "src/worker/index.ts");
  assert.equal(u.server.data.target, "cloudflare-workers");
  assert.equal(describeUnit(u), "./ · Vite React + Hono · browser and server parts");
  const host = detectHost(u.dir, u.root);
  assert.equal(host.id, "cloudflare");
  assert.equal(hostStepFor(u, host), true);
  const handoff = handoffLines(handoffOf({ dashboard: "https://app.parlox.io", siteId: "s", verifyToken: "vt", names: runNames([u], u.dir) }, u, host, { secretDone: false, tokenDone: false, finished: false }));
  assert.ok(handoff.includes(RUNTIME_SECRET), handoff.join("\n"));
});

test("the plugin's options that change nothing in the client build are allowed: configPath inside the app, viteEnvironment, persistState, inspectorPort, remoteBindings", () => {
  for (const options of [
    '{ viteEnvironment: { name: "ssr" } }',
    '{ configPath: "./wrangler.json", persistState: false, inspectorPort: false, remoteBindings: false }',
    '{ persistState: { path: ".wrangler/state" }, inspectorPort: 9230 }',
  ]) {
    const u = unitOf(withConfig(`cloudflare(${options})`));
    assert.equal(u.server?.integration, "hono", `${options}: ${u.warnings.join("\n")}`);
  }
});

test("the plugin's other options withhold the key: experimental (cloudflare.config.ts, a prerender Worker), config and auxiliaryWorkers (Worker configs, functions allowed), assetsOnly, tunnel, a configPath outside the app", () => {
  for (const [options, key] of [
    ["{ experimental: { newConfig: true } }", "experimental"],
    ['{ experimental: { prerenderWorker: { configPath: "./prerender.jsonc" } } }', "experimental"],
    ['{ config: { vars: { A: "1" } } }', "config"],
    ['{ auxiliaryWorkers: [{ configPath: "./aux/wrangler.jsonc" }] }', "auxiliaryWorkers"],
    ["{ assetsOnly: true }", "assetsOnly"],
    ["{ tunnel: true }", "tunnel"],
    ['{ configPath: "../shared/wrangler.json" }', "configPath"],
    // A wrangler config is JSON, JSONC or TOML; any other file is not one the wizard has read the handling of.
    ['{ configPath: "./w.js" }', "configPath"],
    // The Worker's environment is never the client's: the client's output is what the browser downloads.
    ['{ viteEnvironment: { name: "client" } }', "viteEnvironment"],
    ['{ viteEnvironment: { name: "ssr", childEnvironments: ["client"] } }', "viteEnvironment"],
  ]) {
    const u = unitOf(withConfig(`cloudflare(${options})`));
    assert.equal(u.server, null, options);
    assert.match(u.warnings[0] ?? "", new RegExp(`^Hono: no server part was added\\. vite\\.config\\.ts uses the option ${key} of @cloudflare/vite-plugin \\(line 6\\)`), options);
  }
  // A call the wizard cannot read.
  assert.equal(unitOf(withConfig("cloudflare(options)")).server, null);
});

test("beside the plugin, Vite's environments setting withholds the key: it could put a Worker's output, with the local variables the plugin writes there, inside the client's", () => {
  const u = unitOf(withConfig("cloudflare()", '\n\tenvironments: { vite_react_template: { build: { outDir: "dist/client/worker" } } },'));
  assert.equal(u.server, null, u.warnings.join("\n"));
  assert.match(u.warnings[0] ?? "", /^Hono: no server part was added\. vite\.config\.ts uses the setting environments beside @cloudflare\/vite-plugin \(line 7\)/);
});

test("the plugin must come from the npm registry, like every package the guard trusts by name", () => {
  const pkg = JSON.parse(TEMPLATE["package.json"]);
  const u = unitOf({ ...TEMPLATE, "package.json": JSON.stringify({ ...pkg, devDependencies: { ...pkg.devDependencies, "@cloudflare/vite-plugin": "github:someone/vite-plugin" } }) });
  assert.equal(u.server, null, u.warnings.join("\n"));
  assert.match(u.warnings[0] ?? "", /package\.json declares @cloudflare\/vite-plugin as "github:someone\/vite-plugin", not a version from the npm registry/);
});

test("create-hono's Workers template with Vite: the Cloudflare plugin passes, and vite-ssr-components, which the guard does not read, withholds the key", () => {
  const u = unitOf({
    "package.json": JSON.stringify({ name: "shop", type: "module", scripts: { dev: "vite", build: "vite build", deploy: "$npm_execpath run build && wrangler deploy" }, dependencies: { hono: "^4.13.12" }, devDependencies: { "@cloudflare/vite-plugin": "^1.44.0", vite: "^8.1.4", "vite-ssr-components": "^0.8.0", wrangler: "^4.110.0" } }),
    "package-lock.json": "{}",
    "wrangler.jsonc": '{\n  "name": "shop",\n  "compatibility_date": "2025-08-03",\n  "main": "./src/index.tsx"\n}\n',
    "vite.config.ts": "import { cloudflare } from '@cloudflare/vite-plugin'\nimport { defineConfig } from 'vite'\nimport ssrPlugin from 'vite-ssr-components/plugin'\n\nexport default defineConfig({\n  plugins: [cloudflare(), ssrPlugin()]\n})\n",
    "src/index.tsx": "import { Hono } from 'hono'\nconst app = new Hono()\napp.get('/', (c) => c.text('Hello Hono!'))\nexport default app\n",
  });
  assert.equal(u.server, null);
  assert.match(u.warnings[0] ?? "", /^Hono: no server part was added\. vite\.config\.ts uses the import of vite-ssr-components\/plugin \(line 3\)/);
});
