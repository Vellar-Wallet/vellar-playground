import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearAll,
  readAttackResults,
  readLastCatalogSearch,
  readLastPayment,
  readQuestProgress,
  readSession,
  writeAttackResult,
  writeLastCatalogSearch,
  writeLastPayment,
  writeQuestLevel,
  writeSession,
  type StoredAttackResult,
  type StoredLastPayment,
  type StoredSession,
} from "./local-storage";

// ---------------------------------------------------------------------------
// This repo's vitest.config.ts runs a plain "node" environment (no jsdom/
// happy-dom installed — confirmed via `ls node_modules` and pnpm-lock.yaml,
// where both only appear as vitest's *optional peer deps*, not installed
// packages). Rather than adding a new devDependency for this one test file,
// this test provides a small, realistic in-memory mock that implements the
// real `Storage` interface (getItem/setItem/removeItem/clear/key/length) and
// installs it as `globalThis.window.localStorage` / `globalThis.localStorage`
// before each test — exactly the surface lib/local-storage.ts's
// `getStorage()` reads. This is the same "construct the real shape, call the
// real code" testing convention already used by
// app/api/pay/pay.secret-leak.test.ts and app/api/session/session.secret-leak.test.ts
// (real Request/Response objects, not mocked route internals).
// ---------------------------------------------------------------------------

class FakeStorage implements Storage {
  private store = new Map<string, string>();

