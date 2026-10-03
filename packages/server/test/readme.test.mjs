// The README is what merchants copy from: its snippets must match the built package, and it must state the behaviour
// the code has (the order key, the bounds, AWS Lambda, Deno).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const here = import.meta.dirname;
const readme = readFileSync(resolve(here, "../README.md"), "utf8");
const blocks = [...readme.matchAll(/```[a-z]*\n([\s\S]*?)```/g)].map((m) => m[1]);
const inline = [...readme.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]);
const section = (title) => readme.split(/^## /m).find((s) => s.startsWith(title)) ?? "";
const oneLine = (text) => text.replace(/\s+/g, " ");

const entry = (spec) => pathToFileURL(resolve(here, "../dist/esm", `${spec === "@parlox/server" ? "index" : spec.slice("@parlox/server/".length)}.js`)).href;

test("readme: every import and require of @parlox/server names something that entry point exports", async () => {
  const uses = [];
  for (const code of [...blocks, ...inline]) {
    for (const m of code.matchAll(/import\s*\{([^}]+)\}\s*from\s*"(@parlox\/server(?:\/[a-z]+)?)"/g)) uses.push([m[2], m[1].split(",").map((n) => n.trim().split(/\s+as\s+/)[0]).filter(Boolean)]);
    for (const m of code.matchAll(/require\("(@parlox\/server(?:\/[a-z]+)?)"\)/g)) uses.push([m[1], []]);
  }
  assert.ok(uses.length >= 7, `found ${uses.length}`);
  for (const [spec, names] of uses) {
    const mod = await import(entry(spec));
    for (const name of names) assert.ok(name in mod, `${spec} exports ${name}`);
  }
});

test("readme: every option in the table is one the package's types declare", () => {
  const types = readdirSync(resolve(here, "../dist/types")).filter((f) => f.endsWith(".d.ts")).map((f) => readFileSync(resolve(here, "../dist/types", f), "utf8")).join("\n");
  const options = [...readme.matchAll(/^\| `([A-Za-z]+)(?:\([^)]*\))?` \|/gm)].map((m) => m[1]);
  assert.ok(options.length >= 15, `found ${options.length}`);
  for (const name of options) assert.match(types, new RegExp(`\\b${name}\\?:`), name);
});

test("readme: confirmed orders use an instance and a key of their own, and say where a send key comes from", () => {
  const orders = section("Confirmed orders");
  const code = [...orders.matchAll(/```[a-z]*\n([\s\S]*?)```/g)].map((m) => m[1]).join("\n");
  const made = code.match(/const (\w+) = createParlox\(\{ secretKey: process\.env\.PARLOX_ORDERS_KEY \}\);/);
  assert.ok(made, code);
  assert.match(code, new RegExp(`await ${made[1]}\\.purchase\\(`));
  assert.doesNotMatch(code, /createParlox\(\)/);
  const text = oneLine(orders);
  assert.match(text, /can only send crawler reports/);
  assert.match(text, /Settings → Keys/);
  assert.match(text, /"Send: crawler reports and orders"/);
});

test("readme: AWS Lambda reports start after the handler has returned, so they usually wait for the next invocation", () => {
  const text = oneLine(readme);
  assert.match(text, /On AWS Lambda[^.]*starts only after an asynchronous one-way hash, so after your handler has returned/);
  assert.match(text, /usually delayed to the next invocation of the same warm instance, and lost when the instance is frozen and then recycled/);
  assert.doesNotMatch(text, /is sent at once on AWS Lambda, and/, "no unqualified promise for Lambda");
});

