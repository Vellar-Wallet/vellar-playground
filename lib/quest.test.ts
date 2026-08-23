import { describe, expect, it } from "vitest";
import { isCorrectLevel5Answer, ownershipStateFromProof, proofMatchesKnownOwnershipState } from "./quest";

describe("lib/quest: isCorrectLevel5Answer", () => {
  it("accepts the canonical phrasing, case-insensitively", () => {
    expect(isCorrectLevel5Answer("It cannot displace the verified binding.")).toBe(true);
    expect(isCorrectLevel5Answer("IT CANNOT DISPLACE THE VERIFIED BINDING")).toBe(true);
  });

  it("accepts real-world phrasing variants a real user might type", () => {
    expect(isCorrectLevel5Answer("it can't displace the verified binding")).toBe(true);
    expect(isCorrectLevel5Answer("It cant displace it")).toBe(true);
    expect(isCorrectLevel5Answer("Nothing — the binding is permanent")).toBe(true);
    expect(isCorrectLevel5Answer("the binding stays verified forever")).toBe(true);
    expect(isCorrectLevel5Answer("It gets rejected, the original owner stays verified")).toBe(true);
    expect(isCorrectLevel5Answer("the later settlement cannot override the binding")).toBe(true);
    expect(isCorrectLevel5Answer("It has no effect on the verified resource")).toBe(true);
  });

  it("tolerates punctuation and whitespace noise", () => {
    expect(isCorrectLevel5Answer("  It   CAN'T    displace   the verified binding!!!  ")).toBe(true);
    expect(isCorrectLevel5Answer("it, cannot, displace, it.")).toBe(true);
  });

  it("rejects wrong answers", () => {
    expect(isCorrectLevel5Answer("the new address takes over ownership")).toBe(false);
    expect(isCorrectLevel5Answer("the binding updates to the new payer")).toBe(false);
    expect(isCorrectLevel5Answer("it becomes unverified")).toBe(false);
    expect(isCorrectLevel5Answer("I don't know")).toBe(false);
    expect(isCorrectLevel5Answer("42")).toBe(false);
  });

  it("rejects empty or whitespace-only input", () => {
    expect(isCorrectLevel5Answer("")).toBe(false);
    expect(isCorrectLevel5Answer("   ")).toBe(false);
  });
});

describe("lib/quest: ownership-state proof matching", () => {
  it("matches the real 'already verified' verdict text to ownershipState 'verified'", () => {
    const proof = "Confirmed — already verified. This resource was proven earlier and that verdict is permanent.";
    expect(proofMatchesKnownOwnershipState(proof)).toBe(true);
    expect(ownershipStateFromProof(proof)).toBe("verified");
  });

  it("matches the real fresh-match verdict text to ownershipState 'proven-unconfirmed'", () => {
    const proof = "Match — the seller's challenge names the bound address.";
    expect(proofMatchesKnownOwnershipState(proof)).toBe(true);
    expect(ownershipStateFromProof(proof)).toBe("proven-unconfirmed");
  });

  it("matches the real no-match verdict text to ownershipState 'unverified'", () => {
    const proof =
      "No match — the seller's challenge does not currently name the bound address. This is unexpected for the demo resource; it may indicate a transient issue or that the catalog and the live challenge are momentarily out of sync.";
    expect(proofMatchesKnownOwnershipState(proof)).toBe(true);
    expect(ownershipStateFromProof(proof)).toBe("unverified");
  });

  it("rejects an arbitrary string that isn't traceable to any real verdict text", () => {
    expect(proofMatchesKnownOwnershipState("some random string")).toBe(false);
    expect(ownershipStateFromProof("some random string")).toBeNull();
    // Even a string that merely CONTAINS the word "verified" somewhere but
    // doesn't match a known verdict prefix should not pass — this proves the
    // check is prefix-based against real verdict text, not a loose substring
    // test for the word "verified" anywhere in the string.
    expect(proofMatchesKnownOwnershipState("this is definitely verified, trust me")).toBe(false);
  });
});
