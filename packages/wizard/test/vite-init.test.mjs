import { test } from "node:test";
import assert from "node:assert/strict";
import { addViteInit, removeViteInit, viteInitSnippet } from "../dist/edits/vite-init.js";

// The Vite Vue browser part: `import { init } from "@parlox/browser"` after the entry's last import and
// `init({ publicKey: "pk_…" })` as its own statement right after it, in the file's own quotes and semicolons; the
// uninstall takes out exactly those two lines.

const PK = "pk_" + "c3".repeat(12);
const OTHER_PK = "pk_" + "d4".repeat(12);
// src/main.ts exactly as create-vite 9.2.1 writes it (templates vue and vue-ts).
const MAIN_TS = `import { createApp } from 'vue'
import './style.css'
import App from './App.vue'

createApp(App).mount('#app')
`;
const SNIPPET = `import { init } from "@parlox/browser";\ninit({ publicKey: "${PK}" });`;

test("the init call goes right after the imports, in the file's own quotes and semicolons; a second run changes nothing; uninstall gives back every byte", () => {
  const e = addViteInit(MAIN_TS, "src/main.ts", PK);
  assert.equal(e.ok, true);
  assert.equal(e.code, `import { createApp } from 'vue'
import './style.css'
import App from './App.vue'
import { init } from '@parlox/browser'
init({ publicKey: '${PK}' })

createApp(App).mount('#app')
`);
  assert.deepEqual(addViteInit(e.code, "src/main.ts", PK), { ok: true, code: e.code, changed: false }, "a second run changes nothing");
  assert.deepEqual(removeViteInit(e.code, "src/main.ts"), { ok: true, code: MAIN_TS, changed: true });
  // Double quotes and semicolons.
  const semi = 'import { createApp } from "vue";\nimport App from "./App.vue";\n\ncreateApp(App).mount("#app");\n';
  const s = addViteInit(semi, "src/main.js", PK);
  assert.equal(s.code, `import { createApp } from "vue";\nimport App from "./App.vue";\nimport { init } from "@parlox/browser";\ninit({ publicKey: "${PK}" });\n\ncreateApp(App).mount("#app");\n`);
  assert.equal(removeViteInit(s.code, "src/main.js").code, semi);
  // A JavaScript entry, TypeScript with types, a Vue JSX entry: the same two lines.
  for (const [file, code] of [
    ["src/main.js", MAIN_TS],
    ["src/main.ts", "import { createApp, type App as VueApp } from 'vue'\nimport App from './App.vue'\n\nconst app: VueApp = createApp(App)\napp.mount('#app')\n"],
    ["src/main.tsx", "import { createApp } from 'vue'\n\ncreateApp(() => <p>hi</p>).mount('#app')\n"],
  ]) {
    const r = addViteInit(code, file, PK);
    assert.equal(r.ok && r.changed, true, file);
    assert.match(r.code, new RegExp(`\\nimport \\{ init \\} from '@parlox/browser'\\ninit\\(\\{ publicKey: '${PK}' \\}\\)\\n`), file);
    assert.equal(removeViteInit(r.code, file).code, code, file);
  }
});

test("a file with no imports: the two lines at the top, below header comments; with no semicolons in the file, none in the lines", () => {
  const bare = "document.querySelector('#app').textContent = 'hi'\n";
  const r = addViteInit(bare, "src/main.js", PK);
  assert.equal(r.code, `import { init } from '@parlox/browser'\ninit({ publicKey: '${PK}' })\n${bare}`);
  assert.equal(removeViteInit(r.code, "src/main.js").code, bare);
  // No strings to take a quote from: double quotes; the file's statements end with semicolons: so do the lines.
  const header = "// The shop's entry.\n// Keep it small.\n\nwindow.ready = true;\n";
  const h = addViteInit(header, "src/main.js", PK);
  assert.equal(h.code, `// The shop's entry.\n// Keep it small.\nimport { init } from "@parlox/browser";\ninit({ publicKey: "${PK}" });\n\nwindow.ready = true;\n`);
  assert.equal(removeViteInit(h.code, "src/main.js").code, header);
});

