import { lstatSync } from "node:fs";
import { join, posix } from "node:path";
import { addPageTag, headTag, htmlSnippet, pugSnippet, REMOVE_TAG_SNIPPET, removePageTag } from "../edits/head-tag.js";
import { findAppDeclarations, moduleSystemOf, removeUseLine } from "../edits/use-line.js";
import { parseCode } from "../edits/splice.js";
import { viteOutDir } from "../edits/vite-config.js";
import { findExpressPages, markedFiles, type ExpressPages } from "../edits/views.js";
import { envLoading, envNotes, localCheckFor, planEnvToken, unplanEnv, WORKER_LOCAL_SKIP, type EnvLoading } from "../envfiles.js";
import { readInside } from "../fs-safe.js";
import { onlyCloudflare, wranglerOf } from "../hosts.js";
import { OWN_REPORT_KIND, ownReporting, ownReportWarning, type OwnReport } from "../own-reporting.js";
import { declared, emptyPlan, packageCommand, type Plan } from "../plan-core.js";
import { findServerFile, importsModule, serverFileCandidates } from "../scripts.js";
import { DetectError, GUIDE, hasDep, installedMajor, packageManagerOf, readJson, readText, type PackageManager } from "../workspace.js";
import { serverPackageKept } from "../sdk-use.js";
import { planUseLine, shutdownNote, tryRead } from "./server-part.js";
import type { Integration, PlanInput } from "./types.js";
import { viteFoldersBelow } from "./vite-react.js";

// Express 4 and 5. The server part: `app.use(parlox())` right after `const app = express()` in the file
// the app runs. NestJS (which uses Express underneath) is declined: its app is created by NestFactory, not express().
// An app that already reports to Parlox with its own code gets no server part (own-reporting.ts). The browser part,
// when the app serves pages: the dashboard's pinned tag in its layout, its views or its static HTML (edits/views.ts,
// edits/head-tag.ts); an app with no pages the wizard can see gets the server part only. Uninstall removes every tag the
// wizard wrote (marked) in the views and static folders, however many, and never one pasted by hand. Local variables:
// PARLOX_VERIFY_TOKEN goes in the .env the app already loads (envfiles.ts), else the report says what to set; under
// wrangler, where nothing says the app runs elsewhere, the server is a Worker, whose local variables are wrangler's.

export interface ExpressData {
  serverFile: string | null;
  reason: string | null;
  pkgType: string | undefined;
  system: "esm" | "cjs" | null;
  appName: string | null;
  /** Where the app reports to Parlox with its own code, or null. */
  ownReport: OwnReport | null;
  /** What the scan for that code did not read (the app is larger than its caps), or null. */
  ownReportNotChecked: string | null;
  /** Express is only in devDependencies: beside a Vite React app it is a dev helper, not the server (apps.ts). */
  devOnly: boolean;
  /** The pages it serves (views, static HTML) for the browser part, or null: no single app in the server file. */
  pages: ExpressPages | null;
  /** What the report says about local variables when the wizard adds the server part (envfiles.ts). */
  envNotes: string[];
  /** Whether the server runs as a Cloudflare Worker: wrangler's config in the app folder, and no other host's file or
   * link from there up to the top of the repository (hosts.ts, onlyCloudflare). A leftover wrangler config beside
   * fly.toml, say, is a Node server's. */
  worker: boolean;
}

const SOURCE = "@parlox/server/express";
const NOT_FOUND = "No server file found: the wizard looked at the files the start and dev scripts run, main, and server, index and app files in the folder and in src/.";
export const CDN_NOTE = "Pages a CDN serves from its cache never reach this server, so those crawler visits are not seen.";
const NO_PAGES = "This app serves no pages the wizard can see (no views, no static HTML): the browser part belongs in your frontend.";
/** A step by hand for the browser part: the tag in Pug for a Pug template, else as HTML (one page, or each page). */
const tagSnippet = (pk: string, file: string, pug: boolean | undefined): string =>
  pug ? pugSnippet(pk) : file.endsWith("/") ? `As the first line inside each page's <head>:\n${headTag(pk)}` : htmlSnippet(pk);

/** Where the Vite builds in the app at `dir` write: each config's build.outDir relative to `dir` ("unknown" when the
 * wizard cannot read it), and why it could not look through every folder for one (null: it did). */
