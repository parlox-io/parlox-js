// Runs the wizard's test files with node --test. The files are listed here rather than passed as a glob: glob
// arguments to --test need Node 21, and with no arguments Node 20 would also pick up the JavaScript inside
// test/fixtures (the generated apps), which are inputs, not tests.
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = fileURLToPath(new URL("../test/", import.meta.url));
const files = readdirSync(dir).filter((f) => f.endsWith(".test.mjs")).sort().map((f) => join("test", f));
if (files.length === 0) {
  console.error("No test files found in test/");
  process.exit(1);
}
const r = spawnSync(process.execPath, ["--test", ...process.argv.slice(2), ...files], { stdio: "inherit", cwd: join(dir, "..") });
process.exit(r.status ?? 1);
