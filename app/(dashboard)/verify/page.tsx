"use client";

// ---------------------------------------------------------------------------
// /verify — "Ownership verification" (formerly Station 2, inline on "/").
// Split into its own always-reachable route as part of the rail402-style
// sidebar restructure — see dashboard-shell.tsx's NAV_GROUPS doc comment.
//
// This station is public/read-only end to end — no session, no wallet
// required to use it (unlike /pay and /break/payments) — so it fetches its
// own small slice of catalog data directly rather than depending on
// anything /pay loaded, and doesn't gate on useWallet() at all.
// ---------------------------------------------------------------------------

import { useEffect, useMemo, useState } from "react";
import { Eyebrow, LpActionButton, MonoRow, MonoRows } from "../../design/ui";
import { formatAtomicAmount, truncateMiddle } from "@/lib/format";
import { useElapsedSeconds } from "@/lib/use-elapsed-seconds";
import {
  DEFAULT_VERIFY_ID,
  VERIFIABLE_RESOURCES,
  verifiableResourceCatalogUrl,
  verifiableResourceUrl,
  type VerifiableResource,
} from "@/lib/verifiable-resources";

interface CatalogItem {
  resource: string;
  description?: string;
  accepts?: Array<{ amount?: string; asset?: string; payTo?: string; network?: string }>;
  trust?: { ownerVerified?: boolean; ownershipState?: string; verification?: string };
}

type CatalogStage = { status: "idle" } | { status: "loading" } | { status: "ready"; items: CatalogItem[] } | { status: "error" };

type OwnershipStepName = "fetch_challenge" | "decode_header" | "parse_pay_to" | "compare_catalog" | "verdict";
type OwnershipStepStatus = "pending" | "active" | "done" | "error";

const OWNERSHIP_STEP_ORDER: OwnershipStepName[] = ["fetch_challenge", "decode_header", "parse_pay_to", "compare_catalog", "verdict"];
const OWNERSHIP_STEP_LABELS: Record<OwnershipStepName, string> = {
  fetch_challenge: "Fetching the seller's 402 challenge",
  decode_header: "Reading the PAYMENT-REQUIRED header",
  parse_pay_to: "Parsing the payTo from the challenge",
  compare_catalog: "Comparing against the bound address from the catalog",
  verdict: "Verdict",
};

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
  // From the route directly, not inferred from verdictText's wording — see
  // that field's own doc comment in route.ts on why: rendering a payTo
  // match on a still-unverified resource identically to a durably-verified
  // one is exactly what read as "it says verified" to a visitor before
  // this existed, even though the wording itself was hedged.
  alreadyVerified: boolean;
  verdictText: string;
  challengePayTos: string[];
  boundPayTos: string[];
}

type OwnershipStage =
  | { status: "idle" }
  // wakingUp: true once a "waking_up" event has been seen this run — the
  // demo seller can be cold-started on Render's free tier, same signal
  // /pay's ledger already surfaces for the identical situation. Cleared on
  // the next "checking" (a fresh run starts clean).
  | { status: "checking"; startedAt: number; steps: OwnershipStepMap; wakingUp: boolean }
  | { status: "success"; result: OwnershipVerdictResult; steps: OwnershipStepMap }
  | { status: "error"; message: string; steps: OwnershipStepMap };

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

function trustLabel(trust?: CatalogItem["trust"]): { text: string; verified: boolean } {
  if (!trust) return { text: "Unknown", verified: false };
  if (trust.ownerVerified === true) return { text: "Verified", verified: true };
  const state = trust.ownershipState || trust.verification;
  if (state === "unverified") return { text: "Unverified", verified: false };
  return { text: "Unknown", verified: false };
}

