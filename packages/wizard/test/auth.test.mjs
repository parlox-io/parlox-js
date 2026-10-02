import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { createHash } from "node:crypto";
import { signIn, signOut, pkcePair, SignInError, SIGN_IN_TIMEOUT_MS } from "../dist/auth.js";
import { GatewayClient, ApiError } from "../dist/api.js";
import { PRODUCTION } from "../dist/config.js";
import { startFakeAuth, startFakeGateway } from "./fake-servers.mjs";

const PORTS = [53782, 53783];
const API_KEY = "anon-public-key-fake-for-tests";
const follow = (url) => { fetch(url).catch(() => {}); };
// A one-off request on its own socket (no keep-alive), so it can't be handed a connection pooled from a
// previous test's server on the same port that has since been closed.
const rawRequest = (url, method) => new Promise((resolve, reject) => {
  const u = new URL(url);
  const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, agent: false }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode)); });
  req.on("error", reject);
  req.end();
});

test("production endpoints are compiled in and https; the four registered ports; a publishable apiKey", () => {
  assert.match(PRODUCTION.gateway, /^https:\/\//);
  assert.match(PRODUCTION.supabaseUrl, /^https:\/\//);
  assert.deepEqual(PRODUCTION.ports, [53682, 53683, 53684, 53685]);
  assert.equal(typeof PRODUCTION.apiKey, "string");
  assert.ok(PRODUCTION.apiKey.length > 0);
});

test("PKCE: verifier is 43+ url-safe characters and the challenge is its S256", () => {
  const { verifier, challenge } = pkcePair();
  assert.match(verifier, /^[A-Za-z0-9_-]{43,128}$/);
  assert.equal(challenge, createHash("sha256").update(verifier).digest("base64url"));
});

test("approve: returns the access token; the code is exchanged with the verifier, the exact redirect URI and the apikey header; sign-out ends the session and reports success", async () => {
  const auth = await startFakeAuth({ decide: "approve" });
  try {
    const token = await signIn({ supabaseUrl: auth.url, clientId: "wiz", apiKey: API_KEY, ports: PORTS, open: follow, timeoutMs: 5000 });
    assert.equal(token, "wizard-token");
    assert.equal(auth.tokenRequests[0].grant_type, "authorization_code");
    assert.equal(auth.tokenRequests[0].redirect_uri, `http://127.0.0.1:${PORTS[0]}/callback`);
    assert.equal(await signOut(auth.url, API_KEY, token), true);
    assert.deepEqual(auth.logouts, ["Bearer wizard-token"]);
    // Only this sign-in's session: without scope=local Supabase would sign the user out everywhere, dashboard included.
    assert.deepEqual(auth.logoutScopes, ["local"]);
  } finally { auth.close(); }
});

test("the default sign-in timeout is 5 minutes (tests pass their own shorter ones)", () => {
  assert.equal(SIGN_IN_TIMEOUT_MS, 300_000);
});

test("a stray request with the wrong state is answered 400 and does not end the flow", async () => {
  const auth = await startFakeAuth({ decide: "approve" });
  try {
    let strayStatus;
    const open = async (url) => {
      strayStatus = (await fetch(`http://127.0.0.1:${PORTS[0]}/callback?code=x&state=forged`)).status;
      follow(url);
    };
    assert.equal(await signIn({ supabaseUrl: auth.url, clientId: "wiz", apiKey: API_KEY, ports: PORTS, open, timeoutMs: 5000 }), "wizard-token");
    assert.equal(strayStatus, 400);
  } finally { auth.close(); }
});

test("/callback refuses any method other than GET, and the flow still completes", async () => {
  const auth = await startFakeAuth({ decide: "approve" });
  try {
    let methodStatus;
    const open = async (url) => {
      methodStatus = await rawRequest(`http://127.0.0.1:${PORTS[0]}/callback`, "POST");
      follow(url);
    };
    assert.equal(await signIn({ supabaseUrl: auth.url, clientId: "wiz", apiKey: API_KEY, ports: PORTS, open, timeoutMs: 5000 }), "wizard-token");
    assert.equal(methodStatus, 405);
  } finally { auth.close(); }
});

/** A one-off request on its own socket that returns the status and the headers, without following a redirect. */
const rawHead = (url, method = "GET", headers = {}) => new Promise((resolve, reject) => {
  const u = new URL(url);
  const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers, agent: false }, (res) => { res.resume(); res.on("end", () => resolve({ status: res.statusCode, headers: res.headers })); });
  req.on("error", reject);
  req.end();
});

