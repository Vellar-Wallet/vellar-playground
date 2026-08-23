import { describe, expect, it } from "vitest";
import {
  Keypair,
  TransactionBuilder,
  Account,
  Contract,
  nativeToScVal,
  scValToNative,
  xdr,
  Networks,
} from "@stellar/stellar-sdk";
import { tamperAmount, redirectPayTo, stripSignature, wrongNetwork, withCorruptedXdr, getArmedXdr, type ArmedPayload } from "./attack-payment";

// These tests exercise the XDR-manipulation MECHANICS entirely offline (no
// network, no real facilitator, no real signer) — a synthetic but
// structurally real invokeHostFunction transaction, built the same way a
// real x402 Stellar payment is shaped (Contract#call("transfer", from, to,
// amount)). The LIVE behavior against the real facilitator (that these
// corruptions actually produce the predicted reason codes) is covered
// separately by app/api/attack/payment/payment.secret-leak.test.ts's
// end-to-end real run — this file only proves the XDR surgery itself is
// correct and reversible/inspectable.

const ASSET = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const AMOUNT = 1_000_000;

function buildFixtureXdr(): { xdrStr: string; payer: string; payTo: string } {
  const payer = Keypair.random();
  const payTo = Keypair.random();
  const account = new Account(payer.publicKey(), "1");
  const contract = new Contract(ASSET);
  const op = contract.call(
    "transfer",
    nativeToScVal(payer.publicKey(), { type: "address" }),
    nativeToScVal(payTo.publicKey(), { type: "address" }),
    nativeToScVal(AMOUNT, { type: "i128" }),
  );
  const tx = new TransactionBuilder(account, { fee: "1000000", networkPassphrase: Networks.TESTNET })
    .addOperation(op)
    .setTimeout(60)
    .build();
  return { xdrStr: tx.toXDR(), payer: payer.publicKey(), payTo: payTo.publicKey() };
}

/** Synthesizes a structurally-shaped (not cryptographically real) auth entry
 *  onto the fixture's invokeHostFunction op, so stripSignature has something
 *  non-empty to strip. Only the STRUCTURE matters for this unit test — the
 *  live secret-leak test exercises a real, RPC-simulated auth entry. */
function withSyntheticAuthEntry(xdrStr: string): string {
  const envelope = xdr.TransactionEnvelope.fromXDR(xdrStr, "base64");
  const tx = envelope.v1().tx();
  const op = tx.operations()[0];
  const invokeHostFunctionOp = op.body().invokeHostFunctionOp();
  const credentials = xdr.SorobanCredentials.sorobanCredentialsSourceAccount();
  const rootInvocation = new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
      new xdr.InvokeContractArgs({
        contractAddress: invokeHostFunctionOp.hostFunction().invokeContract().contractAddress(),
        functionName: invokeHostFunctionOp.hostFunction().invokeContract().functionName(),
        args: invokeHostFunctionOp.hostFunction().invokeContract().args(),
      }),
    ),
    subInvocations: [],
  });
  const authEntry = new xdr.SorobanAuthorizationEntry({ credentials, rootInvocation });
  const newOp = new xdr.InvokeHostFunctionOp({
    hostFunction: invokeHostFunctionOp.hostFunction(),
    auth: [authEntry],
  });
  op.body(xdr.OperationBody.invokeHostFunction(newOp));
  return envelope.toXDR("base64");
}

describe("lib/attack-payment: tamperAmount", () => {
  it("changes the transfer amount arg and leaves everything else byte-identical in shape", () => {
    const { xdrStr } = buildFixtureXdr();
    const tampered = tamperAmount(xdrStr);
    expect(tampered).not.toBe(xdrStr);

    const envelope = xdr.TransactionEnvelope.fromXDR(tampered, "base64");
    const op = envelope.v1().tx().operations()[0];
    const args = op.body().invokeHostFunctionOp().hostFunction().invokeContract().args();
    const newAmount = scValToNative(args[2]) as bigint;
    expect(newAmount.toString()).toBe((BigInt(AMOUNT) + BigInt(1)).toString());

    // from/to args untouched.
    const original = xdr.TransactionEnvelope.fromXDR(xdrStr, "base64");
    const originalOp = original.v1().tx().operations()[0];
    const originalArgs = originalOp.body().invokeHostFunctionOp().hostFunction().invokeContract().args();
    expect(scValToNative(args[0])).toBe(scValToNative(originalArgs[0]));
    expect(scValToNative(args[1])).toBe(scValToNative(originalArgs[1]));
  });

  it("is idempotent-shaped per call — corrupting a FRESH copy each time never accumulates", () => {
    const { xdrStr } = buildFixtureXdr();
    const first = tamperAmount(xdrStr);
    const second = tamperAmount(xdrStr); // fresh copy, not the already-tampered one
    expect(first).toBe(second);
  });
});

