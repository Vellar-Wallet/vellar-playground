import { unsealData } from "iron-session";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getIronSessionOptions, type SessionData } from "@/lib/session";
import { GET } from "./route";
import { POST } from "./create/route";

// The single most important property of Step 2: no code path — success,
// friendbot failure, or an unexpected exception — may ever put the secret
// key anywhere an HTTP caller can see it (response body, in particular).
//
// POST /api/session/create now streams newline-delimited JSON (NDJSON)
// events instead of a single JSON body (see that route's wire-format doc
// comment). This test reads the FULL stream to completion, collects every
// emitted line, and asserts the secret key never appears in ANY of them —
// not just a final line — since there are now several emission points
// (keypair/friendbot/trustline/usdc_purchase/complete) instead of one.
//
// SESSION_SECRET must be set before any of the modules under test read it
// (lib/session.ts validates it eagerly inside getIronSessionOptions()).
process.env.SESSION_SECRET ??= "test-only-session-secret-that-is-at-least-32-chars-long";

const STELLAR_SECRET_KEY_SHAPE = /^S[A-Z0-9]{55}$/;

function cookieHeaderFromSetCookie(setCookieValues: string[], cookieName: string): string | undefined {
  const match = setCookieValues.find((v) => v.startsWith(`${cookieName}=`));
  if (!match) return undefined;
  // Everything up to the first ";" is "name=value" — exactly what a browser
  // would send back in a subsequent request's Cookie header.
  return match.split(";")[0];
}

async function readSealedSessionFromSetCookie(setCookieValues: string[]): Promise<SessionData | null> {
  const options = getIronSessionOptions();
  const cookieHeader = cookieHeaderFromSetCookie(setCookieValues, options.cookieName);
  if (!cookieHeader) return null;
  const sealValue = decodeURIComponent(cookieHeader.slice(options.cookieName.length + 1));
  if (!sealValue) return null; // an empty value means the cookie was cleared, not set
  return unsealData<SessionData>(sealValue, { password: options.password });
}

function makeRequest(url: string, init?: RequestInit, cookie?: string, ip?: string): Request {
  const headers = new Headers(init?.headers);
  if (cookie) headers.set("cookie", cookie);
  // Every test gets its own synthetic client IP (unless it deliberately wants
  // to share one, e.g. to test the "one session per IP" cookie hand-off).
  // Without this, all these tests share the "unknown" fallback IP the real
  // route falls back to when x-forwarded-for is absent (see lib/ip.ts) and
  // would trip over each other via the module-level rate-limit/session-by-IP
  // maps, since route.ts/create/route.ts are each imported once per file.
  headers.set("x-forwarded-for", ip ?? `203.0.113.${Math.floor(Math.random() * 200) + 1}`);
  return new Request(url, { ...init, headers });
}

/**
 * Recursively asserts a value (typically a parsed JSON event) never contains
 * a key literally named "secretKey" anywhere in its structure.
 */
function assertNoSecretKeyField(value: unknown, path = "$"): void {
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoSecretKeyField(v, `${path}[${i}]`));
    return;
  }
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    expect(key, `found forbidden key "secretKey" at ${path}.${key}`).not.toBe("secretKey");
    assertNoSecretKeyField(val, `${path}.${key}`);
  }
}

