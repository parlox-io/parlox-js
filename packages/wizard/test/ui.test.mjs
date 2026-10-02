import { test } from "node:test";
import assert from "node:assert/strict";
import { withDefaults } from "../dist/ui/types.js";
import { scrub } from "../dist/ui/scrub.js";
import { summarizeChanges, purposeOf } from "../dist/ui/summary.js";

const SECRET = "sk_parlox_" + "a".repeat(64);

test("scrub hides both key formats anywhere in a string", () => {
  assert.equal(scrub(`key=${SECRET} and sk_${"b".repeat(64)}.`), "key=[hidden] and [hidden].");
  assert.equal(scrub("sk_short stays"), "sk_short stays");
});

test("withDefaults: new methods have safe defaults; changes and report print through info like before", () => {
  const out = [];
  const ui = withDefaults({ info: (m) => out.push(m), warn: (m) => out.push(`WARN ${m}`), confirm: async () => true, select: async (_m, o) => o[0].value, text: async () => "" });
  ui.step("detect", "active"); ui.fact("Found", "Next.js 16"); ui.task("install", "active"); ui.log("npm noise");
  assert.deepEqual(out, []);
  const plan = { changes: [{ path: "proxy.js", before: null, after: "x\n" }], install: { command: "npm", args: ["install", "a@1"] }, manual: [{ file: "app/layout.tsx", reason: "why", snippet: "snip" }], warnings: ["careful"] };
  ui.changes(plan, "shop", "install");
  assert.ok(out.some((m) => m.includes("+++ b/proxy.js")));
  assert.ok(out.some((m) => m === "Will run: npm install a@1"));
  assert.ok(out.includes("WARN careful"));
  assert.ok(out.some((m) => m.startsWith("WARN app/layout.tsx: why")));
  ui.handoff({ host: "Netlify", url: "https://app.parlox.io/sites/x?newKey=a#keys", where: "Project configuration → Environment variables", docs: "https://docs.netlify.com/build/environment-variables/get-started/", variables: ["PARLOX_SECRET_KEY", "PARLOX_VERIFY_TOKEN=vt"] });
  assert.ok(out.some((m) => m.includes("Netlify") && m.includes("https://app.parlox.io/sites/x?newKey=a#keys")));
  ui.report(["Server part: not checked.", "Next: deploy."]);
  assert.equal(out.at(-1), "Server part: not checked.\nNext: deploy.");
});

test("the plain face's log line is scrubbed", async () => {
  const { plainUi } = await import("../dist/ui/plain.js");
  const written = [];
  const stream = { isTTY: false, write: (t) => { written.push(String(t)); return true; } };
  plainUi(stream).log(`npm printed ${SECRET}`);
  assert.equal(written.join("").includes(SECRET), false);
  assert.match(written.join(""), /npm printed \[hidden\]/);
});

test("plainUi(): changes() and handoff() scrub secrets from diffs, manual snippets and handoff fields", async () => {
  const { plainUi } = await import("../dist/ui/plain.js");
  // changes() and handoff() render through clack's own note()/log.message(), which always write to process.stdout
  // regardless of the stream passed to plainUi() — so this captures process.stdout.write itself, as the review asked.
  const original = process.stdout.write;
  const written = [];
  process.stdout.write = (chunk) => { written.push(String(chunk)); return true; };
  try {
    const ui = plainUi();
    const plan = {
      install: null,
      warnings: [],
      manual: [{ file: ".env.local", reason: "a real key would land here", snippet: `PARLOX_SECRET_KEY=${SECRET}` }],
      changes: [{ path: ".env.local", before: null, after: `PARLOX_SECRET_KEY=${SECRET}\n` }],
    };
    ui.changes(plan, "shop", "install");
    ui.handoff({
      host: "Netlify",
      url: `https://app.parlox.io/sites/x?newKey=${SECRET}#keys`,
      where: `Paste it near ${SECRET}`,
      docs: `https://docs.example.com/${SECRET}`,
      variables: [`PARLOX_SECRET_KEY=${SECRET}`],
    });
  } finally {
    process.stdout.write = original;
  }
  const out = written.join("");
  assert.equal(out.includes(SECRET), false, "the secret must never reach the terminal");
  assert.match(out, /\[hidden\]/);
});

