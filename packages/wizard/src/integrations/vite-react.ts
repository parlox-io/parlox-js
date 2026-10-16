import { addViteEntry, removeViteEntry, viteEntrySnippet } from "../edits/vite-entry.js";
import { DetectError, GUIDE, hasDep } from "../workspace.js";
import type { Integration } from "./types.js";
import { viteSpa } from "./vite-spa.js";

// What Vite single-page apps share (detection after the framework's own check, the server part, the ownership file,
// the host notes) lives in vite-spa.ts; the Vite checks the server integrations share, in vite-folders.ts.
export { secretExposureOf, viteServerKind, type ViteData } from "./vite-spa.js";
export { folderViteCheck, folderViteNamesSecretKey, netlifyCommands, runsVite, runsViteBuild, viteFoldersBelow, type Below, type FolderVite, type ViteFolder } from "./vite-folders.js";

// Vite React: react and vite in package.json, and no next. The browser part is <ParloxAnalytics /> beside <App /> in
// the root render(…) call of the entry index.html names (edits/vite-entry.ts).

const REMOVE_SNIPPET = "Remove the ParloxAnalytics import and element by hand.";

// Frameworks with their own server and routing (most build on Vite): not a single-page app with an index.html entry,
// and each needs its own server adapter (not covered yet). Earlier package names of the same frameworks count too.
const OWN_SERVER: Array<[string, string]> = [
  ["@react-router/dev", "React Router in framework mode"],
  ["@remix-run/dev", "Remix"],
  ["@tanstack/react-start", "TanStack Start"],
  ["@tanstack/start", "TanStack Start"],
  ["vike", "Vike"],
  ["vite-plugin-ssr", "Vike"],
  ["astro", "Astro"],
  ["waku", "Waku"],
  ["@redwoodjs/core", "RedwoodJS"],
  ["@redwoodjs/vite", "RedwoodJS"],
];

export const viteReact: Integration = viteSpa({
  id: "vite-react",
  label: "Vite React",
  matches(pkg) {
    if (!hasDep(pkg, "react") || hasDep(pkg, "next")) return false;
    const own = OWN_SERVER.find(([name]) => hasDep(pkg, name));
    if (own) throw new DetectError("not-supported", `${own[1]} (${own[0]}) is a framework with its own server and routing, not a Vite React single-page app; the wizard does not cover it yet. See ${GUIDE}`);
    return hasDep(pkg, "vite");
  },
  entry: { kind: "vite-entry", snippet: viteEntrySnippet, add: addViteEntry, remove: removeViteEntry, removeSnippet: REMOVE_SNIPPET, what: "the ParloxAnalytics element" },
});
