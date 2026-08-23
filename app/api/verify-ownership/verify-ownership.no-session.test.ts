import { describe, expect, it } from "vitest";
import { GET, POST } from "./route";

// SESSION_SECRET must be set before any imported module reads it — same
// convention as app/api/pay/pay.secret-leak.test.ts, even though THIS route
// never touches the session at all (that is exactly the property being
// asserted here). Set defensively in case a shared test-run process has
// already imported something that reads it eagerly.
process.env.SESSION_SECRET ??= "test-only-session-secret-that-is-at-least-32-chars-long";

/**
 * POST /api/verify-ownership never touches the session — no cookie is read,
 * no secret key is ever in scope. This is the whole point of Station 2's
 * security story (see that route's module doc comment): it operates
 * entirely on public, unauthenticated data (the seller's own 402 challenge,
 * the facilitator's public catalog). Unlike POST /api/pay, this route never
 * imports lib/session.ts anywhere in its module graph — the ONLY thing it
 * reads off the Request now is an opaque `id` string, validated against a
 * closed server-side allow-list (VERIFIABLE_RESOURCES in route.ts), never a
 * cookie. These tests exercise that directly against the real live route
 * (no Set-Cookie header, no secret-shaped bytes anywhere in the stream)
 * rather than merely asserting via source inspection.
 */
async function readNdjsonStream(res: Response): Promise<{ rawText: string; events: Record<string, unknown>[] }> {
  const rawText = await res.clone().text();
  const events = rawText
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  return { rawText, events };
}

