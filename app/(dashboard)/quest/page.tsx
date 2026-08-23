"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Eyebrow, LpActionButton, MonoRow, MonoRows } from "../../design/ui";
import { truncateMiddle } from "@/lib/format";
import { FACILITATOR_URL } from "@/lib/config";
import { isCorrectLevel5Answer, ownershipStateFromProof } from "@/lib/quest";
import {
  readAttackResults,
  readLastPayment,
  readQuestProgress,
  writeQuestLevel,
  type StoredAttackResults,
  type StoredQuestProgress,
} from "@/lib/local-storage";

// ---------------------------------------------------------------------------
// /quest — the 5-level challenge track. Read-only tour of what Stations 1-3
// (on `/`) already produced, plus two self-contained checks (L4's live
// catalog fetch, L5's comprehension question) that live entirely on this
// page.
//
// ARCHITECTURE NOTE — why this page does NOT read vellar.questProgress into
// a single source of truth for every level's pass/fail:
//   - L1/L2 completion (verified: true) is written by Stations 1/2 on `/` at
//     the moment their own mechanism produces real evidence (see
//     app/(dashboard)/page.tsx's writeQuestLevel(1, ...) inside
//     persistPaymentCompletion, and writeQuestLevel(2, ...) inside
//     runVerifyOwnership's `finish`). This page reads that stored proof, but
//     ALSO re-verifies it live (L1 against Horizon, L2 against the live
//     facilitator catalog) — "verified" here means "checked against real
//     chain/facilitator state just now", not merely "local storage has an
//     entry marked verified: true from whenever Station 1/2 last ran". A
//     stored level can therefore show as "proof exists, checking..." rather
///    than instantly "verified" on load.
//   - L3 is computed PURELY by reading vellar.attackResults at render
//     time — no vellar.questProgress[3] write happens anywhere (not added to
//     AttackBenchSection on `/`). See LEVEL 3 DESIGN DECISION below for the
//     full reasoning.
//   - L4 has no earlier "proof" to read at all — its own live catalog fetch
//     IS its completion check, and its result is written to
//     vellar.questProgress[4] once it passes (see Level4Card below).
//   - L5 has no external proof — a correct answer submitted on this page
//     writes vellar.questProgress[5] directly (verified: true means
//     "answered correctly", per this level's own doc-commented meaning in
//     lib/local-storage.ts's StoredQuestLevel).
//
// LEVEL 3 DESIGN DECISION (documented per the task's explicit ask): chose
// (b) — pure read of vellar.attackResults at render time, NO
// vellar.questProgress[3] write anywhere, and NO change to
// AttackBenchSection on `/`. Reasoning: vellar.attackResults already fully
// determines L3's pass/fail (>=1 stored result with passed===true and a
// valid checkMethod) — a separate write would be redundant derived state
// that could drift from its own source (e.g. if attack results were ever
// cleared independently of questProgress). This keeps "Stations 1/2/3's core
// mechanics" completely untouched, satisfying the task's "what must NOT
// change" constraint with the smallest, most defensible diff, at the cost of
// L3 being structurally different from L1/L2/L4/L5 (no questProgress[3]
// entry ever exists, even after L3 is complete — this page's own progress
// counter accounts for that, see computeVerifiedCount below).
// ---------------------------------------------------------------------------

const VALID_CHECK_METHODS = new Set(["reason_code", "http_status", "poll_diff", "content_inspection"]);
const DEMO_RESOURCE_URL = "https://vellar-seller-demo.onrender.com/quote";

interface CatalogTrust {
  ownershipState?: string;
  ownerVerified?: boolean;
}
interface CatalogItem {
  resource: string;
  trust?: CatalogTrust;
}

