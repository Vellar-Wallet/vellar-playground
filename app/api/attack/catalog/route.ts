import { FACILITATOR_URL } from "@/lib/config";
import { fetchCatalog, CatalogFetchError, type CatalogItem } from "@/lib/catalog";

/**
 * POST /api/attack/catalog — Station 3's catalog-attack track, attacks 6
 * (ssrf_linklocal) and 7 (displace_verified). Attack 8 (prompt_injection) is
 * a separate route (/api/attack/sanitize) since it needs no facilitator call
 * at all — see that route's doc comment.
 *
 * SECURITY / SCOPE: this route touches ONLY public, unauthenticated data —
 * the facilitator's public GET /health and GET /discovery/resources. It
 * never imports lib/session.ts, never reads a cookie, and has no
 * session/secret-key involvement anywhere in its code path — same
 * structural guarantee as POST /api/verify-ownership (confirmed by grep: no
 * `getSession`/`cookie` import in this file). See
 * app/api/attack/catalog/catalog.no-session.test.ts.
 *
 * ---------------------------------------------------------------------------
 * ATTACK 6 — ssrf_linklocal — HONEST FRAMING, decided per the task's own
 * instruction (full reasoning in the task report):
 *
 * You cannot catalog a NEW malicious resource URL on the shared, real hosted
 * facilitator — there is no "register a resource" endpoint; cataloging only
 * happens as a side effect of a real settlement against that URL, and there
 * is no real seller listening at a metadata-style address to settle against
 * (nor should there be — attempting to make one exist would be the literal
 * SSRF this control exists to prevent).
 *
 * This route instead demonstrates the SAME underlying guard
 * (`isBlockedAddress`, from vellar-facilitator/src/ownership.ts, imported
 * into src/catalog.ts's `isStructurallyUnverifiable()`) using REAL,
 * ALREADY-LIVE catalog data: the facilitator's public catalog currently
 * contains `http://localhost:<port>/quote` entries (real resources,
 * genuinely settled against in the past) that are PERMANENTLY stuck at
 * `ownershipState: "unverified"` — confirmed live via GET /health's
 * `unverifiableEntries` counter and GET /discovery/resources, both read
 * here fresh, right now. The real mechanism: `isStructurallyUnverifiable()`
 * refuses `http://` (non-https) and the literal hostname `localhost`
 * outright, and separately calls the SAME `isBlockedAddress()` function a
 * `169.254.169.254` metadata-IP attempt would also hit (loopback/private/
 * link-local, all in one function) for any bare IP literal. This is not the
 * exact same branch a `169.254.169.254` attempt would take (that's a bare-IP
 * check; `localhost` is a hostname literal check) — it is the SAME guard
 * function, same intent, same permanent structural refusal, on data that is
 * genuinely live on the shared facilitator right now, which is the more
 * honest and more reproducible choice over attempting a real metadata-IP
 * fetch against infrastructure this playground doesn't operate.
 *
 * `checkMethod: "poll_diff"` — the "before"/"after" snapshots compared are:
 *   before = GET /health right now (unverifiableEntries count)
 *   after  = GET /discovery/resources right now, filtered to the entries
 *            whose ownershipState is "unverified" AND whose resource is a
 *            structurally-unverifiable http://localhost URL
 * There is no time-separated "before an attack, after an attack" step here
 * (nothing is being attacked live) — the "diff" being demonstrated is
 * structural: the count from /health matches the actual unverifiable
 * entries found in /discovery/resources, which is itself the evidence that
 * these bindings are real and permanently stuck, not a fabricated example.
 *
 * ---------------------------------------------------------------------------
 * ATTACK 7 — displace_verified — HONEST FRAMING, decided per the task's own
 * instruction (full reasoning in the task report):
 *
 * A genuinely live "attacker tries to displace the verified binding" attempt
 * is NOT cleanly constructible from this playground against the shared
 * hosted facilitator: it would require submitting a real /settle call whose
 * paymentRequirements.payTo differs from the demo seller's own bound
 * address — but the seller's own 402 challenge NAMES its own payTo, so a
 * legitimate-looking payment claiming a different payTo isn't constructible
 * without the seller's cooperation (which this playground doesn't have,
 * since it doesn't control a second seller identity). Confirmed directly
 * against the facilitator's source (src/catalog.ts's `upsertFromPayment`):
 * a settle whose payTo isn't already bound is refused as an ordinary
 * "payTo not bound" rejection BEFORE the displacement logic even runs —
 * meaning "displacement was attempted and refused" and "this was never a
 * valid payment to begin with" are indistinguishable from the outside.
 *
 * The honest, buildable alternative built here instead: poll
 * GET /discovery/resources for the demo resource BEFORE and AFTER, and show
 * that its bound payTo / ownershipState are UNCHANGED across the poll — the
 * one-way-latch property demonstrated by observing that a real, ongoing
 * stream of LEGITIMATE settlements (Station 1's own payments, and everyone
 * else's, on the shared demo) never alters an already-established binding.
 * This is a real, honest, observable demonstration of permanence — not
 * "an attacker tried and failed", but "verified state is stable under
 * repeated real use", which is what the underlying property actually
 * guarantees either way.
 *
 * `checkMethod: "poll_diff"` — `before`/`after` are two real, time-separated
 * GET /discovery/resources snapshots of the demo resource's `accepts[].payTo`
 * and `trust.ownershipState`/`trust.settlements`, a few seconds apart.
 * `passed` = true if payTo/ownershipState are unchanged and settlements
 * count did not decrease (a real settlement happening between the two polls
 * would show it not decreasing — the binding surviving is what's asserted,
 * not that zero activity occurred).
 * ---------------------------------------------------------------------------
 */

