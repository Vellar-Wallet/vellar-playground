/**
 * Station 3 — the payment-attack track's "arm the bench" step and its five
 * deliberate corruptions.
 *
 * "Arming" builds ONE real, validly-signed x402 Stellar payment payload,
 * using the EXACT SAME mechanism lib/pay.ts's attemptPayment() uses
 * (createEd25519Signer, x402Client, ExactStellarScheme,
 * client.createPaymentPayload(required) against a real 402 challenge from
 * the demo seller) — this is the template a real payment is built from, so
 * it is also the template a deliberately corrupted payment is built from.
 *
 * Each corruption function below takes the armed payload's raw XDR string
 * and returns a FRESH, independently corrupted XDR string — the caller is
 * responsible for taking a fresh copy of the armed payload per attack (see
 * app/api/attack/payment/route.ts), never mutating and reusing one
 * corrupted copy for a second attack.
 *
 * MECHANISM, confirmed against the facilitator's real source
 * (@x402/stellar's exact/facilitator/index.mjs, read directly — see the
 * task report) and confirmed LIVE against the real hosted facilitator
 * before this file was written:
 *   - The facilitator parses the XDR as a TransactionEnvelope, reads the
 *     single invokeHostFunction operation, and inspects the `transfer(from,
 *     to, amount)` contract-invocation ARGS directly — this happens BEFORE
 *     signature/auth validation, so tampering the args without re-signing
 *     is caught by the args check, not (only) by a signature mismatch.
 *   - auth entries are checked separately (validateAuthEntries): an empty
 *     `auth` array is refused outright with invalid_exact_stellar_payload_no_auth_entries.
 * None of this is re-signed after tampering — the whole point is that the
 * original signature no longer matches the tampered args (or, for
 * strip_signature, there is no auth entry to check at all).
 *
 * SECURITY: this module never touches a secret key — it only ever receives
 * an already-signed XDR string (no signing capability) and returns a
 * mutated XDR string. The signer/secret key lives only in
 * app/api/attack/payment/route.ts's arming step, exactly like /api/pay.
 */

import { xdr, nativeToScVal, scValToNative } from "@stellar/stellar-sdk";

/** The armed payload's raw building blocks — plain data, no secret. */
export interface ArmedPayload {
  /** The full x402 PaymentPayload object exactly as client.createPaymentPayload()
   *  returned it (includes `payload.transaction`, the base64 XDR). */
  paymentPayload: Record<string, unknown>;
  /** The single matched PaymentRequirements this payload was built against. */
  paymentRequirements: Record<string, unknown>;
}

function getXdr(paymentPayload: Record<string, unknown>): string {
  const inner = paymentPayload.payload as Record<string, unknown> | undefined;
  const tx = inner?.transaction;
  if (typeof tx !== "string" || tx.length === 0) {
    throw new Error("armed payload has no payload.transaction XDR to corrupt");
  }
  return tx;
}

function withXdr(paymentPayload: Record<string, unknown>, newXdr: string): Record<string, unknown> {
  const inner = (paymentPayload.payload as Record<string, unknown> | undefined) ?? {};
  return { ...paymentPayload, payload: { ...inner, transaction: newXdr } };
}

/** Reads the single invokeHostFunction operation out of a transaction
 *  envelope XDR string. Throws if the shape doesn't match what an armed
 *  x402 Stellar payload always has (exactly one invokeHostFunction op) —
 *  this should never happen for a payload this module itself armed. */
function getInvokeHostFunctionOp(envelope: xdr.TransactionEnvelope): {
  op: xdr.Operation;
  invokeHostFunctionOp: xdr.InvokeHostFunctionOp;
} {
  const tx = envelope.v1().tx();
  const ops = tx.operations();
  if (ops.length !== 1) throw new Error("expected exactly one operation in the armed payload's XDR");
  const op = ops[0];
  const body = op.body();
  if (body.switch().name !== "invokeHostFunction") {
    throw new Error("expected an invokeHostFunction operation in the armed payload's XDR");
  }
  return { op, invokeHostFunctionOp: body.invokeHostFunctionOp() };
}

/**
 * attack 1: tamper_amount — decode the XDR, find the transfer(from, to,
 * amount) invocation args, change `amount`, re-serialize. Not re-signed.
 */
