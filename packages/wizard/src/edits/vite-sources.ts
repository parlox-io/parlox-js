import { posix } from "node:path";
import type { WorkspacePackage } from "./vite-install.js";

// The files a Vite build can process, and what in them loads code while Vite builds: Tailwind's @plugin and @config,
// Less's @plugin, Stylus's use(), in stylesheets, in <style> blocks of HTML files, and in the style blocks of Vue and
// Svelte components; a component template in another language (Pug and the like run code when they compile). The walk
// covers the app folder (every folder but node_modules, .git and Vite's own build output) and every folder its sources
// import from inside the repository (a workspace package, a local package, a relative path, an alias), read with the
// same checks. An import from outside the repository, or one the wizard cannot follow, is not proven safe. Packages from
// the npm registry are what the install already runs; their own files are not read. Only reads, through the reader it
// is given; vite-build-files.ts words the reasons.

export interface SourceReader {
  read: (rel: string) => string | null;
  exists: (rel: string) => boolean;
  /** The names in a folder, a folder's with "/" after it; null when it cannot be listed. */
  list: (rel: string) => string[] | null;
}

/** Where a Vite alias leads: a folder or file relative to the app folder, a package name (`vue: 'vue/dist/…'`), or
 * null when the wizard cannot follow it. */
export type AliasTarget = { path: string } | { bare: string } | null;

export interface SourceContext {
  /** Vite's root and output folder, relative to the app folder; null when not known (nothing is skipped then). */
  root: string;
  outDir: string | null;
  /** Vite copies its public folder as it is: its files are not built, so what they import is not read. */
  publicDir: string | false | null;
  /** resolve.alias, by key, or "any" when an alias may match any name (a RegExp, or one written in code). */
  aliases: Map<string, AliasTarget> | "any";
  /** tsconfig paths, when Vite resolves imports through them (vite-tsconfig-paths, resolve.tsconfigPaths): each pattern
   * with its targets relative to the app folder ("*" for a baseUrl, tried besides the packages); "unknown" when they
   * cannot be read; null when they are not used. */
  tsconfigPaths: Array<{ pattern: string; targets: string[]; baseUrl?: boolean }> | "unknown" | null;
  /** The packages of the workspace (folders relative to the app folder). */
  packages: WorkspacePackage[];
  /** The folders whose package.json may declare a local package (file:, link:, portal:): the app's, the workspace
   * root's, the repository top's. */
  pkgFolders: string[];
  /** The top of the repository, relative to the app folder. */
  repoTop: string;
  /** Files and folders the config gives the build besides its imports (build inputs, stylesheet load paths), or
   * "unknown". */
  entries: string[] | "unknown";
}

const at = (folder: string, name: string) => (folder === "." ? name : `${folder}/${name}`);
const lineAt = (text: string, index: number) => text.slice(0, index).split("\n").length;
// A base deep enough that a path relative to the app folder never climbs above it.
const BASE = `/${Array.from({ length: 64 }, (_, i) => `d${i}`).join("/")}`;
/** Whether `p` is `dir` or inside it (both relative to the app folder, "/"-separated). */
const within = (p: string, dir: string): boolean => {
  const r = posix.relative(posix.join(BASE, dir), posix.join(BASE, p));
  return r === "" || (!r.startsWith("..") && !posix.isAbsolute(r));
};

// Every file Vite builds as a stylesheet (its CSS_LANGS_RE), and the sources whose imports the walk reads.
export const STYLE_RE = /\.(?:css|pcss|postcss|sss|less|sass|scss|styl|stylus)$/;
const SCRIPT_RE = /\.(?:[cm]?[jt]sx?)$/;
const DECLARATION_RE = /\.d\.[cm]?ts$/;
const COMPONENT_RE = /\.(?:vue|svelte)$/;
const HTML_RE = /\.html?$/;
// The state folders of package managers and host tools (Yarn's releases and cache, Wrangler's and Vercel's build output,
// build caches): bundles a build never imports, often over the 1 MB the wizard reads. Their stylesheets are still
// read; what their scripts import is not.
const TOOL_FOLDERS = new Set([".yarn", ".wrangler", ".vercel", ".netlify", ".turbo", ".cache", ".nx", ".parcel-cache", ".pnpm-store", ".next", ".nuxt", ".output", ".svelte-kit", ".angular"]);
const MAX_STYLES = 200;
const MAX_SOURCES = 5000;
const MAX_ENTRIES = 20_000;
const MAX_ROOTS = 50;

