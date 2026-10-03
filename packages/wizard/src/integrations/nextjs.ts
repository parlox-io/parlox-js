import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Git } from "../git.js";
import { addBrowser, removeBrowser } from "../edits/browser.js";
import { addServer, removeServer } from "../edits/server.js";
import { addGitignoreLine, setEnvValue } from "../edits/env.js";
import { declared, packageCommand, type Plan } from "../plan-core.js";
import { packagesToAdd } from "../pins.js";
import { BROWSER_VERSION, SERVER_VERSION } from "../versions.js";
import { DetectError, GUIDE, installedMajor, packageManagerOf, readJson, workspaceDirs, workspaceGlobs, type PackageManager } from "../workspace.js";
import { ignoreRefusedReason, readEnvFile, readOrRefusal, refusedEnvReason, trackedEnvReason, unplanEnv } from "../envfiles.js";
import { serverPackageKept } from "../sdk-use.js";
import type { Detection, Integration, PlanIo } from "./types.js";

// Next.js: the root layout (App Router) or _app (Pages Router) gets the browser part, the middleware (proxy.* from
// Next.js 16) the server part, and .env.local the verify token. The detection and the plan are the ones the wizard had
// before integrations existed, moved here unchanged.

export interface NextApp {
  dir: string;
  root: string;
  nextMajor: number;
  typescript: boolean;
  srcDir: boolean;
  packageManager: PackageManager;
  layoutFile: string | null;
  appFile: string | null;
  middlewareFile: string | null;
  middlewareTarget: string;
}

const EXTS = ["tsx", "ts", "jsx", "js"];

const firstExisting = (dir: string, base: string, exts = EXTS) => {
  for (const e of exts) if (existsSync(join(dir, `${base}.${e}`))) return `${base}.${e}`;
  return null;
};
const hasNext = (pkg: Record<string, any>) => Boolean(pkg.dependencies?.next || pkg.devDependencies?.next);

const nextMajorOf = (dir: string, pkg: Record<string, any>): number | null => installedMajor(dir, pkg, "next");

export function detectApp(dir: string, root = dir): NextApp {
  const pkgPath = join(dir, "package.json");
  if (!existsSync(pkgPath)) throw new DetectError("no-package-json", "No package.json here. Run the wizard in your Next.js project's folder.");
  const pkg = readJson(pkgPath);
  if (!hasNext(pkg)) throw new DetectError("not-next", `This project does not use Next.js. The wizard supports Next.js; for other stacks see ${GUIDE}`);
  const nextMajor = nextMajorOf(dir, pkg);
  if (nextMajor === null) throw new DetectError("unknown-next", "Could not tell which Next.js version this project uses. Install dependencies first (npm install), then run the wizard again.");
  if (nextMajor < 13) throw new DetectError("old-next", `Next.js ${nextMajor} is not supported by the wizard (13 or later). See ${GUIDE}`);
  const packageManager = packageManagerOf(dir, root);

  const srcDir = existsSync(join(dir, "src", "app")) || existsSync(join(dir, "src", "pages"));
  const base = srcDir ? "src/" : "";
  const layoutFile = firstExisting(dir, `${base}app/layout`);
  const appFile = firstExisting(dir, `${base}pages/_app`);
  if (!layoutFile && !appFile) throw new DetectError("no-entry", `No ${base}app/layout or ${base}pages/_app file found. Add one, or follow ${GUIDE}`);

  const typescript = existsSync(join(dir, "tsconfig.json"));
  // Next.js only runs `proxy.*` starting with version 16; on 13-15 it is an ordinary file (a helper
  // wrapped by a real `middleware.*` beside it, say) and must not be mistaken for the middleware entry.
  const middlewareFile = (nextMajor >= 16 ? firstExisting(dir, `${base}proxy`, ["ts", "js"]) : null) ?? firstExisting(dir, `${base}middleware`, ["ts", "js"]);
  const middlewareTarget = middlewareFile ?? `${base}${nextMajor >= 16 ? "proxy" : "middleware"}.${typescript ? "ts" : "js"}`;
  return { dir, root, nextMajor, typescript, srcDir, packageManager, layoutFile, appFile, middlewareFile, middlewareTarget };
}

/** Folders (relative to root) of the Next.js apps: every workspace depending on next, or "." for a single app. */
export function findNextApps(root: string): string[] {
  if (workspaceGlobs(root).length === 0) return ["."];
  return workspaceDirs(root).filter((rel) => hasNext(readJson(join(root, rel, "package.json"))));
}

const ENV_FILE = ".env.local";
const VERIFY = "PARLOX_VERIFY_TOKEN";
const PACKAGES = ["@parlox/browser", "@parlox/server"];

