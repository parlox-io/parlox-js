// Run by ui.test.mjs in a child process, because the plain face's questions read the real stdin (here a pipe the
// parent answers through): three questions answered, then the run's stop signal fires. The markers around the stop
// let the parent see exactly what the stop itself wrote.
import { getEventListeners } from "node:events";
import { plainUi } from "../dist/ui/plain.js";

const ac = new AbortController();
// The parent answers through a pipe standing in for a terminal: without a terminal, a plain question is refused at
// once, and this test is about questions that are asked.
Object.defineProperty(process.stdin, "isTTY", { value: true });
process.stdin.setRawMode = () => process.stdin;
const ui = plainUi(process.stdout, ac.signal);
for (let i = 1; i <= 3; i++) await ui.confirm(`Question ${i}?`);
process.stdout.write(`\nLISTENERS ${getEventListeners(ac.signal, "abort").length}\nBEFORE-STOP`);
ac.abort();
await new Promise((r) => setTimeout(r, 50));
process.stdout.write("AFTER-STOP\n");