  getItem(key: string): string | null {
    return this.store.has(key) ? this.store.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    this.store.set(key, String(value));
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
  clear(): void {
    this.store.clear();
  }
  key(index: number): string | null {
    return Array.from(this.store.keys())[index] ?? null;
  }
  get length(): number {
    return this.store.size;
  }
}

const STELLAR_SECRET_KEY_SHAPE = /^S[A-Z0-9]{55}$/;

let fakeStorage: FakeStorage;

beforeEach(() => {
  fakeStorage = new FakeStorage();
  vi.stubGlobal("window", { localStorage: fakeStorage } as unknown as Window & typeof globalThis);
  vi.stubGlobal("localStorage", fakeStorage);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("lib/local-storage: namespacing + round-trip", () => {
  it("writeSession/readSession round-trips under the vellar.session key", () => {
    const data: StoredSession = { publicKey: "GAAA...TEST", balanceXlm: "9999.0000000", balanceUsdc: "1.5000000" };
    writeSession(data);

    expect(fakeStorage.getItem("vellar.session")).toBeTruthy();
    expect(readSession()).toEqual(data);
  });

  it("writeLastPayment/readLastPayment round-trips under the vellar.lastPayment key", () => {
    const data: StoredLastPayment = {
      settlementTx: "abc123",
      paymentPayload: { accepted: { scheme: "exact" } },
      sellerUrl: "https://vellar-seller-demo.onrender.com/quote",
      amount: "10000",
      timestamp: 1234567890,
    };
    writeLastPayment(data);

    expect(fakeStorage.getItem("vellar.lastPayment")).toBeTruthy();
    expect(readLastPayment()).toEqual(data);
  });

  it("writeLastCatalogSearch/readLastCatalogSearch round-trips under the vellar.lastCatalogSearch key", () => {
    writeLastCatalogSearch({ query: "quote", results: [{ resource: "https://example.com/quote" }] });
    expect(readLastCatalogSearch()).toEqual({ query: "quote", results: [{ resource: "https://example.com/quote" }] });
  });

  it("writeQuestLevel/readQuestProgress accumulates keyed by level number, under vellar.questProgress", () => {
    writeQuestLevel(1, { completedAt: 1000, proof: "abc123settlementtx", verified: true });
    expect(readQuestProgress()).toEqual({
      1: { level: 1, completedAt: 1000, proof: "abc123settlementtx", verified: true },
    });

    writeQuestLevel(2, { completedAt: 2000, proof: "Confirmed — already verified.", verified: true });
    expect(readQuestProgress()).toEqual({
      1: { level: 1, completedAt: 1000, proof: "abc123settlementtx", verified: true },
      2: { level: 2, completedAt: 2000, proof: "Confirmed — already verified.", verified: true },
    });
    expect(fakeStorage.getItem("vellar.questProgress")).toBeTruthy();
  });

  it("writeQuestLevel overwrites an existing level's record rather than duplicating it", () => {
    writeQuestLevel(1, { completedAt: 1000, proof: "first-tx", verified: true });
    writeQuestLevel(1, { completedAt: 2000, proof: "second-tx", verified: true });
    expect(readQuestProgress()).toEqual({
      1: { level: 1, completedAt: 2000, proof: "second-tx", verified: true },
    });
  });

  it("writeAttackResult/readAttackResults round-trips under the vellar.attackResults key, keyed by attackId", () => {
    const result: StoredAttackResult = {
      attackId: "tamper_amount",
      endpoint: "/verify",
      attemptedAt: 5000,
      checkMethod: "reason_code",
      httpStatus: 200,
      reasonCode: "invalid_exact_stellar_payload_wrong_amount",
      expectedCodes: ["invalid_exact_stellar_payload_wrong_amount"],
      passed: true,
      rawResponse: { isValid: false, invalidReason: "invalid_exact_stellar_payload_wrong_amount" },
    };
    writeAttackResult(result);
    expect(readAttackResults()).toEqual({ tamper_amount: result });
    expect(fakeStorage.getItem("vellar.attackResults")).toBeTruthy();
  });

  it("writeAttackResult accumulates multiple attacks keyed by their own attackId", () => {
    const a: StoredAttackResult = {
      attackId: "tamper_amount",
      endpoint: "/verify",
      attemptedAt: 1,
      checkMethod: "reason_code",
      expectedCodes: ["invalid_exact_stellar_payload_wrong_amount"],
      passed: true,
      rawResponse: {},
    };
    const b: StoredAttackResult = {
      attackId: "wrong_network",
      endpoint: "/verify",
      attemptedAt: 2,
      checkMethod: "http_status",
      httpStatus: 500,
      expectedCodes: [],
      passed: true,
      rawResponse: {},
    };
    writeAttackResult(a);
    writeAttackResult(b);
    expect(readAttackResults()).toEqual({ tamper_amount: a, wrong_network: b });
  });
});

describe("lib/local-storage: secret key never reaches the raw stored bytes", () => {
  it("writeSession's raw stored JSON never contains a secretKey field or a Stellar-secret-shaped substring", () => {
    const data: StoredSession = { publicKey: "GDXYZ", balanceXlm: "100.0000000", balanceUsdc: "5.0000000" };
    writeSession(data);

    const raw = fakeStorage.getItem("vellar.session")!;
    expect(raw).toBeTruthy();
    expect(raw.includes("secretKey")).toBe(false);
    expect(raw).not.toMatch(STELLAR_SECRET_KEY_SHAPE);
  });

  it("writeSession strips a secretKey field smuggled in via an unsafe cast (defense in depth, not just caller discipline)", () => {
    // This exercises writeSession with a genuinely dangerous object — the
    // type system is bypassed with `as unknown as StoredSession`, the same
    // way a careless caller (e.g. a future `{...someServerResponse}` spread)
    // could realistically defeat structural typing. writeSession reconstructs
    // its stored object from named fields rather than writing the input
    // through as-is (see lib/local-storage.ts), so the secret is dropped even
    // though it was genuinely present on the object passed in — this is the
    // real proof the earlier version of this test only appeared to give (that
    // version pre-filtered the dangerous object itself before calling
    // writeSession, so it could never have failed regardless of writeSession's
    // behavior; corrected here to actually pass the dangerous object through).
    const secretKey = "SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const dangerousCallerObject = {
      publicKey: "GDXYZ",
      balanceXlm: "100.0000000",
      secretKey,
    } as unknown as StoredSession;
    writeSession(dangerousCallerObject);

    const raw = fakeStorage.getItem("vellar.session")!;
    expect(raw).toBeTruthy();
    expect(raw.includes("secretKey")).toBe(false);
    expect(raw).not.toContain(secretKey);
    expect(raw).not.toMatch(STELLAR_SECRET_KEY_SHAPE);
    // Confirm the legitimate fields still made it through — this isn't
    // proving the write silently no-ops, just that the extra field is gone.
    expect(raw).toContain("GDXYZ");
  });

  it("writeLastPayment strips a secretKey field smuggled in via an unsafe cast", () => {
    const secretKey = "SCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";
    const dangerousCallerObject = {
      settlementTx: "deadbeef",
      paymentPayload: { accepted: { scheme: "exact" } },
      sellerUrl: "https://vellar-seller-demo.onrender.com/quote",
      amount: "10000",
      timestamp: Date.now(),
      secretKey,
    } as unknown as StoredLastPayment;
    writeLastPayment(dangerousCallerObject);

    const raw = fakeStorage.getItem("vellar.lastPayment")!;
    expect(raw).toBeTruthy();
    expect(raw.includes("secretKey")).toBe(false);
    expect(raw).not.toContain(secretKey);
    expect(raw).not.toMatch(STELLAR_SECRET_KEY_SHAPE);
    expect(raw).toContain("deadbeef");
  });

  it("writeLastPayment's raw stored JSON never contains a secretKey field or a Stellar-secret-shaped substring", () => {
    const secretKey = "SBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
    const data: StoredLastPayment = {
      settlementTx: "deadbeef",
      // A realistic paymentPayload shape (mirrors what lib/pay.ts's "verify"
      // event actually carries) — proves even a nested, uncontrolled object
      // doesn't smuggle a secret through, as long as the caller itself never
      // put one in (which, per the module doc comment, it structurally can't
      // for this app's actual call sites).
      paymentPayload: { accepted: { scheme: "exact", network: "stellar:testnet" }, payload: { transaction: "AAAA..." } },
      sellerUrl: "https://vellar-seller-demo.onrender.com/quote",
      amount: "10000",
      timestamp: Date.now(),
    };
    writeLastPayment(data);

    const raw = fakeStorage.getItem("vellar.lastPayment")!;
    expect(raw).toBeTruthy();
    expect(raw.includes("secretKey")).toBe(false);
    expect(raw).not.toContain(secretKey);
    expect(raw).not.toMatch(STELLAR_SECRET_KEY_SHAPE);
  });
});

describe("lib/local-storage: clearAll()", () => {
  it("removes exactly the 5 namespaced keys and leaves a non-vellar key untouched", () => {
    writeSession({ publicKey: "G1", balanceXlm: "1" });
    writeLastPayment({ settlementTx: "tx1", paymentPayload: {}, sellerUrl: "https://x", amount: "1", timestamp: 1 });
    writeLastCatalogSearch({ query: "q", results: [] });
    writeQuestLevel(1, { completedAt: 1, proof: "tx1", verified: true });
    writeAttackResult({
      attackId: "tamper_amount",
      endpoint: "/verify",
      attemptedAt: 1,
      checkMethod: "reason_code",
      expectedCodes: ["invalid_exact_stellar_payload_wrong_amount"],
      passed: true,
      rawResponse: {},
    });
    fakeStorage.setItem("some.other.app.key", "should-survive");

    expect(fakeStorage.length).toBe(6);

    clearAll();

    expect(fakeStorage.getItem("vellar.session")).toBeNull();
    expect(fakeStorage.getItem("vellar.lastPayment")).toBeNull();
    expect(fakeStorage.getItem("vellar.lastCatalogSearch")).toBeNull();
    expect(fakeStorage.getItem("vellar.questProgress")).toBeNull();
    expect(fakeStorage.getItem("vellar.attackResults")).toBeNull();
    // Proves clearAll() is NOT calling localStorage.clear() wholesale.
    expect(fakeStorage.getItem("some.other.app.key")).toBe("should-survive");
    expect(fakeStorage.length).toBe(1);
  });

  it("is a no-op (doesn't throw) when none of the 5 keys are present", () => {
    fakeStorage.setItem("unrelated", "1");
    expect(() => clearAll()).not.toThrow();
    expect(fakeStorage.getItem("unrelated")).toBe("1");
  });
});

describe("lib/local-storage: graceful absence + corruption handling", () => {
  it("every read* returns null/empty when its key is entirely absent", () => {
    expect(readSession()).toBeNull();
    expect(readLastPayment()).toBeNull();
    expect(readLastCatalogSearch()).toBeNull();
    expect(readQuestProgress()).toEqual({});
    expect(readAttackResults()).toEqual({});
  });

  it("readSession does not throw and returns null on corrupted/unparseable JSON", () => {
    fakeStorage.setItem("vellar.session", "{not valid json!!");
    expect(() => readSession()).not.toThrow();
    expect(readSession()).toBeNull();
  });

  it("readLastPayment does not throw and returns null on corrupted/unparseable JSON", () => {
    fakeStorage.setItem("vellar.lastPayment", "undefined");
    expect(() => readLastPayment()).not.toThrow();
    expect(readLastPayment()).toBeNull();
  });

  it("readLastCatalogSearch does not throw and returns null on corrupted/unparseable JSON", () => {
    fakeStorage.setItem("vellar.lastCatalogSearch", "{{{");
    expect(() => readLastCatalogSearch()).not.toThrow();
    expect(readLastCatalogSearch()).toBeNull();
  });

  it("readQuestProgress does not throw and returns {} on corrupted/unparseable JSON", () => {
    fakeStorage.setItem("vellar.questProgress", "]not json[");
    expect(() => readQuestProgress()).not.toThrow();
    expect(readQuestProgress()).toEqual({});
  });

  it("readAttackResults does not throw and returns {} on corrupted/unparseable JSON", () => {
    fakeStorage.setItem("vellar.attackResults", "]not json[");
    expect(() => readAttackResults()).not.toThrow();
    expect(readAttackResults()).toEqual({});
  });

  it("write* functions never throw even if the underlying storage.setItem throws (quota exceeded, disabled storage)", () => {
    const throwingStorage: Storage = {
      ...fakeStorage,
      setItem: () => {
        throw new DOMException("QuotaExceededError");
      },
      getItem: (k: string) => fakeStorage.getItem(k),
      removeItem: (k: string) => fakeStorage.removeItem(k),
      clear: () => fakeStorage.clear(),
      key: (i: number) => fakeStorage.key(i),
      get length() {
        return fakeStorage.length;
      },
    };
    vi.stubGlobal("window", { localStorage: throwingStorage } as unknown as Window & typeof globalThis);

    expect(() => writeSession({ publicKey: "G1", balanceXlm: "1" })).not.toThrow();
    expect(() =>
      writeLastPayment({ settlementTx: "t", paymentPayload: {}, sellerUrl: "https://x", amount: "1", timestamp: 1 }),
    ).not.toThrow();
    expect(() => writeLastCatalogSearch({ query: "q", results: [] })).not.toThrow();
    expect(() => writeQuestLevel(1, { completedAt: 1, proof: "tx1", verified: true })).not.toThrow();
    expect(() =>
      writeAttackResult({
        attackId: "tamper_amount",
        endpoint: "/verify",
        attemptedAt: 1,
        checkMethod: "reason_code",
        expectedCodes: ["invalid_exact_stellar_payload_wrong_amount"],
        passed: true,
        rawResponse: {},
      }),
    ).not.toThrow();
  });

  it("read* functions never throw even if the underlying storage.getItem throws", () => {
    const throwingStorage: Storage = {
      ...fakeStorage,
      getItem: () => {
        throw new Error("storage access denied");
      },
      setItem: (k: string, v: string) => fakeStorage.setItem(k, v),
      removeItem: (k: string) => fakeStorage.removeItem(k),
      clear: () => fakeStorage.clear(),
      key: (i: number) => fakeStorage.key(i),
      get length() {
        return fakeStorage.length;
      },
    };
    vi.stubGlobal("window", { localStorage: throwingStorage } as unknown as Window & typeof globalThis);

    expect(() => readSession()).not.toThrow();
    expect(readSession()).toBeNull();
    expect(() => readQuestProgress()).not.toThrow();
    expect(readQuestProgress()).toEqual({});
  });

  it("every read/write is a safe no-op when window/localStorage doesn't exist at all (SSR-like context)", () => {
    vi.stubGlobal("window", undefined);
    vi.stubGlobal("localStorage", undefined);

    expect(() => writeSession({ publicKey: "G1", balanceXlm: "1" })).not.toThrow();
    expect(readSession()).toBeNull();
    expect(() => clearAll()).not.toThrow();
  });
});
