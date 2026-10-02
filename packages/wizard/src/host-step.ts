import type { AppUnit } from "./apps.js";
import { ApiError, KeyScopeError, KeysStopped, SECRET_KEY_RE, type GatewayClient } from "./api.js";
import type { Args } from "./args.js";
import type { CliDeps } from "./deps.js";
import { handoffUrl, keyHostName, type Host } from "./hosts.js";
import { integrationOf } from "./integrations/registry.js";
import type { RunNames } from "./names.js";
import { halt, Stopped } from "./stop.js";
import { scrub } from "./ui/scrub.js";
import type { Handoff, Ui } from "./ui/types.js";
import { addVercelEnv, varIn, vercelEnvList, vercelHasSecretVisibility, vercelProject } from "./vercel.js";

// The host step: PARLOX_SECRET_KEY and PARLOX_VERIFY_TOKEN on each app's production host. On a linked Vercel project
// the wizard sets them itself (with the person's Yes, or --vercel); elsewhere it hands off what to set by hand.

// What every early end after the install's files were written says (a stop, a cancelled question, a question with no
// terminal, an error): the host step has not run. The hand-off follows it.
export const HOST_NOT_CONNECTED = "Stopped before your host was connected. Your files were changed and stay changed; set the variables by hand (below), or run the wizard again to connect the host (it finds the changes already made).";

export interface HostCtx {
  /** Creates the keys: the run's RunKeys, so that a gateway of another version gets asked for one key only. */
  api: Pick<GatewayClient, "createKey">; siteId: string; verifyToken: string; dashboard: string;
  args: Pick<Args, "yes" | "vercel" | "noVercel" | "noBrowser">; deps: Pick<CliDeps, "run" | "open" | "signal">; ui: Ui; names: RunNames;
  /** Whether the Vercel CLI takes `--visibility secret`: asked once per run, the first time a key is stored. */
  secretVisibility?: Promise<boolean>;
}
/** One app's host step: which variables are set, and whether the step ran to its end (its hand-off, if any, shown).
 * `secretStored`: how this run stored PARLOX_SECRET_KEY on Vercel; `secretAlreadySet`: it was there already, a key the
 * wizard cannot see. */
export interface HostState { secretDone: boolean; tokenDone: boolean; finished: boolean; secretStored?: "secret" | "sensitive"; secretAlreadySet?: boolean }

/** What is still to set on the host, listing only the variables not already set (the secret succeeding, say, while
 * the token add fails names only the token). The secret key is created in the dashboard, never here: the link opens
 * the key form with its name filled in, and the dashboard shows the key once, for pasting into the host. In a run
 * with several apps the host line and the key name say which app it is for. */
export function handoffOf(c: Pick<HostCtx, "dashboard" | "siteId" | "verifyToken" | "names">, u: AppUnit, host: Host, state: HostState): Handoff {
  // What the app's own integration says about setting them on this host (a Worker's key is a runtime secret).
  const notes = u.server ? integrationOf(u.server).handoffNotes?.(u.server, host) ?? [] : [];
  return {
    host: c.names.host(u, host.label),
    url: state.secretDone ? null : handoffUrl(c.dashboard, c.siteId, host, c.names.key(u, keyHostName(host))),
    where: host.where,
    docs: host.docs,
    variables: [...(state.secretDone ? [] : ["PARLOX_SECRET_KEY (from the dashboard key, shown once)"]), ...(state.tokenDone ? [] : [`PARLOX_VERIFY_TOKEN=${c.verifyToken}`])],
    ...(notes.length && !state.secretDone ? { notes } : {}),
  };
}

/** The host step for one app with a server part: the Vercel automation when the app is linked and the person agrees,
 * then the hand-off for whatever is still to set. A key the gateway refuses for this app (its key limit, its rate
 * limit) is a warning and a hand-off for this app, not the end of the run. */
