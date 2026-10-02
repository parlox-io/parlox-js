/** The run was stopped (deps.signal: a confirmed quit, Ctrl+C, SIGTERM): not an error. Its step ends "skipped" and
 * the exit code is 130. */
export class Stopped extends Error {}

/**
 * A stop takes effect at the flow's next step and before each of its side effects (creating a site or a key, writing
 * files, installing, opening the browser, setting host variables, the local check): before the review is approved
 * nothing is changed, and after it nothing more. Requests already sent are not aborted: a POST cut off midway may
 * still have taken effect, and the outcome would be unknown; each has its own time limit. Signing out still runs
 * (main's `finally`): it is cleanup, not a change.
 */
export function halt(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Stopped();
}
