/**
 * Shared low-level fetch-and-parse for the facilitator's other public GET
 * endpoints (`/health`, `/supported`, `/discovery/search`) — the sibling of
 * `lib/catalog.ts`'s `fetchCatalog()`, which already covers
 * `/discovery/resources`. Kept as a separate small module (rather than
 * folding into catalog.ts) because these endpoints have nothing in common
 * with the catalog-price-lookup callers catalog.ts also serves — but the
 * cold-start/timeout handling and error shape are intentionally identical,
 * copied from that module's proven pattern rather than reinvented.
 *
 * All three of `/api/health`, `/api/supported`, `/api/search` proxy through
 * this — same design rationale as `/api/catalog`'s doc comment: live CORS
 * checks (`curl -H "Origin: ..."`) showed `access-control-allow-origin: *`
 * on every one of these endpoints, so a server proxy isn't required to work
 * around CORS. It exists anyway to centralize the ~45s cold-start/timeout
 * handling in one place, consistent with how `/api/catalog` already made
 * that same call — see this step's report for the live curl evidence.
 *
 * None of these route handlers read the session cookie or touch
 * lib/session.ts — they proxy unauthenticated, public facilitator data only.
 */

import { FACILITATOR_URL } from "@/lib/config";

const FACILITATOR_TIMEOUT_MS = 60_000;

/** Machine-readable reason a facilitator GET failed — same convention as
 *  `lib/catalog.ts`'s `CatalogFetchError`. */
export class FacilitatorFetchError extends Error {
  code: "unreachable" | "bad_response";
  timedOut: boolean;
  constructor(code: FacilitatorFetchError["code"], message: string, timedOut = false) {
    super(message);
    this.code = code;
    this.timedOut = timedOut;
    this.name = "FacilitatorFetchError";
  }
}

/**
 * Fetch a facilitator GET endpoint (given its path + optional query string)
 * and parse the JSON body. Throws `FacilitatorFetchError` on any failure —
 * callers turn that into a proper HTTP error response, never surfacing
 * `.message` verbatim.
 */
export async function fetchFacilitatorJson(path: string): Promise<unknown> {
  const url = `${FACILITATOR_URL.replace(/\/+$/, "")}${path}`;
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(FACILITATOR_TIMEOUT_MS) });
  } catch (err) {
    const timedOut = err instanceof Error && err.name === "TimeoutError";
    throw new FacilitatorFetchError(
      "unreachable",
      `facilitator fetch of ${path} failed: ${err instanceof Error ? err.message : String(err)}`,
      timedOut,
    );
  }
  if (!res.ok) {
    throw new FacilitatorFetchError("bad_response", `facilitator ${path} returned HTTP ${res.status}`);
  }
  try {
    return await res.json();
  } catch (err) {
    throw new FacilitatorFetchError(
      "bad_response",
      `facilitator ${path} response was not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
