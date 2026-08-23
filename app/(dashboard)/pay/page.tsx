"use client";

// ---------------------------------------------------------------------------
// /pay — "First payment" (formerly Station 1, inline on "/"). Split into its
// own always-reachable route as part of the rail402-style sidebar restructure
// (flat routes, no gating behind a wallet-ready single page) — see
// dashboard-shell.tsx's NAV_GROUPS doc comment for the full rationale.
//
// Wallet state itself now lives in lib/wallet-context.tsx (shared across
// every dashboard route via the (dashboard) layout), NOT here — this page
// only owns what's specific to the payment flow: the catalog grid you pay
// FROM, the payment ledger, and this station's own "who is involved"/"run
// this on your machine" footers.
// ---------------------------------------------------------------------------

import { useEffect, useRef, useState } from "react";
import { Eyebrow, LpActionButton, MonoRow, MonoRows } from "../../design/ui";
import { formatAtomicAmount, truncateMiddle } from "@/lib/format";
import { useElapsedSeconds } from "@/lib/use-elapsed-seconds";
import { FACILITATOR_URL, SELLER_URL } from "@/lib/config";
import { isLocalOrPrivateResource } from "@/lib/catalog";
import { readLastPayment, readSession, writeLastPayment, writeQuestLevel, writeSession } from "@/lib/local-storage";
import { useWallet } from "@/lib/wallet-context";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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

interface LedgerEvent {
  step: string;
  status: string;
  attempt?: number;
  maxAttempts?: number;
  [key: string]: unknown;
}

