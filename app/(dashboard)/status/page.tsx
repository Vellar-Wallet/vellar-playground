"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Eyebrow, Field, LpActionButton, MonoRow, MonoRows } from "../../design/ui";
import { formatDuration, truncateMiddle } from "@/lib/format";
import { useElapsedSeconds } from "@/lib/use-elapsed-seconds";

// ---------------------------------------------------------------------------
// Types — narrow, defensive parsing of the live shapes documented in this
// step's task (verified by curl against the hosted facilitator):
//
// GET /health   -> { status, service, uptimeSeconds, catalogSize, commit,
//                    reverifyPending, unverifiableEntries }
// GET /supported -> { kinds: [{ x402Version, scheme, network, extra }],
//                     extensions: [...], signers: { [prefix]: string[] } }
// ---------------------------------------------------------------------------

interface HealthBody {
  status?: string;
  service?: string;
  uptimeSeconds?: number;
  catalogSize?: number;
  reverifyPending?: number;
  unverifiableEntries?: number;
  commit?: string;
}

interface SupportedKind {
  x402Version?: number;
  scheme?: string;
  network?: string;
  extra?: Record<string, unknown>;
}

interface SupportedBody {
  kinds?: SupportedKind[];
  extensions?: string[];
  signers?: Record<string, string[]>;
}

type Snapshot = { health: HealthBody; supported: SupportedBody; fetchedAt: number; slow: boolean };

type Stage =
  | { status: "loading"; startedAt: number }
  | { status: "ready"; snapshot: Snapshot }
  | { status: "error"; message: string };

// A fetch that resolves within this window never shows the honest
// "waking up" cold-start treatment — only a fetch slower than this (first
// load or an unlucky refresh) does. Matches the demo page's own cold-start
// framing (app/page.tsx's COLD_START_CEILING_MS is a *timeout* ceiling;
// this is the much shorter "is this slow enough to explain to the user"
// threshold the task spec calls out at 5s).
const SLOW_THRESHOLD_MS = 5_000;
const AUTO_REFRESH_MS = 30_000;

/**
 * Derive a green/amber/red status indicator. The facilitator's /health and
 * /supported responses carry no ready-made tri-state field, so this is
 * derived here, explicitly:
 *   - green: both endpoints responded within SLOW_THRESHOLD_MS AND
 *            health.status === "ok"
 *   - amber: both endpoints responded (any latency) but either the fetch
 *            was slow (hit cold-start territory) OR health.status is
 *            present but not "ok"
 *   - red:   a fetch failed outright (network error / non-2xx / timeout)
 */
function deriveIndicator(
  stage: Stage,
): { tone: "green" | "amber" | "red"; label: string } {
  if (stage.status === "error") return { tone: "red", label: "Unreachable" };
  if (stage.status === "loading") return { tone: "amber", label: "Checking…" };
  const { health, slow } = stage.snapshot;
  const ok = health.status === "ok";
  if (ok && !slow) return { tone: "green", label: "Healthy" };
  if (ok && slow) return { tone: "amber", label: "Healthy (slow response)" };
  return { tone: "amber", label: `Status: ${health.status ?? "unknown"}` };
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  const body = await res.json();
  if (!res.ok) {
    throw new Error(body?.message || `Request to ${url} failed (HTTP ${res.status}).`);
  }
  return body as T;
}

// Sentinel "not started yet" stage — real loading (with a concrete
// `startedAt`) only begins once the mount effect below runs. Keeps
// `Date.now()` out of the render body / useState initializer entirely,
// which the stricter React 19 purity lint (react-hooks/purity) forbids.
const INITIAL_STAGE: Stage = { status: "loading", startedAt: 0 };

