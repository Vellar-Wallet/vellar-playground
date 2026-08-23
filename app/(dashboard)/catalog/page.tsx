"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Eyebrow, LpActionButton } from "../../design/ui";
import { formatAtomicAmount, truncateMiddle } from "@/lib/format";
import { useElapsedSeconds } from "@/lib/use-elapsed-seconds";
import { writeLastCatalogSearch } from "@/lib/local-storage";
import { isLocalOrPrivateResource } from "@/lib/catalog";
import { useWallet, WALLET_STEP_ORDER, WALLET_STEP_LABELS, type WalletStage, type WalletStepMap } from "@/lib/wallet-context";

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
  /** Example query-param values from the resource's own Bazaar discovery
   *  entry (extensions.bazaar.info.input.queryParams), e.g. { input: "hello
   *  world" } for /hash. Not every resource needs input — /quote, /timestamp,
   *  /uuid all answer with zero params — so this is only ever CONSULTED
   *  reactively, after a real "no_challenge" (expected 402, got a non-402)
   *  failure, rather than used to guess upfront which resources need a
   *  prompt. See ParamPrompt below. */
  exampleQueryParams?: Record<string, string>;
  /** Example PATH-param values (extensions.bazaar.info.input.pathParams),
   *  e.g. { address: "GAAT..." } for /inspect/:address. The resource URL
   *  itself carries the literal, unsubstituted ":address" placeholder from
   *  discovery — these values get substituted into the URL path (not
   *  appended as a query string) before the resource is paid for. Same
   *  reactive-only usage as exampleQueryParams. */
  examplePathParams?: Record<string, string>;
}

/** Reads extensions.bazaar.info.input.{queryParams,pathParams} off a raw
 *  discovery item and returns both example maps. Both live at the same
 *  nesting depth (one level under `input`, confirmed via curl against the
 *  real /discovery/resources response) — a single walk down to `input`
 *  serves both, rather than two near-duplicate functions. */
function extractExampleParams(item: unknown): { queryParams?: Record<string, string>; pathParams?: Record<string, string> } {
  if (!item || typeof item !== "object") return {};
  const extensions = (item as Record<string, unknown>).extensions;
  if (!extensions || typeof extensions !== "object") return {};
  const bazaar = (extensions as Record<string, unknown>).bazaar;
  if (!bazaar || typeof bazaar !== "object") return {};
  const info = (bazaar as Record<string, unknown>).info;
  if (!info || typeof info !== "object") return {};
  // BUG FIX: this used to read `info.queryParams` directly — one level too
  // shallow. The real live shape (confirmed via curl against
  // /discovery/resources) nests queryParams/pathParams one level deeper,
  // under `info.input`, matching this function's own doc comment above
  // (which had the right path all along) but not what the code actually
  // read. Silent effect: exampleQueryParams was always undefined for
  // every real resource, so the "needs_input" param-prompt form could
  // never fire — any resource needing query params (hash, base64,
  // word-count, stroops) fell into a permanent, unrecoverable generic
  // "Payment failed" error with no way to supply the input a retry would
  // need.
  const input = (info as Record<string, unknown>).input;
  if (!input || typeof input !== "object") return {};
  const toStringMap = (value: unknown): Record<string, string> | undefined => {
    if (!value || typeof value !== "object") return undefined;
    const entries = Object.entries(value as Record<string, unknown>).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    );
    return entries.length > 0 ? Object.fromEntries(entries) : undefined;
  };
  return {
    queryParams: toStringMap((input as Record<string, unknown>).queryParams),
    pathParams: toStringMap((input as Record<string, unknown>).pathParams),
  };
}