// The Tailwind plugins a stylesheet may load with @plugin (or @config): @tailwindcss/*, tailwindcss-animate (1.0.7: its
// only require is tailwindcss/plugin; no process or env), and daisyUI and its theme plugin (5.7.47 opened: only
// relative imports of its own files, and no process, require or import() anywhere in the package). Each must come from
// the npm registry (vite-install.ts).
const STYLE_PLUGIN = /^(?:@tailwindcss\/[a-z0-9][a-z0-9._-]*|tailwindcss-animate|daisyui(?:\/theme)?)$/;
export const STYLE_PLUGIN_PACKAGES = ["tailwindcss-animate", "daisyui"];

/** What in a stylesheet (of the language `ext`: "css", "less", "styl"…) loads code, or null: Less's @plugin (and
 * @import (plugin)), Stylus's use(), and Tailwind's @plugin and @config unless they name a plugin on the list (a path,
 * another package, or a name a Vite alias may point elsewhere, is code the wizard does not check). `base`: the line
 * the text starts on. */
export function styleOff(text: string, ext: string, aliases: string[] | "any", base = 1): string | null {
  const line = (i: number) => ` (line ${lineAt(text, i) + base - 1})`;
  if (ext === "less") {
    const m = /@plugin\b|@import\s*\([^)]*\bplugin\b/.exec(text);
    if (m) return `Less's @plugin${line(m.index)}`;
  }
  if (ext === "styl" || ext === "stylus") {
    const m = /\buse\s*\(/.exec(text);
    if (m) return `Stylus's use()${line(m.index)}`;
  }
  for (const m of text.matchAll(/@(plugin|config)\b/g)) {
    const q = /^\s*(["'])([^"'\n]*)\1/.exec(text.slice(m.index! + m[0].length));
    const spec = q?.[2];
    const aliased = spec !== undefined && (aliases === "any" || aliases.some((a) => spec === a || spec.startsWith(`${a}/`)));
    if (spec === undefined || !STYLE_PLUGIN.test(spec) || aliased) return `@${m[1]}${spec === undefined ? "" : ` "${spec}"`}${line(m.index!)}`;
  }
  return null;
}

/** An import: what to resolve, where it is in the text, and how it is written (a glob's whole pattern). */
type Spec = { spec: string; index: number; shown?: string };
// import … from "x", import "x", export … from "x", import("x"), require("x"), new URL("x", import.meta.url). Comments
// and strings that look like these count too: the walk reads more than the build, never less.
const JS_IMPORT = /(?:\b(?:import|export)\b[^'"`;()]*?\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*|\bnew\s+URL\s*\(\s*)(["'`])([^"'`\r\n]*)\1/g;
const GLOB = /\bimport\.meta\.glob(?:Eager)?\s*(?:<[^>]*>)?\s*\(([^)]*)\)/g;
const STRING = /(["'`])([^"'`\r\n]*)\1/g;
/** The specifiers a module imports. A glob's pattern counts up to its first wildcard; a template literal up to its first
 * ${…}. */
function jsImports(text: string): Spec[] {
  const out: Spec[] = [];
  for (const m of text.matchAll(JS_IMPORT)) out.push({ spec: m[2].split("${")[0], index: m.index! });
  for (const g of text.matchAll(GLOB)) for (const s of g[1].matchAll(STRING)) out.push({ spec: s[2].replace(/^!/, "").split(/[*?{[]/)[0] || ".", index: g.index!, shown: s[2] });
  return out;
}
// @import (also with url() and Less's options), Sass's @use and @forward, Stylus's @require, Tailwind's @reference, and
// CSS modules' composes … from.
const CSS_IMPORT = /@(?:import|use|forward|require|reference)\b\s*(?:\([^)]*\)\s*)?(?:url\(\s*)?(["']?)([^"')\s;,]+)\1/g;
const COMPOSES = /\bcomposes\s*:[^;]*?\bfrom\s+(["'])([^"']+)\1/g;
export function cssImports(text: string): Spec[] {
  return [...text.matchAll(CSS_IMPORT), ...text.matchAll(COMPOSES)].map((m) => ({ spec: m[2], index: m.index! }));
}
const attr = (attrs: string, name: string): string | null => new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`).exec(attrs)?.slice(1).find((v) => v !== undefined) ?? null;
const BLOCK = (tag: string) => new RegExp(`<${tag}\\b([^>]*)>([\\s\\S]*?)<\\/${tag}\\s*>`, "gi");

type Found = { root: string } | { off: string } | null;

/** Why the sources a Vite build can process may load code while it builds, or null when every one is proven not to. */
export function sourcesOff(f: SourceReader, c: SourceContext): string | null {
  const roots: string[] = ["."];
  const walked = new Set<string>();
  let entries = 0, styles = 0, sources = 0;
  // A folder, or a file's folder, the build reads from: walked when it is inside the repository and not inside a
  // folder already walked.
  const place = (target: string, from: string, spec: string, index: number, text: string): Found => {
    const p = posix.normalize(target);
    // A path into node_modules is a package from the registry, as a bare name would be.
    if (roots.some((r) => within(p, r)) || p.split("/").includes("node_modules")) return null;
    if (!within(p, c.repoTop)) return { off: `${from} imports ${JSON.stringify(spec)} (line ${lineAt(text, index)}), from outside this repository, which the wizard does not check` };
    // A file, or a name a preprocessor completes (a Sass partial): its folder.
    const dir = f.list(p) !== null ? p : posix.dirname(p);
    if (roots.length >= MAX_ROOTS) return { off: `This app's sources import from more than ${MAX_ROOTS} folders outside it, more than the wizard reads` };
    roots.push(dir);
    return null;
  };
  const pkgOf = (spec: string) => (spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]);
  /** A package declared with a local folder (file:, link:, portal:) in a package.json of the folder being walked, the
   * app, its workspace root or the repository top: that folder, relative to the app folder. */
  const localDep = (name: string, rootOfFile: string): string | null => {
    for (const folder of [rootOfFile, ...c.pkgFolders]) {
      let pkg: any;
      try { pkg = JSON.parse((f.read(at(folder, "package.json")) ?? "null").replace(/^﻿/, "")); } catch { continue; }
      for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
        const spec = pkg?.[field]?.[name];
        const m = typeof spec === "string" ? /^(?:file|link|portal):(.+)$/.exec(spec.trim()) : null;
        if (m) return posix.normalize(posix.join(folder, m[1]));
      }
    }
    return null;
  };
  const resolve = (spec: string, from: string, rootOfFile: string, index: number, text: string, raw = spec): Found => {
    let s = spec.trim();
    if (s.startsWith("#")) return null;
    s = s.replace(/\?.*$/, "").replace(/#.*$/, "");
    if (!s || s.startsWith("\0") || s.startsWith("//")) return null;
    const outside = (): Found => ({ off: `${from} imports ${JSON.stringify(raw)} (line ${lineAt(text, index)}), from outside this repository, which the wizard does not check` });
    if (/^file:/i.test(s) || /^[A-Za-z]:[\\/]/.test(s) || s.startsWith("/@fs/")) return outside();
    if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return null;
    // Vite resolves a path from / against its root (or its public folder): inside the app.
    if (s.startsWith("/")) return null;
    if (s.startsWith("~")) s = s.slice(1);
    if (s === "." || s === ".." || s.startsWith("./") || s.startsWith("../")) return place(posix.join(posix.dirname(from), s), from, raw, index, text);
    if (c.aliases === "any") return { off: `${from} imports ${JSON.stringify(raw)} (line ${lineAt(text, index)}), and the Vite config has an alias the wizard cannot follow (a RegExp, or one written in code), so it cannot tell where that import leads` };
    const key = [...c.aliases.keys()].filter((k) => s === k || s.startsWith(`${k}/`)).sort((a, b) => b.length - a.length)[0];
    if (key !== undefined) {
      const t = c.aliases.get(key)!;
      if (t === null) return { off: `${from} imports ${JSON.stringify(raw)} (line ${lineAt(text, index)}) through the Vite alias ${key}, which leads where the wizard cannot follow` };
      if ("path" in t) return place(posix.join(t.path, s.slice(key.length)), from, raw, index, text);
      s = `${t.bare}${s.slice(key.length)}`;
    }
    if (c.tsconfigPaths === "unknown") return { off: `${from} imports ${JSON.stringify(raw)} (line ${lineAt(text, index)}), and Vite resolves imports through tsconfig paths the wizard cannot read` };
    for (const p of c.tsconfigPaths ?? []) {
      const star = p.pattern.indexOf("*");
      const hit = star < 0 ? s === p.pattern : s.startsWith(p.pattern.slice(0, star)) && s.endsWith(p.pattern.slice(star + 1));
      if (!hit) continue;
      for (const t of p.targets) { const r = place(t.split("*")[0] || ".", from, raw, index, text); if (r) return r; }
      // A baseUrl is tried first, and the packages after it.
      if (!p.baseUrl) return null;
    }
    const name = pkgOf(s);
    const ws = c.packages.find((p) => p.name === name);
    if (ws) return place(ws.dir, from, raw, index, text);
    const local = localDep(name, rootOfFile);
    if (local !== null) return place(local, from, raw, index, text);
    return null;
  };

  for (const e of c.entries === "unknown" ? [] : c.entries) {
    const r = place(e, "The Vite config", e, 0, "");
    if (r && "off" in r) return `The Vite config gives the build ${JSON.stringify(e)}, from outside this repository, which the wizard does not check`;
  }
  if (c.entries === "unknown") return "The Vite config gives the build inputs or stylesheet folders the wizard cannot follow (written in code, or an absolute path)";

  for (let i = 0; i < roots.length; i++) {
    const top = roots[i];
    if (walked.has(top)) continue;
    walked.add(top);
    const files: Array<{ rel: string; kind: "style" | "html" | "component" | "script" }> = [];
    const queue = [top];
    while (queue.length) {
      const folder = queue.shift()!;
      const names = f.list(folder);
      if (names === null) return `${folder === "." ? "This folder" : folder} cannot be listed, and Vite may build stylesheets in it`;
      for (const name of [...names].sort()) {
        if (++entries > MAX_ENTRIES) return `This folder holds more than ${MAX_ENTRIES} files, more than the wizard checks for stylesheets that load code`;
        const rel = at(folder, name.replace(/\/$/, ""));
        if (name.endsWith("/")) {
          const dir = name.slice(0, -1);
          if (dir !== "node_modules" && dir !== ".git" && !(c.outDir !== null && rel === c.outDir)) queue.push(rel);
          continue;
        }
        const built = !(typeof c.publicDir === "string" && within(rel, c.publicDir)) && !rel.split("/").some((part) => TOOL_FOLDERS.has(part));
        if (STYLE_RE.test(name)) {
          if (++styles > MAX_STYLES) return `This app has more than ${MAX_STYLES} stylesheets, more than the wizard checks for ones that load code`;
          files.push({ rel, kind: "style" });
        } else if (built && (HTML_RE.test(name) || COMPONENT_RE.test(name) || (SCRIPT_RE.test(name) && !DECLARATION_RE.test(name)))) {
          if (++sources > MAX_SOURCES) return `This app has more than ${MAX_SOURCES} source files, more than the wizard reads for what they import`;
          files.push({ rel, kind: HTML_RE.test(name) ? "html" : COMPONENT_RE.test(name) ? "component" : "script" });
        }
      }
    }
    const keys = c.aliases === "any" ? "any" : [...c.aliases.keys()];
    // Stylesheets first, then the sources that import them.
    for (const { rel, kind } of [...files.filter((x) => x.kind === "style"), ...files.filter((x) => x.kind !== "style")]) {
      const text = f.read(rel);
      if (text === null) return kind === "style" ? `${rel} exists, but the wizard cannot read it, and Vite builds it` : `${rel} exists, but the wizard cannot read it (a file it may open, of at most 1 MB), so it cannot tell what it imports, and Vite builds it`;
      // `specs` with their index in the file's text.
      const follow = (specs: Spec[]): string | null => {
        for (const { spec, index, shown } of specs) {
          const r = resolve(spec, rel, top, index, text, shown);
          if (r && "off" in r) return r.off;
        }
        return null;
      };
      const shift = (specs: Spec[], by: number): Spec[] => specs.map((x) => ({ ...x, index: x.index + by }));
      if (kind === "style") {
        const ext = rel.slice(rel.lastIndexOf(".") + 1);
        const off = styleOff(text, ext, keys);
        if (off) return `${rel} loads code with ${off}, which the wizard does not check`;
        const imp = follow(cssImports(text));
        if (imp) return imp;
        continue;
      }
      // <style> blocks (with their language in a component), <template> in another language, and what the blocks and
      // the tags import.
      for (const m of text.matchAll(BLOCK("style"))) {
        const lang = kind === "component" ? attr(m[1], "lang") ?? "css" : "css";
        const body = m[2];
        const start = m.index! + m[0].indexOf(">") + 1;
        const off = styleOff(body, lang, keys, lineAt(text, start));
        if (off) return `${rel} loads code with ${off}, which the wizard does not check`;
        const src = attr(m[1], "src");
        const imp = follow([...shift(cssImports(body), start), ...(src ? [{ spec: src, index: m.index! }] : [])]);
        if (imp) return imp;
      }
      if (kind === "component") {
        for (const m of text.matchAll(/<template\b([^>]*)>/gi)) {
          const lang = attr(m[1], "lang");
          if (attr(m[1], "src") !== null || (lang !== null && lang !== "html")) return `${rel} has a <template${lang ? ` lang="${lang}"` : " src"}> (line ${lineAt(text, m.index!)}), which compiles in a language that can run code when Vite builds, and the wizard does not check it`;
        }
      }
      if (kind === "script") {
        const imp = follow(jsImports(text));
        if (imp) return imp;
        continue;
      }
      for (const m of text.matchAll(BLOCK("script"))) {
        const start = m.index! + m[0].indexOf(">") + 1;
        const src = attr(m[1], "src");
        const imp = follow([...shift(jsImports(m[2]), start), ...(src ? [{ spec: src, index: m.index! }] : [])]);
        if (imp) return imp;
      }
      if (kind === "html") {
        const imp = follow([...text.matchAll(/<link\b[^>]*>/gi)].flatMap((m) => { const href = attr(m[0], "href"); return href ? [{ spec: href, index: m.index! }] : []; }));
        if (imp) return imp;
      }
    }
  }
  return null;
}
