"use client";

import { useState } from "react";
import { cx, Eyebrow, Frame, MonoRow, MonoRows } from "../../design/ui";
import { truncateMiddle } from "@/lib/format";
import {
  BOND_ESCROW_CONTRACT_ID,
  BOND_SEQUENCE,
  STELLAR_EXPERT_TESTNET_CONTRACT_URL,
  stellarExpertTestnetTxUrl,
} from "@/lib/config";

// ---------------------------------------------------------------------------
// /bond — the bond system explainer. Read-only and entirely static/
// client-side: no session, no wallet, no API route of its own. The last
// "station" of the guided tour, covering ground none of the prior six pages
// touch — provider bonds, dispute standing, and slashing — as a design
// explainer backed by real, Horizon-confirmed on-chain evidence rather than
// a hypothetical.
//
// SECURITY NOTE: this file imports no `lib/session`, holds no secret key,
// and makes no facilitator/session-scoped calls. Every fact rendered here is
// either a compile-time constant (lib/config.ts's BOND_* exports, lifted
// verbatim from vellar-facilitator's docs/bond-escrow-deployment.md) or a
// link to public explorers (Stellar Expert / Horizon) the visitor's own
// browser fetches, not this app's server.
//
// STRUCTURE — three parts per the task's locked spec:
//   1. The problem (one honest paragraph, static)
//   2. How it works — six clickable <details> steps (Frame + .lp-dpanel
//      cards, MonoRows for the on-chain evidence inside each)
//   3. What's live vs not-yet-live (two plain lists, closing with the
//      near-verbatim framing the task specifies)
// plus the established "Run this on your machine" footer.
// ---------------------------------------------------------------------------

const HAPPY_PATH_STEP = BOND_SEQUENCE[3]; // register_settlement — cited by step 2 as the happy-path reference
const DISPUTE_STEP = BOND_SEQUENCE[4]; // file_dispute
const FINALIZE_STEP = BOND_SEQUENCE[5]; // finalize (slash)
const DEPOSIT_STEP = BOND_SEQUENCE[1]; // deposit

type FlowStep = {
  id: string;
  title: string;
  tagline: string;
  body: React.ReactNode;
};

