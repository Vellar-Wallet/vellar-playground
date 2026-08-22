"use client";

import { useEffect, useRef, useState } from "react";
import { Eyebrow, Field, LpActionButton, MonoRow, MonoRows, TokenPill } from "./design/ui";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface WalletState {
  publicKey: string;
  balanceXlm: string;
}

type WalletStage =
  | { status: "idle" }
  | { status: "loading"; startedAt: number }
  | { status: "ready"; wallet: WalletState }
  | { status: "error"; message: string };

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

function truncateMiddle(s: string, head = 10, tail = 6): string {
  if (s.length <= head + tail + 3) return s;
  return `${s.slice(0, head)}...${s.slice(-tail)}`;
}

/** Format an atomic amount for the (default 7-decimal) Stellar SEP-41 token
 *  convention used by testnet USDC here — see @x402/stellar's
 *  DEFAULT_TOKEN_DECIMALS. Falls back to the raw atomic string if the value
 *  isn't a plain integer string, rather than guessing. */
function formatAtomicAmount(amount?: string): string {
  if (!amount) return "—";
  if (!/^\d+$/.test(amount)) return amount;
  const decimals = 7;
  const padded = amount.padStart(decimals + 1, "0");
  const whole = padded.slice(0, -decimals).replace(/^0+(?=\d)/, "");
  const frac = padded.slice(-decimals).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

/** Live-updating "(Ns)" elapsed-time counter, ticking every second.
 *
 *  `Date.now()` is read only from inside the `setInterval` callback — an
 *  event-like async callback, not the effect body itself or the render body
 *  — which satisfies both React 19 purity rules: no impure call during
 *  render, and no synchronous `setState` in the effect body (the effect only
 *  *subscribes*; the interval callback is what calls `setState`, exactly the
 *  "calling setState in a callback function when external state changes"
 *  pattern the lint rule asks for). The first tick's value lags by up to 1s
 *  (visible only as "(0s)" for a moment) — an acceptable tradeoff for a
 *  loading-state counter, not worth a synchronous effect setState to avoid. */
function useElapsedSeconds(startedAt: number | null): number {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (startedAt === null) return;
    const id = setInterval(() => {
      setElapsed(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));
    }, 1000);
    return () => clearInterval(id);
  }, [startedAt]);
  return startedAt === null ? 0 : elapsed;
}

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
    setWallet({ status: "loading", startedAt: Date.now() });
    try {
      const res = await fetch("/api/session/create", { method: "POST" });
      const body = await res.json();
      if (!res.ok) {
        setWallet({ status: "error", message: body?.message || "We couldn't set up your wallet. Please try again." });
        return;
      }
      setWallet({ status: "ready", wallet: { publicKey: body.publicKey, balanceXlm: body.balanceXlm } });
    } catch {
      setWallet({ status: "error", message: "We couldn't reach the server. Please check your connection and try again." });
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
    <main className="lp-wrap lp-hero">
      <Eyebrow>Vellar Playground</Eyebrow>
      <h1>Watch a 402 turn into a 200.</h1>
      <p className="lp-lead">
        A playground for external developers to visually try out the Vellar x402 payment facilitator
        on Stellar testnet — get a real funded wallet, browse the live Bazaar catalog, and pay a real
        invoice, no setup required.
      </p>

      {/* ---- Section 1: Get started / wallet ---- */}
      <section className="lp-sec lp-sec--tight" style={{ paddingBottom: 0 }}>
        <WalletSection wallet={wallet} elapsed={walletElapsed} onCreate={createWallet} copied={copied} onCopy={async (pk) => {
          await copyToClipboard(pk);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }} />
      </section>

      {/* ---- Section 2: Catalog ---- */}
      {wallet.status === "ready" && (
        <section className="lp-sec">
          <CatalogSection
            catalog={catalog}
            elapsed={catalogElapsed}
            onRetry={loadCatalog}
            onPay={payForResource}
            payBusy={pay.status === "paying"}
          />
        </section>
      )}

      {/* ---- Section 3: Payment trace (the cinematic moment) ---- */}
      {wallet.status === "ready" && pay.status !== "idle" && (
        <section className="lp-sec lp-sec--tight">
          <PaymentTrace pay={pay} elapsed={payElapsed} onRetry={() => payForResource(pay.resourceUrl)} />
        </section>
      )}
    </main>
  );
}

// ---------------------------------------------------------------------------
// Wallet section
// ---------------------------------------------------------------------------

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
      <div className="lp-cta-row">
        <LpActionButton variant="sun" size="lg" onClick={onCreate}>
          Get started →
        </LpActionButton>
      </div>
    );
  }

  if (wallet.status === "loading") {
    return (
      <div>
        <p className="lp-lead">Setting up your wallet... ({elapsed}s)</p>
        <p className="lp-lead" style={{ fontSize: "0.9rem" }}>
          We&apos;re generating a fresh Stellar testnet keypair and funding it via friendbot. This is
          usually fast.
        </p>
      </div>
    );
  }

  if (wallet.status === "error") {
    return (
      <div>
        <p className="lp-lead">{wallet.message}</p>
        <div className="lp-cta-row">
          <LpActionButton variant="outline" onClick={onCreate}>
            Try again
          </LpActionButton>
        </div>
      </div>
    );
  }

  const { publicKey, balanceXlm } = wallet.wallet;
  const explorerUrl = `https://stellar.expert/explorer/testnet/account/${publicKey}`;

  return (
    <div className="lp-hero-cards" style={{ marginTop: "var(--lp-sp-8)", gridTemplateColumns: "minmax(0, 1fr)" }}>
      <div className="lp-pcard" style={{ maxWidth: 480 }}>
        <div className="lp-pcard-top">
          <span>Your testnet wallet</span>
          <span>◇</span>
        </div>
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
      <Eyebrow>Bazaar catalog</Eyebrow>
      <h2 style={{ marginTop: "var(--lp-sp-4)" }}>Live resources, from the real facilitator.</h2>

      {catalog.status === "loading" && (
        <p className="lp-lead" style={{ marginTop: "var(--lp-sp-6)" }}>
          Waking up the facilitator... ({elapsed}s)
          {elapsed > COLD_START_CEILING_MS / 1000 && " This is taking longer than usual."}
        </p>
      )}

      {catalog.status === "error" && (
        <div style={{ marginTop: "var(--lp-sp-6)" }}>
          <p className="lp-lead">{catalog.message}</p>
          <div className="lp-cta-row">
            <LpActionButton variant="outline" onClick={onRetry}>
              Retry
            </LpActionButton>
          </div>
        </div>
      )}

      {catalog.status === "ready" && catalog.items.length === 0 && (
        <p className="lp-lead" style={{ marginTop: "var(--lp-sp-6)" }}>
          No resources are cataloged yet.
        </p>
      )}

      {catalog.status === "ready" && catalog.items.length > 0 && (
        <div className="lp-rlist" style={{ marginTop: "var(--lp-sp-8)" }}>
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
      <div className="lp-cta-row" style={{ marginTop: "var(--lp-sp-8)" }}>
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
    <div className="lp-trace lp-invert">
      <div className="lp-wrap lp-trace-pin">
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
