import { addViteInit, removeViteInit, viteInitSnippet } from "../edits/vite-init.js";
import { DetectError, GUIDE, hasDep } from "../workspace.js";
import type { Integration } from "./types.js";
import { viteSpa } from "./vite-spa.js";

// Vite Vue: vue and vite in package.json, and no next. The browser part is init({ publicKey }) from @parlox/browser
// right after the imports of the entry index.html names (edits/vite-init.ts): Vue needs no component, and the call runs
// before the app mounts. The server part, the ownership file and every check on the Vite build are Vite React's
// (vite-spa.ts). A folder that also depends on react is not taken as a Vue app: the wizard cannot tell which framework
// renders it, so this integration declines it, and the refusal is said beside Vite React's install (apps.ts,
// detectFolder), which edits only a createRoot(…).render(…) call.

const REMOVE_SNIPPET = 'Remove `import { init } from "@parlox/browser"` and the init({ publicKey: … }) call by hand.';

// What builds on Vue and Vite but is not a single-page app with an index.html entry: frameworks with their own server
// and routing (each needs its own server adapter, not covered yet), and site generators with their own entry and
// routing. Earlier package names of the same frameworks count too (nuxt3 and nuxt-edge, Nuxt 3's and Nuxt 2's earlier
// channels; nuxt-nightly; vuepress-vite, VuePress 2's; each read from the npm registry).
const OWN_SERVER: Array<[string, string]> = [
  ["nuxt", "Nuxt"],
  ["nuxt3", "Nuxt"],
  ["nuxt-edge", "Nuxt"],
  ["nuxt-nightly", "Nuxt"],
  ["@tanstack/vue-start", "TanStack Start"],
  ["vike", "Vike"],
  ["vite-plugin-ssr", "Vike"],
  ["astro", "Astro"],
];
const OWN_ENTRY: Array<[string, string]> = [
  ["vitepress", "VitePress"],
  ["vuepress", "VuePress"],
  ["vuepress-vite", "VuePress"],
  ["vite-ssg", "vite-ssg"],
  ["@quasar/app-vite", "Quasar CLI"],
  ["iles", "îles"],
  ["@slidev/cli", "Slidev"],
];

export const viteVue: Integration = viteSpa({
  id: "vite-vue",
  label: "Vite Vue",
  matches(pkg) {
    if (!hasDep(pkg, "vue") || hasDep(pkg, "next")) return false;
    const own = OWN_SERVER.find(([name]) => hasDep(pkg, name));
    if (own) throw new DetectError("not-supported", `${own[1]} (${own[0]}) is a framework with its own server and routing, not a Vite Vue single-page app; the wizard does not cover it yet. See ${GUIDE}`);
    const entry = OWN_ENTRY.find(([name]) => hasDep(pkg, name));
    if (entry) throw new DetectError("not-supported", `${entry[1]} (${entry[0]}) builds the site from its own entry and routing, not a Vite Vue single-page app's index.html; the wizard does not cover it yet. See ${GUIDE}`);
    if (!hasDep(pkg, "vite")) return false;
    if (hasDep(pkg, "react")) throw new DetectError("not-supported", `This folder depends on both vue and react, so the wizard cannot tell which one renders the app, and adds no Vue browser part here (Vite React's part goes only into a createRoot(…).render(…) call). If Vue renders it, add the browser part by hand: see ${GUIDE}`);
    return true;
  },
  entry: {
    kind: "vite-init",
    snippet: viteInitSnippet,
    add(code, file, publicKey, have) {
      const e = addViteInit(code, file, publicKey);
      // Only where the wizard would add its lines: its own lines already there with this key are an install.
      if (!e.ok || !e.changed || have["@parlox/browser"] === undefined) return e;
      return { ok: false, reason: `@parlox/browser is already in package.json, but ${file} does not start it the way the wizard writes it, so Parlox may already start elsewhere in this app with options of its own (consent: "required"): a second init() here would run first, and those options would not apply. If nothing starts Parlox yet, add the lines below.`, snippet: viteInitSnippet(publicKey) };
    },
    remove: removeViteInit,
    removeSnippet: REMOVE_SNIPPET,
    what: "Parlox's init() call",
  },
});
