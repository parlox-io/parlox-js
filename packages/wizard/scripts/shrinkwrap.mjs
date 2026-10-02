// Regenerates npm-shrinkwrap.json for the published wizard: the exact dependency tree npx will install.
import { mkdtempSync, readFileSync, renameSync, rmSync, copyFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const here = resolve(import.meta.dirname, "..");
const tmp = mkdtempSync(join(tmpdir(), "wizard-shrinkwrap-"));
// devDependencies (@types/node, typescript) are removed from the temporary package.json, not just passed
// --omit=dev: npm's own lockfile format can still list a devDependency-only branch (flagged "dev": true) even
// under --omit=dev, for a package that has one, so leaving the field in place produced exactly those entries.
// Without the field there is nothing for npm to resolve or list for them.
const pkg = JSON.parse(readFileSync(join(here, "package.json"), "utf8"));
delete pkg.devDependencies;
writeFileSync(join(tmp, "package.json"), JSON.stringify(pkg, null, 2));
execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", ["install", "--package-lock-only", "--omit=dev", "--ignore-scripts"], { cwd: tmp, stdio: "inherit", shell: process.platform === "win32" });
renameSync(join(tmp, "package-lock.json"), join(tmp, "npm-shrinkwrap.json"));
copyFileSync(join(tmp, "npm-shrinkwrap.json"), join(here, "npm-shrinkwrap.json"));
rmSync(tmp, { recursive: true, force: true });
console.log("npm-shrinkwrap.json updated");