const FLOW_STEPS: FlowStep[] = [
  {
    id: "deposit",
    title: "1. Seller deposits a bond",
    tagline: "Real USDC, locked in the contract, before any dispute exists to protect.",
    body: (
      <>
        <p className="lp-lead" style={{ fontSize: "0.9rem" }}>
          A seller who wants to offer dispute standing calls <code>deposit</code> on the bond-escrow
          contract, locking real testnet USDC against their resource key. This is what a buyer&apos;s
          later dispute can actually slash — no bond, no standing.
        </p>
        <MonoRows>
          <MonoRow label="contract (testnet)" value={truncateMiddle(BOND_ESCROW_CONTRACT_ID, 10, 6)} />
          <MonoRow label="entry point" value="deposit" />
          <MonoRow label="proven tx" value={truncateMiddle(DEPOSIT_STEP.txHash, 10, 6)} />
          <MonoRow label="result" value={DEPOSIT_STEP.summary} tone="ok" />
        </MonoRows>
        <div className="lp-cta-row" style={{ marginTop: "var(--lp-sp-3)" }}>
          <a className="lp-btn lp-btn--outline lp-btn--sm" href={STELLAR_EXPERT_TESTNET_CONTRACT_URL} target="_blank" rel="noreferrer">
            View contract on Stellar Expert ↗
          </a>
          <a className="lp-btn lp-btn--ghost lp-btn--sm" href={stellarExpertTestnetTxUrl(DEPOSIT_STEP.txHash)} target="_blank" rel="noreferrer">
            View this deposit tx ↗
          </a>
        </div>
      </>
    ),
  },
  {
    id: "payment",
    title: "2. Buyer makes a payment",
    tagline: "Settlement is registered on-chain by the facilitator — synchronously, before /settle reports success.",
    body: (
      <>
        <p className="lp-lead" style={{ fontSize: "0.9rem" }}>
          When a buyer pays a bonded seller through x402, the facilitator calls{" "}
          <code>register_settlement</code> on the bond-escrow contract as part of handling{" "}
          <code>POST /settle</code> — this is what gives the buyer standing to dispute later. The gating
          condition, exactly as wired: <code>if (bondEscrow &amp;&amp; result.success === true)</code>, awaited{" "}
          <em>before</em> <code>/settle</code> reports success back to the buyer. If bonding is configured
          and registration fails, the whole settle call returns <code>503 bond_registration_unavailable</code>{" "}
          rather than silently succeeding without giving the payer dispute standing.
        </p>
        <p className="lp-lead" style={{ fontSize: "0.85rem" }}>
          The call is signed by a dedicated admin key (<code>BOND_ESCROW_ADMIN_SECRET_KEY</code>) —
          structurally never the facilitator&apos;s payment-sponsor key. There is no code path in{" "}
          <code>src/bond.ts</code> that even reads the sponsor key.
        </p>
        <MonoRows>
          <MonoRow label="entry point" value="register_settlement" />
          <MonoRow label="signer" value="dedicated admin key (never sponsor key)" />
          <MonoRow label="wiring" value="PR #75, merged to main" tone="ok" />
          <MonoRow label="proven tx" value={truncateMiddle(HAPPY_PATH_STEP.txHash, 10, 6)} />
          <MonoRow label="result" value={HAPPY_PATH_STEP.summary} tone="ok" />
        </MonoRows>
        <div className="lp-cta-row" style={{ marginTop: "var(--lp-sp-3)" }}>
          <a className="lp-btn lp-btn--ghost lp-btn--sm" href={stellarExpertTestnetTxUrl(HAPPY_PATH_STEP.txHash)} target="_blank" rel="noreferrer">
            View this registration tx ↗
          </a>
        </div>
      </>
    ),
  },
  {
    id: "delivery",
    title: "3. Seller delivers and produces a signed receipt",
    tagline: "The seller's delivery-signing key, registered up front, is what makes a later receipt checkable.",
    body: (
      <>
        <p className="lp-lead" style={{ fontSize: "0.9rem" }}>
          Before any of this matters, the seller registers a delivery-signing public key with{" "}
          <code>set_delivery_key</code>. When they deliver the resource, they can sign a receipt with that
          key — proof, checkable by anyone, that delivery happened. Posting that receipt on-chain (
          <code>post_receipt</code>) is one of the entry points the contract exposes but no HTTP relay wires
          up yet (see Part 3 below) — today a seller would call it directly via CLI/SDK.
        </p>
        <MonoRows>
          <MonoRow label="entry point" value="set_delivery_key" />
          <MonoRow label="proven tx" value={truncateMiddle(BOND_SEQUENCE[2].txHash, 10, 6)} />
          <MonoRow label="result" value={BOND_SEQUENCE[2].summary} tone="ok" />
        </MonoRows>
      </>
    ),
  },
  {
    id: "happy-path",
    title: "4a. Happy path — seller withdraws after the window",
    tagline: "No dispute filed before the claim deadline: the seller can withdraw the bond.",
    body: (
      <>
        <p className="lp-lead" style={{ fontSize: "0.9rem" }}>
          Every <code>register_settlement</code> call sets a <code>claim_deadline</code> on that
          settlement. If no dispute is filed before that deadline elapses, the seller can call{" "}
          <code>withdraw</code> and reclaim their bond — the buyer&apos;s window to dispute has simply
          passed with nothing filed.
        </p>
        <p className="lp-lead" style={{ fontSize: "0.85rem" }}>
          <strong>The response window on this testnet deployment is 5 minutes</strong> —{" "}
          <code>PLACEHOLDER_RESPONSE_WINDOW_SECONDS</code> in{" "}
          <code>contracts/bond-escrow/src/lib.rs:235</code>, an explicit placeholder, not 24 hours. The
          design reasoning argues for something closer to 24h before any real/pubnet use; 5 minutes was
          chosen deliberately so the full lifecycle below could be exercised in real ledger time during
          testing.
        </p>
        <MonoRows>
          <MonoRow label="entry point" value="withdraw" />
          <MonoRow label="response window (this deployment)" value="5 minutes" tone="bad" />
          <MonoRow label="response window (design target)" value="~24 hours (not yet set)" />
        </MonoRows>
      </>
    ),
  },
  {
    id: "dispute-path",
    title: "4b. Dispute path — the bond is slashed",
    tagline: "Buyer files a dispute with receipt-or-absence proof; the window elapses; the bond is slashed.",
    body: (
      <>
        <p className="lp-lead" style={{ fontSize: "0.9rem" }}>
          If the buyer believes delivery failed (or never happened), they call <code>file_dispute</code>{" "}
          against the registered settlement. If the seller doesn&apos;t produce a valid receipt before the
          claim deadline, anyone can call <code>finalize</code> once the window elapses — the contract
          slashes the bond and pays the buyer.
        </p>
        <p className="lp-lead" style={{ fontSize: "0.85rem" }}>
          This exact sequence has genuinely happened on this deployed contract: a dispute was filed, a real
          ~5m30s wait elapsed on the actual network clock with no receipt posted, and{" "}
          <code>finalize</code> executed a real SEP-41 transfer slashing 0.025 USDC from the bond to the
          payer.
        </p>
        <MonoRows>
          <MonoRow label="entry point" value="file_dispute" />
          <MonoRow label="proven tx" value={truncateMiddle(DISPUTE_STEP.txHash, 10, 6)} />
          <MonoRow label="result" value={DISPUTE_STEP.summary} tone="ok" />
        </MonoRows>
        <MonoRows>
          <MonoRow label="entry point" value="finalize" />
          <MonoRow label="proven tx" value={truncateMiddle(FINALIZE_STEP.txHash, 10, 6)} />
          <MonoRow label="result" value={FINALIZE_STEP.summary} tone="bad" />
        </MonoRows>
        <div className="lp-cta-row" style={{ marginTop: "var(--lp-sp-3)" }}>
          <a className="lp-btn lp-btn--ghost lp-btn--sm" href={stellarExpertTestnetTxUrl(DISPUTE_STEP.txHash)} target="_blank" rel="noreferrer">
            View dispute tx ↗
          </a>
          <a className="lp-btn lp-btn--ghost lp-btn--sm" href={stellarExpertTestnetTxUrl(FINALIZE_STEP.txHash)} target="_blank" rel="noreferrer">
            View finalize (slash) tx ↗
          </a>
        </div>
      </>
    ),
  },
];