/** `versions`: the versions to add (the ones this wizard pins when not given). */
export function installPlan(app: NextApp, input: { publicKey: string; verifyToken: string; shown?(rel: string): string; versions?: { browser: string; server: string } }, read: (rel: string) => string | null, git: Git): Plan {
  const plan: Plan = { changes: [], install: null, manual: [], warnings: [] };
  const change = (path: string, after: string | null) => { const before = read(path); if (before !== after) plan.changes.push({ path, before, after }); };

  const entry = app.layoutFile ? { file: app.layoutFile, kind: "layout" as const } : { file: app.appFile!, kind: "app" as const };
  const b = addBrowser(read(entry.file) ?? "", entry.file, entry.kind, input.publicKey);
  if (b.ok) { if (b.changed) change(entry.file, b.code); } else plan.manual.push({ file: entry.file, reason: b.reason, snippet: b.snippet });

  const s = addServer(app.middlewareFile ? read(app.middlewareFile) : null, app.middlewareTarget);
  if (s.ok) { if (s.changed) change(app.middlewareTarget, s.code); if (s.matcherWarning) plan.warnings.push(`${app.middlewareTarget}: ${s.matcherWarning}`); }
  else plan.manual.push({ file: app.middlewareTarget, reason: s.reason, snippet: s.snippet });

  // .env.local the wizard may not write (git tracks it, it is a link, or git does not ignore it yet and .gitignore is a
  // file the wizard may not read: a link, or over 1 MB) is a step by hand for this app, as for Express and Hono
  // (envfiles.ts), never the end of the run.
  const byHand = (reason: string) => plan.manual.push({ file: ENV_FILE, reason, snippet: `${VERIFY}=${input.verifyToken}` });
  const current = readEnvFile(read, ENV_FILE);
  if (git.isRepo() && git.isTracked(ENV_FILE)) byHand(trackedEnvReason(input.shown?.(ENV_FILE) ?? ENV_FILE));
  else if ("refused" in current) byHand(refusedEnvReason(current.refused));
  else {
    const ignore = git.isRepo() && !git.isIgnored(ENV_FILE) ? readOrRefusal(read, ".gitignore") : null;
    if (ignore && "refused" in ignore) byHand(ignoreRefusedReason(ignore.refused));
    else {
      const env = setEnvValue(current.text, VERIFY, input.verifyToken);
      if (env.changed) change(ENV_FILE, env.content);
      if (ignore) {
        const gi = addGitignoreLine(ignore.text, ENV_FILE);
        if (gi.changed) change(".gitignore", gi.content);
      }
    }
  }

  const versions = input.versions ?? { browser: BROWSER_VERSION, server: SERVER_VERSION };
  const pins = packagesToAdd(declared(read), [["@parlox/browser", versions.browser], ["@parlox/server", versions.server]]);
  if (pins.add.length) plan.install = packageCommand(app.packageManager, "add", pins.add);
  plan.warnings.push(...pins.notes);
  return plan;
}

export function uninstallPlan(app: NextApp, read: (rel: string) => string | null, git: Git, io: Pick<PlanIo, "shown" | "others"> = {}): Plan {
  const plan: Plan = { changes: [], install: null, manual: [], warnings: [] };
  const change = (path: string, after: string | null) => { const before = read(path); if (before !== after) plan.changes.push({ path, before, after }); };
  // A file it cannot parse that names no Parlox package: a step only if Parlox is there (uninstall, apps.ts parloxIn).
  const unread = (text: string) => (text.includes("@parlox/") ? {} : { unread: true });
  for (const file of [app.layoutFile, app.appFile].filter((f): f is string => !!f)) {
    const text = read(file) ?? "";
    const r = removeBrowser(text, file);
    if (r.ok) { if (r.changed) change(file, r.code); } else plan.manual.push({ file, reason: r.reason, snippet: r.snippet, ...unread(text) });
  }
  if (app.middlewareFile) {
    const text = read(app.middlewareFile) ?? "";
    const r = removeServer(text, app.middlewareFile);
    if (r.ok) { if (r.changed) change(app.middlewareFile, r.deleteFile ? null : r.code); } else plan.manual.push({ file: app.middlewareFile, reason: r.reason, snippet: r.snippet, ...unread(text) });
  }
  // The verify token, as for every stack (envfiles.ts): a PARLOX_SECRET_KEY line stays, and the review says why.
  const env = unplanEnv({ read, shown: io.shown, git }, ENV_FILE);
  plan.changes.push(...env.changes);
  plan.manual.push(...env.manual);
  plan.warnings.push(...(env.warnings ?? []));
  // @parlox/server stays while the app's own code imports it (purchase() in a route handler, say).
  const have = declared(read);
  const kept = have["@parlox/server"] ? serverPackageKept(app.dir, read, plan, app.packageManager, io.others) : null;
  if (kept) plan.warnings.push(kept);
  const present = PACKAGES.filter((p) => have[p] && !(kept && p === "@parlox/server"));
  if (present.length) plan.install = packageCommand(app.packageManager, "remove", present);
  return plan;
}

/** The Detection for a Next.js app: both parts (the root layout or _app, and the middleware), .env.local. */
export function nextDetection(app: NextApp): Detection {
  return {
    integration: "nextjs", dir: app.dir, root: app.root, packageManager: app.packageManager,
    parts: { browser: { file: app.layoutFile ?? app.appFile, kind: app.layoutFile ? "layout" : "app" }, server: { file: app.middlewareTarget, kind: "middleware" } },
    facts: [["Found", `Next.js ${app.nextMajor} · ${app.layoutFile ? "App Router" : "Pages Router"} · ${app.typescript ? "TypeScript" : "JavaScript"} · ${app.packageManager}`]],
    notes: [], envFile: ".env.local", localCheck: { url: "http://localhost:3000", start: "npm run dev" }, data: app,
  };
}

// Next.js always gets both parts (its middleware is the server part) and the versions this wizard pins; the plan is
// exactly the one the wizard made before integrations existed.
export const nextjs: Integration = {
  id: "nextjs",
  label: "Next.js",
  detect(dir, root) {
    const p = join(dir, "package.json");
    if (!existsSync(p) || !hasNext(readJson(p))) return null;
    return nextDetection(detectApp(dir, root));
  },
  plan: (d, input) => installPlan(d.data as NextApp, { publicKey: input.publicKey, verifyToken: input.verifyToken, shown: input.shown }, input.read, input.git),
  unplan: (d, io) => uninstallPlan(d.data as NextApp, io.read, io.git, io),
};
