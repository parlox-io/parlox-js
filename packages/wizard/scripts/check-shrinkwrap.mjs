// Fails when the published dependency tree carries dev entries or any package with an install script.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const lock = JSON.parse(readFileSync(resolve(import.meta.dirname, "..", "npm-shrinkwrap.json"), "utf8"));
const entries = Object.entries(lock.packages ?? {}).filter(([k]) => k !== "");
const dev = entries.filter(([, v]) => v.dev).map(([k]) => k);
const scripts = entries.filter(([, v]) => v.hasInstallScript).map(([k]) => k);
if (dev.length || scripts.length) {
  console.error(`dev entries: ${dev.join(", ") || "none"}\ninstall scripts: ${scripts.join(", ") || "none"}`);
  process.exit(1);
}
console.log(`ok: ${entries.length} packages, no dev entries, no install scripts`);