export async function connectHost(c: HostCtx, u: AppUnit, host: Host, state: HostState): Promise<void> {
  const { args, deps, ui, names } = c;
  // A stop after the previous app's host step: nothing more is asked or run.
  halt(deps.signal);
  const keyName = names.key(u, "Vercel");
  const where = names.app(u);
  // The Vercel CLI runs where the project is linked: the app folder, or the workspace root of a monorepo. A link at
  // the root may belong to another app of the monorepo, so it is never used without the person's own Yes: the
  // question is asked even with --vercel, and an unattended run (--yes --vercel, where nobody is asked) leaves it
  // alone and hands off instead.
  const vercelDir = host.vercelDir;
  const linkedAtRoot = vercelDir !== null && vercelDir !== u.dir;
  const unattended = args.yes && args.vercel;
  if (linkedAtRoot && unattended && !args.noVercel) {
    ui.info(`A Vercel project link was found at the workspace root, not in ${where}; it may belong to another app, so --yes --vercel does not set variables there. Set them by hand (below), or run again without --yes to be asked.`);
  }
  const project = args.noVercel || !vercelDir || (linkedAtRoot && unattended) ? null : await vercelProject(vercelDir, deps.run);
  halt(deps.signal);
  const rootNote = linkedAtRoot ? ` It is linked at the workspace root, not in ${where}.` : "";
  if (vercelDir && project && ((args.vercel && !linkedAtRoot) || (await ui.confirm(`Set PARLOX_SECRET_KEY and PARLOX_VERIFY_TOKEN on the Vercel project "${project.name}" (production)${names.forApp(u)}?${rootNote}`, "Pass --vercel or --no-vercel.")))) {
    // Listed once, before anything is added: adding the secret key does not change whether the token is there.
    const listing = await vercelEnvList(vercelDir, deps.run);
    const secretState = varIn(listing, "PARLOX_SECRET_KEY");
    let secretLabel: string;
    if (secretState === "yes") {
      ui.info(`PARLOX_SECRET_KEY is already set on "${project.name}"; no new key was created.`);
      state.secretDone = true;
      state.secretAlreadySet = true;
      // Its type and its access are not visible to the wizard: it says only that it was there.
      secretLabel = "PARLOX_SECRET_KEY already set (not created by this run)";
    } else if (secretState === "unknown") {
      // `vercel env ls` itself failed: we cannot tell whether a key already exists there. Creating one anyway risks
      // an orphaned key (created in the dashboard, never confirmed stored on the host).
      ui.warn(`Could not read "${project.name}"'s Vercel environment variables; not creating a key, to avoid creating one that never gets stored. Set PARLOX_SECRET_KEY by hand from a key you create in the dashboard (Settings → Keys, shown once).`);
      secretLabel = "PARLOX_SECRET_KEY not checked";
    } else {
      halt(deps.signal);
      // Stored as a Secret where the CLI has the type, else as sensitive (which Vercel treats as a Secret too); asked
      // before the key exists, so a stop here leaves no key behind.
      const visibility = await (c.secretVisibility ??= vercelHasSecretVisibility(vercelDir, deps.run));
      halt(deps.signal);
      let secret: string | null = null;
      try { secret = await c.api.createKey(c.siteId, keyName); }
      catch (err) {
        // The gateway answered with an error (its 20-key limit, its rate limit): no key was created. Anything else (no
        // answer in time, say) leaves it unknown whether the key was created, and the warning says what to check.
        const why = scrub(err instanceof Error ? err.message : String(err));
        // A key created with more access than crawler reports: it exists, unused, and the developer revokes it.
        if (err instanceof KeyScopeError) ui.warn(`${why} Set PARLOX_SECRET_KEY by hand (below), from a key created with that access.`);
        // No key was asked for (an earlier one came back with other access): said once in the run; the hand-off follows.
        else if (err instanceof KeysStopped) { if (err.first) ui.warn(why); }
        else ui.warn(err instanceof ApiError
          ? `Could not create a key${names.forApp(u)} (${why}); nothing was set on Vercel for it. Set PARLOX_SECRET_KEY by hand (below).`
          : `Could not create a key${names.forApp(u)} (${why}). It may have been created all the same: if "wizard · ${keyName}" is in Settings → Keys, revoke it. Set PARLOX_SECRET_KEY by hand (below).`);
      }
      if (secret === null) secretLabel = "PARLOX_SECRET_KEY not set (see above)";
      else {
        if (deps.signal?.aborted) {
          ui.warn(`The key "wizard · ${keyName}" was created, but the wizard was stopped before storing it on Vercel; revoke it in the dashboard (Settings → Keys).`);
          throw new Stopped();
        }
        if (!SECRET_KEY_RE.test(secret)) {
          ui.warn(`The dashboard returned a key in an unexpected form; refusing to use it (its value is not shown). It was created, though: revoke "wizard · ${keyName}" in the dashboard (Settings → Keys), then create a key there by hand and set it as PARLOX_SECRET_KEY.`);
          secretLabel = "PARLOX_SECRET_KEY not set (see above)";
        } else {
          const r = await addVercelEnv(vercelDir, "PARLOX_SECRET_KEY", secret, visibility ? "visibility" : true, deps.run);
          if (r.ok) {
            state.secretDone = true;
            state.secretStored = visibility ? "secret" : "sensitive";
            secretLabel = visibility ? "PARLOX_SECRET_KEY set (Secret: no one on the team can read it back)" : "PARLOX_SECRET_KEY set (sensitive)";
          }
          else {
            ui.warn(`${r.message}\nThe key "wizard · ${keyName}" was created but not stored; revoke it in the dashboard (Settings → Keys).`);
            secretLabel = "PARLOX_SECRET_KEY not set (see above)";
          }
        }
      }
    }

    halt(deps.signal);
    const tokenState = varIn(listing, "PARLOX_VERIFY_TOKEN");
    let tokenLabel: string;
    if (tokenState === "yes") { state.tokenDone = true; tokenLabel = "PARLOX_VERIFY_TOKEN already set"; }
    else if (tokenState === "unknown") {
      ui.warn(`Could not read "${project.name}"'s Vercel environment variables; set PARLOX_VERIFY_TOKEN by hand: PARLOX_VERIFY_TOKEN=${c.verifyToken}`);
      tokenLabel = "PARLOX_VERIFY_TOKEN not checked";
    } else {
      halt(deps.signal);
      const r = await addVercelEnv(vercelDir, "PARLOX_VERIFY_TOKEN", c.verifyToken, false, deps.run);
      if (r.ok) { state.tokenDone = true; tokenLabel = "PARLOX_VERIFY_TOKEN set"; }
      else {
        ui.warn(`${r.message}\nSet it by hand: PARLOX_VERIFY_TOKEN=${c.verifyToken}`);
        tokenLabel = "PARLOX_VERIFY_TOKEN not set (see above)";
      }
    }

    ui.info(`Vercel "${project.name}": ${secretLabel}, ${tokenLabel}.`);
  }
  // One hand-off for whatever is still to do by hand, including when Vercel was skipped or is not the host. The
  // browser opens the key form only in an interactive run.
  if (!state.secretDone || !state.tokenDone) {
    const h = handoffOf(c, u, host, state);
    halt(deps.signal);
    if (h.url && !args.yes && !args.noBrowser) deps.open(h.url);
    ui.handoff(h);
  }
  state.finished = true;
}