describe("lib/attack-payment: redirectPayTo", () => {
  it("changes the `to` arg to a different address and leaves from/amount untouched", () => {
    const { xdrStr, payTo } = buildFixtureXdr();
    const redirected = redirectPayTo(xdrStr);
    expect(redirected).not.toBe(xdrStr);

    const envelope = xdr.TransactionEnvelope.fromXDR(redirected, "base64");
    const op = envelope.v1().tx().operations()[0];
    const args = op.body().invokeHostFunctionOp().hostFunction().invokeContract().args();
    const newTo = scValToNative(args[1]) as string;
    expect(newTo).not.toBe(payTo);
    expect(newTo).toBe("GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5");

    const amount = scValToNative(args[2]) as bigint;
    expect(amount.toString()).toBe(String(AMOUNT));
  });
});

describe("lib/attack-payment: stripSignature", () => {
  it("empties the auth array on the invokeHostFunction operation", () => {
    const { xdrStr } = buildFixtureXdr();
    const withAuth = withSyntheticAuthEntry(xdrStr);
    const beforeEnvelope = xdr.TransactionEnvelope.fromXDR(withAuth, "base64");
    expect(beforeEnvelope.v1().tx().operations()[0].body().invokeHostFunctionOp().auth().length).toBe(1);

    const stripped = stripSignature(withAuth);
    const afterEnvelope = xdr.TransactionEnvelope.fromXDR(stripped, "base64");
    expect(afterEnvelope.v1().tx().operations()[0].body().invokeHostFunctionOp().auth().length).toBe(0);
  });

  it("leaves the func/args untouched, only auth changes", () => {
    const { xdrStr } = buildFixtureXdr();
    const withAuth = withSyntheticAuthEntry(xdrStr);
    const stripped = stripSignature(withAuth);

    const beforeEnvelope = xdr.TransactionEnvelope.fromXDR(withAuth, "base64");
    const afterEnvelope = xdr.TransactionEnvelope.fromXDR(stripped, "base64");
    const beforeArgs = beforeEnvelope.v1().tx().operations()[0].body().invokeHostFunctionOp().hostFunction().invokeContract().args();
    const afterArgs = afterEnvelope.v1().tx().operations()[0].body().invokeHostFunctionOp().hostFunction().invokeContract().args();
    expect(scValToNative(afterArgs[2])).toBe(scValToNative(beforeArgs[2]));
  });
});

describe("lib/attack-payment: wrongNetwork", () => {
  it("swaps paymentRequirements.network and paymentPayload.accepted.network, leaves the XDR untouched", () => {
    const { xdrStr } = buildFixtureXdr();
    const armed: ArmedPayload = {
      paymentPayload: { payload: { transaction: xdrStr }, accepted: { network: "stellar:testnet", scheme: "exact" } },
      paymentRequirements: { network: "stellar:testnet", scheme: "exact", payTo: "G...", amount: "1000000", asset: ASSET },
    };
    const corrupted = wrongNetwork(armed, "eip155:1");
    expect(corrupted.paymentRequirements.network).toBe("eip155:1");
    expect((corrupted.paymentPayload.accepted as Record<string, unknown>).network).toBe("eip155:1");
    // The XDR itself is byte-for-byte untouched — this attack corrupts the
    // requirements only, never the signed transaction.
    expect(getArmedXdr(corrupted.paymentPayload)).toBe(xdrStr);
  });

  it("does not mutate the original armed payload object", () => {
    const armed: ArmedPayload = {
      paymentPayload: { payload: { transaction: "AAAA" }, accepted: { network: "stellar:testnet" } },
      paymentRequirements: { network: "stellar:testnet" },
    };
    wrongNetwork(armed);
    expect(armed.paymentRequirements.network).toBe("stellar:testnet");
    expect((armed.paymentPayload.accepted as Record<string, unknown>).network).toBe("stellar:testnet");
  });
});

describe("lib/attack-payment: withCorruptedXdr", () => {
  it("replaces only payload.transaction, keeps paymentRequirements untouched", () => {
    const armed: ArmedPayload = {
      paymentPayload: { payload: { transaction: "ORIGINAL" }, accepted: { network: "stellar:testnet" } },
      paymentRequirements: { network: "stellar:testnet", payTo: "G..." },
    };
    const result = withCorruptedXdr(armed, "CORRUPTED");
    expect(getArmedXdr(result.paymentPayload)).toBe("CORRUPTED");
    expect(result.paymentRequirements).toEqual(armed.paymentRequirements);
    // Original untouched.
    expect(getArmedXdr(armed.paymentPayload)).toBe("ORIGINAL");
  });
});

describe("lib/attack-payment: getArmedXdr", () => {
  it("throws a clear error when there is no payload.transaction to corrupt", () => {
    expect(() => getArmedXdr({})).toThrow(/no payload\.transaction/);
    expect(() => getArmedXdr({ payload: {} })).toThrow(/no payload\.transaction/);
  });
});