/** Frame accent per step — lime/sun alternate for the routine setup/happy-
 *  path steps (deposit, payment, delivery, happy-path withdraw), and the
 *  dispute step gets coral: this system already treats coral as the
 *  risk/error accent (see landing.css's header contrast notes), and
 *  "dispute-path" is literally the step where the bond gets slashed — the
 *  one moment on this page that IS a risk/danger event, so it earns the
 *  one color the other four steps deliberately don't use. */
function flowStepColor(id: string, index: number): "lime" | "sun" | "coral" {
  if (id === "dispute-path") return "coral";
  return index % 2 === 0 ? "lime" : "sun";
}

/** One clickable flow step: Frame-wrapped .lp-dpanel card, <details>-based
 *  expand for the plain-English explanation — reuses the established
 *  .lp-fitem disclosure pattern (FAQ-style, not the dark-panel --raw
 *  variant, since these cards sit on the light content background). */
function FlowStepCard({ step, index }: { step: FlowStep; index: number }) {
  return (
    <Frame color={flowStepColor(step.id, index)}>
      <div className="lp-dpanel" id={step.id}>
        <details className="lp-fitem">
          <summary>
            <span>
              <div style={{ fontWeight: 700 }}>{step.title}</div>
              <div className="lp-lead" style={{ fontSize: "0.8125rem", fontWeight: 400, marginTop: "4px" }}>
                {step.tagline}
              </div>
            </span>
            <span className="pm" aria-hidden>
              +
            </span>
          </summary>
          <div className="body" style={{ maxWidth: "none" }}>
            {step.body}
          </div>
        </details>
      </div>
    </Frame>
  );
}

// ---------------------------------------------------------------------------
// Footer — "Run this on your machine", same established pattern as the
// other stations' own footers (a copy-pasteable CLI command inside
// .lp-trace-panel with a Copy button). Sibling to QuestRunOnYourMachine /
// RunOnYourMachine, not a variant of either.
// ---------------------------------------------------------------------------

async function copyToClipboard(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Best-effort, same as every other copy affordance in this app.
  }
}

