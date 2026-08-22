"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Eyebrow, LpActionButton } from "../../design/ui";
import { formatAtomicAmount, truncateMiddle } from "@/lib/format";
import { useElapsedSeconds } from "@/lib/use-elapsed-seconds";

// ---------------------------------------------------------------------------
// Types — live shapes verified by curl against the hosted facilitator (see
// this step's task notes). Note the deliberate shape mismatch between the
// two endpoints this page uses:
//   GET /discovery/resources -> { items: [...] }
//   GET /discovery/search    -> { resources: [...] }
// Both arrays hold the same per-item shape, just under a different key —
// `normalizeItems()` below is the single place that reconciles this.
// ---------------------------------------------------------------------------

interface Trust {
  settlements?: number;
  uniquePayers?: number;
  lastSettled?: string;
  ownershipState?: string;
  ownerVerified?: boolean;
  verification?: string;
}

interface CatalogAccept {
  amount?: string;
  asset?: string;
  payTo?: string;
  network?: string;
}

interface CatalogItem {
  resource: string;
  description?: string;
  accepts?: CatalogAccept[];
  trust?: Trust;
}

function normalizeItems(body: unknown): CatalogItem[] {
  if (!body || typeof body !== "object") return [];
  const record = body as Record<string, unknown>;
  const raw = Array.isArray(record.items)
    ? record.items
    : Array.isArray(record.resources)
      ? record.resources
      : [];
  return raw.filter((item): item is CatalogItem => Boolean(item && typeof item === "object" && typeof (item as CatalogItem).resource === "string"));
}

type CatalogStage =
  | { status: "loading"; startedAt: number }
  | { status: "ready"; items: CatalogItem[] }
  | { status: "error"; message: string };

type SearchStage =
  | { status: "idle" }
  | { status: "loading"; startedAt: number }
  | { status: "ready"; items: CatalogItem[]; partialResults?: boolean }
  | { status: "error"; message: string };

const DEBOUNCE_MS = 350;

async function fetchJson(url: string): Promise<{ ok: boolean; body: unknown }> {
  const res = await fetch(url);
  const body = await res.json();
  return { ok: res.ok, body };
}

// Sentinel "not started yet" — real loading (with a concrete `startedAt`)
// begins once the mount effect below actually runs `loadCatalog()`. Keeps
// `Date.now()` out of the useState initializer (render body), which the
// stricter React 19 purity lint (react-hooks/purity) forbids.
const INITIAL_CATALOG_STAGE: CatalogStage = { status: "loading", startedAt: 0 };

