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
 * never logged, never included in any returned value or emitted progress
 * event, and this module has no access to an HTTP response object to
 * accidentally leak it into.
 *
 * PROGRESS EVENTS — added for the streaming /api/pay redesign (Station 1):
 * `attemptPayment` now takes an optional `onEvent` callback invoked once for
 * every real underlying step as it genuinely happens (no cosmetic timing —
 * see each call site below). This is additive: every prior caller/behavior
 * (return `PayResult`, throw `PaymentError`) is unchanged; `onEvent` is
 * simply an extra tap on the same sequence of real network calls. See
 * `PayProgressEvent` for the exact event shapes the route handler streams to
 * the client, and app/api/pay/route.ts for how they're turned into NDJSON.
 */

import { x402Client } from "@x402/core/client";
import { x402HTTPClient } from "@x402/core/http";
import { ExactStellarScheme } from "@x402/stellar/exact/client";
import { createEd25519Signer } from "@x402/stellar";
import { fetchWithColdStartNotice } from "@/lib/fetch-with-cold-start-notice";

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

// ---------------------------------------------------------------------------
// Progress events
// ---------------------------------------------------------------------------
//
// One `attemptPayment()` call emits, in this exact order (all real, none
// fabricated — see inline comments at each emit site below):
//   get_request   (active, then done — the real unpaid GET + its 402)
//   challenge     (done only — derived from get_request's decoded 402, no
//                  separate network call, emitted immediately after)
//   sign          (active, then done or error — the real createPaymentPayload call)
//   verify        (done only — no network call of its own, see route doc)
//   settle        (active, then done or error — the real paid retry request)
//
// "waking_up" is emitted separately (zero or more times) only around the
// step-1 GET, if the seller hasn't responded within 5s — see
// `fetchWithColdStartNotice` below.

export type PayStepName = "get_request" | "challenge" | "sign" | "verify" | "settle";
export type PayStepStatus = "active" | "done" | "error";

export interface DecodedPaymentRequired {
  x402Version: number;
  error?: string;
  resource?: { url: string; description?: string; mimeType?: string };
  accepts: Array<{
    scheme: string;
    network: string;
    asset: string;
    amount: string;
    payTo: string;
    maxTimeoutSeconds: number;
    extra?: Record<string, unknown>;
  }>;
  extensions?: Record<string, unknown>;
}

export type PayProgressEvent =
  | { step: "waking_up"; status: "active" }
  | { step: "get_request"; status: "active"; requestLine: string }
  | {
      step: "get_request";
      status: "done";
      requestLine: string;
      responseStatus: number;
      rawPaymentRequiredHeader: string;
      decoded: DecodedPaymentRequired;
    }
  | { step: "get_request"; status: "error"; message: string }
  | {
      step: "challenge";
      status: "done";
      amount: string;
      asset: string;
      payTo: string;
      scheme: string;
      network: string;
      maxTimeoutSeconds: number;
    }
  | { step: "sign"; status: "active" }
  | { step: "sign"; status: "done"; xdr: string; note: string }
  | { step: "sign"; status: "error"; message: string }
  | {
      step: "verify";
      status: "done";
      paymentPayload: unknown;
      paymentRequirements: unknown;
      responseNote: string;
    }
  | { step: "settle"; status: "active"; requestNote: string }
  | { step: "settle"; status: "done"; settlementTx: string; payer?: string; network?: string; body: unknown }
  | { step: "settle"; status: "error"; message: string };

export type OnPayEvent = (event: PayProgressEvent) => void;

/**
 * A Soroban auth entry (what `sign` actually signs here) is not a full
 * classic Stellar transaction envelope: `AssembledTransaction.build()` is
 * called with no source-account `publicKey`, so simulation runs against the
 * SDK's NULL_ACCOUNT rather than the payer's own account, and what gets
 * signed is the SEP-41 `transfer` invocation's auth entry — not a
 * transaction the payer is the source of. See buyer-classic.mjs's own header
 * comment ("NO SEPARATE SIMULATION SOURCE IS NEEDED") for why: the official
 * client never makes the payer the transaction source, so there is no
 * classic-transaction signature here at all, only an auth-entry signature
 * over the contract invocation.
 */
const SIGN_STEP_NOTE =
  "This signs a Soroban auth entry authorizing the SEP-41 transfer call — not a classic Stellar transaction. " +
  "The payment is simulated against a null source account (no separate account pays/simulates this), so the " +
  "payer's signature applies only to the transfer invocation's auth entry, not to a transaction envelope.";

const VERIFY_RESPONSE_NOTE =
  "Response shown is what the seller received from the facilitator — the playground only observes the seller's final result.";

/**
 * One full attempt of the GET → 402 → pay → retry flow against `resourceUrl`,
 * signing with `secretKey`. Throws `PaymentError` on any failure — callers
 * that want the "retry the whole flow with a fresh payload" behavior
 * buyer-classic.mjs describes (ledger-expiry-based signatures, so a stale
 * payload can't be reused) should call this again from scratch rather than
 * retrying any sub-step.
 *
 * `onEvent`, if provided, is invoked synchronously at each real step
 * boundary (see `PayProgressEvent`). It never receives the secret key.
 *
 * `getTimeoutMs` bounds the initial (step 1) unpaid GET specifically — the
 * "is the seller asleep" call. It defaults to the same 30s as every other
 * fetch in this module; the route handler overrides it to 90s to give a cold
 * Render.com free-tier instance room to wake up (see that route's doc
 * comment). Every other fetch in this function keeps the standard
 * `FETCH_TIMEOUT_MS` regardless of this parameter.
 */