export function viteBuildOutputs(dir: string): { outs: Array<{ config: string; out: string }>; notChecked: string | null } {
  const existsIn = (base: string) => (rel: string) => { try { lstatSync(join(base, rel)); return true; } catch { return false; } };
  const below = viteFoldersBelow(dir);
  const outs = [".", ...below.folders.filter((f) => f.config).map((f) => f.rel)].flatMap((rel) => {
    const o = viteOutDir(readText(rel === "." ? dir : join(dir, rel)), existsIn(rel === "." ? dir : join(dir, rel)));
    return o ? [{ config: rel === "." ? o.file : `${rel}/${o.file}`, out: o.outDir === "unknown" ? o.outDir : posix.normalize(posix.join(rel, o.outDir)) }] : [];
  });
  return { outs, notChecked: below.notChecked };
}

/** Why a static folder may be where a Vite build in this app writes (its build.outDir, as a client's '../public'), or
 * null. A build whose outDir the wizard cannot read, or folders it could not look through, could write there too: that
 * fails closed (a step by hand), since an edit there would be lost at the next build. The app's Vite configs are looked
 * for only when a static folder has pages. */
function viteOutputs(dir: string): (folder: string) => string | null {
  let found: { outs: Array<{ config: string; out: string }>; notChecked: string | null } | null = null;
  return (folder) => {
    found ??= viteBuildOutputs(dir);
    const hit = found.outs.find((o) => folder === o.out || folder.startsWith(`${o.out}/`));
    if (hit) return `${folder}/ is where the Vite build of ${hit.config} writes (its build.outDir): the next build replaces it, so the wizard does not edit it. Add the tag to the page that build starts from, or run the wizard for that app.`;
    const unread = found.outs.find((o) => o.out === "unknown");
    if (unread) return `The wizard could not read where ${unread.config} builds to (its build.outDir is computed in code, or written in a way the wizard does not follow), so it cannot tell whether ${folder}/ is that build's output, where an edit would be lost at the next build. Add the tag to the page that build starts from, or to the <head> of each page in ${folder}/.`;
    if (found.notChecked) return `The wizard could not look through every folder of this app for a Vite build, so it cannot tell whether ${folder}/ is one's output, where an edit would be lost at the next build. Add the tag to the <head> of each page in ${folder}/.`;
    return null;
  };
}

/** The env file's text, for the PORT it may set (the local check); null when there is none or the wizard may not read
 * it (a link is never followed). */
export function envText(dir: string, file: string | null): string | null {
  if (!file) return null;
  try { return readInside(dir, file); } catch { return null; }
}

const appsIn = (code: string, file: string): number => { const ast = parseCode(code, file); return ast ? findAppDeclarations(ast, "express").length : 0; };

