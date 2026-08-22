import { FACILITATOR_URL } from "@/lib/config";

/**
 * GET /api/catalog — proxies GET {FACILITATOR_URL}/discovery/resources.
 *
 * DESIGN DECISION: the hosted facilitator's CORS headers (verified by curl
 * during this build: `access-control-allow-origin: *`, and a working GET
 * with an Origin header) would in fact allow a direct browser-side fetch —
 * CORS is not the reason a proxy exists here. We route through this server
 * proxy anyway to centralize cold-start/timeout handling in one place: the
 * facilitator can have a ~45s cold start on first hit, and that "waking up,
 * keep waiting, then give a clear timeout" logic is identical to what
 * /api/pay's underlying calls need. Keeping it server-side also means the
 * playground can change the facilitator URL (lib/config.ts) or add
 * caching/backoff later without touching client code.
 */

const FACILITATOR_TIMEOUT_MS = 60_000;

function jsonError(status: number, error: string, message: string) {
  return Response.json({ error, message }, { status });
}

export async function GET(): Promise<Response> {
  const url = `${FACILITATOR_URL.replace(/\/+$/, "")}/discovery/resources`;
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(FACILITATOR_TIMEOUT_MS) });
  } catch (err) {
    console.error("GET /api/catalog: facilitator fetch failed:", err);
    const timedOut = err instanceof Error && err.name === "TimeoutError";
    return jsonError(
      timedOut ? 504 : 502,
      timedOut ? "facilitator_timeout" : "facilitator_unreachable",
      timedOut
        ? "The demo facilitator is taking a while to wake up (it sleeps when idle). Please try again shortly."
        : "We couldn't reach the demo facilitator right now. Please try again in a moment.",
    );
  }

  if (!res.ok) {
    console.error(`GET /api/catalog: facilitator returned HTTP ${res.status}`);
    return jsonError(
      502,
      "facilitator_error",
      "The demo facilitator returned an unexpected response. Please try again in a moment.",
    );
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch (err) {
    console.error("GET /api/catalog: could not parse facilitator response:", err);
    return jsonError(502, "facilitator_error", "The demo facilitator returned a response we couldn't read.");
  }

  return Response.json(body);
}
