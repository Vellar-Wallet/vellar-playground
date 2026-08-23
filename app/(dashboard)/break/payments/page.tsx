"use client";

// ---------------------------------------------------------------------------
// /break/payments — "Break payments" (half of formerly Station 3's attack
// bench, inline on "/"). Split into its own always-reachable route as part
// of the rail402-style sidebar restructure — see dashboard-shell.tsx's
// NAV_GROUPS doc comment. The other half (catalog attacks + the sanitizer
// demo) is /break/catalog — see that page for why the sanitizer landed
// there instead of here (it's about a crafted CATALOG description, not a
// payment).
//
// Needs a funded session wallet to arm the bench — same precondition /pay
// has — so this page gates its "Arm the bench" action on useWallet().
// ---------------------------------------------------------------------------

import { useState } from "react";
import { Eyebrow, LpActionButton, MonoRow, MonoRows } from "../../../design/ui";
import { truncateMiddle } from "@/lib/format";
import { FACILITATOR_URL } from "@/lib/config";
import { writeAttackResult, type StoredAttackResult } from "@/lib/local-storage";
import { useElapsedSeconds } from "@/lib/use-elapsed-seconds";
import { useWallet } from "@/lib/wallet-context";

type AttackBenchStatus = "pending" | "active" | "done" | "error";

interface AttackBenchEntry {
  status: AttackBenchStatus;
  result?: StoredAttackResult;
  message?: string;
}

const PAYMENT_ATTACK_IDS = ["tamper_amount", "redirect_payto", "strip_signature", "wrong_network", "replay"] as const;
type PaymentAttackId = (typeof PAYMENT_ATTACK_IDS)[number];

