import { decodePaymentRequiredHeader } from "@x402/core/http";
import { SELLER_URL } from "@/lib/config";
import { CatalogFetchError, fetchCatalog, type CatalogItem } from "@/lib/catalog";

// A live seller fetch plus a facilitator catalog fetch, either of which can
// hit a cold-start delay — past the default 10s. Vercel Hobby platform max.
export const maxDuration = 30;

/**
 * POST /api/verify-ownership — Station 2's "Verify now" streaming check.
 *
 * SECURITY / SCOPE: this route touches ONLY public, unauthenticated data —
 * the seller's own 402 challenge (no payment attached, no auth) and the
 * facilitator's public GET /discovery/resources. It never imports
 * lib/session.ts, never reads a cookie, and has no session/secret-key
 * involvement anywhere in its code path (see the module-level grep proof in
 * the task report). This is deliberately unlike POST /api/pay, which reads
 * the session cookie to sign a real payment — this route never signs or
 * pays anything.
 *
 * GROUND TRUTH — what this route is, and is not:
 * The facilitator's real ownership check (src/ownership.ts's
 * verifyResourceOwnership) is NOT exposed via any HTTP route — it only runs
 * internally from the facilitator's own boot-time re-proof and its
 * settlement hot path. There is no way for this playground to trigger that
 * real internal check directly. Instead, this route independently performs
 * the SAME KIND of check the facilitator does: fetch the seller's own 402
 * challenge and compare the payTo it names against the bound address already
 * on file in the public catalog. This is a genuinely live check with a
 * genuinely live result — it is just run by the playground, not by invoking
 * the facilitator's internal function.
 *
 * Because the demo resource has already been durably verified (see
 * ownershipState's latch semantics in src/trust.ts / src/catalog.ts), a
 * visitor will essentially always see a re-confirmation of an established
 * verdict, not a live discovery — this route reports that honestly (see
 * step 5's verdict text) rather than dressing it up as a first-time
 * transition.
 *
 * WHAT THIS ROUTE SKIPS, ON PURPOSE: the facilitator's real
 * verifyResourceOwnership() wraps its fetch in SSRF-hardening machinery —
 * DNS pinning (closes a DNS-rebinding TOCTOU), a private/loopback/link-local
 * address block, `redirect: "manual"` (refuses to follow a redirect into a
 * blocked range), and a response-size cap. This route does NOT reimplement
 * any of that, because unlike the facilitator (which fetches arbitrary,
 * attacker-influenced catalog URLs), this route only ever fetches
 * SELLER_URL — a fixed, known-safe demo constant from lib/config.ts, never
 * user input. See the "hardeningSkipped" field on step 1's `done` event for
 * the exact disclosure surfaced to the UI.
 *
 * ---------------------------------------------------------------------------
 * WIRE FORMAT — same NDJSON philosophy as POST /api/pay (see that route's
 * doc comment): one JSON event object per line,
 * `Content-Type: application/x-ndjson`, every event emitted only once the
 * real underlying step has genuinely resolved. Five steps, in this exact
 * order, each `active` (where the step involves a real wait) then `done` or
 * `error`:
 *
 *   1. fetch_challenge   — GET SELLER_URL with no payment attached. Expect
 *                          402. Emits the raw request line, the raw response
 *                          status, and the raw base64 PAYMENT-REQUIRED
 *                          header.
 *   2. decode_header      — decode the base64 header via
 *                          @x402/core/http's decodePaymentRequiredHeader()
 *                          — the same stateless decoder
 *                          x402HTTPClient.getPaymentRequiredResponse()
 *                          (used by lib/pay.ts) calls internally, reused
 *                          here directly since it needs no signer/client
 *                          state. No new network call — genuinely derived
 *                          from step 1's already-fetched header, so it is
 *                          honest for this to resolve immediately after
 *                          step 1. Emits the decoded structured challenge.
 *   3. parse_pay_to       — extract challenge.accepts[].payTo (an array,
 *                          handled generically — see the module doc comment
 *                          on WHY below). No new network call. Emits the
 *                          parsed payTo claim(s).
 *   4. compare_catalog    — GET {FACILITATOR_URL}/discovery/resources (via
 *                          lib/catalog.ts's fetchCatalog(), already used
 *                          elsewhere in this app), find the demo seller's
 *                          entry, read its real current accepts[0].payTo and
 *                          trust.ownershipState/ownerVerified/lastSettled.
 *                          Emits the bound address being compared against.
 *   5. verdict            — compare the challenge's payTo claim(s) against
 *                          the bound address, same logic as
 *                          src/ownership.ts's `claims.some((c) =>
 *                          payTos.has(c))`. Emits the verdict.
 *
 * Every event carries {"step": <name>, "status": "active"|"done"|"error", ...}
 * terminated by one {"step": "complete", "status": "done"|"error", ...}.
 *
 * WHY handle MULTIPLE payTo claims generically (step 3): src/ownership.ts's
 * real verifyResourceOwnership() accepts `settledPayTo: string |
 * readonly string[]` and matches if the challenge names ANY of them — an
 * operator-rotation case (see that file's "G-1" comment). Against today's
 * single demo seller, the catalog's `accepts` array in practice holds one
 * entry, so there is one bound payTo — but this route reads the catalog's
 * FULL accepts[] array (not just accepts[0]) and treats it as a set of
 * claims, exactly like the real module does, rather than hardcoding an
 * assumption ("there is exactly one bound address") that would silently
 * break if the real data ever had more than one.
 * ---------------------------------------------------------------------------
 */

