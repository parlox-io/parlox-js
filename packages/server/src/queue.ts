// The delivery queue for long-running servers (Express, Hono on Node or Bun). Reports go in batches, one request at a
// time, and the queue has a hard size: a crawler flood, or an attacker sending bot user agents, costs the merchant's
// server one outbound request at a time instead of one per incoming request.
//
// The bounds follow PostHog's and Segment's Node SDKs: a batch at 20 events or every 10 seconds, at most 100 events per
// request, at most 1000 waiting, the oldest dropped when full. A batch also closes before its request body would pass
// 200,000 bytes, so it stays under the gateway's 256 KB limit whatever the events hold. While a request is in flight,
// new events wait: after it, the next batch goes at once only if a full one waits (or a flush waits for it), else on
// the interval, so a steady trickle still travels in batches.
//
// A batch is sent again only when the gateway provably stored none of it, so a retry can never store a report twice:
// it answered 429 (its rate limiter refuses before anything is stored), or the connection never reached it (refused,
// or the name did not resolve). Then up to 3 more attempts, 3 seconds apart or after the gateway's Retry-After (at
// most 60 seconds), as PostHog's core retries. Any other failure (a timeout, a 5xx, a reset connection, a refused key)
// is not retried, because the gateway may have stored the batch: its reports are counted as delivery not confirmed.
//
// The dropped count (reports dropped because the queue was full, or whose delivery was not confirmed) travels with
// the next batch (meta.dropped), so Parlox records the gap instead of hiding it. The instance's reports sent at once
// share it (core.ts): those over their bound are added to it, and the next one sent carries it. The queue's timers
// never keep a process alive, except while the app awaits flush(), which keeps it running until done or its own bound.

export interface QueueOptions {
  /** Send once this many events wait. */
  flushAt: number;
  /** Send what waits at least this often, in milliseconds. */
  flushIntervalMs: number;
  /** Events per request, at most. */
  maxBatchSize: number;
  /** Bytes per request body, at most. An event larger than that on its own is sent alone. */
  maxBatchBytes: number;
  /** Events kept waiting; when full, the oldest is dropped and counted. */
  maxQueueSize: number;
  /** Further attempts for a batch the gateway provably did not store. */
  retryCount: number;
  /** Milliseconds between attempts, when the gateway names no Retry-After. */
  retryDelayMs: number;
}

/** What one attempt to send a batch came to. */
export interface SendOutcome {
  /** Parlox accepted the batch. */
  ok: boolean;
  /** Parlox provably stored none of it (it answered 429, or the connection never reached it): it may be sent again. */
  retryable: boolean;
  /** How long the gateway asked to wait before the next attempt (Retry-After), in milliseconds. */
  retryAfterMs?: number;
}
/** Sends one batch: the request body, already written as JSON, {"events":[...]} with "meta" when it carries a count. */
export type BatchSender = (body: string) => Promise<SendOutcome>;

/** The most the gateway accepts in one request's meta.dropped; any more waits for the next batch. */
export const MAX_DROPPED_PER_BATCH = 1_000_000;
/** The largest request body a batch makes, in bytes (the gateway accepts 256 KB). */
export const MAX_BATCH_BYTES = 200_000;
/** The longest wait before a retry, whatever Retry-After asks. */
export const MAX_RETRY_WAIT_MS = 60_000;
/** How long flush() works before it gives up, by default. */
export const FLUSH_TIMEOUT_MS = 30_000;
/** The longest delay a timer takes (beyond it, setTimeout fires at once). */
export const MAX_TIMER_MS = 2_147_483_647;

interface Registry { queues: Set<DeliveryQueue>; exitHooked: boolean }
// Shared by every copy of this package loaded in the process (the ES module and CommonJS builds, each entry point), so
// one flush() and one beforeExit listener reach every queue. Only queues with something to send are listed (a dropped
// count alone waits for the next batch).
const REGISTRY = Symbol.for("@parlox/server/delivery-queues");
function registry(): Registry {
  const g = globalThis as unknown as Record<symbol, Registry | undefined>;
  return (g[REGISTRY] ??= { queues: new Set(), exitHooked: false });
}

/** Sends what is queued so far anywhere in this process, giving up after timeoutMs. Keeps the process running until
 * done or that bound. Never rejects. */