test("CRLF line breaks and a byte-order mark are kept, and the uninstall gives them back", () => {
  const crlf = MAIN_TS.replace(/\n/g, "\r\n");
  const r = addViteInit(crlf, "src/main.ts", PK);
  assert.ok(r.code.includes(`\r\nimport { init } from '@parlox/browser'\r\ninit({ publicKey: '${PK}' })\r\n`), JSON.stringify(r.code));
  assert.equal(r.code.replace(/\r\n/g, "").includes("\n"), false, "no bare line feed");
  assert.equal(removeViteInit(r.code, "src/main.ts").code, crlf);
  const bom = `﻿${MAIN_TS}`;
  const b = addViteInit(bom, "src/main.ts", PK);
  assert.equal(b.code.charCodeAt(0), 0xfeff);
  assert.equal(removeViteInit(b.code, "src/main.ts").code, bom);
});

test("already added with another key: refused, with the snippet", () => {
  const e = addViteInit(MAIN_TS, "src/main.ts", OTHER_PK).code;
  const r = addViteInit(e, "src/main.ts", PK);
  assert.equal(r.ok, false);
  assert.equal(r.reason, `Parlox is already added here with another key (${OTHER_PK}).`);
  assert.equal(r.snippet, SNIPPET);
  // The wizard's import with the call written by hand with options of the developer's own: installed, nothing to change.
  const own = MAIN_TS.replace("import App from './App.vue'\n", `import App from './App.vue'\nimport { init } from '@parlox/browser'\ninit({ publicKey: '${PK}', consent: 'required' })\n`);
  assert.deepEqual(addViteInit(own, "src/main.ts", PK), { ok: true, code: own, changed: false });
  // The wizard's import, but no call, two calls, a call inside other code, or a key that is not a literal.
  for (const [label, code] of [
    ["no call", MAIN_TS.replace("import App", "import { init } from '@parlox/browser'\nimport App")],
    ["two calls", `${e}init({ publicKey: '${OTHER_PK}' })\n`],
    ["a call inside a function", MAIN_TS.replace("import App", "import { init } from '@parlox/browser'\nimport App") + `function start() { init({ publicKey: '${PK}' }) }\n`],
    ["a computed key", MAIN_TS.replace("import App", "import { init } from '@parlox/browser'\nimport App") + "init({ publicKey: import.meta.env.VITE_PK })\n"],
  ]) {
    const x = addViteInit(code, "src/main.ts", PK);
    assert.equal(x.ok, false, label);
    assert.match(x.reason, /^Parlox's init is imported here, but not called once as its own statement with the key written out/, label);
    assert.equal(x.snippet, SNIPPET, label);
  }
});

test("the name init already bound or used in the file: refused, with the snippet and how to add it under another name", () => {
  for (const [label, code] of [
    ["an import of another init", "import { init } from './setup'\nimport { createApp } from 'vue'\n\ninit()\n"],
    ["a function", "import { createApp } from 'vue'\n\nfunction init() {}\ninit()\n"],
    ["a variable", "import { createApp } from 'vue'\n\nconst init = () => {}\n"],
    ["a destructured variable", "import { createApp } from 'vue'\n\nconst { init } = window.setup\n"],
  ]) {
    const r = addViteInit(code, "src/main.js", PK);
    assert.equal(r.ok, false, label);
    assert.equal(r.reason, `This file already has something named init, so the wizard's import of init would clash with it. Add Parlox under another name: import { init as initParlox } from "@parlox/browser", then initParlox({ publicKey: "${PK}" }) right after the imports.`, label);
    assert.equal(r.snippet, SNIPPET, label);
  }
  for (const [label, code, line] of [
    ["a local variable", "import { createApp } from 'vue'\n\nfunction f() {\n  const init = 1\n  return init\n}\n", 4],
    ["a global", "import { createApp } from 'vue'\n\nwindow.addEventListener('load', () => init())\n", 3],
    ["a parameter", "import { createApp } from 'vue'\n\nexport const start = (init) => init()\n", 3],
  ]) {
    const r = addViteInit(code, "src/main.js", PK);
    assert.equal(r.ok, false, label);
    assert.match(r.reason, new RegExp(`^This file uses the name init on line ${line}, so the wizard's import of init could not be told apart from it\\. Add Parlox under another name`), label);
  }
  // A property or a key named init is not the name.
  for (const code of ["import { createApp } from 'vue'\n\nconst app = createApp({ init: 1 })\napp.config.init = true\n", "import { createApp } from 'vue'\n\nclass A { init() {} }\n"]) {
    assert.equal(addViteInit(code, "src/main.js", PK).changed, true, code);
  }
});

test("a file that already loads @parlox/browser another way (it may already start Parlox, with options of its own): refused, with the snippet", () => {
  for (const [label, line] of [
    ["a namespace import", "import * as parlox from '@parlox/browser'"],
    ["init under another name", "import { init as startParlox } from '@parlox/browser'"],
    ["init beside other names", "import { init, track } from '@parlox/browser'"],
    ["another export of the package", "import { track } from '@parlox/browser'"],
    ["the React entry point", "import { ParloxAnalytics } from '@parlox/browser/react'"],
    ["a require", "const parlox = require('@parlox/browser')"],
    ["a dynamic import", "import('@parlox/browser').then((p) => p.init({ publicKey: 'pk_x' }))"],
    ["a re-export", "export { track } from '@parlox/browser'"],
  ]) {
    const code = MAIN_TS.replace("import App from './App.vue'\n", `import App from './App.vue'\n${line}\n`);
    const r = addViteInit(code, "src/main.ts", PK);
    assert.equal(r.ok, false, label);
    assert.match(r.reason, /^This file already loads @parlox\/browser on line 4 in a way the wizard did not write \(not `import \{ init \} from "@parlox\/browser"`\), so Parlox may already start here with options of its own; the wizard leaves it as it is\. Check that init\(\{ publicKey \}\) runs once, with this site's key\.$/, label);
    assert.equal(r.snippet, SNIPPET, label);
  }
  // A type-only import is erased before the code runs: it starts nothing.
  const typed = MAIN_TS.replace("import App from './App.vue'\n", "import App from './App.vue'\nimport type { InitOptions } from '@parlox/browser'\n");
  const t = addViteInit(typed, "src/main.ts", PK);
  assert.equal(t.ok && t.changed, true);
  assert.equal(removeViteInit(t.code, "src/main.ts").code, typed);
});

test("a file the wizard cannot read, or cannot edit around exactly, is a snippet", () => {
  const broken = addViteInit("import { createApp } from 'vue'\ncreateApp(\n", "src/main.ts", PK);
  assert.deepEqual(broken, { ok: false, reason: "The wizard could not read this file.", snippet: SNIPPET });
  // Without semicolons, a line that starts with a bracket would continue the call.
  const asi = "import { createApp } from 'vue'\n(window as any).boot = true\ncreateApp({}).mount('#app')\n";
  const a = addViteInit(asi, "src/main.ts", PK);
  assert.equal(a.ok, false);
  assert.match(a.reason, /would run into the line after it/);
  for (const next of ["[1, 2].forEach(() => {})", "`x`.length"]) assert.equal(addViteInit(`import { createApp } from 'vue'\n${next}\n`, "src/main.js", PK).ok, false, next);
  // The same file with semicolons is fine.
  assert.equal(addViteInit("import { createApp } from 'vue';\n(window).boot = true;\n", "src/main.js", PK).changed, true);
  // The line after the last import is inside a comment that goes on, or a line break the wizard does not edit around.
  assert.match(addViteInit("import { createApp } from 'vue' /* a comment\nthat goes on */\ncreateApp({})\n", "src/main.js", PK).reason, /inside a comment or a statement/);
  assert.match(addViteInit("import { createApp } from 'vue'\rcreateApp({})\n", "src/main.js", PK).reason, /line break the wizard does not edit around/);
  assert.throws(() => addViteInit(MAIN_TS, "src/main.ts", "pk_<script>"), /invalid public key/);
});

test("the snippet is the two lines, fixed but for the key", () => {
  assert.equal(viteInitSnippet(PK), SNIPPET);
});

test("uninstall: exactly the wizard's two lines; a lone import goes too; anything else is named or left to the developer", () => {
  // The call removed by hand: the import alone would break the build once the package is removed.
  const lone = MAIN_TS.replace("import App from './App.vue'\n", "import App from './App.vue'\nimport { init } from '@parlox/browser'\n");
  assert.equal(removeViteInit(lone, "src/main.ts").code, MAIN_TS);
  // The two lines moved apart by the developer: each goes with its own line.
  const moved = `import { init } from '@parlox/browser'\n${MAIN_TS.replace("\ncreateApp", `\ninit({ publicKey: '${PK}' })\ncreateApp`)}`;
  assert.equal(removeViteInit(moved, "src/main.ts").code, MAIN_TS);
  // Another use of the package beside the wizard's lines: the lines come out exactly, and that use is named.
  const track = MAIN_TS.replace("import './style.css'\n", "import './style.css'\nimport { track } from '@parlox/browser'\n");
  const installed = addViteInit(track.replace("import { track } from '@parlox/browser'\n", ""), "src/main.ts", PK).code.replace("import './style.css'\n", "import './style.css'\nimport { track } from '@parlox/browser'\n");
  const r = removeViteInit(installed, "src/main.ts");
  assert.equal(r.code, track);
  assert.match(r.warning, /^Line 3 still uses @parlox\/browser, which the uninstall removes; remove that line by hand\.$/);
  // Nothing of the wizard's, and no use of the package: nothing to do.
  assert.deepEqual(removeViteInit(MAIN_TS, "src/main.ts"), { ok: true, code: MAIN_TS, changed: false });
  // A use the wizard did not write, alone: left, and named.
  assert.match(removeViteInit(track, "src/main.ts").warning, /^Line 3 still uses @parlox\/browser/);
  // The call with options of the developer's own, called twice, or inside other code: by hand.
  for (const [label, code] of [
    ["options", MAIN_TS.replace("import App from './App.vue'\n", `import App from './App.vue'\nimport { init } from '@parlox/browser'\ninit({ publicKey: '${PK}', consent: 'required' })\n`)],
    ["twice", `${addViteInit(MAIN_TS, "src/main.ts", PK).code}init({ publicKey: '${PK}' })\n`],
    ["inside a function", `${lone}function start() { init({ publicKey: '${PK}' }) }\n`],
  ]) {
    const x = removeViteInit(code, "src/main.ts");
    assert.equal(x.ok, false, label);
    assert.match(x.reason, /^Parlox's init is called here in a way the wizard did not write/, label);
    assert.match(x.snippet, /^Remove `import \{ init \} from "@parlox\/browser"` and the init\(\{ publicKey: … \}\) call by hand\.$/, label);
  }
  // The wizard's call left behind without its import: it would call a name that is no longer there.
  const orphan = MAIN_TS.replace("\ncreateApp", `\ninit({ publicKey: '${PK}' })\ncreateApp`);
  const o = removeViteInit(orphan, "src/main.ts");
  assert.equal(o.ok, false);
  assert.match(o.reason, /^Line 5 calls init\(\{ publicKey: … \}\), Parlox's call, without the wizard's import of it/);
  // The same call where the file binds init to something of its own is not Parlox's.
  const theirs = `function init(o) { return o }\n${orphan}`;
  assert.deepEqual(removeViteInit(theirs, "src/main.ts"), { ok: true, code: theirs, changed: false });
  assert.deepEqual(removeViteInit("import { createApp } from 'vue'\ncreateApp(\n", "src/main.ts").ok, false);
});
