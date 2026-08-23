"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { cx, Eyebrow, Field, LpActionButton, MonoRow, MonoRows, TokenPill } from "../design/ui";
import { formatAtomicAmount, truncateMiddle } from "@/lib/format";
import { useElapsedSeconds } from "@/lib/use-elapsed-seconds";
import { useScrollSpy } from "@/lib/use-scroll-spy";
import { FACILITATOR_URL, SELLER_URL } from "@/lib/config";
import {
  clearAll,
  readLastPayment,
  readSession,
  writeAttackResult,
  writeLastPayment,
  writeQuestLevel,
  writeSession,
  type StoredAttackResult,
} from "@/lib/local-storage";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface WalletState {
  publicKey: string;
  balanceXlm: string;
  usdcProvisioned: boolean;
  balanceUsdc?: string;
}

// Per-step provisioning progress, streamed from POST /api/session/create
// (see that route's wire-format doc comment). Mirrors the event shapes
// emitted server-side.
type StepName = "keypair" | "friendbot" | "trustline" | "usdc_purchase";
type StepStatus = "pending" | "active" | "done" | "error" | "skipped";

const STEP_ORDER: StepName[] = ["keypair", "friendbot", "trustline", "usdc_purchase"];
const STEP_LABELS: Record<StepName, string> = {
  keypair: "Generating your Stellar keypair",
  friendbot: "Funding with testnet XLM",
  trustline: "Opening USDC trustline",
  usdc_purchase: "Buying testnet USDC",
};

type StepMap = Record<StepName, StepStatus>;

function initialSteps(): StepMap {
  return { keypair: "pending", friendbot: "pending", trustline: "pending", usdc_purchase: "pending" };
}

type WalletStage =
  | { status: "idle" }
  // "restoring" — a briefer, more honest framing than the full 4-step
  // animation for the case where vellar.session (a localStorage display
  // cache) indicates a returning visitor. See createWallet()'s doc comment
  // for why this still calls the same POST /api/session/create the "Get
  // started" button calls, rather than trusting the cached data as truth.
  | { status: "restoring" }
  | { status: "loading"; startedAt: number; steps: StepMap }
  | { status: "ready"; wallet: WalletState }
  | { status: "error"; message: string; steps: StepMap };

interface CatalogItem {
  resource: string;
  description?: string;
  accepts?: Array<{ amount?: string; asset?: string; payTo?: string; network?: string }>;
  trust?: { ownerVerified?: boolean; ownershipState?: string; verification?: string };
}

type CatalogStage =
  | { status: "idle" }
  | { status: "loading"; startedAt: number }
  | { status: "ready"; items: CatalogItem[] }
  | { status: "error"; message: string };

// ---------------------------------------------------------------------------
// Payment ledger types — mirrors the NDJSON events streamed from
// POST /api/pay (see that route's wire-format doc comment). Six real steps,
// plus "waking_up" (cold-start) and "retry" (whole-flow-restarted) markers,
// terminated by one "complete" event.
// ---------------------------------------------------------------------------

type LedgerStepName = "get_request" | "challenge" | "sign" | "verify" | "settle" | "result";
type LedgerStepStatus = "pending" | "active" | "done" | "error";

const LEDGER_STEP_ORDER: LedgerStepName[] = ["get_request", "challenge", "sign", "verify", "settle", "result"];
const LEDGER_STEP_LABELS: Record<LedgerStepName, string> = {
  get_request: "GET the seller URL",
  challenge: "402 payment challenge",
  sign: "Sign the payment",
  verify: "Verify (request built)",
  settle: "Settle on-chain",
  result: "Resource delivered",
};

/** Loosely-typed raw event as received off the wire — narrowed field-by-field
 *  as each step's renderer reads it, rather than one large discriminated
 *  union, since the wire events already carry heterogeneous extra fields per
 *  step (see app/api/pay/route.ts's StreamEvent). */
interface LedgerEvent {
  step: string;
  status: string;
  attempt?: number;
  maxAttempts?: number;
  [key: string]: unknown;
}

interface LedgerStepState {
  status: LedgerStepStatus;
  /** The most recent event object received for this step (raw, for the
   *  collapsible "raw wire bytes" panel) — overwritten as active -> done. */
  event?: LedgerEvent;
  message?: string;
}

type LedgerStepMap = Record<LedgerStepName, LedgerStepState>;

function initialLedgerSteps(): LedgerStepMap {
  const pending: LedgerStepState = { status: "pending" };
  return {
    get_request: { ...pending },
    challenge: { ...pending },
    sign: { ...pending },
    verify: { ...pending },
    settle: { ...pending },
    result: { ...pending },
  };
}

interface PayCompleteResult {
  settlementTx: string;
  payer?: string;
  network?: string;
  amount?: string;
  asset?: string;
  payTo?: string;
  attempts: number;
}

type PayStage =
  | { status: "idle" }
  | {
      status: "paying";
      startedAt: number;
      resourceUrl: string;
      steps: LedgerStepMap;
      attempt: number;
      maxAttempts: number;
      wakingUp: boolean;
      wakingUpSince: number | null;
    }
  | { status: "success"; result: PayCompleteResult; resourceUrl: string; steps: LedgerStepMap; attempt: number }
  | { status: "error"; message: string; resourceUrl: string; steps: LedgerStepMap; attempt: number };

/** Parses one line of the NDJSON stream emitted by POST /api/pay. Returns
 *  null for a blank line rather than throwing — same convention as
 *  parseStreamLine for /api/session/create below. */
function parsePayStreamLine(line: string): LedgerEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object" && typeof parsed.step === "string" && typeof parsed.status === "string") {
      return parsed as LedgerEvent;
    }
    return null;
  } catch {
    return null;
  }
}

const DEMO_RESOURCE_URL = "https://vellar-seller-demo.onrender.com/quote";
const COLD_START_CEILING_MS = 60_000;

// ---------------------------------------------------------------------------
// Ownership verification types — mirrors the NDJSON events streamed from
// POST /api/verify-ownership (see that route's wire-format doc comment).
// Five real steps, terminated by one "complete" event. Station 2.
// ---------------------------------------------------------------------------

type OwnershipStepName = "fetch_challenge" | "decode_header" | "parse_pay_to" | "compare_catalog" | "verdict";
type OwnershipStepStatus = "pending" | "active" | "done" | "error";

const OWNERSHIP_STEP_ORDER: OwnershipStepName[] = [
  "fetch_challenge",
  "decode_header",
  "parse_pay_to",
  "compare_catalog",
  "verdict",
];
const OWNERSHIP_STEP_LABELS: Record<OwnershipStepName, string> = {
  fetch_challenge: "Fetching the seller's 402 challenge",
  decode_header: "Reading the PAYMENT-REQUIRED header",
  parse_pay_to: "Parsing the payTo from the challenge",
  compare_catalog: "Comparing against the bound address from the catalog",
  verdict: "Verdict",
};

/** Loosely-typed raw event as received off the wire — same "narrow
 *  field-by-field as each step's renderer reads it" convention as
 *  LedgerEvent above (see that type's comment). */
interface OwnershipEvent {
  step: string;
  status: string;
  [key: string]: unknown;
}

interface OwnershipStepState {
  status: OwnershipStepStatus;
  event?: OwnershipEvent;
  message?: string;
}

type OwnershipStepMap = Record<OwnershipStepName, OwnershipStepState>;

function initialOwnershipSteps(): OwnershipStepMap {
  const pending: OwnershipStepState = { status: "pending" };
  return {
    fetch_challenge: { ...pending },
    decode_header: { ...pending },
    parse_pay_to: { ...pending },
    compare_catalog: { ...pending },
    verdict: { ...pending },
  };
}

interface OwnershipVerdictResult {
  match: boolean;
  verdictText: string;
  challengePayTos: string[];
  boundPayTos: string[];
}

type OwnershipStage =
  | { status: "idle" }
  | { status: "checking"; startedAt: number; steps: OwnershipStepMap }
  | { status: "success"; result: OwnershipVerdictResult; steps: OwnershipStepMap }
  | { status: "error"; message: string; steps: OwnershipStepMap };

/** Parses one line of the NDJSON stream emitted by POST /api/verify-ownership.
 *  Same convention as parsePayStreamLine above. */
function parseOwnershipStreamLine(line: string): OwnershipEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object" && typeof parsed.step === "string" && typeof parsed.status === "string") {
      return parsed as OwnershipEvent;
    }
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Station 3 — attack bench types. Two independent NDJSON streams (mirrors
// POST /api/attack/payment and POST /api/attack/catalog's own wire-format
// doc comments): each emits {"step":"attack","status":"active"|"done"|
// "error","attackId":...} events and one terminal
// {"step":"complete","status":"done"|"error",...}. Attack 8
// (prompt_injection) is a separate, synchronous, non-streaming call to
// POST /api/attack/sanitize and gets its own small state shape below.
// ---------------------------------------------------------------------------

type AttackBenchStatus = "pending" | "active" | "done" | "error";

interface AttackBenchEntry {
  status: AttackBenchStatus;
  result?: StoredAttackResult;
  message?: string;
}

const PAYMENT_ATTACK_IDS = ["tamper_amount", "redirect_payto", "strip_signature", "wrong_network", "replay"] as const;
const CATALOG_ATTACK_IDS = ["ssrf_linklocal", "displace_verified"] as const;

type PaymentAttackId = (typeof PAYMENT_ATTACK_IDS)[number];
type CatalogAttackId = (typeof CATALOG_ATTACK_IDS)[number];

const PAYMENT_ATTACK_LABELS: Record<PaymentAttackId, string> = {
  tamper_amount: "Tamper the amount",
  redirect_payto: "Redirect the payTo",
  strip_signature: "Strip the signature",
  wrong_network: "Claim an unregistered network",
  replay: "Replay an already-settled payment",
};

const CATALOG_ATTACK_LABELS: Record<CatalogAttackId, string> = {
  ssrf_linklocal: "Point at a blocked internal address",
  displace_verified: "Displace an already-verified binding",
};

function initialPaymentAttackMap(): Record<PaymentAttackId, AttackBenchEntry> {
  const pending: AttackBenchEntry = { status: "pending" };
  return {
    tamper_amount: { ...pending },
    redirect_payto: { ...pending },
    strip_signature: { ...pending },
    wrong_network: { ...pending },
    replay: { ...pending },
  };
}

function initialCatalogAttackMap(): Record<CatalogAttackId, AttackBenchEntry> {
  const pending: AttackBenchEntry = { status: "pending" };
  return { ssrf_linklocal: { ...pending }, displace_verified: { ...pending } };
}

type PaymentAttackMap = Record<PaymentAttackId, AttackBenchEntry>;
type CatalogAttackMap = Record<CatalogAttackId, AttackBenchEntry>;

type PaymentAttackStage =
  | { status: "idle" }
  | { status: "running"; startedAt: number; attacks: PaymentAttackMap }
  | { status: "done"; attacks: PaymentAttackMap }
  | { status: "error"; message: string; attacks: PaymentAttackMap };

type CatalogAttackStage =
  | { status: "idle" }
  | { status: "running"; startedAt: number; attacks: CatalogAttackMap }
  | { status: "done"; attacks: CatalogAttackMap }
  | { status: "error"; message: string; attacks: CatalogAttackMap };

interface AttackStreamEvent {
  step: string;
  status: string;
  attackId?: string;
  result?: StoredAttackResult;
  message?: string;
  results?: StoredAttackResult[];
  error?: string;
  [key: string]: unknown;
}

function parseAttackStreamLine(line: string): AttackStreamEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object" && typeof parsed.step === "string" && typeof parsed.status === "string") {
      return parsed as AttackStreamEvent;
    }
    return null;
  } catch {
    return null;
  }
}

interface SanitizeDemoState {
  status: "idle" | "loading" | "done" | "error";
  input: string;
  result?: StoredAttackResult;
  message?: string;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function truncateKey(key: string): string {
  if (key.length <= 12) return key;
  return `${key.slice(0, 5)}...${key.slice(-4)}`;
}

async function copyToClipboard(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Clipboard access can fail (permissions, insecure context) — this is a
    // convenience affordance, not a critical path, so fail silently.
  }
}

/**
 * Parses one line of the NDJSON stream emitted by POST /api/session/create.
 * Returns null for a blank line (the trailing newline after the last event,
 * or a keep-alive-style empty line) rather than throwing.
 */
