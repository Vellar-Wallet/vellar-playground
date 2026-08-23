"use client";

import { useCallback, useState } from "react";
import Link from "next/link";
import { Eyebrow, LpActionButton } from "../../design/ui";
import { FACILITATOR_URL } from "@/lib/config";

// ---------------------------------------------------------------------------
// A raw API console: one card per facilitator endpoint. GET endpoints are
// wired to a real "Run" button (through this app's server proxy routes —
// same cold-start/CORS rationale as /api/catalog, see lib/facilitator.ts).
// POST endpoints (/verify, /settle) are illustrative only, per spec: show
// the expected request shape, no interactive form, and point at the guided
// demo page where they're actually exercised.
// ---------------------------------------------------------------------------

type RunStage =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; body: unknown; ms: number }
  | { status: "error"; message: string };

interface EndpointDef {
  id: string;
  method: "GET" | "POST";
  path: string;
  description: string;
  /** Proxy route to hit for a real "Run" — undefined means no Run button. */
  proxyPath?: string;
  /** true if this endpoint takes a `query` text param, run through the proxy. */
  hasQueryParam?: boolean;
}

const ENDPOINTS: EndpointDef[] = [
  {
    id: "health",
    method: "GET",
    path: "/health",
    description: "Liveness check — service status, uptime, catalog size, current commit.",
    proxyPath: "/api/health",
  },
  {
    id: "supported",
    method: "GET",
    path: "/supported",
    description: "Advertises the schemes, networks, and settlement signers this facilitator supports.",
    proxyPath: "/api/supported",
  },
  {
    id: "discovery-resources",
    method: "GET",
    path: "/discovery/resources",
    description: "Lists the live Bazaar catalog — every resource this facilitator has seen paid for.",
    proxyPath: "/api/catalog",
  },
  {
    id: "discovery-search",
    method: "GET",
    path: "/discovery/search",
    description: "Keyword search over the Bazaar catalog. Takes a `query` param.",
    proxyPath: "/api/search",
    hasQueryParam: true,
  },
  {
    id: "verify",
    method: "POST",
    path: "/verify",
    description: "Re-simulates a payment to check it's valid, without settling it on-chain. Free to call.",
  },
  {
    id: "settle",
    method: "POST",
    path: "/settle",
    description: "Submits a signed payment on-chain and sponsors the network fee.",
  },
];

// Illustrative request body for /verify and /settle — both take the same
// { paymentPayload, paymentRequirements } shape (verified against
// vellar-facilitator's src/server.ts route handlers: `const { paymentPayload,
// paymentRequirements } = request.body`). The field shapes themselves are
// @x402/core's real V2 PaymentRequirements/PaymentPayload types (scheme,
// network, amount, asset, payTo, maxTimeoutSeconds, extra / x402Version,
// resource, accepted, payload, extensions) — `payload` itself (the signed
// Stellar transaction envelope + auth entries) is scheme-specific binary
// data, so it's shown as a placeholder string rather than invented XDR.
const ILLUSTRATIVE_BODY = `{
  "paymentPayload": {
    "x402Version": 2,
    "resource": { "url": "https://vellar-seller-demo.onrender.com/quote" },
    "accepted": {
      "scheme": "exact",
      "network": "stellar:testnet",
      "amount": "1000000",
      "asset": "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
      "payTo": "GAATVGLRHZXFC66GEN5QNKD56HC5JJZVHQ3P7ZJNVCCI4WKLN44FICSC",
      "maxTimeoutSeconds": 120,
      "extra": { "areFeesSponsored": true }
    },
    "payload": "<scheme-specific: signed Stellar transaction envelope + auth entry, base64 XDR>"
  },
  "paymentRequirements": {
    "scheme": "exact",
    "network": "stellar:testnet",
    "amount": "1000000",
    "asset": "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
    "payTo": "GAATVGLRHZXFC66GEN5QNKD56HC5JJZVHQ3P7ZJNVCCI4WKLN44FICSC",
    "maxTimeoutSeconds": 120,
    "extra": { "areFeesSponsored": true }
  }
}`;

function fullUrl(path: string): string {
  return `${FACILITATOR_URL.replace(/\/+$/, "")}${path}`;
}

export default function ConsolePage() {
  const [runs, setRuns] = useState<Record<string, RunStage>>({});
  const [queryInputs, setQueryInputs] = useState<Record<string, string>>({});

  // useCallback (not a plain function-in-render-body) so react-hooks/purity
  // treats `Date.now()` inside it as event-handler code, not render code —
  // same reasoning as /status's `load`.
  const run = useCallback(
    async (endpoint: EndpointDef) => {
      if (!endpoint.proxyPath) return;
      setRuns((prev) => ({ ...prev, [endpoint.id]: { status: "loading" } }));
      const startedAt = Date.now();
      try {
        const url = endpoint.hasQueryParam
          ? `${endpoint.proxyPath}?query=${encodeURIComponent(queryInputs[endpoint.id] ?? "")}`
          : endpoint.proxyPath;
        const res = await fetch(url);
        const body = await res.json();
        const ms = Date.now() - startedAt;
        if (!res.ok) {
          setRuns((prev) => ({
            ...prev,
            [endpoint.id]: { status: "error", message: body?.message || `Request failed (HTTP ${res.status}).` },
          }));
          return;
        }
        setRuns((prev) => ({ ...prev, [endpoint.id]: { status: "ready", body, ms } }));
      } catch {
        setRuns((prev) => ({
          ...prev,
          [endpoint.id]: {
            status: "error",
            message: "We couldn't reach the server. Please check your connection and try again.",
          },
        }));
      }
    },
    [queryInputs],
  );

  return (
    <>
      <div className="lp-content-head">
        <Eyebrow>API console</Eyebrow>
        <h1>Every endpoint, raw.</h1>
        <p className="lp-lead">
          The full facilitator surface — run the real GET endpoints and see the actual JSON come back. POST
          endpoints are shown illustratively; use the guided demo to trigger a real payment.
        </p>
      </div>

      <div className="lp-dgrid lp-dgrid--wide">
        {ENDPOINTS.map((endpoint) => (
          <EndpointCard
            key={endpoint.id}
            endpoint={endpoint}
            stage={runs[endpoint.id] ?? { status: "idle" }}
            queryValue={queryInputs[endpoint.id] ?? ""}
            onQueryChange={(v) => setQueryInputs((prev) => ({ ...prev, [endpoint.id]: v }))}
            onRun={() => run(endpoint)}
          />
        ))}
      </div>
    </>
  );
}

