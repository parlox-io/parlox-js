import { existsSync, lstatSync } from "node:fs";
import { join, posix } from "node:path";
import { PUBLIC_KEY_RE } from "../edits/browser.js";
import { addViteEntry, moduleEntry, removeViteEntry, viteEntrySnippet } from "../edits/vite-entry.js";
import { readViteSettings, type SecretExposure, type ViteSettings } from "../edits/vite-config.js";
import { whyOn } from "../edits/vite-exposure.js";
import { appSettingsOf, vercelRootOf } from "../edits/vite-vercel.js";
import { yarnReleaseNote } from "../edits/vite-install.js";
import { edgeRefusal, planVercelEdge, unplanVercelEdge, vercelMiddlewareTemplate } from "../edits/vercel-edge.js";
import { PathError } from "../fs-safe.js";
import { detectHost, type Host } from "../hosts.js";
import { declared, emptyPlan, packageCommand, type FileChange, type Plan } from "../plan-core.js";
import { packagesToAdd } from "../pins.js";
import { serverPackageKept } from "../sdk-use.js";
import { DetectError, GUIDE, hasDep, packageManagerOf, readJson, readText } from "../workspace.js";
import type { Detection, Integration, PlanInput } from "./types.js";
import { appFolders } from "./vite-folders.js";

// The Vite checks that the server integrations share live in vite-folders.ts.
export { folderViteCheck, folderViteNamesSecretKey, netlifyCommands, runsVite, runsViteBuild, viteFoldersBelow, type Below, type FolderVite, type ViteFolder } from "./vite-folders.js";

// Vite React: react and vite in package.json, and no next. The browser part goes in the entry index.html
// names. A static site has no server of its own: on Vercel, Routing Middleware (edits/vercel-edge.ts) is its server
// part; on any other host, the ownership file in the public folder proves the domain, and crawlers are not seen.
// A Vite config that could bundle PARLOX_SECRET_KEY into the browser code (or that the wizard cannot prove does not)
// gets no middleware and no host step: Vercel gives the build the project's variables, so the key would be set where
// the build reads it.

export interface ViteData {
  /** The entry file (relative to the app folder), or null with entryReason. */
  entry: string | null;
  entryReason: string | null;
  typescript: boolean;
  /** Why a root middleware would not run (Next.js, Astro, a Storybook deployment), or null. */
  refusal: string | null;
  /** Vite's public folder, relative to the app folder (Vite's root applied); null: the wizard cannot tell. */
  publicDir: string | false | null;
  /** null: the wizard cannot tell. */
  envPrefix: string[] | null;
  /** Why PARLOX_SECRET_KEY could reach the browser build, or null. */
  exposure: SecretExposure | null;
  /** Why a middleware in this folder would not, or might not, be the Vercel project's root middleware (Vercel is set
   * up at the workspace root and builds there, or the wizard cannot tell where), or null. */
  vercelRoot: string | null;
  /** The .vercel/project.json whose saved project settings the wizard read for this app's build, or null. */
  vercelSettings: string | null;
  /** The Yarn release files the install runs, allowed by their standard location (vite-install.ts): the report names
   * each where the middleware and its key are added. */
  yarnReleases?: string[];
}