function BondRunOnYourMachine() {
  const [copied, setCopied] = useState(false);

  // payment_id is a BytesN<32>, hex-encoded — same 32-byte/64-hex-char shape
  // src/bond.ts's registerSettlement requires for `paymentId`. This uses the
  // real register_settlement tx's own hash as an ILLUSTRATIVE payment_id —
  // NOT a confirmed match. See the task report: this exact value was
  // invoke-tested live against the deployed contract during this build and
  // returned `null` (no record), because the deployment's live sequence was
  // run via direct CLI before any facilitator wiring existed, so its real
  // payment_id was never recorded anywhere public. The command below is
  // genuinely correct, runnable syntax against the real deployed contract —
  // only the specific payment_id is a plausible example, not a proven hit.
  const snippet = [
    "# Read a SettlementRecord directly from the deployed bond-escrow contract.",
    "# payment_id is 32 bytes, hex-encoded (64 hex chars) — same shape",
    "# src/bond.ts's registerSettlement expects. The value below is the real",
    "# register_settlement call's own tx hash, used illustratively: this",
    "# specific one was tested against the live contract and returned no",
    "# record (that proven sequence was run by direct CLI before any",
    "# payment ever produced a payment_id through the facilitator itself).",
    "# Swap in a payment_id from your own registered settlement to see it.",
    "stellar contract invoke \\",
    `  --id ${BOND_ESCROW_CONTRACT_ID} \\`,
    "  --source-account <any funded testnet account, read-only call> \\",
    "  --rpc-url https://soroban-testnet.stellar.org \\",
    '  --network-passphrase "Test SDF Network ; September 2015" \\',
    "  --send=no \\",
    "  -- get_settlement \\",
    `  --payment_id ${HAPPY_PATH_STEP.txHash}`,
  ].join("\n");

  return (
    <div style={{ marginTop: "var(--lp-sp-8)" }}>
      <Eyebrow>Run this on your machine</Eyebrow>
      <p className="lp-lead" style={{ marginTop: "var(--lp-sp-4)", fontSize: "0.9rem" }}>
        Reads a <code>SettlementRecord</code> straight from the deployed contract — no facilitator, no
        session, just a public read against Stellar testnet.
      </p>
      <div className="lp-trace-panel" style={{ marginTop: "var(--lp-sp-4)" }}>
        <div className="head">
          <span>stellar contract invoke</span>
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
// Part tabs — real tabs (one part visible at a time), not the scroll-spy
// jump-nav this used to be. The nav bar visually presents as tabs (pill
// buttons, an "active" highlight) but previously just scrolled to an anchor
// while every part stayed rendered continuously — which put the nav BELOW
// the very first part it linked to ("The problem" content, then a nav bar
// whose first item is also "The problem", pointing back up at what the
// visitor just read) and never actually shortened the page. Real tabs fix
// both: the bar sits above all content, and only the active part renders.
// ---------------------------------------------------------------------------

const BOND_PARTS = [
  { id: "bond-part-1", label: "The problem" },
  { id: "bond-part-2", label: "How it works" },
  { id: "bond-part-3", label: "What's live" },
] as const;

type BondPartId = (typeof BOND_PARTS)[number]["id"];

function BondTabs({ activeId, onSelect }: { activeId: BondPartId; onSelect: (id: BondPartId) => void }) {
  return (
    <nav className="lp-stationnav" role="tablist" aria-label="Bond system">
      {BOND_PARTS.map((part) => (
        <button
          key={part.id}
          type="button"
          role="tab"
          id={`tab-${part.id}`}
          aria-selected={part.id === activeId}
          aria-controls={part.id}
          className={cx(part.id === activeId && "active")}
          onClick={() => onSelect(part.id)}
        >
          {part.label}
        </button>
      ))}
    </nav>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function BondPage() {
  const [activeId, setActiveId] = useState<BondPartId>("bond-part-1");

  return (
    <>
      <div className="lp-content-head">
        <Eyebrow>Provider bond system</Eyebrow>
        <h1>x402 settles before delivery is confirmed. This closes that gap.</h1>
      </div>

      <BondTabs activeId={activeId} onSelect={setActiveId} />

      <section
        id="bond-part-1"
        role="tabpanel"
        aria-labelledby="tab-bond-part-1"
        hidden={activeId !== "bond-part-1"}
        style={{ marginTop: "var(--lp-sp-4)" }}
      >
        <Eyebrow>The problem</Eyebrow>
        <p className="lp-lead" style={{ marginTop: "var(--lp-sp-3)" }}>
          A plain x402 payment settles the moment the facilitator verifies it — before the buyer has any
          way to know whether the seller actually delivered. If a provider takes payment and returns
          garbage, the settlement already happened, with no on-chain recourse. Nobody has solved this on
          Stellar yet. <code>x402r</code> exists for exactly this problem on EVM and Solana, but not here.
          Vellar&apos;s bond system is the gap it closes: a seller posts a bond, a buyer&apos;s settlement
          registers standing to dispute, and a bad delivery can be slashed on-chain instead of just
          disputed in someone&apos;s inbox.
        </p>
      </section>

      <section
        id="bond-part-2"
        role="tabpanel"
        aria-labelledby="tab-bond-part-2"
        hidden={activeId !== "bond-part-2"}
        style={{ marginTop: "var(--lp-sp-4)" }}
      >
        <Eyebrow>How it works</Eyebrow>
        <p className="lp-lead" style={{ marginTop: "var(--lp-sp-3)", marginBottom: "var(--lp-sp-6)" }}>
          Click any step to expand what actually happens on-chain, with the real proven transaction for
          each — this isn&apos;t a design description, it&apos;s a sequence that has genuinely run on
          Stellar testnet.
        </p>
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--lp-sp-6)" }}>
          {FLOW_STEPS.map((step, i) => (
            <FlowStepCard key={step.id} step={step} index={i} />
          ))}
        </div>
      </section>

      <section
        id="bond-part-3"
        role="tabpanel"
        aria-labelledby="tab-bond-part-3"
        hidden={activeId !== "bond-part-3"}
        style={{ marginTop: "var(--lp-sp-4)" }}
      >
        <Eyebrow>What&apos;s live today vs what&apos;s coming</Eyebrow>

        <div className="lp-dgrid lp-dgrid--wide" style={{ marginTop: "var(--lp-sp-6)" }}>
          <div className="lp-dpanel lp-dpanel--sun">
            <div className="lp-dpanel-head">
              <h2 style={{ fontSize: "var(--lp-fs-h4)" }}>Live today</h2>
            </div>
            <ul style={{ display: "flex", flexDirection: "column", gap: "var(--lp-sp-3)", paddingLeft: "1.1em" }}>
              <li className="lp-lead" style={{ fontSize: "0.9rem" }}>
                Bond escrow contract deployed on Stellar testnet —{" "}
                <a href={STELLAR_EXPERT_TESTNET_CONTRACT_URL} target="_blank" rel="noreferrer">
                  {truncateMiddle(BOND_ESCROW_CONTRACT_ID, 10, 6)} on Stellar Expert ↗
                </a>
              </li>
              <li className="lp-lead" style={{ fontSize: "0.9rem" }}>
                <code>register_settlement</code> wired into <code>POST /settle</code> (PR #75, merged) —
                gated on <code>bondEscrow &amp;&amp; result.success === true</code>, synchronous and
                awaited before <code>/settle</code> reports success
              </li>
              <li className="lp-lead" style={{ fontSize: "0.9rem" }}>
                Full sequence proven: deposit → register → dispute → finalize, all Horizon-confirmed (see
                each step above for the real tx links)
              </li>
              <li className="lp-lead" style={{ fontSize: "0.9rem" }}>
                Design document covering every decision —{" "}
                <code>docs/proposal-provider-bond.md</code>, 7 sections, locked
              </li>
            </ul>
          </div>

          <div className="lp-dpanel lp-dpanel--dark lp-dpanel--dark-lime">
            <div className="lp-dpanel-head">
              <h2 style={{ fontSize: "var(--lp-fs-h4)" }}>Not yet live</h2>
            </div>
            <ul style={{ display: "flex", flexDirection: "column", gap: "var(--lp-sp-3)", paddingLeft: "1.1em" }}>
              <li className="lp-lead" style={{ fontSize: "0.9rem" }}>
                <strong>
                  <code>BOND_ESCROW_CONTRACT_ID</code> is not configured on the hosted facilitator
                </strong>{" "}
                (<code>vellar-facilitator.onrender.com</code>) that this playground talks to. The wiring is
                real, merged, and correct in the code — but it is not currently active on the shared
                instance.
              </li>
              <li className="lp-lead" style={{ fontSize: "0.9rem" }}>
                HTTP relay routes for dispute / receipt / withdraw — the contract&apos;s other entry points
                (<code>deposit</code>, <code>withdraw</code>, <code>file_dispute</code>,{" "}
                <code>set_delivery_key</code>, <code>post_receipt</code>, <code>finalize</code>) are
                callable only via direct Soroban CLI/SDK today, not through any facilitator HTTP route.
              </li>
              <li className="lp-lead" style={{ fontSize: "0.9rem" }}>
                A seller deposit UI — none exists anywhere yet.
              </li>
              <li className="lp-lead" style={{ fontSize: "0.9rem" }}>
                A <code>bonded_only</code> filter in the Bazaar catalog/discovery API.
              </li>
              <li className="lp-lead" style={{ fontSize: "0.9rem" }}>
                A <code>vellar-sdk</code> receipt-signing helper.
              </li>
            </ul>
          </div>
        </div>

        <p className="lp-lead" style={{ marginTop: "var(--lp-sp-6)", fontStyle: "italic" }}>
          The contract is deployed and the payment path is wired. The full dispute flow requires the seller
          and buyer to interact with the contract directly via CLI today. The HTTP relay routes that make
          this seamless are next.
        </p>
      </section>

      <BondRunOnYourMachine />
    </>
  );
}
