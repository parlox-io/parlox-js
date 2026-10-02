import { test } from "node:test";
import assert from "node:assert/strict";
import { addImportLine, applySplices, endsLine, endsLineOrComment, identifierUse, identifierUsed, indentAt, insertLineAfter, insertLineAt, lineEnd, lineStart, parseCode, removeImportLine, removeLines, removeStatement, SpliceError, startsLine, styleOf, topLevelNames } from "../dist/edits/splice.js";

test("a line inserted after another, then removed, gives back the exact bytes: LF, CRLF, and a last line without a break", () => {
  for (const code of ["a\nb\n", "a\r\nb\r\n", "a\nb", "only"]) {
    const at = code.indexOf("a") >= 0 ? code.indexOf("a") : 0;
    const added = insertLineAfter(code, at, "NEW");
    const eol = code.includes("\r\n") ? "\r\n" : "\n";
    assert.ok(added.includes(`${eol}NEW`) || added.startsWith("NEW"), JSON.stringify(added));
    const start = added.indexOf("NEW");
    assert.equal(removeLines(added, start, start + 3), code, JSON.stringify(code));
  }
  assert.equal(removeLines(insertLineAt("x\n", 0, "NEW"), 0, 3), "x\n");
});

test("every line position, LF and CRLF, tabs and spaces, with and without a final line break: insert then remove is byte-exact, in the file's own line breaks", () => {
  for (const eol of ["\n", "\r\n"]) {
    for (const lines of [["a", "\tb", "  c"], ["only"], ["", "x", ""]]) {
      for (const final of [true, false]) {
        const code = lines.join(eol) + (final ? eol : "");
        let at = 0;
        for (let i = 0; i < lines.length; i++) {
          const after = insertLineAfter(code, at, "\tNEW");
          const a = after.indexOf("\tNEW");
          assert.equal(removeLines(after, a, a + 4), code, `after line ${i} of ${JSON.stringify(code)}`);
          const before = insertLineAt(code, at, "  NEW");
          const b = before.indexOf("  NEW");
          assert.equal(removeLines(before, b, b + 5), code, `at line ${i} of ${JSON.stringify(code)}`);
          // A one-line file without a break has no style of its own: the new break is "\n".
          for (const out of code.includes("\n") ? [after, before] : []) {
            const rest = out.split("\r\n").join("");
            assert.equal(rest.includes(eol === "\r\n" ? "\n" : "\r"), false, `only ${JSON.stringify(eol)} line breaks in ${JSON.stringify(out)}`);
          }
          at += lines[i].length + eol.length;
        }
      }
    }
  }
});

test("the start of the first line is 0, also when the file begins with a line break", () => {
  assert.equal(lineStart("\nabc", 0), 0);
  assert.equal(lineStart("\nabc", 1), 1);
  assert.equal(lineStart("ab\r\ncd", 5), 4);
});

test("splices given against one text apply from the end, so offsets stay valid", () => {
  assert.equal(applySplices("export default auth;", [{ start: 15, end: 15, text: "withParlox(" }, { start: 19, end: 19, text: ", { next })" }]), "export default withParlox(auth, { next });");
});

test("splices at one offset go in the order given; overlapping splices are refused", () => {
  assert.equal(applySplices("ab", [{ start: 1, end: 1, text: "X" }, { start: 1, end: 1, text: "Y" }]), "aXYb");
  assert.throws(() => applySplices("abcd", [{ start: 0, end: 2, text: "" }, { start: 1, end: 3, text: "" }]), /overlap/);
});

test("the file's own style: quotes and semicolons from its first import or require", () => {
  const esm = "import a from 'a'\nconst x = 1\n";
  assert.deepEqual(styleOf(esm, parseCode(esm, "x.js")), { q: "'", semi: "" });
  const cjs = 'const express = require("express");\n';
  assert.deepEqual(styleOf(cjs, parseCode(cjs, "x.js")), { q: '"', semi: ";" });
  assert.deepEqual(styleOf("const x = 1\n", parseCode("const x = 1\n", "x.js")), { q: '"', semi: ";" });
});

