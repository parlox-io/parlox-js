import { hostname } from "node:os";
import { coverageNotes, hostStepFor, parloxIn, planUnit, scanApps, selectUnits, unitFacts, unitHost, unplanUnit, unreadNotes, type AppUnit, type Scan } from "./apps.js";
import { appFile } from "./names.js";
import { applyRun, planRun, type RunPlan } from "./apply.js";
import { parseArgs, type Args } from "./args.js";
import type { CliDeps } from "./deps.js";
import { DetectError } from "./workspace.js";
import { integrationOf } from "./integrations/registry.js";
import { secretExposureOf } from "./integrations/vite-react.js";
import { whyOn } from "./edits/vite-exposure.js";
import { OWN_REPORT_KIND } from "./own-reporting.js";
import { ownershipLine } from "./ownership.js";
import type { PlanIo } from "./integrations/types.js";
import { gitFor } from "./git.js";
import { readInside, resolveInside, writeSecretInside, PathError } from "./fs-safe.js";
import { hasEnvValue, setEnvValue } from "./edits/env.js";
import { localKeyName, vercelHost, type Host } from "./hosts.js";
import { connectHost, handoffOf, HOST_NOT_CONNECTED, type HostCtx, type HostState } from "./host-step.js";
import { runNames, type RunNames } from "./names.js";
import { emptyPlan, PlanError, type Plan } from "./plan-core.js";
import { PRODUCTION } from "./config.js";
import { signIn, signOut, SignInError } from "./auth.js";
import { GatewayClient, ApiError, KeyScopeError, KeysStopped, RunKeys, SECRET_KEY_RE, type WizardSite } from "./api.js";
import { openBrowser } from "./open.js";
import { defaultRunner } from "./run.js";
import { checkLocal } from "./check.js";
import { halt, Stopped } from "./stop.js";
import { withDefaults, BY_HAND, NoTerminalError, SIGNIN_LINK_INTRO, STEPS_ABOVE, type Handoff, type StepId, type Ui } from "./ui/types.js";
import { plainUi } from "./ui/plain.js";
import { scrub } from "./ui/scrub.js";

// The wizard's flow: inspect, sign in, choose the site, review and apply, the local keys, the host, the local check,
// the report; and uninstall. The steps with their own rules live beside it: the apply (apply.ts), the package step
// (packages.ts), the host step (host-step.ts), and how a run names its apps (names.ts).

export type { CliDeps } from "./deps.js";

const ioFor = (u: AppUnit): PlanIo => ({ read: (f) => readInside(u.dir, f), git: gitFor(u.dir) });
/** What to remove from one app, its files named from the folder the wizard was started in (names.file, which depends
 * on the app alone). */
const removalOf = (u: AppUnit): Plan => unplanUnit(u, { ...ioFor(u), shown: (f) => appFile(u, f) });

/** The apps this run covers, where their paths are relative to (`base`), and the apps found that the wizard cannot
 * install into (`problems`; none when --app names the apps). For an uninstall with several apps and no --app, only the
 * apps Parlox is in (parloxIn: something to remove, or to take out by hand) are offered, and the others are
 * `without`; when none has Parlox, there is nothing to choose. The removal plans made to tell them apart are returned
 * (`removals`), so uninstall uses them rather than planning each app again. */
async function chooseUnits(cwd: string, args: Args, ui: Ui): Promise<{ base: string; units: AppUnit[]; problems: Scan["problems"]; without: AppUnit[]; removals: Map<AppUnit, Plan> }> {
  const scan = scanApps(cwd);
  const problems = args.apps.length ? [] : scan.problems;
  let without: AppUnit[] = [];
  const removals = new Map<AppUnit, Plan>();
  if (args.uninstall && scan.units.length > 1 && !args.apps.length) {
    for (const u of scan.units) removals.set(u, removalOf(u));
    const withParlox = scan.units.filter((u) => parloxIn(removals.get(u)!, ioFor(u).read));
    if (!withParlox.length) return { base: scan.base, units: scan.units, problems, without, removals };
    without = scan.units.filter((u) => !withParlox.includes(u));
    scan.units = withParlox;
  }
  return { base: scan.base, units: await selectUnits(scan, args.apps, ui, args.uninstall ? "uninstall" : "install"), problems, without, removals };
}

async function gitGate(dir: string, args: Args, ui: Ui): Promise<boolean> {
  const git = gitFor(dir);
  if (!git.isRepo()) {
    ui.warn("This folder is not a git repository, so the changes cannot be reviewed or undone with git.");
    return args.yes ? args.allowNoGit : ui.confirm("Continue anyway?");
  }
  const dirty = git.dirty();
  if (!dirty.length) { ui.fact("Git", "clean"); return true; }
  ui.warn(`Uncommitted changes:\n${dirty.map((f) => `  ${f}`).join("\n")}\nCommit or stash them first, so the wizard's changes are easy to review.`);
  return args.yes ? args.allowDirty : ui.confirm("Continue anyway?");
}