function normalizeItems(body: unknown): CatalogItem[] {
  if (!body || typeof body !== "object") return [];
  const record = body as Record<string, unknown>;
  const raw = Array.isArray(record.items)
    ? record.items
    : Array.isArray(record.resources)
      ? record.resources
      : [];
  return raw
    .filter((item): item is Record<string, unknown> & { resource: string } =>
      Boolean(item && typeof item === "object" && typeof (item as CatalogItem).resource === "string"),
    )
    // Other developers' local dev/test resources (localhost/private-IP
    // hosts) genuinely get indexed into the shared facilitator catalog —
    // see isLocalOrPrivateResource()'s doc comment. Filtered from display
    // only, never from what's fetched.
    .filter((item) => !isLocalOrPrivateResource(item.resource as string))
    .map((item) => {
      const { queryParams, pathParams } = extractExampleParams(item);
      return { ...(item as unknown as CatalogItem), exampleQueryParams: queryParams, examplePathParams: pathParams };
    });
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

function parseNdjsonLine(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Pay step types — mirrors POST /api/pay's NDJSON events. Per the locked
// product decision, this page shows a LIGHTER compact step-progress
// indicator (reusing .lp-step-row/.lp-step-mark), not the full six-step
// raw-wire-bytes ledger app/(dashboard)/page.tsx's PayLedger renders. Because
// of that, this page doesn't need to track each step individually — only
// whether payment is in flight, and the terminal outcome — so PayCardState
// below is intentionally coarser than app/(dashboard)/page.tsx's PayStage.
// The stream still internally retries up to 3 times on a "not_settled"
// failure before giving up (see app/api/pay/route.ts); this page's "paying"
// state just stays showing across that, whichever attempt finally resolves.
// ---------------------------------------------------------------------------

interface PayCompleteResult {
  settlementTx: string;
  attempts: number;
}

type PayCardState =
  | { status: "paying"; startedAt: number }
  | { status: "success"; result: PayCompleteResult }
  | { status: "error"; message: string }
  // Real, wire-observed failure: the resource answered the unpaid GET with
  // something other than a 402 challenge (server-reported `error ===
  // "no_challenge"` — see lib/pay.ts's exact check). For a resource whose
  // Bazaar discovery entry advertises example queryParams (e.g. /hash's
  // `input`, /word-count's `text`), the overwhelmingly likely cause is that
  // it needs those params to answer at all — a blank GET/HEAD-equivalent
  // call 400s before ever reaching the 402 challenge. Rather than guessing
  // upfront which of the catalog's resources need input, this state is only
  // EVER entered reactively, after that specific real failure — see
  // payForResource's handleComplete.
  | { status: "needs_input"; message: string };

/** Per-card payment state, keyed by resource URL. Cards not present in this
 *  map render their default "Pay" button (idle). Using a plain keyed record
 *  (rather than per-card component state) keeps every card's payment outcome
 *  visible from one place and trivially independent — updating one card's
 *  entry can never disturb another's, since each write only ever touches its
 *  own key. */
type PayState = Record<string, PayCardState>;

export default function CatalogPage() {
  const [catalog, setCatalog] = useState<CatalogStage>(INITIAL_CATALOG_STAGE);
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState<SearchStage>({ status: "idle" });

  // Wallet state now lives in the shared context (lib/wallet-context.tsx) —
  // one wallet for the whole app, not a page-local copy, so it survives
  // navigating away and back (see that module's doc comment for why this
  // page used to duplicate wallet-creation logic independently, and why
  // that was the bug: this page and "/" could show two different wallets
  // out of sync with each other before this).
  const { wallet, elapsed: walletElapsed, createWallet } = useWallet();
  // The resource whose Pay click triggered wallet creation THIS time — a
  // state value (not just a ref) because it must survive across re-renders
  // through every phase of that flow (loading -> ready/error) so the SAME
  // card keeps showing the inline provisioning UI, the USDC-graceful-
  // degradation message, or a wallet-creation error, rather than that state
  // seeming to vanish once the fetch resolves. A plain ref would work for
  // the "read it once at completion" carry-forward use (see the effect
  // below, which still uses a ref for that one-shot consumption) but not
  // for "keep rendering on the right card while wallet.status == loading"
  // — hence both exist, serving different purposes. Since wallet state is
  // now shared/global rather than page-local, this only matters for the
  // FIRST-EVER creation on this page load — a wallet that's already
  // "ready"/"cached" from a prior page never sets this at all (see
  // handlePayClick below), so it's undefined outside a fresh in-page
  // creation flow, same as before.
  const [walletFlowResource, setWalletFlowResource] = useState<string | null>(null);
  const pendingResourceRef = useRef<string | null>(null);

  const [payState, setPayState] = useState<PayState>({});
  // Current param-form values per resource, keyed by resource URL — only
  // populated once a card enters "needs_input" and the user starts editing
  // the prefilled example values. Kept separate from `payState` so a param
  // edit never has to reconstruct/guess at the rest of that resource's
  // PayCardState.
  const [paramValues, setParamValues] = useState<Record<string, Record<string, string>>>({});
  // Kept in sync every render (below, near `displayed`) rather than as
  // state — payForResource is a useCallback with empty deps (so its
  // identity is stable across re-renders, matching every other handler in
  // this file), so it can't close over `catalog`/`search` state directly
  // without going stale; a ref read at call time gives it the current
  // catalog without needing to be in its dependency array.
  const itemsByResourceRef = useRef<Map<string, CatalogItem>>(new Map());
  // Optimistic per-resource settlement-count bump — see the settlements-
  // count-after-payment judgment call in this task's report. Kept separate
  // from `catalog`/`search`'s own item data (rather than mutating those
  // arrays in place) so a later real re-fetch of /api/catalog cleanly
  // overwrites it instead of fighting over which value is authoritative.
  const [settlementBumps, setSettlementBumps] = useState<Record<string, number>>({});

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
      const items = normalizeItems(body);
      setSearch({ status: "ready", items, partialResults });
      // Written as a side effect of a completed search — for later use on
      // /catalog (per this task's scoping, no read/restore UI is built yet;
      // this just confirms the write path works). See lib/local-storage.ts.
      writeLastCatalogSearch({ query: q, results: items });
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

  // ---------------------------------------------------------------------
  // Payment — streams POST /api/pay for one resource, updating only that
  // resource's entry in `payState`. See PayState's doc comment above for why
  // this keeps every card's flow independent.
  //
  // `params`, when given, is applied to `resourceUrl` before it's sent as
  // the resource actually paid for — see ParamPrompt below. Path params
  // (e.g. /inspect/:address) substitute the literal `:key` placeholder in
  // the URL path; everything else is appended as a query string. `payState`
  // stays keyed by the CARD's base resource URL throughout (never the
  // substituted one), so a resubmission with different param values still
  // updates the same card rather than opening a second entry.
  // ---------------------------------------------------------------------
  const payForResource = useCallback(async (resourceUrl: string, params?: Record<string, string>) => {
    setPayState((prev) => ({ ...prev, [resourceUrl]: { status: "paying", startedAt: Date.now() } }));

    let requestUrl = resourceUrl;
    if (params && Object.keys(params).length > 0) {
      // Path substitution first (":key" segments), then whatever's left
      // over goes on the query string — a key that matched a ":key"
      // placeholder in the path is consumed there and NOT also appended as
      // a query param.
      let substitutedPath = resourceUrl;
      const remaining: Record<string, string> = {};
      for (const [key, value] of Object.entries(params)) {
        const placeholder = `:${key}`;
        if (substitutedPath.includes(placeholder)) {
          substitutedPath = substitutedPath.split(placeholder).join(encodeURIComponent(value));
        } else {
          remaining[key] = value;
        }
      }
      if (Object.keys(remaining).length > 0) {
        const url = new URL(substitutedPath);
        for (const [key, value] of Object.entries(remaining)) url.searchParams.set(key, value);
        requestUrl = url.toString();
      } else {
        requestUrl = substitutedPath;
      }
    }

    try {
      const res = await fetch("/api/pay", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ resourceUrl: requestUrl }),
      });
      if (!res.ok || !res.body) {
        setPayState((prev) => ({
          ...prev,
          [resourceUrl]: { status: "error", message: "We couldn't reach the server. Please try again." },
        }));
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let settled = false;

      const handleComplete = (event: Record<string, unknown>) => {
        settled = true;
        if (event.status === "done" && event.result && typeof event.result === "object") {
          const result = event.result as { settlementTx?: unknown; attempts?: unknown };
          if (typeof result.settlementTx === "string") {
            setPayState((prev) => ({
              ...prev,
              [resourceUrl]: {
                status: "success",
                result: {
                  settlementTx: result.settlementTx as string,
                  attempts: typeof result.attempts === "number" ? result.attempts : 1,
                },
              },
            }));
            // Optimistic +1 — see the settlements-count-after-payment doc
            // comment on `settlementBumps` above.
            setSettlementBumps((prev) => ({ ...prev, [resourceUrl]: (prev[resourceUrl] ?? 0) + 1 }));
            return;
          }
        }
        // A real "expected 402, got HTTP <n>" failure on a resource that
        // advertises example query params (per its own Bazaar discovery
        // entry) is overwhelmingly a missing- or wrong-value-input case, not
        // a transient network issue — offer the param form (again, if this
        // was already a resubmission with edited values that still didn't
        // work) instead of a plain "try again" that would just repeat the
        // same failing call verbatim. Detected from the server's own
        // machine-readable `error` code (lib/pay.ts's exact "no_challenge"
        // check), not by string-matching `.message`.
        if (event.error === "no_challenge") {
          const item = itemsByResourceRef.current.get(resourceUrl);
          if (item?.exampleQueryParams || item?.examplePathParams) {
            setPayState((prev) => ({
              ...prev,
              [resourceUrl]: {
                status: "needs_input",
                message: typeof event.message === "string" ? event.message : "This resource needs input to pay for it.",
              },
            }));
            return;
          }
        }
        // Reuses the exact wording app/(dashboard)/page.tsx's PayLedger uses
        // for each error category (see that file's humanMessage()) — the
        // server already sends this exact human-readable message on the
        // wire, so this just displays it verbatim rather than re-deriving it.
        const message = typeof event.message === "string" ? event.message : "Payment failed. Please try again.";
        setPayState((prev) => ({ ...prev, [resourceUrl]: { status: "error", message } }));
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const event = parseNdjsonLine(line);
          if (!event) continue;
          if (event.step === "complete") handleComplete(event);
        }
      }

      const trailing = parseNdjsonLine(buffer);
      if (trailing?.step === "complete") handleComplete(trailing);

      if (!settled) {
        setPayState((prev) => ({
          ...prev,
          [resourceUrl]: { status: "error", message: "The connection ended before your payment finished. Please try again." },
        }));
      }
    } catch {
      setPayState((prev) => ({
        ...prev,
        [resourceUrl]: { status: "error", message: "We couldn't reach the server. Please check your connection and try again." },
      }));
    }
  }, []);

  // Wallet creation itself now lives in the shared context (`createWallet`,
  // destructured above) — this page only owns the "which card's Pay click
  // triggered it" carry-forward, so the SAME card that started provisioning
  // keeps showing its progress, and its payment auto-continues once ready.
  const createWalletForResource = useCallback(
    (resourceToPayAfter: string) => {
      pendingResourceRef.current = resourceToPayAfter;
      setWalletFlowResource(resourceToPayAfter);
      void createWallet("button");
    },
    [createWallet],
  );

  // Carry-forward: once wallet creation lands on "ready", automatically
  // start the payment for whichever resource's Pay click triggered it — the
  // user shouldn't have to click Pay a second time. Only fires when
  // usdcProvisioned is true; the graceful-degradation case (XLM funded but
  // no USDC) is shown as a message instead (per the locked product
  // decision), with no automatic payment attempt, since there's no USDC to
  // pay with. Does NOT fire for "cached" — a cached wallet is re-confirming
  // in the background, not something this page itself triggered, so there's
  // no pending resource to carry forward in that case (pendingResourceRef
  // is only ever set by createWalletForResource above, right before an
  // in-page-triggered creation).
  useEffect(() => {
    if (wallet.status !== "ready") return;
    const resourceUrl = pendingResourceRef.current;
    if (!resourceUrl) return;
    pendingResourceRef.current = null;
    if (wallet.wallet.usdcProvisioned) {
      void payForResource(resourceUrl);
    }
  }, [wallet, payForResource]);

  const handlePayClick = useCallback(
    (resourceUrl: string) => {
      if (wallet.status === "idle") {
        createWalletForResource(resourceUrl);
        return;
      }
      void payForResource(resourceUrl);
    },
    [wallet.status, createWalletForResource, payForResource],
  );

  const isSearching = query.trim() !== "";
  const displayed = isSearching ? search : catalog;

  // Kept current after every commit — see itemsByResourceRef's doc comment
  // above. An effect (not a during-render mutation) so this stays a pure
  // side effect rather than a render-body write.
  useEffect(() => {
    if (displayed.status !== "ready") return;
    const map = new Map<string, CatalogItem>();
    for (const item of displayed.items) map.set(item.resource, item);
    itemsByResourceRef.current = map;
  }, [displayed]);

  return (
    <>
      <div className="lp-content-head">
        <Eyebrow>Bazaar catalog</Eyebrow>
        <h1>Every resource the facilitator has seen.</h1>
        <p className="lp-lead">
          Descriptions, prices, ownership state, and settlement counts, straight from the
          facilitator&apos;s <code>/discovery</code> endpoints — and a real, working Pay button on every
          card.
        </p>
      </div>

      <div className="lp-dpanel lp-dpanel--lime" style={{ marginBottom: "var(--lp-sp-6)" }}>
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
            <div className="lp-dgrid" style={{ marginTop: "var(--lp-sp-2)" }}>
              {displayed.items.map((item, index) => {
                // Combined example values (path + query) — the form treats
                // both uniformly (the user just fills in named fields);
                // payForResource is what tells path segments apart from
                // query params, by checking each key against the URL's own
                // ":key" placeholders.
                const exampleParams = { ...item.exampleQueryParams, ...item.examplePathParams };
                return (
                  <CatalogCard
                    key={item.resource}
                    item={item}
                    accentIndex={index}
                    settlementBump={settlementBumps[item.resource] ?? 0}
                    pay={payState[item.resource]}
                    paramValues={paramValues[item.resource] ?? exampleParams}
                    onParamChange={(key, value) =>
                      setParamValues((prev) => ({
                        ...prev,
                        [item.resource]: { ...(prev[item.resource] ?? exampleParams), [key]: value },
                      }))
                    }
                    walletPendingForThis={walletFlowResource === item.resource}
                    wallet={wallet}
                    walletElapsed={walletElapsed}
                    onPayClick={() => handlePayClick(item.resource)}
                    onRetryPay={() => payForResource(item.resource)}
                    onSubmitParams={() => payForResource(item.resource, paramValues[item.resource] ?? exampleParams)}
                  />
                );
              })}
            </div>
          </>
        )}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Card