test("summarizeChanges: kind, line counts and purpose per file", () => {
  const plan = { install: null, manual: [], warnings: [], changes: [
    { path: "app/layout.tsx", before: "a\nb\n", after: "a\nimport x\nb\n<P />\n" },
    { path: "proxy.ts", before: null, after: "1\n2\n3\n" },
    { path: ".env.local", before: null, after: "PARLOX_VERIFY_TOKEN=v\n" },
    { path: ".gitignore", before: "node_modules\n", after: "node_modules\n.env.local\n" },
    { path: "middleware.js", before: "x\n", after: null },
  ] };
  assert.deepEqual(summarizeChanges(plan), [
    { path: "app/layout.tsx", kind: "edited", added: 2, removed: 0, purpose: "browser part" },
    { path: "proxy.ts", kind: "created", added: 3, removed: 0, purpose: "server part" },
    { path: ".env.local", kind: "created", added: 1, removed: 0, purpose: "ownership token" },
    { path: ".gitignore", kind: "edited", added: 1, removed: 0, purpose: "keeps .env.local out of git" },
    { path: "middleware.js", kind: "deleted", added: 0, removed: 1, purpose: "server part" },
  ]);
  assert.equal(purposeOf("src/pages/_app.jsx"), "browser part");
  assert.equal(purposeOf("src/middleware.ts"), "server part");
  assert.equal(purposeOf("README.md"), "");
});

test("hand-off with only the verify token left: each variable is named, and neither face asks for a secret key", async () => {
  const handoff = { host: "Vercel", url: null, where: "your project → Settings → Environment Variables (then redeploy)", docs: null, variables: ["PARLOX_VERIFY_TOKEN=vt"] };
  const out = [];
  withDefaults({ info: (m) => out.push(m), warn: (m) => out.push(`WARN ${m}`), confirm: async () => true, select: async (_m, o) => o[0].value, text: async () => "" }).handoff(handoff);
  // The single wording (ui/handoff.ts).
  assert.ok(out.some((m) => m.includes("Set on Vercel:\n  PARLOX_VERIFY_TOKEN=vt")), JSON.stringify(out));
  assert.equal(out.some((m) => /secret key/i.test(m)), false, JSON.stringify(out));

  const { plainUi } = await import("../dist/ui/plain.js");
  const original = process.stdout.write;
  const written = [];
  process.stdout.write = (chunk) => { written.push(String(chunk)); return true; };
  try { plainUi().handoff(handoff); } finally { process.stdout.write = original; }
  const plain = written.join("");
  assert.match(plain, /PARLOX_VERIFY_TOKEN=vt/);
  assert.doesNotMatch(plain, /secret key/i);
});

test("the plain face prints the hand-off link whole, on one line, so it can be copied from any log", async () => {
  const { plainUi } = await import("../dist/ui/plain.js");
  const url = "https://app.parlox.io/sites/11111111-1111-1111-1111-111111111111?newKey=Netlify%20%C2%B7%20production#keys";
  const original = process.stdout.write;
  const written = [];
  process.stdout.write = (chunk) => { written.push(String(chunk)); return true; };
  try {
    plainUi().handoff({ host: "Netlify", url, where: "Project configuration → Environment variables", docs: "https://docs.netlify.com/build/environment-variables/get-started/", variables: ["PARLOX_SECRET_KEY (from the dashboard key, shown once)", "PARLOX_VERIFY_TOKEN=vt"] });
  } finally {
    process.stdout.write = original;
  }
  assert.ok(written.join("").split("\n").some((line) => line.includes(url)), written.join(""));
});

test("the plain face prints the host's docs link whole, on one line, however long it is", async () => {
  const { plainUi } = await import("../dist/ui/plain.js");
  const docs = "https://docs.example-host.com/a/rather/long/path/to/the/page/about/environment-variables/and/secrets/for/services";
  const original = process.stdout.write;
  const written = [];
  process.stdout.write = (chunk) => { written.push(String(chunk)); return true; };
  try {
    plainUi().handoff({ host: "Example", url: null, where: "Settings", docs, variables: ["PARLOX_VERIFY_TOKEN=vt"] });
  } finally {
    process.stdout.write = original;
  }
  assert.ok(written.join("").split("\n").some((line) => line.includes(docs)), written.join(""));
});