export async function attemptPayment(
  secretKey: string,
  resourceUrl: string,
  options?: { onEvent?: OnPayEvent; getTimeoutMs?: number; coldStartAfterMs?: number },
): Promise<PayResult> {
  const onEvent = options?.onEvent;
  const getTimeoutMs = options?.getTimeoutMs ?? FETCH_TIMEOUT_MS;
  const coldStartAfterMs = options?.coldStartAfterMs ?? 5_000;

  const signer = createEd25519Signer(secretKey, NETWORK);
  const client = new x402Client().register(NETWORK, new ExactStellarScheme(signer));
  const http = new x402HTTPClient(client);

  // -------------------------------------------------------------------
  // Step 1: GET the seller URL (unpaid). Expect 402 with payment
  // requirements in the PAYMENT-REQUIRED header (the body is intentionally
  // empty — see seller.mjs's own handling of the unpaid-challenge case).
  // -------------------------------------------------------------------
  const requestLine = `GET ${resourceUrl}`;
  onEvent?.({ step: "get_request", status: "active", requestLine });

  let unpaid: Response;
  try {
    unpaid = await fetchWithColdStartNotice(resourceUrl, {}, getTimeoutMs, coldStartAfterMs, () =>
      onEvent?.({ step: "waking_up", status: "active" }),
    );
  } catch (err) {
    const message = `Could not reach the resource to start the payment: ${err instanceof Error ? err.message : String(err)}`;
    onEvent?.({ step: "get_request", status: "error", message });
    throw new PaymentError("no_challenge", message);
  }
  if (unpaid.status !== 402) {
    const message = `Expected a 402 payment challenge from the resource, got HTTP ${unpaid.status}.`;
    onEvent?.({ step: "get_request", status: "error", message });
    throw new PaymentError("no_challenge", message);
  }

  const rawPaymentRequiredHeader = unpaid.headers.get("PAYMENT-REQUIRED") ?? "";
  const required = http.getPaymentRequiredResponse((name) => unpaid.headers.get(name), undefined);
  onEvent?.({
    step: "get_request",
    status: "done",
    requestLine,
    responseStatus: unpaid.status,
    rawPaymentRequiredHeader,
    decoded: required as unknown as DecodedPaymentRequired,
  });

  const req = required.accepts?.find((a) => a.network === NETWORK && a.scheme === "exact");
  if (!req) {
    const message = `The resource has no ${NETWORK} "exact" payment option available.`;
    throw new PaymentError("no_requirement", message);
  }

  // -------------------------------------------------------------------
  // Step 2: the 402 challenge, parsed from step 1's already-decoded data.
  // No new network call — genuinely derived from what step 1 just fetched,
  // so it's honest for this to land immediately after step 1 resolves.
  // -------------------------------------------------------------------
  onEvent?.({
    step: "challenge",
    status: "done",
    amount: req.amount,
    asset: req.asset,
    payTo: req.payTo,
    scheme: req.scheme,
    network: req.network,
    maxTimeoutSeconds: req.maxTimeoutSeconds,
  });

  // -------------------------------------------------------------------
  // Step 3: build + sign the payment. Ledger-expiry-based signatures —
  // never cache/reuse across attempts, always build fresh (buyer-classic.mjs's
  // own comment).
  // -------------------------------------------------------------------
  onEvent?.({ step: "sign", status: "active" });
  let payload;
  try {
    payload = await client.createPaymentPayload(required);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    const message = `Could not build the payment (commonly: no trustline to the asset, or an empty balance): ${detail}`;
    onEvent?.({ step: "sign", status: "error", message });
    throw new PaymentError("build_failed", message);
  }
  const xdr =
    typeof (payload.payload as Record<string, unknown> | undefined)?.transaction === "string"
      ? ((payload.payload as Record<string, unknown>).transaction as string)
      : "";
  onEvent?.({ step: "sign", status: "done", xdr, note: SIGN_STEP_NOTE });

  // -------------------------------------------------------------------
  // Step 4: "verify" — no new network call (the locked decision: never
  // double-call /settle, and by extension don't independently call /verify
  // either). The request side is real data already held in-process; the
  // response side is intentionally not fabricated — see VERIFY_RESPONSE_NOTE.
  // -------------------------------------------------------------------
  onEvent?.({
    step: "verify",
    status: "done",
    paymentPayload: payload,
    paymentRequirements: req,
    responseNote: VERIFY_RESPONSE_NOTE,
  });

  // -------------------------------------------------------------------
  // Step 5: retry the request with the payment attached — the real paid
  // call, and the real settlement.
  // -------------------------------------------------------------------
  onEvent?.({ step: "settle", status: "active", requestNote: "Sent to the seller, who forwards it to the facilitator's /settle." });
  let paid: Response;
  try {
    paid = await fetch(resourceUrl, {
      headers: http.encodePaymentSignatureHeader(payload),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    const message = `The paid request failed to reach the resource: ${err instanceof Error ? err.message : String(err)}`;
    onEvent?.({ step: "settle", status: "error", message });
    throw new PaymentError("not_settled", message);
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
    const message = `Payment did not settle: HTTP ${paid.status}${detail}`;
    onEvent?.({ step: "settle", status: "error", message });
    throw new PaymentError("not_settled", message);
  }

  const tx = body.settlement?.transaction;
  if (!tx) {
    const message = "Payment response was HTTP 200 but had no settlement transaction.";
    onEvent?.({ step: "settle", status: "error", message });
    throw new PaymentError("not_settled", message);
  }

  onEvent?.({
    step: "settle",
    status: "done",
    settlementTx: tx,
    payer: body.settlement?.payer,
    network: body.settlement?.network,
    body,
  });

  return {
    settlementTx: tx,
    payer: body.settlement?.payer,
    network: body.settlement?.network,
    amount: req.amount,
    asset: req.asset,
    payTo: req.payTo,
  };
}
