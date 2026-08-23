/**
 * Shared fetch for the facilitator's live discovery catalog
 * (`GET {FACILITATOR_URL}/discovery/resources`).
 *
 * Two callers need this: the `/api/catalog` route (proxies it verbatim to
 * the client) and `POST /api/session/create` (reads just the demo seller's
 * price out of it to decide how much USDC to provision). Factored here so
 * the fetch-and-parse logic — including the cold-start timeout handling —
 * lives in exactly one place rather than being duplicated across both.
 *
 * Deliberately returns the parsed JSON as `unknown`-ish loosely-typed shape
 * rather than a fully-validated schema: `/api/catalog` just re-serves it
 * verbatim (it doesn't need to understand the shape), and the one caller
 * that does need to read into it (session/create's price lookup) does its
 * own narrow, defensive parsing of just the fields it needs.
 */

import { FACILITATOR_URL } from "@/lib/config";

const FACILITATOR_TIMEOUT_MS = 60_000;

export interface CatalogAccept {
  amount?: string;
  asset?: string;
  payTo?: string;
  network?: string;
}

export interface CatalogItem {
  resource?: string;
  description?: string;
  accepts?: CatalogAccept[];
  [key: string]: unknown;
}

export interface CatalogResponse {
  items?: CatalogItem[];
  [key: string]: unknown;
}

/**
 * Machine-readable reason a `fetchCatalog()` call failed, so callers can
 * pick an appropriate status code / fallback behavior without string-sniffing
 * `.message`:
 *  - "unreachable": network error or timeout reaching the facilitator.
 *  - "bad_response": facilitator responded, but non-2xx or unparseable body.
 */
export class CatalogFetchError extends Error {
  code: "unreachable" | "bad_response";
  /** True when `code === "unreachable"` and the cause was specifically a timeout
   *  (AbortSignal.timeout() firing), as opposed to a network error. */
  timedOut: boolean;
  constructor(code: CatalogFetchError["code"], message: string, timedOut = false) {
    super(message);
    this.code = code;
    this.timedOut = timedOut;
    this.name = "CatalogFetchError";
  }
}

/**
 * Fetch and parse the facilitator's discovery catalog. Throws
 * `CatalogFetchError` on any failure (unreachable, non-2xx, timeout,
 * unparseable body) — same convention as lib/stellar.ts: callers are
 * responsible for turning this into a human-readable response or a graceful
 * fallback, never surfacing `.message` verbatim to an HTTP caller.
 */
export async function fetchCatalog(): Promise<CatalogResponse> {
  const url = `${FACILITATOR_URL.replace(/\/+$/, "")}/discovery/resources`;
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(FACILITATOR_TIMEOUT_MS) });
  } catch (err) {
    const timedOut = err instanceof Error && err.name === "TimeoutError";
    throw new CatalogFetchError(
      "unreachable",
      `facilitator catalog fetch failed: ${err instanceof Error ? err.message : String(err)}`,
      timedOut,
    );
  }
  if (!res.ok) {
    throw new CatalogFetchError("bad_response", `facilitator catalog returned HTTP ${res.status}`);
  }
  try {
    return (await res.json()) as CatalogResponse;
  } catch (err) {
    throw new CatalogFetchError(
      "bad_response",
      `facilitator catalog response was not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Find the demo seller's cataloged resource entry (`resource === resourceUrl`)
 * and read its first `accepts[]` requirement's atomic amount + asset id.
 * Returns `null` if the catalog doesn't contain that resource, or the entry
 * has no usable `accepts[0]` — callers treat that the same as a fetch
 * failure (fall back to a sensible default) rather than throwing, since a
 * not-yet-cataloged demo resource is an expected, non-exceptional case.
 */
export function findResourcePrice(
  catalog: CatalogResponse,
  resourceUrl: string,
): { amountAtomic: string; asset?: string } | null {
  const items = Array.isArray(catalog.items) ? catalog.items : [];
  const entry = items.find((item) => item.resource === resourceUrl);
  const accept = entry?.accepts?.[0];
  if (!accept?.amount || !/^\d+$/.test(accept.amount)) return null;
  return { amountAtomic: accept.amount, asset: accept.asset };
}

/**
 * True when `resourceUrl`'s host is localhost, a loopback address, or a
 * private-network IP — i.e. some other developer's local dev/test resource
 * that got indexed into the shared facilitator's discovery catalog on
 * testnet (confirmed live: `curl .../discovery/resources` genuinely returns
 * entries like `http://localhost:4031/quote` today, registered by other
 * people's local `x402 seller` test runs). This is a DISPLAY filter only —
 * it hides these from the playground's own catalog UI, since showcasing
 * strangers' throwaway local endpoints isn't appropriate for a public demo.
 * It does not touch the facilitator's data or any other consumer of
 * `fetchCatalog()` (e.g. `/api/session/create`'s price lookup, which must
 * keep seeing the real, unfiltered catalog to price correctly).
 */
export function isLocalOrPrivateResource(resourceUrl: string): boolean {
  let host: string;
  try {
    host = new URL(resourceUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === "localhost" || host === "::1" || host === "0.0.0.0") return true;
  // IPv4 loopback (127.0.0.0/8) and RFC 1918 private ranges.
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
    if (a === 127) return true; // 127.0.0.0/8
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
  }
  return false;
}
