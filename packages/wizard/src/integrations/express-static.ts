import { createRequire } from "node:module";
import { join, posix } from "node:path";
import { lstatSync } from "node:fs";
import { parseCode, walk, type Node } from "../edits/splice.js";
import { pathOf } from "../edits/views.js";
import { viteCopiesPublicDir, viteOutDir } from "../edits/vite-config.js";
import { readJson, readText } from "../workspace.js";
import type { ExpressData } from "./express.js";
import type { ViteData } from "./vite-react.js";

// The folders an Express app provably serves at the site's root for GET /.well-known/parlox-verify: where an ownership
// file proves the domain when the app's server part is withheld (apps.ts).
//
// express.static is serve-static, which hands each request to send. Whether send serves a file inside a folder whose
// name starts with a dot (.well-known) depends on its version (each read from npm with `npm pack`, never run):
// - Express 4 (serve-static 1.x, send 0.x): with no `dotfiles` option, send looks only at the last part of the path
//   ("legacy support": send 0.19.2 index.js:132-134 and :559-567; its README: this default "will not ignore the files
//   within a directory that begins with a dot"), so /.well-known/parlox-verify is served. The same code is in send
//   0.10.1 (index.js:450), which Express 4.10.0 uses; earlier Express 4 releases are not counted. Express 4.22.3 uses
//   serve-static ~1.16.2 and send ~0.19.1.
// - Express 5 (serve-static 2.x, send 1.x): `dotfiles` defaults to "ignore" (send 1.2.1 index.js:114-116) for every
//   part of the path (containsDotFile, :807-816; a 404 at :457-470), so the file is not served: Express 5 is never
//   counted, and an app on it gets no ownership file (the report says how to prove the domain instead).
// The proof from the file that creates the app, each step strict (anything else is not proven, and no file is
// planned):
// - `app.use(express.static(<folder>))`, or the same under the mount "/", as a statement of its own at the top of the
//   file, `express` being the name the file gives the express module; its options, if any, an object of literals with
//   no `dotfiles` other than "allow";
// - before it, nothing that could answer the request first: settings (app.set, app.disable…), routes for other methods,
//   routes and mounts at a literal path other than the ownership path and the folders above it, Express's own body
//   parsers (express.json and the others skip a request without a body: body-parser 1.20.5 lib/types/json.js:111-114,
//   the same in raw.js, text.js and urlencoded.js), and other static folders that hold no ownership file and pass a
//   request on when the file is not there;
// - no handler added anywhere else in the file (inside a function or a condition, whose order the wizard cannot tell),
//   and the app not handed to other code before that statement (which could add one).
// A folder written as a string is relative to where the app starts, taken to be its package folder, as for its pages
// (views.ts, pathOf).

const VERIFY = "/.well-known/parlox-verify";
/** The methods that add a handler for requests (Express 4's app.METHOD, app.all, app.use, app.route). */
const HANDLERS = new Set(["use", "all", "route", "get", "head", "post", "put", "delete", "patch", "options", "checkout", "copy", "lock", "merge", "mkactivity", "mkcol", "move", "m-search", "notify", "propfind", "proppatch", "purge", "report", "search", "subscribe", "trace", "unlock", "unsubscribe"]);
/** Routes a GET (or the gateway's HEAD) can match. */
const READS = new Set(["get", "head", "all"]);
/** What adds no handler. */
const SETTINGS = new Set(["set", "enable", "disable", "enabled", "disabled", "engine", "param", "listen", "render", "path"]);
const BODY_PARSERS = new Set(["json", "urlencoded", "text", "raw"]);

/** Whether this app runs an Express that serves files inside a dot-folder: 4.10 or later, before 5. The installed
 * version decides; without one, the declared range (^4.x.y, ~4.x.y or 4.x.y with x at least 10). */
export function servesDotFolders(dir: string, pkg: Record<string, any>): boolean {
  const ok = (major: number, minor: number) => major === 4 && minor >= 10;
  try {
    const installed = createRequire(join(dir, "package.json")).resolve("express/package.json");
    const m = /^(\d+)\.(\d+)\./.exec(String(readJson(installed).version));
    return !!m && ok(Number(m[1]), Number(m[2]));
  } catch { /* not installed: the declared range decides */ }
  const m = /^[\^~]?4\.(\d+)(?:\.\d+)?$/.exec(String(pkg.dependencies?.express ?? pkg.devDependencies?.express ?? "").trim());
  return !!m && ok(4, Number(m[1]));
}

