import { x402Client } from "@x402/core/client";
import { x402HTTPClient } from "@x402/core/http";
import { ExactStellarScheme } from "@x402/stellar/exact/client";
import { createEd25519Signer } from "@x402/stellar";
import { getSession } from "@/lib/session";
import { SELLER_URL, FACILITATOR_URL } from "@/lib/config";
import {
  tamperAmount,
  redirectPayTo,
  stripSignature,
  wrongNetwork,
  withCorruptedXdr,
  getArmedXdr,
  type ArmedPayload,
} from "@/lib/attack-payment";

// Arms one real payload, then fires 5 sequential live attacks (one of which,
// replay, is 2 real /settle calls) — comfortably past the default 10s. Set
// to Vercel Hobby's platform maximum.
export const maxDuration = 60;

/**
 * POST /api/attack/payment — Station 3's payment-attack track (5 attacks).
 *
 * MECHANISM (confirmed live against the real hosted facilitator before this
 * route was written — see the task report for the full transcript):
 *   1. "Arm the bench": build ONE real, validly-signed x402 Stellar payment
 *      payload, using the SAME mechanism lib/pay.ts's attemptPayment() uses
 *      (createEd25519Signer, x402Client, ExactStellarScheme,
 *      client.createPaymentPayload(required) against a real 402 challenge
 *      from the demo seller), signed with the CURRENT SESSION's wallet. This
 *      requires a funded session wallet — same precondition as Station 1.
 *   2. For each of 5 attacks, take a FRESH COPY of the armed payload (never
 *      mutate-and-reuse) and corrupt it (see lib/attack-payment.ts for the
 *      exact corruption mechanics), then submit it live.
 *
 * ENDPOINT CHOICE, per attack — LOCKED DECISION, confirmed by direct live
 * testing against the real facilitator (see the task report):
 *   - tamper_amount, redirect_payto, strip_signature, wrong_network: all hit
 *     /verify. /verify runs the SAME validation path /settle does (both call
 *     into @x402/stellar's ExactStellarScheme#verify internally), so
 *     verification alone is enough to demonstrate the refusal, without
 *     attempting to move funds for a payload that's deliberately broken —
 *     the more conservative and correct choice.
 *   - replay: is the ONE exception. /verify was directly tested live by
 *     calling it TWICE with the exact same, untouched armed payload — both
 *     calls returned {"isValid":true}. /verify re-simulates from scratch
 *     every time and never checks "was this already used" — it has no
 *     concept of nonce consumption. Only /settle actually submits the
 *     transaction to the network, which is what consumes the real on-chain
 *     nonce (the Soroban auth-entry nonce / account sequence number). So
 *     replay is demonstrated by: /settle once for real (a genuine payment —
 *     this DOES spend real testnet funds, once, deliberately, as the only
 *     way to have something to replay against), then /settle AGAIN with the
 *     exact same payload. This was directly observed live: the first
 *     /settle succeeded (success:true, a real settlementTx), the second
 *     failed with errorReason "invalid_exact_stellar_payload_simulation_failed"
 *     — one of the codes the investigation predicted as plausible.
 *
 * SECURITY: the secret key is read once, here, from the session cookie
 * (server-side only), passed directly into createEd25519Signer(), and never
 * assigned to any other variable, logged, or placed into any streamed event
 * or the armed payload itself (the armed payload is a SIGNED payload, not
 * the secret — a signed Soroban auth entry cannot be reversed into the
 * secret key that produced it). See
 * app/api/attack/payment/payment.secret-leak.test.ts.
 *
 * WIRE FORMAT — NDJSON, same philosophy as /api/pay and /api/verify-ownership:
 *   {"step":"armed","status":"active"}
 *   {"step":"armed","status":"done","publicKey":...}   — no secret, no XDR of the untampered original (attacks below show their own corrupted XDRs)
 *   {"step":"armed","status":"error","message":...}
 *   {"step":"attack","status":"active","attackId":...}
 *   {"step":"attack","status":"done","attackId":...,"result":StoredAttackResult}
 *   {"step":"attack","status":"error","attackId":...,"message":...}
 *   {"step":"complete","status":"done","results":StoredAttackResult[]}
 *   {"step":"complete","status":"error","error":...,"message":...}
 */

const NETWORK = "stellar:testnet";
const FETCH_TIMEOUT_MS = 30_000;

