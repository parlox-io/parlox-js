import { basename } from "node:path";
import type { AppUnit } from "./apps.js";
import { LOCAL_KEY_PREFIX } from "./hosts.js";

// How a run names its apps, in one place. A run with one app keeps the names it always had ("Netlify · production",
// "Set on Netlify:"); only a run with several apps names each app, so each key can be revoked on its own and
// each hand-off says which app it is for.

type Named = Pick<AppUnit, "rel" | "dir">;

/** An app as every message names it: its folder from where the wizard was started ("apps/web"), or, for that folder
 * itself, the folder's own name ("shop"). Never ".". */
export const appName = (u: Named): string => (u.rel === "." ? basename(u.dir) : u.rel);

/** A file of an app as the review shows it: relative to the folder the wizard was started in. */
export const appFile = (u: Pick<AppUnit, "rel">, file: string): string => (u.rel === "." ? file : `${u.rel}/${file}`);

/** At most `max` characters from the end of `text`, never starting inside a character that takes two (an emoji). */
const lastChars = (text: string, max: number): string => {
  if (text.length <= max) return text;
  const cut = text.slice(text.length - max);
  return /^[\uDC00-\uDFFF]/.test(cut) ? cut.slice(1) : cut;
};
const printableName = (name: string) => name.replace(/[\u0000-\u001f\u007f]/g, "");

/** "web · Vercel · production": in a run with several apps each key names its folder, so each can be revoked on its
 * own. At most 71 characters (the gateway adds "wizard · " and allows 80); a long folder keeps its end. */
export function keyLabel(rel: string, hostName: string): string {
  const tail = ` · ${hostName} · production`;
  return `${lastChars(printableName(rel), 71 - tail.length)}${tail}`;
}

/** At least this many characters of the computer's name stay in a local key's name, before the "…" that marks it
 * shortened. */
const MIN_COMPUTER = 4;

/** The local key's name in a run with several apps: "local dev · <computer> · web" (`computer`: localKeyName's
 * "local dev · <computer>"), within the same 71 characters. The folder is what tells the keys apart, so where the name
 * would be longer, the computer's name is shortened first, to MIN_COMPUTER characters at least, and marked with "…";
 * only a folder too long even then keeps its end, as keyLabel's does. */
export function localKeyLabel(computer: string, rel: string): string {
  const folder = printableName(rel);
  const sep = " · ";
  if (computer.length + sep.length + folder.length <= 71) return `${computer}${sep}${folder}`;
  const least = Math.min(computer.length, LOCAL_KEY_PREFIX.length + MIN_COMPUTER + 1);
  const kept = Math.max(71 - sep.length - folder.length, least);
  const head = kept >= computer.length ? computer : `${computer.slice(0, kept - 1)}…`;
  return `${head}${sep}${lastChars(folder, 71 - sep.length - head.length)}`;
}

export interface RunNames {
  /** Whether the run has one app: then no name below mentions it. */
  single: boolean;
  /** The folder named in the review and its question: the one app, or the folder the wizard was started in. */
  target: string;
  /** The app's name (appName). */
  app(u: Named): string;
  /** A folder the scan reported, by the same rule ("." is the start folder's own name). */
  folder(rel: string): string;
  /** " (apps/web)" after a part's name, or nothing in a run with one app. */
  of(u: Named): string;
  /** " in apps/web" after a task, or nothing in a run with one app. */
  inApp(u: Named): string;
  /** " for apps/web" after a question, or nothing in a run with one app. */
  forApp(u: Named): string;
  /** Where a command to finish by hand must run: " in apps/web", or nothing when that is where the wizard was started
   * (a run with one app, started in its folder). */
  runIn(u: Named): string;
  /** "apps/web: <text>", or the text alone in a run with one app. */
  note(u: Named, text: string): string;
  /** A file of the app as the review shows it: relative to the folder the wizard was started in. */
  file(u: Named, file: string): string;
  /** The production key's name: "Netlify · production", or "apps/web · Netlify · production". */
  key(u: Named, hostName: string): string;
  /** The local key's name: `computer` ("local dev · <computer>"), or with the app after it. */
  localKey(u: Named, computer: string): string;
  /** The host line of a hand-off: "Netlify", or "Netlify (for apps/web)". */
  host(u: Named, label: string): string;
}

/** The names for a run over `units`, whose paths are relative to `base` (the folder the wizard was started in). */
export function runNames(units: Named[], base: string): RunNames {
  const single = units.length === 1;
  const folder = (rel: string) => (rel === "." ? basename(base) : rel);
  return {
    single,
    target: single ? appName(units[0]) : basename(base),
    app: appName,
    folder,
    of: (u) => (single ? "" : ` (${appName(u)})`),
    inApp: (u) => (single ? "" : ` in ${appName(u)}`),
    forApp: (u) => (single ? "" : ` for ${appName(u)}`),
    runIn: (u) => (single && u.rel === "." ? "" : ` in ${appName(u)}`),
    note: (u, text) => (single ? text : `${appName(u)}: ${text}`),
    file: appFile,
    key: (u, hostName) => (single ? `${hostName} · production` : keyLabel(appName(u), hostName)),
    localKey: (u, computer) => (single ? computer : localKeyLabel(computer, appName(u))),
    host: (u, label) => (single ? label : `${label} (for ${appName(u)})`),
  };
}