export function flushAll(timeoutMs: number = FLUSH_TIMEOUT_MS): Promise<void> {
  return flushEvery(timeoutMs, true);
}

async function flushEvery(timeoutMs: number, keepAlive: boolean): Promise<void> {
  await Promise.all([...registry().queues].map((q) => q.flush(timeoutMs, keepAlive)));
}

// A best-effort flush when the process is about to end on its own (its event loop is empty). It keeps nothing alive: a
// retry it would wait for is given up when the process ends. beforeExit does not fire on process.exit() or on a signal:
// a library must not install signal handlers (they change how a process exits), so an app that stops on a signal
// awaits flush() itself, as PostHog's shutdown() is called.
function hookExit(r: Registry): void {
  if (r.exitHooked) return;
  const p = (globalThis as { process?: { on?: (event: string, listener: () => void) => unknown } }).process;
  if (typeof p?.on !== "function") return;
  r.exitHooked = true;
  p.on("beforeExit", () => { void flushEvery(FLUSH_TIMEOUT_MS, false); });
}

// Not a reason for the process to stay alive. Node's and Bun's timers have unref(); Deno's setTimeout returns a number,
// which Deno.unrefTimer(id) unrefs ("Make the timer of the given id not block the event loop from finishing",
// docs.deno.com/api/deno/~/Deno.unrefTimer).
function unref(timer: ReturnType<typeof setTimeout>): void {
  try {
    if (typeof timer === "number") (globalThis as { Deno?: { unrefTimer?(id: number): void } }).Deno?.unrefTimer?.(timer);
    else (timer as { unref?: () => void }).unref?.();
  } catch { /* the timer stays as it is */ }
}

const encoder = new TextEncoder();
const utf8Bytes = (text: string) => encoder.encode(text).byteLength;

// One flush() call: it waits for the events that entered the queue before it (ordinals up to `through`, known once
// the events still being prepared at the call have entered), and gives up at `at`. `keepAlive`: the app awaits it.
interface Flush { through: number; at: number; keepAlive: boolean; timer?: ReturnType<typeof setTimeout>; resolve: () => void }

export class DeliveryQueue {
  private items: unknown[] = [];
  private droppedCount = 0;
  private preparing = 0;
  private order: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setTimeout> | null = null;
  // Each event that enters the queue gets the next ordinal (1, 2, 3...): `pushed` is the last one given, and `removed`
  // counts the events that have left the head of the queue (taken for a batch, dropped or counted), so the oldest
  // waiting event is removed + 1. `sendingFrom` is the first ordinal of the batch being sent, 0 when none is.
  private pushed = 0;
  private removed = 0;
  private sendingFrom = 0;
  // Whether the send loop runs. Set and cleared in the same synchronous step as the loop's look at the queue, so an
  // event that arrives after the loop's last look starts a new loop or finds the interval timer armed.
  private sending = false;
  private flushes = new Set<Flush>();
  // A batch whose first event is at or before this ordinal gets no further attempt: a flush waiting for it gave up.
  private noRetryThrough = 0;
  private retryWait: { until: number; stop: () => void } | null = null;
  // The oldest event written as JSON, kept when it did not fit a batch, so no event is written twice.
  private written: { item: unknown; json: string } | null = null;

  /** `onError` must not throw (the core passes one that cannot). */
  constructor(private readonly send: BatchSender, private readonly o: QueueOptions, private readonly onError: (e: unknown) => void) {}

  /** Events waiting to be sent (not counting a batch being sent). */
  get pending(): number { return this.items.length; }
  /** Reports dropped because the queue was full, or whose delivery was not confirmed, not yet reported in a batch. */
  get dropped(): number { return this.droppedCount; }

  /** Takes the dropped count for a request about to carry it (as much as one request may carry). */
  takeDropped(): number {
    const n = Math.min(this.droppedCount, MAX_DROPPED_PER_BATCH);
    this.droppedCount -= n;
    return n;
  }
  /** Adds to the dropped count from outside the queue: a report sent at once that was over its bound, or the count a
   * request sent at once carried and did not deliver. */
  countDropped(n: number): void { this.droppedCount += n; }