test("imports go after the last import, else after a given require, else at the top below a shebang or directive; removal restores the bytes", () => {
  const esm = "import a from \"a\";\n\nconst x = 1;\n";
  const added = addImportLine(esm, parseCode(esm, "x.mjs"), 'import { parlox } from "@parlox/server/express";');
  assert.equal(added, "import a from \"a\";\nimport { parlox } from \"@parlox/server/express\";\n\nconst x = 1;\n");
  assert.equal(removeImportLine(added, parseCode(added, "x.mjs"), "@parlox/server/express", ["parlox"]), esm);
  const bang = "#!/usr/bin/env node\n'use strict';\nfoo();\n";
  const withReq = addImportLine(bang, parseCode(bang, "x.js"), "const { parlox } = require('@parlox/server/express');");
  assert.equal(withReq, "#!/usr/bin/env node\n'use strict';\nconst { parlox } = require('@parlox/server/express');\nfoo();\n");
  assert.equal(removeImportLine(withReq, parseCode(withReq, "x.js"), "@parlox/server/express", ["parlox"]), bang);
  const cjs = "const express = require('express');\nconst app = express();\n";
  const ast = parseCode(cjs, "x.js");
  const req = addImportLine(cjs, ast, "const { parlox } = require('@parlox/server/express');", ast.program.body[0]);
  assert.equal(req, "const express = require('express');\nconst { parlox } = require('@parlox/server/express');\nconst app = express();\n");
  assert.equal(removeImportLine(req, parseCode(req, "x.js"), "@parlox/server/express", ["parlox"]), cjs);
});

test("an import at the top of a file stays below a byte-order mark, a shebang, a header comment, a pinned or /// comment and a pragma, and above a comment that belongs to the first statement", () => {
  const line = 'import { a } from "a";';
  const cases = [
    ["\uFEFFconst x = 1;\n", `\uFEFF${line}\nconst x = 1;\n`],
    ["#!/usr/bin/env node", `#!/usr/bin/env node\n${line}`],
    ["// @ts-check\nconst x = 1;\n", `// @ts-check\n${line}\nconst x = 1;\n`],
    ["/*! pinned */\n/** The handler. */\nconst x = 1;\n", `/*! pinned */\n${line}\n/** The handler. */\nconst x = 1;\n`],
    ["/// <reference types=\"node\" />\nconst x = 1;\n", `/// <reference types="node" />\n${line}\nconst x = 1;\n`],
    ["/* Copyright */\n// Licensed MIT\n\nconst x = 1;\n", `/* Copyright */\n// Licensed MIT\n${line}\n\nconst x = 1;\n`],
    ["// Copyright\n\n/** The handler. */\nconst x = 1;\n", `// Copyright\n${line}\n\n/** The handler. */\nconst x = 1;\n`],
    ["/** The handler. */\nconst x = 1;\n", `${line}\n/** The handler. */\nconst x = 1;\n`],
    ["\r\n// Copyright\r\n\r\nconst x = 1;", `\r\n// Copyright\r\n${line}\r\n\r\nconst x = 1;`],
    ["", `${line}\n`],
  ];
  for (const [code, want] of cases) {
    const got = addImportLine(code, parseCode(code, "x.ts"), line);
    assert.equal(got, want, JSON.stringify(code));
    assert.ok(parseCode(got, "x.ts"), JSON.stringify(got));
    assert.equal(removeImportLine(got, parseCode(got, "x.ts"), "a", ["a"]), code, `removal of ${JSON.stringify(got)}`);
  }
});

test("an import is never put inside a comment or a template string that runs on past the anchor's line", () => {
  for (const code of ['import a from "a"; const html = `\n<p>\n`;\n', 'import a from "a"; /* a note\n  that goes on */\nconst x = 1;\n', '"use strict"; const t = `\n`;\n']) {
    assert.throws(() => addImportLine(code, parseCode(code, "x.js"), 'import { b } from "b";'), SpliceError, JSON.stringify(code));
  }
});

