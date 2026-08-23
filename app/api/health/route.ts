import { FacilitatorFetchError, fetchFacilitatorJson } from "@/lib/facilitator";

// fetchFacilitatorJson's own internal timeout is 60s (the facilitator's
// documented cold-start allowance). Vercel Hobby platform max.
export const maxDuration = 60;

/**
 * GET /api/health — proxies GET {FACILITATOR_URL}/health.
 *
 * Public, unauthenticated data only — no session cookie is read here. See
 * lib/facilitator.ts's doc comment for the proxy-vs-direct-fetch rationale
 * (CORS already permits a direct client fetch; the proxy exists to
 * centralize cold-start/timeout handling, matching /api/catalog).
 */

function jsonError(status: number, error: string, message: string) {
  return Response.json({ error, message }, { status });
}

export async function GET(): Promise<Response> {
  let body: unknown;
  try {
    body = await fetchFacilitatorJson("/health");
  } catch (err) {
    console.error("GET /api/health: fetch failed:", err);
    if (err instanceof FacilitatorFetchError && err.code === "unreachable") {
      return jsonError(
        err.timedOut ? 504 : 502,
        err.timedOut ? "facilitator_timeout" : "facilitator_unreachable",
        err.timedOut
          ? "The demo facilitator is taking a while to wake up (it sleeps when idle). Please try again shortly."
          : "We couldn't reach the demo facilitator right now. Please try again in a moment.",
      );
    }
    return jsonError(502, "facilitator_error", "The demo facilitator returned a response we couldn't read.");
  }
  return Response.json(body);
}
