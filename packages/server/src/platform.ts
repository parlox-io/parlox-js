// What the platform offers for work that must outlive the response. Read at request time and never cached: Vercel's
// request context exists only inside a request.

export type WaitUntil = (promise: Promise<unknown>) => void;

/**
 * Vercel's waitUntil for the current request, read the way @vercel/functions (getContext) and Sentry's core read it:
 * from the request context Vercel's runtime keeps under Symbol.for("@vercel/request-context"). Undefined outside
 * Vercel, or outside a request.
 */
export function vercelWaitUntil(): WaitUntil | undefined {
  try {
    const holder = (globalThis as unknown as Record<symbol, { get?: () => { waitUntil?: WaitUntil } | undefined } | undefined>)[Symbol.for("@vercel/request-context")];
    const ctx = holder?.get?.();
    const waitUntil = ctx?.waitUntil;
    return typeof waitUntil === "function" ? (promise) => waitUntil.call(ctx, promise) : undefined;
  } catch { return undefined; }
}

interface DenoLike {
  env?: { get?(name: string): string | undefined };
  permissions?: { querySync?(descriptor: { name: "env"; variable: string }): { state?: unknown } };
}

/**
 * An environment variable, trimmed; undefined when unset or blank. Read from process.env where the runtime has it,
 * else from Deno.env. Never throws.
 *
 * On Deno, reading a variable without permission shows a permission prompt in a terminal (and throws elsewhere), and
 * Deno 2's global process.env is guarded the same way. So on Deno the variable is read only when
 * Deno.permissions.querySync({ name: "env", variable }) answers "granted" (--allow-env, or --allow-env naming it;
 * Deno Deploy runs with every permission). Any other answer, or no such query, counts as not set: the key is then not
 * found and nothing is reported, and the platform checks below find no platform, so reports are queued.
 */
export function env(name: string): string | undefined {
  try {
    const g = globalThis as { process?: { env?: Record<string, string | undefined> }; Deno?: DenoLike };
    if (g.Deno && !denoMayRead(g.Deno, name)) return undefined;
    const v = g.process?.env?.[name] ?? g.Deno?.env?.get?.(name);
    return v && v.trim() ? v.trim() : undefined;
  } catch { return undefined; }
}

function denoMayRead(deno: DenoLike, variable: string): boolean {
  try { return deno.permissions?.querySync?.({ name: "env", variable })?.state === "granted"; } catch { return false; }
}

/**
 * AWS Lambda freezes the process once the handler returns and offers no waitUntil, so a timer set for later may never
 * run there: "Lambda freezes the execution environment when the runtime and each extension have completed and there
 * are no pending events" (docs.aws.amazon.com/lambda/latest/dg/lambda-runtime-environment.html). Lambda defines
 * AWS_LAMBDA_FUNCTION_NAME, "The name of the function" (docs.aws.amazon.com/lambda/latest/dg/configuration-envvars.html).
 *
 * Sending at once does not get a report out before the freeze: its request starts only after an asynchronous one-way
 * hash, so after the handler has returned. "Background processes or callbacks that were initiated by your Lambda
 * function and did not complete when the function ended resume if Lambda reuses the execution environment" (the page
 * above), so the report is usually delayed to the next invocation of the same warm instance, and lost when the instance
 * is frozen and then recycled ("Lambda terminates execution environments every few hours", the same page).
 */
export function isLambda(): boolean {
  return !!env("AWS_LAMBDA_FUNCTION_NAME");
}

/**
 * Whether the platform may stop or freeze this code soon after a response, so a report left for a later timer could
 * be lost: then each report is sent at once instead of queued. Detected only by signals the platforms' own
 * documentation defines; anywhere else (a long-running server) reports are queued.
 *
 * - AWS Lambda: see isLambda.
 * - Cloudflare Workers: "An async call that is neither awaited nor passed to ctx.waitUntil() can be canceled when the
 *   invocation ends" (developers.cloudflare.com/workers/runtime-apis/context/). navigator.userAgent is
 *   "Cloudflare-Workers", "to reliably determine that code is running within the Workers environment"
 *   (developers.cloudflare.com/workers/runtime-apis/web-standards/), by default since the 2022-03-21 compatibility
 *   date (developers.cloudflare.com/workers/configuration/compatibility-flags/#global-navigator).
 * - Deno Deploy: an application is stopped once it has received no request for "between 5 seconds and 10 minutes",
 *   and then "has 5 seconds to shut down gracefully" (docs.deno.com/deploy/reference/runtime/), which can come before
 *   the queue's 10-second interval. DENO_DEPLOYMENT_ID is one of its "predefined environment variables in all
 *   contexts" (docs.deno.com/deploy/reference/env_vars_and_contexts/).
 * - Azure Functions: tasks a function starts "must complete before your function code returns. Because Functions
 *   doesn't track these background threads, site shutdown can occur regardless of background thread status"
 *   (learn.microsoft.com/azure/azure-functions/performance-reliability). FUNCTIONS_WORKER_RUNTIME is the app setting
 *   naming "the language or language stack of the worker runtime" (learn.microsoft.com/azure/azure-functions/
 *   functions-app-settings). The Flex Consumption plan deprecates that setting, so there it may be absent (not checked).
 */
export function stopsAfterResponse(): boolean {
  return isLambda() || !!env("DENO_DEPLOYMENT_ID") || !!env("FUNCTIONS_WORKER_RUNTIME") || isCloudflareWorkers();
}

/** Cloudflare Workers (and Pages Functions, the same runtime): navigator.userAgent is "Cloudflare-Workers" (see
 * stopsAfterResponse for the source). Self-hosted workerd answers the same, so this tells how the runtime treats work
 * left after a response, never which headers Cloudflare set (receivedByCloudflare does). Never throws. */
export function isCloudflareWorkers(): boolean {
  try { return (globalThis as { navigator?: { userAgent?: unknown } }).navigator?.userAgent === "Cloudflare-Workers"; }
  catch { return false; }
}

/**
 * Whether `request` came through Cloudflare's own network: Cloudflare's runtime gives each incoming request a `cf`
 * object, "an object containing properties about the incoming request provided by Cloudflare's global network"
 * (developers.cloudflare.com/workers/runtime-apis/request/, opened 2026-10-02). Self-hosted workerd leaves it
 * `undefined` on receipt unless its config names a cfBlobHeader to parse it from (workerd.capnp, cfBlobHeader), and
 * other runtimes have none. Never throws.
 */
export function receivedByCloudflare(request: unknown): boolean {
  try {
    const cf = (request as { cf?: unknown } | null | undefined)?.cf;
    return typeof cf === "object" && cf !== null;
  } catch { return false; }
}
