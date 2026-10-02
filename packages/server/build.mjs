// Builds @parlox/server: ES modules, CommonJS (for require()) and type declarations. No runtime dependencies.
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";

const entryPoints = ["src/index.ts", "src/next.ts", "src/express.ts", "src/fetch.ts", "src/hono.ts", "src/vercel.ts"];
rmSync("dist", { recursive: true, force: true });
await build({ entryPoints, outdir: "dist/esm", bundle: true, splitting: true, format: "esm", platform: "neutral", target: "es2022", chunkNames: "chunks/[name]-[hash]", logLevel: "error" });
await build({ entryPoints, outdir: "dist/cjs", outExtension: { ".js": ".cjs" }, bundle: true, format: "cjs", platform: "neutral", target: "es2022", logLevel: "error" });
const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
execFileSync(process.execPath, [tsc, "-p", "tsconfig.json", "--emitDeclarationOnly"], { stdio: "inherit" });
// CommonJS consumers get their own declarations (.d.cts beside the .cjs files) so TypeScript under node16/nodenext
// resolves require() types as CommonJS rather than as the ESM declarations ("masquerading as ESM").
import { readdirSync as __ls } from "node:fs";
for (const f of __ls("dist/types")) {
  if (!f.endsWith(".d.ts")) continue;
  const src = readFileSync(`dist/types/${f}`, "utf8").replace(/from "(\.\/[^"]+)\.js"/g, 'from "$1.cjs"').replace(/import\("(\.\/[^"]+)\.js"\)/g, 'import("$1.cjs")');
  writeFileSync(`dist/cjs/${f.replace(/\.d\.ts$/, ".d.cts")}`, src);
}

console.log("@parlox/server built");