// ---------------------------------------------------------------------------

const CARD_TINTS = ["mint", "sun", "lime", "coral"] as const;

function ownershipBadge(trust?: Trust): { text: string; verified: boolean } {
  const state = trust?.ownershipState;
  if (state === "verified") return { text: "Verified", verified: true };
  if (state === "unverified") return { text: "Unverified", verified: false };
  if (state === "proven-unconfirmed") return { text: "Proven (unconfirmed)", verified: false };
  if (typeof state === "string" && state.length > 0) return { text: state, verified: false };
  return { text: "Unknown", verified: false };
}

/** Compact step-progress indicator for wallet creation — reuses
 *  .lp-step-row/.lp-step-mark (mint=done/sun=active/coral=error), same
 *  pattern app/(dashboard)/page.tsx's StepProgress uses, just rendered
 *  inline inside a card rather than a full page section. */
function CompactStepProgress({ steps }: { steps: WalletStepMap }) {
  return (
    <div className="lp-steps-card">
      {WALLET_STEP_ORDER.map((step) => {
        const status = steps[step];
        return (
          <div className="lp-step-row" data-state={status} key={step}>
            <span className="lp-step-mark" aria-hidden />
            <span className="lp-step-label">{WALLET_STEP_LABELS[step]}</span>
          </div>
        );
      })}
    </div>
  );
}

