// The command line: every flag the wizard knows, checked strictly (a misspelled flag never falls through to an install).

export interface Args {
  uninstall: boolean; dryRun: boolean; yes: boolean; allowDirty: boolean; allowNoGit: boolean; noBrowser: boolean;
  skipCheck: boolean; vercel: boolean; noVercel: boolean; debug: boolean; localKey: boolean; site?: string; url?: string;
  /** --app folders, in the order given (repeatable). */
  apps: string[];
}
const BOOLEAN_FLAGS = ["--dry-run", "--yes", "--allow-dirty", "--allow-no-git", "--no-browser", "--skip-check", "--vercel", "--no-vercel", "--debug", "--local-key"] as const;
const VALUE_FLAGS = ["--site", "--url", "--app"] as const;
const KNOWN_FLAGS = new Set<string>([...BOOLEAN_FLAGS, ...VALUE_FLAGS]);

/** Rejects anything not a known flag (or "init"/"uninstall" as the first argument): a misspelled or unrecognised flag
 * (e.g. `--dryrun`) must never be silently ignored and fall through to a real install, and `--site`/`--url`/`--app`
 * must never silently swallow the next flag as their value (e.g. `--url --yes`). No command is the same as "init".
 * `--app` may be given more than once (one folder each); the others keep their last value. */
export function parseArgs(argv: string[]): Args | { error: string } {
  const command = argv[0] === "init" || argv[0] === "uninstall" ? argv[0] : null;
  const uninstall = command === "uninstall";
  const rest = command ? argv.slice(1) : argv;
  const values: Record<string, string> = {};
  const present = new Set<string>();
  const apps: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!KNOWN_FLAGS.has(a)) return { error: `Unknown option: ${a}\nValid flags: ${[...KNOWN_FLAGS].join(", ")}${command ? "" : ", or \"init\"/\"uninstall\" as the first argument"}` };
    if ((VALUE_FLAGS as readonly string[]).includes(a)) {
      const v = rest[i + 1];
      if (v === undefined || v.startsWith("--")) return { error: `${a} needs a value after it (got ${v === undefined ? "nothing" : JSON.stringify(v)}).` };
      if (a === "--app") apps.push(v); else values[a] = v;
      i++;
    } else {
      present.add(a);
    }
  }
  return {
    uninstall, dryRun: present.has("--dry-run"), yes: present.has("--yes"), allowDirty: present.has("--allow-dirty"), allowNoGit: present.has("--allow-no-git"),
    noBrowser: present.has("--no-browser"), skipCheck: present.has("--skip-check"), vercel: present.has("--vercel"), noVercel: present.has("--no-vercel"), debug: present.has("--debug"),
    localKey: present.has("--local-key"), site: values["--site"], url: values["--url"], apps,
  };
}