/**
 * Reads a streamed NDJSON Response (POST /api/session/create's response
 * shape) fully to completion, returning:
 *  - `rawText`: the entire raw response body, concatenated, exactly as
 *    transmitted — used for substring/regex leak checks across the WHOLE
 *    stream, not just one parsed event.
 *  - `events`: each line parsed as JSON (blank lines skipped), in emission
 *    order — used to assert structural properties (no `secretKey` key) on
 *    every individual event, and to find the terminal "complete" event.
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

function findCompleteEvent(events: Record<string, unknown>[]): Record<string, unknown> | undefined {
  return events.find((e) => e.step === "complete");
}

describe("secret key never leaks via the session API", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  // Real flow: real friendbot, real Horizon. Slower and network-dependent,
  // but this is the deliverable the task calls out as most important, so we
  // exercise the true end-to-end path rather than mocking it away.
  describe("success path (real friendbot + Horizon)", () => {
    it(
      "POST /api/session/create stream never contains the secret key in any event",
      async () => {
        const req = makeRequest("http://localhost/api/session/create", { method: "POST" });
        const res = await POST(req);

        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toContain("application/x-ndjson");

        const { rawText, events } = await readNdjsonStream(res);

        // The stream must carry at least one event, and its LAST event must
        // be the terminal "complete" event.
        expect(events.length).toBeGreaterThan(0);
        expect(events.at(-1)?.step).toBe("complete");

        const complete = findCompleteEvent(events);
        expect(complete?.status).toBe("done");
        const result = complete?.result as { publicKey?: string } | undefined;
        expect(result?.publicKey).toBeDefined();

        // Assert the secret-key absence property across EVERY individual
        // event object, not just the final one — this is the point of
        // re-verifying this test for the streaming shape: there are now
        // several emission points (keypair/friendbot/trustline/
        // usdc_purchase/complete), any one of which could theoretically leak.
        for (const event of events) {
          assertNoSecretKeyField(event);
        }

        // And across the raw, concatenated stream text as a whole — catches
        // a leak that might not parse as clean per-line JSON (e.g. embedded
        // in a message string spanning what look like line boundaries).
        expect(rawText).not.toMatch(STELLAR_SECRET_KEY_SHAPE);
        expect(rawText.includes("secretKey")).toBe(false);

        // Recover the REAL secret directly from the sealed cookie (never from
        // the HTTP response) and confirm it's genuinely absent from the
        // stream.
        const setCookie = res.headers.getSetCookie();
        expect(setCookie.length, "expected a session cookie to be set on success").toBeGreaterThan(0);
        const session = await readSealedSessionFromSetCookie(setCookie);
        expect(session?.secretKey).toBeDefined();
        expect(session!.secretKey!).toMatch(STELLAR_SECRET_KEY_SHAPE);
        expect(rawText).not.toContain(session!.secretKey!);

        // Follow up with GET /api/session using the real cookie and assert
        // the same absence there.
        const cookieHeader = cookieHeaderFromSetCookie(setCookie, getIronSessionOptions().cookieName)!;
        const getReq = makeRequest("http://localhost/api/session", { method: "GET" }, cookieHeader);
        const getRes = await GET(getReq);
        const getRawText = await getRes.clone().text();
        const getBody = JSON.parse(getRawText);

        expect(getRes.status).toBe(200);
        expect(getBody.publicKey).toBe(session!.publicKey);
        assertNoSecretKeyField(getBody);
        expect(getRawText).not.toMatch(STELLAR_SECRET_KEY_SHAPE);
        expect(getRawText).not.toContain(session!.secretKey!);
        expect(getRawText.includes("secretKey")).toBe(false);
      },
      // POST /api/session/create now does real work beyond friendbot: a
      // catalog price lookup, then a classic-Horizon USDC trustline open +
      // DEX path-payment purchase (lib/usdc.ts), each bounded at
      // SUBMIT_TIMEOUT_SECONDS=35s worst case, sequentially — so the call
      // can legitimately take upwards of a minute on a slow testnet day.
      // 120s gives real margin above that worst case rather than a value
      // that just barely covers the happy path.
      120_000,
    );

    it(
      "streams multiple distinct step events over real time (not one buffered chunk)",
      async () => {
        // Reinforces that this is a genuine stream, not a JSON body dressed
        // up in NDJSON framing: reads the ReadableStream incrementally via
        // its reader (the same API the browser client uses) and records a
        // timestamp each time a new chunk of bytes arrives. A real stream
        // must show more than one distinct read (keypair/friendbot/
        // trustline/usdc_purchase/complete don't all resolve in the same
        // microtask), which a fully-buffered-then-sent response could not.
        const req = makeRequest("http://localhost/api/session/create", { method: "POST" });
        const res = await POST(req);
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

        // At minimum this proves the handler is actually using
        // controller.enqueue() incrementally rather than building one string
        // and calling it once — vitest/undici's ReadableStream plumbing
        // still delivers each enqueue() as its own read() resolution.
        expect(chunkTimestamps.length).toBeGreaterThan(1);

        const events = combined
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean)
          .map((l) => JSON.parse(l) as Record<string, unknown>);
        for (const event of events) {
          assertNoSecretKeyField(event);
        }
        expect(combined).not.toMatch(STELLAR_SECRET_KEY_SHAPE);
      },
      120_000,
    );
  });

  describe("friendbot failure path (mocked — no real network failure needed)", () => {
    it("returns a terminal error event with no secret leak and writes NO session cookie", async () => {
      const realFetch = global.fetch;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = typeof input === "string" ? input : input.toString();
          if (url.includes("friendbot.stellar.org")) {
            return new Response("service unavailable", { status: 503 });
          }
          return realFetch(input, init);
        }),
      );

      const req = makeRequest("http://localhost/api/session/create", { method: "POST" });
      const res = await POST(req);
      const { rawText, events } = await readNdjsonStream(res);

      // The route responds 200 at the HTTP-transport level (the failure is
      // reported as a "complete"/"error" event within the stream, since a
      // streaming response has already committed to a 200 status before any
      // provisioning has happened) — the meaningful status lives in the
      // terminal event, asserted below.
      expect(res.status).toBe(200);

      const complete = findCompleteEvent(events);
      expect(complete?.step).toBe("complete");
      expect(complete?.status).toBe("error");
      expect(complete?.error).toBe("funding_failed");
      // Human-readable, not a raw technical string.
      expect(complete?.message).toBeTruthy();
      expect(String(complete?.message).toLowerCase()).not.toContain("econnrefused");
      expect(String(complete?.message).toLowerCase()).not.toContain("fetch failed");

      // A "friendbot" step event with status "error" should also have been
      // emitted before the terminal complete event.
      // There are TWO "friendbot" events (active, then error) — find the
      // terminal one specifically rather than the first match.
      const friendbotErrorEvent = events.find((e) => e.step === "friendbot" && e.status === "error");
      expect(friendbotErrorEvent).toBeDefined();

      for (const event of events) {
        assertNoSecretKeyField(event);
      }
      expect(rawText).not.toMatch(STELLAR_SECRET_KEY_SHAPE);
      expect(rawText.includes("secretKey")).toBe(false);

      // No session cookie should have been written for an unfunded wallet.
      const setCookie = res.headers.getSetCookie();
      expect(setCookie.length).toBe(0);
    });

    it("a friendbot timeout is handled the same way as any other failure (no leak, no cookie)", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL) => {
          const url = typeof input === "string" ? input : input.toString();
          if (url.includes("friendbot.stellar.org")) {
            // Simulate what AbortSignal.timeout() produces: an aborted fetch.
            throw new DOMException("The operation was aborted.", "AbortError");
          }
          throw new Error(`unexpected fetch to ${url}`);
        }),
      );

      const req = makeRequest("http://localhost/api/session/create", { method: "POST" });
      const res = await POST(req);
      const { rawText, events } = await readNdjsonStream(res);

      expect(res.status).toBe(200);
      const complete = findCompleteEvent(events);
      expect(complete?.status).toBe("error");
      expect(complete?.error).toBe("funding_failed");
      for (const event of events) {
        assertNoSecretKeyField(event);
      }
      expect(rawText).not.toMatch(STELLAR_SECRET_KEY_SHAPE);
      expect(res.headers.getSetCookie().length).toBe(0);
    });
  });

  describe("GET /api/session error paths", () => {
    it("401s with no secret leak when there is no cookie at all", async () => {
      const req = makeRequest("http://localhost/api/session", { method: "GET" });
      const res = await GET(req);
      const rawText = await res.clone().text();
      const body = JSON.parse(rawText);

      expect(res.status).toBe(401);
      expect(body.error).toBe("no_session");
      assertNoSecretKeyField(body);
      expect(rawText).not.toMatch(STELLAR_SECRET_KEY_SHAPE);
    });

    it("401s with no secret leak when the cookie is garbage/unparseable", async () => {
      const options = getIronSessionOptions();
      const req = makeRequest(
        "http://localhost/api/session",
        { method: "GET" },
        `${options.cookieName}=not-a-real-sealed-value`,
      );
      const res = await GET(req);
      const rawText = await res.clone().text();
      const body = JSON.parse(rawText);

      expect(res.status).toBe(401);
      assertNoSecretKeyField(body);
      expect(rawText).not.toMatch(STELLAR_SECRET_KEY_SHAPE);
    });
  });
});