export default function StatusPage() {
  const [stage, setStage] = useState<Stage>(INITIAL_STAGE);
  const [now, setNow] = useState<number | null>(null);

  const loadingElapsed = useElapsedSeconds(
    stage.status === "loading" && stage.startedAt > 0 ? stage.startedAt : null,
  );

  const load = useCallback(async (isInitial: boolean) => {
    const startedAt = Date.now();
    if (isInitial) {
      setStage({ status: "loading", startedAt });
    }
    try {
      const [health, supported] = await Promise.all([
        fetchJson<HealthBody>("/api/health"),
        fetchJson<SupportedBody>("/api/supported"),
      ]);
      const fetchedAt = Date.now();
      const slow = fetchedAt - startedAt > SLOW_THRESHOLD_MS;
      setStage({ status: "ready", snapshot: { health, supported, fetchedAt, slow } });
      setNow(fetchedAt);
    } catch (err) {
      setStage({
        status: "error",
        message: err instanceof Error ? err.message : "We couldn't reach the demo facilitator right now.",
      });
    }
  }, []);

  // Initial load — fires once on mount. Guarded by a ref (same pattern as
  // app/page.tsx's `fetchedForWallet`) rather than an unconditional
  // `void load(true)` at the top of the effect body: react-hooks/purity's
  // static analysis can't prove `load`'s synchronous `setStage(...)` call
  // (gated by the `isInitial` *parameter*, not visible to the linter) is
  // safe unless the call site itself is conditional.
  const hasLoadedInitially = useRef(false);
  useEffect(() => {
    if (!hasLoadedInitially.current) {
      hasLoadedInitially.current = true;
      void load(true);
    }
  }, [load]);

  // Auto-refresh every 30s. A refresh reuses the same `load(false)` path so
  // it never resets `stage` to a fresh "loading" state (and never re-shows
  // the cold-start copy) unless that particular refresh is itself slow —
  // `slow` is recomputed per-snapshot, not carried over from the initial load.
  useEffect(() => {
    const id = setInterval(() => {
      void load(false);
    }, AUTO_REFRESH_MS);
    return () => clearInterval(id);
  }, [load]);

  // "last updated Ns ago" ticker — independent 1s tick, only needs `now`.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const indicator = deriveIndicator(stage);
  const showColdStart = stage.status === "loading" && loadingElapsed >= Math.floor(SLOW_THRESHOLD_MS / 1000);

  return (
    <>
      <div className="lp-content-head">
        <Eyebrow>Facilitator status</Eyebrow>
        <h1>Live health, straight from the facilitator.</h1>
        <p className="lp-lead">
          Auto-refreshing snapshot of the real hosted facilitator&apos;s <code>/health</code> and{" "}
          <code>/supported</code> endpoints — no session, no wallet, just what the service itself reports.
        </p>
      </div>

      {stage.status === "loading" && !showColdStart && (
        <p className="lp-lead">Checking facilitator status…</p>
      )}

      {showColdStart && <p className="lp-lead">Waking up the facilitator... ({loadingElapsed}s)</p>}

      {stage.status === "error" && (
        <div>
          <p className="lp-lead">{stage.message}</p>
          <div className="lp-cta-row">
            <LpActionButton variant="outline" onClick={() => load(true)}>
              Retry
            </LpActionButton>
          </div>
        </div>
      )}

      {stage.status === "ready" && (
        <StatusSnapshot
          snapshot={stage.snapshot}
          indicator={indicator}
          now={now ?? stage.snapshot.fetchedAt}
          onRefresh={() => load(false)}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Snapshot rendering
// ---------------------------------------------------------------------------

function IndicatorDot({ tone }: { tone: "green" | "amber" | "red" }) {
  const color = tone === "green" ? "var(--lp-mint)" : tone === "amber" ? "var(--lp-sun)" : "var(--lp-coral)";
  return (
    <span
      aria-hidden
      style={{
        display: "inline-block",
        width: 10,
        height: 10,
        borderRadius: "50%",
        background: color,
        marginRight: 8,
      }}
    />
  );
}

function StatusSnapshot({
  snapshot,
  indicator,
  now,
  onRefresh,
}: {
  snapshot: Snapshot;
  indicator: { tone: "green" | "amber" | "red"; label: string };
  now: number;
  onRefresh: () => void;
}) {
  const { health, supported, fetchedAt } = snapshot;
  const agoSeconds = Math.max(0, Math.floor((now - fetchedAt) / 1000));
  const signerEntries = Object.entries(supported.signers ?? {});
  const sponsorConfigured = signerEntries.length > 0 && signerEntries.some(([, keys]) => keys.length > 0);

  return (
    <>
      <div className="lp-cta-row" style={{ marginTop: 0, alignItems: "center" }}>
        <span className="lp-lead" style={{ fontSize: "0.85rem" }}>
          Last updated {agoSeconds}s ago · auto-refreshes every 30s
        </span>
        <LpActionButton variant="outline" size="sm" onClick={onRefresh}>
          Refresh now
        </LpActionButton>
      </div>

      <div className="lp-dgrid" style={{ marginTop: "var(--lp-sp-6)" }}>
        {/* ---- Stat tiles panel ---- */}
        <div className="lp-dpanel lp-dpanel--sun">
          <div className="lp-dpanel-head">
            <h2>At a glance</h2>
          </div>
          <div className="lp-hero-cards" style={{ marginTop: 0, gridTemplateColumns: "repeat(2, 1fr)" }}>
            <Field
              label="STATUS"
              amount={
                <>
                  <IndicatorDot tone={indicator.tone} />
                  {indicator.label}
                </>
              }
            />
            <Field label="UPTIME" amount={formatDuration(health.uptimeSeconds ?? 0)} />
            <Field label="CATALOG SIZE" amount={String(health.catalogSize ?? "—")} />
            <Field
              label="COMMIT"
              amount={health.commit ? truncateMiddle(health.commit, 7, 0) : "—"}
              amountStyle={{ fontFamily: "var(--lp-mono)", fontSize: "1.1rem" }}
            />
          </div>

          {/* Bonus context: reverifyPending / unverifiableEntries, when present. */}
          {(typeof health.reverifyPending === "number" || typeof health.unverifiableEntries === "number") && (
            <div className="lp-hero-cards" style={{ marginTop: "var(--lp-sp-2)", gridTemplateColumns: "repeat(2, 1fr)" }}>
              {typeof health.reverifyPending === "number" && (
                <Field label="REVERIFY PENDING" amount={String(health.reverifyPending)} />
              )}
              {typeof health.unverifiableEntries === "number" && (
                <Field label="UNVERIFIABLE ENTRIES" amount={String(health.unverifiableEntries)} />
              )}
            </div>
          )}
        </div>

        {/* ---- Supported kinds panel ---- */}
        <div className="lp-dpanel lp-dpanel--dark lp-dpanel--dark-lime">
          <div className="lp-dpanel-head">
            <Eyebrow>Supported schemes &amp; networks</Eyebrow>
          </div>
          <p className="lp-lead" style={{ fontSize: "0.85rem" }}>
            Derived from <code>supported.kinds[]</code> — each entry pairs a scheme with a network and any
            notable <code>extra</code> flags.
          </p>
          <div className="lp-trace-panel" style={{ marginTop: "var(--lp-sp-2)" }}>
            <div className="head">
              <span>GET /supported</span>
              <span>{supported.kinds?.length ?? 0} kind(s)</span>
            </div>
            <MonoRows>
              {(supported.kinds ?? []).map((kind, i) => (
                <MonoRow
                  key={`${kind.scheme}-${kind.network}-${i}`}
                  label={`${kind.scheme ?? "?"} · ${kind.network ?? "?"}`}
                  value={formatExtra(kind.extra)}
                  tone="ok"
                />
              ))}
              {(supported.kinds?.length ?? 0) === 0 && <MonoRow label="No supported kinds reported" />}
            </MonoRows>
          </div>
        </div>

        {/* ---- Sponsor signer panel ---- */}
        <div className="lp-dpanel lp-dpanel--dark lp-dpanel--dark-lime lp-dpanel--span2">
          <div className="lp-dpanel-head">
            <Eyebrow>Sponsor signer</Eyebrow>
            <span className="lp-lead" style={{ fontSize: "0.8rem" }}>
              {sponsorConfigured ? "configured" : "not detected"}
            </span>
          </div>
          <div className="lp-trace-panel" style={{ marginTop: "var(--lp-sp-2)" }}>
            <div className="head">
              <span>Sponsor signer</span>
              <span>{sponsorConfigured ? "configured" : "not detected"}</span>
            </div>
            <MonoRows>
              {signerEntries.length === 0 && <MonoRow label="No signers reported in /supported" />}
              {signerEntries.map(([prefix, keys]) => (
                <MonoRow
                  key={prefix}
                  label={prefix}
                  value={keys.length > 0 ? truncateMiddle(keys[0], 8, 6) : "—"}
                  tone={keys.length > 0 ? "ok" : "bad"}
                />
              ))}
            </MonoRows>
            <p className="lp-lead" style={{ fontSize: "0.8rem", marginTop: "var(--lp-sp-4)" }}>
              This only confirms a sponsor signer address is configured for settlement — the API doesn&apos;t
              expose its live balance or preflight state, so we don&apos;t claim to know either.
            </p>
          </div>
        </div>
      </div>
    </>
  );
}

function formatExtra(extra?: Record<string, unknown>): string {
  if (!extra || Object.keys(extra).length === 0) return "—";
  return Object.entries(extra)
    .map(([k, v]) => `${k}=${typeof v === "string" && v.length > 14 ? truncateMiddle(v, 8, 4) : String(v)}`)
    .join(", ");
}