// ---------------------------------------------------------------------------
// Level 1 — live Horizon check
// ---------------------------------------------------------------------------
//
// VERIFICATION-TIMING DECISION (documented per the task's explicit ask):
// background-refresh, not a blocking full-page wait. On mount, if a proof
// hash exists, this immediately renders it in a "checking..." state (not
// blank, not fake-verified) while a live GET against Horizon runs in the
// background; the UI updates in place once that resolves. This avoids
// blocking the whole page behind a Horizon round-trip (Horizon can be slow,
// and a visitor should be able to see and interact with every other level
// immediately) while still being honest that the checkmark reflects a check
// that just happened, not a cached-forever assumption. A "Re-check now"
// button lets the visitor re-run it on demand at any time.
//
// CLIENT-SIDE, NOT A SERVER ROUTE — confirmed live during this build: `curl
// -D - https://horizon-testnet.stellar.org/transactions/<hash> -H "Origin:
// http://localhost:3000"` returns `Access-Control-Allow-Origin:
// http://localhost:3000` (permissive, request-origin-echoing CORS on
// Horizon's public testnet reads) — so a direct browser fetch works with no
// server proxy needed. This mirrors GET /api/catalog's own documented
// finding for the facilitator's CORS (a proxy there exists for cold-start
// handling, not because CORS blocked it) — Horizon has no comparable
// cold-start concern, so no proxy is added here at all.

type HorizonCheck = { status: "idle" } | { status: "checking" } | { status: "done"; ok: boolean; checkedAt: number } | { status: "error"; message: string };

async function checkHorizonTx(hash: string): Promise<{ ok: boolean }> {
  const res = await fetch(`https://horizon-testnet.stellar.org/transactions/${hash}`);
  if (!res.ok) return { ok: false };
  const body = await res.json();
  return { ok: body?.successful === true };
}

// ---------------------------------------------------------------------------
// Level 4 — live catalog check
// ---------------------------------------------------------------------------

async function fetchDemoResourceTrust(): Promise<CatalogTrust | null> {
  const res = await fetch(`${FACILITATOR_URL}/discovery/resources`);
  if (!res.ok) return null;
  const body = await res.json();
  const items: CatalogItem[] = Array.isArray(body?.items) ? body.items : [];
  const demo = items.find((item) => item.resource === DEMO_RESOURCE_URL);
  return demo?.trust ?? null;
}

// ---------------------------------------------------------------------------
// Progress bar
// ---------------------------------------------------------------------------

function computeVerifiedCount(progress: StoredQuestProgress, level3Passed: boolean): number {
  let count = 0;
  for (let level = 1; level <= 5; level++) {
    if (level === 3) {
      if (level3Passed) count++;
      continue;
    }
    if (progress[level]?.verified) count++;
  }
  return count;
}

