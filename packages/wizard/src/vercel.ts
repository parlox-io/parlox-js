import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { defaultRunner, type Runner } from "./run.js";

export async function vercelProject(dir: string, run: Runner = defaultRunner): Promise<{ name: string } | null> {
  const p = join(dir, ".vercel", "project.json");
  if (!existsSync(p)) return null;
  let name = "";
  try { name = String(JSON.parse(readFileSync(p, "utf8")).projectName ?? ""); } catch { return null; }
  if ((await run("vercel", ["--version"], { cwd: dir })).status !== 0) return null;
  const who = await run("vercel", ["whoami"], { cwd: dir });
  if (who.status !== 0 || /log in/i.test(who.stdout + who.stderr)) return null;
  return { name: name || "(unnamed project)" };
}

// The production variables' listing: stdout of `vercel env ls production` (it prints its table on stdout, confirmed
// against the real CLI; stderr only carries the CLI's own error text on failure), or null when the command failed.
// Listed once per run and read for each variable (varIn).
export async function vercelEnvList(dir: string, run: Runner = defaultRunner): Promise<string | null> {
  const r = await run("vercel", ["env", "ls", "production"], { cwd: dir });
  return r.status === 0 ? r.stdout : null;
}

// "unknown" (not "no") when the listing failed: a caller that treated a failed check as "absent" would go on to create
// a new secret key and then fail to store it, orphaning it on the account with nothing pointing at it.
export function varIn(listing: string | null, name: string): "yes" | "no" | "unknown" {
  if (listing === null) return "unknown";
  return new RegExp(`(^|\\s)${name}(\\s|$)`, "m").test(listing) ? "yes" : "no";
}

export async function vercelHasVar(dir: string, name: string, run: Runner = defaultRunner): Promise<"yes" | "no" | "unknown"> {
  return varIn(await vercelEnvList(dir, run), name);
}

/** Whether this Vercel CLI's `vercel env add` takes `--visibility secret`: Vercel's Config and Secret types ("pass
 * --visibility config or --visibility secret to vercel env add or vercel env update", vercel.com/changelog/environment-
 * variables-now-use-config-and-secret-types, 2026-08-24). Read from the command's own help, which Vercel CLI 59.1.3
 * prints on stderr with exit code 2, so both streams count whatever the status. No version number is parsed. */
export async function vercelHasSecretVisibility(dir: string, run: Runner = defaultRunner): Promise<boolean> {
  const r = await run("vercel", ["env", "add", "--help"], { cwd: dir });
  return /^\s*--visibility\b[\s\S]{0,300}?\bsecret\b/m.test(`${r.stdout}\n${r.stderr}`);
}

// The value goes to the developer's own Vercel CLI on standard input, never in the arguments, where other programs on
// the computer can read it. Production only. `secret`: true stores it as sensitive (--sensitive), "visibility" as a
// Secret (--visibility secret, on a CLI that has it); either way it cannot be read back from Vercel, and Vercel still
// gives it to the project's deployments and builds.
export async function addVercelEnv(dir: string, name: string, value: string, secret: boolean | "visibility", run: Runner = defaultRunner): Promise<{ ok: true } | { ok: false; message: string }> {
  const flags = secret === "visibility" ? ["--visibility", "secret"] : secret ? ["--sensitive"] : [];
  const r = await run("vercel", ["env", "add", name, "production", ...flags], { cwd: dir, input: value });
  if (r.status === 0) return { ok: true };
  const out = (r.stdout + r.stderr).split(value).join("[hidden]");
  return { ok: false, message: `Vercel did not accept ${name}: ${out.trim().slice(0, 300)}` };
}
