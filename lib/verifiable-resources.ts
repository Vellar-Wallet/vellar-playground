import { SELLER_URL } from "@/lib/config";

/**
 * The fixed, closed set of resources POST /api/verify-ownership will ever
 * check — shared between that route (which validates an incoming `id`
 * against this exact map before ever building a fetch URL from it) and
 * /verify's own picker UI (which needs the same ids/labels to let a
 * visitor choose what to check). One source of truth so client and server
 * can never drift apart on what's actually checkable.
 *
 * Every resource here sits on SELLER_URL — the one host this route's whole
 * security model depends on staying fixed and known (see route.ts's own
 * doc comment on why this stays a closed id-keyed allow-list, never a
 * client-supplied URL/path). Confirmed live: 8 of the catalog's 11 entries
 * sit on this exact host today; the other 3 are localhost:* dev/test
 * artifacts from local facilitator testing, not real public resources.
 *
 * Two resources need a fetch path that DIFFERS from what the catalog lists
 * them under, both confirmed live:
 *   - /inspect carries a literal, unsubstituted ":address" path-param
 *     placeholder in its OWN catalog entry — `path` here substitutes a
 *     real, fixed testnet address so the actual fetch gets a 402 instead
 *     of a 400.
 *   - hash/base64/word-count/stroops all 400 on a bare GET with
 *     `{"error":"invalid_input", ...}` BEFORE the seller ever gets to
 *     checking payment — each needs its own required query param(s) (seen
 *     directly in each 400's own error detail) just to reach its 402
 *     challenge. The catalog lists all four under their bare path with no
 *     query string.
 * `catalogPath` is the literal/bare form the catalog lists a resource
 * under, whenever it differs from the `path` actually fetched.
 */
export interface VerifiableResource {
  id: string;
  /** Path actually fetched for a live 402 challenge. */
  path: string;
  label: string;
  /** Path the catalog lists this resource UNDER, when it differs from
   *  `path` — see the module doc comment above. */
  catalogPath?: string;
}

export const VERIFIABLE_RESOURCES: readonly VerifiableResource[] = [
  { id: "quote", path: "/quote", label: "Motivational quote of the day" },
  { id: "timestamp", path: "/timestamp", label: "Current time, anchored to the ledger" },
  { id: "uuid", path: "/uuid", label: "Fresh UUID v4 with a SHA-256 fingerprint" },
  {
    id: "hash",
    path: "/hash?input=x402",
    catalogPath: "/hash",
    label: "SHA-256 / MD5 hash",
  },
  {
    id: "base64",
    path: "/base64?mode=encode&input=x402",
    catalogPath: "/base64",
    label: "Base64 encode/decode",
  },
  {
    id: "word-count",
    path: "/word-count?text=x402%20on%20Stellar",
    catalogPath: "/word-count",
    label: "Word/character count",
  },
  {
    id: "stroops",
    path: "/stroops?usdc=1",
    catalogPath: "/stroops",
    label: "USDC-to-stroop conversion",
  },
  {
    id: "inspect",
    path: "/inspect/GAATVGLRHZXFC66GEN5QNKD56HC5JJZVHQ3P7ZJNVCCI4WKLN44FICSC",
    catalogPath: "/inspect/:address",
    label: "Stellar address inspector",
  },
] as const;

export const DEFAULT_VERIFY_ID = "quote";

export function verifiableResourceById(id: string): VerifiableResource | undefined {
  return VERIFIABLE_RESOURCES.find((r) => r.id === id);
}

/** Full URL this resource is actually fetched at (SELLER_URL + path). */
export function verifiableResourceUrl(resource: VerifiableResource): string {
  return `${SELLER_URL.replace(/\/+$/, "")}${resource.path}`;
}

/** Full URL the catalog lists this resource under (may differ from the
 *  fetch URL — see `catalogPath`'s own doc comment above). */
export function verifiableResourceCatalogUrl(resource: VerifiableResource): string {
  const path = resource.catalogPath ?? resource.path;
  return `${SELLER_URL.replace(/\/+$/, "")}${path}`;
}
