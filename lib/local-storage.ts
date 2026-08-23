/**
 * Client-side localStorage persistence, namespaced under `vellar.*`.
 *
 * This is a display cache, not a source of truth. The real source of truth
 * for anything security-relevant (the wallet's secret key, above all) is the
 * encrypted server-side session cookie (see lib/session.ts) — never this
 * module. Every value read/written here is either non-secret wallet display
 * data (public key, balances) or purely local convenience state (last
 * payment shown, last catalog search, quest progress).
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
} as const;

// All four namespaced keys — the exhaustive list clearAll() removes. Kept as
// its own array (rather than Object.values(KEYS) inline at the call site) so
// the "exactly these four, nothing else" contract is visible at a glance.
const ALL_KEYS: string[] = [KEYS.session, KEYS.lastPayment, KEYS.lastCatalogSearch, KEYS.questProgress];

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

/** Keyed by station name (e.g. "station-1"). `true` marks simple completion;
 *  `{proof: unknown}` allows a station to attach whatever evidence it wants
 *  later (Station 2/3 will need to agree on a proof shape when they exist —
 *  not defined by this task). */
export type StoredQuestProgress = Record<string, true | { proof: unknown }>;

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

export function writeQuestProgress(station: string, value: true | { proof: unknown }): void {
  const existing = readQuestProgress();
  writeJson(KEYS.questProgress, { ...existing, [station]: value });
}

export function readQuestProgress(): StoredQuestProgress {
  return readJson<StoredQuestProgress>(KEYS.questProgress) ?? {};
}

// ---------------------------------------------------------------------------
// Start fresh
// ---------------------------------------------------------------------------

/** Removes exactly the four `vellar.*` keys this module owns. Deliberately
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
