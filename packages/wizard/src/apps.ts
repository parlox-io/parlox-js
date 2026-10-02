import { existsSync, realpathSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { detectHost, unknownHost, type Host } from "./hosts.js";
import { appFile, appName, type RunNames } from "./names.js";
import { INTEGRATIONS, integrationOf } from "./integrations/registry.js";
import { folderViteCheck, folderViteNamesSecretKey, secretExposureOf, type ViteData } from "./integrations/vite-react.js";
import { viteVerifyServed } from "./integrations/express-static.js";
import type { ExpressData } from "./integrations/express.js";
import { denoProject, type HonoData } from "./integrations/hono.js";
import { whyOn, type SecretExposure } from "./edits/vite-exposure.js";
import { yarnReleaseNote } from "./edits/vite-install.js";
import { OWN_REPORT_KIND } from "./own-reporting.js";
import type { Detection, Integration, IntegrationId, PlanIo } from "./integrations/types.js";
import { combinePlans, declared, emptyPlan, overlayReader, type Plan } from "./plan-core.js";
import type { Ui } from "./ui/types.js";
import { BROWSER_VERSION, SERVER_VERSION } from "./versions.js";
import { DetectError, findRoot, GUIDE, hasWorkspaces, workspaceDirs } from "./workspace.js";

// An app unit is one folder the wizard installs into, with every integration that matched it. A folder matched by two
// integrations is one app with both parts: a Vite build served by the same package's Express server gets the browser
// part in the Vite entry and the server part in the Express file.

export interface AppUnit {
  dir: string;
  root: string;
  /** The folder relative to the run's base, "/"-separated; "." for the base itself. */
  rel: string;
  detections: Detection[];
  /** The detection that plans the browser part, and the one that plans the server part (null: this app has none). */
  browser: Detection | null;
  server: Detection | null;
  /** What another integration refused in this folder while one matched (an app beside it the wizard cannot cover), a
   * server part withheld because a Vite build could bundle its key (or the wizard could not check), and that a host's
   * dashboard is not visible: for the review and the report, kept, never dropped. */
  warnings: string[];
  /** The server part the wizard did not plan because a Vite build could bundle its key (or the wizard could not prove
   * it does not): its detection and why, and, for Express 4 serving the Vite React build of the same folder, the folder
   * it serves the ownership file from (express-static.ts), so the Vite app's ownership file is planned. null: nothing
   * was withheld. */
  withheld: { detection: Detection; exposure: SecretExposure; verifyFrom?: string } | null;
  /** Whether the server part the wizard plans sits beside a Vite build of this folder (or one below it) that the guard
   * checked and let the key through: a build there reads the host's variables too, so a key already set on the host
   * is one to check (cli.ts). */
  viteBeside?: boolean;
}

export interface Scan {
  root: string;
  /** What the run's paths are relative to: the folder the wizard was started in. */
  base: string;
  units: AppUnit[];
  /** Folders with an app of a covered stack the wizard cannot install into, and why. */
  problems: Array<{ rel: string; error: DetectError }>;
  /** Whether any folder looked at had a package.json. */
  sawPackage: boolean;
}

// Which integration's part wins when two match one folder: the browser part from the frontend's own entry, the server
// part from the server framework. Next.js is always alone (its middleware is its server part).
const BROWSER_ORDER: IntegrationId[] = ["nextjs", "vite-react", "hono", "express"];
const SERVER_ORDER: IntegrationId[] = ["nextjs", "express", "hono", "vite-react"];
const pick = (found: Detection[], order: IntegrationId[], part: "browser" | "server"): Detection | null => {
  for (const id of order) {
    const d = found.find((x) => x.integration === id && x.parts[part]);
    if (d) return d;
  }
  return null;
};
const relOf = (base: string, dir: string) => relative(base, dir).split(sep).join("/") || ".";
/** A folder in a list shown to the developer: the base itself is "./", as describeUnit writes it. */
const shown = (rel: string) => (rel === "." ? "./" : rel);
const listOf = (rels: string[]) => rels.map(shown).join(", ");

export const labelOf = (d: Pick<Detection, "integration">): string => INTEGRATIONS.find((i) => i.id === d.integration)?.label ?? d.integration;
const labels = () => INTEGRATIONS.map((i) => i.label).join(", ");

/** Every integration's detect on one folder (`integrations`: the registry; a test passes its own). A Next.js app is one
 * app, as before, whatever else it depends on. When nothing matches and an integration refused the folder (an old
 * Next.js, NestJS), the first refusal is thrown; when something matches, every refusal becomes a warning. */
export function detectFolder(dir: string, root: string, integrations: Integration[] = INTEGRATIONS): { found: Detection[]; warnings: string[] } {
  if (!existsSync(join(dir, "package.json"))) return { found: [], warnings: [] };
  const found: Detection[] = [];
  const refusals: Array<{ label: string; error: DetectError }> = [];
  for (const integration of integrations) {
    let d: Detection | null;
    try { d = integration.detect(dir, root); }
    catch (err) {
      if (err instanceof DetectError) { refusals.push({ label: integration.label, error: err }); continue; }
      throw err;
    }
    if (!d) continue;
    if (d.integration === "nextjs") { found.splice(0, found.length, d); break; }
    found.push(d);
  }
  if (!found.length && refusals.length) throw refusals[0].error;
  return { found, warnings: refusals.map((r) => `${r.label}: ${r.error.message}`) };
}

const capital = (s: string) => `${s[0].toUpperCase()}${s.slice(1)}`;
/** Why a server part beside a Vite build that could bundle the key is not added, in the words of the Vite note. Off
 * Vercel (another host, or none detected), a reason taken from what Vercel would run is said without naming Vercel. */
const withheldNote = (d: Detection, e: SecretExposure, host: Host): string =>
  `${labelOf(d)}: no server part was added. ${whyOn(e, host.id === "vercel")} A PARLOX_SECRET_KEY set on the host for this server could also reach this folder's Vite build (hosts usually give the build the same variables). ${capital(e.fix)}${e.byHand ? "." : " and run the wizard again to add the server part."}`;

/** What the review and the report say about a key beside a Vite app: the wizard reads the build commands in files only. */
const dashboardNote = (d: Detection): string =>
  `${labelOf(d)}: the wizard read the build commands in package.json, vercel.json and netlify.toml, but build and install commands set in your host's dashboard (on Vercel: the Build Command, Install Command and Ignored Build Step) are not visible to it. If one of them runs a Vite build or other build code, make sure it cannot read PARLOX_SECRET_KEY: see ${GUIDE}`;

// The server integrations whose key would sit on the same host as a Vite build in their folder.
const BESIDE_VITE = new Set<IntegrationId>(["express", "hono"]);
/** Express only in devDependencies, beside a Vite React app: a dev helper (a Vite dev server, a mock API), not what
 * serves the site. */
const devHelper = (d: Detection, found: Detection[]): boolean =>
  d.integration === "express" && (d.data as ExpressData).devOnly && found.some((x) => x.integration === "vite-react");

/** The host the run names for an app (cli.ts), and the one the withheld note is worded for: detectHost, from the files
 * each host's tooling writes, and Cloudflare only where the app's server part does not say otherwise. A Hono server part
 * whose target is not Cloudflare Workers or Pages (its code imports hono/vercel, it depends on @hono/node-server, Bun
 * runs it…) is not on Cloudflare, though wrangler's config is the only host file there: its code and its dependencies,
 * which detectHost does not read, contradict it, and nothing says where it runs instead, so the host is not detected. */
export function hostOf(dir: string, root: string, server: Detection | null): Host {
  const host = detectHost(dir, root);
  if (host.id !== "cloudflare" || server?.integration !== "hono") return host;
  const target = (server.data as HonoData).target;
  return target === "cloudflare-workers" || target === "cloudflare-pages" ? host : unknownHost();
}
/** hostOf for an app unit: its server part, planned or withheld. */
export const unitHost = (u: AppUnit): Host => hostOf(u.dir, u.root, u.server ?? u.withheld?.detection ?? null);

export function unitOf(dir: string, root: string, base: string, found: Detection[], warnings: string[] = []): AppUnit {
  const server = pick(found.filter((d) => !devHelper(d, found)), SERVER_ORDER, "server");
  // Security: a key set on the host is present when this folder's Vite build runs too,
  // whatever the framework on Vite (Vue, Svelte, React Router…). Where that build could bundle PARLOX_SECRET_KEY, or
  // the wizard cannot prove it does not, no server part, key or host step is planned for a server integration here
  // (Vite's own server part already leaves out the key). An app that reports with its own code gets none of them anyway.
  // The same check on every host, Cloudflare Workers included: that an app runs only as a Worker, whose runtime secrets
  // the build does not see, cannot be read from its files (Workers Builds and other Git-connected hosts leave no trace
  // in the repository), and the key the wizard creates can only send crawler reports anyway.
  const guarded = !!server && BESIDE_VITE.has(server.integration) && server.parts.server?.kind !== OWN_REPORT_KIND;
  const check = guarded ? folderViteCheck(dir, root) : null;
  // A Vite config that reads PARLOX_SECRET_KEY by name withholds the key wherever it is, with Vite declared and run or
  // not.
  const named = guarded ? folderViteNamesSecretKey(dir) : null;
  const exposure = named ?? (check ? secretExposureOf(found) ?? check.exposure : null);
  const browser = pick(found, BROWSER_ORDER, "browser");
  // A withheld Express server that serves this folder's Vite React build: the ownership file can prove the domain.
  const served = exposure && server!.integration === "express" && browser?.integration === "vite-react" ? viteVerifyServed(dir, server!.data as ExpressData, browser.data as ViteData) : null;
  const vite = browser?.data as ViteData | undefined;
  const verifyNote = served ? [`${labelOf(server!)}: the ownership file goes in ${vite!.publicDir}/.well-known/parlox-verify: Express 4 serves ${served.folder}/ (express.static in ${served.serverFile})${served.folder === vite!.publicDir ? "." : ", where Vite copies the public folder when it builds."}`] : [];
  // The host the run will detect for this app (cli.ts), for the wording only.
  // Beside the dashboard note: each Yarn release file the guard allowed by its location, not by reading it.
  const notes = exposure ? [withheldNote(server!, exposure, hostOf(dir, root, server)), ...verifyNote] : check?.seen ? [dashboardNote(server!), ...(check.yarnReleases ?? []).map((r) => `${labelOf(server!)}: ${yarnReleaseNote(r)}`)] : [];
  return {
    dir, root, rel: relOf(base, dir), detections: found, browser,
    server: exposure ? null : server,
    warnings: [...warnings, ...notes],
    withheld: exposure ? { detection: server!, exposure, ...(served ? { verifyFrom: served.folder } : {}) } : null,
    ...(!exposure && check?.seen ? { viteBeside: true } : {}),
  };
}

/**
 * The apps to choose from, read only. Started inside one package of a monorepo: that package only, as before. Started
 * at a workspace root: the root and every workspace package. Elsewhere: the folder itself. Sorted by folder.
 */
export function scanApps(cwd: string, integrations: Integration[] = INTEGRATIONS): Scan {
  const root = findRoot(cwd);
  const base = cwd;
  const folders = root === cwd && hasWorkspaces(root) ? [".", ...workspaceDirs(root)] : ["."];
  const units: AppUnit[] = [];
  const problems: Scan["problems"] = [];
  let sawPackage = false;
  for (const rel of folders) {
    const dir = rel === "." ? cwd : join(root, rel);
    if (!existsSync(join(dir, "package.json"))) {
      // A Deno project has no package.json: it is said to be not covered, not that there is no project here.
      const deno = denoProject(dir);
      if (deno) problems.push({ rel: relOf(base, dir), error: deno });
      continue;
    }
    sawPackage = true;
    try {
      const { found, warnings } = detectFolder(dir, root, integrations);
      if (found.length) units.push(unitOf(dir, root, base, found, warnings));
    } catch (err) {
      if (!(err instanceof DetectError)) throw err;
      problems.push({ rel: relOf(base, dir), error: err });
    }
  }
  units.sort((a, b) => (a.rel === "." ? -1 : b.rel === "." ? 1 : a.rel.localeCompare(b.rel)));
  const onePerProblem = onePerFolder(problems.map((p) => ({ ...p, dir: join(base, p.rel) })), base).map(({ rel, error }) => ({ rel, error }));
  return { root, base, units: onePerFolder(units, base), problems: onePerProblem, sawPackage };
}

const realOf = (dir: string): string => { try { return realpathSync(dir); } catch { return dir; } };

/** One entry per real folder: two workspace entries can reach the same folder (a symlink both globs match), and it is
 * one app, installed once. The entry whose path is the folder's own (reached without a symlink) is kept, else the
 * first. `rel` is relative to `base`. */
function onePerFolder<T extends { dir: string; rel: string }>(items: T[], base: string): T[] {
  const realBase = realOf(base);
  const direct = (item: T) => realOf(item.dir) === (item.rel === "." ? realBase : join(realBase, item.rel));
  const byReal = new Map<string, T>();
  for (const item of items) {
    const real = realOf(item.dir);
    const kept = byReal.get(real);
    if (!kept || (!direct(kept) && direct(item))) byReal.set(real, item);
  }
  return items.filter((item) => byReal.get(realOf(item.dir)) === item);
}

function nothingFound(scan: Scan): DetectError {
  if (scan.problems.length === 1) return scan.problems[0].error;
  if (scan.problems.length) return new DetectError("no-app", `No app here can take Parlox:\n${scan.problems.map((p) => `  ${shown(p.rel)}: ${p.error.message}`).join("\n")}`);
  if (!scan.sawPackage) return new DetectError("no-package-json", "No package.json here. Run the wizard in your project's folder.");
  return scan.base === scan.root && hasWorkspaces(scan.root)
    ? new DetectError("no-app", `No app the wizard supports (${labels()}) was found in this folder or its workspaces. For other stacks see ${GUIDE}`)
    : new DetectError("not-supported", `This project does not use a stack the wizard supports (${labels()}). For other stacks see ${GUIDE}`);
}

function byFlag(scan: Scan, wanted: string[]): AppUnit[] {
  const out: AppUnit[] = [];
  for (const w of wanted) {
    const rel = relOf(scan.base, resolve(scan.base, w));
    // A folder named by a link to an app's folder is that app.
    const u = scan.units.find((x) => x.rel === rel) ?? scan.units.find((x) => realOf(x.dir) === realOf(resolve(scan.base, w)));
    if (!u) {
      const problem = scan.problems.find((p) => p.rel === rel);
      if (problem) throw problem.error;
      throw new DetectError("app-not-found", `--app ${w}: no app the wizard supports there. Apps found: ${listOf(scan.units.map((x) => x.rel)) || "none"}.`);
    }
    if (!out.includes(u)) out.push(u);
  }
  return out;
}

/**
 * Which apps this run covers. --app folders are taken as given (repeatable, in that order). Otherwise one app needs no
 * question; several are offered in a multi-select with every app selected, so one run can cover them all (PostHog's
 * wizard also scans a monorepo and offers its projects, but picks one per run: SelfDrivingIntegrationDetectScreen.tsx).
 * With no terminal the face refuses the question at once, and the hint says what to pass.
 */
export async function selectUnits(scan: Scan, wanted: string[], ui: Pick<Ui, "multiselect">, mode: "install" | "uninstall"): Promise<AppUnit[]> {
  if (wanted.length) return byFlag(scan, wanted);
  if (scan.units.length === 1) return scan.units;
  if (!scan.units.length) throw nothingFound(scan);
  const question = mode === "install" ? "Which apps should Parlox be installed in?" : "Which apps should Parlox be removed from?";
  const hint = `Run it from the app's own folder, or pass --app <folder> for each app to include (${listOf(scan.units.map((u) => u.rel))}).`;
  const chosen = await ui.multiselect(question, scan.units.map((u) => ({ value: u.rel, label: describeUnit(u) })), hint);
  const units = scan.units.filter((u) => chosen.includes(u.rel));
  // Both faces keep at least one selected; an answer with none (or only values never offered) is refused here too, so
  // the run never goes on with nothing to do.
  if (!units.length) throw new DetectError("declined", "No app was chosen. Choose at least one, or pass --app <folder>.");
  return units;
}

/** "web/ · Vite React · browser part (server part on Vercel)", "api/ · Express · server part". */
export function describeUnit(u: AppUnit): string {
  const folder = u.rel === "." ? "./" : `${u.rel}/`;
  const names = [...new Set(u.detections.map(labelOf))].join(" + ");
  const server = u.server?.parts.server ?? null;
  let parts: string;
  if (u.browser && server) {
    parts = server.kind === "vercel-edge" ? "browser part (server part on Vercel)"
      : server.kind === "verify-file" ? "browser part only (static site)"
      : server.kind === "host-question" ? "browser part (server part if it deploys on Vercel)"
      : server.kind === OWN_REPORT_KIND ? "browser part (its server reports to Parlox with its own code)"
      : "browser and server parts";
  } else parts = u.browser ? "browser part" : server ? (server.kind === OWN_REPORT_KIND ? "no server part (it reports to Parlox with its own code)" : "server part") : "nothing to add";
  return `${folder} · ${names} · ${parts}`;
}

/** The fact lines for the detect step: one app shows its integrations' own lines; several show one line each. */
export function unitFacts(u: AppUnit, single: boolean): Array<[string, string]> {
  return single ? u.detections.flatMap((d) => d.facts) : [["App", describeUnit(u)]];
}

/** What this run does not cover, for the review and the report: each app the wizard found but cannot install into
 * (`problems`, when the apps were not named with --app), and what another integration refused inside a chosen app
 * (named by its folder when the run has several apps). */
export function coverageNotes(problems: Scan["problems"], units: AppUnit[], names: RunNames): string[] {
  return [
    ...problems.map((p) => `${names.folder(p.rel)} is not included: ${p.error.message}`),
    ...units.flatMap((u) => u.warnings.map((w) => names.note(u, w))),
  ];
}

export interface UnitInput { publicKey: string; verifyToken: string; host: Host; shown?(rel: string): string }

/** One app's plan: the browser part from its browser detection, the server part from its server detection. The second
 * integration reads the first one's changes, so a file both touch is changed once, in order. */
export function planUnit(u: AppUnit, input: UnitInput, io: PlanIo): Plan {
  const steps: Array<{ d: Detection; parts: { browser: boolean; server: boolean; verifyFile?: boolean } }> = [];
  if (u.browser) steps.push({ d: u.browser, parts: { browser: true, server: u.server === u.browser, ...(u.withheld?.verifyFrom ? { verifyFile: true } : {}) } });
  if (u.server && u.server !== u.browser) steps.push({ d: u.server, parts: { browser: false, server: true } });
  let plan = emptyPlan();
  for (const s of steps) {
    const next = integrationOf(s.d).plan(s.d, { ...input, versions: { browser: BROWSER_VERSION, server: SERVER_VERSION }, parts: s.parts, read: overlayReader(io.read, plan), git: io.git });
    plan = combinePlans(plan, next);
  }
  return plan;
}

/** What to remove from one app: every integration that matched it, in turn. Each is told which files the others edit
 * (their server files), so the wizard's own lines there do not keep @parlox/server installed; a note two of them give
 * (the package stays, say) is said once. */
export function unplanUnit(u: AppUnit, io: PlanIo): Plan {
  let plan = emptyPlan();
  for (const d of u.detections) {
    const others = u.detections.filter((x) => x !== d).map((x) => x.parts.server?.file).filter((f): f is string => !!f);
    plan = combinePlans(plan, integrationOf(d).unplan(d, { read: overlayReader(io.read, plan), git: io.git, shown: io.shown, others }));
  }
  return { ...plan, warnings: [...new Set(plan.warnings)] };
}

/** Whether an uninstall plan (unplanUnit) shows that Parlox is in the app: something to change or remove, a step by
 * hand in a file the wizard read that holds Parlox's line, or a @parlox/* dependency in its package.json (`read`, the
 * app's reader). A step by hand in a file the wizard could not read (`unread`: a link to a shared .env, say) is not
 * evidence by itself: an app that never had Parlox has nothing to remove. */
export function parloxIn(plan: Plan, read: (rel: string) => string | null): boolean {
  if (plan.changes.length || plan.install || plan.manual.some((m) => !m.unread)) return true;
  try { return Object.keys(declared(read)).some((name) => name.startsWith("@parlox/")); }
  catch { return false; }
}

/** The steps by hand of an app without Parlox (parloxIn), as notes: each file the wizard could not read, and why. */
export const unreadNotes = (u: AppUnit, plan: Plan): string[] => plan.manual.filter((m) => m.unread).map((m) => `${appFile(u, m.file)}: ${m.reason}`);

/** Several apps' plans as one review: paths relative to the run's base, one package step per app. */
export function mergePlans(parts: Array<{ unit: AppUnit; plan: Plan }>): Plan {
  const out: Plan = { changes: [], install: null, manual: [], warnings: [], installs: [] };
  for (const { unit, plan } of parts) {
    out.changes.push(...plan.changes.map((c) => ({ ...c, path: appFile(unit, c.path), ...(c.removeEmptyDirs ? { removeEmptyDirs: c.removeEmptyDirs.map((d) => appFile(unit, d)) } : {}) })));
    out.manual.push(...plan.manual.map((m) => ({ ...m, file: m.placeholder ? `${m.file} in ${appName(unit)}` : appFile(unit, m.file) })));
    out.warnings.push(...plan.warnings.map((w) => `${appName(unit)}: ${w}`));
    if (plan.install) out.installs!.push({ dir: appName(unit), ...plan.install });
  }
  return out;
}

// Key names live with the run's other names (names.ts).
export { keyLabel, localKeyLabel } from "./names.js";

/** Whether this app's server part needs PARLOX_SECRET_KEY on its host (the host step). */
export function hostStepFor(u: AppUnit, host: Host): boolean {
  if (!u.server) return false;
  const i = integrationOf(u.server);
  return i.hostStep ? i.hostStep(u.server, host) : true;
}
