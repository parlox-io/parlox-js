#!/usr/bin/env node
// First, before any other module is loaded (a static import would run before this line, so everything is imported
// below it): on Windows, Node's own search for a program to start (git, rundll32) looks in the current folder before
// PATH unless this is set in the wizard's own environment, so a project could put a git.exe of its own there. Every
// child also gets it (run.ts childEnv). Elsewhere it does nothing.
process.env.NoDefaultCurrentDirectoryInExePath = "1";

const [{ start }, { scrub }] = await Promise.all([import("./start.js"), import("./ui/scrub.js")]);

start(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => { process.stderr.write(`${scrub(err instanceof Error ? err.message : String(err))}\n`); process.exit(1); },
);