const VERIFY_FILE = ".well-known/parlox-verify";
// A verification code as edits/env.ts accepts a value it writes: the gateway's own code, public by design.
const TOKEN_RE = /^[A-Za-z0-9_\-.:]+$/;
const VERIFY_LINE_RE = /^[A-Za-z0-9_\-.:]+\r?\n$/;
const STATIC_NOTE = "Crawlers that do not run JavaScript are not seen on this host: they never run the browser part, and the site has no server of its own. Deploy on Vercel, or add a server, to see them.";
const NO_EDGE_NOTE = "Crawlers that do not run JavaScript are not seen: they never run the browser part, and the site has no server of its own (Vercel would not run a middleware for it either). Add a server to see them.";
const EXPOSED_NOTE = "Crawlers that do not run JavaScript are not seen until the server part is added (see the note on the Vite config).";
// Off Vercel, with a build the wizard could not prove safe: a Vercel middleware would be withheld for the same reason.
const STATIC_EXPOSED_NOTE = "Crawlers that do not run JavaScript are not seen on this host: they never run the browser part, and the site has no server of its own. Add a server to see them.";
const VERCEL_ROOT_NOTE = "Crawlers that do not run JavaScript are not seen until the middleware is added (see the note on where Vercel builds this project).";
const EDGE_NOTE = "The Vercel middleware runs on every page request (Vercel prices it as compute); its matcher leaves out static assets.";
// The build and install commands the wizard checks are the ones in vercel.json and package.json. Vercel's dashboard can
// set a Build Command, an Install Command and an Ignored Build Step too, and each runs in the build with the project's
// variables.
const DASHBOARD_NOTE = "If this project sets a Build Command, an Install Command or an Ignored Build Step in Vercel's dashboard, check that the Build Command runs `vite build` and that none of them runs code that could put PARLOX_SECRET_KEY into the build: the wizard cannot see dashboard settings.";
// With the settings `vercel pull` saved: what was read, and what was not (changes since, and the Ignored Build Step,
// which the CLI does not save).
const settingsNote = (file: string) => `The wizard read the Build Command and the Install Command that \`vercel pull\` saved in ${file}. If they have changed in Vercel's dashboard since, or the project sets an Ignored Build Step there, check that the Build Command runs \`vite build\` and that none of them runs code that could put PARLOX_SECRET_KEY into the build.`;
const LOCAL_SKIP = "the Vercel middleware runs only on Vercel; check it after you deploy";
const REMOVE_SNIPPET = "Remove the ParloxAnalytics import and element by hand.";

// Frameworks with their own server and routing (most build on Vite): not a single-page app with an index.html entry,
// and each needs its own server adapter (not covered yet). Earlier package names of the same frameworks count too.
const OWN_SERVER: Array<[string, string]> = [
  ["@react-router/dev", "React Router in framework mode"],
  ["@remix-run/dev", "Remix"],
  ["@tanstack/react-start", "TanStack Start"],
  ["@tanstack/start", "TanStack Start"],
  ["vike", "Vike"],
  ["vite-plugin-ssr", "Vike"],
  ["astro", "Astro"],
  ["waku", "Waku"],
  ["@redwoodjs/core", "RedwoodJS"],
  ["@redwoodjs/vite", "RedwoodJS"],
];

export const viteServerKind = (host: Host, data: ViteData): "vercel-edge" | "verify-file" => (host.id === "vercel" && !data.refusal && !data.vercelRoot && !data.exposure ? "vercel-edge" : "verify-file");

/** Why an app's Vite build could bundle PARLOX_SECRET_KEY, from any Vite React detection among `detections`. */
export function secretExposureOf(detections: Detection[]): SecretExposure | null {
  for (const d of detections) if (d.integration === "vite-react" && (d.data as ViteData).exposure) return (d.data as ViteData).exposure;
  return null;
}

const verifyPath = (publicDir: string) => (publicDir === "." ? VERIFY_FILE : `${publicDir}/${VERIFY_FILE}`);
/** The folders the ownership file goes in, innermost first, that the uninstall removes when they are left empty:
 * the public folder's .well-known and the public folder itself, never the app folder. */
const verifyDirs = (publicDir: string) => (publicDir === "." ? [".well-known"] : [`${publicDir}/.well-known`, publicDir]);
const refusalNote = (refusal: string) => `No Vercel middleware: ${refusal}`;
/** Why the app gets no middleware, in Vercel's words only where the host is Vercel (an undetected host may not be). */
const exposureNote = (e: SecretExposure, entryKnown: boolean, host: Host) => `${whyOn(e, host.id === "vercel")} ${entryKnown ? "Parlox set up the browser part only" : "Parlox added no server part"}${e.byHand ? `. ${e.fix[0].toUpperCase()}${e.fix.slice(1)}.` : `; ${e.fix} and run the wizard again to add the server part.`}`;
/** Where a missing middleware is worth saying: on Vercel, or where the host is not known. */
const edgeMatters = (host: Host) => host.id === "vercel" || host.id === "unknown";
/** The note on why the app gets no middleware, when it matters on this host. */
const noEdgeNotes = (data: ViteData, host: Host): string[] =>
  !edgeMatters(host) ? [] : data.refusal ? [refusalNote(data.refusal)] : data.vercelRoot ? [refusalNote(data.vercelRoot)] : data.exposure ? [exposureNote(data.exposure, !!data.entry, host)] : [];

