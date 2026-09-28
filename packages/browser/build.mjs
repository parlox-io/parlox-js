// Builds @parlox/browser.
//   dist/tag/      the hosted tag and recorder (IIFE, minified) plus manifest.json with their SRI hashes
//   dist/esm/      the npm module (ES modules; the recorder is a separate chunk, loaded lazily)
//   dist/cjs/      the npm module for require()
//   dist/types/    type declarations
// The recorder is built first because the tag embeds its integrity hash.
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
const version = pkg.version;
const sri = (buf) => "sha384-" + createHash("sha384").update(buf).digest("base64");
// Old browsers are not the audience of agent analytics, but a person on an old phone must never get a syntax error.
const BROWSERS = ["chrome80", "safari14", "firefox78", "edge80"];
// The recorder (rrweb) needs newer syntax; it only ever runs in automated browsers, which are current Chromium builds.
const RECORDER_BROWSERS = ["chrome100", "safari16", "firefox100"];

rmSync("dist", { recursive: true, force: true });
mkdirSync("dist/tag", { recursive: true });

// 1. Hosted recorder.
const rec = await build({
  entryPoints: ["src/recorder-tag.ts"], bundle: true, format: "iife", platform: "browser", target: RECORDER_BROWSERS,
  minify: true, legalComments: "none", write: false, logLevel: "error",
});
const recorderJs = rec.outputFiles[0].contents;
writeFileSync("dist/tag/parlox-record.js", recorderJs);
const recorderSri = sri(recorderJs);

// 2. Hosted tag, pinned to this release's recorder.
const tag = await build({
  entryPoints: ["src/tag.ts"], bundle: true, format: "iife", platform: "browser", target: BROWSERS,
  minify: true, legalComments: "none", write: false, logLevel: "error",
  define: { __SDK_VERSION__: JSON.stringify(version), __RECORDER_SRI__: JSON.stringify(recorderSri) },
});
const tagJs = tag.outputFiles[0].contents;
writeFileSync("dist/tag/parlox.js", tagJs);
writeFileSync("dist/tag/manifest.json", JSON.stringify({ version, tag_sri: sri(tagJs), recorder_sri: recorderSri, tag_bytes: tagJs.length, recorder_bytes: recorderJs.length }, null, 2) + "\n");

// 3. npm module, as standard ES2020: the merchant's bundler transpiles it to their own browser targets, and
//    dependencies stay external so it resolves them from their lockfile.
const external = ["@rrweb/record", "react"];
await build({
  entryPoints: ["src/index.ts", "src/react.ts"], outdir: "dist/esm", bundle: true, splitting: true, format: "esm",
  platform: "browser", target: "es2020", external, chunkNames: "chunks/[name]-[hash]", logLevel: "error",
});
// CommonJS has no code splitting, so each module is its own file and they require each other: react.cjs uses
// index.cjs (one shared tracker instance for track() and <ParloxAnalytics>), and index.cjs requires recorder.cjs only
// when an automated browser is detected.
const siblings = { "./index.js": "./index.cjs", "./recorder.js": "./recorder.cjs" };
const cjsSiblings = (self) => ({
  name: "cjs-siblings",
  setup(b) {
    b.onResolve({ filter: /^\.\/(index|recorder)\.js$/ }, (a) => (a.path !== self && siblings[a.path] ? { path: siblings[a.path], external: true } : undefined));
  },
});
for (const [entry, self] of [["src/index.ts", "./index.js"], ["src/react.ts", "./react.js"], ["src/recorder.ts", "./recorder.js"]]) {
  await build({
    entryPoints: [entry], outdir: "dist/cjs", outExtension: { ".js": ".cjs" }, bundle: true,
    format: "cjs", platform: "browser", target: "es2020", external, plugins: [cjsSiblings(self)], logLevel: "error",
  });
}
// React Server Components: the component must be marked for the client in the built file.
for (const f of ["dist/esm/react.js", "dist/cjs/react.cjs"]) writeFileSync(f, '"use client";\n' + readFileSync(f, "utf8"));

// 4. Types.
const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
execFileSync(process.execPath, [tsc, "-p", "tsconfig.json", "--emitDeclarationOnly"], { stdio: "inherit" });
// The tag entries are not part of the npm API.
for (const f of ["tag.d.ts", "recorder-tag.d.ts"]) rmSync(`dist/types/${f}`, { force: true });
// CommonJS consumers get their own declarations (.d.cts beside the .cjs files) so TypeScript under node16/nodenext
// resolves require() types as CommonJS rather than as the ESM declarations ("masquerading as ESM").
import { readdirSync as __ls } from "node:fs";
for (const f of __ls("dist/types")) {
  if (!f.endsWith(".d.ts")) continue;
  const src = readFileSync(`dist/types/${f}`, "utf8").replace(/from "(\.\/[^"]+)\.js"/g, 'from "$1.cjs"').replace(/import\("(\.\/[^"]+)\.js"\)/g, 'import("$1.cjs")');
  writeFileSync(`dist/cjs/${f.replace(/\.d\.ts$/, ".d.cts")}`, src);
}


console.log(`@parlox/browser ${version}: tag ${tagJs.length} B, recorder ${recorderJs.length} B`);
