"use client";

// ---------------------------------------------------------------------------
// /break/catalog — "Poison catalog" (the other half of formerly Station 3's
// attack bench, inline on "/"). Split into its own always-reachable route as
// part of the rail402-style sidebar restructure — see dashboard-shell.tsx's
// NAV_GROUPS doc comment. See /break/payments for the payment-attack half.
//
// The prompt-injection sanitizer demo (attack 8) lives HERE, not on
// /break/payments — it's about a crafted CATALOG description getting
// sanitized before cataloging, not about a payment, and (like both catalog
// attacks) needs no session at all.
// ---------------------------------------------------------------------------

import { useState } from "react";
import { Eyebrow, LpActionButton, MonoRow, MonoRows } from "../../../design/ui";
import { truncateMiddle } from "@/lib/format";
import { FACILITATOR_URL, SELLER_URL } from "@/lib/config";
import { writeAttackResult, type StoredAttackResult } from "@/lib/local-storage";
import { useElapsedSeconds } from "@/lib/use-elapsed-seconds";

type AttackBenchStatus = "pending" | "active" | "done" | "error";

interface AttackBenchEntry {
  status: AttackBenchStatus;
  result?: StoredAttackResult;
  message?: string;
}

const CATALOG_ATTACK_IDS = ["ssrf_linklocal", "displace_verified"] as const;
type CatalogAttackId = (typeof CATALOG_ATTACK_IDS)[number];

const CATALOG_ATTACK_LABELS: Record<CatalogAttackId, string> = {
  ssrf_linklocal: "Point at a blocked internal address",
  displace_verified: "Displace an already-verified binding",
};

function initialCatalogAttackMap(): Record<CatalogAttackId, AttackBenchEntry> {
  const pending: AttackBenchEntry = { status: "pending" };
  return { ssrf_linklocal: { ...pending }, displace_verified: { ...pending } };
}

type CatalogAttackMap = Record<CatalogAttackId, AttackBenchEntry>;

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

const ATTACK_LIVE_NOTES: Record<CatalogAttackId, string> = {
  ssrf_linklocal:
    "Live data, illustrative framing — real /health and /discovery/resources reads from the real hosted facilitator, showing ALREADY-cataloged localhost entries that are structurally unverifiable for the same isBlockedAddress guard family a 169.254.169.254 metadata-IP attempt would hit. Not a live attempt to reach cloud metadata infrastructure — that would be the exact SSRF this control exists to prevent.",
  displace_verified:
    "Live data, illustrative framing — two real, time-separated /discovery/resources polls of the demo resource, showing its verified binding is unchanged. Not a live attacker attempt (not cleanly constructible against shared infrastructure without a second seller identity) — this demonstrates the same permanence property by observing it hold under real, ongoing legitimate use.",
};

const SANITIZE_LIVE_NOTE =
  "Not a live round-trip. This runs a faithful local port of the facilitator's real sanitizeDescription() (vellar-facilitator/src/catalog.ts) against whatever you type below — live, in this process, with no network call to the facilitator at all. Cataloging a new resource with a crafted description isn't triggerable from this playground without controlling an independent seller identity.";

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