/** A file read that refuses a symlink (fs-safe.ts) as a reason for a step by hand, never as the end of the run. */
function tryRead(read: (rel: string) => string | null, rel: string): { text: string | null } | { refused: string } {
  try { return { text: read(rel) }; }
  catch (err) {
    if (err instanceof PathError) return { refused: `${err.message}.` };
    throw err;
  }
}

/** The ownership file in Vite's public folder, or a step by hand where it cannot be written. */
function planVerifyFile(data: ViteData, input: PlanInput, plan: Plan): void {
  if (!TOKEN_RE.test(input.verifyToken)) throw new Error("Refusing to write an invalid verification code");
  const byHand = (file: string, reason: string) => plan.manual.push({ file, reason, snippet: `Serve this text at /.well-known/parlox-verify on your domain:\n${input.verifyToken}`, part: "server" });
  if (typeof data.publicDir !== "string") { byHand(VERIFY_FILE, data.publicDir === false ? "The Vite config turns the public folder off (publicDir: false)." : "The wizard could not read the Vite config's publicDir."); return; }
  // Vite copies the public folder into the build as is; the gateway's ownership check reads this path (the code alone,
  // or "parlox-verify=<code>", whitespace ignored).
  const path = verifyPath(data.publicDir);
  const got = tryRead(input.read, path);
  if ("refused" in got) byHand(path, got.refused);
  else if (got.text === null) plan.changes.push({ path, before: null, after: `${input.verifyToken}\n`, purpose: "ownership proof" });
  // A file that already proves this site is left as it is; one with another code is not replaced, since the uninstall
  // could not give it back.
  else if (got.text.trim() !== input.verifyToken && got.text.trim() !== `parlox-verify=${input.verifyToken}`) byHand(path, `${path} already holds another verification code; replace its text with this site's.`);
}

/** The entry file from Vite's index.html (in Vite's root), or why there is none. */
function entryOf(read: (rel: string) => string | null, s: ViteSettings): { entry: string | null; reason: string | null } {
  if (s.root === null) return { entry: null, reason: `The wizard cannot read Vite's root from ${s.file} (it is computed in code, or the config is not a plain object), so it cannot tell which index.html Vite uses.` };
  const html = s.root === "." ? "index.html" : `${s.root}/index.html`;
  const text = read(html);
  if (text === null) return { entry: null, reason: s.root === "." ? "No index.html in this folder." : `No index.html in ${s.root} (Vite's root, set in ${s.file}).` };
  const src = moduleEntry(text);
  if (!src) return { entry: null, reason: `${html} has no single <script type="module" src="…"> of the app's own.` };
  const rel = posix.normalize(posix.join(s.root, src));
  if (posix.isAbsolute(rel) || rel === ".." || rel.startsWith("../")) return { entry: null, reason: `The module script in ${html} is outside this folder.` };
  return { entry: rel, reason: null };
}

