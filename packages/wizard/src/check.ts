// Asks the developer's running app for the ownership answer. A correct answer proves the server part is wired in and
// the verify token is loaded. Nothing is sent to Parlox, so no test data appears in the dashboard.
export async function checkLocal(baseUrl: string, token: string): Promise<{ ok: boolean; detail: string }> {
  let url: URL;
  try { url = new URL("/.well-known/parlox-verify", baseUrl); } catch { return { ok: false, detail: `${baseUrl} is not a URL.` }; }
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) return { ok: false, detail: "The local check only runs against localhost." };
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000), redirect: "manual" });
    const body = (await res.text()).trim();
    if (res.ok && body === token) return { ok: true, detail: "The server part answered the ownership check." };
    if (res.status === 404) return { ok: false, detail: "The app answered 404: the middleware did not run for /.well-known/parlox-verify (check its matcher), or PARLOX_VERIFY_TOKEN is not loaded (restart the dev server)." };
    return { ok: false, detail: `The app answered ${res.status} with a different body.` };
  } catch {
    return { ok: false, detail: `Could not reach ${url.origin}. Is the dev server running?` };
  }
}