interface SanitizeDemoState {
  status: "idle" | "loading" | "done" | "error";
  input: string;
  result?: StoredAttackResult;
  message?: string;
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function BreakCatalogPage() {
  const [catalogAttacks, setCatalogAttacks] = useState<CatalogAttackStage>({ status: "idle" });
  const catalogAttacksElapsed = useElapsedSeconds(catalogAttacks.status === "running" ? catalogAttacks.startedAt : null);
  const [sanitizeDemo, setSanitizeDemo] = useState<SanitizeDemoState>({ status: "idle", input: "" });
  const [sanitizeInput, setSanitizeInput] = useState("");

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
        return { ...prev, attacks: { ...prev.attacks, [attackId]: { status: "error", message: event.message } } };
      }
      return prev;
    }

    try {
      const res = await fetch("/api/attack/catalog", { method: "POST" });
      if (!res.ok || !res.body) {
        setCatalogAttacks((prev) => ({ status: "error", message: "We couldn't reach the server. Please try again.", attacks: prev.status === "running" ? prev.attacks : attacks }));
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
        setCatalogAttacks((prev) => ({ status: "error", message, attacks: prev.status === "running" ? prev.attacks : attacks }));
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
        setCatalogAttacks((prev) => ({ status: "error", message: "The connection ended before the attack bench finished. Please try again.", attacks: prev.status === "running" ? prev.attacks : attacks }));
      }
    } catch {
      setCatalogAttacks((prev) => ({ status: "error", message: "We couldn't reach the server. Please check your connection and try again.", attacks: prev.status === "running" ? prev.attacks : attacks }));
    }
  }

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
        setSanitizeDemo({ status: "error", input, message: typeof body?.message === "string" ? body.message : "Something went wrong. Please try again." });
        return;
      }
      const result = body as StoredAttackResult;
      writeAttackResult(result);
      setSanitizeDemo({ status: "done", input, result });
    } catch {
      setSanitizeDemo({ status: "error", input, message: "We couldn't reach the server. Please check your connection and try again." });
    }
  }

  const catalogMap = catalogAttacks.status === "running" || catalogAttacks.status === "done" || catalogAttacks.status === "error" ? catalogAttacks.attacks : initialCatalogAttackMap();

  return (
    <>
      <div className="lp-content-head">
        <Eyebrow>Poison catalog</Eyebrow>
        <h1>
          Break it. <em>Watch it refuse to break.</em>
        </h1>
        <p className="lp-lead">
          Three deliberate attacks against the public catalog — no session needed. Mint means the
          facilitator refused for the right reason (a pass for the defense); coral means something
          unexpected happened.
        </p>
      </div>

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
            <LpActionButton variant="sun" onClick={runCatalogAttacks}>
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
                Polling... ({catalogAttacksElapsed}s)
              </p>
            )}
            {catalogAttacks.status === "error" && (
              <div style={{ marginTop: "var(--lp-sp-4)" }}>
                <p className="lp-lead">{catalogAttacks.message}</p>
                <div className="lp-cta-row">
                  <LpActionButton variant="outline" size="sm" onClick={runCatalogAttacks}>
                    Try again
                  </LpActionButton>
                </div>
              </div>
            )}
            {catalogAttacks.status === "done" && (
              <div className="lp-cta-row" style={{ marginTop: "var(--lp-sp-4)" }}>
                <LpActionButton variant="outline" size="sm" onClick={runCatalogAttacks}>
                  Run again
                </LpActionButton>
              </div>
            )}
          </>
        )}
      </div>

      <div className="lp-dpanel lp-dpanel--dark lp-dpanel--dark-coral" style={{ marginTop: "var(--lp-sp-6)" }}>
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
          <LpActionButton variant="sun" size="sm" onClick={() => runSanitizeDemo(sanitizeInput)} disabled={sanitizeDemo.status === "loading"}>
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
              <MonoRow label="sanitized length" value={String((sanitizeDemo.result.rawResponse as { sanitizedLength?: number })?.sanitizedLength ?? "—")} />
              <MonoRow label="stripped chars" value={String((sanitizeDemo.result.rawResponse as { strippedCharCount?: number })?.strippedCharCount ?? "—")} />
              <MonoRow label="truncated to 256" value={String((sanitizeDemo.result.rawResponse as { truncated?: boolean })?.truncated ?? "—")} />
              <MonoRow label="sanitized output" value={truncateMiddle(String((sanitizeDemo.result.rawResponse as { sanitized?: string })?.sanitized ?? ""), 40, 10)} />
            </MonoRows>
          </div>
        )}
      </div>
    </>
  );
}
