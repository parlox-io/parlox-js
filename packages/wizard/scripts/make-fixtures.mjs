// Regenerates test/fixtures/generated/ from the official generators, at pinned versions (Sentry's
// e2e-tests/test-applications pattern). Needs the network. Run it by hand when a generator version is bumped, review
// the diff, commit it; nothing here runs in CI. No dependencies are installed (create-vite --no-immediate, create-hono
// answered "n"), so no node_modules is committed.
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const OUT = resolve(import.meta.dirname, "..", "test", "fixtures", "generated");
const npx = process.platform === "win32" ? "npx.cmd" : "npx";
const VITE = "create-vite@9.2.1", EXPRESS = "express-generator@4.16.1", HONO = "create-hono@0.19.5";
const FIXTURES = [
  ["vite-react-ts", [VITE, "vite-react-ts", "--template", "react-ts", "--no-interactive", "--no-immediate"]],
  ["vite-react", [VITE, "vite-react", "--template", "react", "--no-interactive", "--no-immediate"]],
  ["express-pug", [EXPRESS, "--view=pug", "express-pug"]],
  ["express-ejs", [EXPRESS, "--view=ejs", "express-ejs"]],
  ["express-hbs", [EXPRESS, "--view=hbs", "express-hbs"]],
  ["express-jade", [EXPRESS, "express-jade"]],                       // the generator's default engine
  ["express-static", [EXPRESS, "--no-view", "express-static"]],
  ...["nodejs", "bun", "cloudflare-workers", "cloudflare-pages", "vercel", "aws-lambda"].map((t) => [`hono-${t}`, [HONO, `hono-${t}`, "--template", t, "--pm", "npm"]]),
];

const work = mkdtempSync(join(tmpdir(), "parlox-fixtures-"));
for (const [name, args] of FIXTURES) {
  // create-hono asks whether to install dependencies; the answer is no.
  const r = spawnSync(npx, ["-y", ...args], { cwd: work, input: "n\n", encoding: "utf8", shell: process.platform === "win32" });
  if (r.status !== 0) { console.error(`${name}: ${r.stderr}`); process.exit(1); }
  rmSync(join(OUT, name), { recursive: true, force: true });
  cpSync(join(work, name), join(OUT, name), { recursive: true, filter: (src) => !/[\\/](node_modules|\.git)([\\/]|$)/.test(src) });
  console.log(`generated ${name}`);
}
rmSync(work, { recursive: true, force: true });