function EndpointCard({
  endpoint,
  stage,
  queryValue,
  onQueryChange,
  onRun,
}: {
  endpoint: EndpointDef;
  stage: RunStage;
  queryValue: string;
  onQueryChange: (v: string) => void;
  onRun: () => void;
}) {
  return (
    <div className="lp-dpanel lp-dpanel--dark lp-dpanel--dark-lime">
      <div className="lp-dpanel-head">
        <h2 style={{ fontSize: "var(--lp-fs-h4)", fontFamily: "var(--lp-mono)" }}>
          {endpoint.method} {endpoint.path}
        </h2>
      </div>
      <p className="lp-lead" style={{ fontSize: "0.9rem" }}>
        {endpoint.description}
      </p>
      <p className="lp-lead" style={{ fontSize: "0.8rem", fontFamily: "var(--lp-mono)" }}>
        {endpoint.method} {fullUrl(endpoint.path)}
      </p>

      {endpoint.proxyPath ? (
        <>
          <div className="lp-cta-row" style={{ marginTop: "var(--lp-sp-4)", alignItems: "center" }}>
            {endpoint.hasQueryParam && (
              <input
                type="text"
                value={queryValue}
                onChange={(e) => onQueryChange(e.target.value)}
                placeholder="query, e.g. quote"
                style={{
                  font: "inherit",
                  fontSize: "0.9rem",
                  padding: "8px 12px",
                  background: "var(--lp-on-dark)",
                  color: "var(--lp-ink)",
                  border: 0,
                }}
              />
            )}
            <LpActionButton variant="sun" size="sm" onClick={onRun} disabled={stage.status === "loading"}>
              {stage.status === "loading" ? "Running…" : "Run →"}
            </LpActionButton>
            {stage.status === "ready" && (
              <span className="lp-lead" style={{ fontSize: "0.8rem" }}>
                {stage.ms}ms
              </span>
            )}
          </div>

          {stage.status === "error" && (
            <p className="lp-lead" style={{ marginTop: "var(--lp-sp-4)", color: "var(--lp-coral)" }}>
              {stage.message}
            </p>
          )}

          {stage.status === "ready" && (
            <div className="lp-trace-panel" style={{ marginTop: "var(--lp-sp-4)" }}>
              <div className="head">
                <span>Response</span>
                <span>200 OK</span>
              </div>
              <JsonBlock value={stage.body} />
            </div>
          )}
        </>
      ) : (
        <>
          {/* Collapsed by default — same <details>/.lp-fitem--raw disclosure
              pattern the payment ledger's "Raw wire bytes" rows use (see
              app/(dashboard)/page.tsx's StepRawBytes). The always-expanded
              version of this made /verify and /settle far taller than their
              GET siblings (a static internal maxHeight:420 JSON block
              embedded directly in card flow), pushing the whole grid past
              the fold — collapsing it fixes the actual height cause rather
              than just shrinking the number. */}
          <details className="lp-fitem lp-fitem--raw" style={{ marginTop: "var(--lp-sp-4)" }}>
            <summary>
              <span>Illustrative request body</span>
              <span className="pm" aria-hidden>
                +
              </span>
            </summary>
            <div className="body">
              <div className="lp-trace-panel" style={{ marginTop: "var(--lp-sp-3)" }}>
                <div className="head">
                  <span>Request</span>
                  <span>POST</span>
                </div>
                <JsonBlock text={ILLUSTRATIVE_BODY} />
              </div>
            </div>
          </details>
          <p className="lp-lead" style={{ marginTop: "var(--lp-sp-4)", fontSize: "0.9rem" }}>
            Use the guided demo page to trigger these →{" "}
            <Link href="/" style={{ textDecoration: "underline", color: "var(--lp-sun)" }}>
              Go to the demo
            </Link>
          </p>
        </>
      )}
    </div>
  );
}

/** Pretty-printed, horizontally-scrollable JSON block — never forces the
 *  page itself to scroll horizontally (the scroll container is local). */
function JsonBlock({ value, text }: { value?: unknown; text?: string }) {
  const content = text ?? JSON.stringify(value, null, 2);
  return (
    <div style={{ overflowX: "auto", maxHeight: 420, overflowY: "auto" }}>
      <pre
        style={{
          margin: 0,
          fontFamily: "var(--lp-mono)",
          fontSize: "0.8125rem",
          whiteSpace: "pre",
          color: "var(--lp-on-dark-soft)",
        }}
      >
        {content}
      </pre>
    </div>
  );
}