const NDJSON_HEADERS: HeadersInit = {
  "content-type": "application/x-ndjson; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};

interface AttackOutcome {
  attackId: string;
  endpoint: "/verify" | "/settle";
  attemptedAt: number;
  checkMethod: "reason_code" | "http_status";
  httpStatus?: number;
  reasonCode?: string;
  expectedCodes: string[];
  passed: boolean;
  rawResponse: unknown;
}

type StreamEvent =
  | { step: "armed"; status: "active" }
  | { step: "armed"; status: "done"; publicKey: string }
  | { step: "armed"; status: "error"; message: string }
  | { step: "attack"; status: "active"; attackId: string }
  | { step: "attack"; status: "done"; attackId: string; result: AttackOutcome }
  | { step: "attack"; status: "error"; attackId: string; message: string }
  | { step: "complete"; status: "done"; results: AttackOutcome[] }
  | { step: "complete"; status: "error"; error: string; message: string };

function encodeEvent(event: StreamEvent): string {
  return `${JSON.stringify(event)}\n`;
}

function jsonError(status: number, error: string, message: string) {
  return Response.json({ error, message }, { status });
}

async function callFacilitator(
  path: "/verify" | "/settle",
  paymentPayload: unknown,
  paymentRequirements: unknown,
): Promise<{ status: number; body: unknown }> {
  const url = `${FACILITATOR_URL.replace(/\/+$/, "")}${path}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ paymentPayload, paymentRequirements }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = await res.text().catch(() => "");
  }
  return { status: res.status, body };
}

/** Extracts a reason code from a /verify or /settle JSON body, whichever
 *  field it landed in (invalidReason for /verify, errorReason for /settle). */
function extractReasonCode(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const b = body as Record<string, unknown>;
  if (typeof b.invalidReason === "string") return b.invalidReason;
  if (typeof b.errorReason === "string") return b.errorReason;
  return undefined;
}

export async function POST(req: Request): Promise<Response> {
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

  // Read once, passed directly into the signer. Never assigned to any other
  // variable, logged, or placed into any streamed event.
  const secretKey = session.secretKey;
  const publicKey = session.publicKey;

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      function emit(event: StreamEvent) {
        controller.enqueue(encoder.encode(encodeEvent(event)));
      }

      try {
        // -------------------------------------------------------------
        // Arm the bench: one real, validly-signed payload.
        // -------------------------------------------------------------
        emit({ step: "armed", status: "active" });

        const resourceUrl = `${SELLER_URL.replace(/\/+$/, "")}/quote`;
        const signer = createEd25519Signer(secretKey, NETWORK);
        const client = new x402Client().register(NETWORK, new ExactStellarScheme(signer));
        const http = new x402HTTPClient(client);

        let unpaid: Response;
        try {
          unpaid = await fetch(resourceUrl, { signal: AbortSignal.timeout(90_000) });
        } catch (err) {
          const message = `Could not reach the demo resource to arm the bench: ${err instanceof Error ? err.message : String(err)}`;
          emit({ step: "armed", status: "error", message });
          emit({ step: "complete", status: "error", error: "no_challenge", message });
          controller.close();
          return;
        }
        if (unpaid.status !== 402) {
          void unpaid.body?.cancel?.().catch(() => {});
          const message = `Expected a 402 payment challenge from the resource, got HTTP ${unpaid.status}.`;
          emit({ step: "armed", status: "error", message });
          emit({ step: "complete", status: "error", error: "no_challenge", message });
          controller.close();
          return;
        }
        const required = http.getPaymentRequiredResponse((name) => unpaid.headers.get(name), undefined);
        const req0 = required.accepts?.find((a) => a.network === NETWORK && a.scheme === "exact");
        if (!req0) {
          const message = `The resource has no ${NETWORK} "exact" payment option available.`;
          emit({ step: "armed", status: "error", message });
          emit({ step: "complete", status: "error", error: "no_requirement", message });
          controller.close();
          return;
        }

        let paymentPayload: Record<string, unknown>;
        try {
          paymentPayload = (await client.createPaymentPayload(required)) as unknown as Record<string, unknown>;
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          const message = `Could not build the armed payment (commonly: no trustline to the asset, or an empty balance): ${detail}`;
          emit({ step: "armed", status: "error", message });
          emit({ step: "complete", status: "error", error: "build_failed", message });
          controller.close();
          return;
        }

        const armed: ArmedPayload = {
          paymentPayload,
          paymentRequirements: req0 as unknown as Record<string, unknown>,
        };
        emit({ step: "armed", status: "done", publicKey });

        const results: AttackOutcome[] = [];

        async function runAttack(
          attackId: string,
          endpoint: "/verify" | "/settle",
          corrupted: ArmedPayload,
          checkMethod: "reason_code" | "http_status",
          expectedCodes: string[],
          expectedHttpStatus?: number,
        ) {
          emit({ step: "attack", status: "active", attackId });
          const attemptedAt = Date.now();
          try {
            const { status, body } = await callFacilitator(
              endpoint,
              corrupted.paymentPayload,
              corrupted.paymentRequirements,
            );
            const reasonCode = extractReasonCode(body);
            const passed =
              checkMethod === "http_status"
                ? status === expectedHttpStatus
                : reasonCode !== undefined && expectedCodes.includes(reasonCode);
            const outcome: AttackOutcome = {
              attackId,
              endpoint,
              attemptedAt,
              checkMethod,
              httpStatus: status,
              reasonCode,
              expectedCodes,
              passed,
              rawResponse: body,
            };
            results.push(outcome);
            emit({ step: "attack", status: "done", attackId, result: outcome });
          } catch (err) {
            const message = `Attack "${attackId}" failed to reach the facilitator: ${err instanceof Error ? err.message : String(err)}`;
            emit({ step: "attack", status: "error", attackId, message });
          }
        }

        // 1. tamper_amount
        {
          const corruptedXdr = tamperAmount(getArmedXdr(armed.paymentPayload));
          await runAttack(
            "tamper_amount",
            "/verify",
            withCorruptedXdr(armed, corruptedXdr),
            "reason_code",
            ["invalid_exact_stellar_payload_wrong_amount"],
          );
        }

        // 2. redirect_payto
        {
          const corruptedXdr = redirectPayTo(getArmedXdr(armed.paymentPayload));
          await runAttack(
            "redirect_payto",
            "/verify",
            withCorruptedXdr(armed, corruptedXdr),
            "reason_code",
            ["invalid_exact_stellar_payload_wrong_recipient"],
          );
        }

        // 3. strip_signature
        {
          const corruptedXdr = stripSignature(getArmedXdr(armed.paymentPayload));
          await runAttack(
            "strip_signature",
            "/verify",
            withCorruptedXdr(armed, corruptedXdr),
            "reason_code",
            ["invalid_exact_stellar_payload_no_auth_entries"],
          );
        }

        // 4. wrong_network
        {
          const corrupted = wrongNetwork(armed);
          await runAttack("wrong_network", "/verify", corrupted, "http_status", [], 500);
        }

        // 5. replay — the documented exception: hits /settle twice (a real
        // settlement, then the exact same payload replayed). See the module
        // doc comment above for why /verify cannot demonstrate this.
        {
          const attemptedAt = Date.now();
          emit({ step: "attack", status: "active", attackId: "replay" });
          try {
            const first = await callFacilitator("/settle", armed.paymentPayload, armed.paymentRequirements);
            const second = await callFacilitator("/settle", armed.paymentPayload, armed.paymentRequirements);
            const reasonCode = extractReasonCode(second.body);
            const expectedCodes = [
              "invalid_exact_stellar_signature_expiration_too_far",
              "invalid_exact_stellar_payload_simulation_failed",
              "settle_exact_stellar_transaction_submission_failed",
              "settle_exact_stellar_transaction_failed",
            ];
            const passed = reasonCode !== undefined && expectedCodes.includes(reasonCode);
            const outcome: AttackOutcome = {
              attackId: "replay",
              endpoint: "/settle",
              attemptedAt,
              checkMethod: "reason_code",
              httpStatus: second.status,
              reasonCode,
              expectedCodes,
              passed,
              rawResponse: { first: first.body, second: second.body },
            };
            results.push(outcome);
            emit({ step: "attack", status: "done", attackId: "replay", result: outcome });
          } catch (err) {
            const message = `Attack "replay" failed to reach the facilitator: ${err instanceof Error ? err.message : String(err)}`;
            emit({ step: "attack", status: "error", attackId: "replay", message });
          }
        }

        emit({ step: "complete", status: "done", results });
        controller.close();
      } catch (err) {
        console.error("POST /api/attack/payment stream failed unexpectedly:", err);
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
  for (const cookie of scratch.headers.getSetCookie()) {
    headers.append("set-cookie", cookie);
  }
  return new Response(stream, { status: 200, headers });
}

// GET is intentionally unsupported — same convention as /api/verify-ownership
// and /api/pay: this always performs a fresh live run, a POST-shaped action.
export async function GET(): Promise<Response> {
  return jsonError(405, "method_not_allowed", "Use POST to run the payment-attack bench.");
}
