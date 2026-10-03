export interface WizardConfig { gateway: string; supabaseUrl: string; clientId: string; apiKey: string; ports: number[]; dashboard: string }

// Public values, compiled in: the gateway, the Supabase project URL, the wizard's OAuth client id (a public
// client has no secret), and Supabase's anon/publishable key. There are no environment overrides, so nothing in a
// shell profile can send the sign-in or a key elsewhere. Tests pass their own WizardConfig to main().
export const PRODUCTION: WizardConfig = {
  gateway: "https://gateway.parlox.io",
  supabaseUrl: "https://oijlltuyaibjimksyeoh.supabase.co",
  clientId: "64699d97-1618-4291-bb19-82624285bbe0",
  // Supabase's public (publishable) key: not a secret, safe to ship, and required by Supabase's own API
  // gateway on every /auth/v1/* call (the token exchange and logout included).
  apiKey: "sb_publishable_E97p_dRldy6mZpxqFWRwrg_cOx-1kks",
  ports: [53682, 53683, 53684, 53685],
  // The merchant dashboard, where the production key is created and shown once (the hand-off link opens it).
  dashboard: "https://app.parlox.io",
};