export const express: Integration = {
  id: "express",
  label: "Express",
  detect(dir, root) {
    const read = readText(dir);
    if (read("package.json") === null) return null;
    const pkg = readJson(join(dir, "package.json"));
    if (!hasDep(pkg, "express")) return null;
    if (hasDep(pkg, "@nestjs/core")) throw new DetectError("declined", `NestJS is not covered by the wizard yet (its app is created by NestFactory). Add the server part by hand: ${GUIDE}`);
    const major = installedMajor(dir, pkg, "express");
    if (major !== null && (major < 4 || major > 5)) throw new DetectError("declined", `Express ${major} is not covered by the wizard (Express 4 and 5 are). Add the server part by hand: ${GUIDE}`);
    const packageManager = packageManagerOf(dir, root);
    const candidates = serverFileCandidates(read, pkg);
    const isExpress = (code: string, file: string) => importsModule(code, file, ["express"]);
    // The file that creates the app; else the first that imports express, so the snippet can say what it found there.
    const found = findServerFile(read, candidates, (code, file) => isExpress(code, file) && appsIn(code, file) > 0) ?? findServerFile(read, candidates, isExpress);
    let reason: string | null = found ? null : NOT_FOUND;
    let system: ExpressData["system"] = null;
    let appName: string | null = null;
    if (found) {
      const ast = parseCode(found.code, found.file);
      if (!ast) reason = `The wizard could not read ${found.file}.`;
      else {
        system = moduleSystemOf(found.file, ast, pkg.type);
        const apps = findAppDeclarations(ast, "express");
        appName = apps.length === 1 ? apps[0].name : null;
      }
    }
    const pages = found && appName ? findExpressPages(dir, read, found.file, found.code, appName, viteOutputs(dir)) : null;
    const scan = ownReporting(dir);
    const ownReport = scan.found;
    const devOnly = !pkg.dependencies?.express;
    // Local variables: none for an app that reports with its own code (it gets no server part), and none for a Worker
    // (under wrangler they are wrangler's, not a .env). A Worker only where every host file says Cloudflare, as for
    // Hono; the app's own wrangler config too, since one at the workspace root belongs to another app.
    const worker = wranglerOf(read) !== null && onlyCloudflare(dir, root);
    const env: EnvLoading = ownReport || worker ? { file: null, how: null } : envLoading(pkg, found?.code ?? null, found?.file ?? null, false, read("bunfig.toml"));
    const data: ExpressData = { serverFile: found?.file ?? null, reason, pkgType: pkg.type, system, appName, ownReport, ownReportNotChecked: scan.notChecked, devOnly, pages, envNotes: ownReport || worker ? [] : envNotes(env), worker };
    return {
      integration: "express", dir, root, packageManager,
      parts: {
        browser: pages && (pages.files.length || pages.manual.length) ? { file: pages.files[0] ?? null, kind: "express-pages", ...(pages.files.length ? {} : { manualReason: pages.manual[0].reason }) } : null,
        server: ownReport ? { file: ownReport.file, kind: OWN_REPORT_KIND } : { file: data.serverFile, kind: "express", ...(reason ? { manualReason: reason } : {}) },
      },
      facts: [
        ["Found", `Express${major !== null ? ` ${major}` : ""} · ${data.serverFile ?? "server file not found"} · ${system === "esm" ? "ES modules" : system === "cjs" ? "CommonJS" : "module system not known"} · ${packageManager}`],
        ...(pages?.summary ? [["Views", pages.summary] as [string, string]] : []),
        ...(env.file ? [["Env", `${env.file} (${env.how})`] as [string, string]] : []),
      ],
      // Said in the review too (plan.warnings), and again in the report.
      notes: [...(ownReport ? [ownReportWarning(ownReport)] : scan.notChecked ? [scan.notChecked] : []), ...(pages?.warnings ?? []), ...(pages?.notes ?? [])],
      envFile: env.file,
      localCheck: worker ? { skip: WORKER_LOCAL_SKIP } : localCheckFor(pkg, packageManager, found?.code ?? null, found?.file ?? null, env, envText(dir, env.file)),
      data,
    };
  },

  plan(d, input) {
    const data = d.data as ExpressData;
    const plan = emptyPlan();
    if (input.parts.server) {
      planServer(d.packageManager, data, input, plan);
      if (d.envFile) { const e = planEnvToken(input, d.envFile); plan.changes.push(...e.changes); plan.manual.push(...e.manual); }
    }
    if (input.parts.browser && data.pages) planPages(data.pages, input, plan);
    return plan;
  },

  unplan(d, io) {
    const data = d.data as ExpressData;
    const plan = emptyPlan();
    const got = data.serverFile ? tryRead(io.read, data.serverFile) : { text: null };
    // A file it may not read, or one it cannot parse that does not name the adapter: a step only if Parlox is there.
    if ("refused" in got) plan.manual.push({ file: data.serverFile!, reason: got.refused, snippet: `Remove .use(parlox()) and the import of ${SOURCE} by hand.`, part: "server", unread: true });
    else if (data.serverFile && got.text !== null) {
      const r = removeUseLine(got.text, data.serverFile, SOURCE);
      if (!r.ok) plan.manual.push({ file: data.serverFile, reason: r.reason, snippet: r.snippet, part: "server", ...(got.text.includes(SOURCE) ? {} : { unread: true }) });
      else if (r.changed) plan.changes.push({ path: data.serverFile, before: got.text, after: r.code, purpose: "server part" });
    }
    for (const file of markedFiles(d.dir, data.pages?.folders ?? [], readText(d.dir))) {
      const page = tryRead(io.read, file);
      if ("refused" in page) { plan.manual.push({ file, reason: page.refused, snippet: REMOVE_TAG_SNIPPET, part: "browser" }); continue; }
      if (page.text === null) continue;
      const r = removePageTag(file, page.text);
      if (!r.ok) plan.manual.push({ file, reason: r.reason, snippet: r.snippet, part: "browser" });
      else if (r.changed) plan.changes.push({ path: file, before: page.text, after: r.code, purpose: "browser part" });
    }
    if (d.envFile) { const e = unplanEnv(io, d.envFile); plan.changes.push(...e.changes); plan.manual.push(...e.manual); plan.warnings.push(...(e.warnings ?? [])); }
    // The package stays while the app's own code imports it (purchase() for orders, say).
    if (declared(io.read)["@parlox/server"]) {
      const kept = serverPackageKept(d.dir, io.read, plan, d.packageManager, io.others);
      if (kept) plan.warnings.push(kept);
      else plan.install = packageCommand(d.packageManager, "remove", ["@parlox/server"]);
    }
    return plan;
  },

  // No key and no hand-off for an app that reports with its own code.
  hostStep: (d) => d.parts.server?.kind === "express",

  // The pure-API note: the wizard adds this app's server part, and nothing in the app takes a browser part
  // (pages that already have a Parlox tag are said in the notes instead). The runtime-secret sentence is said for
  // Hono's Cloudflare Workers target only (integrations/hono.ts); an Express server under wrangler gets the Cloudflare
  // hand-off without it. Its Vite build is checked as every server's is (apps.ts).
  hostNotes: (d, host, role) => {
    if (!role.server || d.parts.server?.kind !== "express") return [];
    // A server that keeps running between requests: the shutdown snippet. Not for a Worker.
    const shutdown = (d.data as ExpressData).worker ? null : shutdownNote(host);
    return [
      CDN_NOTE,
      ...(role.unitHasBrowser || (d.data as ExpressData).pages?.warnings.length ? [] : [NO_PAGES]),
      // Only where the wizard plans the server part: a server part withheld (a Vite build that could expose the key)
      // has no local variables to talk about.
      ...(d.data as ExpressData).envNotes,
      ...(shutdown ? [shutdown] : []),
    ];
  },
};