async function copyToClipboard(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Convenience affordance, not a critical path — fail silently.
  }
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function VerifyPage() {
  const [catalog, setCatalog] = useState<CatalogStage>({ status: "idle" });
  const [ownership, setOwnership] = useState<OwnershipStage>({ status: "idle" });
  const [selectedId, setSelectedId] = useState<string>(DEFAULT_VERIFY_ID);
  const ownershipElapsed = useElapsedSeconds(ownership.status === "checking" ? ownership.startedAt : null);

  const selectedResource: VerifiableResource = useMemo(
    () => VERIFIABLE_RESOURCES.find((r) => r.id === selectedId) ?? VERIFIABLE_RESOURCES[0],
    [selectedId],
  );

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setCatalog({ status: "loading" });
      try {
        const res = await fetch("/api/catalog");
        const body = await res.json();
        if (cancelled) return;
        if (!res.ok) {
          setCatalog({ status: "error" });
          return;
        }
        const items: CatalogItem[] = Array.isArray(body?.items) ? body.items : [];
        setCatalog({ status: "ready", items });
      } catch {
        if (!cancelled) setCatalog({ status: "error" });
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  async function runVerifyOwnership() {
    const steps = initialOwnershipSteps();
    setOwnership({ status: "checking", startedAt: Date.now(), steps: { ...steps }, wakingUp: false });

    function applyEvent(prev: OwnershipStage, event: OwnershipEvent): OwnershipStage {
      if (prev.status !== "checking") return prev;
      if (event.step === "waking_up") {
        return { ...prev, wakingUp: true };
      }
      if (!OWNERSHIP_STEP_ORDER.includes(event.step as OwnershipStepName)) return prev;
      const stepName = event.step as OwnershipStepName;
      const status = event.status;
      if (status !== "active" && status !== "done" && status !== "error") return prev;
      // A "done"/"error" on fetch_challenge clears any "waking up" framing
      // — the seller has genuinely responded by then, same convention
      // /pay's ledger uses for its own get_request step.
      const clearsWakingUp = stepName === "fetch_challenge" && status !== "active";
      return {
        ...prev,
        wakingUp: clearsWakingUp ? false : prev.wakingUp,
        steps: {
          ...prev.steps,
          [stepName]: { status: status as OwnershipStepStatus, event, message: typeof event.message === "string" ? event.message : undefined },
        },
      };
    }

    try {
      const res = await fetch("/api/verify-ownership", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: selectedResource.id }),
      });
      if (!res.ok || !res.body) {
        setOwnership((prev) => ({ status: "error", message: "We couldn't reach the server. Please try again.", steps: prev.status === "checking" ? prev.steps : steps }));
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let settled = false;

      const finish = (event: OwnershipEvent) => {
        settled = true;
        if (event.status === "done") {
          setOwnership((prev) => {
            if (prev.status !== "checking") return prev;
            const verdictEvent = prev.steps.verdict.event;
            if (verdictEvent && typeof verdictEvent.match === "boolean" && typeof verdictEvent.verdictText === "string") {
              const result: OwnershipVerdictResult = {
                match: verdictEvent.match,
                alreadyVerified: verdictEvent.alreadyVerified === true,
                verdictText: verdictEvent.verdictText,
                challengePayTos: Array.isArray(verdictEvent.challengePayTos) ? (verdictEvent.challengePayTos as string[]) : [],
                boundPayTos: Array.isArray(verdictEvent.boundPayTos) ? (verdictEvent.boundPayTos as string[]) : [],
              };
              return { status: "success", result, steps: prev.steps };
            }
            return { status: "error", message: "The verification stream ended without a clear verdict. Please try again.", steps: prev.steps };
          });
          return;
        }
        const message = typeof event.message === "string" ? event.message : "Verification failed. Please try again.";
        setOwnership((prev) => ({ status: "error", message, steps: prev.status === "checking" ? prev.steps : steps }));
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
      if (trailing?.step === "complete") finish(trailing);

      if (!settled) {
        setOwnership((prev) => ({ status: "error", message: "The connection ended before verification finished. Please try again.", steps: prev.status === "checking" ? prev.steps : steps }));
      }
    } catch {
      setOwnership((prev) => ({ status: "error", message: "We couldn't reach the server. Please check your connection and try again.", steps: prev.status === "checking" ? prev.steps : steps }));
    }
  }

  // Every VERIFIABLE_RESOURCES entry, joined against whatever /api/catalog
  // actually returned — looked up by verifiableResourceCatalogUrl() so
  // /inspect's literal ":address" catalog listing resolves correctly (see
  // that helper's own doc comment in lib/verifiable-resources.ts).
  const catalogItemsByUrl = useMemo(() => {
    const map = new Map<string, CatalogItem>();
    if (catalog.status === "ready") {
      for (const item of catalog.items) map.set(item.resource, item);
    }
    return map;
  }, [catalog]);

  const demoItem = catalogItemsByUrl.get(verifiableResourceCatalogUrl(selectedResource));
  const trust = trustLabel(demoItem?.trust);
  const accept = demoItem?.accepts?.[0];
  const boundPayTo = accept?.payTo;
  const lastSettled = demoItem?.trust && "lastSettled" in demoItem.trust ? (demoItem.trust as { lastSettled?: string }).lastSettled : undefined;
  const settlements = demoItem?.trust && "settlements" in demoItem.trust ? (demoItem.trust as { settlements?: number }).settlements : undefined;

  const steps = ownership.status === "checking" || ownership.status === "success" || ownership.status === "error" ? ownership.steps : initialOwnershipSteps();

  function selectResource(id: string) {
    if (id === selectedId) return;
    setSelectedId(id);
    // A stale in-flight/finished run against the PREVIOUS resource reading
    // as this one's result would be actively misleading — clear it back to
    // idle so "Verify now" always reflects the currently selected resource.
    setOwnership({ status: "idle" });
  }

  return (
    <>
      <div className="lp-content-head">
        <Eyebrow>Ownership verification</Eyebrow>
        <h1>
          Once proven, <em>it can&apos;t be taken back.</em>
        </h1>
        <p className="lp-lead">
          The facilitator&apos;s differentiator: a resource&apos;s ownership binding, once proven by a real
          settlement, is a permanent latch — not a badge that can flip back off. Once proven, a later
          settlement from a different address can&apos;t displace it.
        </p>
      </div>

      <div className="lp-dpanel lp-dpanel--mint" style={{ marginTop: "var(--lp-sp-6)" }}>
        <div className="lp-dpanel-head">
          <h3>Pick a resource to check</h3>
        </div>
        <p className="lp-lead" style={{ fontSize: "0.85rem" }}>
          All {VERIFIABLE_RESOURCES.length} of the demo seller&apos;s own resources — not just one. Each has already
          settled at least once; most are settled-but-not-yet-reverified, since the facilitator only reverifies
          ownership as a fire-and-forget side effect of a fresh settlement (see &quot;Verify now&quot; below for what
          that means for the check you&apos;re about to run).
        </p>
        <div className="lp-rlist" style={{ marginTop: "var(--lp-sp-3)" }}>
          {VERIFIABLE_RESOURCES.map((resource) => {
            const item = catalogItemsByUrl.get(verifiableResourceCatalogUrl(resource));
            const rowTrust = trustLabel(item?.trust);
            const selected = resource.id === selectedId;
            return (
              <button
                key={resource.id}
                type="button"
                className="lp-rrow lp-rrow--pick"
                data-selected={selected || undefined}
                onClick={() => selectResource(resource.id)}
                aria-pressed={selected}
              >
                <span className="ri" aria-hidden />
                <span className="rn">
                  <b>{item?.description || resource.label}</b>
                  <span>{truncateMiddle(verifiableResourceUrl(resource), 34, 12)}</span>
                </span>
                <span className="lp-verified" style={!rowTrust.verified ? { marginLeft: "auto", background: "var(--lp-paper-tint)" } : { marginLeft: "auto" }}>
                  {rowTrust.verified ? "✓ " : ""}
                  {catalog.status === "loading" ? "…" : rowTrust.text}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="lp-dgrid lp-dgrid--wide" style={{ marginTop: "var(--lp-sp-6)" }}>
        <div className="lp-dpanel lp-dpanel--sun">
          <div className="lp-dpanel-head">
            <h3>The catalog entry</h3>
          </div>
          {!demoItem && (
            <p className="lp-lead" style={{ fontSize: "0.9rem" }}>
              {catalog.status === "loading" ? "Loading the catalog..." : "This resource isn't in the catalog yet."}
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
              <span className="lp-verified" style={!trust.verified ? { background: "var(--lp-paper-tint)" } : undefined}>
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

        <div className="lp-dpanel lp-dpanel--dark">
          <div className="lp-dpanel-head">
            <h3>Verify now</h3>
          </div>
          <p className="lp-lead" style={{ fontSize: "0.85rem" }}>
            Checking <b>{selectedResource.label}</b>: the playground performs the same check the facilitator runs —
            fetching this resource&apos;s own 402 challenge and comparing the payTo it names against the bound
            address already on file.
          </p>
          <p className="lp-lead" style={{ fontSize: "0.75rem" }}>
            The real facilitator also pins DNS and blocks private/internal addresses before fetching an arbitrary
            seller URL; this demo check skips that hardening since the resource you can pick above is always one of a
            fixed, known-safe set — never an address you supply.
          </p>

          {ownership.status === "idle" && (
            <div className="lp-cta-row" style={{ marginTop: "var(--lp-sp-4)" }}>
              <LpActionButton variant="sun" onClick={runVerifyOwnership}>
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

              {ownership.status === "checking" && ownership.wakingUp && (
                <p className="lp-lead" style={{ marginTop: "var(--lp-sp-4)", fontSize: "0.85rem" }}>
                  The demo seller looks like it&apos;s waking up from a cold start — this can take up to a
                  minute on testnet. ({ownershipElapsed}s)
                </p>
              )}
              {ownership.status === "checking" && !ownership.wakingUp && (
                <p className="lp-lead" style={{ marginTop: "var(--lp-sp-4)", fontSize: "0.85rem" }}>
                  Checking... ({ownershipElapsed}s)
                </p>
              )}

              {ownership.status === "success" && (
                <div style={{ marginTop: "var(--lp-sp-4)" }}>
                  {/* A visually distinct badge, not just wording, for
                      "matched but still Unverified in the catalog" vs.
                      "durably Verified" — rendering both as one undifferentiated
                      bold paragraph is exactly what made a payTo match on an
                      unverified resource read as "it says verified" (see
                      alreadyVerified's own doc comment above). match=false
                      (a genuine mismatch) gets neither badge — it's an
                      unexpected/error-flavored result, not a trust state. */}
                  {ownership.result.match && (
                    <span
                      className="lp-verified"
                      style={!ownership.result.alreadyVerified ? { background: "var(--lp-paper-tint)" } : undefined}
                    >
                      {ownership.result.alreadyVerified ? "✓ Verified" : "Still Unverified"}
                    </span>
                  )}
                  <p className="lp-lead" style={{ marginTop: "var(--lp-sp-2)" }}>
                    {ownership.result.verdictText}
                  </p>
                  <div className="lp-cta-row">
                    <LpActionButton variant="ghost" size="sm" onClick={runVerifyOwnership}>
                      Run again
                    </LpActionButton>
                  </div>
                </div>
              )}

              {ownership.status === "error" && (
                <div style={{ marginTop: "var(--lp-sp-4)" }}>
                  <p className="lp-lead">{ownership.message}</p>
                  <div className="lp-cta-row">
                    <LpActionButton variant="ghost" size="sm" onClick={runVerifyOwnership}>
                      Try again
                    </LpActionButton>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      <RunVerifyOnYourMachine resource={selectedResource} />
    </>
  );
}

function ownershipStepStatusLabel(step: OwnershipStepState): string {
  if (step.status === "pending") return "Waiting";
  if (step.status === "active") return "In progress";
  if (step.status === "error") return step.message ?? "Failed";
  return "Done";
}

function OwnershipStepRawBytes({ step, stepName }: { step: OwnershipStepState; stepName: OwnershipStepName }) {
  const event = step.event;
  if (!event || step.status === "pending" || step.status === "active") return null;

  let rows: Array<{ label: string; value: string }> = [];
  let note: string | undefined;

  if (stepName === "fetch_challenge" && event.status === "done") {
    rows = [
      { label: "request", value: String(event.requestLine ?? "") },
      { label: "status", value: String(event.responseStatus ?? "") },
      { label: "PAYMENT-REQUIRED (raw, base64)", value: truncateMiddle(String(event.rawPaymentRequiredHeader ?? ""), 28, 10) },
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

function RunVerifyOnYourMachine({ resource }: { resource: VerifiableResource }) {
  const [copiedSnippet, setCopiedSnippet] = useState(false);
  const resourceUrl = verifiableResourceUrl(resource);

  const curlSnippet = [
    `curl -sD - ${resourceUrl} -o /dev/null \\`,
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
