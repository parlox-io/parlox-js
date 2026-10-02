import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { main } from "../dist/cli.js";
import { startFakeAuth, startFakeGateway } from "./fake-servers.mjs";
import { fixture } from "./helpers.mjs";

// --url names one local address: it is refused only when several apps of the run have a server part that can be
// checked locally (a dev server to ask). A static site's ownership file has no local check, so it does not count.

const SITE = { id: "11111111-1111-1111-1111-111111111111", name: "Shop", domain: "shop.example.com", public_key: "pk_" + "a1".repeat(12), verified: false };
const G = ["-c", "user.email=t@t", "-c", "user.name=t"];

test("--url in a monorepo with a static Vite site and one API: the API is checked at that address", async (t) => {
  const auth = await startFakeAuth({ decide: "approve" });
  const gw = await startFakeGateway({ sites: [{ ...SITE }], keys: [] });
  const dev = createServer((req, res) => { res.end(req.url === "/.well-known/parlox-verify" ? "vt_fake" : "ok"); });
  await new Promise((r) => dev.listen(0, "127.0.0.1", r));
  t.after(() => { auth.close(); gw.close(); dev.closeAllConnections?.(); dev.close(); });
  const root = fixture({
    "package.json": JSON.stringify({ name: "mono", private: true, workspaces: ["apps/*"] }), "package-lock.json": "{}", ".gitignore": "node_modules\n.env\n",
    "apps/web/package.json": JSON.stringify({ name: "web", scripts: { build: "vite build" }, dependencies: { react: "^19.2.0", "react-dom": "^19.2.0" }, devDependencies: { vite: "^7.2.0", "@vitejs/plugin-react": "^5.1.0" } }),
    "apps/web/netlify.toml": "",
    "apps/web/vite.config.js": "import { defineConfig } from 'vite'\nimport react from '@vitejs/plugin-react'\n\nexport default defineConfig({\n  plugins: [react()],\n})\n",
    "apps/web/index.html": '<!doctype html>\n<html>\n  <body>\n    <div id="root"></div>\n    <script type="module" src="/src/main.jsx"></script>\n  </body>\n</html>\n',
    "apps/web/src/main.jsx": 'import { createRoot } from "react-dom/client";\nimport App from "./App.jsx";\n\ncreateRoot(document.getElementById("root")).render(<App />);\n',
    "apps/api/package.json": JSON.stringify({ name: "api", type: "module", scripts: { dev: "node server.js" }, dependencies: { express: "^5.1.0", dotenv: "^17.0.0" } }),
    "apps/api/render.yaml": "",
    "apps/api/server.js": "import 'dotenv/config'\nimport express from 'express'\n\nconst app = express()\napp.listen(3000)\n",
  });
  execFileSync("git", [...G, "init", "-q"], { cwd: root });
  execFileSync("git", [...G, "add", "-A"], { cwd: root });
  execFileSync("git", [...G, "commit", "-qm", "init"], { cwd: root });
  const out = [];
  const ui = { info: (m) => out.push(m), warn: (m) => out.push(`WARN ${m}`), confirm: async () => true, select: async (_m, o) => o[0].value, text: async () => "", multiselect: async (_m, o) => o.map((x) => x.value) };
  const config = { gateway: gw.url, supabaseUrl: auth.url, clientId: "wiz", apiKey: "test-publishable-key", ports: [53892, 53893], dashboard: "https://app.parlox.io" };
  const url = `http://127.0.0.1:${dev.address().port}`;
  const code = await main(["--yes", "--no-vercel", "--site", "shop.example.com", "--url", url], { cwd: root, config, ui, open: (u) => { fetch(u).catch(() => {}); }, run: () => ({ status: 0, stdout: "", stderr: "" }) });
  assert.equal(code, 0, out.join("\n"));
  assert.equal(out.some((m) => m.includes("--url names one local address")), false, out.join("\n"));
  assert.match(out.at(-1), /Server part \(apps\/api\): verified locally\./, out.at(-1));
});

test("--url with two apps that each have a local check is refused before sign-in, naming them", async () => {
  const api = (name) => ({
    [`apps/${name}/package.json`]: JSON.stringify({ name, type: "module", scripts: { dev: "node server.js" }, dependencies: { express: "^5.1.0", dotenv: "^17.0.0" } }),
    [`apps/${name}/server.js`]: "import 'dotenv/config'\nimport express from 'express'\n\nconst app = express()\napp.listen(3000)\n",
  });
  const root = fixture({ "package.json": JSON.stringify({ name: "mono", private: true, workspaces: ["apps/*"] }), "package-lock.json": "{}", ...api("a"), ...api("b") });
  const out = [];
  const ui = { info: (m) => out.push(m), warn: (m) => out.push(`WARN ${m}`), confirm: async () => true, select: async (_m, o) => o[0].value, text: async () => "", multiselect: async (_m, o) => o.map((x) => x.value) };
  const config = { gateway: "http://127.0.0.1:1", supabaseUrl: "http://127.0.0.1:1", clientId: "wiz", apiKey: "k", ports: [53894, 53895], dashboard: "https://app.parlox.io" };
  assert.equal(await main(["--yes", "--allow-no-git", "--site", "shop.example.com", "--url", "http://localhost:3000"], { cwd: root, config, ui, open: () => {}, run: () => ({ status: 0, stdout: "", stderr: "" }) }), 1);
  assert.ok(out.some((m) => m.startsWith("WARN --url names one local address, and this run has several apps whose server part can be checked locally (apps/a, apps/b).")), out.join("\n"));
});
