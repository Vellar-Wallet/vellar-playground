"use client";

// ---------------------------------------------------------------------------
// / — the landing/overview page. Used to be a single monolithic page holding
// the wallet panel plus all 3 stations, gated behind a wallet-ready state
// (nothing but "Get started" until a wallet existed). Split into always-
// reachable routes as part of the rail402-style sidebar restructure — see
// dashboard-shell.tsx's NAV_GROUPS doc comment for the full reasoning:
//   /pay             — First payment (Station 1)
//   /verify          — Ownership verification (Station 2)
//   /break/payments  — Break payments (half of Station 3)
//   /break/catalog   — Poison catalog (the other half of Station 3)
// This page is now just an entry point: the wallet panel (so a visitor can
// get started right from the front door) plus a short map of where
// everything else lives, matching the "Journey map" role rail402's own
// landing page plays in their sidebar.
// ---------------------------------------------------------------------------

import Link from "next/link";
import { Eyebrow, Field, LpActionButton, TokenPill } from "../design/ui";
import { truncateMiddle } from "@/lib/format";
import { useWallet, WALLET_STEP_ORDER, WALLET_STEP_LABELS, type WalletStepMap } from "@/lib/wallet-context";
import { useState } from "react";

async function copyToClipboard(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Convenience affordance, not a critical path — fail silently.
  }
}

function StepProgress({ steps }: { steps: WalletStepMap }) {
  return (
    <div className="lp-steps-card">
      {WALLET_STEP_ORDER.map((step) => {
        const status = steps[step];
        const note = status === "skipped" ? "Skipped — wallet still usable" : status === "error" ? "Failed" : undefined;
        return (
          <div className="lp-step-row" data-state={status} key={step}>
            <span className="lp-step-mark" aria-hidden />
            <span className="lp-step-label">{WALLET_STEP_LABELS[step]}</span>
            {note && <span className="lp-step-note">{note}</span>}
          </div>
        );
      })}
    </div>
  );
}

const JOURNEY_GROUPS = [
  {
    label: "Learn the flow",
    items: [
      { href: "/pay", label: "First payment", description: "Pay a real API and inspect every byte on the wire." },
      { href: "/verify", label: "Ownership verification", description: "A resource's ownership binding, once proven, can't be taken back." },
    ],
  },
  {
    label: "Break it",
    items: [
      { href: "/break/payments", label: "Break payments", description: "Five deliberate corruptions of a real signed payment, every one refused." },
      { href: "/break/catalog", label: "Poison catalog", description: "Three poisoning attempts against the Bazaar's real catalog." },
    ],
  },
  {
    label: "Discovery",
    items: [{ href: "/catalog", label: "Bazaar catalog", description: "Every resource the facilitator has seen, with a real Pay button on each." }],
  },
  {
    label: "Learn",
    items: [
      { href: "/quest", label: "Quest", description: "A five-level challenge track through everything above." },
      { href: "/bond", label: "Bond system", description: "How Vellar closes the gap between settlement and delivery." },
    ],
  },
  {
    label: "Tools",
    items: [
      { href: "/status", label: "Status", description: "Live facilitator health, supported schemes, sponsor signer." },
      { href: "/console", label: "Console", description: "Every facilitator endpoint, raw." },
    ],
  },
];

export default function Home() {
  const { wallet, elapsed, createWallet } = useWallet();
  const [copied, setCopied] = useState(false);

  return (
    <>
      <div className="lp-content-head">
        <Eyebrow>Vellar Playground</Eyebrow>
        <h1>Learn x402 by doing it, for real.</h1>
        <p className="lp-lead">
          A playground for external developers to visually try out the Vellar x402 payment facilitator
          on Stellar testnet — get a real funded wallet, then work through the lessons below. Real
          settlements, real refusals, everything inspectable.
        </p>
      </div>

      <div className="lp-dpanel" style={{ marginTop: "var(--lp-sp-6)" }}>
        <div className="lp-dpanel-head">
          <h2>Your wallet</h2>
        </div>
        <WalletCardBody wallet={wallet} elapsed={elapsed} onCreate={() => createWallet("button")} copied={copied} onCopy={async (pk) => {
          await copyToClipboard(pk);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }} />
      </div>

      {JOURNEY_GROUPS.map((group) => (
        <div key={group.label} style={{ marginTop: "var(--lp-sp-8)" }}>
          <Eyebrow>{group.label}</Eyebrow>
          <div className="lp-dgrid" style={{ marginTop: "var(--lp-sp-4)" }}>
            {group.items.map((item) => (
              <Link key={item.href} href={item.href} className="lp-dpanel lp-journey-card">
                <b style={{ fontSize: "0.95rem" }}>{item.label}</b>
                <p className="lp-lead" style={{ fontSize: "0.8rem", marginTop: "var(--lp-sp-2)" }}>
                  {item.description}
                </p>
              </Link>
            ))}
          </div>
        </div>
      ))}
    </>
  );
}

function WalletCardBody({
  wallet,
  elapsed,
  onCreate,
  copied,
  onCopy,
}: {
  wallet: ReturnType<typeof useWallet>["wallet"];
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
          Setting up your wallet, live — each step below only ticks once it has genuinely finished ({elapsed}s).
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

  // "cached" or "ready" — both carry a real WalletState.
  const { publicKey, balanceXlm, usdcProvisioned, balanceUsdc } = wallet.wallet;
  const explorerUrl = `https://stellar.expert/explorer/testnet/account/${publicKey}`;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--lp-sp-4)" }}>
      <Field
        label="PUBLIC KEY"
        amount={truncateMiddle(publicKey, 5, 4)}
        amountStyle={{ fontSize: 18, fontFamily: "var(--lp-mono)" }}
        sub={
          <>
            <button
              type="button"
              onClick={() => onCopy(publicKey)}
              style={{ background: "none", border: 0, padding: 0, font: "inherit", color: "inherit", cursor: "pointer", textDecoration: "underline" }}
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
          USDC funding didn&apos;t complete — you can still browse the catalog, but paying may not work yet.
        </p>
      )}
    </div>
  );
}