/** The plan as the review shows it: with what this run does not cover (`notes`) beside the plan's own warnings. */
const withNotes = (plan: Plan, notes: string[]): Plan => (notes.length ? { ...plan, warnings: [...plan.warnings, ...notes] } : plan);

/**
 * The domain as Parlox stores it: trimmed, lower case, without scheme, path, port or a trailing dot, and without a
 * leading "www." (Parlox counts www.example.com and example.com as the same site). Both sides of the comparison are
 * normalised, so "WWW.Shop.example.com" or "https://shop.example.com/products" find the existing site
 * shop.example.com (or www.shop.example.com) instead of creating another one.
 * The gateway still decides whether a domain is acceptable when a site is created.
 */
export function normaliseDomain(raw: string): string {
  return raw.trim().toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, "").replace(/[/?#].*$/, "").replace(/:\d+$/, "").replace(/\.$/, "").replace(/^www\./, "");
}

// How to choose the site without a terminal to answer in.
const SITE_HINT = "Pass --site <domain>.";

/** A dry run must never create anything (a site included): when the requested or chosen domain has no site yet,
 * this returns which domain would be created instead of creating it, and main() stops there. Under --yes, a --site
 * domain the account does not have is created without asking, named after the domain (as `vercel link --yes` creates
 * the project it does not find); otherwise the person is asked first. `created` says whether this run created it. */
async function pickSite(api: GatewayClient, args: Args, ui: Ui, signal?: AbortSignal): Promise<{ site: WizardSite; created: boolean } | { pendingDomain: string }> {
  const sites = await api.listSites();
  // No question after a stop that came while the list was loading.
  halt(signal);
  if (args.site) {
    const domain = normaliseDomain(args.site);
    const found = sites.find((s) => normaliseDomain(s.domain) === domain);
    if (found) return { site: found, created: false };
    if (!domain) throw new Error(`"${args.site}" is not a domain. Give the site's bare domain, such as shop.example.com.`);
    if (args.dryRun) return { pendingDomain: domain };
    if (!args.yes && !(await ui.confirm(`No site for ${domain} in your account yet. Create it?`))) throw new Declined("No site chosen. Nothing was changed.");
    return { site: await createSite(api, domain, domain, ui, signal), created: true };
  }
  const NEW = "__new__";
  const choice = sites.length ? await ui.select("Which site is this project?", [...sites.map((s) => ({ value: s.id, label: `${s.name} (${s.domain})${s.verified ? "" : " — not verified yet"}` })), { value: NEW, label: "A new site" }], SITE_HINT) : NEW;
  if (choice !== NEW) return { site: sites.find((s) => s.id === choice)!, created: false };
  const domain = await ui.text("The site's domain", "shop.example.com", SITE_HINT);
  if (args.dryRun) return { pendingDomain: domain };
  const name = await ui.text("A name for it", domain, SITE_HINT);
  return { site: await createSite(api, name || domain, domain, ui, signal), created: true };
}

/** A stop that arrives while the site is being created cannot undo it: the site exists, and the person is told so.
 * The gateway checks the domain, as for any new site: a bad one is refused with its message, and nothing is created. */
async function createSite(api: GatewayClient, name: string, domain: string, ui: Ui, signal?: AbortSignal): Promise<WizardSite> {
  halt(signal);
  const site = await api.createSite(name, domain);
  if (signal?.aborted) ui.warn(`The site ${domain} was created in your account just before the stop.`);
  return site;
}

/** A deliberate stop by the person (a No that ends the run), not an error: its step ends "skipped" and its message
 * is shown as is. */
class Declined extends Error {}

/**
 * --local-key: a separate key, named for this computer, stored in the app's env file (.env.local for Next.js) so the
 * server part can be tried locally. It is a real key of the site, so local visits land in the site's real data; the
 * warning says so and says how to revoke it. A PARLOX_SECRET_KEY already in that file is kept and no new key is created
 * (a second key would be left active with nothing using it). Every failure here is a warning, not a failed step: the
 * install itself is complete. The key's value is never printed; the install plan has already refused a committed env
 * file and git-ignored it. An env file that receives the key ends readable only by its owner, whatever mode it had
 * (POSIX; Windows has no such mode). `file` is read and written in `dir`; `shown` is how the messages name it (the
 * app's folder and the file, in a run with several apps). Returns whether the key was written.
 */
export async function writeLocalKey(api: Pick<GatewayClient, "createKey">, siteId: string, dir: string, file: string, shown: string, name: string, ui: Ui, signal?: AbortSignal): Promise<boolean> {
  // Checked here as well as in the plan (defence in depth): a key never goes into a file git tracks (it would be
  // committed) or through a link (it could land in a file shared with other apps). No key is created for either.
  const how = "To report from your dev server, create a key in Settings → Keys and set PARLOX_SECRET_KEY in the environment you start the server with.";
  try { resolveInside(dir, file); }
  catch (err) {
    if (!(err instanceof PathError)) throw err;
    ui.warn(`No local key: ${shown} is a link, or inside one, and the wizard never writes through a link, so no key was created. ${how}`);
    return false;
  }
  const git = gitFor(dir);
  if (git.isRepo() && git.isTracked(file)) {
    ui.warn(`No local key: git tracks ${shown}, so a key written there would be committed; no key was created. ${how}`);
    return false;
  }
  let current: string | null;
  try { current = readInside(dir, file); }
  catch (err) { ui.warn(`Could not read ${shown} (${scrub(err instanceof Error ? err.message : String(err))}); no local key was created.`); return false; }
  if (hasEnvValue(current, "PARLOX_SECRET_KEY")) {
    ui.info(`PARLOX_SECRET_KEY is already in ${shown}; no new local key was created. To replace it, revoke the old key in Settings → Keys, delete that line, and run again with --local-key.`);
    return false;
  }
  halt(signal);
  let value: string;
  try { value = await api.createKey(siteId, name); }
  catch (err) {
    // A key created with more access than crawler reports is never written; the message names it, to revoke.
    if (err instanceof KeyScopeError) ui.warn(`${scrub(err.message)} Nothing was written to ${shown}.`);
    // No key was asked for (an earlier one came back with other access): said once in the run.
    else if (err instanceof KeysStopped) { if (err.first) ui.warn(scrub(err.message)); }
    else ui.warn(`Could not create a local key (${scrub(err instanceof Error ? err.message : String(err))}); nothing was written to ${shown}.`);
    return false;
  }
  if (signal?.aborted) {
    ui.warn(`The local key "wizard · ${name}" was created, but the wizard was stopped before writing it to ${shown}; revoke it in the dashboard (Settings → Keys).`);
    throw new Stopped();
  }
  if (!SECRET_KEY_RE.test(value)) {
    ui.warn(`The dashboard returned a key in an unexpected form; refusing to use it (its value is not shown). Revoke "wizard · ${name}" in the dashboard (Settings → Keys).`);
    return false;
  }
  try {
    const next = setEnvValue(current, "PARLOX_SECRET_KEY", value);
    // Replaced whole, never emptied in place: if the write fails, the developer's own variables are all still there.
    if (next.changed) writeSecretInside(dir, file, next.content);
  } catch (err) {
    ui.warn(`The local key "wizard · ${name}" was created but could not be written to ${shown} (${scrub(err instanceof Error ? err.message : String(err))}); revoke it in the dashboard (Settings → Keys).`);
    return false;
  }
  ui.warn(`A separate key "wizard · ${name}" is in ${shown} for local development. Visits to your local server will appear in the site's real data. Revoke this key in Settings → Keys when you are done.`);
  return true;
}

/** What the report says about PARLOX_SECRET_KEY on Vercel: how this run stored it (Vercel still gives it to the
 * project's deployments and builds, either way), or, for a key already there on a static site or for an Express or
 * Hono server beside a Vite build in its folder, that the wizard cannot see it, while a build there can read the
 * project's variables. */
function secretLines(u: AppUnit, state: HostState | undefined, names: RunNames): string[] {
  const of = names.of(u);
  if (state?.secretStored === "secret") return [`PARLOX_SECRET_KEY${of} is stored on Vercel as a Secret (--visibility secret): no one on the team can read it back; your deployments and builds still receive it.`];
  if (state?.secretStored === "sensitive") return [`PARLOX_SECRET_KEY${of} is stored on Vercel as sensitive (--sensitive: this Vercel CLI has no --visibility option): it cannot be read back; your deployments and builds still receive it.`];
  if (state?.secretAlreadySet && (u.server?.integration === "vite-react" || u.viteBeside)) return [`PARLOX_SECRET_KEY${of} was already set on Vercel, so the wizard created no key and cannot see which key it is or what it may send. The keys the wizard creates can send only crawler reports, so that a key this site's build could reach can do nothing more: check in Settings → Keys that this key is "Crawler reports only".`];
  return [];
}

/** Whether Parlox has a part in this app: its browser part, or a server part of the wizard's (not withheld, and not an
 * app that reports with its own code). */
const hasParts = (u: AppUnit): boolean => !!u.browser || (!!u.server && u.server.parts.server?.kind !== OWN_REPORT_KIND);

/** What a run with nothing to change says: "already installed" only for the apps whose Parlox parts are there, and
 * which part is missing where one was withheld. */
function alreadyInstalled(units: AppUnit[], names: RunNames): string {
  const there = units.filter(hasParts);
  if (!there.length) return "Nothing to change.";
  if (names.single) return units[0].withheld ? "Parlox's browser part is already in this app; no server part was added (see the note below). Nothing to change." : "Parlox is already installed in this app. Nothing to change.";
  const rest = units.filter((u) => !hasParts(u));
  if (!rest.length && !units.some((u) => u.withheld)) return "Parlox is already installed in these apps. Nothing to change.";
  const label = (u: AppUnit) => `${names.app(u)}${u.withheld ? " (browser part only)" : ""}`;
  return `Parlox is already installed in ${there.map(label).join(", ")}${rest.length ? `; nothing was added to ${rest.map((u) => names.app(u)).join(", ")}` : ""} (see the notes below). Nothing to change.`;
}

/** The report's last lines when nothing was added: what to do, by why nothing was. */
function nextWhenNothing(units: AppUnit[]): string[] {
  const own = units.some((u) => u.server?.parts.server?.kind === OWN_REPORT_KIND);
  const withheld = units.some((u) => u.withheld);
  return [
    ...(own ? ["Next: remove that code, then run the wizard again."] : []),
    ...(withheld ? ["Next: do what the note on the server part above says."] : []),
    ...(!own && !withheld ? ["Next: see the notes above."] : []),
  ];
}

/** The report's lines for one app, each with its basis. `plan` is the app's own plan (its paths unprefixed). */
function unitReport(u: AppUnit, host: Host, plan: Plan, local: string, domain: string, names: RunNames, state?: HostState): string[] {
  const manual = new Set(plan.manual.map((m) => m.file));
  const lines: string[] = [];
  const server = u.server?.parts.server ?? null;
  if (u.server && hostStepFor(u, host)) {
    const byHand = (!!server?.file && manual.has(server.file)) || plan.manual.some((m) => m.part === "server");
    lines.push(`Server part${names.of(u)}: ${byHand ? BY_HAND : local}.`, ...secretLines(u, state, names));
  }
  const browser = u.browser?.parts.browser ?? null;
  if (browser) {
    const byHand = (!!browser.file && manual.has(browser.file)) || plan.manual.some((m) => m.part === "browser");
    lines.push(`Browser part${names.of(u)}: ${byHand ? BY_HAND : "added to your code"}; confirmed after you deploy, when the first visit from ${domain} arrives.`);
  }
  for (const d of u.detections) {
    lines.push(...d.notes.map((n) => names.note(u, n)));
    lines.push(...(integrationOf(d).hostNotes?.(d, host, { browser: u.browser === d, server: u.server === d, unitHasBrowser: !!u.browser }) ?? []).map((n) => names.note(u, n)));
  }
  // What the review warned about (a middleware's own matcher, say) is said again here, once.
  for (const w of plan.warnings) if (!lines.includes(names.note(u, w))) lines.push(names.note(u, w));
  return lines;
}

/** Uninstall does not edit .gitignore: a line the install added there keeps an env file out of git, and the file may
 * still hold the developer's own variables. Said for each env file the removal took Parlox's lines out of. */
function gitignoreKept(run: RunPlan, names: RunNames): string[] {
  const files = run.planned.flatMap(({ unit, plan }) => plan.changes.filter((c) => unit.detections.some((d) => d.envFile === c.path)).map((c) => names.file(unit, c.path)));
  if (!files.length) return [];
  const list = files.length === 1 ? files[0] : `${files.slice(0, -1).join(", ")} and ${files[files.length - 1]}`;
  return [`.gitignore was not changed: any line the install added there to keep ${list} out of git stays.`];
}

const KEYS_KEPT = "Keys are not revoked by uninstall: revoke them in the dashboard (Settings → Keys).";

/** What the uninstall report says it removed, per app: never "removed" for an app it changed nothing in (an app with
 * nothing of Parlox's has its own note). */
function removedLines(run: RunPlan, names: RunNames): string[] {
  const byHand = run.planned.filter((p) => p.plan.manual.length > 0);
  if (!byHand.length) return [`Removed. ${KEYS_KEPT}`];
  if (names.single) return [`Removed, except ${STEPS_ABOVE}. ${KEYS_KEPT}`];
  return [
    ...run.planned.filter(({ plan }) => plan.changes.length || plan.install || plan.manual.length).map(({ unit, plan }) => {
      const removed = plan.changes.length > 0 || !!plan.install;
      return `${names.app(unit)}: ${!plan.manual.length ? "removed." : removed ? `removed, except ${STEPS_ABOVE}.` : `nothing removed; ${STEPS_ABOVE} are left to do.`}`;
    }),
    KEYS_KEPT,
  ];
}

/** `without`: the apps found that Parlox is not in, which the run did not offer (chooseUnits). `removals`: the removal
 * plans chooseUnits already made; an app without one is planned here. */
async function uninstall(units: AppUnit[], names: RunNames, coverage: string[], without: AppUnit[], removals: Map<AppUnit, Plan>, args: Args, deps: CliDeps, ui: Ui): Promise<number> {
  ui.step("review", "active");
  const removal = (u: AppUnit): Plan => { let p = removals.get(u); if (!p) { p = removalOf(u); removals.set(u, p); } return p; };
  const unplanned = new Map(units.map((u) => [u, removal(u)]));
  // An app Parlox is not in (it never had Parlox; a file it could not read is a step only if it did): nothing of it is
  // removed or listed as a step by hand. Each file it could not read is named in a note, with why; in a run with
  // several apps, an app named with --app is said to have nothing to remove.
  const absent = units.filter((u) => !parloxIn(unplanned.get(u)!, ioFor(u).read));
  const someLeft = absent.length < units.length;
  const notes = [
    ...[...absent, ...without].flatMap((u) => unreadNotes(u, removal(u))),
    ...(names.single || !someLeft ? [] : absent.map((u) => `${names.app(u)}: nothing from Parlox was found to remove.`)),
    ...coverage,
  ];
  // Each app keeps its place in the run (its files keep their folder in the review); an app Parlox is not in has an
  // empty plan.
  const run = planRun(units, (u) => (absent.includes(u) ? emptyPlan() : unplanned.get(u)!));
  const nothingToApply = !run.review.changes.length && !run.steps.length;
  if (nothingToApply && !run.review.manual.length) {
    ui.step("review", "done");
    ui.report(["Nothing from Parlox was found to remove.", ...notes], "Nothing to remove");
    ui.step("done", "done");
    return 0;
  }
  ui.changes(withNotes(run.review, notes), names.target, "uninstall");
  // Only steps by hand (an env file the wizard does not change, a file it may not read): nothing to apply, and nothing
  // is said to be removed. The steps are listed.
  if (nothingToApply) {
    ui.step("review", "done");
    ui.report([
      "Nothing was removed: what is left of Parlox is in files the wizard does not change. Take it out by hand:",
      ...run.review.manual.map((m) => `${m.file}: ${m.reason}`),
      KEYS_KEPT,
      ...run.review.warnings,
      ...notes,
    ], "Steps by hand");
    ui.step("done", "done");
    return 0;
  }
  if (args.dryRun) {
    ui.step("review", "done");
    ui.report(["Nothing was removed.", "Run without --dry-run to apply these changes."], "Dry run");
    ui.step("done", "done");
    return 0;
  }
  if (!args.yes && !(await ui.confirm("Remove these?"))) { ui.step("review", "skipped"); return 1; }
  halt(deps.signal);
  // "done" once the first change has landed (see main): a first write that fails leaves the review failed.
  let landed = false;
  const { code } = await applyRun(run, "removal", names, deps, ui, () => { if (!landed) { landed = true; ui.step("review", "done"); } });
  if (code !== null) return code;
  ui.report([
    ...removedLines(run, names),
    'If you used --local-key, revoke the key named "wizard · local dev · …" in Settings → Keys.',
    ...gitignoreKept(run, names),
    // What the review said was left, and why (a package the app's own code imports, a key line), said again.
    ...run.review.warnings,
    ...notes,
  ], "Parlox is removed");
  ui.step("done", "done");
  return 0;
}

export async function main(argv: string[], partial: Partial<CliDeps> = {}): Promise<number> {
  const deps: CliDeps = { cwd: process.cwd(), config: PRODUCTION, open: openBrowser, run: defaultRunner, ui: plainUi(), ...partial };
  const base = withDefaults(deps.ui);
  // Tracks whichever step is currently "active", so any error caught below — a known error, a cancelled prompt, or
  // anything unexpected — can close that step as "failed" instead of leaving a screen with no final status.
  let activeStep: StepId | null = null;
  const ui: Ui = { ...base, step: (id, status) => { activeStep = status === "active" ? id : null; base.step(id, status); } };
  const { config } = deps;
  const parsed = parseArgs(argv);
  if ("error" in parsed) { ui.warn(parsed.error); return 1; }
  const args = parsed;

  // A build shipped with its placeholder client id or Supabase key cannot sign anyone in; refuse before touching
  // the network or the developer's files, rather than failing confusingly partway through.
  if (config.clientId.startsWith("REPLACE_WITH") || config.apiKey.startsWith("REPLACE_WITH")) {
    ui.warn("This build of the wizard is missing its OAuth client id or Supabase key. This is a packaging error, not something to fix in your project: please reinstall parlox from a published release.");
    return 1;
  }

  let token: string | null = null;
  // For an early end's message: whether this run changed the project's files, whether the host step has finished,
  // and what the hand-offs would say (known once the site is chosen; one per app with a server part whose host step
  // has not run to its end).
  let applied = false, hostFinished = false;
  let handoffsNow: (() => Handoff[]) | null = null;
  // The apps a failed write left with none of their changes (apply.ts).
  let untouched: AppUnit[] = [];
  // One contract for every early end after the files were written (a stop, a cancelled question, a question with no
  // terminal, an error): say that the host is not connected, and what to set there by hand. Said once; the browser is
  // not opened (nothing more happens after a stop). The faces close with "Stopped. The changes already applied stay."
  const leftToDo = () => {
    if (!applied || hostFinished || !handoffsNow) return;
    hostFinished = true;
    const left = handoffsNow();
    if (!left.length) return;
    ui.warn(HOST_NOT_CONNECTED);
    for (const h of left) ui.handoff(h);
  };
  try {
    // 1. Inspect (read only)
    ui.step("detect", "active");
    const { base: runBase, units, problems, without, removals } = await chooseUnits(deps.cwd, args, ui);
    const names = runNames(units, runBase);
    // A run with one app works in that app's folder, as before; with several, in the folder the wizard was started in.
    const home = names.single ? units[0].dir : runBase;
    const notes = coverageNotes(problems, units, names);
    for (const u of units) for (const [label, value] of unitFacts(u, names.single)) ui.fact(label, value);
    if (!args.dryRun && !(await gitGate(home, args, ui))) {
      // A No to "Continue anyway?" is the person's own choice (skipped); under --yes nothing was asked and the
      // wizard itself refused to go on without --allow-dirty / --allow-no-git (failed).
      ui.step("detect", args.yes ? "failed" : "skipped");
      return 1;
    }
    ui.step("detect", "done");
    if (args.uninstall) return await uninstall(units, names, notes, without, removals, args, deps, ui);
    // Only an app whose server part has a local check (a dev server to ask) takes the address: a static site's
    // ownership file, or a server part checked only after the deploy, does not.
    const checkable = units.filter((u) => u.server && "url" in u.server.localCheck);
    if (args.url && checkable.length > 1) {
      ui.warn(`--url names one local address, and this run has several apps whose server part can be checked locally (${checkable.map((u) => names.app(u)).join(", ")}). Check each app on its own: run again with --app <folder> --url <address> (the wizard finds the changes already made).`);
      return 1;
    }

    // 2. Sign in
    halt(deps.signal);
    ui.step("signin", "active");
    token = await signIn({ supabaseUrl: config.supabaseUrl, clientId: config.clientId, apiKey: config.apiKey, ports: config.ports, open: args.noBrowser ? () => {} : deps.open, onListening: (url) => ui.info(`${SIGNIN_LINK_INTRO}\n${url}`) });
    const api = new GatewayClient(config.gateway, token);
    ui.step("signin", "done");

    // 3. Site
    halt(deps.signal);
    ui.step("site", "active");
    const siteResult = await pickSite(api, args, ui, deps.signal);
    if ("pendingDomain" in siteResult) {
      ui.step("site", "done");
      ui.report([`No site for ${siteResult.pendingDomain} in your account yet; run without --dry-run to create it.`], "Dry run");
      ui.step("done", "done");
      return 0;
    }
    const { site, created } = siteResult;
    ui.fact("Site", `${site.name} (${site.domain})`);
    const hosts = new Map<AppUnit, Host>();
    for (const u of units) {
      // From its files, and from its server part's runtime where that contradicts wrangler's config (apps.ts, hostOf).
      const h = unitHost(u);
      hosts.set(u, h);
      ui.fact("Host", names.note(u, h.id === "unknown" ? "not detected" : h.label));
    }
    // A static site's server part depends on its host: on Vercel a middleware runs; elsewhere there is none. When no
    // host file says, the developer answers (--vercel / --no-vercel answer it without a terminal).
    for (const u of units) {
      if (hosts.get(u)!.id !== "unknown" || u.server?.parts.server?.kind !== "host-question") continue;
      const onVercel = args.vercel || (!args.noVercel && (await ui.confirm(`Is ${names.app(u)} deployed on Vercel?`, "Pass --vercel if it is, or --no-vercel if it is not.")));
      halt(deps.signal);
      if (onVercel) {
        hosts.set(u, vercelHost(null));
        ui.fact("Host", names.note(u, "Vercel (your answer)"));
      }
    }
    ui.step("site", "done");
    const { verify_token } = await api.verifyToken(site.id);
    // Every key of the run goes through one key maker: after a key the gateway answers with other access than crawler
    // reports, no other key is asked for.
    const keys = new RunKeys(api);
    const hctx: HostCtx = { api: keys, siteId: site.id, verifyToken: verify_token, dashboard: config.dashboard, args, deps, ui, names };
    const hostUnits = units.filter((u) => hostStepFor(u, hosts.get(u)!));
    const hostState = new Map<AppUnit, HostState>(hostUnits.map((u) => [u, { secretDone: false, tokenDone: false, finished: false }]));
    handoffsNow = () => hostUnits
      .filter((u) => { const st = hostState.get(u)!; return !untouched.includes(u) && !st.finished && !(st.secretDone && st.tokenDone); })
      .map((u) => handoffOf(hctx, u, hosts.get(u)!, hostState.get(u)!));

    // 4. Plan and diff (nothing written yet)
    halt(deps.signal);
    ui.step("review", "active");
    const run = planRun(units, (u) => planUnit(u, { publicKey: site.public_key, verifyToken: verify_token, host: hosts.get(u)!, shown: (f) => names.file(u, f) }, ioFor(u)));
    // An env file the wizard does not write (git tracks it, it is a link): a step by hand in the app's own plan.
    const envByHand = (u: AppUnit): boolean => !!u.server?.envFile && !!run.planned.find((p) => p.unit === u)?.plan.manual.some((m) => m.file === u.server!.envFile);
    const plan = run.review;
    const nothing = !plan.changes.length && !run.steps.length && !plan.manual.length;
    // No app has a part of Parlox's (it reports with its own code, or its server part was withheld and it has no
    // browser part): nothing is installed, so only "nothing to change" is said, and the report's title does not say
    // Parlox is installed. Such a run has nothing to change.
    const nothingAdded = !units.some(hasParts);
    if (nothing) {
      ui.info(alreadyInstalled(units, names));
      // What the review would have said beside the diff is said all the same (an app refused beside these, say).
      for (const w of withNotes(plan, notes).warnings) ui.warn(w);
    } else ui.changes(withNotes(plan, notes), names.target, "install");
    if (args.dryRun) {
      ui.step("review", "done");
      ui.report(["Nothing was changed.", "Run without --dry-run to apply these changes."], "Dry run");
      ui.step("done", "done");
      return 0;
    }

    // 5. Apply
    if (plan.changes.length || run.steps.length) {
      if (!args.yes && !(await ui.confirm(`Apply these changes to ${names.target}?`))) { ui.step("review", "skipped"); return 1; }
      // A Yes that raced a stop: the stop wins, and nothing is written.
      halt(deps.signal);
      // The review ends "done" once its first change has landed, not before: the faces' closing line reads it ("The
      // changes already applied stay"), and a first write that fails has changed nothing (the review then ends failed).
      // A plan with only a package install is done once the install is about to run.
      const result = await applyRun(run, "install", names, deps, ui, () => { if (!applied) { applied = true; ui.step("review", "done"); } });
      // An app none of whose changes were written has no Parlox code: no hand-off, so no key is made for it.
      if (result.code !== null) { untouched = result.untouched; leftToDo(); return result.code; }
    } else {
      // No files to write and no package to install (already installed, or every change needs a manual edit):
      // the review is still finished — there is nothing left to approve.
      ui.step("review", "done");
    }

    // 5b. Opt-in local keys (never in a dry run, which has already returned above): one per app whose server part
    // needs a key.
    halt(deps.signal);
    const localKeyFiles: string[] = [];
    if (args.localKey) {
      for (const u of units) {
        // Vite exposes the variables of the app's .env files whose names start with envPrefix to the browser build:
        // where the config could bundle PARLOX_SECRET_KEY, or the wizard cannot prove it does not, no key is written.
        const exposure = secretExposureOf(u.detections);
        if (exposure) {
          ui.warn(`No local key${names.of(u)}: ${whyOn(exposure, hosts.get(u)!.id === "vercel")}${exposure.byHand ? "" : ` ${exposure.fix[0].toUpperCase()}${exposure.fix.slice(1)} and run the wizard again.`}`);
          continue;
        }
        if (!hostUnits.includes(u)) continue;
        const d = u.server!;
        if (!d.envFile) {
          const why = "skip" in d.localCheck ? d.localCheck.skip : "this app loads no .env file, so a key there would not be read";
          ui.warn(`No local key${names.of(u)}: ${why}. To report from your dev server, create a key in Settings → Keys and set PARLOX_SECRET_KEY in the environment you start the server with.`);
          continue;
        }
        const shown = names.file(u, d.envFile);
        // Never into a file the plan left to the developer: git tracks it (a key there would be committed), or the
        // wizard may not read it.
        if (envByHand(u)) {
          ui.warn(`No local key${names.of(u)}: ${shown} is a step by hand (the wizard does not write it), so no key was created. To report from your dev server, create a key in Settings → Keys and set PARLOX_SECRET_KEY in the environment you start the server with.`);
          continue;
        }
        if (await writeLocalKey(keys, site.id, u.dir, d.envFile, shown, names.localKey(u, localKeyName(hostname())), ui, deps.signal)) localKeyFiles.push(shown);
      }
    }

    // 6. Production variables, per app with a server part (always asked unless --vercel; --yes accepts only the diff)
    halt(deps.signal);
    ui.step("host", "active");
    ui.task("host", "active");
    for (const u of hostUnits) await connectHost(hctx, u, hosts.get(u)!, hostState.get(u)!);
    const allSet = hostUnits.length > 0 && hostUnits.every((u) => hostState.get(u)!.secretDone && hostState.get(u)!.tokenDone);
    if (hostUnits.length) ui.task("host", allSet ? "done" : "skipped");
    else ui.task("host", "skipped", "Nothing to set on a host: no app here has a server part");
    ui.step("host", allSet ? "done" : "skipped");
    hostFinished = true;

    // 7. Local check, per app whose server part needs the host step (a static site off Vercel has none to check)
    halt(deps.signal);
    ui.step("check", "active");
    ui.task("check", "active");
    const local = new Map<AppUnit, string>();
    for (const u of hostUnits) {
      const lc = u.server!.localCheck;
      let result = "not checked";
      if ("skip" in lc) result = `not checked (${lc.skip})`;
      else if (envByHand(u)) result = `not checked (PARLOX_VERIFY_TOKEN is not in ${names.file(u, u.server!.envFile!)} yet: it is a step by hand)`;
      else if (!args.skipCheck) {
        const question = names.single ? `Check the server part now? Start your app (${lc.start}) first.` : `Check the server part of ${names.app(u)} now? Start it (${lc.start}) first.`;
        const url = args.url ?? (!args.yes && (await ui.confirm(question)) ? (await ui.text("Local URL", lc.url)) || lc.url : undefined);
        halt(deps.signal);
        if (url) { const r = await checkLocal(url, verify_token); result = r.ok ? "verified locally" : `not verified locally (${r.detail})`; }
      }
      local.set(u, result);
    }
    const results = [...local.values()];
    const verified = results.length > 0 && results.every((l) => l.startsWith("verified"));
    const detail = !results.length ? "Nothing to check locally: no app here has a server part" : names.single ? results[0] : [...local].map(([u, l]) => names.note(u, l)).join("; ");
    ui.task("check", verified ? "done" : "skipped", detail);
    ui.step("check", verified ? "done" : "skipped");

    // 8. Report, each line with its basis
    halt(deps.signal);
    ui.report([
      ...(created ? [`Created the site ${site.domain} in your Parlox account.`] : []),
      ...run.planned.flatMap(({ unit, plan: own }) => unitReport(unit, hosts.get(unit)!, own, local.get(unit) ?? "not checked", site.domain, names, hostState.get(unit))),
      ...notes,
      // Ownership is said to be confirmed only where something in the plan, or already there, proves it
      // (ownership.ts); otherwise how to prove it. Not said where the app reports with its own code: nothing of the
      // wizard's is there, and the warning says what to remove.
      ...(nothingAdded && !units.some((u) => u.withheld) ? [] : [ownershipLine(run.planned, (u) => hosts.get(u)!, verify_token, site.domain)]),
      ...(nothingAdded ? [] : [`Visits on preview or staging URLs are not recorded; only ${site.domain} counts.`]),
      ...(process.platform !== "win32" ? localKeyFiles.map((f) => `${f} is now readable only by you: it holds the local key.`) : []),
      // The link on a line of its own: a link wrapped across lines cannot be copied whole.
      ...(nothingAdded ? nextWhenNothing(units) : ["Next: deploy, then open the dashboard to watch the first reports:", `  ${config.dashboard}`]),
    ], nothingAdded ? "Nothing was added to your code" : "Parlox is installed");
    ui.step("done", "done");
    return 0;
  } catch (err) {
    // Whatever step was active when this was thrown never reached a normal done/skipped exit; close it here so a
    // screen keyed to that step is never left waiting on a status that will never come.
    // A stop, whatever it interrupted (a question it cancelled included), is not an error: the step ends "skipped"
    // and the exit code is 130. The faces close with "Stopped…"; after the files were changed, what is left is said.
    if (err instanceof Stopped || deps.signal?.aborted) {
      if (activeStep) ui.step(activeStep, "skipped");
      leftToDo();
      return 130;
    }
    // A cancelled question (Ctrl+C or Esc at a plain question, q at a full-screen one: both faces reject it with this
    // exact Error) is a stop, never an answer. It is the person's own choice, not a failure: the step ends "skipped",
    // with its own message rather than "Unexpected error: Cancelled.". So does a Declined (a No that ends the run).
    // Anything else is a real error and ends the step "failed".
    const cancelled = err instanceof Error && err.message === "Cancelled.";
    if (activeStep) ui.step(activeStep, cancelled || err instanceof Declined ? "skipped" : "failed");
    if (cancelled) {
      if (applied) leftToDo(); else ui.info("Cancelled. Nothing else was changed.");
      return 1;
    }
    if (err instanceof Declined) { ui.info(err.message); return 1; }
    const known = err instanceof DetectError || err instanceof PlanError || err instanceof SignInError || err instanceof ApiError || err instanceof PathError || err instanceof NoTerminalError;
    const message = known ? (err as Error).message : `Unexpected error: ${err instanceof Error ? err.message : String(err)}`;
    ui.warn(scrub(message));
    if (args.debug && err instanceof Error && err.stack) ui.warn(scrub(err.stack));
    leftToDo();
    return 1;
  } finally {
    if (token) {
      const ok = await signOut(config.supabaseUrl, config.apiKey, token);
      if (!ok) ui.warn("Could not end the sign-in session; it expires on its own within an hour.");
    }
  }
}