interface LedgerStepState {
  status: LedgerStepStatus;
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

const COLD_START_CEILING_MS = 60_000;

async function copyToClipboard(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Clipboard access can fail (permissions, insecure context) — this is a
    // convenience affordance, not a critical path, so fail silently.
  }
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function PayPage() {
  const { wallet, createWallet } = useWallet();
  const [catalog, setCatalog] = useState<CatalogStage>({ status: "idle" });
  const [pay, setPay] = useState<PayStage>({ status: "idle" });

  const catalogElapsed = useElapsedSeconds(catalog.status === "loading" ? catalog.startedAt : null);
  const payElapsed = useElapsedSeconds(pay.status === "paying" ? pay.startedAt : null);

  const hasWallet = wallet.status === "ready" || wallet.status === "cached";
  const walletPublicKey = wallet.status === "ready" || wallet.status === "cached" ? wallet.wallet.publicKey : undefined;

  async function loadCatalog() {
    setCatalog({ status: "loading", startedAt: Date.now() });
    try {
      const res = await fetch("/api/catalog");
      const body = await res.json();
      if (!res.ok) {
        setCatalog({ status: "error", message: body?.message || "We couldn't load the catalog. Please try again." });
        return;
      }
      const rawItems: CatalogItem[] = Array.isArray(body?.items) ? body.items : [];
      const items = rawItems.filter((item) => !isLocalOrPrivateResource(item.resource));
      setCatalog({ status: "ready", items });
    } catch {
      setCatalog({ status: "error", message: "We couldn't reach the server. Please check your connection and try again." });
    }
  }

  // Fetch the catalog automatically once a wallet exists — "cached" counts
  // (the pill's cached display data is real, and the catalog is public
  // read-only data anyway, so there's no reason to wait for the background
  // wallet re-confirm before loading it).
  const fetchedForWallet = useRef(false);
  useEffect(() => {
    if (hasWallet && !fetchedForWallet.current) {
      fetchedForWallet.current = true;
      void loadCatalog();
    }
  }, [hasWallet]);

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

    let latestPaymentPayload: unknown = undefined;

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

    function applyEvent(prev: PayStage, event: LedgerEvent): PayStage {
      if (prev.status !== "paying") return prev;

      if (event.step === "waking_up") {
        return { ...prev, wakingUp: true, wakingUpSince: prev.wakingUpSince ?? Date.now() };
      }

      if (event.step === "retry") {
        const maxAttempts = typeof event.maxAttempts === "number" ? event.maxAttempts : prev.maxAttempts;
        const attempt = typeof event.attempt === "number" ? event.attempt : prev.attempt + 1;
        latestPaymentPayload = undefined;
        return { ...prev, steps: initialLedgerSteps(), attempt, maxAttempts, wakingUp: false, wakingUpSince: null };
      }

      if (LEDGER_STEP_ORDER.includes(event.step as LedgerStepName)) {
        const stepName = event.step as LedgerStepName;
        const status = event.status;
        if (status !== "active" && status !== "done" && status !== "error") return prev;
        if (stepName === "verify" && status === "done" && "paymentPayload" in event) {
          latestPaymentPayload = event.paymentPayload;
        }
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

  return (
    <>
      <div className="lp-content-head">
        <Eyebrow>First payment</Eyebrow>
        <h1>Watch a 402 turn into a 200.</h1>
        <p className="lp-lead">
          Browse the live Bazaar catalog and pay a real invoice — six real steps, each one only ticks
          once it has genuinely happened.
        </p>
      </div>

      {wallet.status === "idle" && (
        <div className="lp-cta-row" style={{ marginTop: "var(--lp-sp-4)" }}>
          <LpActionButton variant="sun" size="lg" onClick={() => createWallet("button")}>
            Get started →
          </LpActionButton>
        </div>
      )}

      {(wallet.status === "loading" || wallet.status === "restoring") && (
        <p className="lp-lead" style={{ marginTop: "var(--lp-sp-4)" }}>
          Setting up your wallet…
        </p>
      )}

      {wallet.status === "error" && (
        <div style={{ marginTop: "var(--lp-sp-4)" }}>
          <p className="lp-lead">{wallet.message}</p>
          <div className="lp-cta-row">
            <LpActionButton variant="outline" onClick={() => createWallet("button")}>
              Try again
            </LpActionButton>
          </div>
        </div>
      )}

      {hasWallet && pay.status !== "idle" && (
        <div className="lp-dpanel lp-dpanel--dark" style={{ marginTop: "var(--lp-sp-6)" }}>
          <PayLedger pay={pay} elapsed={payElapsed} onRetry={() => payForResource(pay.resourceUrl)} />
        </div>
      )}

      {hasWallet && (
        <>
          <div className="lp-dpanel lp-dpanel--lime" style={{ marginTop: "var(--lp-sp-6)" }}>
            <CatalogSection catalog={catalog} elapsed={catalogElapsed} onRetry={loadCatalog} onPay={payForResource} payBusy={pay.status === "paying"} />
          </div>

          {pay.status !== "idle" && walletPublicKey && <WhoIsInvolved publicKey={walletPublicKey} pay={pay} />}
          {pay.status !== "idle" && walletPublicKey && <RunOnYourMachine publicKey={walletPublicKey} resourceUrl={pay.resourceUrl} />}
        </>
      )}
    </>
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

const CATALOG_TINTS = ["mint", "sun", "lime", "coral"] as const;
const CATALOG_VISIBLE_COUNT = 9;

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
  const [expanded, setExpanded] = useState(false);
  const allItems = catalog.status === "ready" ? catalog.items : [];
  const visibleItems = expanded ? allItems : allItems.slice(0, CATALOG_VISIBLE_COUNT);
  const hiddenCount = allItems.length - visibleItems.length;

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

      {catalog.status === "ready" && allItems.length === 0 && <p className="lp-lead">No resources are cataloged yet.</p>}

      {catalog.status === "ready" && allItems.length > 0 && (
        <>
          <div className="lp-dgrid" style={{ marginTop: "var(--lp-sp-4)" }}>
            {visibleItems.map((item, index) => {
              const accept = item.accepts?.[0];
              const trust = trustLabel(item.trust);
              const tint = CATALOG_TINTS[index % CATALOG_TINTS.length];
              return (
                <div className={`lp-dpanel lp-dpanel--${tint}`} key={item.resource}>
                  <div>
                    <b style={{ fontSize: "0.95rem" }}>{item.description || item.resource}</b>
                    <p className="lp-lead" style={{ fontSize: "0.8rem", marginTop: "var(--lp-sp-2)" }}>
                      {formatAtomicAmount(accept?.amount)} atomic of {truncateMiddle(accept?.asset || "—")}
                    </p>
                    <p className="lp-lead" style={{ fontSize: "0.75rem", marginTop: "var(--lp-sp-1)" }}>
                      {truncateMiddle(item.resource, 32, 12)}
                    </p>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "var(--lp-sp-3)", marginTop: "var(--lp-sp-3)" }}>
                    <span className="lp-verified" style={!trust.verified ? { background: "var(--lp-paper-tint)" } : undefined}>
                      {trust.verified ? "✓ " : ""}
                      {trust.text}
                    </span>
                    <LpActionButton variant="sun" size="sm" onClick={() => onPay(item.resource)} disabled={payBusy}>
                      Pay →
                    </LpActionButton>
                  </div>
                </div>
              );
            })}
          </div>

          {allItems.length > CATALOG_VISIBLE_COUNT && (
            <div className="lp-cta-row" style={{ marginTop: "var(--lp-sp-4)" }}>
              <LpActionButton variant="outline" size="sm" onClick={() => setExpanded((v) => !v)}>
                {expanded ? "See less" : `See ${hiddenCount} more →`}
              </LpActionButton>
            </div>
          )}
        </>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Payment ledger — the cinematic moment, six real steps
// ---------------------------------------------------------------------------

function ledgerStepStatusLabel(step: LedgerStepState): string {
  if (step.status === "pending") return "Waiting";
  if (step.status === "active") return "In progress";
  if (step.status === "error") return step.message ?? "Failed";
  return "Done";
}

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
    <details className="lp-fitem lp-fitem--raw" name="ledger-raw-bytes">
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
        <h2 style={{ marginTop: "var(--lp-sp-8)" }}>
          Your wallet hits a paywall. <em>It pays it.</em>
        </h2>
        <p className="lp-lead" style={{ marginTop: "var(--lp-sp-6)", lineHeight: 1.75 }}>
          GET the resource, get a 402, build and sign a Stellar payment, verify and settle it, and
          receive the paid resource — all from a real testnet keypair, no browser secret. Six real
          steps, each one only ticks once it has genuinely happened.
        </p>

        {pay.status === "paying" && attempt > 1 && (
          <p className="lp-lead" style={{ marginTop: "var(--lp-sp-6)", fontWeight: 700 }}>
            Attempt {attempt} of {maxAttempts} — the first attempt didn&apos;t settle (this happens on
            testnet), so the whole flow restarted with a fresh signature.
          </p>
        )}
        {pay.status === "paying" && pay.wakingUp && (
          <p className="lp-lead" style={{ marginTop: "var(--lp-sp-6)" }}>
            The demo seller looks like it&apos;s waking up from a cold start — this can take up to a
            minute on testnet. ({elapsed}s)
          </p>
        )}
        {pay.status === "paying" && !pay.wakingUp && (
          <p className="lp-lead" style={{ marginTop: "var(--lp-sp-6)" }}>
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
                <a className="lp-btn lp-btn--ghost" href={`https://horizon-testnet.stellar.org/transactions/${pay.result.settlementTx}`} target="_blank" rel="noreferrer">
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

function explorerAccountUrl(key: string): string {
  return `https://stellar.expert/explorer/testnet/account/${key}`;
}

function WhoIsInvolvedCard({ label, value, href, mono = true }: { label: string; value: string; href: string; mono?: boolean }) {
  return (
    <div className="lp-dpanel" style={{ padding: "var(--lp-sp-4)", gap: "var(--lp-sp-2)" }}>
      <div className="lbl" style={{ fontSize: "0.75rem", fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--lp-ink-faint)" }}>
        {label}
      </div>
      <div style={{ fontFamily: mono ? "var(--lp-mono)" : undefined, fontSize: "0.875rem", wordBreak: "break-all" }}>{truncateMiddle(value, 20, 8)}</div>
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

function RunOnYourMachine({ publicKey, resourceUrl }: { publicKey?: string; resourceUrl?: string }) {
  const [tab, setTab] = useState<"cli" | "curl">("cli");
  const [copiedSnippet, setCopiedSnippet] = useState(false);

  const [fallbackPayment] = useState(() => (resourceUrl ? null : readLastPayment()));
  const [fallbackSession] = useState(() => (publicKey ? null : readSession()));

  const effectiveResourceUrl = resourceUrl ?? fallbackPayment?.sellerUrl;
  const effectivePublicKey = publicKey ?? fallbackSession?.publicKey;

  if (!effectiveResourceUrl) {
    return (
      <div style={{ marginTop: "var(--lp-sp-8)" }}>
        <Eyebrow>Run this on your machine</Eyebrow>
        <p className="lp-lead" style={{ marginTop: "var(--lp-sp-4)" }}>
          Make a payment first — once you&apos;ve paid a resource, its CLI and curl snippets will show up here.
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

  const curlSnippet = [`curl -i ${effectiveResourceUrl}`, "", "# Expect: HTTP/1.1 402 Payment Required", "# with a PAYMENT-REQUIRED header (base64-encoded challenge)."].join("\n");

  const snippet = tab === "cli" ? cliSnippet : curlSnippet;

  return (
    <div style={{ marginTop: "var(--lp-sp-8)" }}>
      <Eyebrow>Run this on your machine</Eyebrow>
      <div className="lp-chips" role="tablist" aria-label="Snippet language" style={{ marginTop: "var(--lp-sp-4)" }}>
        <b role="tab" aria-selected={tab === "cli"} tabIndex={0} className={tab === "cli" ? "on" : undefined} style={{ cursor: "pointer" }} onClick={() => setTab("cli")} onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && setTab("cli")}>
          CLI
        </b>
        <b role="tab" aria-selected={tab === "curl"} tabIndex={0} className={tab === "curl" ? "on" : undefined} style={{ cursor: "pointer" }} onClick={() => setTab("curl")} onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && setTab("curl")}>
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
