import http from "node:http";
import { createHash } from "node:crypto";

const listen = (server) => new Promise((r) => server.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${server.address().port}`)));
// Also ends idle keep-alive connections (fetch keeps them open), so a closed server holds nothing open.
const closeServer = (server) => { server.closeAllConnections?.(); server.close(); };
const body = (req) => new Promise((r) => { let s = ""; req.on("data", (c) => (s += c)); req.on("end", () => r(s)); });

// Stand-in for Supabase's OAuth server: /authorize "decides" at once and redirects the browser (here: our fetch).
// `logoutStatus` lets a test simulate Supabase's logout endpoint failing (anything other than 204).
export async function startFakeAuth({ decide, logoutStatus = 204 }) {
  const codes = new Map();
  const tokenRequests = [];
  const logouts = [];
  const logoutScopes = [];
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, "http://x");
    if (u.pathname === "/auth/v1/oauth/authorize") {
      const redirect = new URL(u.searchParams.get("redirect_uri"));
      if (decide === "never") return res.end("waiting");
      if (decide === "deny") redirect.searchParams.set("error", "access_denied");
      else {
        const code = "code_" + Math.random().toString(36).slice(2);
        codes.set(code, { challenge: u.searchParams.get("code_challenge"), redirect: u.searchParams.get("redirect_uri"), client: u.searchParams.get("client_id") });
        redirect.searchParams.set("code", code);
      }
      redirect.searchParams.set("state", u.searchParams.get("state"));
      res.writeHead(302, { location: redirect.toString() }).end();
      return;
    }
    if (u.pathname === "/auth/v1/oauth/token" && req.method === "POST") {
      // Supabase's own API gateway sits in front of /auth/v1/*: it 401s any request missing the project's
      // apikey header, before the Auth server itself ever sees it.
      if (!req.headers.apikey) return res.writeHead(401, { "content-type": "application/json" }).end('{"message":"No API key found in request"}');
      const p = new URLSearchParams(await body(req));
      tokenRequests.push(Object.fromEntries(p));
      const c = codes.get(p.get("code"));
      const challenge = createHash("sha256").update(p.get("code_verifier") ?? "").digest("base64url");
      if (!c || c.challenge !== challenge || c.redirect !== p.get("redirect_uri") || c.client !== p.get("client_id")) return res.writeHead(400).end('{"error":"invalid_grant"}');
      codes.delete(p.get("code"));
      return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ access_token: "wizard-token", token_type: "bearer", expires_in: 3600, refresh_token: "r" }));
    }
    if (u.pathname === "/auth/v1/logout" && req.method === "POST") {
      if (!req.headers.apikey) return res.writeHead(401, { "content-type": "application/json" }).end('{"message":"No API key found in request"}');
      logouts.push(req.headers.authorization);
      // Supabase ends every session of the user unless scope=local (or others) is given; record what was asked.
      logoutScopes.push(u.searchParams.get("scope"));
      if (logoutStatus !== 204) return res.writeHead(logoutStatus, { "content-type": "application/json" }).end('{"error":"logout failed"}');
      return res.writeHead(204).end();
    }
    res.writeHead(404).end();
  });
  const url = await listen(server);
  return { url, close: () => closeServer(server), tokenRequests, logouts, logoutScopes };
}

// Stand-in for the gateway's /v1/wizard API. `keyValue` lets a test simulate the dashboard returning a key value in
// an unexpected shape (the wizard must validate a key before using it). The key object carries its scope, as the
// gateway's does ("fetch" for every wizard key); `keyScope` lets a test simulate a gateway that gives another one (null: none named).
export async function startFakeGateway(state = { sites: [], keys: [] }, { keyValue = "sk_parlox_" + "d".repeat(64), keyScope = "fetch" } = {}) {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    const raw = await body(req);
    calls.push({ method: req.method, path: req.url, body: raw ? JSON.parse(raw) : null });
    const json = (status, v) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(v));
    if (req.headers.authorization !== "Bearer wizard-token") return json(401, { error: "Sign in required" });
    if (req.method === "GET" && req.url === "/v1/wizard/sites") return json(200, { sites: state.sites });
    if (req.method === "POST" && req.url === "/v1/wizard/sites") {
      const b = JSON.parse(raw);
      const site = { id: "33333333-3333-3333-3333-333333333333", name: b.name, domain: b.domain, public_key: "pk_" + "c3".repeat(12), verified: false };
      state.sites.push(site);
      return json(201, { site });
    }
    let m = req.url.match(/^\/v1\/wizard\/sites\/([^/]+)\/keys$/);
    if (m && req.method === "POST") { state.keys.push(JSON.parse(raw).name); return json(201, { value: keyValue, key: { id: "k1", name: `wizard · ${JSON.parse(raw).name}`, prefix: "dddddddd", ...(keyScope === null ? {} : { scope: keyScope }) } }); }
    m = req.url.match(/^\/v1\/wizard\/sites\/([^/]+)\/verify-token$/);
    if (m) { const s = state.sites.find((x) => x.id === m[1]); return s ? json(200, { verify_token: "vt_fake", domain: s.domain, public_key: s.public_key }) : json(404, { error: "Site not found" }); }
    json(404, { error: "not found" });
  });
  return { url: await listen(server), close: () => closeServer(server), calls, state };
}