function CatalogCard({
  item,
  accentIndex,
  settlementBump,
  pay,
  paramValues,
  onParamChange,
  walletPendingForThis,
  wallet,
  walletElapsed,
  onPayClick,
  onRetryPay,
  onSubmitParams,
}: {
  item: CatalogItem;
  accentIndex: number;
  settlementBump: number;
  pay: PayCardState | undefined;
  paramValues: Record<string, string>;
  onParamChange: (key: string, value: string) => void;
  walletPendingForThis: boolean;
  wallet: WalletStage;
  walletElapsed: number;
  onPayClick: () => void;
  onRetryPay: () => void;
  onSubmitParams: () => void;
}) {
  const accept = item.accepts?.[0];
  const badge = ownershipBadge(item.trust);
  const settlements = (item.trust?.settlements ?? 0) + settlementBump;
  const tint = CARD_TINTS[accentIndex % CARD_TINTS.length];

  return (
    <div className={`lp-dpanel lp-dpanel--${tint}`}>
      <div>
        <b style={{ fontSize: "0.95rem" }}>{item.description || item.resource}</b>
        <p className="lp-lead" style={{ fontSize: "0.8rem", marginTop: "var(--lp-sp-2)" }}>
          {formatAtomicAmount(accept?.amount)} atomic of {truncateMiddle(accept?.asset || "—")}
        </p>
        <p className="lp-lead" style={{ fontSize: "0.75rem", marginTop: "var(--lp-sp-1)" }}>
          {truncateMiddle(item.resource, 32, 12)}
        </p>
      </div>

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "var(--lp-sp-3)" }}>
        <span className="lp-verified" style={!badge.verified ? { background: "var(--lp-paper-tint)" } : undefined}>
          {badge.verified ? "✓ " : ""}
          {badge.text}
        </span>
        <span style={{ fontSize: "0.75rem", color: "var(--lp-ink-faint)" }}>
          {settlements} settlement{settlements === 1 ? "" : "s"}
        </span>
      </div>

      <CardPayArea
        walletPendingForThis={walletPendingForThis}
        wallet={wallet}
        walletElapsed={walletElapsed}
        pay={pay}
        paramValues={paramValues}
        onParamChange={onParamChange}
        onPayClick={onPayClick}
        onRetryPay={onRetryPay}
        onSubmitParams={onSubmitParams}
      />
    </div>
  );
}