test("withDefaults: the fallback changes() and handoff() scrub secrets from the diff, manual snippets and every hand-off field", () => {
  const out = [];
  const ui = withDefaults({ info: (m) => out.push(m), warn: (m) => out.push(`WARN ${m}`), confirm: async () => true, select: async (_m, o) => o[0].value, text: async () => "" });
  ui.changes({ changes: [{ path: ".env.local", before: `PARLOX_SECRET_KEY=${SECRET}\n`, after: null }], install: null, manual: [{ file: `f-${SECRET}`, reason: `r-${SECRET}`, snippet: `PARLOX_SECRET_KEY=${SECRET}` }], warnings: [`w-${SECRET}`] }, "shop", "uninstall");
  ui.handoff({ host: `h-${SECRET}`, url: `https://app.parlox.io/x?newKey=${SECRET}`, where: `w-${SECRET}`, docs: `d-${SECRET}`, variables: [`PARLOX_SECRET_KEY=${SECRET}`] });
  assert.ok(out.length >= 4, JSON.stringify(out));
  assert.equal(out.some((m) => m.includes(SECRET)), false, JSON.stringify(out));
  assert.ok(out.some((m) => m.includes("[hidden]")));
});

// A stop (Ctrl-C from outside, SIGTERM) while a plain question is open ends it at once, as a cancel: the flow
// unwinds and signs out instead of waiting for an answer until the grace runs out.
test("plainUi(out, signal): once the stop signal has fired, a question ends at once as a cancel", async () => {
  const { plainUi } = await import("../dist/ui/plain.js");
  const ac = new AbortController();
  ac.abort();
  const stream = { isTTY: false, write: () => true };
  const ui = plainUi(stream, ac.signal);
  // A cancelled Yes/No question is a stop, never an answer (it read as a No before).
  await assert.rejects(ui.confirm("Apply these changes to shop?"), /Cancelled\./);
  await assert.rejects(ui.select("Which site is this project?", [{ value: "a", label: "Shop" }]), /Cancelled\./);
  await assert.rejects(ui.text("The site's domain"), /Cancelled\./);
});

// clack adds an abort listener to the signal of each question and never removes it; on the run's own signal, every
// question already answered would close again at a stop and print one more line.
test("plainUi: questions already answered leave nothing on the stop signal; a stop prints no extra lines", { timeout: 20_000 }, async () => {
  const { spawn } = await import("node:child_process");
  const { resolve } = await import("node:path");
  const child = spawn(process.execPath, [resolve(import.meta.dirname, "plain-child.mjs")], { stdio: ["pipe", "pipe", "pipe"] });
  let out = "", answered = 0;
  const kill = setTimeout(() => child.kill(), 15_000);
  child.stdout.on("data", (d) => {
    out += d;
    // Answer each question once it is shown: y, then Enter.
    while (answered < 3 && out.includes(`Question ${answered + 1}?`)) {
      answered++;
      setTimeout(() => { child.stdin.write("y"); setTimeout(() => child.stdin.write("\r"), 20); }, 20);
    }
    if (out.includes("AFTER-STOP")) child.stdin.end();
  });
  const code = await new Promise((r) => child.on("exit", r));
  clearTimeout(kill);
  assert.equal(code, 0, out);
  assert.match(out, /LISTENERS 0\n/, "no abort listener left by the three answered questions");
  const between = out.slice(out.indexOf("BEFORE-STOP") + "BEFORE-STOP".length, out.indexOf("AFTER-STOP"));
  assert.equal(JSON.stringify(between), '""', "the stop wrote nothing");
});

