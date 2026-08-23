/**
 * Client-side localStorage persistence, namespaced under `vellar.*`.
 *
 * This is a display cache, not a source of truth. The real source of truth
 * for anything security-relevant (the wallet's secret key, above all) is the
 * encrypted server-side session cookie (see lib/session.ts) — never this
 * module. Every value read/written here is either non-secret wallet display
 * data (public key, balances) or purely local convenience state (last
 * payment shown, last catalog search, quest progress, attack-bench results).
 *
 * SECURITY, non-negotiable: `StoredSession` has no `secretKey` field, and no
 * write* function here accepts one. Two layers, not one: the type itself has
 * no such field, and every caller in this app only ever has access to
 * `{publicKey, balanceXlm, usdcProvisioned, balanceUsdc}` from the streaming
 * session-create response (POST /api/session/create never emits a secretKey
 * in any event — see that route's module doc comment) — so there is no
 * secret key value in scope client-side to begin with. On top of that,
 * `writeSession`/`writeLastPayment` reconstruct their stored object from
 * named fields rather than writing the input through as-is, so even a caller
 * that bypassed the type system (an unsafe cast, a careless object spread)
 * could not smuggle an extra field into storage. See lib/local-storage.test.ts
 * for a runtime assertion that exercises exactly that bypass.
 *
 * Every read/write is wrapped in try/catch: localStorage can throw (Safari
 * private browsing, storage disabled by the user, quota exceeded) or simply
 * not exist (a non-browser context) — this module must never let a storage
 * failure crash the page. A failed write is silently dropped; a failed read
 * returns the same "nothing here" value an absent key would.
 */

const NAMESPACE = "vellar.";

const KEYS = {
  session: `${NAMESPACE}session`,
  lastPayment: `${NAMESPACE}lastPayment`,
  lastCatalogSearch: `${NAMESPACE}lastCatalogSearch`,
  questProgress: `${NAMESPACE}questProgress`,
  attackResults: `${NAMESPACE}attackResults`,
} as const;