const FETCH_TIMEOUT_MS = 15_000;

const HARDENING_DISCLOSURE =
  "The real facilitator also pins DNS and blocks private/internal addresses before fetching an arbitrary " +
  "seller URL; this demo check skips that hardening since it's only ever pointed at a known, fixed demo resource.";

const MECHANISM_DISCLOSURE =
  "The playground is performing the same check the facilitator runs — fetching the seller's own 402 challenge " +
  "and comparing the payTo it names against the bound address.";

function jsonError(status: number, error: string, message: string) {
  return Response.json({ error, message }, { status });
}

const NDJSON_HEADERS: HeadersInit = {
  "content-type": "application/x-ndjson; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};

interface DecodedChallenge {
  x402Version?: number;
  accepts?: Array<{
    scheme?: string;
    network?: string;
    asset?: string;
    amount?: string;
    payTo?: string;
    maxTimeoutSeconds?: number;
  }>;
  [key: string]: unknown;
}

type StreamEvent =
  | { step: "fetch_challenge"; status: "active"; requestLine: string }
  | {
      step: "fetch_challenge";
      status: "done";
      requestLine: string;
      responseStatus: number;
      rawPaymentRequiredHeader: string;
      mechanismNote: string;
      hardeningSkippedNote: string;
    }
  | { step: "fetch_challenge"; status: "error"; message: string }
  | { step: "decode_header"; status: "done"; decoded: DecodedChallenge }
  | { step: "decode_header"; status: "error"; message: string }
  | { step: "parse_pay_to"; status: "done"; payTos: string[] }
  | { step: "parse_pay_to"; status: "error"; message: string }
  | {
      step: "compare_catalog";
      status: "done";
      resource: string;
      boundPayTos: string[];
      ownershipState?: string;
      ownerVerified?: boolean;
      lastSettled?: string;
      settlements?: number;
    }
  | { step: "compare_catalog"; status: "error"; message: string }
  | {
      step: "verdict";
      status: "done";
      match: boolean;
      verdictText: string;
      challengePayTos: string[];
      boundPayTos: string[];
    }
  | { step: "complete"; status: "done" }
  | { step: "complete"; status: "error"; error: string; message: string };

function encodeEvent(event: StreamEvent): string {
  return `${JSON.stringify(event)}\n`;
}

export async function POST(): Promise<Response> {
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      function emit(event: StreamEvent) {
        controller.enqueue(encoder.encode(encodeEvent(event)));
      }

      try {
        // -----------------------------------------------------------------
        // Step 1: fetch the seller's 402 challenge — a plain unpaid GET, no
        // payment attached, no auth. Fresh, independent fetch (deliberately
        // NOT reusing Station 1's captured data, since the point is a live
        // re-check, not a replay).
        // -----------------------------------------------------------------
        const resourceUrl = `${SELLER_URL.replace(/\/+$/, "")}/quote`;
        const requestLine = `GET ${resourceUrl}`;
        emit({ step: "fetch_challenge", status: "active", requestLine });

        let unpaid: Response;
        try {
          unpaid = await fetch(resourceUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
        } catch (err) {
          const message = `Could not reach the seller to fetch its 402 challenge: ${err instanceof Error ? err.message : String(err)}`;
          emit({ step: "fetch_challenge", status: "error", message });
          emit({ step: "complete", status: "error", error: "unreachable", message });
          controller.close();
          return;
        }

        if (unpaid.status !== 402) {
          void unpaid.body?.cancel?.().catch(() => {});
          const message = `Expected a 402 payment challenge from the seller, got HTTP ${unpaid.status}.`;
          emit({ step: "fetch_challenge", status: "error", message });
          emit({ step: "complete", status: "error", error: "no_challenge", message });
          controller.close();
          return;
        }

        const rawPaymentRequiredHeader = unpaid.headers.get("PAYMENT-REQUIRED") ?? "";
        void unpaid.body?.cancel?.().catch(() => {});

        emit({
          step: "fetch_challenge",
          status: "done",
          requestLine,
          responseStatus: unpaid.status,
          rawPaymentRequiredHeader,
          mechanismNote: MECHANISM_DISCLOSURE,
          hardeningSkippedNote: HARDENING_DISCLOSURE,
        });

        // -----------------------------------------------------------------
        // Step 2: decode the base64 PAYMENT-REQUIRED header — the same
        // decoder @x402/core's x402HTTPClient.getPaymentRequiredResponse()
        // calls internally (that method is a thin, stateless wrapper around
        // exactly this function — no signer/client/network state is
        // involved, so this route calls it directly rather than
        // constructing an unused client just to reach it). No new network
        // call: genuinely derived from step 1's already-fetched header.
        // -----------------------------------------------------------------
        let decoded: DecodedChallenge;
        try {
          decoded = decodePaymentRequiredHeader(rawPaymentRequiredHeader) as unknown as DecodedChallenge;
        } catch (err) {
          const message = `Could not decode the PAYMENT-REQUIRED header: ${err instanceof Error ? err.message : String(err)}`;
          emit({ step: "decode_header", status: "error", message });
          emit({ step: "complete", status: "error", error: "decode_failed", message });
          controller.close();
          return;
        }
        emit({ step: "decode_header", status: "done", decoded });

        // -----------------------------------------------------------------
        // Step 3: parse payTo(s) from the decoded challenge. Handled
        // generically as an array — src/ownership.ts's real check supports
        // multiple bound addresses (operator rotation), so this doesn't
        // hardcode an "exactly one" assumption. No new network call.
        // -----------------------------------------------------------------
        const challengePayTos = (decoded.accepts ?? [])
          .map((a) => a.payTo)
          .filter((p): p is string => typeof p === "string" && p.length > 0);

        if (challengePayTos.length === 0) {
          const message = "The seller's 402 challenge named no payTo address to compare.";
          emit({ step: "parse_pay_to", status: "error", message });
          emit({ step: "complete", status: "error", error: "no_pay_to", message });
          controller.close();
          return;
        }
        emit({ step: "parse_pay_to", status: "done", payTos: challengePayTos });

        // -----------------------------------------------------------------
        // Step 4: fetch the public catalog (lib/catalog.ts's fetchCatalog(),
        // already used elsewhere in this app) and find the demo seller's
        // entry — read its REAL current bound payTo(s) and trust fields.
        // -----------------------------------------------------------------
        let catalogItem: CatalogItem | undefined;
        try {
          const catalog = await fetchCatalog();
          const items = Array.isArray(catalog.items) ? catalog.items : [];
          catalogItem = items.find((item) => item.resource === resourceUrl);
        } catch (err) {
          const message =
            err instanceof CatalogFetchError
              ? `Could not reach the facilitator's public catalog: ${err.message}`
              : `Could not reach the facilitator's public catalog: ${err instanceof Error ? err.message : String(err)}`;
          emit({ step: "compare_catalog", status: "error", message });
          emit({ step: "complete", status: "error", error: "catalog_unreachable", message });
          controller.close();
          return;
        }

        if (!catalogItem) {
          const message = "The demo resource isn't in the facilitator's public catalog yet.";
          emit({ step: "compare_catalog", status: "error", message });
          emit({ step: "complete", status: "error", error: "not_cataloged", message });
          controller.close();
          return;
        }

        const boundPayTos = (catalogItem.accepts ?? [])
          .map((a) => a.payTo)
          .filter((p): p is string => typeof p === "string" && p.length > 0);
        const trust = (catalogItem as { trust?: { ownershipState?: string; ownerVerified?: boolean; lastSettled?: string; settlements?: number } }).trust;

        emit({
          step: "compare_catalog",
          status: "done",
          resource: catalogItem.resource ?? resourceUrl,
          boundPayTos,
          ownershipState: trust?.ownershipState,
          ownerVerified: trust?.ownerVerified,
          lastSettled: trust?.lastSettled,
          settlements: trust?.settlements,
        });

        // -----------------------------------------------------------------
        // Step 5: verdict — same comparison logic as src/ownership.ts's
        // `claims.some((c) => payTos.has(c))`: a match if ANY challenge
        // payTo is in the set of bound payTos.
        // -----------------------------------------------------------------
        const boundSet = new Set(boundPayTos);
        const match = challengePayTos.some((c) => boundSet.has(c));
        const alreadyVerified = trust?.ownershipState === "verified";

        let verdictText: string;
        if (match && alreadyVerified) {
          verdictText = "Confirmed — already verified. This resource was proven earlier and that verdict is permanent.";
        } else if (match) {
          verdictText = "Match — the seller's challenge names the bound address.";
        } else {
          // Shouldn't happen against the real demo seller, but handled
          // honestly rather than papered over (e.g. a transient network
          // hiccup, or the bound address having genuinely changed).
          verdictText =
            "No match — the seller's challenge does not currently name the bound address. This is unexpected for " +
            "the demo resource; it may indicate a transient issue or that the catalog and the live challenge are " +
            "momentarily out of sync.";
        }

        emit({
          step: "verdict",
          status: "done",
          match,
          verdictText,
          challengePayTos,
          boundPayTos,
        });

        emit({ step: "complete", status: "done" });
        controller.close();
      } catch (err) {
        console.error("POST /api/verify-ownership stream failed unexpectedly:", err);
        try {
          emit({
            step: "complete",
            status: "error",
            error: "internal_error",
            message: "Something went wrong, please try again in a moment.",
          });
        } catch {
          // controller may already be closed/errored — nothing more to do.
        }
        controller.close();
      }
    },
  });

  const headers = new Headers(NDJSON_HEADERS);
  return new Response(stream, { status: 200, headers });
}

// GET is intentionally unsupported — this route always performs a fresh
// live check, which is a POST-shaped action (analogous to /api/pay), not a
// cacheable GET.
export async function GET(): Promise<Response> {
  return jsonError(405, "method_not_allowed", "Use POST to run a fresh ownership verification check.");
}