test("removal takes out only the exact import written: its names not renamed, a value import, alone on its line", () => {
  const code = 'import { parlox as p } from "@parlox/server/express";\nimport type { parlox } from "@parlox/server/express";\nconst { parlox: q } = require("@parlox/server/express");\n';
  assert.equal(removeImportLine(code, parseCode(code, "x.ts"), "@parlox/server/express", ["parlox"]), code);
});

test("top-level names: imports, declarations (destructured too), functions and classes", () => {
  const code = "import next from 'x';\nimport { a as b } from 'y';\nconst { c, d: e } = z;\nfunction f() {}\nexport class G {}\n";
  assert.deepEqual([...topLevelNames(parseCode(code, "x.js"))].sort(), ["G", "b", "c", "e", "f", "next"]);
});

test("top-level names include TypeScript's: enums, type aliases, interfaces, namespaces, import-equals, declared functions", () => {
  const code = "enum A {}\ntype B = 1;\ninterface C {}\nnamespace D {}\nimport E = require('e');\ndeclare function F(): void;\nexport type G = 2;\n";
  assert.deepEqual([...topLevelNames(parseCode(code, "x.ts"))].sort(), ["A", "B", "C", "D", "E", "F", "G"]);
});

test("a name counts as used where it is a reference, not where it is a property name, a key or a label", () => {
  const used = (code) => identifierUsed(parseCode(code, "x.ts"), "next");
  assert.equal(used("import { next } from 'x';\nrequest.next; a?.next; ({ next: 1 }); class A { next() {} next2 = 1 }\ntype T = { next: string };\n"), false);
  for (const code of ["import { next } from 'x';\nnext();\n", "import { next } from 'x';\nconst o = { next };\n", "import { next } from 'x';\nexport { next };\n", "import { next } from 'x';\na[next];\n", "import { next } from 'x';\ntype T = typeof next;\n"]) {
    assert.equal(used(code), true, code);
  }
});

test("a lone \\r, or a Unicode line or paragraph separator, stops every line primitive with a SpliceError (the wizard edits only \\n and \\r\\n lines)", () => {
  for (const code of ["a\rb\r", "x\r", "a\r\nb\rc\r\n", "a\u2028b\n", "a\nb\u2029"]) {
    const calls = {
      lineStart: () => lineStart(code, 1), lineEnd: () => lineEnd(code, 0), indentAt: () => indentAt(code, 0), startsLine: () => startsLine(code, 0), endsLine: () => endsLine(code, 0),
      endsLineOrComment: () => endsLineOrComment(code, 0), insertLineAfter: () => insertLineAfter(code, 0, "NEW"), insertLineAt: () => insertLineAt(code, 0, "NEW"),
      removeLines: () => removeLines(code, 0, 1), removeStatement: () => removeStatement(code, { type: "X", start: 0, end: 1 }),
    };
    for (const [name, call] of Object.entries(calls)) assert.throws(call, (err) => err instanceof SpliceError && /line \d+/.test(err.message), `${name} on ${JSON.stringify(code)}`);
  }
  const file = "import a from 'a'\rexport default a\r";
  assert.throws(() => addImportLine(file, parseCode(file, "x.js"), 'import { b } from "b";'), SpliceError);
  assert.equal(lineEnd("a\r\nb", 0), 1, "CRLF is still one line break");
});

test("identifierUse points at the first use outside imports, for a reason that names its line", () => {
  const ast = parseCode("import { next } from 'x';\nconst a = 1;\nfunction f() {\n  const next = 2;\n}\n", "x.js");
  assert.equal(identifierUse(ast, "next").loc.start.line, 4);
  assert.equal(identifierUse(ast, "withParlox"), null);
});