const literal = (n: Node | undefined): string | null =>
  n?.type === "StringLiteral" ? n.value : n?.type === "TemplateLiteral" && n.expressions.length === 0 ? n.quasis[0].value.cooked ?? null : null;
const isRequire = (n: Node | undefined, name: string) => n?.type === "CallExpression" && n.callee.type === "Identifier" && n.callee.name === "require" && literal(n.arguments[0]) === name;

/** The names the file gives the express module: its default import, or `const x = require("express")`. */
function expressNames(program: Node): Set<string> {
  const names = new Set<string>();
  walk(program, (n) => {
    if (n.type === "ImportDeclaration" && n.source.value === "express" && n.importKind !== "type") for (const s of n.specifiers) if (s.type === "ImportDefaultSpecifier") names.add(s.local.name);
    if (n.type === "VariableDeclarator" && n.id.type === "Identifier" && isRequire(n.init, "express")) names.add(n.id.name);
  });
  return names;
}

/** `express.<fn>(…)` for one of the file's names for the express module, or null. */
const expressCall = (n: Node | undefined, express: Set<string>, fns: Set<string>): Node | null =>
  n?.type === "CallExpression" && n.callee.type === "MemberExpression" && !n.callee.computed && n.callee.object.type === "Identifier" && express.has(n.callee.object.name) && fns.has(n.callee.property.name) ? n : null;

/** A literal path an Express 4 route or mount is given: plain characters only (no parameters, wildcards or groups). */
const plainPath = (n: Node | undefined): string | null => {
  const p = literal(n);
  return p !== null && p.startsWith("/") && !/[:*?+()[\]\\]/.test(p) ? p.toLowerCase().replace(/\/+$/, "") : null;
};
/** Whether a route at `path` matches the ownership path (Express matches without case, with or without a final slash). */
const routeMatches = (path: string) => path === VERIFY;
/** Whether a mount at `path` sees the ownership path: "/" and the folders above it. */
const mountSees = (path: string) => path === "" || VERIFY === path || VERIFY.startsWith(`${path}/`);

/** The options of express.static, when proven to change nothing about this request: none, or an object of literal
 * values with `dotfiles` "allow" if set. `fallthrough` false is kept apart: a folder that does not hold the file then
 * answers 404 instead of passing the request on. */
function staticOptions(n: Node | undefined): { ok: boolean; fallthrough: boolean } {
  if (n === undefined) return { ok: true, fallthrough: true };
  if (n.type !== "ObjectExpression") return { ok: false, fallthrough: false };
  let fallthrough = true;
  for (const p of n.properties) {
    if (p.type !== "ObjectProperty" || p.computed) return { ok: false, fallthrough: false };
    const key = p.key.type === "Identifier" ? p.key.name : literal(p.key);
    const v = p.value;
    const plain = ["StringLiteral", "NumericLiteral", "BooleanLiteral", "NullLiteral"].includes(v.type) || (v.type === "ArrayExpression" && v.elements.every((e: Node | null) => e?.type === "StringLiteral"));
    if (!key || !plain) return { ok: false, fallthrough: false };
    if (key === "dotfiles" && literal(v) !== "allow") return { ok: false, fallthrough: false };
    if (key === "fallthrough" && v.type === "BooleanLiteral" && v.value === false) fallthrough = false;
  }
  return { ok: true, fallthrough };
}

/**
 * The folders (relative to the app folder `dir`) that the Express app `appName`, created in `file` (its text `code`),
 * serves at the site's root for GET /.well-known/parlox-verify, as far as the file proves it (see the top of this
 * file); `holds(folder)` says whether a folder already holds a file at that path. Empty when nothing is proven.
 */