/** The Pay button plus whichever inline state currently applies to this
 *  card: idle Pay button, inline wallet-creation progress (only shown on the
 *  card whose click triggered it), payment-in-progress compact steps, a
 *  success tx hash + explorer link, or an error with Try again. */
function CardPayArea({
  walletPendingForThis,
  wallet,
  walletElapsed,
  pay,
  paramValues,
  onParamChange,
  onPayClick,
  onRetryPay,
  onSubmitParams,
}: {
  walletPendingForThis: boolean;
  wallet: WalletStage;
  walletElapsed: number;
  pay: PayCardState | undefined;
  paramValues: Record<string, string>;
  onParamChange: (key: string, value: string) => void;
  onPayClick: () => void;
  onRetryPay: () => void;
  onSubmitParams: () => void;
}) {
  // 1. This card is the one that triggered wallet creation, and it's still
  // in flight — show the inline provisioning flow right here, per the
  // locked "no navigation away from /catalog" decision.
  if (walletPendingForThis && wallet.status === "loading") {
    return (
      <div>
        <p className="lp-lead" style={{ fontSize: "0.8rem" }}>
          Setting up a wallet first, live ({walletElapsed}s) — your payment will start automatically once
          it&apos;s ready.
        </p>
        <div style={{ marginTop: "var(--lp-sp-3)" }}>
          <CompactStepProgress steps={wallet.steps} />
        </div>
      </div>
    );
  }

  if (walletPendingForThis && wallet.status === "error") {
    return (
      <div>
        <p className="lp-lead" style={{ fontSize: "0.8rem" }}>
          {wallet.message}
        </p>
        <div className="lp-cta-row" style={{ marginTop: "var(--lp-sp-2)" }}>
          <LpActionButton variant="outline" size="sm" onClick={onPayClick}>
            Try again
          </LpActionButton>
        </div>
      </div>
    );
  }

  // Graceful-degradation case: a wallet now exists but USDC provisioning
  // didn't complete, so there's no USDC to pay with. Same wording "/"'s
  // wallet card uses for this exact case.
  if (walletPendingForThis && wallet.status === "ready" && !wallet.wallet.usdcProvisioned && !pay) {
    return (
      <p className="lp-lead" style={{ fontSize: "0.8rem" }}>
        USDC funding didn&apos;t complete — you can still browse the catalog, but paying may not work yet.
      </p>
    );
  }

  // 2. Payment in flight for this card.
  if (pay?.status === "paying") {
    return (
      <div>
        <div className="lp-step-row" data-state="active">
          <span className="lp-step-mark" aria-hidden />
          <span className="lp-step-label">Paying…</span>
        </div>
      </div>
    );
  }

  // 3. Success — the real settlement tx hash + Stellar Expert explorer link.
  if (pay?.status === "success") {
    const explorerUrl = `https://stellar.expert/explorer/testnet/tx/${pay.result.settlementTx}`;
    return (
      <div>
        <div className="lp-step-row" data-state="done">
          <span className="lp-step-mark" aria-hidden />
          <span className="lp-step-label">Paid</span>
        </div>
        <p className="lp-lead" style={{ fontSize: "0.75rem", marginTop: "var(--lp-sp-2)", wordBreak: "break-all" }}>
          {truncateMiddle(pay.result.settlementTx, 14, 8)}
        </p>
        <div className="lp-cta-row" style={{ marginTop: "var(--lp-sp-2)" }}>
          <a className="lp-btn lp-btn--ghost" href={explorerUrl} target="_blank" rel="noreferrer">
            View on Stellar Expert →
          </a>
        </div>
      </div>
    );
  }

  // 3.5. Needs input — the resource 400'd on a blank call. Show its real
  // example query params (from its own Bazaar discovery entry) as a small
  // prefilled form; submitting re-attempts payment with those values
  // appended to the resource URL. See PayCardState's "needs_input" doc
  // comment for why this is only ever entered reactively, never guessed
  // upfront.
  if (pay?.status === "needs_input") {
    const keys = Object.keys(paramValues);
    return (
      <div>
        <p className="lp-lead" style={{ fontSize: "0.8rem" }}>
          This resource needs input to run — fill in the values below and pay again.
        </p>
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--lp-sp-2)", marginTop: "var(--lp-sp-3)" }}>
          {keys.map((key) => (
            <label key={key} style={{ display: "block" }}>
              <span className="lp-eyebrow" style={{ display: "block", marginBottom: "var(--lp-sp-1)", fontSize: "0.68rem" }}>
                {key}
              </span>
              <input
                type="text"
                value={paramValues[key]}
                onChange={(e) => onParamChange(key, e.target.value)}
                className="lp-field"
                style={{ width: "100%", font: "inherit", fontSize: "0.85rem", color: "inherit", display: "block" }}
              />
            </label>
          ))}
        </div>
        <div className="lp-cta-row" style={{ marginTop: "var(--lp-sp-3)" }}>
          <LpActionButton variant="sun" size="sm" onClick={onSubmitParams}>
            Pay with these values →
          </LpActionButton>
        </div>
      </div>
    );
  }

  // 4. Error — human-readable message + Try again, re-runs just this card's
  // payment step (not wallet creation again, since the wallet already
  // exists by this point).
  if (pay?.status === "error") {
    return (
      <div>
        <p className="lp-lead" style={{ fontSize: "0.8rem" }}>
          {pay.message}
        </p>
        <div className="lp-cta-row" style={{ marginTop: "var(--lp-sp-2)" }}>
          <LpActionButton variant="outline" size="sm" onClick={onRetryPay}>
            Try again
          </LpActionButton>
        </div>
      </div>
    );
  }

  // 5. Idle — the default state.
  return (
    <div className="lp-cta-row" style={{ marginTop: 0 }}>
      <LpActionButton variant="sun" size="sm" onClick={onPayClick}>
        Pay →
      </LpActionButton>
    </div>
  );
}
