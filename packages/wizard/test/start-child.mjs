// Run by start.test.mjs in a child process, because the behaviour under test ends the process: start() on a fake
// terminal while the flow waits for the browser sign-in (which does not listen for a stop), then the signal named in
// argv[3] twice, 250 ms apart. Everything written to the terminal is appended to the file argv[2] as it happens
// (an in-memory copy would be lost at process.exit). If start() returns instead, the child says so and exits 99.
import { appendFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import { start } from "../dist/start.js";
import { WizardStore } from "../dist/tui/store.js";
import { fixture, pkg } from "./helpers.mjs";

const [, , outFile, signal] = process.argv;
const layout = `export default function RootLayout({ children }) {\n  return (\n    <html>\n      <body>{children}</body>\n    </html>\n  );\n}\n`;
const G = ["-c", "user.email=t@t", "-c", "user.name=t"];
const dir = fixture({ "package.json": pkg(), "package-lock.json": "{}", "app/layout.tsx": layout, ".gitignore": ".env*.local\n" });
for (const args of [["init", "-q"], ["add", "-A"], ["commit", "-qm", "init"]]) execFileSync("git", [...G, ...args], { cwd: dir });

class Out extends EventEmitter {
  constructor() { super(); this.isTTY = true; this.columns = 120; this.rows = 40; }
  write(d, cb) { appendFileSync(outFile, String(d)); if (typeof cb === "function") cb(); return true; }
}
class In extends EventEmitter {
  constructor() { super(); this.isTTY = true; this.data = null; }
  type(d) { this.data = d; this.emit("readable"); this.emit("data", d); }
  read() { const d = this.data; this.data = null; return d; }
  setEncoding() {} setRawMode() {} resume() {} pause() {} ref() {} unref() {}
}
const stdout = new Out(), stdin = new In();
const store = new WizardStore();
let sent = false;
store.subscribe(() => {
  if (sent || store.getSnapshot().steps.signin !== "active") return;
  sent = true;
  setTimeout(() => process.emit(signal), 50);
  setTimeout(() => process.emit(signal), 300);
});
// Enter once the screen listens for keys (Ink is loaded when the full screen starts).
const enter = () => (stdin.listenerCount("readable") > 0 ? stdin.type("\r") : setTimeout(enter, 10));
setTimeout(enter, 40);
// Nothing answers the sign-in: the browser is never opened and the auth server does not exist.
const config = { gateway: "http://127.0.0.1:9", supabaseUrl: "http://127.0.0.1:9", clientId: "wiz", apiKey: "test-publishable-key", ports: [53796, 53797], dashboard: "https://app.parlox.io" };
const never = () => { throw new Error("nothing should run"); };
const env = { TERM: "xterm-256color", ...(process.platform === "win32" ? { WT_SESSION: "1" } : {}) };
const code = await start(["--site", "shop.example.com", "--skip-check"], { cwd: dir, config, open: () => {}, run: never }, { stdout, stdin, env, store });
appendFileSync(outFile, `\nstart() returned ${code}\n`);
process.exit(99);
