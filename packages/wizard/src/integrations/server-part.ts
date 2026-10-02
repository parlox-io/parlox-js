import { addUseLine, useSnippet, type AppKind } from "../edits/use-line.js";
import { PathError } from "../fs-safe.js";
import type { Host, HostId } from "../hosts.js";
import { ownReportWarning, type OwnReport } from "../own-reporting.js";
import { declared, packageCommand, type Plan } from "../plan-core.js";
import type { PackageManager } from "../workspace.js";
import type { PlanInput } from "./types.js";

// The server part Express and Hono share: `app.use(parlox())` in the file that creates the app, with the import from
// the framework's adapter, and the package. The same guards for both: no server part for an app that reports with its
// own code; a step by hand for a file the wizard may not read, one git ignores (built or generated), or no file found.

/** A file read that refuses a symlink or an oversized file (fs-safe.ts) as a reason for a step by hand. */
export function tryRead(read: (rel: string) => string | null, rel: string): { text: string | null } | { refused: string } {
  try { return { text: read(rel) }; }
  catch (err) {
    if (err instanceof PathError) return { refused: `${err.message}.` };
    throw err;
  }
}

// Hosts whose files say the server runs as a process that keeps running between requests, where @parlox/server queues
// reports (packages/server/src/queue.ts) and a stop on a signal loses what waits unless the app flushes it: the SDK
// installs no signal handlers, since a library's listener would replace Node's default exit.
const LONG_RUNNING: Partial<Record<HostId, string>> = { fly: "on Fly.io", render: "on Render", railway: "on Railway", docker: "in a Docker container" };
const SHUTDOWN_README = "https://github.com/parlox-io/parlox-js/tree/main/packages/server#shutdown-long-running-servers";

/** The report's line for an Express or Hono server part on such a host, pointing to the shutdown snippet in
 * @parlox/server's README; null on any other host (Vercel, Netlify and Cloudflare run it per request; where no host
 * file says, the wizard does not know). */
export function shutdownNote(host: Pick<Host, "id">): string | null {
  const where = LONG_RUNNING[host.id];
  return where ? `This server keeps running between requests ${where}, so reports wait in a queue, and a stop on a signal loses them unless your shutdown code sends them first (await parlox.flush()): ${SHUTDOWN_README}` : null;
}

export interface UseLinePart {
  kind: AppKind;
  /** The adapter's module: "@parlox/server/express". */
  source: string;
  /** The file that creates the app, or null (none found). */
  file: string | null;
  /** How a step by hand names the file when none was found ("your server file"). */
  placeholder: string;
  /** Why no file can be edited, or null; `notFound` when no reason was recorded. */
  reason: string | null;
  notFound: string;
  pkgType: string | undefined;
  ownReport: OwnReport | null;
  ownReportNotChecked: string | null;
}

/** The server part: `app.use(parlox())` in the app's file, and the package. */
export function planUseLine(pm: PackageManager, part: UseLinePart, input: PlanInput, plan: Plan): void {
  if (part.ownReport) { plan.warnings.push(ownReportWarning(part.ownReport)); return; }
  if (part.ownReportNotChecked) plan.warnings.push(part.ownReportNotChecked);
  const snippet = useSnippet(part.kind, part.source);
  const file = part.file;
  const got = file ? tryRead(input.read, file) : { text: null };
  if ("refused" in got) plan.manual.push({ file: file!, reason: got.refused, snippet, part: "server" });
  // A file git ignores is built or generated, and a change to it would not be committed with the app.
  else if (file && got.text !== null && input.git.isRepo() && input.git.isIgnored(file)) plan.manual.push({ file, reason: `git ignores ${file}, so it is likely built or generated, and a change there would not be kept; add this to the source it comes from.`, snippet, part: "server" });
  else if (!file) plan.manual.push({ file: part.placeholder, reason: part.reason ?? part.notFound, snippet, part: "server", placeholder: true });
  else if (got.text === null) plan.manual.push({ file, reason: part.reason ?? part.notFound, snippet, part: "server" });
  else {
    const e = addUseLine(got.text, file, { kind: part.kind, source: part.source, pkgType: part.pkgType });
    if (!e.ok) plan.manual.push({ file, reason: e.reason, snippet: e.snippet, part: "server" });
    else if (e.changed) plan.changes.push({ path: file, before: got.text, after: e.code, purpose: "server part" });
  }
  if (declared(input.read)["@parlox/server"] !== input.versions.server) plan.install = packageCommand(pm, "add", [`@parlox/server@${input.versions.server}`]);
}
