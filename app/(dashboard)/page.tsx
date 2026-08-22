"use client";

import { useEffect, useRef, useState } from "react";
import { Eyebrow, Field, LpActionButton, MonoRow, MonoRows, TokenPill } from "../design/ui";
import { formatAtomicAmount, truncateMiddle } from "@/lib/format";
import { useElapsedSeconds } from "@/lib/use-elapsed-seconds";

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

interface PayResponse {
  ok: boolean;
  settlementTx?: string;
  payer?: string;
  network?: string;
  amount?: string;
  asset?: string;
  payTo?: string;
  attempts?: number;
  error?: string;
  message?: string;
}

type PayStage =
  | { status: "idle" }
  | { status: "paying"; startedAt: number; resourceUrl: string }
  | { status: "success"; result: PayResponse; resourceUrl: string }
  | { status: "error"; message: string; resourceUrl: string };

const DEMO_RESOURCE_URL = "https://vellar-seller-demo.onrender.com/quote";
const COLD_START_CEILING_MS = 60_000;

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
// Page
// ---------------------------------------------------------------------------

export default function Home() {
  const [wallet, setWallet] = useState<WalletStage>({ status: "idle" });
  const [catalog, setCatalog] = useState<CatalogStage>({ status: "idle" });
  const [pay, setPay] = useState<PayStage>({ status: "idle" });
  const [copied, setCopied] = useState(false);

  const walletElapsed = useElapsedSeconds(wallet.status === "loading" ? wallet.startedAt : null);
  const catalogElapsed = useElapsedSeconds(catalog.status === "loading" ? catalog.startedAt : null);
  const payElapsed = useElapsedSeconds(pay.status === "paying" ? pay.startedAt : null);

  // Fetch the catalog automatically once a wallet exists.
  const fetchedForWallet = useRef(false);
  useEffect(() => {
    if (wallet.status === "ready" && !fetchedForWallet.current) {
      fetchedForWallet.current = true;
      void loadCatalog();
    }
  }, [wallet.status]);

  async function createWallet() {
    const steps = initialSteps();
    setWallet({ status: "loading", startedAt: Date.now(), steps: { ...steps } });

    try {
      const res = await fetch("/api/session/create", { method: "POST" });
      if (!res.ok || !res.body) {
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
                setWallet({
                  status: "ready",
                  wallet: {
                    publicKey: result.publicKey,
                    balanceXlm: result.balanceXlm,
                    usdcProvisioned: Boolean(result.usdcProvisioned),
                    balanceUsdc: result.balanceUsdc,
                  },
                });
                continue;
              }
            }
            const message =
              typeof event.message === "string" ? event.message : "We couldn't set up your wallet. Please try again.";
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
            setWallet({
              status: "ready",
              wallet: {
                publicKey: result.publicKey,
                balanceXlm: result.balanceXlm,
                usdcProvisioned: Boolean(result.usdcProvisioned),
                balanceUsdc: result.balanceUsdc,
              },
            });
          }
        }
      }

      if (!settled) {
        // The stream ended (network hiccup, server crash mid-stream) without
        // ever reaching a "complete" event — treat as an honest failure
        // rather than leaving the UI stuck mid-progress.
        setWallet((prev) => ({
          status: "error",
          message: "The connection ended before your wallet finished setting up. Please try again.",
          steps: prev.status === "loading" ? prev.steps : steps,
        }));
      }
    } catch {
      setWallet((prev) => ({
        status: "error",
        message: "We couldn't reach the server. Please check your connection and try again.",
        steps: prev.status === "loading" ? prev.steps : steps,
      }));
    }
  }

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
    setPay({ status: "paying", startedAt: Date.now(), resourceUrl });
    try {
      const res = await fetch("/api/pay", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ resourceUrl }),
      });
      const body: PayResponse = await res.json();
      if (!res.ok || !body.ok) {
        setPay({ status: "error", message: body?.message || "Payment failed. Please try again.", resourceUrl });
        return;
      }
      setPay({ status: "success", result: body, resourceUrl });
    } catch {
      setPay({ status: "error", message: "We couldn't reach the server. Please check your connection and try again.", resourceUrl });
    }
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

      <div className="lp-dgrid lp-dgrid--wide">
        {/* ---- Wallet panel ---- */}
        <div className="lp-dpanel">
          <div className="lp-dpanel-head">
            <h2>Your wallet</h2>
          </div>
          <WalletSection
            wallet={wallet}
            elapsed={walletElapsed}
            onCreate={createWallet}
            copied={copied}
            onCopy={async (pk) => {
              await copyToClipboard(pk);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
          />
        </div>

        {/* ---- Catalog panel ---- */}
        {wallet.status === "ready" && (
          <div className="lp-dpanel">
            <CatalogSection
              catalog={catalog}
              elapsed={catalogElapsed}
              onRetry={loadCatalog}
              onPay={payForResource}
              payBusy={pay.status === "paying"}
            />
          </div>
        )}

        {/* ---- Payment trace panel (the cinematic moment) ---- */}
        {wallet.status === "ready" && pay.status !== "idle" && (
          <div className="lp-dpanel lp-dpanel--dark lp-dpanel--span2">
            <PaymentTrace pay={pay} elapsed={payElapsed} onRetry={() => payForResource(pay.resourceUrl)} />
          </div>
        )}
      </div>
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
}: {
  wallet: WalletStage;
  elapsed: number;
  onCreate: () => void;
  copied: boolean;
  onCopy: (pk: string) => void;
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
// Payment trace — the cinematic moment
// ---------------------------------------------------------------------------

function PaymentTrace({ pay, elapsed, onRetry }: { pay: PayStage; elapsed: number; onRetry: () => void }) {
  if (pay.status === "idle") return null;

  return (
    <div className="lp-trace-grid">
      <div>
        <Eyebrow>One request, end to end</Eyebrow>
        <h2 style={{ marginTop: "var(--lp-sp-4)" }}>
          Your wallet hits a paywall. <em>It pays it.</em>
        </h2>
        <p className="lp-lead">
          GET the resource, get a 402, build and sign a Stellar payment, retry with the signature
          attached, settle on-chain — all from a real testnet keypair, no browser secret.
        </p>
        {pay.status === "paying" && (
          <p className="lp-lead" style={{ marginTop: "var(--lp-sp-4)" }}>
            Paying... this can take a few tries on testnet ({elapsed}s)
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
              Settled in {pay.result.attempts ?? 1} attempt{(pay.result.attempts ?? 1) === 1 ? "" : "s"}.
            </p>
            {pay.result.settlementTx && (
              <div className="lp-cta-row">
                <a
                  className="lp-btn lp-btn--ghost"
                  href={`https://stellar.expert/explorer/testnet/tx/${pay.result.settlementTx}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  View settlement on Stellar Expert →
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
        <TraceRows pay={pay} />
        <div className="lp-trace-bar">
          <i />
        </div>
      </div>
    </div>
  );
}

function TraceRows({ pay }: { pay: Exclude<PayStage, { status: "idle" }> }) {
  const rows: Array<{ label: string; value?: string; tone?: "ok" | "bad" }> = [
    { label: "GET /quote", value: "402", tone: "bad" },
    { label: "PAYMENT-SIGNATURE", value: pay.status === "paying" ? "signing..." : "✓ signed", tone: pay.status === "paying" ? undefined : "ok" },
  ];

  if (pay.status === "paying") {
    rows.push({ label: "retry with signature", value: "..." });
  } else if (pay.status === "success") {
    rows.push({ label: "retry with signature", value: "200 OK", tone: "ok" });
    rows.push({
      label: "settled on-chain",
      value: pay.result.settlementTx ? truncateMiddle(pay.result.settlementTx, 10, 6) : "—",
      tone: "ok",
    });
  } else if (pay.status === "error") {
    rows.push({ label: "retry with signature", value: "failed", tone: "bad" });
  }

  return (
    <MonoRows>
      {rows.map((r, i) => (
        <MonoRow key={`${r.label}-${i}`} label={r.label} value={r.value} tone={r.tone} />
      ))}
    </MonoRows>
  );
}