test("readme: the bounds on sending at once, and the shared purchase cap, are stated as the code applies them", () => {
  const text = oneLine(readme);
  assert.match(text, /At most 64 reports are sent at once in the whole process/);
  assert.match(text, /Each instance compares the number in flight in the process with its own `maxPurchasesInFlight`/);
  assert.match(text, /`onError` gets Parlox's reason/);
});

test("readme: on Deno the environment is read only with permission", () => {
  assert.match(oneLine(readme), /On Deno, environment variables are read only with `--allow-env`/);
});

test("readme: long-running servers get the shutdown snippet, fitted to the app's own, and a hard kill is said to lose what is queued", () => {
  const shutdown = section("Shutdown (long-running servers)");
  assert.ok(shutdown, "the section the wizard's report links to (#shutdown-long-running-servers)");
  const code = [...shutdown.matchAll(/```[a-z]*\n([\s\S]*?)```/g)].map((m) => m[1]).join("\n");
  assert.ok(code.includes('process.on("SIGTERM", async () => { await parlox.flush(); process.exit(0); })'), code);
  const text = oneLine(shutdown);
  for (const host of ["Express", "Hono on Node or Bun", "Fly.io", "Render", "Railway", "Heroku", "Cloud Run", "Kubernetes"]) assert.ok(text.includes(host), host);
  assert.match(text, /installs no signal handler/);
  assert.match(text, /Fly\.io sends SIGINT/);
  assert.match(text, /A hard kill [^.]*loses what is queued, and with it the count of reports not yet delivered/);
});

test("readme: cf-connecting-ip is the default only for requests Cloudflare's own runtime received, and self-hosted workerd names its proxy's header", () => {
  const text = oneLine(readme);
  assert.match(text, /`cf-connecting-ip` only for a request that carries Cloudflare's `cf` object/);
  assert.match(text, /On self-hosted workerd, set `ipHeader` \(or `PARLOX_IP_HEADER`\) to the header your proxy sets/);
  assert.doesNotMatch(text, /`cf-connecting-ip` on Cloudflare Workers automatically/);
});

test("readme: UCP reports use the send key's own instance, show a report after a UCP call, and say what is sent, what never is, and what a crawler-only key gets", () => {
  const all = readme.split(/^## /m).map((s) => s.split("\n")[0]);
  assert.equal(all[all.indexOf("Confirmed orders") + 1], "UCP reports", "beside Confirmed orders");
  const ucp = section("UCP reports");
  const code = [...ucp.matchAll(/```[a-z]*\n([\s\S]*?)```/g)].map((m) => m[1]).join("\n");
  const made = code.match(/const (\w+) = createParlox\(\{ secretKey: process\.env\.PARLOX_ORDERS_KEY \}\);/);
  assert.ok(made, code);
  assert.match(code, new RegExp(`${made[1]}\\.ucp\\(\\s*\\{ op: "checkout_create"`));
  assert.doesNotMatch(code, /createParlox\(\)/);
  const text = oneLine(ucp);
  const ops = ["discovery", "catalog_search", "catalog_lookup", "catalog_product", "checkout_create", "checkout_get", "checkout_update", "checkout_complete", "checkout_cancel", "order_get", "order_update", "handoff_opened", "handoff_linked", "handoff_completed"];
  for (const op of ops) assert.ok(text.includes(`\`${op}\``), op);
  assert.match(text, /Never sent: buyer names, emails, phone numbers, addresses, payment instruments or tokens/);
  assert.match(text, /emails and runs of 4 or more digits in it are replaced with `\[email\]` and `\[number\]`/);
  assert.match(text, /Pass `ip` only when the caller is an agent platform's server/);
  assert.match(text, /HTTP 403/);
  assert.match(text, /`Parlox refused the UCP report \(HTTP 403\): This key can only send crawler reports\. To record orders or UCP reports, create a send key in the dashboard \(Settings → Keys\)\.`/);
  assert.match(text, /never batched/);
  assert.match(text, /At most 10 are posted at the same time in the whole process/);
});

test("readme: UCP reports' second argument has no path; a message's path is free text kept as passed; the query's masking is partial", () => {
  const text = oneLine(section("UCP reports"));
  const second = text.slice(text.indexOf("The second argument"));
  assert.doesNotMatch(second.slice(0, second.indexOf(". ")), /`path`/, "the call's path is not sent");
  assert.match(text, /A message's `path` is free text that Parlox keeps as you pass it, up to 80 characters, without masking anything in it\. What goes there is your decision: it is meant for the JSONPath the message points at \(such as `\$\.line_items\[0\]`\), never for buyer data\./);
  assert.match(text, /a number split by spaces or other characters is masked only in its runs of 4 or more digits \(`555 123 4567` is sent as `555 123 \[number\]`\)/);
  assert.match(text, /do not pass buyer data in the query/);
});
