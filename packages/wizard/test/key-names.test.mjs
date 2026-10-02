import { test } from "node:test";
import assert from "node:assert/strict";
import { localKeyName } from "../dist/hosts.js";
import { runNames } from "../dist/names.js";

// In a run with several apps, the local key's name ends with the app's folder: that is what tells the keys apart, so
// within the 71 characters a name may have (the gateway adds "wizard · " and allows 80), the computer's name is
// shortened first, marked with "…", and only a folder too long even then keeps its end. The host names are given here,
// never the machine's.

// GitHub's macOS runner's host name (40 characters), and a 63-character one (the longest a DNS label may be).
const H40 = "sat12-bq161-7a1783d1-5822-4f00-a319-c7d4";
const H63 = "ip-10-200-30-40-build-agent-pool-7f3c9e2a1b4d-eu-central-1-ci01";
const units = (rel) => [{ rel, dir: `/work/${rel}` }, { rel: "apps/other", dir: "/work/apps/other" }];
const name = (host, rel) => { const u = units(rel); return runNames(u, "/work").localKey(u[0], localKeyName(host)); };

test("the host names are the lengths the tests mean", () => {
  assert.equal(H40.length, 40);
  assert.equal(H63.length, 63);
});

test("a 40- or 63-character host name: the folder stays whole, the computer's name is shortened, at most 71 characters", () => {
  for (const host of [H40, H63]) {
    for (const folder of ["parlox-wizard-EX0tEQ", "apps/storefront-admin", "packages/checkout-service-v2"]) {
      const n = name(host, folder);
      assert.ok(n.length <= 71, `${n} (${n.length})`);
      assert.ok(n.endsWith(` · ${folder}`), n);
      assert.ok(n.startsWith(`local dev · ${host.slice(0, 4)}`), n);
      assert.match(n, /… · /, `the shortened computer's name is marked: ${n}`);
    }
  }
});

test("a name that fits is unchanged; a run with one app names the computer alone", () => {
  assert.equal(name("Erezs-MacBook-Pro.local", "apps/web"), "local dev · Erezs-MacBook-Pro.local · apps/web");
  assert.equal(name(H40, "web"), `local dev · ${H40} · web`, "52 + 3 + 3 characters fit");
  const one = [{ rel: "apps/web", dir: "/work/apps/web" }];
  assert.equal(runNames(one, "/work").localKey(one[0], localKeyName(H40)), `local dev · ${H40}`);
});

test("only a folder too long for even a few characters of the computer's name keeps its end", () => {
  const folder = `packages/${"x".repeat(80)}/storefront`;
  for (const host of [H40, H63, "ab"]) {
    const n = name(host, folder);
    assert.ok(n.length <= 71, `${n} (${n.length})`);
    assert.ok(n.endsWith("/storefront"), n);
    assert.ok(n.startsWith(`local dev · ${host.slice(0, 4)}`), n);
  }
});
