import { getSession } from "@/lib/session";
import { SELLER_URL } from "@/lib/config";
import { attemptPayment, PaymentError, type PayProgressEvent, type PayResult } from "@/lib/pay";

// ---------------------------------------------------------------------------
// Wire format
// ---------------------------------------------------------------------------
//
// POST /api/pay now streams newline-delimited JSON (NDJSON), one event
// object per line, `Content-Type: application/x-ndjson` — same wire-format
// philosophy as POST /api/session/create (see that route's doc comment for
// why NDJSON over SSE). Six real steps, in this exact order:
//
//   1. get_request   — the real unpaid GET, its raw request line, the raw
//                       402 response headers (PAYMENT-REQUIRED, base64) and
//                       their decoded structured form.
//   2. challenge      — the 402 requirement, parsed from step 1's already-
//                       decoded data. Emitted immediately after step 1
//                       resolves — genuinely derived, not a new round trip.
//   3. sign           — the real client.createPaymentPayload() call: builds
//                       + signs a Soroban auth entry (see lib/pay.ts's
//                       SIGN_STEP_NOTE for the auth-entry-vs-transaction
//                       distinction).
//   4. verify         — NOT a new network call (locked decision: never
//                       double-call /settle, and by extension don't mirror
//                       /verify either). Shows the real request payload
//                       about to be sent; the response side is a short,
//                       factual note, not a fabricated body.
//   5. settle         — the real paid retry request. On success, includes
//                       the real settlementTx hash extracted from the
//                       seller's response body.
//   6. result         — the seller's full real response body plus the
//                       settlement tx hash (added by this route once
//                       attemptPayment resolves — lib/pay.ts's PayResult
//                       carries the hash, but the seller's full body is
//                       reported here since lib/pay.ts's settle event
//                       already carries it — see the "settle" event's
//                       `body` field, which route.ts republishes as
//                       "result").
//
// Every step event is one of:
//   {"step": "get_request"|"sign"|"settle", "status": "active", "attempt": N, ...}
//   {"step": <any of the six>, "status": "done"|"error", "attempt": N, ...}
//   {"step": "challenge"|"verify", "status": "done", "attempt": N, ...}
//   {"step": "waking_up", "status": "active", "attempt": N}
//   {"step": "retry", "status": "active", "attempt": N, "maxAttempts": 3}
//   {"step": "complete", "status": "done", "result": {...}}
//   {"step": "complete", "status": "error", "error": string, "message": string, "attempts": N}
//
// Every event (except "complete") carries an `attempt` field (1-based) so
// the client can tell which pass through the retry loop it belongs to — see
// the RETRY VISUALIZATION comment below.
//
// JUDGMENT CALL — every step streams genuinely live, no buffer-then-flush:
// /api/session/create had to buffer its first two steps because the session
// cookie (Set-Cookie) could only be written once friendbot funding succeeded,
// and HTTP headers must commit atomically before a streamed body starts.
// /api/pay has no equivalent constraint: this route only *reads* the
// existing session (no session.save() call anywhere in this handler, unlike
// session/create) — the scratch Response passed to getSession() exists only
// to keep getSession()'s signature uniform across routes, not because this
// route ever writes a cookie. So headers (including the NDJSON content-type)
// can be sent immediately, before any of the six steps begin, and every
// single step below is emitted the instant the real underlying work
// finishes — this route re-evaluated the constraint fresh rather than
// copying session/create's buffering, and concluded it doesn't apply here.
//
// RETRY VISUALIZATION — the biggest open design decision in this task:
// the existing (pre-streaming) route retried the ENTIRE attemptPayment()
// call up to 3 times, only for the "not_settled" failure category — and
// critically, each retry re-runs the WHOLE flow from a fresh GET, per
// buyer-classic.mjs's own comment ("retry the whole flow, signing a fresh
// payload" — ledger-expiry-based signatures can't be reused). The task's
// text suggests visually re-emitting "steps 3/4/5" for a retry; this
// implementation instead re-emits ALL SIX steps (a fresh get_request through
// result) tagged with the new attempt number, because that is what actually
// happens mechanically — attemptPayment() is called again from scratch, so
// steps 1-2 genuinely re-run too (a fresh GET against the seller, a fresh
// 402 decode), not just 3-5. Re-emitting only 3-5 would imply the GET/402
// were reused, which would be dishonest. A `{"step":"retry",...}` marker
// event precedes each retry pass so the client can visibly reset the six-
// step ledger and show "Attempt 2 of 3" rather than silently restarting.
//
// COLD-START — "waking_up" fires (server-side, once per crossing) only
// around step 1's GET if the seller hasn't responded within 5s (see
// lib/pay.ts's fetchWithColdStartNotice). The client is expected to run its
// own elapsed-time ticker from that point (same pattern as
// useElapsedSeconds elsewhere in this app) rather than the server emitting
// repeated ticks — see lib/pay.ts's doc comment for why.
//
// SECURITY: the secret key is read once from the session and passed
// directly into attemptPayment()'s signer construction. It is never
// assigned to any other variable, logged, or placed into any event object
// at any step — see app/api/pay/pay.secret-leak.test.ts, which reads every
// emitted event across a real payment (including a forced retry) and
// asserts this.
// ---------------------------------------------------------------------------

