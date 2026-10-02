// New keys have this exact shape; keys issued before the sk_parlox_ prefix existed keep
// working as plain sk_ + 64 hex, but the dashboard's /keys endpoint only ever issues fresh keys, so a freshly
// created key not matching this is a sign something is wrong upstream — better to refuse it than store it.
export const SECRET_KEY_RE = /^sk_(parlox_)?[0-9a-f]{64}$/;

export class ApiError extends Error { constructor(message: string, readonly status: number) { super(message); } }

/** A key the gateway created with access other than "Crawler reports only" (scope "fetch"), or with no scope named (a
 * gateway from before scopes): the wizard never uses it. `keyName` is the key as the dashboard lists it, to revoke. The
 * key's value is not in the message. */
export class KeyScopeError extends Error {
  constructor(readonly keyName: string, scope: unknown) {
    const named = typeof scope === "string" && /^[a-z_-]{1,20}$/.test(scope) ? `its access is "${scope}"` : "the gateway did not say what it may send";
    super(`The gateway created the key "${keyName}", but ${named}, not "Crawler reports only", so the wizard did not use it. Revoke "${keyName}" in Settings → Keys: a key the wizard sets must be "Crawler reports only".`);
  }
}
/** A key the run did not ask the gateway for, because it already answered one of this run's keys with other access
 * (KeyScopeError): a gateway that answers one key that way is not the version this wizard needs, and would answer every
 * key the same way. `first`: the first key withheld this way, where the run says so (once). */
export class KeysStopped extends Error {
  constructor(readonly refused: KeyScopeError, readonly first: boolean) {
    super(`No more keys were created in this run: the gateway answered "${refused.keyName}" with access other than "Crawler reports only", so it is not the version this wizard needs, and it would answer every key the same way. Set PARLOX_SECRET_KEY by hand where each app needs it, from a key created in Settings → Keys with access "Crawler reports only" (each app's hand-off says where on its host).`);
  }
}

/** The run's key maker: every key goes through it (the local keys, then each app's host key). After a KeyScopeError no
 * other key is asked for (KeysStopped): only the one key the developer revokes was created. */
export class RunKeys {
  private refused: KeyScopeError | null = null;
  private told = false;
  constructor(private api: Pick<GatewayClient, "createKey">) {}
  async createKey(siteId: string, name: string): Promise<string> {
    if (this.refused) { const first = !this.told; this.told = true; throw new KeysStopped(this.refused, first); }
    try { return await this.api.createKey(siteId, name); }
    catch (err) { if (err instanceof KeyScopeError) this.refused = err; throw err; }
  }
}
export interface WizardSite { id: string; name: string; domain: string; public_key: string; verified: boolean }

export class GatewayClient {
  constructor(private base: string, private token: string) {}
  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.token}`, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) throw new ApiError(typeof json.error === "string" ? json.error : `The gateway answered ${res.status}.`, res.status);
    return json as T;
  }
  async listSites() { return (await this.call<{ sites: WizardSite[] }>("GET", "/v1/wizard/sites")).sites; }
  async createSite(name: string, domain: string) { return (await this.call<{ site: WizardSite }>("POST", "/v1/wizard/sites", { name, domain })).site; }
  /** A new key's value. The gateway gives every wizard key the scope "fetch" (crawler reports only, never orders or
   * reads); a key it answers with any other scope, or none, is refused here (KeyScopeError), before anything uses it. */
  async createKey(siteId: string, name: string) {
    const created = await this.call<{ value: string; key?: { scope?: unknown } }>("POST", `/v1/wizard/sites/${encodeURIComponent(siteId)}/keys`, { name });
    if (created.key?.scope !== "fetch") throw new KeyScopeError(`wizard · ${name}`, created.key?.scope);
    return created.value;
  }
  verifyToken(siteId: string) { return this.call<{ verify_token: string; domain: string; public_key: string }>("GET", `/v1/wizard/sites/${encodeURIComponent(siteId)}/verify-token`); }
}