export function verifyFolders(dir: string, pkg: Record<string, any>, file: string, code: string, appName: string, holds: (folder: string) => boolean): string[] {
  if (!servesDotFolders(dir, pkg)) return [];
  const ast = parseCode(code, file);
  if (!ast) return [];
  const express = expressNames(ast.program);
  if (!express.size) return [];
  const fileDir = posix.dirname(file) === "." ? "" : posix.dirname(file);
  const body = ast.program.body;
  const isApp = (n: Node | undefined) => n?.type === "Identifier" && n.name === appName;
  const appCall = (n: Node | undefined): { method: string; args: Node[] } | null =>
    n?.type === "CallExpression" && n.callee.type === "MemberExpression" && !n.callee.computed && isApp(n.callee.object) ? { method: n.callee.property.name, args: n.arguments } : null;

  // Where the app is used other than as `app.<method>(…)` at the top of the file: a handler added inside a function or
  // a condition, or the app handed to other code. Each such use is counted from the top-level statement it is in.
  let loose = false;
  const handedAt = new Set<Node>();
  for (const stmt of body) {
    walk(stmt, (n, ancestors) => {
      const parent = ancestors[ancestors.length - 1];
      if (!isApp(n)) return;
      if (parent?.type === "VariableDeclarator" && parent.id === n) return;
      const call = parent?.type === "MemberExpression" && parent.object === n && !parent.computed ? ancestors[ancestors.length - 2] : null;
      const method = call?.type === "CallExpression" && call.callee === parent ? parent.property.name : null;
      if (method && SETTINGS.has(method)) return;
      // app.get("setting") with one argument reads a setting.
      if (method === "get" && call!.arguments.length === 1 && literal(call!.arguments[0]) !== null && !literal(call!.arguments[0])!.startsWith("/")) return;
      // app.<handler>(…) as a statement of its own at the top of the file: ordered, read below.
      if (method && HANDLERS.has(method) && ancestors.length === 3 && stmt.type === "ExpressionStatement" && stmt.expression === call) return;
      if (method && HANDLERS.has(method)) { loose = true; return; }
      // app.locals holds values for templates; anything else (handed to other code, or its router reached into)
      // could add a handler.
      if (parent?.type === "MemberExpression" && parent.object === n && !parent.computed && parent.property.name === "locals") return;
      handedAt.add(stmt);
    });
  }
  if (loose) return [];

  const served: string[] = [];
  for (const stmt of body) {
    if (handedAt.has(stmt)) break;
    const call = stmt.type === "ExpressionStatement" ? appCall(stmt.expression) : null;
    if (!call || SETTINGS.has(call.method)) continue;
    const { method, args } = call;
    if (method === "route") break;
    if (method !== "use") {
      if (!READS.has(method)) continue;
      if (method === "get" && args.length === 1 && literal(args[0]) !== null && !literal(args[0])!.startsWith("/")) continue;
      // A route for GET: at a literal path other than the ownership path; an array of them; anything else may match.
      const paths = args[0]?.type === "ArrayExpression" ? args[0].elements.map((e: Node) => plainPath(e)) : [plainPath(args[0])];
      if (paths.some((p: string | null) => p === null || routeMatches(p))) break;
      continue;
    }
    const mount = literal(args[0]) !== null ? args[0] : undefined;
    const handlers = mount ? args.slice(1) : args;
    const at = mount ? plainPath(mount) : "";
    if (at === null) break;
    if (!mountSees(at)) continue;
    // Express's own body parsers pass on a request without a body.
    if (handlers.length && handlers.every((h) => expressCall(h, express, BODY_PARSERS))) continue;
    const stat = handlers.length === 1 ? expressCall(handlers[0], express, new Set(["static"])) : null;
    if (!stat || at !== "") break;
    const folder = pathOf(stat.arguments[0], fileDir);
    const options = staticOptions(stat.arguments[1]);
    if (folder === "unknown" || !options.ok || stat.arguments.length > 2) break;
    served.push(folder);
    // A folder that would answer this request itself (it holds such a file, or answers 404 without passing it on)
    // ends the list: the folders after it are never reached.
    if (holds(folder) || !options.fallthrough) break;
  }
  return served;
}

/** Where Express serves the ownership file of a Vite React app in the same folder (`dir`) from, when its server part is
 * withheld: Vite's public folder itself, or the build's output folder, into which `vite build` copies the public folder
 * (build.copyPublicDir, read from the config). null when not proven: the file is then not planned. */
export function viteVerifyServed(dir: string, server: ExpressData, vite: ViteData): { folder: string; serverFile: string } | null {
  if (!server.serverFile || !server.appName || typeof vite.publicDir !== "string") return null;
  const read = readText(dir);
  const exists = (rel: string) => { try { lstatSync(join(dir, rel)); return true; } catch { return false; } };
  const code = read(server.serverFile);
  let pkg: Record<string, any>;
  try { pkg = readJson(join(dir, "package.json")); } catch { return null; }
  if (code === null) return null;
  const holds = (folder: string) => exists(posix.join(folder, VERIFY.slice(1)));
  const served = verifyFolders(dir, pkg, server.serverFile, code, server.appName, holds);
  const out = viteOutDir(read, exists);
  const outDir = out ? out.outDir : "dist";
  const copied = outDir !== "unknown" && viteCopiesPublicDir(read, exists) === true ? outDir : null;
  const folder = served.find((f) => f === vite.publicDir || f === copied);
  return folder ? { folder, serverFile: server.serverFile } : null;
}
