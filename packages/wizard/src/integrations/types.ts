import type { Git } from "../git.js";
import type { Host } from "../hosts.js";
import type { Plan } from "../plan-core.js";
import type { PackageManager } from "../workspace.js";

// One stack the wizard installs into. The shared flow (sign-in, site, review, apply, host, check, report, uninstall)
// knows nothing about the stack; an integration finds its app (detect, read only), says exactly what it would change
// (plan), and exactly how to undo it (unplan). Structure as in PostHog's wizard (src/programs/frameworks/, a registry)
// and Sentry's (one folder per framework): here with fixed syntax-tree edits shown as a diff first.

export type IntegrationId = "nextjs" | "vite-react" | "express" | "hono";

/** Where a part goes: a file (null with manualReason: the developer pastes a snippet), and what kind of edit. */
export interface PartTarget { file: string | null; kind: string; manualReason?: string }

/** The local check: the address the dev server answers on and the command that starts it, or why there is none. */
export type LocalCheck = { url: string; start: string } | { skip: string };

export interface Detection {
  integration: IntegrationId;
  /** The app folder (absolute). */
  dir: string;
  /** The workspace root (absolute; dir itself outside a monorepo). */
  root: string;
  packageManager: PackageManager;
  parts: { browser: PartTarget | null; server: PartTarget | null };
  /** Shown to the developer: ["Found", "Next.js 16 · App Router · TypeScript · npm"]. */
  facts: Array<[string, string]>;
  /** What is not covered and why, for the report. */
  notes: string[];
  /** The env file the project loads (PARLOX_VERIFY_TOKEN and a --local-key key go there), or null: none is loaded. */
  envFile: string | null;
  localCheck: LocalCheck;
  /** The integration's own findings; only its plan and unplan read them. */
  data: unknown;
}

export interface PlanIo {
  read(rel: string): string | null;
  git: Git;
  /** How the review names a file of this app (names.file: "apps/api/.env" in a run with several apps); the path itself
   * when not given. */
  shown?(rel: string): string;
  /** For an uninstall: the files another integration of the same app edits (its server file). Their Parlox lines are
   * that integration's to take out, so they never keep @parlox/server installed by themselves (sdk-use.ts). */
  others?: string[];
}
export interface PlanInput extends PlanIo {
  publicKey: string;
  verifyToken: string;
  host: Host;
  versions: { browser: string; server: string };
  /** Which parts this plan covers: a folder matched by two integrations takes each part from one of them.
   * `verifyFile`: only the ownership file of the server part (a Vite app whose Express server serves its build, with
   * that server's own part withheld: apps.ts). */
  parts: { browser: boolean; server: boolean; verifyFile?: boolean };
}

export interface Integration {
  id: IntegrationId;
  /** "Vite React", shown in facts and pickers. */
  label: string;
  /** Is this folder one of mine? Reads package.json and known files only; never writes. Throws DetectError for an app
   * of this stack the wizard cannot install into (an old Next.js, NestJS). */
  detect(dir: string, root: string): Detection | null;
  /** The exact changes for install (browser part, server part or both). Paths are relative to d.dir. */
  plan(d: Detection, input: PlanInput): Plan;
  /** The exact changes to undo an install; byte for byte back to the original where the wizard made the edit. */
  unplan(d: Detection, io: PlanIo): Plan;
  /** Whether this app's server part needs PARLOX_SECRET_KEY on the host (the host step). Default: it has a server part. */
  hostStep?(d: Detection, host: Host): boolean;
  /** Report lines that depend on the host and on the part this detection plays in its app (a static site off Vercel
   * does not see crawlers; a server with no pages says the browser part belongs in the frontend). */
  hostNotes?(d: Detection, host: Host, role: NoteRole): string[];
  /** What the host hand-off says beside the variables, where the developer sets them (a Worker's key is a runtime
   * secret, not a build variable). */
  handoffNotes?(d: Detection, host: Host): string[];
}

/** Which parts of its app a detection provides, and whether the app has a browser part at all. */
export interface NoteRole { browser: boolean; server: boolean; unitHasBrowser: boolean }