// Finding 5 (Trojan Source): a bidirectional override or a zero-width character in a file would make the diff read
// differently from what is written, and an escape code would restyle the terminal. The plain face writes them out.
// Tabs stay tabs here: the terminal itself lays them out.
test("plainUi(): the diff and the file list write out control and invisible format characters", async () => {
  const { plainUi } = await import("../dist/ui/plain.js");
  const original = process.stdout.write;
  const written = [];
  process.stdout.write = (chunk) => { written.push(String(chunk)); return true; };
  try {
    plainUi().changes({ install: null, warnings: [], manual: [], changes: [{ path: "src/a‮b.ts", before: null, after: "const ok = 1;‮ // x\nz​w\u001b[2J\n\tindented\n" }] }, "shop", "install");
  } finally {
    process.stdout.write = original;
  }
  const out = written.join("");
  for (const raw of ["‮", "​", "\u001b[2J"]) assert.equal(out.includes(raw), false, JSON.stringify(raw));
  assert.match(out, /src\/a<U\+202E>b\.ts/);
  assert.match(out, /const ok = 1;<U\+202E> \/\/ x/);
  assert.match(out, /z<U\+200B>w\^\[\[2J/);
  assert.match(out, /\+\tindented/);
});

// The hand-off had three wordings ("Where to paste:" in two faces, "Where (host):" in the fallback)
// and the diff's scrub-and-print pipeline was written twice. One source for each now.
test("one hand-off wording: the plain face, the fallback and the full screen's lines are the same", async () => {
  const { handoffLines, HANDOFF_TITLE } = await import("../dist/ui/handoff.js");
  const { plainUi } = await import("../dist/ui/plain.js");
  const { handoffLines: storeLines } = await import("../dist/tui/store.js");
  const h = { host: "Netlify", url: "https://app.parlox.io/sites/1?newKey=Netlify%20%C2%B7%20production#keys", where: "Project configuration → Environment variables", docs: "https://docs.netlify.com/build/environment-variables/get-started/", variables: ["PARLOX_SECRET_KEY (from the dashboard key, shown once)", "PARLOX_VERIFY_TOKEN=vt"] };
  const lines = handoffLines(h);
  assert.equal(storeLines, handoffLines, "the store uses the same function");
  const out = [];
  withDefaults({ info: (m) => out.push(m), warn: (m) => out.push(`WARN ${m}`), confirm: async () => true, select: async (_m, o) => o[0].value, text: async () => "" }).handoff(h);
  assert.deepEqual(out, [[HANDOFF_TITLE, ...lines].join("\n")]);
  const original = process.stdout.write;
  const written = [];
  process.stdout.write = (chunk) => { written.push(String(chunk)); return true; };
  try { plainUi().handoff(h); } finally { process.stdout.write = original; }
  const plain = written.join("");
  for (const line of lines) assert.ok(plain.split("\n").some((l) => l.includes(line.trim()) && (line.startsWith("  ") ? l.includes(line) : true)), `${line}\n${plain}`);
  assert.doesNotMatch(plain, /Where \(/);
});

test("one diff pipeline: printableDiff() is what the fallback prints, scrubbed and printable", async () => {
  const { printableDiff } = await import("../dist/ui/summary.js");
  const plan = { install: null, warnings: [], manual: [], changes: [{ path: "notes.txt", before: null, after: `PARLOX_SECRET_KEY=${SECRET}\nx\u001b[2J\n\tt\n` }] };
  const diff = printableDiff(plan);
  assert.equal(diff.some((l) => l.includes(SECRET) || l.includes("\u001b")), false);
  assert.ok(diff.includes("+PARLOX_SECRET_KEY=[hidden]"), JSON.stringify(diff));
  assert.ok(diff.includes("+x^[[2J"), JSON.stringify(diff));
  assert.ok(diff.includes("+\tt"), "tabs are left to the terminal");
  const out = [];
  withDefaults({ info: (m) => out.push(m), warn: (m) => out.push(`WARN ${m}`), confirm: async () => true, select: async (_m, o) => o[0].value, text: async () => "" }).changes(plan, "shop", "install");
  assert.equal(out[0], diff.join("\n"));
});

// Without a terminal, a plain question is never waited on: it refuses at once, naming the question
// and how to answer it without a terminal (a hint per question, "Run it in a terminal." otherwise).
test("plainUi: with no terminal on stdin, every question refuses at once with its hint", async () => {
  const { plainUi } = await import("../dist/ui/plain.js");
  const { NoTerminalError } = await import("../dist/ui/types.js");
  const written = [];
  const out = { isTTY: false, columns: 80, write: (t) => { written.push(String(t)); return true; } };
  const pipe = { isTTY: false };
  const ui = plainUi(out, undefined, pipe);
  await assert.rejects(ui.select("Which site is this project?", [{ value: "a", label: "Shop" }], "Pass --site <domain>."), (e) => e instanceof NoTerminalError && e.message === "No terminal to answer: Which site is this project? Pass --site <domain>.");
  await assert.rejects(ui.confirm("Continue anyway?"), (e) => e instanceof NoTerminalError && e.message === "No terminal to answer: Continue anyway? Run it in a terminal.");
  await assert.rejects(ui.text("The site's domain", "shop.example.com", "Pass --site <domain>."), (e) => e.message === "No terminal to answer: The site's domain. Pass --site <domain>.");
  assert.deepEqual(written, [], "nothing drawn: no question was shown");
});