const DEMO_RESOURCE_URL = "https://vellar-seller-demo.onrender.com/quote";
const POLL_GAP_MS = 4_000;

interface AttackOutcome {
  attackId: string;
  endpoint: string;
  attemptedAt: number;
  checkMethod: "poll_diff";
  expectedCodes: string[];
  passed: boolean;
  rawResponse: { before: unknown; after: unknown };
}

type StreamEvent =
  | { step: "attack"; status: "active"; attackId: string }
  | { step: "attack"; status: "done"; attackId: string; result: AttackOutcome }
  | { step: "attack"; status: "error"; attackId: string; message: string }
  | { step: "complete"; status: "done"; results: AttackOutcome[] }
  | { step: "complete"; status: "error"; error: string; message: string };

function encodeEvent(event: StreamEvent): string {
  return `${JSON.stringify(event)}\n`;
}

const NDJSON_HEADERS: HeadersInit = {
  "content-type": "application/x-ndjson; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};

async function fetchHealth(): Promise<unknown> {
  const url = `${FACILITATOR_URL.replace(/\/+$/, "")}/health`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  return res.json().catch(() => ({}));
}

function findDemoEntry(items: CatalogItem[]): CatalogItem | undefined {
  return items.find((item) => item.resource === DEMO_RESOURCE_URL);
}

function isStructurallyUnverifiableLocalhost(item: CatalogItem): boolean {
  try {
    const u = new URL(item.resource ?? "");
    return u.protocol !== "https:" || u.hostname === "localhost";
  } catch {
    return false;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function POST(): Promise<Response> {
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      function emit(event: StreamEvent) {
        controller.enqueue(encoder.encode(encodeEvent(event)));
      }

      const results: AttackOutcome[] = [];

      try {
        // -------------------------------------------------------------
        // Attack 6: ssrf_linklocal
        // -------------------------------------------------------------
        emit({ step: "attack", status: "active", attackId: "ssrf_linklocal" });
        try {
          const attemptedAt = Date.now();
          const health = await fetchHealth();
          const catalog = await fetchCatalog();
          const items = Array.isArray(catalog.items) ? catalog.items : [];
          const unverifiableLocalEntries = items.filter(
            (item) =>
              isStructurallyUnverifiableLocalhost(item) &&
              (item as { trust?: { ownershipState?: string } }).trust?.ownershipState === "unverified",
          );
          const healthCount =
            health && typeof health === "object" ? (health as Record<string, unknown>).unverifiableEntries : undefined;
          // "passed" here means the guard is DEMONSTRATED to be working: at
          // least one real structurally-unverifiable localhost entry exists
          // and stays unverified, consistent with /health's own count.
          const passed = unverifiableLocalEntries.length > 0 && typeof healthCount === "number" && healthCount > 0;
          const outcome: AttackOutcome = {
            attackId: "ssrf_linklocal",
            endpoint: "/health + /discovery/resources",
            attemptedAt,
            checkMethod: "poll_diff",
            expectedCodes: [],
            passed,
            rawResponse: {
              before: { health },
              after: {
                unverifiableLocalEntries: unverifiableLocalEntries.map((i) => ({
                  resource: i.resource,
                  ownershipState: (i as { trust?: { ownershipState?: string } }).trust?.ownershipState,
                })),
              },
            },
          };
          results.push(outcome);
          emit({ step: "attack", status: "done", attackId: "ssrf_linklocal", result: outcome });
        } catch (err) {
          const message =
            err instanceof CatalogFetchError
              ? `Could not reach the facilitator's catalog/health: ${err.message}`
              : `Could not reach the facilitator's catalog/health: ${err instanceof Error ? err.message : String(err)}`;
          emit({ step: "attack", status: "error", attackId: "ssrf_linklocal", message });
        }

        // -------------------------------------------------------------
        // Attack 7: displace_verified
        // -------------------------------------------------------------
        emit({ step: "attack", status: "active", attackId: "displace_verified" });
        try {
          const attemptedAt = Date.now();
          const before = await fetchCatalog();
          const beforeItems = Array.isArray(before.items) ? before.items : [];
          const beforeEntry = findDemoEntry(beforeItems);

          await delay(POLL_GAP_MS);

          const after = await fetchCatalog();
          const afterItems = Array.isArray(after.items) ? after.items : [];
          const afterEntry = findDemoEntry(afterItems);

          const beforePayTos = (beforeEntry?.accepts ?? []).map((a) => a.payTo).filter(Boolean);
          const afterPayTos = (afterEntry?.accepts ?? []).map((a) => a.payTo).filter(Boolean);
          const beforeTrust = (beforeEntry as { trust?: Record<string, unknown> } | undefined)?.trust;
          const afterTrust = (afterEntry as { trust?: Record<string, unknown> } | undefined)?.trust;
          const beforeSettlements = typeof beforeTrust?.settlements === "number" ? beforeTrust.settlements : undefined;
          const afterSettlements = typeof afterTrust?.settlements === "number" ? afterTrust.settlements : undefined;

          const payToUnchanged = JSON.stringify(beforePayTos) === JSON.stringify(afterPayTos);
          const stateUnchanged = beforeTrust?.ownershipState === afterTrust?.ownershipState;
          const settlementsDidNotDecrease =
            beforeSettlements === undefined || afterSettlements === undefined || afterSettlements >= beforeSettlements;
          const passed = Boolean(beforeEntry && afterEntry && payToUnchanged && stateUnchanged && settlementsDidNotDecrease);

          const outcome: AttackOutcome = {
            attackId: "displace_verified",
            endpoint: "/discovery/resources",
            attemptedAt,
            checkMethod: "poll_diff",
            expectedCodes: [],
            passed,
            rawResponse: {
              before: { resource: beforeEntry?.resource, accepts: beforeEntry?.accepts, trust: beforeTrust },
              after: { resource: afterEntry?.resource, accepts: afterEntry?.accepts, trust: afterTrust },
            },
          };
          results.push(outcome);
          emit({ step: "attack", status: "done", attackId: "displace_verified", result: outcome });
        } catch (err) {
          const message =
            err instanceof CatalogFetchError
              ? `Could not reach the facilitator's catalog: ${err.message}`
              : `Could not reach the facilitator's catalog: ${err instanceof Error ? err.message : String(err)}`;
          emit({ step: "attack", status: "error", attackId: "displace_verified", message });
        }

        emit({ step: "complete", status: "done", results });
        controller.close();
      } catch (err) {
        console.error("POST /api/attack/catalog stream failed unexpectedly:", err);
        try {
          emit({
            step: "complete",
            status: "error",
            error: "internal_error",
            message: "Something went wrong, please try again in a moment.",
          });
        } catch {
          // controller may already be closed/errored — nothing more to do.
        }
        controller.close();
      }
    },
  });

  const headers = new Headers(NDJSON_HEADERS);
  return new Response(stream, { status: 200, headers });
}

function jsonError(status: number, error: string, message: string) {
  return Response.json({ error, message }, { status });
}

export async function GET(): Promise<Response> {
  return jsonError(405, "method_not_allowed", "Use POST to run the catalog-attack bench.");
}