/** A raw request written on its own socket (to send what http.request would not, such as no Host header at all);
 * resolves with the response's status. */
const rawStatus = (port, text) => new Promise((resolve, reject) => {
  const socket = net.connect(port, "127.0.0.1", () => socket.write(text));
  let data = "";
  socket.on("data", (c) => (data += c));
  socket.on("end", () => resolve(Number(data.split(" ")[1])));
  socket.on("error", reject);
});

/** A stand-in for Supabase's OAuth server that approves at once and holds the token exchange until `release()`: the
 * wizard's listener then stays up after the callback, for as long as the test needs. */
async function slowAuth() {
  let release;
  const released = new Promise((r) => (release = r));
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, "http://x");
    if (u.pathname === "/auth/v1/oauth/authorize") {
      const back = new URL(u.searchParams.get("redirect_uri"));
      back.searchParams.set("code", "code_1");
      back.searchParams.set("state", u.searchParams.get("state"));
      return res.writeHead(302, { location: back.toString() }).end();
    }
    if (u.pathname === "/auth/v1/oauth/token") { req.resume(); await released; return res.writeHead(200, { "content-type": "application/json" }).end('{"access_token":"slow-token"}'); }
    res.writeHead(404).end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}`, release: () => release(), close: () => { server.closeAllConnections?.(); server.close(); } };
}

// The link to copy when the browser did not open is the listener's own root with a per-run token
// (as rclone's loopback link), which redirects to this run's authorize URL. The target is fixed (never taken from
// the request). Only a GET addressed to 127.0.0.1:<port> with the token gets it; anything else is a 404, as for an
// unknown path, so nothing confirms that a sign-in is waiting. Once the callback has come, the link is gone.
test("the short link: only GET /?t=<token>, addressed to 127.0.0.1:<port>, redirects; everything else is a 404; it ends at the callback", async () => {
  const auth = await slowAuth();
  try {
    let short, full;
    const got = {};
    const open = async (url) => {
      full = url;
      const port = PORTS[0];
      const token = new URL(short).searchParams.get("t");
      const at = (path, headers = {}, method = "GET") => rawHead(`http://127.0.0.1:${port}${path}`, method, headers);
      got.noHost = await rawStatus(port, `GET /?t=${token} HTTP/1.0\r\n\r\n`);
      got.localhost = await at(`/?t=${token}`, { host: `localhost:${port}` });
      got.noPort = await at(`/?t=${token}`, { host: "127.0.0.1" });
      got.rebound = await at(`/?t=${token}`, { host: `attacker.example:${port}` });
      got.noToken = await at("/");
      got.wrongToken = await at(`/?t=${"A".repeat(token.length)}`);
      got.shortToken = await at(`/?t=${token.slice(0, -1)}`);
      got.longToken = await at(`/?t=${token}x`);
      got.post = await at(`/?t=${token}`, {}, "POST");
      got.withRedirect = await at(`/?t=${token}&redirect=https%3A%2F%2Fevil.example%2F`);
      got.other = await at("/authorize");
      got.root = await rawHead(short);
      // The browser, from here: the authorize page sends it back to the callback.
      const callback = (await rawHead(url)).headers.location;
      got.callback = await rawHead(callback);
      got.afterCallback = await rawHead(short);
      auth.release();
    };
    const token = await signIn({ supabaseUrl: auth.url, clientId: "wiz", apiKey: API_KEY, ports: PORTS, open, timeoutMs: 5000, onListening: (u) => { short = u; } });
    assert.equal(token, "slow-token", "the callback still completes the sign-in after GET /");
    assert.match(short, new RegExp(`^http://127\\.0\\.0\\.1:${PORTS[0]}/\\?t=[A-Za-z0-9_-]{22}$`), "128 random bits, base64url");
    assert.match(full, /\/auth\/v1\/oauth\/authorize\?/, "the browser is opened with the full authorize URL");
    assert.equal(full.includes(new URL(short).searchParams.get("t")), false, "the token is not part of the authorize URL");
    assert.equal(got.root.status, 302);
    assert.equal(got.root.headers.location, full);
    assert.equal(got.root.headers["cache-control"], "no-store");
    assert.equal(got.root.headers["referrer-policy"], "no-referrer");
    assert.equal(got.withRedirect.status, 302);
    assert.equal(got.withRedirect.headers.location, full, "the target never comes from the request");
    assert.equal(got.post.status, 405);
    for (const name of ["noHost", "localhost", "noPort", "rebound", "noToken", "wrongToken", "shortToken", "longToken", "other", "afterCallback"]) {
      const r = got[name];
      assert.equal(typeof r === "number" ? r : r.status, 404, name);
      if (typeof r !== "number") assert.equal(r.headers.location, undefined, name);
    }
    assert.equal(got.callback.status, 200);
    await assert.rejects(rawHead(short), "the short link ends with the listener");
  } finally { auth.close(); }
});