function QuestProgressBar({ verifiedCount }: { verifiedCount: number }) {
  return (
    <div style={{ marginTop: "var(--lp-sp-6)" }}>
      <div className="lp-quest-bar" role="progressbar" aria-valuenow={verifiedCount} aria-valuemin={0} aria-valuemax={5}>
        {[1, 2, 3, 4, 5].map((n) => (
          <i key={n} data-filled={n <= verifiedCount} />
        ))}
      </div>
      <div className="lp-quest-count">
        <span>{verifiedCount} / 5 levels verified</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared level-card scaffolding
// ---------------------------------------------------------------------------

function LevelBadge({ done }: { done: boolean }) {
  return (
    <div className="lp-step-row" data-state={done ? "done" : "pending"} style={{ borderBottom: 0, padding: 0 }}>
      <span className="lp-step-mark" aria-hidden />
    </div>
  );
}

function LevelCard({
  number,
  title,
  goal,
  proofExplanation,
  done,
  children,
}: {
  number: number;
  title: string;
  goal: string;
  proofExplanation: string;
  done: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="lp-dpanel lp-dpanel--lime">
      <div className="lp-dpanel-head" style={{ alignItems: "center" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "var(--lp-sp-3)" }}>
          <LevelBadge done={done} />
          <h2 style={{ fontSize: "var(--lp-fs-h4)" }}>
            Level {number} — {title}
          </h2>
        </div>
      </div>
      <p className="lp-lead" style={{ fontSize: "0.9rem" }}>
        {goal}
      </p>
      <p className="lp-lead" style={{ fontSize: "0.8rem", fontStyle: "italic" }}>
        Proof: {proofExplanation}
      </p>
      <div style={{ marginTop: "var(--lp-sp-2)" }}>{children}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Level 1 card
// ---------------------------------------------------------------------------

function Level1Card({
  proof,
  horizon,
  onCheck,
}: {
  proof: string | null;
  horizon: HorizonCheck;
  onCheck: (hash: string) => void;
}) {
  const done = horizon.status === "done" && horizon.ok;

  if (!proof) {
    return (
      <LevelCard
        number={1}
        title="Settle your first payment"
        goal="Pay the demo resource once, end to end, from a real funded testnet wallet."
        proofExplanation="the 64-character settlement transaction hash Station 1 produces."
        done={false}
      >
        <div className="lp-cta-row" style={{ marginTop: 0 }}>
          <Link href="/" className="lp-btn lp-btn--sun">
            Send me to Station 1 →
          </Link>
        </div>
      </LevelCard>
    );
  }

  return (
    <LevelCard
      number={1}
      title="Settle your first payment"
      goal="Pay the demo resource once, end to end, from a real funded testnet wallet."
      proofExplanation="the 64-character settlement transaction hash Station 1 produces."
      done={done}
    >
      <MonoRows>
        <MonoRow label="settlement tx" value={truncateMiddle(proof, 14, 8)} />
        <MonoRow
          label="Horizon check"
          value={
            horizon.status === "checking"
              ? "Checking…"
              : horizon.status === "done"
                ? horizon.ok
                  ? "successful: true"
                  : "not confirmed"
                : horizon.status === "error"
                  ? horizon.message
                  : "Not yet checked"
          }
          tone={horizon.status === "done" ? (horizon.ok ? "ok" : "bad") : undefined}
        />
        {horizon.status === "done" && (
          <MonoRow label="last verified" value={new Date(horizon.checkedAt).toLocaleTimeString()} />
        )}
      </MonoRows>
      <div className="lp-cta-row" style={{ flexWrap: "wrap" }}>
        <LpActionButton variant="outline" size="sm" onClick={() => onCheck(proof)} disabled={horizon.status === "checking"}>
          {horizon.status === "checking" ? "Checking…" : "Re-check on Horizon →"}
        </LpActionButton>
        <a
          className="lp-btn lp-btn--ghost"
          href={`https://horizon-testnet.stellar.org/transactions/${proof}`}
          target="_blank"
          rel="noreferrer"
        >
          View raw response →
        </a>
      </div>
    </LevelCard>
  );
}

// ---------------------------------------------------------------------------
// Level 2 card
// ---------------------------------------------------------------------------

type L2Check = { status: "idle" } | { status: "checking" } | { status: "done"; state: string | null; plausible: boolean } | { status: "error"; message: string };

function Level2Card({ proof, walletReady, l2check, onCheck }: { proof: string | null; walletReady: boolean; l2check: L2Check; onCheck: () => void }) {
  if (!proof) {
    return (
      <LevelCard
        number={2}
        title="Read what you signed"
        goal="Run Station 2's live re-verification: fetch the seller's own 402 challenge and confirm it names the bound owner address."
        proofExplanation="the verdict text Station 2's own verification step produces (it's read-only, so there's no XDR to sign here)."
        done={false}
      >
        <p className="lp-lead" style={{ fontSize: "0.85rem" }}>
          {walletReady
            ? "Your wallet is ready — Station 2 needs no payment first, just a wallet."
            : "Get a wallet first (Station 1's \"Get started\"), then run \"Verify now\" — Station 2 needs no payment, just a wallet."}
        </p>
        <div className="lp-cta-row" style={{ marginTop: 0 }}>
          <Link href="/" className="lp-btn lp-btn--sun">
            Send me to Station 2 →
          </Link>
        </div>
      </LevelCard>
    );
  }

  const traceableState = ownershipStateFromProof(proof);
  const done = l2check.status === "done" && l2check.plausible && traceableState !== null;

  return (
    <LevelCard
      number={2}
      title="Read what you signed"
      goal="Run Station 2's live re-verification: fetch the seller's own 402 challenge and confirm it names the bound owner address."
      proofExplanation="the verdict text Station 2's own verification step produces (it's read-only, so there's no XDR to sign here)."
      done={done}
    >
      <MonoRows>
        <MonoRow label="stored verdict" value={truncateMiddle(proof, 40, 0)} />
        <MonoRow label="traces to ownershipState" value={traceableState ?? "not recognized"} tone={traceableState ? "ok" : "bad"} />
        <MonoRow
          label="live catalog re-check"
          value={
            l2check.status === "checking"
              ? "Checking…"
              : l2check.status === "done"
                ? `ownershipState: ${l2check.state ?? "—"}`
                : l2check.status === "error"
                  ? l2check.message
                  : "Not yet checked"
          }
          tone={l2check.status === "done" ? (l2check.plausible ? "ok" : "bad") : undefined}
        />
      </MonoRows>
      <div className="lp-cta-row">
        <LpActionButton variant="outline" size="sm" onClick={onCheck} disabled={l2check.status === "checking"}>
          {l2check.status === "checking" ? "Checking…" : "Re-check live catalog →"}
        </LpActionButton>
      </div>
    </LevelCard>
  );
}

// ---------------------------------------------------------------------------
// Level 3 card — pure read of vellar.attackResults, no write anywhere.
// ---------------------------------------------------------------------------

// `results` comes from the parent (QuestPage already reads vellar.attackResults
// correctly, in a mount effect — see the hydration note there) rather than this
// component doing its own separate localStorage read, which would reintroduce
// the exact same server/client mismatch a second time.
function Level3Card({ results }: { results: StoredAttackResults }) {
  const passingEntry = Object.values(results).find((r) => r.passed && VALID_CHECK_METHODS.has(r.checkMethod));
  const done = Boolean(passingEntry);

  return (
    <LevelCard
      number={3}
      title="Break the catalog"
      goal="Run Station 3's attack bench and get at least one attack to be refused for the right reason."
      proofExplanation="the reason code (or HTTP status) from any attack result stored locally with passed === true."
      done={done}
    >
      {done && passingEntry ? (
        <MonoRows>
          <MonoRow label="attackId" value={passingEntry.attackId} />
          <MonoRow label="checkMethod" value={passingEntry.checkMethod} tone="ok" />
          <MonoRow label="proof" value={passingEntry.reasonCode ?? (passingEntry.httpStatus !== undefined ? `HTTP ${passingEntry.httpStatus}` : "—")} />
        </MonoRows>
      ) : (
        <p className="lp-lead" style={{ fontSize: "0.85rem" }}>
          No passing attack result stored yet in this browser.
        </p>
      )}
      <p className="lp-lead" style={{ fontSize: "0.75rem" }}>
        This level is checked entirely from your browser&apos;s own attack-bench history — no live re-check needed,
        since a past attack result is itself the evidence.
      </p>
      <div className="lp-cta-row" style={{ marginTop: 0 }}>
        <Link href="/" className="lp-btn lp-btn--sun">
          Send me to Station 3 →
        </Link>
      </div>
    </LevelCard>
  );
}

// ---------------------------------------------------------------------------
// Level 4 card — the check IS the live fetch.
// ---------------------------------------------------------------------------

type L4Check =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "done"; state: string | null; pass: boolean }
  | { status: "error"; message: string };

function Level4Card({ stored, l4check, onCheck }: { stored: boolean; l4check: L4Check; onCheck: () => void }) {
  const done = stored || (l4check.status === "done" && l4check.pass);

  return (
    <LevelCard
      number={4}
      title="Get discovered"
      goal={'Confirm the demo resource appears in the facilitator\'s live public catalog with an ownership state beyond "unverified".'}
      proofExplanation="a live GET against the facilitator's /discovery/resources — not a cached result."
      done={done}
    >
      <MonoRows>
        <MonoRow
          label="live GET /discovery/resources"
          value={
            l4check.status === "checking"
              ? "Checking…"
              : l4check.status === "done"
                ? `ownershipState: ${l4check.state ?? "—"}`
                : l4check.status === "error"
                  ? l4check.message
                  : stored
                    ? "Previously confirmed"
                    : "Not yet checked"
          }
          tone={l4check.status === "done" ? (l4check.pass ? "ok" : "bad") : stored ? "ok" : undefined}
        />
      </MonoRows>
      <p className="lp-lead" style={{ fontSize: "0.75rem" }}>
        The demo resource is shared infrastructure everyone hits — there&apos;s no separate station to go complete
        first; clicking below performs the live fetch and computes pass/fail on the spot.
      </p>
      <div className="lp-cta-row">
        <LpActionButton variant="sun" size="sm" onClick={onCheck} disabled={l4check.status === "checking"}>
          {l4check.status === "checking" ? "Checking…" : "Check now →"}
        </LpActionButton>
      </div>
    </LevelCard>
  );
}

// ---------------------------------------------------------------------------
// Level 5 card — comprehension question, no live chain check.
// ---------------------------------------------------------------------------

function Level5Card({ done, storedProof, onSubmit }: { done: boolean; storedProof: string | null; onSubmit: (answer: string) => boolean }) {
  const [answer, setAnswer] = useState("");
  const [feedback, setFeedback] = useState<"idle" | "correct" | "incorrect">("idle");

  function handleSubmit() {
    const correct = onSubmit(answer);
    setFeedback(correct ? "correct" : "incorrect");
  }

  return (
    <LevelCard
      number={5}
      title="Understand the ownership latch"
      goal='Once a binding is verified, what happens if a later settlement arrives from a different address?'
      proofExplanation="a correct written answer — this is a comprehension check, not something verified on-chain."
      done={done}
    >
      {done ? (
        <p className="lp-lead" style={{ fontSize: "0.85rem" }}>
          Answered correctly{storedProof ? `: "${storedProof}"` : ""}.
        </p>
      ) : (
        <>
          <label htmlFor="l5-answer" className="lp-lead" style={{ fontSize: "0.8rem", display: "block" }}>
            Your answer:
          </label>
          <textarea
            id="l5-answer"
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            rows={2}
            style={{
              width: "100%",
              marginTop: "var(--lp-sp-2)",
              fontFamily: "var(--lp-body)",
              fontSize: "0.9rem",
              padding: "var(--lp-sp-3)",
              background: "var(--lp-paper-tint)",
              border: "1px solid var(--lp-line)",
              color: "inherit",
            }}
          />
          <div className="lp-cta-row">
            <LpActionButton variant="sun" size="sm" onClick={handleSubmit} disabled={!answer.trim()}>
              Submit →
            </LpActionButton>
          </div>
          {feedback === "incorrect" && (
            <p className="lp-lead" style={{ fontSize: "0.8rem", marginTop: "var(--lp-sp-2)" }}>
              Not quite — think about what &quot;permanent&quot; means for a proven binding.
            </p>
          )}
        </>
      )}
    </LevelCard>
  );
}

// ---------------------------------------------------------------------------
// Footer — "Run this on your machine", same established pattern as
// Stations 1/2/3's own footers (a copy-pasteable curl one-liner inside
// .lp-trace-panel with a Copy button) rather than an invented style.
// ---------------------------------------------------------------------------

async function copyToClipboard(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Best-effort, same as every other copy affordance in this app.
  }
}

function QuestRunOnYourMachine() {
  const [copied, setCopied] = useState(false);
  const snippet = [
    `curl -s ${FACILITATOR_URL}/discovery/resources \\`,
    `  | jq '.items[] | select(.resource == "${DEMO_RESOURCE_URL}") | .trust.ownershipState'`,
    "",
    '# Expect: "verified" — the same real value Level 4\'s live check reads.',
  ].join("\n");

  return (
    <div style={{ marginTop: "var(--lp-sp-8)" }}>
      <Eyebrow>Run this on your machine</Eyebrow>
      <p className="lp-lead" style={{ marginTop: "var(--lp-sp-4)", fontSize: "0.9rem" }}>
        Reads the live catalog and prints the demo resource&apos;s ownership state — the same real value Level 4
        checks above.
      </p>
      <div className="lp-trace-panel" style={{ marginTop: "var(--lp-sp-4)" }}>
        <div className="head">
          <span>curl</span>
          <button
            type="button"
            onClick={async () => {
              await copyToClipboard(snippet);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
            style={{ background: "none", border: 0, padding: 0, font: "inherit", color: "inherit", cursor: "pointer", textDecoration: "underline" }}
          >
            {copied ? "Copied!" : "Copy"}
          </button>
        </div>
        <pre style={{ whiteSpace: "pre-wrap", fontFamily: "var(--lp-mono)", fontSize: "0.8125rem", margin: 0, color: "var(--lp-on-dark)" }}>{snippet}</pre>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function QuestPage() {
  // NOT a lazy initializer reading localStorage: this page is server-rendered
  // (the static shell) with no access to the browser's localStorage, so the
  // server always "sees" an empty/false state. A lazy `useState(() =>
  // readX())` initializer runs during the CLIENT's first render too — before
  // hydration reconciles against the server HTML — so it would immediately
  // read the real (non-empty) browser state and produce output that doesn't
  // match what the server sent, a hydration mismatch (this is exactly what
  // happened here: verifiedCount/aria-valuenow/data-filled all rendered "2"
  // on the client vs the server's "0"). Every localStorage-derived value
  // below starts at its server-matching empty default, then is populated
  // inside a useEffect (client-only, runs after hydration) — the same
  // pattern this app already uses correctly elsewhere (the wallet-restore
  // effect on `/`, `useElapsedSeconds`).
  const [progress, setProgress] = useState<StoredQuestProgress>({});
  const [horizon, setHorizon] = useState<HorizonCheck>({ status: "idle" });
  const [l2check, setL2check] = useState<L2Check>({ status: "idle" });
  const [l4check, setL4check] = useState<L4Check>({ status: "idle" });

  const l1proof = progress[1]?.verified ? progress[1].proof : null;
  const l2proof = progress[2]?.verified ? progress[2].proof : null;

  const runHorizonCheck = useCallback(async (hash: string) => {
    setHorizon({ status: "checking" });
    try {
      const { ok } = await checkHorizonTx(hash);
      setHorizon({ status: "done", ok, checkedAt: Date.now() });
    } catch {
      setHorizon({ status: "error", message: "Couldn't reach Horizon. Please try again." });
    }
  }, []);

  const runL2Check = useCallback(async () => {
    setL2check({ status: "checking" });
    try {
      const trust = await fetchDemoResourceTrust();
      const state = trust?.ownershipState ?? null;
      const plausible = state === "verified" || state === "proven-unconfirmed";
      setL2check({ status: "done", state, plausible });
    } catch {
      setL2check({ status: "error", message: "Couldn't reach the facilitator. Please try again." });
    }
  }, []);

  const runL4Check = useCallback(async () => {
    setL4check({ status: "checking" });
    try {
      const trust = await fetchDemoResourceTrust();
      const state = trust?.ownershipState ?? null;
      const pass = state !== null && state !== "unverified";
      setL4check({ status: "done", state, pass });
      if (pass) {
        writeQuestLevel(4, { completedAt: Date.now(), proof: state as string, verified: true });
        setProgress(readQuestProgress());
      }
    } catch {
      setL4check({ status: "error", message: "Couldn't reach the facilitator. Please try again." });
    }
  }, []);

  // Background-refresh on mount: fire the live checks automatically once
  // proof exists, without blocking the initial render (see the module doc
  // comment's VERIFICATION-TIMING DECISION above Level1Card). Ref-guarded
  // (not a plain `if (l1proof)`) — same convention as `/status`'s
  // `hasLoadedInitially` ref: react-hooks/set-state-in-effect's static
  // analysis can't prove a setState reached through an async function call
  // is conditional unless the call site itself is gated by a ref check.
  const attemptedL1Check = useRef(false);
  useEffect(() => {
    if (!attemptedL1Check.current && l1proof) {
      attemptedL1Check.current = true;
      void runHorizonCheck(l1proof);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const attemptedL2Check = useRef(false);
  useEffect(() => {
    if (!attemptedL2Check.current && l2proof) {
      attemptedL2Check.current = true;
      void runL2Check();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-read on focus (e.g. returning from `/` after completing L1/L2/L3 via
  // a station) — per the task's own scoping, no cross-tab live-sync
  // mechanism, just a fresh read when this page regains focus/visibility.
  useEffect(() => {
    function onFocus() {
      setProgress(readQuestProgress());
    }
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, []);

  function handleL5Submit(answer: string): boolean {
    const correct = isCorrectLevel5Answer(answer);
    if (correct) {
      writeQuestLevel(5, { completedAt: Date.now(), proof: answer.trim(), verified: true });
      setProgress(readQuestProgress());
    }
    return correct;
  }

  // Server-matching defaults (see the hydration note above `progress`) —
  // populated for real in the mount effect below.
  const [walletReady, setWalletReady] = useState(false);
  const [attackResults, setAttackResults] = useState<StoredAttackResults>({});

  // The one place all of this page's localStorage reads actually happen for
  // the first time: after mount, i.e. after hydration has already reconciled
  // the server's empty-state HTML against the client's identical first
  // render. React re-renders with the real values immediately afterward —
  // a normal client-side update, not a hydration mismatch, because by this
  // point hydration is already done.
  //
  // The three setState calls are wrapped in `loadFromStorage` and invoked via
  // `void loadFromStorage()` rather than called directly in the effect body —
  // same convention as /status's `hasLoadedInitially` effect: react-hooks/
  // purity's static analysis can't see into a called function to prove its
  // setState calls are safe, so an unconditional direct call in the effect
  // body itself trips "calling setState synchronously within an effect", even
  // though this is a plain mount-once read with no external subscription.
  useEffect(() => {
    function loadFromStorage() {
      setProgress(readQuestProgress());
      setWalletReady(Boolean(readLastPayment()) || Boolean(readQuestProgress()[1]));
      setAttackResults(readAttackResults());
    }
    loadFromStorage();
  }, []);

  const level3Passed = Object.values(attackResults).some((r) => r.passed && VALID_CHECK_METHODS.has(r.checkMethod));

  const verifiedCount = computeVerifiedCount(progress, level3Passed);

  return (
    <>
      <div className="lp-content-head">
        <Eyebrow>The 5-level challenge</Eyebrow>
        <h1>Prove you understand the whole loop.</h1>
        <p className="lp-lead">
          Five checkpoints, each backed by something real: a settlement Horizon confirms, a verdict re-checked
          against the live facilitator, an attack the bench actually refused, a live catalog lookup, and one
          question about the ownership latch.
        </p>
        <QuestProgressBar verifiedCount={verifiedCount} />
      </div>

      <div className="lp-dgrid lp-dgrid--wide">
        <Level1Card proof={l1proof} horizon={horizon} onCheck={runHorizonCheck} />
        <Level2Card proof={l2proof} walletReady={walletReady} l2check={l2check} onCheck={runL2Check} />
        <Level3Card results={attackResults} />
        <Level4Card stored={Boolean(progress[4]?.verified)} l4check={l4check} onCheck={runL4Check} />
        <Level5Card done={Boolean(progress[5]?.verified)} storedProof={progress[5]?.proof ?? null} onSubmit={handleL5Submit} />
      </div>

      <QuestRunOnYourMachine />
    </>
  );
}