/** The server part: `app.use(parlox())` in the server file, and the package. */
function planServer(pm: PackageManager, data: ExpressData, input: PlanInput, plan: Plan): void {
  planUseLine(pm, { kind: "express", source: SOURCE, file: data.serverFile, placeholder: "your server file", reason: data.reason, notFound: NOT_FOUND, pkgType: data.pkgType, ownReport: data.ownReport, ownReportNotChecked: data.ownReportNotChecked }, input, plan);
}

/** The browser part: the pinned tag in each page found (each shown in the diff), and a step by hand for the rest. The
 * tag needs no package. */
function planPages(pages: ExpressPages, input: PlanInput, plan: Plan): void {
  const pk = input.publicKey;
  // A Parlox tag the wizard did not write, in a view, a partial or a page: said in the review and the report.
  plan.warnings.push(...pages.warnings);
  const inRepo = input.git.isRepo();
  for (const file of pages.files) {
    const pug = /\.(pug|jade)$/i.test(file);
    const got = tryRead(input.read, file);
    if ("refused" in got) { plan.manual.push({ file, reason: got.refused, snippet: tagSnippet(pk, file, pug), part: "browser" }); continue; }
    if (got.text === null) continue;
    if (inRepo && input.git.isIgnored(file)) { plan.manual.push({ file, reason: `git ignores ${file}, so it is likely built or generated, and a change there would not be kept; add the tag to the source it comes from.`, snippet: tagSnippet(pk, file, pug), part: "browser" }); continue; }
    const e = addPageTag(file, got.text, pk);
    if (!e.ok) plan.manual.push({ file, reason: e.reason, snippet: e.snippet, part: "browser" });
    else {
      if (e.changed) plan.changes.push({ path: file, before: got.text, after: e.code, purpose: "browser part" });
      if (e.warning) plan.warnings.push(`${file}: ${e.warning}`);
    }
  }
  for (const m of pages.manual) plan.manual.push({ file: m.file, reason: m.reason, snippet: tagSnippet(pk, m.file, m.pug), part: "browser" });
}