const PAYMENT_ATTACK_LABELS: Record<PaymentAttackId, string> = {
  tamper_amount: "Tamper the amount",
  redirect_payto: "Redirect the payTo",
  strip_signature: "Strip the signature",
  wrong_network: "Claim an unregistered network",
  replay: "Replay an already-settled payment",
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

type PaymentAttackMap = Record<PaymentAttackId, AttackBenchEntry>;

type PaymentAttackStage =
  | { status: "idle" }
  | { status: "running"; startedAt: number; attacks: PaymentAttackMap }
  | { status: "done"; attacks: PaymentAttackMap }
  | { status: "error"; message: string; attacks: PaymentAttackMap };

interface AttackStreamEvent {
  step: string;
  status: string;
  attackId?: string;
  result?: StoredAttackResult;
  message?: string;
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

const ATTACK_LIVE_NOTES: Record<PaymentAttackId, string> = {
  tamper_amount: "Live — a real, deliberately-corrupted payload submitted to the real hosted facilitator's /verify.",
  redirect_payto: "Live — a real, deliberately-corrupted payload submitted to the real hosted facilitator's /verify.",
  strip_signature: "Live — a real, deliberately-corrupted payload submitted to the real hosted facilitator's /verify.",
  wrong_network: "Live — the real armed payload's network claim submitted to the real hosted facilitator's /verify.",
  replay:
    "Live — a real settlement, then the exact same payload replayed against the real hosted facilitator's /settle (the one attack in this track that needs /settle, not /verify).",
};

function attackRowState(entry: AttackBenchEntry): "pending" | "active" | "done" | "error" {
  if (entry.status === "pending") return "pending";
  if (entry.status === "active") return "active";
  if (entry.status === "error") return "error";
  return entry.result?.passed ? "done" : "error";
}

function attackRowNote(entry: AttackBenchEntry): string {
  if (entry.status === "pending") return "Waiting";
  if (entry.status === "active") return "In progress";
  if (entry.status === "error") return entry.message ?? "Failed to run";
  if (!entry.result) return "Done";
  if (entry.result.checkMethod === "http_status") {
    return entry.result.passed ? `Refused as expected — HTTP ${entry.result.httpStatus}` : `Unexpected — HTTP ${entry.result.httpStatus}`;
  }
  if (entry.result.checkMethod === "poll_diff") {
    return entry.result.passed ? "Confirmed" : "Unexpected result";
  }
  return entry.result.passed ? `Refused as expected — ${entry.result.reasonCode ?? "no reason code"}` : `Unexpected — ${entry.result.reasonCode ?? "no reason code"}`;
}

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

async function copyToClipboard(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Convenience affordance, not a critical path — fail silently.
  }
}

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
    "# is never sent to the browser — same discipline as /pay's snippet).",
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

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function BreakPaymentsPage() {
  const { wallet, createWallet } = useWallet();
  const [paymentAttacks, setPaymentAttacks] = useState<PaymentAttackStage>({ status: "idle" });
  const paymentAttacksElapsed = useElapsedSeconds(paymentAttacks.status === "running" ? paymentAttacks.startedAt : null);

  const hasWallet = wallet.status === "ready" || wallet.status === "cached";

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
        return { ...prev, attacks: { ...prev.attacks, [attackId]: { status: "error", message: event.message } } };
      }
      return prev;
    }

    try {
      const res = await fetch("/api/attack/payment", { method: "POST" });
      if (!res.ok || !res.body) {
        const body = await res.json().catch(() => ({}));
        const message = typeof body?.message === "string" ? body.message : "We couldn't reach the server. Please try again.";
        setPaymentAttacks((prev) => ({ status: "error", message, attacks: prev.status === "running" ? prev.attacks : attacks }));
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
        setPaymentAttacks((prev) => ({ status: "error", message, attacks: prev.status === "running" ? prev.attacks : attacks }));
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
        }
      }

      const trailing = parseAttackStreamLine(buffer);
      if (trailing?.step === "complete") finish(trailing);

      if (!settled) {
        setPaymentAttacks((prev) => ({ status: "error", message: "The connection ended before the attack bench finished. Please try again.", attacks: prev.status === "running" ? prev.attacks : attacks }));
      }
    } catch {
      setPaymentAttacks((prev) => ({ status: "error", message: "We couldn't reach the server. Please check your connection and try again.", attacks: prev.status === "running" ? prev.attacks : attacks }));
    }
  }

  const paymentMap = paymentAttacks.status === "running" || paymentAttacks.status === "done" || paymentAttacks.status === "error" ? paymentAttacks.attacks : initialPaymentAttackMap();

  return (
    <>
      <div className="lp-content-head">
        <Eyebrow>Break payments</Eyebrow>
        <h1>
          Break it. <em>Watch it refuse to break.</em>
        </h1>
        <p className="lp-lead">
          Five deliberate attacks against a real signed payment, submitted live to the real hosted
          facilitator. Mint means the facilitator refused for the right reason (a pass for the defense);
          coral means something unexpected happened.
        </p>
      </div>

      {!hasWallet && (
        <div className="lp-cta-row" style={{ marginTop: "var(--lp-sp-4)" }}>
          <LpActionButton variant="sun" size="lg" onClick={() => createWallet("button")}>
            Get a wallet to arm the bench →
          </LpActionButton>
        </div>
      )}

      {hasWallet && (
        <div className="lp-dpanel lp-dpanel--dark lp-dpanel--dark-coral" style={{ marginTop: "var(--lp-sp-6)" }}>
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
              <LpActionButton variant="sun" onClick={runPaymentAttacks}>
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
                  Arming and attacking... ({paymentAttacksElapsed}s)
                </p>
              )}
              {paymentAttacks.status === "error" && (
                <div style={{ marginTop: "var(--lp-sp-4)" }}>
                  <p className="lp-lead">{paymentAttacks.message}</p>
                  <div className="lp-cta-row">
                    <LpActionButton variant="ghost" size="sm" onClick={runPaymentAttacks}>
                      Try again
                    </LpActionButton>
                  </div>
                </div>
              )}
              {paymentAttacks.status === "done" && (
                <div className="lp-cta-row" style={{ marginTop: "var(--lp-sp-4)" }}>
                  <LpActionButton variant="ghost" size="sm" onClick={runPaymentAttacks}>
                    Run again
                  </LpActionButton>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </>
  );
}