// Two runs never share a link.
test("the short link's token is new for every sign-in", async () => {
  const auth = await startFakeAuth({ decide: "approve" });
  try {
    const links = [];
    for (let i = 0; i < 2; i++) await signIn({ supabaseUrl: auth.url, clientId: "wiz", apiKey: API_KEY, ports: PORTS, open: follow, timeoutMs: 5000, onListening: (u) => links.push(u) });
    assert.notEqual(new URL(links[0]).searchParams.get("t"), new URL(links[1]).searchParams.get("t"));
  } finally { auth.close(); }
});

test("deny and timeout end with a SignInError and free the port", async () => {
  for (const [decide, code] of [["deny", "denied"], ["never", "timeout"]]) {
    const auth = await startFakeAuth({ decide });
    try {
      await assert.rejects(signIn({ supabaseUrl: auth.url, clientId: "wiz", apiKey: API_KEY, ports: PORTS, open: follow, timeoutMs: 800 }), (e) => e instanceof SignInError && e.code === code, decide);
    } finally { auth.close(); }
  }
  const probe = http.createServer();
  await new Promise((r, j) => probe.once("error", j).listen(PORTS[0], "127.0.0.1", r));
  probe.close();
});

test("the next port is used when the first is busy; all busy is ports-busy", async () => {
  const blocker = http.createServer();
  await new Promise((r) => blocker.listen(PORTS[0], "127.0.0.1", r));
  const auth = await startFakeAuth({ decide: "approve" });
  try {
    await signIn({ supabaseUrl: auth.url, clientId: "wiz", apiKey: API_KEY, ports: PORTS, open: follow, timeoutMs: 5000 });
    assert.equal(auth.tokenRequests[0].redirect_uri, `http://127.0.0.1:${PORTS[1]}/callback`);
    await assert.rejects(signIn({ supabaseUrl: auth.url, clientId: "wiz", apiKey: API_KEY, ports: [PORTS[0]], open: follow, timeoutMs: 500 }), (e) => e.code === "ports-busy");
  } finally { blocker.close(); auth.close(); }
});

test("gateway client: sites, create, key, verify token, errors carry the status, paths are URL-encoded", async () => {
  const gw = await startFakeGateway();
  try {
    const c = new GatewayClient(gw.url, "wizard-token");
    assert.deepEqual(await c.listSites(), []);
    const site = await c.createSite("Shop", "shop.example.com");
    assert.equal(site.domain, "shop.example.com");
    assert.match(await c.createKey(site.id, "Vercel · production"), /^sk_parlox_/);
    assert.equal((await c.verifyToken(site.id)).verify_token, "vt_fake");
    await assert.rejects(new GatewayClient(gw.url, "bad").listSites(), (e) => e instanceof ApiError && e.status === 401);

    const weirdId = "abc/def ghi";
    await c.createKey(weirdId, "Weird key");
    assert.ok(gw.calls.some((call) => call.path === `/v1/wizard/sites/${encodeURIComponent(weirdId)}/keys`));
    assert.ok(!gw.calls.some((call) => call.path.includes("abc/def ghi")));
  } finally { gw.close(); }
});
