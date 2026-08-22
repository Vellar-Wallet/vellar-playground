import { getSession } from "@/lib/session";
import { SELLER_URL } from "@/lib/config";
import { attemptPayment, PaymentError, type PayResult } from "@/lib/pay";

// POST /api/pay body cap — this route accepts a small optional JSON body
// ({ resourceUrl }), same defensive posture as /api/session/create.
const MAX_BODY_BYTES = 2048;

// buyer-classic.mjs: "Roughly one settle in three fails on testnet with an
// empty transaction... retry the whole flow, signing a fresh payload."
// Implemented server-side here (see DESIGN DECISION below for why).
const MAX_ATTEMPTS = 3;

const DEFAULT_RESOURCE_URL = `${SELLER_URL.replace(/\/+$/, "")}/quote`;

function jsonError(status: number, error: string, message: string) {
  return Response.json({ error, message }, { status });
}

/**
 * DESIGN DECISION — server-driven retry, not client-driven:
 *
 * /api/pay performs the ENTIRE up-to-3-attempts retry loop in one server-side
 * call and only returns after final success or exhausting attempts. The
 * alternative (client calls /api/pay once per attempt, driving the counter
 * itself) would let the UI show a real "attempt 2/3" during the call, but it
 * also means the client would need to orchestrate protocol-level retry logic
 * that's really a server-side implementation detail — and every one of the
 * three attempts still needs a *fresh* signed payload built server-side
 * anyway (ledger-expiry-based signatures per buyer-classic.mjs), so there's
 * no meaningful client-side state to drive between attempts other than a
 * number. We picked server-driven because: (1) it keeps the secret key's
 * signer construction entirely server-side per attempt with no risk of a
 * client-orchestrated retry accidentally reusing state across calls: each
 * server-side attempt is a clean call to attemptPayment(); (2) it's simpler
 * — one request/response pair instead of a stateful multi-request protocol
 * between client and server; (3) it's honest about what the client actually
 * knows: the client genuinely does NOT know which attempt is in flight
 * during a single fetch, so a live "attempt N/3" counter during the call
 * would be fabricated. The client-visible loading copy instead says "this
 * can take a few tries on testnet" with elapsed time — true regardless of
 * which attempt is running. The final response DOES report how many
 * attempts were made (`attempts`), so the client can say "took 2 attempts"
 * or "failed after 3 attempts" truthfully, just not live during the call.
 */
export async function POST(req: Request): Promise<Response> {
  try {
    const contentLength = req.headers.get("content-length");
    if (contentLength && Number(contentLength) > MAX_BODY_BYTES) {
      return jsonError(413, "payload_too_large", "That request looks too large for this endpoint.");
    }
    const text = await req.text().catch(() => null);
    if (text === null) {
      return jsonError(400, "bad_request", "We couldn't read your request. Please try again.");
    }
    if (text.length > MAX_BODY_BYTES) {
      return jsonError(413, "payload_too_large", "That request looks too large for this endpoint.");
    }

    let resourceUrl = DEFAULT_RESOURCE_URL;
    if (text.trim().length > 0) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return jsonError(400, "invalid_body", "Your request body isn't valid JSON.");
      }
      if (typeof parsed === "object" && parsed !== null && "resourceUrl" in parsed) {
        const candidate = (parsed as { resourceUrl?: unknown }).resourceUrl;
        if (typeof candidate !== "string" || candidate.length === 0) {
          return jsonError(400, "invalid_body", "resourceUrl must be a non-empty string if provided.");
        }
        let url: URL;
        try {
          url = new URL(candidate);
        } catch {
          return jsonError(400, "invalid_body", "resourceUrl must be a valid URL.");
        }
        if (url.protocol !== "https:" && url.protocol !== "http:") {
          return jsonError(400, "invalid_body", "resourceUrl must be an http(s) URL.");
        }
        resourceUrl = candidate;
      }
    }

    // Scratch response purely so getSession() has somewhere to write a
    // Set-Cookie header if it needed to (it doesn't on the read-only path
    // this route takes, but this keeps the pattern identical to the other
    // routes so getSession's contract never has to special-case a caller).
    const scratch = new Response(null);
    const session = await getSession(req, scratch);

    if (!session.publicKey || !session.secretKey || !session.createdAt) {
      return jsonError(401, "no_session", "You don't have an active session yet. Create one to get started.");
    }

    const ageMs = Date.now() - session.createdAt;
    const THIRTY_MINUTES_IN_MS = 30 * 60 * 1000;
    if (ageMs > THIRTY_MINUTES_IN_MS) {
      return jsonError(401, "session_expired", "Your session has expired after 30 minutes. Please create a new one.");
    }

    // secretKey is read here and passed directly into attemptPayment(); it is
    // never assigned to any other variable, logged, or included in a
    // response. See lib/pay.ts's module doc for the same guarantee on its side.
    const secretKey = session.secretKey;

    let lastError: PaymentError | null = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const result: PayResult = await attemptPayment(secretKey, resourceUrl);
        return Response.json({
          ok: true,
          settlementTx: result.settlementTx,
          payer: result.payer,
          network: result.network,
          amount: result.amount,
          asset: result.asset,
          payTo: result.payTo,
          attempts: attempt,
        });
      } catch (err) {
        lastError = err instanceof PaymentError ? err : new PaymentError("not_settled", String(err));
        console.error(`POST /api/pay attempt ${attempt}/${MAX_ATTEMPTS} failed:`, lastError.code, lastError.message);
        // Non-retryable categories: no point burning attempts on these.
        if (lastError.code === "no_challenge" || lastError.code === "no_requirement") break;
        // "build_failed" (no trustline / empty balance) is also not
        // retryable — it will fail identically every time until the
        // underlying wallet state changes.
        if (lastError.code === "build_failed") break;
        // Only "not_settled" (the flaky-testnet-settle case) is worth
        // retrying with a fresh payload.
      }
    }

    const attemptsMade = lastError?.code === "not_settled" ? MAX_ATTEMPTS : 1;
    const status =
      lastError?.code === "build_failed"
        ? 402
        : lastError?.code === "no_challenge" || lastError?.code === "no_requirement"
          ? 502
          : 503;

    return Response.json(
      {
        ok: false,
        error: lastError?.code ?? "unknown",
        message: humanMessage(lastError),
        attempts: attemptsMade,
      },
      { status },
    );
  } catch (err) {
    console.error("POST /api/pay failed:", err);
    return jsonError(500, "internal_error", "Something went wrong, please try again in a moment.");
  }
}

function humanMessage(err: PaymentError | null): string {
  if (!err) return "Something went wrong while trying to pay. Please try again.";
  switch (err.code) {
    case "no_challenge":
      return "We couldn't reach the demo resource to start the payment. It may be waking up — please try again in a moment.";
    case "no_requirement":
      return "This resource doesn't offer a payment option we support yet.";
    case "build_failed":
      return "Your wallet can't build this payment — it likely doesn't hold the required asset or a trustline to it yet. (Known gap: session wallets are funded with XLM only.)";
    case "not_settled":
      return "This payment didn't settle after 3 tries — this happens sometimes on testnet, nothing was charged, try again.";
    default:
      return "Something went wrong while trying to pay. Please try again.";
  }
}