// POST /api/pay body cap — this route accepts a small optional JSON body
// ({ resourceUrl }), same defensive posture as /api/session/create.
const MAX_BODY_BYTES = 2048;

// buyer-classic.mjs: "Roughly one settle in three fails on testnet with an
// empty transaction... retry the whole flow, signing a fresh payload."
const MAX_ATTEMPTS = 3;

// This first GET needs a longer allowance than every other fetch in the
// flow specifically to accommodate a cold Render.com free-tier instance
// waking up — NOT the 30s FETCH_TIMEOUT_MS the rest of lib/pay.ts uses.
const FIRST_GET_TIMEOUT_MS = 90_000;
const COLD_START_AFTER_MS = 5_000;

const DEFAULT_RESOURCE_URL = `${SELLER_URL.replace(/\/+$/, "")}/quote`;

function jsonError(status: number, error: string, message: string) {
  return Response.json({ error, message }, { status });
}

const NDJSON_HEADERS: HeadersInit = {
  "content-type": "application/x-ndjson; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};

/** Wire event shape: every PayProgressEvent (tagged with an attempt number),
 *  plus the two route-level events (retry marker, result, complete). */
type StreamEvent =
  | (PayProgressEvent & { attempt: number })
  | { step: "retry"; status: "active"; attempt: number; maxAttempts: number }
  | { step: "result"; status: "done"; attempt: number; settlementTx: string; body: unknown }
  | {
      step: "complete";
      status: "done";
      result: { settlementTx: string; payer?: string; network?: string; amount?: string; asset?: string; payTo?: string; attempts: number };
    }
  | { step: "complete"; status: "error"; error: string; message: string; attempts: number };

/** Serializes one event exactly as it appears on the wire (see the module doc comment). */
function encodeEvent(event: StreamEvent): string {
  return `${JSON.stringify(event)}\n`;
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

export async function POST(req: Request): Promise<Response> {
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
  // Set-Cookie header if it needed to — it never does on this read-only
  // path (see the module doc comment on why that means no buffer-then-flush
  // is needed here, unlike /api/session/create).
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
  // never assigned to any other variable, logged, or included in any
  // streamed event. See lib/pay.ts's module doc for the same guarantee on
  // its side.
  const secretKey = session.secretKey;

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      function emit(event: StreamEvent) {
        controller.enqueue(encoder.encode(encodeEvent(event)));
      }

      try {
        let lastError: PaymentError | null = null;
        let attemptsMade = 0;

        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
          attemptsMade = attempt;
          if (attempt > 1) {
            emit({ step: "retry", status: "active", attempt, maxAttempts: MAX_ATTEMPTS });
          }

          try {
            const result: PayResult = await attemptPayment(secretKey, resourceUrl, {
              getTimeoutMs: FIRST_GET_TIMEOUT_MS,
              coldStartAfterMs: COLD_START_AFTER_MS,
              onEvent: (event) => emit({ ...event, attempt }),
            });

            // Step 6: result — the seller's full real response body plus the
            // settlement tx hash, both already real data attemptPayment just
            // produced (lib/pay.ts's "settle"/"done" event already carries the
            // raw seller body; this reconstructs the same fields from the
            // typed PayResult attemptPayment returns). Kept as its own step
            // here rather than folded into lib/pay.ts's "settle" event so
            // lib/pay.ts's event surface stays scoped to its own five
            // protocol-level steps, with "result" as this route's
            // presentation-layer step over the same data.
            emit({
              step: "result",
              status: "done",
              attempt,
              settlementTx: result.settlementTx,
              body: {
                settlement: { transaction: result.settlementTx, payer: result.payer, network: result.network },
                amount: result.amount,
                asset: result.asset,
                payTo: result.payTo,
              },
            });

            emit({
              step: "complete",
              status: "done",
              result: {
                settlementTx: result.settlementTx,
                payer: result.payer,
                network: result.network,
                amount: result.amount,
                asset: result.asset,
                payTo: result.payTo,
                attempts: attempt,
              },
            });
            controller.close();
            return;
          } catch (err) {
            lastError = err instanceof PaymentError ? err : new PaymentError("not_settled", String(err));
            console.error(`POST /api/pay attempt ${attempt}/${MAX_ATTEMPTS} failed:`, lastError.code, lastError.message);
            // Non-retryable categories: no point burning attempts on these —
            // same classification the pre-streaming route used.
            if (lastError.code === "no_challenge" || lastError.code === "no_requirement") break;
            if (lastError.code === "build_failed") break;
            // Only "not_settled" (the flaky-testnet-settle case) is worth
            // retrying with a fresh payload.
            if (lastError.code !== "not_settled") break;
          }
        }

        emit({
          step: "complete",
          status: "error",
          error: lastError?.code ?? "unknown",
          message: humanMessage(lastError),
          attempts: attemptsMade,
        });
        controller.close();
      } catch (err) {
        // Genuinely unexpected failure (not a PaymentError — those are
        // caught per-attempt above) — e.g. a bug in event serialization.
        // Still end the stream with an honest terminal event rather than
        // leaving the client's reader hanging forever.
        console.error("POST /api/pay stream failed unexpectedly:", err);
        try {
          emit({
            step: "complete",
            status: "error",
            error: "internal_error",
            message: "Something went wrong, please try again in a moment.",
            attempts: 0,
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