export function tamperAmount(armedXdr: string): string {
  const envelope = xdr.TransactionEnvelope.fromXDR(armedXdr, "base64");
  const { op, invokeHostFunctionOp } = getInvokeHostFunctionOp(envelope);
  const invokeArgs = invokeHostFunctionOp.hostFunction().invokeContract();
  const args = invokeArgs.args();
  const amount = scValToNative(args[2]) as bigint;
  const tamperedAmount = amount + BigInt(1); // any different value demonstrates the mismatch
  const newArgs = [args[0], args[1], nativeToScVal(tamperedAmount, { type: "i128" })];
  const newInvokeArgs = new xdr.InvokeContractArgs({
    contractAddress: invokeArgs.contractAddress(),
    functionName: invokeArgs.functionName(),
    args: newArgs,
  });
  const newHostFunction = xdr.HostFunction.hostFunctionTypeInvokeContract(newInvokeArgs);
  const newOp = new xdr.InvokeHostFunctionOp({
    hostFunction: newHostFunction,
    auth: invokeHostFunctionOp.auth(),
  });
  op.body(xdr.OperationBody.invokeHostFunction(newOp));
  return envelope.toXDR("base64");
}

/**
 * attack 2: redirect_payto — same mechanism, change the `to` arg instead.
 * The substituted address is a real, distinct, non-facilitator Stellar
 * account (the testnet USDC issuer — a real, unrelated public address, not
 * a fabricated string) so the facilitator's own recipient-mismatch check is
 * what catches this, not "not a valid address".
 */
const DIFFERENT_RECIPIENT = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

export function redirectPayTo(armedXdr: string): string {
  const envelope = xdr.TransactionEnvelope.fromXDR(armedXdr, "base64");
  const { op, invokeHostFunctionOp } = getInvokeHostFunctionOp(envelope);
  const invokeArgs = invokeHostFunctionOp.hostFunction().invokeContract();
  const args = invokeArgs.args();
  const newToScVal = nativeToScVal(DIFFERENT_RECIPIENT, { type: "address" });
  const newArgs = [args[0], newToScVal, args[2]];
  const newInvokeArgs = new xdr.InvokeContractArgs({
    contractAddress: invokeArgs.contractAddress(),
    functionName: invokeArgs.functionName(),
    args: newArgs,
  });
  const newHostFunction = xdr.HostFunction.hostFunctionTypeInvokeContract(newInvokeArgs);
  const newOp = new xdr.InvokeHostFunctionOp({
    hostFunction: newHostFunction,
    auth: invokeHostFunctionOp.auth(),
  });
  op.body(xdr.OperationBody.invokeHostFunction(newOp));
  return envelope.toXDR("base64");
}

/**
 * attack 3: strip_signature — decode the XDR, set the invokeHostFunction
 * operation's `auth` array to empty, re-serialize.
 */
export function stripSignature(armedXdr: string): string {
  const envelope = xdr.TransactionEnvelope.fromXDR(armedXdr, "base64");
  const { op, invokeHostFunctionOp } = getInvokeHostFunctionOp(envelope);
  const newOp = new xdr.InvokeHostFunctionOp({
    hostFunction: invokeHostFunctionOp.hostFunction(),
    auth: [],
  });
  op.body(xdr.OperationBody.invokeHostFunction(newOp));
  return envelope.toXDR("base64");
}

/**
 * attack 5: wrong_network — no XDR corruption at all (the armed payload's
 * signed transaction stays byte-for-byte real). Only `paymentRequirements.
 * network` (and, for symmetry, `paymentPayload.accepted.network`, though the
 * facilitator's dispatch reads paymentRequirements.network — see the route's
 * doc comment) is swapped to an unregistered CAIP-2 network id. Returns a
 * full corrupted {paymentPayload, paymentRequirements} pair rather than just
 * an XDR string, since this attack corrupts the requirements, not the XDR.
 */
export function wrongNetwork(armed: ArmedPayload, unregisteredNetwork = "eip155:1"): ArmedPayload {
  const accepted = armed.paymentPayload.accepted as Record<string, unknown> | undefined;
  return {
    paymentPayload: {
      ...armed.paymentPayload,
      ...(accepted ? { accepted: { ...accepted, network: unregisteredNetwork } } : {}),
    },
    paymentRequirements: { ...armed.paymentRequirements, network: unregisteredNetwork },
  };
}

/** Convenience: build a corrupted ArmedPayload from a corrupted XDR string,
 *  for the three XDR-level attacks (tamper_amount/redirect_payto/
 *  strip_signature) — keeps paymentRequirements untouched, only the
 *  transaction XDR inside paymentPayload changes. */
export function withCorruptedXdr(armed: ArmedPayload, corruptedXdr: string): ArmedPayload {
  return {
    paymentPayload: withXdr(armed.paymentPayload, corruptedXdr),
    paymentRequirements: armed.paymentRequirements,
  };
}

/** Re-exported for callers that need the raw XDR out of an armed payload
 *  (e.g. to pass into tamperAmount/redirectPayTo/stripSignature). */
export { getXdr as getArmedXdr };
