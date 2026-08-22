import { CatalogFetchError, fetchCatalog } from "@/lib/catalog";

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
 *
 * The actual fetch-and-parse logic lives in lib/catalog.ts, shared with
 * POST /api/session/create's USDC-price lookup — see that module's doc.
 */

function jsonError(status: number, error: string, message: string) {
  return Response.json({ error, message }, { status });
}

export async function GET(): Promise<Response> {
  let body: unknown;
  try {
    body = await fetchCatalog();
  } catch (err) {
    console.error("GET /api/catalog: fetchCatalog failed:", err);
    if (err instanceof CatalogFetchError && err.code === "unreachable") {
      return jsonError(
        err.timedOut ? 504 : 502,
        err.timedOut ? "facilitator_timeout" : "facilitator_unreachable",
        err.timedOut
          ? "The demo facilitator is taking a while to wake up (it sleeps when idle). Please try again shortly."
          : "We couldn't reach the demo facilitator right now. Please try again in a moment.",
      );
    }
    return jsonError(
      502,
      "facilitator_error",
      "The demo facilitator returned a response we couldn't read.",
    );
  }

  return Response.json(body);
}
