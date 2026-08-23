/**
 * GET `url` with a bounded timeout, calling `onColdStart` (once) if the
 * response hasn't arrived within `coldStartAfterMs` — the shared "the
 * seller/facilitator might be waking up from a Render free-tier cold
 * start" pattern, extracted here so every route hitting an external
 * service the SAME way (a plain unpaid GET against a service that can be
 * cold) doesn't reimplement its own timer.
 *
 * Originally private to lib/pay.ts (as `fetchWithColdStartNotice`, scoped to
 * that module's own `OnPayEvent` shape) — pulled out and genericized once a
 * second route (POST /api/verify-ownership) needed the identical mechanism
 * but emits a differently-shaped stream event for its own "waking up"
 * signal. `onColdStart` here is a plain callback with no event-shape
 * opinion; each caller decides what its own "waking_up"-equivalent event
 * looks like.
 *
 * JUDGMENT CALL — client-side ticker, not server-side repeated ticks: the
 * server calls `onColdStart` exactly once the moment the threshold is
 * crossed, then the real GET keeps running underneath; the client is
 * expected to start its own `useElapsedSeconds`-style ticker from the
 * moment it sees that signal (see this app's own useElapsedSeconds usage
 * elsewhere) rather than this helper re-emitting on an interval.
 */
export async function fetchWithColdStartNotice(
  url: string,
  init: RequestInit,
  hardTimeoutMs: number,
  coldStartAfterMs: number,
  onColdStart?: () => void,
): Promise<Response> {
  const coldStartTimer = setTimeout(() => {
    onColdStart?.();
  }, coldStartAfterMs);

  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(hardTimeoutMs) });
  } finally {
    clearTimeout(coldStartTimer);
  }
}
