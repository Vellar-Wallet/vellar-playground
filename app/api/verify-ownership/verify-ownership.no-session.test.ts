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
 * the facilitator's public catalog). Unlike POST /api/pay, the exported
 * handler here takes no Request argument at all (see route.ts's
 * `export async function POST(): Promise<Response>`) — there is
 * structurally no cookie for it to read, which these tests exercise
 * directly against the real live route rather than merely asserting via
 * source inspection.
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
      // POST() takes no Request argument at all (see route.ts) — there is
      // structurally no way for this handler to read a cookie even if it
      // wanted to, which this test exercises directly rather than merely
      // asserting via source inspection.
      const res = await POST();

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
    30_000,
  );

  it(
    "streams multiple distinct step events over real time (not one buffered chunk)",
    async () => {
      const res = await POST();
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
    30_000,
  );

  it("rejects GET with 405, since a fresh live check is a POST-shaped action", async () => {
    const res = await GET();
    expect(res.status).toBe(405);
    const body = await res.json();
    expect(body.error).toBe("method_not_allowed");
  });
});
