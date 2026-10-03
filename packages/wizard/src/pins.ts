// The Parlox packages the wizard adds, at the versions it was tested with (versions.ts), and never over a newer one the
// app already declares. One rule for every integration, by what package.json says for the package:
// - nothing: the pinned version is added;
// - an exact version, or a ^ or ~ range, of the pinned version's major: kept when its lowest version is the pinned one
//   or later (the plan says so), and replaced by the pinned version when it is earlier;
// - another major, or a spec the wizard cannot compare (workspace:, file:, link:, a git or URL source, an npm: alias, a
//   tag such as latest, *, any other range): kept as it is, and the plan says the wizard did not change it.
// The wizard reads only package.json here: what is installed in node_modules may differ until the package manager runs.

interface Version { core: [number, number, number]; pre: string[] }

// semver.org's grammar: x.y.z without leading zeros, an optional prerelease (numeric identifiers without leading zeros)
// and optional build metadata, which takes no part in the order.
const ID = "(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)";
const VERSION_RE = new RegExp(`^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(?:-(${ID}(?:\\.${ID})*))?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`);

function parseVersion(text: string): Version | null {
  const m = VERSION_RE.exec(text);
  return m ? { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split(".") : [] } : null;
}

const NUMERIC = /^\d+$/;

// How a spec the wizard cannot compare is named in the plan: quoted, and without the user part of a git or URL
// address (git+https://<token>@github.com/…), where a token can be.
const shownSpec = (spec: unknown): string => JSON.stringify(typeof spec === "string" ? spec.replace(/:\/\/[^/@\s]*@/g, "://[hidden]@") : spec);

/** semver.org's precedence: -1, 0 or 1. A prerelease is lower than its release; prerelease identifiers compare as
 * numbers when both are numbers, a number is lower than a word, words compare in ASCII order, and a shorter list is
 * lower when it is the start of the longer one. */
function compare(a: Version, b: Version): number {
  for (let i = 0; i < 3; i++) if (a.core[i] !== b.core[i]) return a.core[i] < b.core[i] ? -1 : 1;
  if (!a.pre.length || !b.pre.length) return Math.sign(b.pre.length - a.pre.length);
  for (let i = 0; i < Math.min(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i], y = b.pre[i];
    if (x === y) continue;
    const xn = NUMERIC.test(x), yn = NUMERIC.test(y);
    // Without leading zeros, a longer number is the larger one (and no digits are lost to floating point).
    if (xn && yn) return x.length !== y.length ? (x.length < y.length ? -1 : 1) : x < y ? -1 : 1;
    if (xn !== yn) return xn ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return Math.sign(a.pre.length - b.pre.length);
}

/** -1, 0 or 1 as `a` is earlier than, the same as, or later than `b`; null when either is not an x.y.z version. */
export function compareVersions(a: string, b: string): number | null {
  const x = parseVersion(a), y = parseVersion(b);
  return x && y ? compare(x, y) : null;
}

/** For one package: what to add (`name@pinned`), or null; and the plan's line when the wizard keeps what package.json
 * declares, or null. `spec`: package.json's value for the package (undefined when it is not there). */
export function pinFor(name: string, spec: unknown, pinned: string): { add: string | null; note: string | null } {
  if (spec === undefined) return { add: `${name}@${pinned}`, note: null };
  const want = parseVersion(pinned);
  if (!want) throw new Error(`The version pinned for ${name} is not x.y.z: ${pinned}`);
  const prefix = typeof spec === "string" && (spec.startsWith("^") || spec.startsWith("~")) ? spec[0] : "";
  const low = typeof spec === "string" ? parseVersion(spec.slice(prefix.length)) : null;
  const unchanged = (what: string) => ({ add: null, note: `${what}, so the wizard did not change it.` });
  if (!low) return unchanged(`${name} is already in package.json as ${shownSpec(spec)}, which the wizard cannot compare with the version it was tested with (${pinned})`);
  if (low.core[0] !== want.core[0]) return unchanged(`${name} ${spec} is already in package.json, a different major version from the one this wizard was tested with (${pinned})`);
  const c = compare(low, want);
  if (c < 0) return { add: `${name}@${pinned}`, note: null };
  if (c === 0 && !prefix) return { add: null, note: null };
  return { add: null, note: c > 0
    ? `${name} ${spec} is already in package.json, newer than the version this wizard was tested with (${pinned}), so the wizard keeps it.`
    : `${name} ${spec} is already in package.json: the version this wizard was tested with (${pinned}) or newer, so the wizard keeps it.` };
}

/** pinFor for each package, in order: the packages to add, and the plan's lines for those kept. `have`: package.json's
 * declared dependencies (plan-core.ts, declared). */
export function packagesToAdd(have: Record<string, unknown>, wanted: Array<readonly [name: string, pinned: string]>): { add: string[]; notes: string[] } {
  const out: { add: string[]; notes: string[] } = { add: [], notes: [] };
  for (const [name, pinned] of wanted) {
    const r = pinFor(name, have[name], pinned);
    if (r.add) out.add.push(r.add);
    if (r.note) out.notes.push(r.note);
  }
  return out;
}
