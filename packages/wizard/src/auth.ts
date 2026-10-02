import http from "node:http";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export class SignInError extends Error {
  constructor(readonly code: "ports-busy" | "denied" | "timeout" | "exchange", message: string) { super(message); }
}

export function pkcePair() {
  const verifier = randomBytes(48).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

/** How long the wizard waits for the browser approval before giving up (signing in may include creating an account). */
export const SIGN_IN_TIMEOUT_MS = 5 * 60_000;

const PAGE = (msg: string) => `<!doctype html><meta charset="utf-8"><title>Parlox</title><body style="font:16px system-ui;margin:3rem">${msg}</body>`;

async function listenOnFirstFree(ports: number[], handler: http.RequestListener): Promise<{ server: http.Server; port: number }> {
  for (const port of ports) {
    const server = http.createServer(handler);
    const ok = await new Promise<boolean>((resolve) => {
      server.once("error", () => resolve(false));
      server.listen(port, "127.0.0.1", () => resolve(true));
    });
    if (ok) return { server, port };
  }
  throw new SignInError("ports-busy", `Ports ${ports.join(", ")} on this computer are all in use. Close the program using them and run the wizard again.`);
}

/** Whether `given` is `expected`, compared in constant time (a length mismatch is simply no match). */
function sameToken(given: string | null, expected: string): boolean {
  if (given === null) return false;
  const a = Buffer.from(given), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** OAuth 2.1 authorization code with PKCE, redirected to a loopback address (RFC 8252). Returns the access token.
 * `onListening` is given a short link to copy when the browser did not open: the listener's own root with a token
 * made for this run (`http://127.0.0.1:<port>/?t=<token>`, as rclone's loopback link), which redirects to the
 * authorize URL (a full one is several hundred characters, and a terminal that breaks it across lines makes it
 * impossible to copy). The browser itself is opened with the full URL. */
export async function signIn(opts: { supabaseUrl: string; clientId: string; apiKey: string; ports: number[]; open(url: string): void; timeoutMs?: number; onListening?(url: string): void }): Promise<string> {
  const { verifier, challenge } = pkcePair();
  const state = randomBytes(24).toString("base64url");
  let settle!: (v: { code?: string; error?: SignInError }) => void;
  const result = new Promise<{ code?: string; error?: SignInError }>((r) => (settle = r));
  // The short link's target and token. Both are cleared once the callback has come: the link is then of no use.
  let authorizeUrl: string | null = null;
  let linkToken: string | null = randomBytes(16).toString("base64url");

  const { server, port } = await listenOnFirstFree(opts.ports, (req, res) => {
    const u = new URL(req.url ?? "/", "http://127.0.0.1");
    // The short link. Its target is this run's own authorize URL, fixed before the link is shown and never taken
    // from the request; it answers only until the callback comes, with no page and nothing of the request echoed.
    // The URL carries this run's state and PKCE challenge, so it goes only to a request that holds the link's
    // token and is addressed to this listener by its own address: a web page that points its own domain at
    // 127.0.0.1 (DNS rebinding) could otherwise read it, and use the two to hand the wizard a sign-in to another
    // account. Anything else is answered as an unknown path, so nothing tells that a sign-in is waiting.
    if (u.pathname === "/") {
      if (!authorizeUrl || !linkToken || req.headers.host !== `127.0.0.1:${port}` || !sameToken(u.searchParams.get("t"), linkToken)) { res.writeHead(404).end(); return; }
      if (req.method !== "GET") { res.writeHead(405).end(); return; }
      res.writeHead(302, { location: authorizeUrl, "cache-control": "no-store", "referrer-policy": "no-referrer" }).end();
      return;
    }
    if (u.pathname !== "/callback") { res.writeHead(404).end(); return; }
    if (req.method !== "GET") { res.writeHead(405).end(); return; }
    // Any web page can send a request here; only the answer carrying this run's state counts, anything else is
    // refused and the wizard keeps waiting.
    if (u.searchParams.get("state") !== state) { res.writeHead(400, { "content-type": "text/plain" }).end("Not for this wizard run."); return; }
    // The exchange for the access token has not happened yet at this point, only the browser hop has — so the
    // page must not claim the wizard is signed in. Settling waits for the response to actually finish writing,
    // so the loopback server is never closed out from under a response the browser is still reading.
    const done = (msg: string, outcome: { code?: string; error?: SignInError }) => {
      authorizeUrl = linkToken = null;
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(PAGE(msg));
      res.on("finish", () => settle(outcome));
    };
    if (u.searchParams.get("error")) return done("Access was not granted. You can close this tab.", { error: new SignInError("denied", "Access was denied in the browser.") });
    const code = u.searchParams.get("code");
    if (!code) return done("No code received. Return to the terminal.", { error: new SignInError("exchange", "No authorization code was returned.") });
    done("Return to the terminal to finish signing in. You can close this tab.", { code });
  });
  const redirectUri = `http://127.0.0.1:${port}/callback`;
  const timer = setTimeout(() => settle({ error: new SignInError("timeout", "Sign-in was not completed in time. Run the wizard again.") }), opts.timeoutMs ?? SIGN_IN_TIMEOUT_MS);

  try {
    const authorize = new URL(`${opts.supabaseUrl}/auth/v1/oauth/authorize`);
    authorize.search = new URLSearchParams({ response_type: "code", client_id: opts.clientId, redirect_uri: redirectUri, state, code_challenge: challenge, code_challenge_method: "S256" }).toString();
    authorizeUrl = authorize.toString();
    opts.onListening?.(`http://127.0.0.1:${port}/?t=${linkToken}`);
    opts.open(authorizeUrl);
    const outcome = await result;
    if (outcome.error) throw outcome.error;
    const res = await fetch(`${opts.supabaseUrl}/auth/v1/oauth/token`, {
      method: "POST",
      // Supabase's API gateway in front of /auth/v1/* requires the project's apikey header on every call,
      // this one included; harmless here, and robust if the gateway ever starts enforcing it more strictly.
      headers: { "content-type": "application/x-www-form-urlencoded", apikey: opts.apiKey },
      body: new URLSearchParams({ grant_type: "authorization_code", code: outcome.code!, client_id: opts.clientId, redirect_uri: redirectUri, code_verifier: verifier }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json().catch(() => ({}))) as { access_token?: string };
    if (!res.ok || !body.access_token) throw new SignInError("exchange", `Could not complete sign-in (${res.status}).`);
    return body.access_token;
  } finally {
    clearTimeout(timer);
    server.closeAllConnections?.();
    server.close();
  }
}

/**
 * Ends this sign-in's session (and its refresh token) when the wizard is done. Never throws; returns whether it
 * worked. scope=local ends only this session: without it Supabase signs the user out of every session, the
 * dashboard in their browser included.
 */
export async function signOut(supabaseUrl: string, apiKey: string, token: string): Promise<boolean> {
  try {
    const res = await fetch(`${supabaseUrl}/auth/v1/logout?scope=local`, { method: "POST", headers: { authorization: `Bearer ${token}`, apikey: apiKey }, signal: AbortSignal.timeout(10_000) });
    return res.ok;
  } catch {
    return false;
  }
}