describe("POST /api/verify-ownership — no session involvement", () => {
  it(
    "runs the full 5-step live check with NO cookie at all, and reaches a terminal verdict",
    async () => {
      // A bare Request with a JSON body carrying an `id` — no cookie header
      // at all, exercising directly (not just via source inspection) that
      // the route genuinely has nothing to read even if a cookie were
      // present, since it never looks for one.
      const res = await POST(new Request("http://localhost/api/verify-ownership", { method: "POST", body: JSON.stringify({ id: "quote" }) }));

      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("application/x-ndjson");

      const { rawText, events } = await readNdjsonStream(res);
      expect(events.length).toBeGreaterThan(0);
      expect(events.at(-1)?.step).toBe("complete");

      // Never a Set-Cookie header on this route's response — no session was
      // ever created, read, or refreshed.
      expect(res.headers.getSetCookie()).toEqual([]);

      // No event, and no raw stream text, may ever contain session-shaped
      // markers — a Stellar secret key shape, or the literal string
      // "secretKey"/"cookie". This route has no access to either, but this
      // asserts the absence property the same way the other secret-leak
      // tests in this repo do, rather than merely trusting the source code
      // reading.
      const STELLAR_SECRET_KEY_SHAPE = /S[A-Z0-9]{55}/;
      expect(rawText).not.toMatch(STELLAR_SECRET_KEY_SHAPE);
      expect(rawText.toLowerCase()).not.toContain("secretkey");
    },
    // A single seller fetch, bounded by the route's own FETCH_TIMEOUT_MS
    // (90s — see route.ts's own doc comment on why: Render's free tier can
    // take a while to wake a cold instance), plus one catalog fetch. 120s
    // gives real margin above that 90s worst case, the same reasoning
    // pay.secret-leak.test.ts's own 150s already applies to a heavier,
    // multi-step payment cycle against this identical seller.
    120_000,
  );

  it(
    "streams multiple distinct step events over real time (not one buffered chunk)",
    async () => {
      const res = await POST(new Request("http://localhost/api/verify-ownership", { method: "POST", body: JSON.stringify({ id: "quote" }) }));
      expect(res.body).toBeTruthy();

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      const chunkTimestamps: number[] = [];
      let combined = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunkTimestamps.push(Date.now());
        combined += decoder.decode(value, { stream: true });
      }

      // Proves controller.enqueue() is used incrementally as each real step
      // resolves (two real network round trips: the seller GET and the
      // facilitator catalog GET), not one buffered string sent at once.
      expect(chunkTimestamps.length).toBeGreaterThan(1);

      const events = combined
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>);
      expect(events.at(-1)?.step).toBe("complete");

      const stepNames = events.map((e) => e.step);
      for (const step of ["fetch_challenge", "decode_header", "parse_pay_to", "compare_catalog", "verdict"]) {
        expect(stepNames, `expected step "${step}" to appear in the stream`).toContain(step);
      }

      const verdictEvent = events.find((e) => e.step === "verdict");
      expect(verdictEvent?.status).toBe("done");
      expect(typeof verdictEvent?.match).toBe("boolean");
      expect(typeof verdictEvent?.verdictText).toBe("string");
    },
    // A single seller fetch, bounded by the route's own FETCH_TIMEOUT_MS
    // (90s — see route.ts's own doc comment on why: Render's free tier can
    // take a while to wake a cold instance), plus one catalog fetch. 120s
    // gives real margin above that 90s worst case, the same reasoning
    // pay.secret-leak.test.ts's own 150s already applies to a heavier,
    // multi-step payment cycle against this identical seller.
    120_000,
  );

  it(
    "checks a NON-default resource (hash) against the real seller and catalog, resolved from the allow-list",
    async () => {
      // Proves the id -> path resolution genuinely reaches a different real
      // resource, not just always the default "quote" regardless of what's
      // sent — settlementCount/ownershipState will differ from quote's.
      const res = await POST(new Request("http://localhost/api/verify-ownership", { method: "POST", body: JSON.stringify({ id: "hash" }) }));
      expect(res.status).toBe(200);
      const { events } = await readNdjsonStream(res);

      const fetchEvent = events.find((e) => e.step === "fetch_challenge" && e.status === "done");
      expect(typeof fetchEvent?.requestLine).toBe("string");
      expect(fetchEvent?.requestLine as string).toContain("/hash");

      const catalogEvent = events.find((e) => e.step === "compare_catalog" && e.status === "done");
      expect(typeof catalogEvent?.resource).toBe("string");
      expect(catalogEvent?.resource as string).toContain("/hash");

      expect(events.at(-1)?.step).toBe("complete");
    },
    // A single seller fetch, bounded by the route's own FETCH_TIMEOUT_MS
    // (90s — see route.ts's own doc comment on why: Render's free tier can
    // take a while to wake a cold instance), plus one catalog fetch. 120s
    // gives real margin above that 90s worst case, the same reasoning
    // pay.secret-leak.test.ts's own 150s already applies to a heavier,
    // multi-step payment cycle against this identical seller.
    120_000,
  );

  it("falls back to the default resource for an id outside the allow-list — never passes it through as a path", async () => {
    // The whole security property this route depends on: an unrecognized id
    // must NOT reach the fetch as a raw path/URL — it silently falls back
    // to the default rather than erroring OR (the actually dangerous
    // failure mode) fetching whatever string was sent.
    const res = await POST(
      new Request("http://localhost/api/verify-ownership", {
        method: "POST",
        body: JSON.stringify({ id: "http://169.254.169.254/latest/meta-data/" }),
      }),
    );
    expect(res.status).toBe(200);
    const { events } = await readNdjsonStream(res);
    const fetchEvent = events.find((e) => e.step === "fetch_challenge" && e.status === "done");
    expect(typeof fetchEvent?.requestLine).toBe("string");
    // Fell back to the default ("quote"), never fetched the malicious id.
    expect(fetchEvent?.requestLine as string).toContain("/quote");
    expect(fetchEvent?.requestLine as string).not.toContain("169.254.169.254");
  });

  it("rejects GET with 405, since a fresh live check is a POST-shaped action", async () => {
    const res = await GET();
    expect(res.status).toBe(405);
    const body = await res.json();
    expect(body.error).toBe("method_not_allowed");
  });
});
