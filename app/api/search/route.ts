import { FacilitatorFetchError, fetchFacilitatorJson } from "@/lib/facilitator";

/**
 * GET /api/search?query=... — proxies GET {FACILITATOR_URL}/discovery/search?query=...
 *
 * Public, unauthenticated data only — no session cookie is read here. See
 * lib/facilitator.ts's doc comment for the proxy-vs-direct-fetch rationale.
 *
 * NOTE the response shape differs from /api/catalog's: the facilitator's own
 * /discovery/search returns `{ resources: [...] }` while /discovery/resources
 * returns `{ items: [...] }` — a real inconsistency in the upstream API, not
 * a bug here. This route proxies the body verbatim either way; callers
 * (app/catalog/page.tsx) are responsible for reading the right key.
 */

function jsonError(status: number, error: string, message: string) {
  return Response.json({ error, message }, { status });
}

export async function GET(request: Request): Promise<Response> {
  const { searchParams } = new URL(request.url);
  const query = searchParams.get("query") ?? "";

  let body: unknown;
  try {
    body = await fetchFacilitatorJson(`/discovery/search?query=${encodeURIComponent(query)}`);
  } catch (err) {
    console.error("GET /api/search: fetch failed:", err);
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
