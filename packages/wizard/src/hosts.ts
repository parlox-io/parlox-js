import { existsSync, lstatSync, readdirSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { VERCEL_CONFIGS } from "./edits/vite-vercel.js";
import { readJsonc, readText, repoTopOf } from "./workspace.js";

export type HostId = "vercel" | "netlify" | "fly" | "cloudflare" | "render" | "railway" | "docker" | "unknown";
export interface Host { id: HostId; label: string; where: string; docs: string | null; vercelDir: string | null }

// "Where to paste" and the docs links were checked against each host's official documentation on 2026-09-29.
const HOSTS: Array<{ id: HostId; files: string[]; label: string; where: string; docs: string | null }> = [
  { id: "vercel", files: [".vercel/project.json", "vercel.json"], label: "Vercel", where: "your project → Settings → Environment Variables (then redeploy)", docs: "https://vercel.com/docs/environment-variables/managing-environment-variables" },
  { id: "netlify", files: ["netlify.toml"], label: "Netlify", where: "Project configuration → Environment variables", docs: "https://docs.netlify.com/build/environment-variables/get-started/" },
  { id: "fly", files: ["fly.toml"], label: "Fly.io", where: "your app's secrets (fly secrets set)", docs: "https://docs.fly.io/apps/secrets/" },
  { id: "cloudflare", files: ["wrangler.toml", "wrangler.json", "wrangler.jsonc"], label: "Cloudflare", where: "Workers & Pages → your Worker → Settings → Variables and Secrets → Add", docs: "https://developers.cloudflare.com/workers/configuration/secrets/" },
  { id: "render", files: ["render.yaml"], label: "Render", where: "your service → Environment → Add Environment Variable", docs: "https://docs.render.com/docs/configure-environment-variables" },
  { id: "railway", files: ["railway.json", "railway.toml"], label: "Railway", where: "your service → Variables tab → New Variable", docs: "https://docs.railway.com/guides/variables" },
  { id: "docker", files: ["Dockerfile"], label: "your server", where: "the server's environment (for Docker, the variables you pass when starting the container)", docs: null },
];
const UNKNOWN = { id: "unknown" as const, label: "your host", where: "your host's environment-variable settings", docs: null };

/**
 * Which host the app deploys to, from the files each host's own tooling writes. This is inferred from files, not
 * confirmed with the host, which is why the wizard only uses it to choose instructions and a key name, never to change
 * anything on the host by itself. In order:
 * 1. a Vercel CLI link (.vercel/project.json) in the app folder: the strongest sign there is (someone ran
 *    `vercel link` there), and the wizard may offer to set the variables, so the Host line and the Vercel question
 *    agree;
 * 2. another host's own file in the app folder (netlify.toml, fly.toml, wrangler.*, render.yaml, railway.*): the root
 *    of a monorepo may belong to another app, so it never overrides what the app folder says;
 * 3. a Vercel CLI link at the workspace root: a monorepo is often linked once there, and the Vercel CLI must then run
 *    in that folder (`vercelDir`);
 * 4. any remaining file (vercel.json, a Dockerfile), in the app folder, then at the root.
 * vercel.json alone is configuration, not a CLI link, so it leaves vercelDir null.
 * Cloudflare counts only when nothing contradicts it: beside another host's file or link anywhere from the app folder up
 * to the top of the repository (otherHostFile), wrangler's config is not taken to name the host unless the app's is a
 * Pages config (pages_build_output_dir: Pages, whatever else is there). The other host's file then decides, and where
 * it is not one this list has instructions for (a Procfile, a Compose file, a link in a folder in between), the host is
 * not detected.
 */
export function detectHost(appDir: string, root: string): Host {
  const dirs = appDir === root ? [appDir] : [appDir, root];
  const linked = (d: string) => existsSync(join(d, ".vercel", "project.json"));
  const found = (h: (typeof HOSTS)[number], vercelDir: string | null): Host => ({ id: h.id, label: h.label, where: h.where, docs: h.docs, vercelDir });
  const vercel = HOSTS.find((h) => h.id === "vercel")!;
  if (linked(appDir)) return found(vercel, appDir);
  const cloudflare = HOSTS.find((h) => h.id === "cloudflare")!;
  const wrangler = dirs.some((d) => cloudflare.files.some((f) => existsSync(join(d, f))));
  const contradicted = wrangler && wranglerOf(readText(appDir))?.pages !== true && otherHostFile(appDir, root) !== null;
  const hosts = contradicted ? HOSTS.filter((h) => h !== cloudflare) : HOSTS;
  const own = hosts.find((h) => h.id !== "vercel" && h.id !== "docker" && h.files.some((f) => existsSync(join(appDir, f))));
  if (own) return found(own, null);
  if (root !== appDir && linked(root)) return found(vercel, root);
  for (const d of dirs) {
    const h = hosts.find((x) => x.files.some((f) => existsSync(join(d, f))));
    if (h) return found(h, null);
  }
  return unknownHost();
}

/** The host when no file says (or the evidence conflicts): "your host", with no instructions of its own. */
export const unknownHost = (): Host => ({ ...UNKNOWN, vercelDir: null });

// The files and links of every host but Cloudflare: a Vercel link of any kind (.vercel/ holds project.json, or repo.json
// for `vercel link --repo`), vercel.json, its earlier name now.json, and the other config files Vercel reads (vercel.ts,
// .mts, .js, .mjs, .cjs, .toml), each other host's own file (HOSTS), Netlify's netlify/ folder (where its functions and
// edge functions live), and what builds or runs the app as a container or a process elsewhere: a Dockerfile under
// another name (Dockerfile.prod, Containerfile), a Compose file (compose.yaml, compose.yml, docker-compose.yaml,
// docker-compose.yml), a Procfile (Heroku and the platforms that read one), nixpacks.toml (the Nixpacks builder), the
// Serverless Framework's serverless.yml or serverless.yaml, and app.yaml (Google App Engine's, among others). The
// container files name a container ("docker"); a Procfile, nixpacks.toml, a Serverless Framework file or app.yaml names
// no platform this list has instructions for.
const OTHER_HOST_FILES: Array<[string, HostId]> = [
  [".vercel", "vercel"], ["vercel.json", "vercel"], ["now.json", "vercel"], ...VERCEL_CONFIGS.map((f): [string, HostId] => [f, "vercel"]),
  ...HOSTS.filter((h) => h.id !== "vercel" && h.id !== "cloudflare").flatMap((h) => h.files.map((f): [string, HostId] => [f, h.id])),
  ["netlify", "netlify"],
  ["Containerfile", "docker"], ["docker-compose.yml", "docker"], ["docker-compose.yaml", "docker"], ["compose.yml", "docker"], ["compose.yaml", "docker"],
  ["Procfile", "unknown"], ["nixpacks.toml", "unknown"], ["serverless.yml", "unknown"], ["serverless.yaml", "unknown"], ["app.yaml", "unknown"],
];
// A Dockerfile for one use, under the name `docker build -f` is given: Dockerfile.prod, Dockerfile.dev.
const DOCKERFILE_FOR = /^Dockerfile\../;

/** The first file or link of a host other than Cloudflare (OTHER_HOST_FILES, and a Dockerfile.<name>) in the app folder
 * or any folder above it up to the top of the repository (repoTopOf: the nearest .git above, never below the workspace
 * root): its path from the app folder ("../../vercel.json") and the host it names; null when there is none. A monorepo
 * is often linked or set up once at its root (vercel.json, netlify.toml with a base, `vercel link --repo`), and a
 * folder in between can hold a Vercel link too. An entry the wizard cannot open counts: it is there; so does a folder
 * it cannot list, where a Dockerfile.<name> could be. */
export function otherHostFile(appDir: string, root: string): { path: string; host: HostId } | null {
  const top = repoTopOf(appDir, root);
  const there = (p: string) => { try { lstatSync(p); return true; } catch { return false; } };
  const at = (d: string, name: string) => relative(appDir, join(d, name)).split(sep).join("/");
  for (let d = appDir; ; d = dirname(d)) {
    const hit = OTHER_HOST_FILES.find(([f]) => there(join(d, f)));
    if (hit) return { path: at(d, hit[0]), host: hit[1] };
    let names: string[];
    try { names = readdirSync(d).sort(); }
    catch { return { path: at(d, "") || ".", host: "unknown" }; }
    const named = names.find((n) => DOCKERFILE_FOR.test(n));
    if (named) return { path: at(d, named), host: "docker" };
    if (d === top || dirname(d) === d) return null;
  }
}

/**
 * Whether every host file says the app deploys to Cloudflare: detectHost names Cloudflare (wrangler's config in the app
 * folder), and no other host's file or link is in the app folder or any folder above it up to the top of the
 * repository (otherHostFile). An Express server under wrangler is taken for a Worker (its local variables are
 * wrangler's) only then. Inferred from files, so anything that points elsewhere ends it; it chooses notes, never
 * whether a Vite build is checked (apps.ts checks it on every host).
 */
export function onlyCloudflare(appDir: string, root: string): boolean {
  return detectHost(appDir, root).id === "cloudflare" && otherHostFile(appDir, root) === null;
}

/** The Vercel entry, for a site linked at `vercelDir`, or one the developer says is on Vercel (vercelDir null: no CLI
 * link, so no automation, and the hand-off is used). */
export function vercelHost(vercelDir: string | null): Host {
  const v = HOSTS.find((h) => h.id === "vercel")!;
  return { id: v.id, label: v.label, where: v.where, docs: v.docs, vercelDir };
}

/** The host as it appears in a key's name: "Netlify", or "Server" when the host is not known. */
export const keyHostName = (host: Host): string => (host.label === "your host" || host.label === "your server" ? "Server" : host.label);

/** The dashboard page that creates the production key, with its name filled in ("Netlify · production"; in a run with
 * several apps, "web · Netlify · production") and its access preselected (scope=fetch): "Crawler reports only", like
 * every key the wizard creates itself, since a host often gives its build the same variables. The dashboard shows the
 * new key once, for pasting into the host. */
export const handoffUrl = (dashboard: string, siteId: string, host: Host, name = `${keyHostName(host)} · production`): string =>
  `${dashboard}/sites/${encodeURIComponent(siteId)}?newKey=${encodeURIComponent(name)}&scope=fetch#keys`;

/** How every local key's name starts. */
export const LOCAL_KEY_PREFIX = "local dev · ";

/** "local dev · <computer>": plain characters only, so the gateway's name rules (1–80 characters, no control
 * characters, after it adds "wizard · ") always accept it. */
export function localKeyName(hostname: string): string {
  const safe = hostname.replace(/\s+/g, "-").replace(/[^A-Za-z0-9._-]/g, "").slice(0, 40);
  return `${LOCAL_KEY_PREFIX}${safe || "this computer"}`;
}

/** What wrangler's config (wrangler.jsonc, wrangler.json, then wrangler.toml) says: the file the Worker runs, whether it
 * is a Pages project (pages_build_output_dir), and the custom build command ([build] command, its dotted key, or the
 * inline table `build = { command = … }`), or null. null: no wrangler config. */
export interface Wrangler { main: string | null; pages: boolean; build: string | null }
export function wranglerOf(read: (rel: string) => string | null): Wrangler | null {
  const json = readJsonc(read("wrangler.jsonc") ?? read("wrangler.json"));
  if (json) return { main: typeof json.main === "string" ? json.main : null, pages: typeof json.pages_build_output_dir === "string", build: typeof json.build?.command === "string" ? json.build.command : null };
  const toml = read("wrangler.toml");
  if (toml === null) return null;
  const value = (re: RegExp, text: string) => { const m = re.exec(text); return m ? (m[2] ?? m[3] ?? "") : null; };
  const STRING = String.raw`\s*=\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)')`;
  // [build]'s table (up to the next [table]), a dotted key at the top, or an inline table.
  const table = /^[ \t]*\[build\][ \t]*(?:#.*)?$([\s\S]*?)(?=^[ \t]*\[|(?![\s\S]))/m.exec(toml)?.[1] ?? "";
  const inline = /^\s*build\s*=\s*\{([^}\n]*)\}/m.exec(toml)?.[1] ?? "";
  const build = value(new RegExp(String.raw`^(\s*)command${STRING}`, "m"), table) ?? value(new RegExp(String.raw`^(\s*)build\.command${STRING}`, "m"), toml) ?? value(new RegExp(String.raw`(^|[{,\s])command${STRING}`), inline);
  return { main: /^\s*main\s*=\s*["']([^"']+)["']/m.exec(toml)?.[1] ?? null, pages: /^\s*pages_build_output_dir\s*=/m.test(toml), build };
}

/** On Cloudflare Workers the key is a runtime secret. Workers Builds keeps "environment variables and secrets
 * accessible only to your build" apart: "Build variables will not be accessible at runtime", and runtime ones are set in
 * Settings > Variables & Secrets (developers.cloudflare.com/workers/ci-cd/builds/configuration/, opened 2026-10-01).
 * Only the Worker reads the key, so it goes where only the Worker sees it, not in the build (whose Vite build the wizard
 * checks anyway, apps.ts). Said for Hono's Cloudflare Workers target (integrations/hono.ts), so never for Pages, whose
 * dashboard variables apply "at runtime and build-time" (developers.cloudflare.com/pages/functions/bindings/, opened
 * 2026-10-01). */
export const WORKERS_RUNTIME_SECRET = "Add PARLOX_SECRET_KEY as a runtime secret under Settings → Variables & Secrets, not as a build variable.";
