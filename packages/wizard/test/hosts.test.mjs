import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { detectHost, handoffUrl, localKeyName } from "../dist/hosts.js";
import { fixture } from "./helpers.mjs";

test("each host is detected from its file", () => {
  const cases = [
    [{ ".vercel/project.json": "{}" }, "vercel"], [{ "vercel.json": "{}" }, "vercel"], [{ "netlify.toml": "" }, "netlify"],
    [{ "fly.toml": "" }, "fly"], [{ "wrangler.toml": "" }, "cloudflare"], [{ "wrangler.jsonc": "{}" }, "cloudflare"],
    [{ "render.yaml": "" }, "render"], [{ "railway.json": "{}" }, "railway"], [{ "railway.toml": "" }, "railway"],
    [{ Dockerfile: "FROM node" }, "docker"], [{ "README.md": "" }, "unknown"],
  ];
  for (const [files, id] of cases) { const d = fixture(files); assert.equal(detectHost(d, d).id, id, JSON.stringify(files)); }
});

test("the Vercel link is found in the app folder, then the workspace root", () => {
  const root = fixture({ ".vercel/project.json": "{}", "apps/web/package.json": "{}" });
  const app = join(root, "apps", "web");
  const h = detectHost(app, root);
  assert.equal(h.id, "vercel");
  assert.equal(h.vercelDir, root);
  const own = fixture({ ".vercel/project.json": "{}" });
  assert.equal(detectHost(own, own).vercelDir, own);
  assert.equal(detectHost(fixture({ "vercel.json": "{}" }), fixture({})).vercelDir, null, "vercel.json alone is not a CLI link");
});

test("verified instructions per host", () => {
  const d = (files) => { const x = fixture(files); return detectHost(x, x); };
  assert.equal(d({ "netlify.toml": "" }).where, "Project configuration → Environment variables");
  assert.equal(d({ "netlify.toml": "" }).docs, "https://docs.netlify.com/build/environment-variables/get-started/");
  assert.equal(d({ "render.yaml": "" }).docs, "https://docs.render.com/docs/configure-environment-variables");
  assert.equal(d({ "wrangler.toml": "" }).docs, "https://developers.cloudflare.com/workers/configuration/secrets/");
  assert.equal(d({ "railway.json": "{}" }).docs, "https://docs.railway.com/guides/variables");
  assert.equal(d({ "fly.toml": "" }).docs, "https://docs.fly.io/apps/secrets/");
  assert.equal(d({ "vercel.json": "{}" }).docs, "https://vercel.com/docs/environment-variables/managing-environment-variables");
  assert.equal(d({ Dockerfile: "" }).docs, null);
});

test("the hand-off link encodes the site id and the key name", () => {
  const host = { id: "netlify", label: "Netlify", where: "", docs: null, vercelDir: null };
  assert.equal(handoffUrl("https://app.parlox.io", "a/b c", host), "https://app.parlox.io/sites/a%2Fb%20c?newKey=Netlify%20%C2%B7%20production&scope=fetch#keys");
});

test("local key names: plain characters only, at most 52 characters", () => {
  assert.equal(localKeyName("Erez's MacBook Pro.local"), "local dev · Erezs-MacBook-Pro.local");
  assert.equal(localKeyName("x".repeat(100)).length, 52);
  assert.equal(localKeyName("\u0000‮"), "local dev · this computer");
});

test("a host file in the app folder wins over one at the workspace root", () => {
  const root = fixture({ "vercel.json": "{}", "apps/web/netlify.toml": "" });
  assert.equal(detectHost(join(root, "apps", "web"), root).id, "netlify");
  const root2 = fixture({ "netlify.toml": "", "apps/web/package.json": "{}" });
  assert.equal(detectHost(join(root2, "apps", "web"), root2).id, "netlify", "the root is still checked when the app folder has none");
});

test("a Vercel CLI link makes the host Vercel, so the Host line and the Vercel question agree", () => {
  // A root link no longer beats the app folder's own host file (the case this test first covered);
  // it still makes the host Vercel when the app folder has none, and an app's own link beats its Dockerfile.
  const root = fixture({ ".vercel/project.json": "{}", "apps/web/Dockerfile": "" });
  const h = detectHost(join(root, "apps", "web"), root);
  assert.equal(h.id, "vercel");
  assert.equal(h.label, "Vercel");
  assert.equal(h.vercelDir, root);
  const own = fixture({ ".vercel/project.json": "{}", Dockerfile: "" });
  assert.equal(detectHost(own, own).id, "vercel");
});

// The root of a monorepo may belong to another app, so a host file in the app folder wins over a
// Vercel link at the root; the root link is used only when the app folder has no host file of its own.
test("a host file in the app folder wins over a Vercel link at the workspace root", () => {
  for (const file of ["netlify.toml", "fly.toml", "render.yaml", "railway.json", "railway.toml"]) {
    const root = fixture({ ".vercel/project.json": "{}", [`apps/web/${file}`]: "" });
    const h = detectHost(join(root, "apps", "web"), root);
    assert.notEqual(h.id, "vercel", file);
    assert.equal(h.vercelDir, null, `${file}: the root link is not used`);
  }
  // wrangler's config (not Pages) is the exception: Cloudflare counts only when nothing contradicts it, and the root
  // link does, so it decides.
  for (const file of ["wrangler.toml", "wrangler.json", "wrangler.jsonc"]) {
    const root = fixture({ ".vercel/project.json": "{}", [`apps/web/${file}`]: "" });
    const h = detectHost(join(root, "apps", "web"), root);
    assert.equal(h.id, "vercel", file);
    assert.equal(h.vercelDir, root, file);
  }
  const root = fixture({ ".vercel/project.json": "{}", "apps/web/netlify.toml": "" });
  assert.equal(detectHost(join(root, "apps", "web"), root).id, "netlify");
  const both = fixture({ ".vercel/project.json": "{}", "apps/web/.vercel/project.json": "{}", "apps/web/netlify.toml": "" });
  assert.equal(detectHost(join(both, "apps", "web"), both).vercelDir, join(both, "apps", "web"), "the app folder's own link comes first");
});