export default function CatalogPage() {
  const [catalog, setCatalog] = useState<CatalogStage>(INITIAL_CATALOG_STAGE);
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState<SearchStage>({ status: "idle" });

  const catalogElapsed = useElapsedSeconds(
    catalog.status === "loading" && catalog.startedAt > 0 ? catalog.startedAt : null,
  );
  const searchElapsed = useElapsedSeconds(search.status === "loading" ? search.startedAt : null);

  // useCallback (not a plain function-in-render-body) so react-hooks/purity
  // is satisfied that the first setState inside runs after an await, not
  // synchronously as part of the calling effect's body.
  const loadCatalog = useCallback(async () => {
    setCatalog({ status: "loading", startedAt: Date.now() });
    try {
      const { ok, body } = await fetchJson("/api/catalog");
      if (!ok) {
        const message =
          (body as { message?: string })?.message || "We couldn't load the catalog. Please try again.";
        setCatalog({ status: "error", message });
        return;
      }
      setCatalog({ status: "ready", items: normalizeItems(body) });
    } catch {
      setCatalog({
        status: "error",
        message: "We couldn't reach the server. Please check your connection and try again.",
      });
    }
  }, []);

  // Guarded by a ref (same pattern as app/page.tsx's `fetchedForWallet`)
  // rather than an unconditional `void loadCatalog()` at the top of the
  // effect body — react-hooks/purity's static analysis can't otherwise
  // prove loadCatalog's synchronous initial `setCatalog(...)` call is safe.
  const hasLoadedInitially = useRef(false);
  useEffect(() => {
    if (!hasLoadedInitially.current) {
      hasLoadedInitially.current = true;
      void loadCatalog();
    }
  }, [loadCatalog]);

  const runSearch = useCallback(async (q: string) => {
    setSearch({ status: "loading", startedAt: Date.now() });
    try {
      const { ok, body } = await fetchJson(`/api/search?query=${encodeURIComponent(q)}`);
      if (!ok) {
        const message = (body as { message?: string })?.message || "Search failed. Please try again.";
        setSearch({ status: "error", message });
        return;
      }
      const partialResults = Boolean((body as { partialResults?: boolean })?.partialResults);
      setSearch({ status: "ready", items: normalizeItems(body), partialResults });
    } catch {
      setSearch({
        status: "error",
        message: "We couldn't reach the server. Please check your connection and try again.",
      });
    }
  }, []);

  // Debounced search — fires runSearch() 350ms after typing settles. A
  // blank query intentionally does NOT touch `search` state at all (no
  // synchronous setState in the effect body) — `isSearching` below derives
  // straight from `query`, so clearing the box falls back to showing the
  // main catalog list without needing an "idle" transition through state.
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const trimmed = query.trim();
    if (trimmed === "") return;
    debounceRef.current = setTimeout(() => {
      void runSearch(trimmed);
    }, DEBOUNCE_MS);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, runSearch]);

  const isSearching = query.trim() !== "";
  const displayed = isSearching ? search : catalog;

  return (
    <>
      <div className="lp-content-head">
        <Eyebrow>Bazaar catalog</Eyebrow>
        <h1>Every resource the facilitator has seen.</h1>
        <p className="lp-lead">
          A browsing-only view of the live Bazaar catalog — descriptions, prices, ownership state, and
          settlement counts, straight from the facilitator&apos;s <code>/discovery</code> endpoints.
        </p>
        <p className="lp-lead" style={{ fontSize: "0.9rem", marginTop: "var(--lp-sp-3)" }}>
          Want to try paying one of these? <Link href="/" style={{ textDecoration: "underline" }}>Head to the guided demo →</Link>
        </p>
      </div>

      <div className="lp-dpanel" style={{ marginBottom: "var(--lp-sp-6)" }}>
        {/* ---- Search box ---- */}
        <div>
          <label htmlFor="catalog-search" className="lp-eyebrow" style={{ display: "block", marginBottom: "var(--lp-sp-2)" }}>
            Search the catalog
          </label>
          <input
            id="catalog-search"
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="e.g. quote"
            className="lp-field"
            style={{
              width: "100%",
              maxWidth: 420,
              font: "inherit",
              fontSize: "1rem",
              color: "inherit",
              display: "block",
            }}
          />
        </div>

        {/* ---- Results ---- */}
        {displayed.status === "loading" && (
          <p className="lp-lead">
            {isSearching ? `Searching... (${searchElapsed}s)` : `Waking up the facilitator... (${catalogElapsed}s)`}
          </p>
        )}

        {displayed.status === "error" && (
          <div>
            <p className="lp-lead">{displayed.message}</p>
            <div className="lp-cta-row">
              <LpActionButton
                variant="outline"
                onClick={() => (isSearching ? runSearch(query.trim()) : loadCatalog())}
              >
                Retry
              </LpActionButton>
            </div>
          </div>
        )}

        {displayed.status === "ready" && displayed.items.length === 0 && (
          <p className="lp-lead">
            {isSearching ? `No resources matched "${query.trim()}".` : "No resources are cataloged yet."}
          </p>
        )}

        {displayed.status === "ready" && displayed.items.length > 0 && (
          <>
            {isSearching && "partialResults" in displayed && displayed.partialResults && (
              <p className="lp-lead" style={{ fontSize: "0.85rem" }}>
                Results are partial — the facilitator truncated this search.
              </p>
            )}
            <div className="lp-rlist">
              {displayed.items.map((item) => (
                <CatalogRow key={item.resource} item={item} />
              ))}
            </div>
          </>
        )}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Row
// ---------------------------------------------------------------------------

function ownershipBadge(trust?: Trust): { text: string; verified: boolean } {
  const state = trust?.ownershipState;
  if (state === "verified") return { text: "Verified", verified: true };
  if (state === "unverified") return { text: "Unverified", verified: false };
  if (state === "proven-unconfirmed") return { text: "Proven (unconfirmed)", verified: false };
  if (typeof state === "string" && state.length > 0) return { text: state, verified: false };
  return { text: "Unknown", verified: false };
}

function CatalogRow({ item }: { item: CatalogItem }) {
  const accept = item.accepts?.[0];
  const badge = ownershipBadge(item.trust);
  const settlements = item.trust?.settlements ?? 0;

  return (
    <div className="lp-rrow" style={{ alignItems: "flex-start" }}>
      <div className="ri"></div>
      <div className="rn" style={{ flex: 1 }}>
        <b>{item.description || item.resource}</b>
        <span>
          {formatAtomicAmount(accept?.amount)} atomic of {truncateMiddle(accept?.asset || "—")}
        </span>
        <span>{truncateMiddle(item.resource, 32, 12)}</span>
        <span>
          {settlements} settlement{settlements === 1 ? "" : "s"}
        </span>
      </div>
      <span className="lp-verified" style={!badge.verified ? { background: "var(--lp-paper-tint)" } : undefined}>
        {badge.verified ? "✓ " : ""}
        {badge.text}
      </span>
    </div>
  );
}