export const viteReact: Integration = {
  id: "vite-react",
  label: "Vite React",
  detect(dir, root) {
    const p = join(dir, "package.json");
    if (!existsSync(p)) return null;
    const pkg = readJson(p);
    if (!hasDep(pkg, "react") || hasDep(pkg, "next")) return null;
    const own = OWN_SERVER.find(([name]) => hasDep(pkg, name));
    if (own) throw new DetectError("not-supported", `${own[1]} (${own[0]}) is a framework with its own server and routing, not a Vite React single-page app; the wizard does not cover it yet. See ${GUIDE}`);
    if (!hasDep(pkg, "vite")) return null;
    const packageManager = packageManagerOf(dir, root);
    const read = readText(dir);
    // Which config Vite loads is decided by which exists (a link or a file it cannot read included).
    const exists = (rel: string) => { try { lstatSync(join(dir, rel)); return true; } catch { return false; } };
    const folders = appFolders(dir, root);
    const settings = readViteSettings(read, exists, folders);
    const { entry, reason } = entryOf(read, settings);
    const where = vercelRootOf(read, exists, folders.workspace);
    const data: ViteData = {
      entry,
      entryReason: reason,
      typescript: existsSync(join(dir, "tsconfig.json")),
      refusal: edgeRefusal(pkg, read),
      publicDir: settings.publicDir,
      envPrefix: settings.envPrefix,
      exposure: settings.exposure,
      vercelRoot: where && where.builds !== "app" ? where.why : null,
      vercelSettings: appSettingsOf(read, exists, folders.workspace)?.file ?? null,
      ...(settings.yarnReleases ? { yarnReleases: settings.yarnReleases } : {}),
    };
    const host = detectHost(dir, root);
    // A refusal or an exposure holds on any host: then nothing depends on the answer, and nothing is asked.
    const kind = data.refusal || data.vercelRoot || data.exposure ? "verify-file" : host.id === "unknown" ? "host-question" : viteServerKind(host, data);
    return {
      integration: "vite-react", dir, root, packageManager,
      parts: {
        browser: { file: entry, kind: "vite-entry", ...(entry ? {} : { manualReason: reason! }) },
        server: { file: kind === "verify-file" && typeof data.publicDir === "string" ? verifyPath(data.publicDir) : null, kind },
      },
      facts: [["Found", `Vite React · ${entry ?? "entry not found"} · ${data.typescript ? "TypeScript" : "JavaScript"} · ${packageManager}`]],
      // Said in the review too (plan.warnings).
      notes: noEdgeNotes(data, host),
      envFile: null,
      localCheck: { skip: LOCAL_SKIP },
      data,
    };
  },

  plan(d, input) {
    const data = d.data as ViteData;
    if (!PUBLIC_KEY_RE.test(input.publicKey)) throw new Error("Refusing to write an invalid public key");
    const plan = emptyPlan();
    const packages: string[] = [];
    const have = declared(input.read);
    if (input.parts.browser) {
      const snippet = viteEntrySnippet(input.publicKey);
      const got = data.entry ? tryRead(input.read, data.entry) : { text: null };
      if ("refused" in got) plan.manual.push({ file: data.entry!, reason: got.refused, snippet, part: "browser" });
      else if (!data.entry || got.text === null) plan.manual.push({ file: data.entry ?? "index.html", reason: data.entryReason ?? `${data.entry} (named in index.html) does not exist.`, snippet, part: "browser" });
      else {
        const e = addViteEntry(got.text, data.entry, input.publicKey);
        if (!e.ok) plan.manual.push({ file: data.entry, reason: e.reason, snippet: e.snippet, part: "browser" });
        else if (e.changed) plan.changes.push({ path: data.entry, before: got.text, after: e.code, purpose: "browser part" });
      }
      const pins = packagesToAdd(have, [["@parlox/browser", input.versions.browser]]);
      packages.push(...pins.add);
      plan.warnings.push(...pins.notes);
    }
    if (input.parts.server) {
      plan.warnings.push(...noEdgeNotes(data, input.host));
      if (viteServerKind(input.host, data) === "vercel-edge") {
        try {
          const edge = planVercelEdge(input.read, data.typescript, input.versions.server);
          plan.changes.push(...edge.changes);
          plan.manual.push(...edge.manual);
          plan.warnings.push(...edge.warnings);
          packages.push(...edge.packages);
        } catch (err) {
          if (!(err instanceof PathError)) throw err;
          plan.manual.push({ file: err.path ?? "middleware.ts", reason: `${err.message}.`, snippet: vercelMiddlewareTemplate(), part: "server" });
        }
      } else planVerifyFile(data, input, plan);
    }
    // The ownership file alone, for an Express server in this folder that serves this build and whose own server part
    // was withheld (apps.ts; it is planned only where Vite's public folder is known).
    else if (input.parts.verifyFile && typeof data.publicDir === "string") planVerifyFile(data, input, plan);
    if (packages.length) plan.install = packageCommand(d.packageManager, "add", packages);
    return plan;
  },

  unplan(d, io) {
    const data = d.data as ViteData;
    const plan: Plan = emptyPlan();
    const have = declared(io.read);
    const got = data.entry ? tryRead(io.read, data.entry) : { text: null };
    // A file it may not read, or one it cannot parse that does not name the package: a step only if Parlox is there.
    if ("refused" in got) plan.manual.push({ file: data.entry!, reason: got.refused, snippet: REMOVE_SNIPPET, part: "browser", unread: true });
    else if (data.entry && got.text !== null) {
      const r = removeViteEntry(got.text, data.entry);
      if (!r.ok) plan.manual.push({ file: data.entry, reason: r.reason, snippet: r.snippet, part: "browser", ...(got.text.includes("@parlox/browser") ? {} : { unread: true }) });
      else {
        if (r.changed) plan.changes.push({ path: data.entry, before: got.text, after: r.code, purpose: "browser part" });
        if (r.warning) plan.manual.push({ file: data.entry, reason: r.warning, snippet: "Remove the line named above by hand.", part: "browser" });
      }
    } else if (have["@parlox/browser"]) {
      // The package goes; its import, wherever it is, would then break the build.
      plan.manual.push({ file: data.entry ?? "index.html", reason: `${data.entryReason ?? `${data.entry} (named in index.html) does not exist.`} The wizard cannot find the ParloxAnalytics element to take out.`, snippet: REMOVE_SNIPPET, part: "browser" });
    }
    try {
      const edge = unplanVercelEdge(io.read);
      plan.changes.push(...edge.changes);
      plan.manual.push(...edge.manual);
    } catch (err) {
      if (!(err instanceof PathError)) throw err;
      plan.manual.push({ file: err.path ?? "middleware.ts", reason: `${err.message}.`, snippet: "Remove withParlox(…, { next }) and its import by hand.", part: "server", unread: true });
    }
    if (typeof data.publicDir === "string") {
      const path = verifyPath(data.publicDir);
      const file = tryRead(io.read, path);
      if ("refused" in file) plan.manual.push({ file: path, reason: file.refused, snippet: `Delete ${path}.`, part: "server", unread: true });
      // The file as the wizard writes it: the code on one line (CRLF after a checkout that converts line breaks). The
      // folders it was put in go too when nothing else is left in them.
      else if (file.text !== null && VERIFY_LINE_RE.test(file.text)) plan.changes.push({ path, before: file.text, after: null, purpose: "ownership proof", removeEmptyDirs: verifyDirs(data.publicDir) } satisfies FileChange);
      else if (file.text !== null) plan.manual.push({ file: path, reason: `${path} is not as the wizard writes it (the verification code on one line), so it is left; delete it if Parlox no longer needs it.`, snippet: `Delete ${path}.`, part: "server" });
    }
    // @vercel/functions is Vercel's package and may be used by more than the middleware: it stays. So does
    // @parlox/server while the app's own code imports it (sdk-use.ts).
    const kept = have["@parlox/server"] ? serverPackageKept(d.dir, io.read, plan, d.packageManager, io.others) : null;
    if (kept) plan.warnings.push(kept);
    const present = ["@parlox/browser", ...(kept ? [] : ["@parlox/server"])].filter((name) => have[name]);
    if (present.length) plan.install = packageCommand(d.packageManager, "remove", present);
    return plan;
  },

  hostStep: (d, host) => viteServerKind(host, d.data as ViteData) === "vercel-edge",

  hostNotes(d, host, role) {
    if (!role.server) return [];
    const data = d.data as ViteData;
    if (data.refusal) return [NO_EDGE_NOTE];
    const dashboard = host.id === "vercel" ? [data.vercelSettings ? settingsNote(data.vercelSettings) : DASHBOARD_NOTE] : [];
    if (viteServerKind(host, data) === "vercel-edge") return [EDGE_NOTE, ...dashboard, ...(data.yarnReleases ?? []).map(yarnReleaseNote)];
    if (data.vercelRoot && edgeMatters(host)) return [VERCEL_ROOT_NOTE, ...dashboard];
    return [data.exposure ? (edgeMatters(host) ? EXPOSED_NOTE : STATIC_EXPOSED_NOTE) : STATIC_NOTE, ...dashboard];
  },
};