function parseStreamLine(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Station jump-nav — see landing.css's ".lp-stationnav" doc comment for why
// this is a sticky sub-nav bar rather than a floating scroll-spy rail.
// Rendered only once wallet.status === "ready" (Home's return, below):
// before that, Station 1 is just the "Get started" wallet card and there is
// nothing yet for Stations 2/3 to jump to.
// ---------------------------------------------------------------------------

const STATIONS = [
  { id: "station-1", label: "First payment" },
  { id: "station-2", label: "Ownership verification" },
  { id: "station-3", label: "Break it" },
] as const;

function StationNav() {
  const activeId = useScrollSpy(STATIONS.map((s) => s.id));

  return (
    <nav className="lp-stationnav" aria-label="Jump to a station">
      {STATIONS.map((station) => (
        <a key={station.id} href={`#${station.id}`} className={cx(station.id === activeId && "active")}>
          {station.label}
        </a>
      ))}
    </nav>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function Home() {
  const [wallet, setWallet] = useState<WalletStage>({ status: "idle" });
  const [catalog, setCatalog] = useState<CatalogStage>({ status: "idle" });
  const [pay, setPay] = useState<PayStage>({ status: "idle" });
  const [ownership, setOwnership] = useState<OwnershipStage>({ status: "idle" });
  const [copied, setCopied] = useState(false);
  const [paymentAttacks, setPaymentAttacks] = useState<PaymentAttackStage>({ status: "idle" });
  const [catalogAttacks, setCatalogAttacks] = useState<CatalogAttackStage>({ status: "idle" });
  const [sanitizeDemo, setSanitizeDemo] = useState<SanitizeDemoState>({ status: "idle", input: "" });

  const walletElapsed = useElapsedSeconds(wallet.status === "loading" ? wallet.startedAt : null);
  const catalogElapsed = useElapsedSeconds(catalog.status === "loading" ? catalog.startedAt : null);
  const payElapsed = useElapsedSeconds(pay.status === "paying" ? pay.startedAt : null);
  const ownershipElapsed = useElapsedSeconds(ownership.status === "checking" ? ownership.startedAt : null);
  const paymentAttacksElapsed = useElapsedSeconds(paymentAttacks.status === "running" ? paymentAttacks.startedAt : null);
  const catalogAttacksElapsed = useElapsedSeconds(catalogAttacks.status === "running" ? catalogAttacks.startedAt : null);

  // Fetch the catalog automatically once a wallet exists.
  const fetchedForWallet = useRef(false);
  useEffect(() => {
    if (wallet.status === "ready" && !fetchedForWallet.current) {
      fetchedForWallet.current = true;
      void loadCatalog();
    }
  }, [wallet.status]);

  /** Persists the freshest known wallet display data to vellar.session.
   *  Deliberately excludes usdcProvisioned (not part of StoredSession) and
   *  never touches secretKey (WalletState has no such field to begin with —
   *  see the module doc comment on lib/local-storage.ts). */
  function persistSession(w: WalletState) {
    writeSession({ publicKey: w.publicKey, balanceXlm: w.balanceXlm, balanceUsdc: w.balanceUsdc });
  }

  // useCallback (not a plain function declaration) so the restore-on-mount
  // effect below can depend on it honestly, same pattern
  // app/(dashboard)/catalog/page.tsx already uses for loadCatalog/runSearch.
  const createWallet = useCallback(async (mode: "button" | "restore" = "button") => {
    const steps = initialSteps();
    if (mode === "restore") {
      setWallet({ status: "restoring" });
    } else {
      setWallet({ status: "loading", startedAt: Date.now(), steps: { ...steps } });
    }

    try {
      const res = await fetch("/api/session/create", { method: "POST" });
      if (!res.ok || !res.body) {
        if (mode === "restore") {
          // A restore attempt failing should fall back to the normal idle
          // "Get started" state, not an error screen — the user never
          // explicitly asked for anything this visit; only vellar.session's
          // mere presence triggered this.
          setWallet({ status: "idle" });
          return;
        }
        setWallet({
          status: "error",
          message: "We couldn't set up your wallet. Please try again.",
          steps: { ...steps },
        });
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let settled = false;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        // The last element may be a partial line — keep it in the buffer
        // until more bytes arrive (or the stream ends).
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const event = parseStreamLine(line);
          if (!event) continue;

          const step = event.step as string | undefined;
          const status = event.status as string | undefined;

          if (step === "complete") {
            settled = true;
            if (status === "done" && event.result && typeof event.result === "object") {
              const result = event.result as Partial<WalletState>;
              if (typeof result.publicKey === "string" && typeof result.balanceXlm === "string") {
                const w: WalletState = {
                  publicKey: result.publicKey,
                  balanceXlm: result.balanceXlm,
                  usdcProvisioned: Boolean(result.usdcProvisioned),
                  balanceUsdc: result.balanceUsdc,
                };
                persistSession(w);
                setWallet({ status: "ready", wallet: w });
                continue;
              }
            }
            const message =
              typeof event.message === "string" ? event.message : "We couldn't set up your wallet. Please try again.";
            if (mode === "restore") {
              // Same reasoning as the fetch-failure branch above — a failed
              // restore falls back to idle, not an error screen.
              setWallet({ status: "idle" });
              continue;
            }
            setWallet((prev) => ({
              status: "error",
              message,
              steps: prev.status === "loading" ? prev.steps : steps,
            }));
            continue;
          }

          if (STEP_ORDER.includes(step as StepName) && (status === "active" || status === "done" || status === "skipped" || status === "error")) {
            setWallet((prev) => {
              if (prev.status !== "loading") return prev;
              return { ...prev, steps: { ...prev.steps, [step as StepName]: status as StepStatus } };
            });
          }
        }
      }

      // Flush any trailing partial line left in the buffer once the stream
      // ends (in practice the server always terminates each event with \n,
      // but this guards against a final line with no trailing newline).
      const trailing = parseStreamLine(buffer);
      if (trailing?.step === "complete") {
        settled = true;
        const status = trailing.status as string | undefined;
        if (status === "done" && trailing.result && typeof trailing.result === "object") {
          const result = trailing.result as Partial<WalletState>;
          if (typeof result.publicKey === "string" && typeof result.balanceXlm === "string") {
            const w: WalletState = {
              publicKey: result.publicKey,
              balanceXlm: result.balanceXlm,
              usdcProvisioned: Boolean(result.usdcProvisioned),
              balanceUsdc: result.balanceUsdc,
            };
            persistSession(w);
            setWallet({ status: "ready", wallet: w });
          }
        }
      }

      if (!settled) {
        // The stream ended (network hiccup, server crash mid-stream) without
        // ever reaching a "complete" event — treat as an honest failure
        // rather than leaving the UI stuck mid-progress.
        if (mode === "restore") {
          setWallet({ status: "idle" });
        } else {
          setWallet((prev) => ({
            status: "error",
            message: "The connection ended before your wallet finished setting up. Please try again.",
            steps: prev.status === "loading" ? prev.steps : steps,
          }));
        }
      }
    } catch {
      if (mode === "restore") {
        setWallet({ status: "idle" });
      } else {
        setWallet((prev) => ({
          status: "error",
          message: "We couldn't reach the server. Please check your connection and try again.",
          steps: prev.status === "loading" ? prev.steps : steps,
        }));
      }
    }
  }, []);

  // ---------------------------------------------------------------------
  // Restore-on-mount — DESIGN DECISION (see task report for full reasoning):
  // vellar.session is a localStorage DISPLAY CACHE, not an authority — the
  // encrypted server-side cookie is the real source of truth for whether a
  // wallet still exists. So on mount, if vellar.session has data, this fires
  // the SAME POST /api/session/create the "Get started" button fires,
  // letting the server's own existing fast-path (valid cookie -> instant
  // complete event) decide whether to reuse or mint fresh. The only
  // difference from a fresh visit is framing: "Restoring your session..."
  // rather than the full 4-step provisioning animation, since a returning
  // visitor's case is (almost always) an instant fast-path response, and
  // showing "Generating your Stellar keypair..." for something that isn't
  // happening would be dishonest UI.
  const attemptedRestore = useRef(false);
  useEffect(() => {
    if (!attemptedRestore.current && readSession()) {
      attemptedRestore.current = true;
      void createWallet("restore");
    }
  }, [createWallet]);

  async function loadCatalog() {
    setCatalog({ status: "loading", startedAt: Date.now() });
    try {
      const res = await fetch("/api/catalog");
      const body = await res.json();
      if (!res.ok) {
        setCatalog({ status: "error", message: body?.message || "We couldn't load the catalog. Please try again." });
        return;
      }
      const items: CatalogItem[] = Array.isArray(body?.items) ? body.items : [];
      setCatalog({ status: "ready", items });
    } catch {
      setCatalog({ status: "error", message: "We couldn't reach the server. Please check your connection and try again." });
    }
  }

  async function payForResource(resourceUrl: string) {
    const steps = initialLedgerSteps();
    setPay({
      status: "paying",
      startedAt: Date.now(),
      resourceUrl,
      steps: { ...steps },
      attempt: 1,
      maxAttempts: 3,
      wakingUp: false,
      wakingUpSince: null,
    });

    // Tracks the most recent "verify" step's real paymentPayload as events
    // stream in, so it's available at "complete" time for vellar.lastPayment
    // — the real signed payload already flowing through the ledger, not a
    // reconstruction. Reset per retry (a whole-flow retry produces a fresh
    // signed payload — see the "retry" event handling below).
    let latestPaymentPayload: unknown = undefined;

    /** Side effects once a payment genuinely completes (status "done"):
     *  1. vellar.lastPayment — the real settlementTx/paymentPayload/etc.
     *  2. vellar.session's balance — via a fresh GET /api/session read
     *     (see DESIGN DECISION doc comment above persistSession-adjacent
     *     code: chosen over client-side subtracting the payment amount,
     *     since a fresh server read is real on-chain truth, not a fragile
     *     local computation).
     *  3. vellar.questProgress — marks Level 1 (this six-step ledger / first
     *     payment) complete, with the real settlement tx hash as proof.
     *     `verified: true` is honest here since this station already
     *     independently confirms a real settlement happened (the "settle"
     *     step's own done event), per this build's own evidence standard.
     */
    async function persistPaymentCompletion(result: PayCompleteResult) {
      writeLastPayment({
        settlementTx: result.settlementTx,
        paymentPayload: latestPaymentPayload,
        sellerUrl: resourceUrl,
        amount: result.amount ?? "",
        timestamp: Date.now(),
      });
      writeQuestLevel(1, { completedAt: Date.now(), proof: result.settlementTx, verified: true });

      try {
        const res = await fetch("/api/session");
        if (res.ok) {
          const body = (await res.json()) as { publicKey?: string; balanceXlm?: string };
          if (typeof body.publicKey === "string" && typeof body.balanceXlm === "string") {
            // Preserve the last-known USDC balance display data (GET
            // /api/session doesn't report it — only balanceXlm — so a full
            // fresh USDC read isn't available here without a second call;
            // XLM is what actually changed from network fees, and USDC is
            // refreshed on the next full session-create fast-path anyway).
            const prevStored = readSession();
            writeSession({
              publicKey: body.publicKey,
              balanceXlm: body.balanceXlm,
              balanceUsdc: prevStored?.publicKey === body.publicKey ? prevStored.balanceUsdc : undefined,
            });
          }
        }
      } catch {
        // Best-effort balance refresh — a failure here shouldn't affect the
        // payment's own already-successful outcome.
      }
    }

    /** Applies one parsed ledger event to the in-flight PayStage, whatever
     *  its current shape (paying only — once success/error lands we stop
     *  mutating). Returns the new PayStage the caller should setState to,
     *  or null if the event isn't relevant to visible state (unexpected
     *  step name — ignored defensively rather than crashing the UI). */
    function applyEvent(prev: PayStage, event: LedgerEvent): PayStage {
      if (prev.status !== "paying") return prev;

      if (event.step === "waking_up") {
        return { ...prev, wakingUp: true, wakingUpSince: prev.wakingUpSince ?? Date.now() };
      }

      if (event.step === "retry") {
        // Whole-flow restart: visibly reset all six steps to pending and
        // bump the attempt counter — see app/api/pay/route.ts's RETRY
        // VISUALIZATION doc comment for why this resets every step, not
        // just 3-5 (a retry genuinely redoes the GET too).
        const maxAttempts = typeof event.maxAttempts === "number" ? event.maxAttempts : prev.maxAttempts;
        const attempt = typeof event.attempt === "number" ? event.attempt : prev.attempt + 1;
        // A retry re-signs from scratch — the previous attempt's payload is
        // no longer the one that (maybe) settles, so drop it.
        latestPaymentPayload = undefined;
        return { ...prev, steps: initialLedgerSteps(), attempt, maxAttempts, wakingUp: false, wakingUpSince: null };
      }

      if (LEDGER_STEP_ORDER.includes(event.step as LedgerStepName)) {
        const stepName = event.step as LedgerStepName;
        const status = event.status;
        if (status !== "active" && status !== "done" && status !== "error") return prev;
        // Capture the real signed payload as it flows through the ledger —
        // used at "complete" time for vellar.lastPayment (see
        // persistPaymentCompletion above).
        if (stepName === "verify" && status === "done" && "paymentPayload" in event) {
          latestPaymentPayload = event.paymentPayload;
        }
        // A "done"/"error" on get_request clears any "waking up" framing —
        // the seller has genuinely responded by then.
        const clearsWakingUp = stepName === "get_request" && status !== "active";
        return {
          ...prev,
          wakingUp: clearsWakingUp ? false : prev.wakingUp,
          steps: {
            ...prev.steps,
            [stepName]: {
              status: status as LedgerStepStatus,
              event,
              message: typeof event.message === "string" ? event.message : undefined,
            },
          },
        };
      }

      return prev;
    }

    try {
      const res = await fetch("/api/pay", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ resourceUrl }),
      });
      if (!res.ok || !res.body) {
        setPay((prev) => ({
          status: "error",
          message: "We couldn't reach the server. Please try again.",
          resourceUrl,
          steps: prev.status === "paying" ? prev.steps : steps,
          attempt: prev.status === "paying" ? prev.attempt : 1,
        }));
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let settled = false;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const event = parsePayStreamLine(line);
          if (!event) continue;

          if (event.step === "complete") {
            settled = true;
            if (event.status === "done" && event.result && typeof event.result === "object") {
              const result = event.result as Partial<PayCompleteResult>;
              if (typeof result.settlementTx === "string") {
                const completeResult: PayCompleteResult = {
                  settlementTx: result.settlementTx,
                  payer: result.payer,
                  network: result.network,
                  amount: result.amount,
                  asset: result.asset,
                  payTo: result.payTo,
                  attempts: typeof result.attempts === "number" ? result.attempts : 1,
                };
                void persistPaymentCompletion(completeResult);
                setPay((prev) => ({
                  status: "success",
                  result: completeResult,
                  resourceUrl,
                  steps: prev.status === "paying" ? prev.steps : steps,
                  attempt: prev.status === "paying" ? prev.attempt : 1,
                }));
                continue;
              }
            }
            const message = typeof event.message === "string" ? event.message : "Payment failed. Please try again.";
            setPay((prev) => ({
              status: "error",
              message,
              resourceUrl,
              steps: prev.status === "paying" ? prev.steps : steps,
              attempt: prev.status === "paying" ? prev.attempt : 1,
            }));
            continue;
          }

          setPay((prev) => applyEvent(prev, event));
        }
      }

      const trailing = parsePayStreamLine(buffer);
      if (trailing?.step === "complete") {
        settled = true;
        if (trailing.status === "done" && trailing.result && typeof trailing.result === "object") {
          const result = trailing.result as Partial<PayCompleteResult>;
          if (typeof result.settlementTx === "string") {
            const completeResult: PayCompleteResult = {
              settlementTx: result.settlementTx,
              payer: result.payer,
              network: result.network,
              amount: result.amount,
              asset: result.asset,
              payTo: result.payTo,
              attempts: typeof result.attempts === "number" ? result.attempts : 1,
            };
            void persistPaymentCompletion(completeResult);
            setPay((prev) => ({
              status: "success",
              result: completeResult,
              resourceUrl,
              steps: prev.status === "paying" ? prev.steps : steps,
              attempt: prev.status === "paying" ? prev.attempt : 1,
            }));
          }
        }
      }

      if (!settled) {
        setPay((prev) => ({
          status: "error",
          message: "The connection ended before your payment finished. Please try again.",
          resourceUrl,
          steps: prev.status === "paying" ? prev.steps : steps,
          attempt: prev.status === "paying" ? prev.attempt : 1,
        }));
      }
    } catch {
      setPay((prev) => ({
        status: "error",
        message: "We couldn't reach the server. Please check your connection and try again.",
        resourceUrl,
        steps: prev.status === "paying" ? prev.steps : steps,
        attempt: prev.status === "paying" ? prev.attempt : 1,
      }));
    }
  }

  // ---------------------------------------------------------------------
  // Station 2 — ownership verification. Streams POST /api/verify-ownership
  // (see that route's wire-format doc comment): five real steps, the
  // playground's own independent re-check of the same kind of thing the
  // facilitator's internal verifyResourceOwnership() does. No session
  // involvement — this is public, unauthenticated data end to end.
  //
  // QUEST PROGRESS TRIGGER POINT (documented per the task's explicit ask):
  // vellar.questProgress[2] (Level 2) is written once this stream reaches
  // its terminal "complete" event with status "done" — i.e. once the live
  // re-verification check has genuinely run to a verdict (see the "verdict"
  // step's applyEvent branch below, which stashes the parsed
  // OwnershipVerdictResult, and the "complete" handling that persists it).
  // This mirrors PayLedger's Level 1 trigger (written on that stream's own
  // "complete"/"done"), so both stations agree on "the mechanism was
  // genuinely demonstrated to a terminal outcome" as the completion
  // signal — not merely "the button was clicked" (that fires on `checking`,
  // before anything real has happened yet).
  //
  // PROOF FIELD — DISCREPANCY, flagged rather than papered over (see
  // lib/local-storage.ts's StoredQuestLevel doc comment for the full
  // reasoning): Station 2 is read-only and never produces an XDR. The proof
  // written below is `verdictText` — the real verdict Station 2's own
  // "verdict" step produces (e.g. "Confirmed — already verified..."), the
  // actual evidence this station generates.
  async function runVerifyOwnership() {
    const steps = initialOwnershipSteps();
    setOwnership({ status: "checking", startedAt: Date.now(), steps: { ...steps } });

    function applyEvent(prev: OwnershipStage, event: OwnershipEvent): OwnershipStage {
      if (prev.status !== "checking") return prev;
      if (!OWNERSHIP_STEP_ORDER.includes(event.step as OwnershipStepName)) return prev;
      const stepName = event.step as OwnershipStepName;
      const status = event.status;
      if (status !== "active" && status !== "done" && status !== "error") return prev;
      return {
        ...prev,
        steps: {
          ...prev.steps,
          [stepName]: {
            status: status as OwnershipStepStatus,
            event,
            message: typeof event.message === "string" ? event.message : undefined,
          },
        },
      };
    }

    try {
      const res = await fetch("/api/verify-ownership", { method: "POST" });
      if (!res.ok || !res.body) {
        setOwnership((prev) => ({
          status: "error",
          message: "We couldn't reach the server. Please try again.",
          steps: prev.status === "checking" ? prev.steps : steps,
        }));
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let settled = false;

      const finish = (event: OwnershipEvent) => {
        settled = true;
        if (event.status === "done") {
          // The "verdict" step (already applied via applyEvent above) is the
          // real source of the result fields — read them back off the
          // in-progress step map rather than re-deriving from "complete"
          // (which carries no payload of its own, see the route's wire doc).
          setOwnership((prev) => {
            if (prev.status !== "checking") return prev;
            const verdictEvent = prev.steps.verdict.event;
            if (
              verdictEvent &&
              typeof verdictEvent.match === "boolean" &&
              typeof verdictEvent.verdictText === "string"
            ) {
              const result: OwnershipVerdictResult = {
                match: verdictEvent.match,
                verdictText: verdictEvent.verdictText,
                challengePayTos: Array.isArray(verdictEvent.challengePayTos)
                  ? (verdictEvent.challengePayTos as string[])
                  : [],
                boundPayTos: Array.isArray(verdictEvent.boundPayTos) ? (verdictEvent.boundPayTos as string[]) : [],
              };
              writeQuestLevel(2, {
                completedAt: Date.now(),
                proof: verdictEvent.verdictText,
                verified: true,
              });
              return { status: "success", result, steps: prev.steps };
            }
            return {
              status: "error",
              message: "The verification stream ended without a clear verdict. Please try again.",
              steps: prev.steps,
            };
          });
          return;
        }
        const message = typeof event.message === "string" ? event.message : "Verification failed. Please try again.";
        setOwnership((prev) => ({
          status: "error",
          message,
          steps: prev.status === "checking" ? prev.steps : steps,
        }));
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const event = parseOwnershipStreamLine(line);
          if (!event) continue;
          if (event.step === "complete") {
            finish(event);
            continue;
          }
          setOwnership((prev) => applyEvent(prev, event));
        }
      }

      const trailing = parseOwnershipStreamLine(buffer);
      if (trailing?.step === "complete") {
        finish(trailing);
      }

      if (!settled) {
        setOwnership((prev) => ({
          status: "error",
          message: "The connection ended before verification finished. Please try again.",
          steps: prev.status === "checking" ? prev.steps : steps,
        }));
      }
    } catch {
      setOwnership((prev) => ({
        status: "error",
        message: "We couldn't reach the server. Please check your connection and try again.",
        steps: prev.status === "checking" ? prev.steps : steps,
      }));
    }
  }

  // ---------------------------------------------------------------------
  // Station 3 — payment-attack track. Streams POST /api/attack/payment (see
  // that route's wire-format doc comment): arms one real signed payload
  // using the current session's wallet, then runs all 5 attacks live
  // against the real facilitator. Requires a funded session — same
  // precondition as Station 1.
  // ---------------------------------------------------------------------
  async function runPaymentAttacks() {
    const attacks = initialPaymentAttackMap();
    setPaymentAttacks({ status: "running", startedAt: Date.now(), attacks: { ...attacks } });

    function applyAttackEvent(prev: PaymentAttackStage, event: AttackStreamEvent): PaymentAttackStage {
      if (prev.status !== "running") return prev;
      const attackId = event.attackId as PaymentAttackId | undefined;
      if (!attackId || !(attackId in prev.attacks)) return prev;
      if (event.status === "active") {
        return { ...prev, attacks: { ...prev.attacks, [attackId]: { status: "active" } } };
      }
      if (event.status === "done" && event.result) {
        writeAttackResult(event.result);
        return { ...prev, attacks: { ...prev.attacks, [attackId]: { status: "done", result: event.result } } };
      }
      if (event.status === "error") {
        return {
          ...prev,
          attacks: { ...prev.attacks, [attackId]: { status: "error", message: event.message } },
        };
      }
      return prev;
    }

    try {
      const res = await fetch("/api/attack/payment", { method: "POST" });
      if (!res.ok || !res.body) {
        const body = await res.json().catch(() => ({}));
        const message =
          typeof body?.message === "string"
            ? body.message
            : "We couldn't reach the server. Please try again.";
        setPaymentAttacks((prev) => ({
          status: "error",
          message,
          attacks: prev.status === "running" ? prev.attacks : attacks,
        }));
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let settled = false;

      const finish = (event: AttackStreamEvent) => {
        settled = true;
        if (event.status === "done") {
          setPaymentAttacks((prev) => ({ status: "done", attacks: prev.status === "running" ? prev.attacks : attacks }));
          return;
        }
        const message = typeof event.message === "string" ? event.message : "The attack bench failed. Please try again.";
        setPaymentAttacks((prev) => ({
          status: "error",
          message,
          attacks: prev.status === "running" ? prev.attacks : attacks,
        }));
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const event = parseAttackStreamLine(line);
          if (!event) continue;
          if (event.step === "complete") {
            finish(event);
            continue;
          }
          if (event.step === "attack") {
            setPaymentAttacks((prev) => applyAttackEvent(prev, event));
          }
          // "armed" step events are intentionally not surfaced as their own
          // row — the 5 attack rows below are the meaningful UI surface;
          // arming failure is still caught by the "complete"/"error" path.
        }
      }

      const trailing = parseAttackStreamLine(buffer);
      if (trailing?.step === "complete") finish(trailing);

      if (!settled) {
        setPaymentAttacks((prev) => ({
          status: "error",
          message: "The connection ended before the attack bench finished. Please try again.",
          attacks: prev.status === "running" ? prev.attacks : attacks,
        }));
      }
    } catch {
      setPaymentAttacks((prev) => ({
        status: "error",
        message: "We couldn't reach the server. Please check your connection and try again.",
        attacks: prev.status === "running" ? prev.attacks : attacks,
      }));
    }
  }

  // ---------------------------------------------------------------------
  // Station 3 — catalog-attack track. Streams POST /api/attack/catalog (see
  // that route's wire-format doc comment): both attacks are real live polls
  // against the public facilitator, no session needed.
  // ---------------------------------------------------------------------
  async function runCatalogAttacks() {
    const attacks = initialCatalogAttackMap();
    setCatalogAttacks({ status: "running", startedAt: Date.now(), attacks: { ...attacks } });

    function applyAttackEvent(prev: CatalogAttackStage, event: AttackStreamEvent): CatalogAttackStage {
      if (prev.status !== "running") return prev;
      const attackId = event.attackId as CatalogAttackId | undefined;
      if (!attackId || !(attackId in prev.attacks)) return prev;
      if (event.status === "active") {
        return { ...prev, attacks: { ...prev.attacks, [attackId]: { status: "active" } } };
      }
      if (event.status === "done" && event.result) {
        writeAttackResult(event.result);
        return { ...prev, attacks: { ...prev.attacks, [attackId]: { status: "done", result: event.result } } };
      }
      if (event.status === "error") {
        return {
          ...prev,
          attacks: { ...prev.attacks, [attackId]: { status: "error", message: event.message } },
        };
      }
      return prev;
    }

    try {
      const res = await fetch("/api/attack/catalog", { method: "POST" });
      if (!res.ok || !res.body) {
        setCatalogAttacks((prev) => ({
          status: "error",
          message: "We couldn't reach the server. Please try again.",
          attacks: prev.status === "running" ? prev.attacks : attacks,
        }));
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let settled = false;

      const finish = (event: AttackStreamEvent) => {
        settled = true;
        if (event.status === "done") {
          setCatalogAttacks((prev) => ({ status: "done", attacks: prev.status === "running" ? prev.attacks : attacks }));
          return;
        }
        const message = typeof event.message === "string" ? event.message : "The attack bench failed. Please try again.";
        setCatalogAttacks((prev) => ({
          status: "error",
          message,
          attacks: prev.status === "running" ? prev.attacks : attacks,
        }));
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const event = parseAttackStreamLine(line);
          if (!event) continue;
          if (event.step === "complete") {
            finish(event);
            continue;
          }
          if (event.step === "attack") {
            setCatalogAttacks((prev) => applyAttackEvent(prev, event));
          }
        }
      }

      const trailing = parseAttackStreamLine(buffer);
      if (trailing?.step === "complete") finish(trailing);

      if (!settled) {
        setCatalogAttacks((prev) => ({
          status: "error",
          message: "The connection ended before the attack bench finished. Please try again.",
          attacks: prev.status === "running" ? prev.attacks : attacks,
        }));
      }
    } catch {
      setCatalogAttacks((prev) => ({
        status: "error",
        message: "We couldn't reach the server. Please check your connection and try again.",
        attacks: prev.status === "running" ? prev.attacks : attacks,
      }));
    }
  }

  // ---------------------------------------------------------------------
  // Station 3 — attack 8 (prompt_injection). A single non-streaming call to
  // POST /api/attack/sanitize — see that route's doc comment: this is a
  // faithful LOCAL port of the facilitator's real sanitizer, not a live
  // round-trip. The UI copy for this section says so explicitly.
  // ---------------------------------------------------------------------
  async function runSanitizeDemo(input: string) {
    setSanitizeDemo({ status: "loading", input });
    try {
      const res = await fetch("/api/attack/sanitize", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: input }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setSanitizeDemo({
          status: "error",
          input,
          message: typeof body?.message === "string" ? body.message : "Something went wrong. Please try again.",
        });
        return;
      }
      const result = body as StoredAttackResult;
      writeAttackResult(result);
      setSanitizeDemo({ status: "done", input, result });
    } catch {
      setSanitizeDemo({
        status: "error",
        input,
        message: "We couldn't reach the server. Please check your connection and try again.",
      });
    }
  }

  // ---------------------------------------------------------------------
  // Start fresh — discards the server-side session cookie (the real source
  // of truth for the secret key) via DELETE /api/session, clears every
  // vellar.* localStorage key, then resets this page's in-memory React
  // state back to its initial idle shape.
  //
  // DESIGN DECISION: in-memory reset chosen over a simpler "just reload the
  // page" — wiring the reset across wallet/catalog/pay state turned out to
  // be a handful of setState calls, not awkward enough to justify a full
  // reload; this way "Start fresh" feels instant (no white-flash reload)
  // and stays consistent with the rest of this page's live, no-reload
  // philosophy (streamed wallet creation, streamed payments).
  async function startFresh() {
    try {
      await fetch("/api/session", { method: "DELETE" });
    } catch {
      // Best-effort — even if the network call fails, still clear local
      // state below so the UI reflects "start fresh" was requested. A
      // failed DELETE leaves the server cookie in place, but it will
      // simply be reused next time (no user-visible harm beyond that).
    }
    clearAll();
    setWallet({ status: "idle" });
    setCatalog({ status: "idle" });
    setPay({ status: "idle" });
    setOwnership({ status: "idle" });
    setPaymentAttacks({ status: "idle" });
    setCatalogAttacks({ status: "idle" });
    setSanitizeDemo({ status: "idle", input: "" });
    setCopied(false);
    fetchedForWallet.current = false;
  }

  return (
    <>
      <div className="lp-content-head">
        <Eyebrow>Vellar Playground</Eyebrow>
        <h1>Watch a 402 turn into a 200.</h1>
        <p className="lp-lead">
          A playground for external developers to visually try out the Vellar x402 payment facilitator
          on Stellar testnet — get a real funded wallet, browse the live Bazaar catalog, and pay a real
          invoice, no setup required.
        </p>
      </div>

      {/* ---- In-page jump nav — only once there's more than one station's
          worth of content to jump between (see StationNav's doc comment). ---- */}
      {wallet.status === "ready" && <StationNav />}

      <div id="station-1">
        <div className="lp-dgrid lp-dgrid--wide">
          {/* ---- Wallet panel ---- */}
          <div className="lp-dpanel">
            <div className="lp-dpanel-head">
              <h2>Your wallet</h2>
            </div>
            <WalletSection
              wallet={wallet}
              elapsed={walletElapsed}
              onCreate={() => createWallet("button")}
              copied={copied}
              onCopy={async (pk) => {
                await copyToClipboard(pk);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
              onStartFresh={startFresh}
            />
          </div>

          {/* ---- Catalog panel ---- */}
          {wallet.status === "ready" && (
            <div className="lp-dpanel lp-dpanel--lime">
              <CatalogSection
                catalog={catalog}
                elapsed={catalogElapsed}
                onRetry={loadCatalog}
                onPay={payForResource}
                payBusy={pay.status === "paying"}
              />
            </div>
          )}

          {/* ---- Payment ledger panel (the cinematic moment) ---- */}
          {wallet.status === "ready" && pay.status !== "idle" && (
            <div className="lp-dpanel lp-dpanel--dark lp-dpanel--span2">
              <PayLedger pay={pay} elapsed={payElapsed} onRetry={() => payForResource(pay.resourceUrl)} />
            </div>
          )}
        </div>

        {/* ---- Who is involved ---- */}
        {wallet.status === "ready" && pay.status !== "idle" && (
          <WhoIsInvolved publicKey={wallet.wallet.publicKey} pay={pay} />
        )}

        {/* ---- Run this on your machine ---- */}
        {wallet.status === "ready" && pay.status !== "idle" && (
          <RunOnYourMachine publicKey={wallet.wallet.publicKey} resourceUrl={pay.resourceUrl} />
        )}
      </div>

      {/* ---- Station 2: ownership verification ----
          PLACEMENT DECISION: below Station 1's payment ledger / "who is
          involved" / "run this on your machine" — the natural next teaching
          moment once a visitor has seen a 402 turn into a 200. Gated only on
          `wallet.status === "ready"` (NOT on `pay.status !== "idle"`) —
          unlike Station 1, this station teaches something about the
          RESOURCE's durable, permanent verification state, which is true
          regardless of whether this particular visitor has paid yet. A
          visitor who never pays can still see the catalog entry, the
          historical binding explanation, and run the live re-check. */}
      {wallet.status === "ready" && (
        <OwnershipSection
          catalog={catalog}
          ownership={ownership}
          elapsed={ownershipElapsed}
          onVerify={runVerifyOwnership}
        />
      )}

      {/* ---- Station 2's own "Run this on your machine" footer ---- */}
      {wallet.status === "ready" && <RunVerifyOnYourMachine />}

      {/* ---- Station 3: the attack bench ----
          PLACEMENT DECISION: below Station 2, same reasoning — the natural
          next teaching moment once a visitor has seen the facilitator
          accept a real payment and confirm a real binding. Gated on
          `wallet.status === "ready"` since the payment-attack track needs a
          funded session wallet to arm the bench (same precondition as
          Station 1); the catalog-attack track needs no session at all but
          is kept in the same gated section for a consistent narrative
          flow. */}
      {wallet.status === "ready" && (
        <AttackBenchSection
          paymentAttacks={paymentAttacks}
          catalogAttacks={catalogAttacks}
          sanitizeDemo={sanitizeDemo}
          paymentElapsed={paymentAttacksElapsed}
          catalogElapsed={catalogAttacksElapsed}
          onRunPaymentAttacks={runPaymentAttacks}
          onRunCatalogAttacks={runCatalogAttacks}
          onRunSanitizeDemo={runSanitizeDemo}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Wallet section
// ---------------------------------------------------------------------------

function StepProgress({ steps }: { steps: StepMap }) {
  return (
    <div className="lp-steps-card">
      {STEP_ORDER.map((step) => {
        const status = steps[step];
        const state = status === "pending" ? "pending" : status;
        const note =
          status === "skipped"
            ? "Skipped — wallet still usable"
            : status === "error"
              ? "Failed"
              : undefined;
        return (
          <div className="lp-step-row" data-state={state} key={step}>
            <span className="lp-step-mark" aria-hidden />
            <span className="lp-step-label">{STEP_LABELS[step]}</span>
            {note && <span className="lp-step-note">{note}</span>}
          </div>
        );
      })}
    </div>
  );
}

function WalletSection({
  wallet,
  elapsed,
  onCreate,
  copied,
  onCopy,
  onStartFresh,
}: {
  wallet: WalletStage;
  elapsed: number;
  onCreate: () => void;
  copied: boolean;
  onCopy: (pk: string) => void;
  onStartFresh: () => void;
}) {
  if (wallet.status === "idle") {
    return (
      <div className="lp-cta-row" style={{ marginTop: 0 }}>
        <LpActionButton variant="sun" size="lg" onClick={onCreate}>
          Get started →
        </LpActionButton>
      </div>
    );
  }

  if (wallet.status === "restoring") {
    return (
      <p className="lp-lead" style={{ fontSize: "0.9rem" }}>
        Restoring your session...
      </p>
    );
  }

  if (wallet.status === "loading") {
    return (
      <div>
        <p className="lp-lead" style={{ fontSize: "0.9rem" }}>
          Setting up your wallet, live — each step below only ticks once it has genuinely finished
          ({elapsed}s).
        </p>
        <div style={{ marginTop: "var(--lp-sp-4)" }}>
          <StepProgress steps={wallet.steps} />
        </div>
      </div>
    );
  }

  if (wallet.status === "error") {
    return (
      <div>
        {wallet.steps && (
          <div style={{ marginBottom: "var(--lp-sp-4)" }}>
            <StepProgress steps={wallet.steps} />
          </div>
        )}
        <p className="lp-lead">{wallet.message}</p>
        <div className="lp-cta-row">
          <LpActionButton variant="outline" onClick={onCreate}>
            Try again
          </LpActionButton>
        </div>
      </div>
    );
  }

  const { publicKey, balanceXlm, usdcProvisioned, balanceUsdc } = wallet.wallet;
  const explorerUrl = `https://stellar.expert/explorer/testnet/account/${publicKey}`;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--lp-sp-4)" }}>
      <Field
        label="PUBLIC KEY"
        amount={truncateKey(publicKey)}
        amountStyle={{ fontSize: 18, fontFamily: "var(--lp-mono)" }}
        sub={
          <>
            <button
              type="button"
              onClick={() => onCopy(publicKey)}
              style={{
                background: "none",
                border: 0,
                padding: 0,
                font: "inherit",
                color: "inherit",
                cursor: "pointer",
                textDecoration: "underline",
              }}
            >
              {copied ? "Copied!" : "Copy"}
            </button>
            <a href={explorerUrl} target="_blank" rel="noreferrer">
              View on Stellar Expert →
            </a>
          </>
        }
      />
      <Field label="BALANCE" amount={balanceXlm} token={<TokenPill label="XLM" />} />
      {usdcProvisioned && balanceUsdc ? (
        <Field label="BALANCE" amount={balanceUsdc} token={<TokenPill label="USDC" usdc />} />
      ) : (
        <p className="lp-lead" style={{ fontSize: "0.85rem" }}>
          USDC funding didn&apos;t complete — you can still browse the catalog, but paying may not work
          yet.
        </p>
      )}
      <div className="lp-cta-row" style={{ marginTop: "var(--lp-sp-2)" }}>
        <LpActionButton variant="outline" size="sm" onClick={onStartFresh}>
          Start fresh
        </LpActionButton>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Catalog section
// ---------------------------------------------------------------------------

function trustLabel(trust?: CatalogItem["trust"]): { text: string; verified: boolean } {
  if (!trust) return { text: "Unknown", verified: false };
  if (trust.ownerVerified === true) return { text: "Verified", verified: true };
  const state = trust.ownershipState || trust.verification;
  if (state === "unverified") return { text: "Unverified", verified: false };
  return { text: "Unknown", verified: false };
}

function CatalogSection({
  catalog,
  elapsed,
  onRetry,
  onPay,
  payBusy,
}: {
  catalog: CatalogStage;
  elapsed: number;
  onRetry: () => void;
  onPay: (resourceUrl: string) => void;
  payBusy: boolean;
}) {
  return (
    <>
      <div className="lp-dpanel-head">
        <div>
          <Eyebrow>Bazaar catalog</Eyebrow>
          <h2 style={{ marginTop: "var(--lp-sp-2)" }}>Live resources, from the real facilitator.</h2>
        </div>
      </div>

      {catalog.status === "loading" && (
        <p className="lp-lead">
          Waking up the facilitator... ({elapsed}s)
          {elapsed > COLD_START_CEILING_MS / 1000 && " This is taking longer than usual."}
        </p>
      )}

      {catalog.status === "error" && (
        <div>
          <p className="lp-lead">{catalog.message}</p>
          <div className="lp-cta-row">
            <LpActionButton variant="outline" onClick={onRetry}>
              Retry
            </LpActionButton>
          </div>
        </div>
      )}

      {catalog.status === "ready" && catalog.items.length === 0 && (
        <p className="lp-lead">No resources are cataloged yet.</p>
      )}

      {catalog.status === "ready" && catalog.items.length > 0 && (
        <div className="lp-rlist">
          {catalog.items.map((item) => {
            const accept = item.accepts?.[0];
            const trust = trustLabel(item.trust);
            const isDemoResource = item.resource === DEMO_RESOURCE_URL;
            return (
              <div className="lp-rrow" key={item.resource}>
                <div className="ri"></div>
                <div className="rn">
                  <b>{item.description || item.resource}</b>
                  <span>
                    {formatAtomicAmount(accept?.amount)} atomic of {truncateMiddle(accept?.asset || "—")}
                    {" · "}
                    {truncateMiddle(item.resource, 24, 10)}
                  </span>
                </div>
                <span className="lp-verified" style={!trust.verified ? { background: "var(--lp-paper-tint)" } : undefined}>
                  {trust.verified ? "✓ " : ""}
                  {trust.text}
                </span>
                <button
                  type="button"
                  className="open"
                  style={{ border: 0, cursor: isDemoResource ? "pointer" : "not-allowed", opacity: isDemoResource ? 1 : 0.5 }}
                  disabled={!isDemoResource || payBusy}
                  title={isDemoResource ? "Pay this resource" : "This demo only pays the featured resource below"}
                  onClick={() => isDemoResource && onPay(item.resource)}
                >
                  Pay
                </button>
              </div>
            );
          })}
        </div>
      )}

      {/* Scoped to the single demo seller resource for this step (see report:
          catalog Pay buttons only work for vellar-seller-demo's /quote — other
          catalog entries are shown but their Pay button is disabled and says why). */}
      <div className="lp-cta-row">
        <LpActionButton variant="sun" size="lg" onClick={() => onPay(DEMO_RESOURCE_URL)} disabled={payBusy}>
          Pay the demo resource →
        </LpActionButton>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Payment ledger — the cinematic moment, six real steps
// ---------------------------------------------------------------------------
//
// Reuses the .lp-step-row/.lp-step-mark 4-state pattern proven for wallet
// creation (mint=done/sun=active pulse/coral=error/amber=skipped — "skipped"
// is unused here, this flow has no graceful-degradation step), extended
// from 4 steps to 6. Each step's raw wire bytes render in a collapsible
// <details> styled after the FAQ section's .lp-fitem disclosure pattern
// (rotating "+" marker) — JUDGMENT CALL: reused verbatim rather than
// inventing new CSS, since .lp-fitem's visual language (a plus-marker button
// that rotates 45° into an "×" on open, revealing a body below) adapts
// cleanly to "click to reveal raw bytes" with no new rules needed.

function ledgerStepStatusLabel(step: LedgerStepState): string {
  if (step.status === "pending") return "Waiting";
  if (step.status === "active") return "In progress";
  if (step.status === "error") return step.message ?? "Failed";
  return "Done";
}

/** One raw-wire-bytes disclosure for a single ledger step. Renders nothing
 *  if the step hasn't emitted a "done" (or "error" with useful detail) event
 *  yet — there's nothing real to show before then. */
function StepRawBytes({ step, stepName }: { step: LedgerStepState; stepName: LedgerStepName }) {
  const event = step.event;
  if (!event || step.status === "pending" || step.status === "active") return null;

  let rows: Array<{ label: string; value: string }> = [];
  let note: string | undefined;

  if (stepName === "get_request" && event.status === "done") {
    rows = [
      { label: "request", value: String(event.requestLine ?? "") },
      { label: "status", value: String(event.responseStatus ?? "") },
      { label: "PAYMENT-REQUIRED (raw, base64)", value: truncateMiddle(String(event.rawPaymentRequiredHeader ?? ""), 28, 10) },
    ];
    note = "The PAYMENT-REQUIRED header is base64 — decoded above into the 402 challenge.";
  } else if (stepName === "sign" && event.status === "done") {
    rows = [{ label: "signed payload (base64 XDR)", value: truncateMiddle(String(event.xdr ?? ""), 28, 10) }];
    note = typeof event.note === "string" ? event.note : undefined;
  } else if (stepName === "verify" && event.status === "done") {
    rows = [
      { label: "paymentRequirements", value: truncateMiddle(JSON.stringify(event.paymentRequirements ?? {}), 40, 10) },
      { label: "paymentPayload.accepted", value: truncateMiddle(JSON.stringify((event.paymentPayload as { accepted?: unknown })?.accepted ?? {}), 40, 10) },
    ];
    note = typeof event.responseNote === "string" ? event.responseNote : undefined;
  } else if (stepName === "settle" && event.status === "done") {
    rows = [{ label: "settlement tx", value: String(event.settlementTx ?? "") }];
  } else if (stepName === "result" && event.status === "done") {
    rows = [
      { label: "settlement tx", value: String(event.settlementTx ?? "") },
      { label: "response body", value: truncateMiddle(JSON.stringify(event.body ?? {}), 40, 10) },
    ];
  } else if (event.status === "error") {
    rows = [{ label: "error", value: step.message ?? "failed" }];
  }

  if (rows.length === 0 && !note) return null;

  return (
    <details className="lp-fitem lp-fitem--raw">
      <summary>
        <span>Raw wire bytes</span>
        <span className="pm" aria-hidden>
          +
        </span>
      </summary>
      <div className="body">
        <MonoRows>
          {rows.map((r, i) => (
            <MonoRow key={`${r.label}-${i}`} label={r.label} value={r.value} />
          ))}
        </MonoRows>
        {note && (
          <p className="lp-lead" style={{ fontSize: "0.8rem", marginTop: "var(--lp-sp-3)" }}>
            {note}
          </p>
        )}
      </div>
    </details>
  );
}

function PayLedger({ pay, elapsed, onRetry }: { pay: PayStage; elapsed: number; onRetry: () => void }) {
  if (pay.status === "idle") return null;

  const steps = pay.status === "paying" || pay.status === "success" || pay.status === "error" ? pay.steps : initialLedgerSteps();
  const attempt = pay.status === "paying" || pay.status === "success" || pay.status === "error" ? pay.attempt : 1;
  const maxAttempts = pay.status === "paying" ? pay.maxAttempts : 3;

  return (
    <div className="lp-trace-grid">
      <div>
        <Eyebrow>One request, end to end</Eyebrow>
        <h2 style={{ marginTop: "var(--lp-sp-4)" }}>
          Your wallet hits a paywall. <em>It pays it.</em>
        </h2>
        <p className="lp-lead">
          GET the resource, get a 402, build and sign a Stellar payment, verify and settle it, and
          receive the paid resource — all from a real testnet keypair, no browser secret. Six real
          steps, each one only ticks once it has genuinely happened.
        </p>

        {pay.status === "paying" && attempt > 1 && (
          <p className="lp-lead" style={{ marginTop: "var(--lp-sp-4)", fontWeight: 700 }}>
            Attempt {attempt} of {maxAttempts} — the first attempt didn&apos;t settle (this happens on
            testnet), so the whole flow restarted with a fresh signature.
          </p>
        )}
        {pay.status === "paying" && pay.wakingUp && (
          <p className="lp-lead" style={{ marginTop: "var(--lp-sp-4)" }}>
            The demo seller looks like it&apos;s waking up from a cold start — this can take up to a
            minute on testnet. ({elapsed}s)
          </p>
        )}
        {pay.status === "paying" && !pay.wakingUp && (
          <p className="lp-lead" style={{ marginTop: "var(--lp-sp-4)" }}>
            Paying... ({elapsed}s)
          </p>
        )}
        {pay.status === "error" && (
          <div style={{ marginTop: "var(--lp-sp-6)" }}>
            <p className="lp-lead">{pay.message}</p>
            <div className="lp-cta-row">
              <LpActionButton variant="ghost" onClick={onRetry}>
                Try again
              </LpActionButton>
            </div>
          </div>
        )}
        {pay.status === "success" && (
          <div style={{ marginTop: "var(--lp-sp-6)" }}>
            <p className="lp-lead">
              Settled in {pay.result.attempts} attempt{pay.result.attempts === 1 ? "" : "s"}.
            </p>
            {pay.result.settlementTx && (
              <div className="lp-cta-row" style={{ flexWrap: "wrap" }}>
                <a
                  className="lp-btn lp-btn--ghost"
                  href={`https://horizon-testnet.stellar.org/transactions/${pay.result.settlementTx}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  View on Horizon →
                </a>
                <a className="lp-btn lp-btn--ghost" href="https://explorer.vellar.xyz" target="_blank" rel="noreferrer">
                  Open Vellar Explorer →
                </a>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="lp-trace-panel">
        <div className="head">
          <span>{truncateMiddle(pay.resourceUrl, 24, 12)}</span>
          <span>402 → 200</span>
        </div>

        <div className="lp-steps-card">
          {LEDGER_STEP_ORDER.map((stepName) => {
            const step = steps[stepName];
            return (
              <div key={stepName}>
                <div className="lp-step-row" data-state={step.status}>
                  <span className="lp-step-mark" aria-hidden />
                  <span className="lp-step-label">{LEDGER_STEP_LABELS[stepName]}</span>
                  <span className="lp-step-note">{ledgerStepStatusLabel(step)}</span>
                </div>
                <StepRawBytes step={step} stepName={stepName} />
              </div>
            );
          })}
        </div>

        <div className="lp-trace-bar">
          <i />
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Who is involved
// ---------------------------------------------------------------------------
//
// JUDGMENT CALL — explorer-link convention: account-shaped entities (Buyer,
// USDC contract) reuse this app's existing Stellar Expert account-link
// pattern (see WalletSection's explorerUrl above) for consistency. The
// Facilitator and Seller are HTTP services, not Stellar accounts — they have
// no account explorer page, so their card just links directly to their own
// base URL rather than a fabricated explorer link.

function explorerAccountUrl(key: string): string {
  return `https://stellar.expert/explorer/testnet/account/${key}`;
}

function WhoIsInvolvedCard({ label, value, href, mono = true }: { label: string; value: string; href: string; mono?: boolean }) {
  return (
    <div className="lp-dpanel" style={{ padding: "var(--lp-sp-4)", gap: "var(--lp-sp-2)" }}>
      <div className="lbl" style={{ fontSize: "0.75rem", fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--lp-ink-faint)" }}>
        {label}
      </div>
      <div style={{ fontFamily: mono ? "var(--lp-mono)" : undefined, fontSize: "0.875rem", wordBreak: "break-all" }}>
        {truncateMiddle(value, 20, 8)}
      </div>
      <a href={href} target="_blank" rel="noreferrer" style={{ fontSize: "0.8rem", fontWeight: 700 }}>
        View →
      </a>
    </div>
  );
}

function WhoIsInvolved({ publicKey, pay }: { publicKey: string; pay: PayStage }) {
  const steps = pay.status === "paying" || pay.status === "success" || pay.status === "error" ? pay.steps : initialLedgerSteps();
  const challengeEvent = steps.challenge.event;
  const usdcAsset = typeof challengeEvent?.asset === "string" ? challengeEvent.asset : null;

  return (
    <div style={{ marginTop: "var(--lp-sp-8)" }}>
      <Eyebrow>Who is involved</Eyebrow>
      <div className="lp-dgrid" style={{ marginTop: "var(--lp-sp-4)", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
        <WhoIsInvolvedCard label="Buyer (your session wallet)" value={publicKey} href={explorerAccountUrl(publicKey)} />
        <WhoIsInvolvedCard label="Seller" value={SELLER_URL} href={SELLER_URL} mono={false} />
        <WhoIsInvolvedCard label="Facilitator" value={FACILITATOR_URL} href={FACILITATOR_URL} mono={false} />
        {usdcAsset && <WhoIsInvolvedCard label="USDC contract" value={usdcAsset} href={explorerAccountUrl(usdcAsset)} />}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Run this on your machine
// ---------------------------------------------------------------------------
//
// JUDGMENT CALL — the CLI tab cannot be 100% paste-and-run for a visitor who
// doesn't have their own testnet secret key exported locally, since this
// playground's session key stays server-side by design and is never sent to
// the browser. The snippet is honest about this: it substitutes the real
// RESOURCE_URL but leaves PAYER_SECRET as an explicit placeholder with a
// one-line explanation, rather than a fabricated value. The curl tab CAN be
// fully real (it only demonstrates the unpaid GET -> 402, the same step 1
// this page already showed happening), so it substitutes the real seller URL.
//
// REUSABILITY REFACTOR (see task report for full reasoning): this component
// used to require {publicKey, resourceUrl} as props, sourced from the home
// page's own live wallet/pay state — which meant it could only ever render
// on a page where a payment had just happened live, in the same session.
// Both props are now OPTIONAL: when a caller has live data in hand (this
// page, right after a payment), it can still pass them directly, same as
// before. When omitted, the component reads vellar.lastPayment (for
// resourceUrl) and vellar.session (for publicKey) via lib/local-storage.ts
// directly — so it can be dropped onto any other page with no props at all
// and still render meaningfully from a PRIOR payment made in this browser,
// not just a live one. If vellar.lastPayment is empty (no payment has ever
// happened in this browser), it renders a "make a payment first" empty
// state instead of broken/blank output — same tone as this app's other
// empty states (e.g. /catalog's "No resources are cataloged yet.").

function RunOnYourMachine({ publicKey, resourceUrl }: { publicKey?: string; resourceUrl?: string }) {
  const [tab, setTab] = useState<"cli" | "curl">("cli");
  const [copiedSnippet, setCopiedSnippet] = useState(false);

  // Lazy initializers — a plain, idempotent localStorage read with no side
  // effects, safe to run during render (same reasoning React's own docs give
  // for lazy useState initializers; this never mutates storage, only reads
  // it). Falls back to localStorage only when the caller didn't pass a prop,
  // so a caller with live data always wins.
  const [fallbackPayment] = useState(() => (resourceUrl ? null : readLastPayment()));
  const [fallbackSession] = useState(() => (publicKey ? null : readSession()));

  const effectiveResourceUrl = resourceUrl ?? fallbackPayment?.sellerUrl;
  const effectivePublicKey = publicKey ?? fallbackSession?.publicKey;

  if (!effectiveResourceUrl) {
    return (
      <div style={{ marginTop: "var(--lp-sp-8)" }}>
        <Eyebrow>Run this on your machine</Eyebrow>
        <p className="lp-lead" style={{ marginTop: "var(--lp-sp-4)" }}>
          Make a payment first — once you&apos;ve paid a resource, its CLI and curl snippets will show up
          here.
        </p>
      </div>
    );
  }

  const cliSnippet = [
    "# Buyer (classic keypair) — from vellar-facilitator/examples/buyer-classic.mjs",
    `RESOURCE_URL=${effectiveResourceUrl} \\`,
    "PAYER_SECRET=<your own testnet secret key here> \\",
    "node buyer-classic.mjs",
    "",
    "# Note: PAYER_SECRET can't be pre-filled with this session's real key —",
    "# the playground's session key stays server-side by design and is never",
    `# sent to the browser.${effectivePublicKey ? ` Your session's public key is ${truncateMiddle(effectivePublicKey, 10, 6)}.` : ""}`,
  ].join("\n");

  const curlSnippet = [
    `curl -i ${effectiveResourceUrl}`,
    "",
    "# Expect: HTTP/1.1 402 Payment Required",
    "# with a PAYMENT-REQUIRED header (base64-encoded challenge).",
  ].join("\n");

  const snippet = tab === "cli" ? cliSnippet : curlSnippet;

  return (
    <div style={{ marginTop: "var(--lp-sp-8)" }}>
      <Eyebrow>Run this on your machine</Eyebrow>
      <div className="lp-chips" role="tablist" aria-label="Snippet language" style={{ marginTop: "var(--lp-sp-4)" }}>
        <b
          role="tab"
          aria-selected={tab === "cli"}
          tabIndex={0}
          className={tab === "cli" ? "on" : undefined}
          style={{ cursor: "pointer" }}
          onClick={() => setTab("cli")}
          onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && setTab("cli")}
        >
          CLI
        </b>
        <b
          role="tab"
          aria-selected={tab === "curl"}
          tabIndex={0}
          className={tab === "curl" ? "on" : undefined}
          style={{ cursor: "pointer" }}
          onClick={() => setTab("curl")}
          onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && setTab("curl")}
        >
          curl
        </b>
      </div>
      <div className="lp-trace-panel" style={{ marginTop: "var(--lp-sp-4)" }}>
        <div className="head">
          <span>{tab === "cli" ? "buyer-classic.mjs" : "curl"}</span>
          <button
            type="button"
            onClick={async () => {
              await copyToClipboard(snippet);
              setCopiedSnippet(true);
              setTimeout(() => setCopiedSnippet(false), 1500);
            }}
            style={{ background: "none", border: 0, padding: 0, font: "inherit", color: "inherit", cursor: "pointer", textDecoration: "underline" }}
          >
            {copiedSnippet ? "Copied!" : "Copy"}
          </button>
        </div>
        <pre style={{ whiteSpace: "pre-wrap", fontFamily: "var(--lp-mono)", fontSize: "0.8125rem", margin: 0, color: "var(--lp-on-dark)" }}>{snippet}</pre>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Station 2 — ownership verification
// ---------------------------------------------------------------------------
//
// Reuses the SAME .lp-step-row/.lp-step-mark 4-state pattern as Station 1's
// PayLedger (mint=done/sun=active pulse/coral=error — "skipped" is unused
// here, same as PayLedger) and the same .lp-fitem-derived collapsible
// raw-bytes disclosure. No new visual language is invented for this station
// — see the task's explicit instruction to reuse, not reinvent.
//
// GROUND TRUTH FRAMING (locked product decision, see task notes): the demo
// resource is ALREADY durably verified from real payments made earlier in
// this build. A visitor today will not see a live unverified->verified
// transition, because src/catalog.ts's `everVerified` latch never resets
// once tripped. This section is honest about that: it shows the ALREADY-
// established verdict (from the live catalog) plus a genuinely live
// re-confirmation (the "Verify now" stream), and never fabricates a fake
// first-discovery animation.

function ownershipStepStatusLabel(step: OwnershipStepState): string {
  if (step.status === "pending") return "Waiting";
  if (step.status === "active") return "In progress";
  if (step.status === "error") return step.message ?? "Failed";
  return "Done";
}

/** One raw-wire-bytes disclosure for a single ownership-check step. Same
 *  "render nothing until there's something real to show" rule as Station
 *  1's StepRawBytes. */
function OwnershipStepRawBytes({ step, stepName }: { step: OwnershipStepState; stepName: OwnershipStepName }) {
  const event = step.event;
  if (!event || step.status === "pending" || step.status === "active") return null;

  let rows: Array<{ label: string; value: string }> = [];
  let note: string | undefined;

  if (stepName === "fetch_challenge" && event.status === "done") {
    rows = [
      { label: "request", value: String(event.requestLine ?? "") },
      { label: "status", value: String(event.responseStatus ?? "") },
      {
        label: "PAYMENT-REQUIRED (raw, base64)",
        value: truncateMiddle(String(event.rawPaymentRequiredHeader ?? ""), 28, 10),
      },
    ];
    note = typeof event.hardeningSkippedNote === "string" ? event.hardeningSkippedNote : undefined;
  } else if (stepName === "decode_header" && event.status === "done") {
    rows = [{ label: "decoded challenge", value: truncateMiddle(JSON.stringify(event.decoded ?? {}), 40, 10) }];
  } else if (stepName === "parse_pay_to" && event.status === "done") {
    const payTos = Array.isArray(event.payTos) ? (event.payTos as string[]) : [];
    rows = payTos.map((p, i) => ({ label: `payTo[${i}]`, value: p }));
  } else if (stepName === "compare_catalog" && event.status === "done") {
    const boundPayTos = Array.isArray(event.boundPayTos) ? (event.boundPayTos as string[]) : [];
    rows = [
      { label: "resource", value: truncateMiddle(String(event.resource ?? ""), 24, 10) },
      ...boundPayTos.map((p, i) => ({ label: `bound payTo[${i}]`, value: p })),
      { label: "ownershipState", value: String(event.ownershipState ?? "—") },
      { label: "lastSettled", value: String(event.lastSettled ?? "—") },
    ];
  } else if (stepName === "verdict" && event.status === "done") {
    const challengePayTos = Array.isArray(event.challengePayTos) ? (event.challengePayTos as string[]) : [];
    const boundPayTos = Array.isArray(event.boundPayTos) ? (event.boundPayTos as string[]) : [];
    rows = [
      { label: "challenge payTo(s)", value: challengePayTos.join(", ") || "—" },
      { label: "bound payTo(s)", value: boundPayTos.join(", ") || "—" },
      { label: "match", value: String(event.match ?? "") },
    ];
  } else if (event.status === "error") {
    rows = [{ label: "error", value: step.message ?? "failed" }];
  }

  if (rows.length === 0 && !note) return null;

  return (
    <details className="lp-fitem lp-fitem--raw">
      <summary>
        <span>Raw wire bytes</span>
        <span className="pm" aria-hidden>
          +
        </span>
      </summary>
      <div className="body">
        <MonoRows>
          {rows.map((r, i) => (
            <MonoRow key={`${r.label}-${i}`} label={r.label} value={r.value} />
          ))}
        </MonoRows>
        {note && (
          <p className="lp-lead" style={{ fontSize: "0.8rem", marginTop: "var(--lp-sp-3)" }}>
            {note}
          </p>
        )}
      </div>
    </details>
  );
}

function OwnershipSection({
  catalog,
  ownership,
  elapsed,
  onVerify,
}: {
  catalog: CatalogStage;
  ownership: OwnershipStage;
  elapsed: number;
  onVerify: () => void;
}) {
  const demoItem = catalog.status === "ready" ? catalog.items.find((item) => item.resource === DEMO_RESOURCE_URL) : undefined;
  const trust = trustLabel(demoItem?.trust);
  const accept = demoItem?.accepts?.[0];
  const boundPayTo = accept?.payTo;
  const lastSettled = demoItem?.trust && "lastSettled" in demoItem.trust ? (demoItem.trust as { lastSettled?: string }).lastSettled : undefined;
  const settlements = demoItem?.trust && "settlements" in demoItem.trust ? (demoItem.trust as { settlements?: number }).settlements : undefined;

  const steps = ownership.status === "checking" || ownership.status === "success" || ownership.status === "error" ? ownership.steps : initialOwnershipSteps();
  const busy = ownership.status === "checking";

  return (
    <div id="station-2" style={{ marginTop: "var(--lp-sp-8)" }}>
      <Eyebrow>Station 2 — ownership verification</Eyebrow>
      <h2 style={{ marginTop: "var(--lp-sp-4)" }}>
        Once proven, <em>it can&apos;t be taken back.</em>
      </h2>
      <p className="lp-lead" style={{ marginTop: "var(--lp-sp-3)" }}>
        The facilitator&apos;s differentiator: a resource&apos;s ownership binding, once proven by a real settlement,
        is a permanent latch — not a badge that can flip back off. Once proven, a later settlement from a different
        address can&apos;t displace it.
      </p>

      <div className="lp-dgrid lp-dgrid--wide" style={{ marginTop: "var(--lp-sp-6)" }}>
        {/* ---- Catalog entry + historical binding ---- */}
        <div className="lp-dpanel lp-dpanel--sun">
          <div className="lp-dpanel-head">
            <h3>The catalog entry</h3>
          </div>
          {!demoItem && (
            <p className="lp-lead" style={{ fontSize: "0.9rem" }}>
              {catalog.status === "loading" ? "Loading the catalog..." : "The demo resource isn't in the catalog yet."}
            </p>
          )}
          {demoItem && (
            <div style={{ display: "flex", flexDirection: "column", gap: "var(--lp-sp-3)" }}>
              <div>
                <b>{demoItem.description || demoItem.resource}</b>
                <div className="lp-lead" style={{ fontSize: "0.85rem", marginTop: "var(--lp-sp-1, 4px)" }}>
                  {formatAtomicAmount(accept?.amount)} atomic of {truncateMiddle(accept?.asset || "—")}
                  {" · "}
                  {truncateMiddle(demoItem.resource, 24, 10)}
                </div>
              </div>
              <span
                className="lp-verified"
                style={!trust.verified ? { background: "var(--lp-paper-tint)" } : undefined}
              >
                {trust.verified ? "✓ " : ""}
                {trust.text}
              </span>

              <div style={{ marginTop: "var(--lp-sp-2)" }}>
                <p className="lp-lead" style={{ fontSize: "0.85rem" }}>
                  What the facilitator did, historically: it fetched the seller&apos;s own 402 challenge, compared the
                  payTo it names ({boundPayTo ? truncateMiddle(boundPayTo, 10, 6) : "—"}) against the address that
                  settled, and found a match — binding this resource&apos;s ownership permanently.
                </p>
                <MonoRows>
                  <MonoRow label="settlements" value={typeof settlements === "number" ? String(settlements) : "—"} />
                  <MonoRow label="last settled" value={lastSettled ?? "—"} />
                </MonoRows>
                <p className="lp-lead" style={{ fontSize: "0.75rem", marginTop: "var(--lp-sp-2)" }}>
                  &quot;Last settled&quot; is the closest publicly-available signal to &quot;when this was first
                  proven&quot; — the facilitator does track a separate first-proof tombstone internally, but it
                  isn&apos;t exposed on the public catalog endpoint, so this shows the real field that is.
                </p>
              </div>
            </div>
          )}
        </div>

        {/* ---- Verify now — live 5-step re-check ---- */}
        <div className="lp-dpanel lp-dpanel--dark">
          <div className="lp-dpanel-head">
            <h3>Verify now</h3>
          </div>
          <p className="lp-lead" style={{ fontSize: "0.85rem" }}>
            The playground is performing the same check the facilitator runs — fetching the seller&apos;s own 402
            challenge and comparing the payTo it names against the bound address.
          </p>
          <p className="lp-lead" style={{ fontSize: "0.75rem" }}>
            The real facilitator also pins DNS and blocks private/internal addresses before fetching an arbitrary
            seller URL; this demo check skips that hardening since it&apos;s only ever pointed at a known, fixed demo
            resource.
          </p>

          {ownership.status === "idle" && (
            <div className="lp-cta-row" style={{ marginTop: "var(--lp-sp-4)" }}>
              <LpActionButton variant="sun" onClick={onVerify}>
                Verify now →
              </LpActionButton>
            </div>
          )}

          {ownership.status !== "idle" && (
            <>
              <div className="lp-steps-card" style={{ marginTop: "var(--lp-sp-4)" }}>
                {OWNERSHIP_STEP_ORDER.map((stepName) => {
                  const step = steps[stepName];
                  return (
                    <div key={stepName}>
                      <div className="lp-step-row" data-state={step.status}>
                        <span className="lp-step-mark" aria-hidden />
                        <span className="lp-step-label">{OWNERSHIP_STEP_LABELS[stepName]}</span>
                        <span className="lp-step-note">{ownershipStepStatusLabel(step)}</span>
                      </div>
                      <OwnershipStepRawBytes step={step} stepName={stepName} />
                    </div>
                  );
                })}
              </div>

              {busy && (
                <p className="lp-lead" style={{ marginTop: "var(--lp-sp-4)", fontSize: "0.85rem" }}>
                  Checking... ({elapsed}s)
                </p>
              )}

              {ownership.status === "success" && (
                <div style={{ marginTop: "var(--lp-sp-4)" }}>
                  <p className="lp-lead" style={{ fontWeight: 700 }}>
                    {ownership.result.verdictText}
                  </p>
                  <div className="lp-cta-row">
                    <LpActionButton variant="ghost" size="sm" onClick={onVerify}>
                      Run again
                    </LpActionButton>
                  </div>
                </div>
              )}

              {ownership.status === "error" && (
                <div style={{ marginTop: "var(--lp-sp-4)" }}>
                  <p className="lp-lead">{ownership.message}</p>
                  <div className="lp-cta-row">
                    <LpActionButton variant="ghost" size="sm" onClick={onVerify}>
                      Try again
                    </LpActionButton>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Station 2's "Run this on your machine" footer
// ---------------------------------------------------------------------------
//
// SIBLING COMPONENT, not an extension of RunOnYourMachine — see the task
// report's reasoning: Station 1's RunOnYourMachine has a CLI-tab/curl-tab
// shape specific to REPLICATING A PAYMENT (a PAYER_SECRET placeholder, a
// buyer-classic.mjs invocation). Station 2 replicates something structurally
// different and simpler: a single, fully real, copy-pasteable curl one-liner
// with no secret/tab distinction at all (there is no session involvement in
// this station to begin with). Forcing that into RunOnYourMachine via a
// "which station" prop would mean threading dead CLI-tab logic through a
// component whose content shape doesn't apply — a sibling component that
// reuses the SAME .lp-trace-panel copy-button visual structure (not the
// internals) is the cleaner DRY cut here: shared look, independent content.
//
// The command replicates step 1 ("Fetching the seller's 402 challenge") and
// step 2 ("Reading the PAYMENT-REQUIRED header") manually: `curl -sD -` to
// capture response headers on stdout alongside the body, piped through a
// small shell one-liner that extracts the payment-required header and
// base64-decodes it — genuinely runnable, not a fabricated example.

function RunVerifyOnYourMachine() {
  const [copiedSnippet, setCopiedSnippet] = useState(false);

  const curlSnippet = [
    `curl -sD - ${DEMO_RESOURCE_URL} -o /dev/null \\`,
    `  | grep -i '^payment-required:' \\`,
    `  | cut -d' ' -f2 \\`,
    `  | tr -d '\\r' \\`,
    "  | base64 -d",
    "",
    "# Expect: HTTP 402, and a decoded JSON challenge whose accepts[0].payTo",
    "# is the address this station compares against the catalog's bound",
    "# address for the same resource.",
  ].join("\n");

  return (
    <div style={{ marginTop: "var(--lp-sp-8)" }}>
      <Eyebrow>Run this on your machine</Eyebrow>
      <p className="lp-lead" style={{ marginTop: "var(--lp-sp-4)", fontSize: "0.9rem" }}>
        Replicates steps 1 and 2 above manually: an unpaid GET against the seller, then decoding the
        PAYMENT-REQUIRED header by hand.
      </p>
      <div className="lp-trace-panel" style={{ marginTop: "var(--lp-sp-4)" }}>
        <div className="head">
          <span>curl</span>
          <button
            type="button"
            onClick={async () => {
              await copyToClipboard(curlSnippet);
              setCopiedSnippet(true);
              setTimeout(() => setCopiedSnippet(false), 1500);
            }}
            style={{ background: "none", border: 0, padding: 0, font: "inherit", color: "inherit", cursor: "pointer", textDecoration: "underline" }}
          >
            {copiedSnippet ? "Copied!" : "Copy"}
          </button>
        </div>
        <pre style={{ whiteSpace: "pre-wrap", fontFamily: "var(--lp-mono)", fontSize: "0.8125rem", margin: 0, color: "var(--lp-on-dark)" }}>{curlSnippet}</pre>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Station 3 — the attack bench
// ---------------------------------------------------------------------------
//
// Reuses the SAME .lp-step-row/.lp-step-mark pattern as Stations 1/2, but
// repurposed for pass/fail rather than progress: mint ("done") = refused for
// the right reason / passed; coral ("error") = unexpected result / failed;
// sun ("active") = in flight — exactly the mapping specified for this
// station. Also reuses .lp-trace-panel/MonoRow/MonoRows for raw response
// display and the .lp-fitem-derived <details> disclosure for raw wire bytes,
// same as every prior station.
//
// HONESTY IN THE UI COPY (non-negotiable, per the task): each attack's own
// description states plainly whether it is a live round-trip against the
// real hosted facilitator, or an honest illustration/replica — see each
// attack's `liveNote` below.

const ATTACK_LIVE_NOTES: Record<string, string> = {
  tamper_amount: "Live — a real, deliberately-corrupted payload submitted to the real hosted facilitator's /verify.",
  redirect_payto: "Live — a real, deliberately-corrupted payload submitted to the real hosted facilitator's /verify.",
  strip_signature: "Live — a real, deliberately-corrupted payload submitted to the real hosted facilitator's /verify.",
  wrong_network: "Live — the real armed payload's network claim submitted to the real hosted facilitator's /verify.",
  replay:
    "Live — a real settlement, then the exact same payload replayed against the real hosted facilitator's /settle (the one attack in this track that needs /settle, not /verify — see the report for why).",
  ssrf_linklocal:
    "Live data, illustrative framing — real /health and /discovery/resources reads from the real hosted facilitator, showing ALREADY-cataloged localhost entries that are structurally unverifiable for the same isBlockedAddress guard family a 169.254.169.254 metadata-IP attempt would hit. Not a live attempt to reach cloud metadata infrastructure — that would be the exact SSRF this control exists to prevent.",
  displace_verified:
    "Live data, illustrative framing — two real, time-separated /discovery/resources polls of the demo resource, showing its verified binding is unchanged. Not a live attacker attempt (not cleanly constructible against shared infrastructure without a second seller identity — see the report) — this demonstrates the same permanence property by observing it hold under real, ongoing legitimate use.",
};

const SANITIZE_LIVE_NOTE =
  "Not a live round-trip. This runs a faithful local port of the facilitator's real sanitizeDescription() (vellar-facilitator/src/catalog.ts) against whatever you type below — live, in this process, with no network call to the facilitator at all. Cataloging a new resource with a crafted description isn't triggerable from this playground without controlling an independent seller identity.";

function attackRowState(entry: AttackBenchEntry): "pending" | "active" | "done" | "error" {
  if (entry.status === "pending") return "pending";
  if (entry.status === "active") return "active";
  if (entry.status === "error") return "error";
  // status === "done": map passed/failed onto the mint/coral convention
  // specified for this station — "done" (mint) only when the attack was
  // genuinely refused for the right reason; a "done" stream event whose
  // result.passed is false is an UNEXPECTED result and reads as coral.
  return entry.result?.passed ? "done" : "error";
}

function attackRowNote(entry: AttackBenchEntry): string {
  if (entry.status === "pending") return "Waiting";
  if (entry.status === "active") return "In progress";
  if (entry.status === "error") return entry.message ?? "Failed to run";
  if (!entry.result) return "Done";
  if (entry.result.checkMethod === "http_status") {
    return entry.result.passed
      ? `Refused as expected — HTTP ${entry.result.httpStatus}`
      : `Unexpected — HTTP ${entry.result.httpStatus}`;
  }
  if (entry.result.checkMethod === "poll_diff") {
    return entry.result.passed ? "Confirmed" : "Unexpected result";
  }
  return entry.result.passed
    ? `Refused as expected — ${entry.result.reasonCode ?? "no reason code"}`
    : `Unexpected — ${entry.result.reasonCode ?? "no reason code"}`;
}

/** Raw-wire-bytes disclosure for one attack's result — same "render nothing
 *  until there's something real to show" rule as every prior station's raw
 *  bytes panel. */
function AttackRawBytes({ entry }: { entry: AttackBenchEntry }) {
  if (entry.status !== "done" && entry.status !== "error") return null;
  if (entry.status === "error") {
    return (
      <details className="lp-fitem lp-fitem--raw">
        <summary>
          <span>Raw wire bytes</span>
          <span className="pm" aria-hidden>
            +
          </span>
        </summary>
        <div className="body">
          <MonoRows>
            <MonoRow label="error" value={entry.message ?? "failed"} />
          </MonoRows>
        </div>
      </details>
    );
  }
  const result = entry.result;
  if (!result) return null;
  const rows: Array<{ label: string; value: string }> = [
    { label: "endpoint", value: result.endpoint },
    { label: "checkMethod", value: result.checkMethod },
  ];
  if (result.httpStatus !== undefined) rows.push({ label: "httpStatus", value: String(result.httpStatus) });
  if (result.reasonCode) rows.push({ label: "reasonCode", value: result.reasonCode });
  if (result.expectedCodes.length > 0) rows.push({ label: "expectedCodes", value: result.expectedCodes.join(", ") });
  rows.push({ label: "rawResponse", value: truncateMiddle(JSON.stringify(result.rawResponse ?? {}), 60, 20) });

  return (
    <details className="lp-fitem lp-fitem--raw">
      <summary>
        <span>Raw wire bytes</span>
        <span className="pm" aria-hidden>
          +
        </span>
      </summary>
      <div className="body">
        <MonoRows>
          {rows.map((r, i) => (
            <MonoRow key={`${r.label}-${i}`} label={r.label} value={r.value} />
          ))}
        </MonoRows>
      </div>
    </details>
  );
}

/** "Run this on your machine" footer for one attack — reuses
 *  RunOnYourMachine's established tone: honest that the payment-track
 *  snippets are illustrative/templated (they need a signed payload the
 *  developer would have to construct themselves), same PAYER_SECRET
 *  placeholder convention. */
function AttackRunOnYourMachine({ attackId, snippet }: { attackId: string; snippet: string }) {
  const [copiedSnippet, setCopiedSnippet] = useState(false);
  return (
    <div className="lp-trace-panel" style={{ marginTop: "var(--lp-sp-3)" }}>
      <div className="head">
        <span>{attackId} — curl</span>
        <button
          type="button"
          onClick={async () => {
            await copyToClipboard(snippet);
            setCopiedSnippet(true);
            setTimeout(() => setCopiedSnippet(false), 1500);
          }}
          style={{ background: "none", border: 0, padding: 0, font: "inherit", color: "inherit", cursor: "pointer", textDecoration: "underline" }}
        >
          {copiedSnippet ? "Copied!" : "Copy"}
        </button>
      </div>
      <pre style={{ whiteSpace: "pre-wrap", fontFamily: "var(--lp-mono)", fontSize: "0.75rem", margin: 0, color: "var(--lp-on-dark)" }}>{snippet}</pre>
    </div>
  );
}

function paymentAttackSnippet(attackId: PaymentAttackId): string {
  const common = [
    "# Illustrative — requires a real signed x402 Stellar payment payload you",
    "# construct yourself (this playground's session key stays server-side and",
    "# is never sent to the browser — same discipline as Station 1's snippet).",
    "PAYER_SECRET=<your own testnet secret key here> \\",
  ];
  const byAttack: Record<PaymentAttackId, string[]> = {
    tamper_amount: [
      "# 1. Build a real payment payload with buyer-classic.mjs, decode the XDR,",
      "#    change the transfer() call's `amount` arg, re-serialize (do not re-sign).",
      "# 2. Submit the corrupted payload:",
      `curl -X POST ${FACILITATOR_URL}/verify \\`,
      '  -H "content-type: application/json" \\',
      "  -d '{\"paymentPayload\": <corrupted>, \"paymentRequirements\": <original>}'",
      "",
      "# Expect: {\"isValid\":false,\"invalidReason\":\"invalid_exact_stellar_payload_wrong_amount\"}",
    ],
    redirect_payto: [
      "# Same mechanism as tamper_amount, but change the `to` arg instead.",
      `curl -X POST ${FACILITATOR_URL}/verify \\`,
      '  -H "content-type: application/json" \\',
      "  -d '{\"paymentPayload\": <corrupted>, \"paymentRequirements\": <original>}'",
      "",
      "# Expect: {\"isValid\":false,\"invalidReason\":\"invalid_exact_stellar_payload_wrong_recipient\"}",
    ],
    strip_signature: [
      "# Same mechanism, but set the invokeHostFunction operation's `auth` to [].",
      `curl -X POST ${FACILITATOR_URL}/verify \\`,
      '  -H "content-type: application/json" \\',
      "  -d '{\"paymentPayload\": <corrupted>, \"paymentRequirements\": <original>}'",
      "",
      "# Expect: {\"isValid\":false,\"invalidReason\":\"invalid_exact_stellar_payload_no_auth_entries\"}",
    ],
    wrong_network: [
      "# Change paymentRequirements.network to an unregistered CAIP-2 id.",
      `curl -i -X POST ${FACILITATOR_URL}/verify \\`,
      '  -H "content-type: application/json" \\',
      '  -d \'{"paymentPayload": <armed, unmodified>, "paymentRequirements": {..., "network": "eip155:1"}}\'',
      "",
      '# Expect: HTTP 500, {"statusCode":500,"error":"Internal Server Error",',
      '#   "message":"No facilitator registered for scheme: exact and network: eip155:1"}',
    ],
    replay: [
      "# Submit the SAME already-armed payload to /settle TWICE.",
      `curl -X POST ${FACILITATOR_URL}/settle \\`,
      '  -H "content-type: application/json" \\',
      "  -d '{\"paymentPayload\": <armed>, \"paymentRequirements\": <original>}'",
      "# (run the exact same command again)",
      "",
      "# Expect: first call succeeds (success:true, a real settlementTx); the",
      "# second fails, commonly with errorReason",
      '# "invalid_exact_stellar_payload_simulation_failed" (observed live) — the',
      "# on-chain nonce the first call consumed is what refuses the second.",
    ],
  };
  return [...common, ...byAttack[attackId]].join("\n");
}

function catalogAttackSnippet(attackId: CatalogAttackId): string {
  if (attackId === "ssrf_linklocal") {
    return [
      `curl ${FACILITATOR_URL}/health`,
      `curl ${FACILITATOR_URL}/discovery/resources`,
      "",
      "# Look for unverifiableEntries on /health, and for resources like",
      '# "http://localhost:<port>/quote" in /discovery/resources whose',
      '# trust.ownershipState stays "unverified" permanently — the same',
      "# isBlockedAddress guard family that blocks 169.254.169.254 also blocks",
      "# these (non-https and/or the literal `localhost` hostname).",
    ].join("\n");
  }
  return [
    `curl ${FACILITATOR_URL}/discovery/resources | jq '.items[] | select(.resource == "${SELLER_URL}/quote")'`,
    "# (wait a few seconds, run again)",
    `curl ${FACILITATOR_URL}/discovery/resources | jq '.items[] | select(.resource == "${SELLER_URL}/quote")'`,
    "",
    "# Expect: accepts[].payTo and trust.ownershipState identical across both",
    "# calls — the verified binding does not move, even under real ongoing use.",
  ].join("\n");
}

function AttackBenchSection({
  paymentAttacks,
  catalogAttacks,
  sanitizeDemo,
  paymentElapsed,
  catalogElapsed,
  onRunPaymentAttacks,
  onRunCatalogAttacks,
  onRunSanitizeDemo,
}: {
  paymentAttacks: PaymentAttackStage;
  catalogAttacks: CatalogAttackStage;
  sanitizeDemo: SanitizeDemoState;
  paymentElapsed: number;
  catalogElapsed: number;
  onRunPaymentAttacks: () => void;
  onRunCatalogAttacks: () => void;
  onRunSanitizeDemo: (input: string) => void;
}) {
  const [sanitizeInput, setSanitizeInput] = useState("");

  const paymentMap =
    paymentAttacks.status === "running" || paymentAttacks.status === "done" || paymentAttacks.status === "error"
      ? paymentAttacks.attacks
      : initialPaymentAttackMap();
  const catalogMap =
    catalogAttacks.status === "running" || catalogAttacks.status === "done" || catalogAttacks.status === "error"
      ? catalogAttacks.attacks
      : initialCatalogAttackMap();

  return (
    <div id="station-3" style={{ marginTop: "var(--lp-sp-8)" }}>
      <Eyebrow>Station 3 — the attack bench</Eyebrow>
      <h2 style={{ marginTop: "var(--lp-sp-4)" }}>
        Break it. <em>Watch it refuse to break.</em>
      </h2>
      <p className="lp-lead" style={{ marginTop: "var(--lp-sp-3)" }}>
        Eight deliberate attacks against the real hosted facilitator — five corrupt a real signed payment, three
        target the public catalog. Mint means the facilitator refused for the right reason (a pass for the
        defense); coral means something unexpected happened. Every attack&apos;s panel says plainly whether it is a
        live round-trip or an honest illustration — see each one below.
      </p>

      {/* ---- Payment-attack track ---- */}
      <div className="lp-dpanel lp-dpanel--dark" style={{ marginTop: "var(--lp-sp-6)" }}>
        <div className="lp-dpanel-head">
          <h3>Payment attacks</h3>
        </div>
        <p className="lp-lead" style={{ fontSize: "0.85rem" }}>
          Arms one real, validly-signed payment using your session wallet, then takes a fresh copy per attack and
          corrupts it — tampered amount, redirected recipient, stripped signature, an unregistered network claim,
          and a replayed settlement. Four hit <code>/verify</code>; replay hits <code>/settle</code> (the only way
          to observe nonce consumption — see the panel below).
        </p>

        {paymentAttacks.status === "idle" && (
          <div className="lp-cta-row" style={{ marginTop: "var(--lp-sp-4)" }}>
            <LpActionButton variant="sun" onClick={onRunPaymentAttacks}>
              Arm the bench and attack →
            </LpActionButton>
          </div>
        )}

        {paymentAttacks.status !== "idle" && (
          <>
            <div className="lp-steps-card" style={{ marginTop: "var(--lp-sp-4)" }}>
              {PAYMENT_ATTACK_IDS.map((attackId) => {
                const entry = paymentMap[attackId];
                return (
                  <div key={attackId}>
                    <div className="lp-step-row" data-state={attackRowState(entry)}>
                      <span className="lp-step-mark" aria-hidden />
                      <span className="lp-step-label">{PAYMENT_ATTACK_LABELS[attackId]}</span>
                      <span className="lp-step-note">{attackRowNote(entry)}</span>
                    </div>
                    <p className="lp-lead" style={{ fontSize: "0.7rem", marginTop: "2px", marginBottom: "4px" }}>
                      {ATTACK_LIVE_NOTES[attackId]}
                    </p>
                    <AttackRawBytes entry={entry} />
                    <AttackRunOnYourMachine attackId={attackId} snippet={paymentAttackSnippet(attackId)} />
                  </div>
                );
              })}
            </div>

            {paymentAttacks.status === "running" && (
              <p className="lp-lead" style={{ marginTop: "var(--lp-sp-4)", fontSize: "0.85rem" }}>
                Arming and attacking... ({paymentElapsed}s)
              </p>
            )}
            {paymentAttacks.status === "error" && (
              <div style={{ marginTop: "var(--lp-sp-4)" }}>
                <p className="lp-lead">{paymentAttacks.message}</p>
                <div className="lp-cta-row">
                  <LpActionButton variant="ghost" size="sm" onClick={onRunPaymentAttacks}>
                    Try again
                  </LpActionButton>
                </div>
              </div>
            )}
            {paymentAttacks.status === "done" && (
              <div className="lp-cta-row" style={{ marginTop: "var(--lp-sp-4)" }}>
                <LpActionButton variant="ghost" size="sm" onClick={onRunPaymentAttacks}>
                  Run again
                </LpActionButton>
              </div>
            )}
          </>
        )}
      </div>

      {/* ---- Catalog-attack track ---- */}
      <div className="lp-dpanel lp-dpanel--coral" style={{ marginTop: "var(--lp-sp-6)" }}>
        <div className="lp-dpanel-head">
          <h3>Catalog attacks</h3>
        </div>
        <p className="lp-lead" style={{ fontSize: "0.85rem" }}>
          No session needed — both poll the facilitator&apos;s public <code>/health</code> and{" "}
          <code>/discovery/resources</code>.
        </p>

        {catalogAttacks.status === "idle" && (
          <div className="lp-cta-row" style={{ marginTop: "var(--lp-sp-4)" }}>
            <LpActionButton variant="sun" onClick={onRunCatalogAttacks}>
              Run the catalog checks →
            </LpActionButton>
          </div>
        )}

        {catalogAttacks.status !== "idle" && (
          <>
            <div className="lp-steps-card" style={{ marginTop: "var(--lp-sp-4)" }}>
              {CATALOG_ATTACK_IDS.map((attackId) => {
                const entry = catalogMap[attackId];
                return (
                  <div key={attackId}>
                    <div className="lp-step-row" data-state={attackRowState(entry)}>
                      <span className="lp-step-mark" aria-hidden />
                      <span className="lp-step-label">{CATALOG_ATTACK_LABELS[attackId]}</span>
                      <span className="lp-step-note">{attackRowNote(entry)}</span>
                    </div>
                    <p className="lp-lead" style={{ fontSize: "0.7rem", marginTop: "2px", marginBottom: "4px" }}>
                      {ATTACK_LIVE_NOTES[attackId]}
                    </p>
                    <AttackRawBytes entry={entry} />
                    <AttackRunOnYourMachine attackId={attackId} snippet={catalogAttackSnippet(attackId)} />
                  </div>
                );
              })}
            </div>

            {catalogAttacks.status === "running" && (
              <p className="lp-lead" style={{ marginTop: "var(--lp-sp-4)", fontSize: "0.85rem" }}>
                Polling... ({catalogElapsed}s)
              </p>
            )}
            {catalogAttacks.status === "error" && (
              <div style={{ marginTop: "var(--lp-sp-4)" }}>
                <p className="lp-lead">{catalogAttacks.message}</p>
                <div className="lp-cta-row">
                  <LpActionButton variant="ghost" size="sm" onClick={onRunCatalogAttacks}>
                    Try again
                  </LpActionButton>
                </div>
              </div>
            )}
            {catalogAttacks.status === "done" && (
              <div className="lp-cta-row" style={{ marginTop: "var(--lp-sp-4)" }}>
                <LpActionButton variant="ghost" size="sm" onClick={onRunCatalogAttacks}>
                  Run again
                </LpActionButton>
              </div>
            )}
          </>
        )}
      </div>

      {/* ---- Sanitizer demo (attack 8) ---- */}
      <div className="lp-dpanel lp-dpanel--dark" style={{ marginTop: "var(--lp-sp-6)" }}>
        <div className="lp-dpanel-head">
          <h3>Prompt injection via a crafted description</h3>
        </div>
        <p className="lp-lead" style={{ fontSize: "0.85rem", fontWeight: 700 }}>
          {SANITIZE_LIVE_NOTE}
        </p>
        <label htmlFor="sanitize-input" className="lp-lead" style={{ fontSize: "0.8rem", display: "block", marginTop: "var(--lp-sp-4)" }}>
          Type an injection attempt (try control characters, an RTL override, or a very long string):
        </label>
        <textarea
          id="sanitize-input"
          value={sanitizeInput}
          onChange={(e) => setSanitizeInput(e.target.value)}
          rows={3}
          style={{
            width: "100%",
            marginTop: "var(--lp-sp-2)",
            fontFamily: "var(--lp-mono)",
            fontSize: "0.8125rem",
            padding: "var(--lp-sp-3)",
            background: "var(--lp-paper-tint)",
            border: "1px solid var(--lp-line)",
            color: "inherit",
          }}
        />
        <div className="lp-cta-row" style={{ marginTop: "var(--lp-sp-3)" }}>
          <LpActionButton
            variant="sun"
            size="sm"
            onClick={() => onRunSanitizeDemo(sanitizeInput)}
            disabled={sanitizeDemo.status === "loading"}
          >
            Sanitize it →
          </LpActionButton>
        </div>

        {sanitizeDemo.status === "error" && (
          <p className="lp-lead" style={{ marginTop: "var(--lp-sp-4)" }}>
            {sanitizeDemo.message}
          </p>
        )}

        {sanitizeDemo.status === "done" && sanitizeDemo.result && (
          <div style={{ marginTop: "var(--lp-sp-4)" }}>
            <div className="lp-step-row" data-state={sanitizeDemo.result.passed ? "done" : "skipped"}>
              <span className="lp-step-mark" aria-hidden />
              <span className="lp-step-label">
                {sanitizeDemo.result.passed ? "The sanitizer changed the input" : "Nothing to strip — input was already clean"}
              </span>
            </div>
            <MonoRows>
              <MonoRow label="input length" value={String((sanitizeDemo.result.rawResponse as { inputLength?: number })?.inputLength ?? "—")} />
              <MonoRow
                label="sanitized length"
                value={String((sanitizeDemo.result.rawResponse as { sanitizedLength?: number })?.sanitizedLength ?? "—")}
              />
              <MonoRow
                label="stripped chars"
                value={String((sanitizeDemo.result.rawResponse as { strippedCharCount?: number })?.strippedCharCount ?? "—")}
              />
              <MonoRow
                label="truncated to 256"
                value={String((sanitizeDemo.result.rawResponse as { truncated?: boolean })?.truncated ?? "—")}
              />
              <MonoRow
                label="sanitized output"
                value={truncateMiddle(String((sanitizeDemo.result.rawResponse as { sanitized?: string })?.sanitized ?? ""), 40, 10)}
              />
            </MonoRows>
          </div>
        )}
      </div>
    </div>
  );
}
