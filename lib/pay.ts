/**
 * Server-side x402 payment logic — ported from
 * vellar-facilitator/examples/buyer-classic.mjs, adapted from a CLI script
 * (env-var secret, process.exit) to a Next.js server context (session-cookie
 * secret, thrown errors a route handler turns into HTTP responses).
 *
 * Per that file's own header comment ("copy this file, not the mechanics
 * underneath it"), the actual protocol calls are untouched: the same
 * `@x402/core` + `@x402/stellar` official client, the same
 * GET → 402 → createPaymentPayload → retry-with-header flow.
 *
 * SECURITY: `secretKey` is used only to construct a signer in-process. It is
 * never logged, never included in any returned value, and this module has no
 * access to an HTTP response object to accidentally leak it into.
 */

import { x402Client } from "@x402/core/client";
import { x402HTTPClient } from "@x402/core/http";
import { ExactStellarScheme } from "@x402/stellar/exact/client";
import { createEd25519Signer } from "@x402/stellar";

const NETWORK = "stellar:testnet";
const FETCH_TIMEOUT_MS = 30_000;

export interface PayResult {
  settlementTx: string;
  payer?: string;
  network?: string;
  amount?: string;
  asset?: string;
  payTo?: string;
}

/**
 * Errors thrown by attemptPayment are always safe to read `.message` from
 * and show to an HTTP caller — never the underlying cause (which may embed
 * request/response detail from the seller or facilitator, but never the
 * secret key, since the secret key never appears in any object this module
 * touches other than the signer it constructs internally).
 */
export class PaymentError extends Error {
  /** Machine-readable category, used by the route handler to pick a status code. */
  code: "no_challenge" | "no_requirement" | "build_failed" | "not_settled";
  constructor(code: PaymentError["code"], message: string) {
    super(message);
    this.code = code;
    this.name = "PaymentError";
  }
}

/**
 * One full attempt of the GET → 402 → pay → retry flow against `resourceUrl`,
 * signing with `secretKey`. Throws `PaymentError` on any failure — callers
 * that want the "retry the whole flow with a fresh payload" behavior
 * buyer-classic.mjs describes (ledger-expiry-based signatures, so a stale
 * payload can't be reused) should call this again from scratch rather than
 * retrying any sub-step.
 */
export async function attemptPayment(secretKey: string, resourceUrl: string): Promise<PayResult> {
  const signer = createEd25519Signer(secretKey, NETWORK);
  const client = new x402Client().register(NETWORK, new ExactStellarScheme(signer));
  const http = new x402HTTPClient(client);

  // 1. Unpaid request → expect 402 with payment requirements in the
  //    PAYMENT-REQUIRED header (the body is intentionally empty — see
  //    seller.mjs's own handling of the unpaid-challenge case).
  let unpaid: Response;
  try {
    unpaid = await fetch(resourceUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (err) {
    throw new PaymentError(
      "no_challenge",
      `Could not reach the resource to start the payment: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (unpaid.status !== 402) {
    throw new PaymentError(
      "no_challenge",
      `Expected a 402 payment challenge from the resource, got HTTP ${unpaid.status}.`,
    );
  }

  const required = http.getPaymentRequiredResponse((name) => unpaid.headers.get(name), undefined);
  const req = required.accepts?.find((a) => a.network === NETWORK && a.scheme === "exact");
  if (!req) {
    throw new PaymentError("no_requirement", `The resource has no ${NETWORK} "exact" payment option available.`);
  }

  // 2. Build + sign the payment. Ledger-expiry-based signatures — never
  //    cache/reuse across attempts, always build fresh (buyer-classic.mjs's
  //    own comment).
  let payload;
  try {
    payload = await client.createPaymentPayload(required);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new PaymentError(
      "build_failed",
      `Could not build the payment (commonly: no trustline to the asset, or an empty balance): ${detail}`,
    );
  }

  // 3. Retry the request with the payment attached.
  let paid: Response;
  try {
    paid = await fetch(resourceUrl, {
      headers: http.encodePaymentSignatureHeader(payload),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    throw new PaymentError(
      "not_settled",
      `The paid request failed to reach the resource: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const body = (await paid.json().catch(() => ({}))) as {
    settlement?: { transaction?: string; payer?: string; network?: string };
    error?: string;
    detail?: unknown;
  };

  if (paid.status !== 200) {
    // Per buyer-classic.mjs: "Roughly one settle in three fails on testnet
    // with an empty transaction. Nothing was spent — retry the whole flow,
    // signing a fresh payload." The route handler is responsible for that
    // whole-flow retry; this function just reports the failure plainly.
    const detail = body?.detail ? ` (${JSON.stringify(body.detail)})` : "";
    throw new PaymentError("not_settled", `Payment did not settle: HTTP ${paid.status}${detail}`);
  }

  const tx = body.settlement?.transaction;
  if (!tx) {
    throw new PaymentError("not_settled", "Payment response was HTTP 200 but had no settlement transaction.");
  }

  return {
    settlementTx: tx,
    payer: body.settlement?.payer,
    network: body.settlement?.network,
    amount: req.amount,
    asset: req.asset,
    payTo: req.payTo,
  };
}
