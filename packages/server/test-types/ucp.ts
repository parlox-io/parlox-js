// Compiled with tsc --noEmit (strict) by npm test: ucp() and its types, from the package's entry and the fetch adapter.
import { createParlox, type UcpCode, type UcpContext, type UcpOp, type UcpReport } from "../src/index.js";
import { parloxFetch } from "../src/fetch.js";

const parlox = createParlox({ secretKey: "sk_example", maxUcpReportsInFlight: 5 });
const code: UcpCode = { type: "error", code: "out_of_stock", severity: "recoverable", path: "$.line_items[0]" };
const op: UcpOp = "checkout_create";
const report: UcpReport = { op, http_status: 201, ms: 40, checkout_id: "chk_1", checkout_status: "incomplete", codes: [code], total_cents: 4990, items: 1, item_ids: ["sku_1"], platform: "agent.example.com" };
const context: UcpContext = { ua: "AgentPlatform/1.0", ip: "203.0.113.9", ip_hash: null, sid: null, path: "/checkout-sessions" };
const done: Promise<{ ok: boolean; status: number }> = parlox.ucp(report, context);
const bare: Promise<{ ok: boolean; status: number }> = parloxFetch().ucp({ op: "discovery" });
void done; void bare;

// @ts-expect-error: op is one of the UCP operations
void parlox.ucp({ op: "checkout_finish" });
// @ts-expect-error: op is required
void parlox.ucp({ http_status: 200 });
// @ts-expect-error: checkout_status is one of UCP's checkout statuses
void parlox.ucp({ op: "checkout_get", checkout_status: "done" });