  /** Queues an event still being prepared (hashed). Events enter the queue in the order they were added. */
  add(event: Promise<unknown>): void {
    this.preparing++;
    this.listed();
    this.order = this.order.then(() => event).then(
      (e) => { this.preparing--; this.push(e); },
      (err) => { this.preparing--; this.droppedCount++; this.onError(err); this.unlistIfIdle(); },
    );
  }

  /**
   * Sends the events added before this call (waiting for those still being prepared), in batches; events added later
   * go in the same batches when there is room, but are not waited for. Gives up after timeoutMs: no retry of those
   * events starts after it, and those still waiting then are counted as delivery not confirmed. A request already in
   * flight is left to finish (it has its own time limit). With keepAlive (an app awaiting it), the flush keeps the
   * process running until it ends, at most timeoutMs; the exit flush passes false. Never rejects.
   */
  flush(timeoutMs: number = FLUSH_TIMEOUT_MS, keepAlive = true): Promise<void> {
    const ms = Number.isFinite(timeoutMs) && timeoutMs >= 0 ? Math.min(timeoutMs, MAX_TIMER_MS) : FLUSH_TIMEOUT_MS;
    return new Promise<void>((resolve) => {
      const f: Flush = { through: Infinity, at: Date.now() + ms, keepAlive, resolve };
      this.flushes.add(f);
      f.timer = setTimeout(() => this.cut(f), ms);
      if (!keepAlive) unref(f.timer);
      // A retry already waiting until after this bound could not happen within it: give it up now.
      if (this.retryWait && this.retryWait.until > f.at) this.retryWait.stop();
      void this.order.then(() => {
        f.through = this.pushed; // every event added before the call has entered the queue (or failed) by now
        this.kick();
        this.settle();
      });
    });
  }

  private push(event: unknown): void {
    if (this.items.length >= this.o.maxQueueSize) {
      const oldest = this.items.shift();
      if (this.written && this.written.item === oldest) this.written = null;
      this.removed++;
      this.droppedCount++;
    }
    this.items.push(event);
    this.pushed++;
    if (this.items.length >= this.o.flushAt) this.kick();
    else if (!this.sending) this.armTimer(); // a running loop arms it when it stops
  }