// All five namespaced keys — the exhaustive list clearAll() removes. Kept as
// its own array (rather than Object.values(KEYS) inline at the call site) so
// the "exactly these five, nothing else" contract is visible at a glance.
const ALL_KEYS: string[] = [
  KEYS.session,
  KEYS.lastPayment,
  KEYS.lastCatalogSearch,
  KEYS.questProgress,
  KEYS.attackResults,
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Non-secret wallet display data only — deliberately has no `secretKey`
 *  field. See the module doc comment above. */
export interface StoredSession {
  publicKey: string;
  balanceXlm: string;
  balanceUsdc?: string;
}

export interface StoredLastPayment {
  settlementTx: string;
  paymentPayload: unknown;
  sellerUrl: string;
  amount: string;
  timestamp: number;
}

export interface StoredCatalogSearch {
  query: string;
  results: unknown[];
}

/**
 * One completed level of the five-level challenge track (Station 3's own
 * design — see the task notes this schema was locked against). `proof` is
 * always a STRING, and always the most honest real evidence the level's own
 * mechanism actually produces:
 *   L1 (first payment / Station 1)        -> settlement tx hash
 *   L2 (ownership verification / Station 2) -> see the DISCREPANCY note below
 *   L3 (a payment attack refused correctly) -> the reason code observed
 *   L4 (a catalog attack demonstrated)      -> a search/poll result summary
 *   L5 (?)                                  -> tx hash
 * This task (Station 3) only builds the STORAGE and the two write call sites
 * Station 1/2 already need (L1, L2) plus whatever Station 3 itself writes —
 * the full 5-level UI is future work.
 *
 * DISCREPANCY, flagged per the task's own instruction rather than papered
 * over: the task's shorthand says "XDR for L2". Station 2
 * (POST /api/verify-ownership) is a READ-ONLY check — it fetches the
 * seller's 402 challenge, decodes it, and compares payTo against the
 * catalog's bound address. It never signs anything and never produces an
 * XDR (see that route's own module doc: "this route never signs or pays
 * anything"). Forcing an XDR value here would mean fabricating one that
 * doesn't exist. The proof actually written for L2 is the verdict text
 * Station 2's own "verdict" step produces (e.g. "Confirmed — already
 * verified. This resource was proven earlier and that verdict is
 * permanent.") — the real evidence that station generates, not a
 * shorthand-shaped substitute.
 */
export interface StoredQuestLevel {
  level: number; // 1-5
  completedAt: number;
  proof: string;
  /** Confirmed against real chain/facilitator state, not merely "the UI flow
   *  ran". True for L1 (a real settlement tx) and L2 (a real live
   *  re-verification against the facilitator's own catalog). */
  verified: boolean;
}

export type StoredQuestProgress = Record<number, StoredQuestLevel>;

// ---------------------------------------------------------------------------
// vellar.attackResults
// ---------------------------------------------------------------------------

export type AttackCheckMethod = "reason_code" | "http_status" | "poll_diff" | "content_inspection";

export interface StoredAttackResult {
  attackId: string;
  endpoint: string;
  attemptedAt: number;
  checkMethod: AttackCheckMethod;
  httpStatus?: number;
  reasonCode?: string;
  /** Set for replay (multiple plausible real codes); single-element array for
   *  the other reason_code/http_status attacks; empty array when genuinely
   *  inapplicable (poll_diff/content_inspection attacks don't compare against
   *  a code list at all — the comparison is structural, not code-based). */
  expectedCodes: string[];
  passed: boolean;
  /** Either the raw HTTP response body object, OR `{before, after}` for
   *  poll_diff attacks (the two real snapshots compared). */
  rawResponse: unknown;
}

export type StoredAttackResults = Record<string, StoredAttackResult>;

// ---------------------------------------------------------------------------
// Low-level helpers
// ---------------------------------------------------------------------------

function getStorage(): Storage | null {
  try {
    if (typeof window === "undefined" || !window.localStorage) return null;
    return window.localStorage;
  } catch {
    // Accessing window.localStorage itself can throw (some private-mode
    // configurations throw on the getter, not just on getItem/setItem).
    return null;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    const storage = getStorage();
    if (!storage) return;
    storage.setItem(key, JSON.stringify(value));
  } catch {
    // Quota exceeded, storage disabled, serialization failure — a storage
    // write is always best-effort, never allowed to throw into caller code.
  }
}

function readJson<T>(key: string): T | null {
  try {
    const storage = getStorage();
    if (!storage) return null;
    const raw = storage.getItem(key);
    if (raw === null) return null;
    return JSON.parse(raw) as T;
  } catch {
    // Corrupted/unparseable JSON, or storage access itself threw — treat
    // exactly like an absent key rather than propagating.
    return null;
  }
}

// ---------------------------------------------------------------------------
// vellar.session
// ---------------------------------------------------------------------------

/**
 * Rebuilds the object from named fields only, rather than writing `data`
 * through as-is. TypeScript's structural typing means a caller CAN still
 * satisfy `StoredSession` with a wider runtime object (e.g. a careless
 * `{...someServerResponse}` spread, or an unsafe cast) — every real call
 * site in this app never does that (see the module doc comment), but this
 * reconstruction makes the guarantee hold even if one someday did, rather
 * than resting on caller discipline alone. Cheap (a handful of fields) and
 * removes the "what if" entirely instead of just documenting it.
 */
export function writeSession(data: StoredSession): void {
  writeJson(KEYS.session, {
    publicKey: data.publicKey,
    balanceXlm: data.balanceXlm,
    balanceUsdc: data.balanceUsdc,
  });
}

export function readSession(): StoredSession | null {
  return readJson<StoredSession>(KEYS.session);
}

// ---------------------------------------------------------------------------
// vellar.lastPayment
// ---------------------------------------------------------------------------

/** Same field-reconstruction rationale as writeSession above. */
export function writeLastPayment(data: StoredLastPayment): void {
  writeJson(KEYS.lastPayment, {
    settlementTx: data.settlementTx,
    paymentPayload: data.paymentPayload,
    sellerUrl: data.sellerUrl,
    amount: data.amount,
    timestamp: data.timestamp,
  });
}

export function readLastPayment(): StoredLastPayment | null {
  return readJson<StoredLastPayment>(KEYS.lastPayment);
}

// ---------------------------------------------------------------------------
// vellar.lastCatalogSearch
// ---------------------------------------------------------------------------

export function writeLastCatalogSearch(data: StoredCatalogSearch): void {
  writeJson(KEYS.lastCatalogSearch, data);
}

export function readLastCatalogSearch(): StoredCatalogSearch | null {
  return readJson<StoredCatalogSearch>(KEYS.lastCatalogSearch);
}

// ---------------------------------------------------------------------------
// vellar.questProgress
// ---------------------------------------------------------------------------

/** Writes/overwrites one level's record, keyed by level number. Accumulates
 *  across calls (same "read-merge-write" convention as the old station-keyed
 *  version this replaces) rather than requiring the caller to pass every
 *  level every time. */
export function writeQuestLevel(level: number, data: Omit<StoredQuestLevel, "level">): void {
  const existing = readQuestProgress();
  writeJson(KEYS.questProgress, {
    ...existing,
    [level]: { level, completedAt: data.completedAt, proof: data.proof, verified: data.verified },
  });
}

export function readQuestProgress(): StoredQuestProgress {
  return readJson<StoredQuestProgress>(KEYS.questProgress) ?? {};
}

// ---------------------------------------------------------------------------
// vellar.attackResults
// ---------------------------------------------------------------------------

/** Writes/overwrites one attack's result, keyed by attackId. Same
 *  read-merge-write accumulation convention as writeQuestLevel above.
 *  Reconstructs the stored object from named fields (same rationale as
 *  writeSession/writeLastPayment's module doc comment) — cheap, and removes
 *  any "what if a caller smuggles an extra field" question rather than
 *  resting on caller discipline. This is also where the secret-key
 *  non-negotiable is enforced on the storage side: there is no `secretKey`
 *  field in `StoredAttackResult` to begin with, and this function only ever
 *  copies the named fields through. */
export function writeAttackResult(result: StoredAttackResult): void {
  const existing = readAttackResults();
  writeJson(KEYS.attackResults, {
    ...existing,
    [result.attackId]: {
      attackId: result.attackId,
      endpoint: result.endpoint,
      attemptedAt: result.attemptedAt,
      checkMethod: result.checkMethod,
      httpStatus: result.httpStatus,
      reasonCode: result.reasonCode,
      expectedCodes: result.expectedCodes,
      passed: result.passed,
      rawResponse: result.rawResponse,
    },
  });
}

export function readAttackResults(): StoredAttackResults {
  return readJson<StoredAttackResults>(KEYS.attackResults) ?? {};
}

// ---------------------------------------------------------------------------
// Start fresh
// ---------------------------------------------------------------------------

/** Removes exactly the five `vellar.*` keys this module owns. Deliberately
 *  NOT `localStorage.clear()` — that would also wipe anything else stored on
 *  this origin, which is out of scope for this app to touch. */
export function clearAll(): void {
  try {
    const storage = getStorage();
    if (!storage) return;
    for (const key of ALL_KEYS) {
      storage.removeItem(key);
    }
  } catch {
    // Best-effort, same as every other write in this module.
  }
}