  private armTimer(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.kick(); }, this.o.flushIntervalMs);
    unref(this.timer);
  }

  // Starts the send loop, unless it runs already or nothing waits.
  private kick(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.sending || !this.items.length) return;
    this.sending = true;
    void this.run();
  }

  // Sends batches, one request at a time: the first because something asked for it (flushAt reached, the interval
  // passed, or a flush), then more only while a full batch waits or a flush waits for the oldest event. Otherwise the
  // loop stops and the interval sends the rest.
  private async run(): Promise<void> {
    try {
      do {
        await this.sendNext();
      } while (this.items.length && (this.items.length >= this.o.flushAt || this.flushWaitsFor(this.removed + 1)));
    } catch (err) {
      this.onError(err);
    } finally {
      this.sending = false;
      this.sendingFrom = 0;
      if (this.items.length) this.armTimer();
      this.settle();
      this.unlistIfIdle();
    }
  }

  // One batch from the head of the queue, sent with its retries, and accounted for whatever happens: when it is not
  // delivered, the count it carried and its own reports go back to the dropped count.
  private async sendNext(): Promise<void> {
    const carried = this.takeDropped();
    const meta = carried > 0 ? { dropped: carried } : undefined;
    const from = this.removed + 1;
    let count = 0;
    let delivered = false;
    try {
      const batch = this.take(meta);
      count = batch.count;
      this.sendingFrom = from;
      delivered = count > 0 && await this.sendWithRetries(batch.body, from);
    } finally {
      if (!delivered) this.droppedCount += carried + count;
      this.sendingFrom = 0;
      this.settle();
    }
  }

  // The next batch as its request body: at most maxBatchSize events and maxBatchBytes bytes (UTF-8), counted exactly
  // as sent. An event that cannot be written as JSON is counted as dropped.
  private take(meta: { dropped: number } | undefined): { count: number; body: string } {
    const head = '{"events":[';
    const tail = meta ? `],"meta":${JSON.stringify(meta)}}` : "]}";
    const parts: string[] = [];
    let bytes = utf8Bytes(head) + utf8Bytes(tail);
    while (this.items.length && parts.length < this.o.maxBatchSize) {
      const json = this.headJson();
      if (json === undefined) { this.items.shift(); this.removed++; this.droppedCount++; continue; }
      const size = utf8Bytes(json) + (parts.length ? 1 : 0); // the comma between events
      if (parts.length && bytes + size > this.o.maxBatchBytes) break; // it waits, already written, for the next batch
      bytes += size;
      parts.push(json);
      this.items.shift();
      this.removed++;
      this.written = null;
    }
    return { count: parts.length, body: head + parts.join(",") + tail };
  }

  private headJson(): string | undefined {
    const item = this.items[0];
    if (this.written && this.written.item === item) return this.written.json;
    let json: string | undefined;
    try { json = JSON.stringify(item); } catch (err) { this.onError(err); }
    this.written = json === undefined ? null : { item, json };
    return json;
  }

  // Sends one batch, and again while the gateway provably stored none of it: at most retryCount more times, and only
  // when the retry would start before any flush waiting for the batch gives up. Resolves whether it was delivered.
  private async sendWithRetries(body: string, from: number): Promise<boolean> {
    for (let retries = 0; ; retries++) {
      let outcome: SendOutcome;
      try { outcome = await this.send(body); } catch (err) { this.onError(err); return false; }
      if (outcome.ok) return true;
      if (!outcome.retryable || retries >= this.o.retryCount || from <= this.noRetryThrough) return false;
      const until = Date.now() + Math.min(Math.max(0, outcome.retryAfterMs ?? this.o.retryDelayMs), MAX_RETRY_WAIT_MS);
      if (until > this.boundFor(from)) return false;
      if (!(await this.pause(until, from))) return false;
      // A flush waiting for this batch gave up while it waited (its bound and the retry fell due together).
      if (from <= this.noRetryThrough) return false;
    }
  }

  // Waits until `until` before a retry; resolves false when a flush ended the wait early. The wait keeps the process
  // running only when a flush the app awaits waits for this batch (and so ends by that flush's bound at the latest).
  // A flush the app starts during the wait keeps the process running by its own timer, which outlasts the wait.
  private pause(until: number, from: number): Promise<boolean> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.retryWait = null; resolve(true); }, Math.max(0, until - Date.now()));
      if (!this.heldOpenFor(from)) unref(timer);
      this.retryWait = { until, stop: () => { clearTimeout(timer); this.retryWait = null; resolve(false); } };
    });
  }

  private flushWaitsFor(ordinal: number): boolean {
    for (const f of this.flushes) if (f.through >= ordinal) return true;
    return false;
  }

  private heldOpenFor(ordinal: number): boolean {
    for (const f of this.flushes) if (f.keepAlive && f.through >= ordinal) return true;
    return false;
  }

  // When the earliest flush waiting for the batch that starts at `from` gives up.
  private boundFor(from: number): number {
    let at = Infinity;
    for (const f of this.flushes) if (f.through >= from) at = Math.min(at, f.at);
    return at;
  }

  // Ends the flushes whose events have all left the queue (delivered, or counted as delivery not confirmed).
  private settle(): void {
    const oldestUnsettled = this.sendingFrom || this.removed + 1;
    for (const f of this.flushes) if (f.through < oldestUnsettled) this.finish(f);
  }

  // A flush's bound has passed: its events still waiting are counted as delivery not confirmed, and a batch of its
  // events being sent gets no further attempt. Events that entered the queue after the call wait as before.
  private cut(f: Flush): void {
    const through = Number.isFinite(f.through) ? f.through : this.pushed;
    const n = Math.max(0, Math.min(this.items.length, through - this.removed));
    if (n) { this.items.splice(0, n); this.removed += n; this.droppedCount += n; this.written = null; }
    this.noRetryThrough = Math.max(this.noRetryThrough, through);
    if (!this.items.length && this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.finish(f);
    this.unlistIfIdle();
  }

  private finish(f: Flush): void {
    if (!this.flushes.delete(f)) return;
    clearTimeout(f.timer);
    f.resolve();
  }

  private listed(): void {
    const r = registry();
    r.queues.add(this);
    hookExit(r);
  }
  private unlistIfIdle(): void {
    if (!this.items.length && !this.preparing && !this.sending) registry().queues.delete(this);
  }
}
