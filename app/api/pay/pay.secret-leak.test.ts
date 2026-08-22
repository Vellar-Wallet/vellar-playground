import { sealData, unsealData } from "iron-session";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getIronSessionOptions, type SessionData } from "@/lib/session";
import { POST as createSession } from "@/app/api/session/create/route";
import { POST } from "./route";

// The single most important property of this route, same standard as every
// prior step in this build: no code path — success, a forced retry, or an
// unexpected exception — may ever put the secret key anywhere an HTTP caller
// can see it (response body, in particular).
//
// POST /api/pay now streams newline-delimited JSON (NDJSON) events instead
// of a single JSON body (see that route's wire-format doc comment). This
// test reads the FULL stream to completion, collects every emitted line,
// and asserts the secret key never appears in ANY of them — not just a
// final line — since there are now several emission points per attempt
// (get_request/challenge/sign/verify/settle/result/complete), and up to 3
// attempts on a forced retry.
//
// SESSION_SECRET must be set before any of the modules under test read it
// (lib/session.ts validates it eagerly inside getIronSessionOptions()).
process.env.SESSION_SECRET ??= "test-only-session-secret-that-is-at-least-32-chars-long";

const STELLAR_SECRET_KEY_SHAPE = /^S[A-Z0-9]{55}$/;

function cookieHeaderFromSetCookie(setCookieValues: string[], cookieName: string): string | undefined {
  const match = setCookieValues.find((v) => v.startsWith(`${cookieName}=`));
  if (!match) return undefined;
  return match.split(";")[0];
}

function makeRequest(url: string, init?: RequestInit, cookie?: string, ip?: string): Request {
  const headers = new Headers(init?.headers);
  if (cookie) headers.set("cookie", cookie);
  // Every test gets its own synthetic client IP — see
  // session.secret-leak.test.ts's identical rationale: without this, the
  // module-level rate-limit/session-by-IP maps in the imported route
  // modules would let tests trip over each other.
  headers.set("x-forwarded-for", ip ?? `198.51.100.${Math.floor(Math.random() * 200) + 1}`);
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

/** Reads a streamed NDJSON Response fully to completion, same helper shape
 *  as session.secret-leak.test.ts's readNdjsonStream. */
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

/**
 * Provisions a real, USDC-funded testnet session via the existing (untouched)
 * POST /api/session/create streaming flow — the same proven path
 * session.secret-leak.test.ts's own success-path test exercises — and
 * returns both the cookie header a browser would send back and the real
 * secret key (read directly from the sealed cookie, never from any response
 * body) for later leak-comparison.
 */
async function provisionFundedSession(): Promise<{ cookieHeader: string; secretKey: string; publicKey: string }> {
  const req = makeRequest("http://localhost/api/session/create", { method: "POST" });
  const res = await createSession(req);
  expect(res.status).toBe(200);

  const setCookie = res.headers.getSetCookie();
  expect(setCookie.length, "expected a session cookie to be set for a funded wallet").toBeGreaterThan(0);

  const options = getIronSessionOptions();
  const cookieHeader = cookieHeaderFromSetCookie(setCookie, options.cookieName)!;
  const sealValue = decodeURIComponent(cookieHeader.slice(options.cookieName.length + 1));
  const session = await unsealData<SessionData>(sealValue, { password: options.password });

  expect(session.secretKey).toBeDefined();
  expect(session.secretKey!).toMatch(STELLAR_SECRET_KEY_SHAPE);

  // Confirm USDC provisioning actually completed — a payment test is
  // meaningless against a wallet with no USDC to build a payload against.
  const rawText = await res.clone().text();
  const events = rawText
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
  const complete = events.find((e) => e.step === "complete") as
    | { result?: { usdcProvisioned?: boolean } }
    | undefined;
  if (!complete?.result?.usdcProvisioned) {
    throw new Error(
      "Test precondition failed: the provisioned session wallet has no USDC (usdcProvisioned=false). " +
        "Cannot exercise a real payment without funds — this indicates a testnet/DEX issue, not a bug in " +
        "the code under test.",
    );
  }

  return { cookieHeader, secretKey: session.secretKey!, publicKey: session.publicKey! };
}

describe("secret key never leaks via POST /api/pay", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  // Real flow: a real funded session, a real payment against the live demo
  // seller/facilitator on testnet. Slower and network-dependent, but this is
  // the deliverable this task calls out as most important, so we exercise
  // the true end-to-end path rather than mocking it away.
  describe("success path (real seller + facilitator)", () => {
    it(
      "POST /api/pay stream never contains the secret key in any event, across all six steps",
      async () => {
        const { cookieHeader, secretKey } = await provisionFundedSession();

        const req = makeRequest(
          "http://localhost/api/pay",
          { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) },
          cookieHeader,
        );
        const res = await POST(req);

        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toContain("application/x-ndjson");

        const { rawText, events } = await readNdjsonStream(res);

        expect(events.length).toBeGreaterThan(0);
        expect(events.at(-1)?.step).toBe("complete");

        const stepNames = events.map((e) => e.step);
        // All six real steps must appear at least once on a successful run.
        for (const step of ["get_request", "challenge", "sign", "verify", "settle", "result"]) {
          expect(stepNames, `expected step "${step}" to appear in the stream`).toContain(step);
        }

        const complete = findCompleteEvent(events);
        expect(complete?.status).toBe("done");
        const result = complete?.result as { settlementTx?: string } | undefined;
        expect(result?.settlementTx).toBeTruthy();

        // Assert the secret-key absence property across EVERY individual
        // event object, not just the final one.
        for (const event of events) {
          assertNoSecretKeyField(event);
        }

        // And across the raw, concatenated stream text as a whole — catches
        // a leak that might not parse as clean per-line JSON.
        expect(rawText).not.toMatch(STELLAR_SECRET_KEY_SHAPE);
        expect(rawText.includes("secretKey")).toBe(false);
        // Direct substring check against the REAL secret recovered from the
        // sealed cookie (never from any /api/pay response) — the strongest
        // possible assertion short of the regex above.
        expect(rawText).not.toContain(secretKey);
      },
      // A funded-session provision (friendbot + trustline + DEX purchase)
      // plus a real GET->402->sign->settle payment cycle, each individually
      // bounded well under a minute — 150s gives real margin above the
      // worst-case sum rather than a value that just barely covers it.
      150_000,
    );

    it(
      "streams multiple distinct step events over real time (not one buffered chunk)",
      async () => {
        const { cookieHeader, secretKey } = await provisionFundedSession();

        const req = makeRequest(
          "http://localhost/api/pay",
          { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) },
          cookieHeader,
        );
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

        // Proves the handler is genuinely using controller.enqueue()
        // incrementally as each real step resolves, not building one string
        // and sending it once — get_request/sign/settle each involve a real
        // network round trip that cannot resolve in the same microtask.
        expect(chunkTimestamps.length).toBeGreaterThan(1);

        const events = combined
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean)
          .map((l) => JSON.parse(l) as Record<string, unknown>);
        expect(events.at(-1)?.step).toBe("complete");
        for (const event of events) {
          assertNoSecretKeyField(event);
        }
        expect(combined).not.toMatch(STELLAR_SECRET_KEY_SHAPE);
        expect(combined).not.toContain(secretKey);
      },
      150_000,
    );
  });

  describe("forced retry path (mocked flakiness — no real settle failure needed)", () => {
    it(
      "a mocked not_settled failure on the first attempt triggers a real retry cycle, with no secret leak across it",
      async () => {
        const { cookieHeader, secretKey, publicKey } = await provisionFundedSession();

        // Intercept just the PAID retry request (the one carrying a
        // PAYMENT-SIGNATURE header) on the FIRST attempt only, forcing it to
        // look like the flaky "HTTP 200 but no settlement transaction"
        // case documented in lib/pay.ts / buyer-classic.mjs. Every other
        // fetch (the unpaid GET, and the second attempt's paid retry) passes
        // through to the real network untouched, so this still exercises a
        // real second attempt end-to-end.
        const realFetch = global.fetch;
        let paidAttempts = 0;
        vi.stubGlobal(
          "fetch",
          vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const headers = new Headers(init?.headers);
            const isPaidRetry = headers.has("payment-signature") || headers.has("PAYMENT-SIGNATURE");
            if (isPaidRetry) {
              paidAttempts += 1;
              if (paidAttempts === 1) {
                // Simulate the documented flaky-testnet case: HTTP 200, empty
                // settlement — attemptPayment() must classify this as
                // "not_settled" and the route must retry.
                return new Response(JSON.stringify({ settlement: {} }), {
                  status: 200,
                  headers: { "content-type": "application/json" },
                });
              }
            }
            return realFetch(input, init);
          }),
        );

        const req = makeRequest(
          "http://localhost/api/pay",
          { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) },
          cookieHeader,
        );
        const res = await POST(req);
        const { rawText, events } = await readNdjsonStream(res);

        expect(res.status).toBe(200);

        // A "retry" marker event for attempt 2 must have been emitted — this
        // is the visible, honest "whole flow restarted" signal.
        const retryEvent = events.find((e) => e.step === "retry");
        expect(retryEvent).toBeDefined();
        expect(retryEvent?.attempt).toBe(2);

        // The first attempt's settle step must show as an error.
        const failedSettle = events.find((e) => e.step === "settle" && e.status === "error" && e.attempt === 1);
        expect(failedSettle).toBeDefined();

        // Regardless of whether attempt 2 itself succeeds (real testnet
        // settle — not mocked), the secret key must never appear anywhere
        // across the WHOLE stream, across both attempts.
        for (const event of events) {
          assertNoSecretKeyField(event);
        }
        expect(rawText).not.toMatch(STELLAR_SECRET_KEY_SHAPE);
        expect(rawText.includes("secretKey")).toBe(false);
        expect(rawText).not.toContain(secretKey);
        // publicKey is not secret and may legitimately appear (e.g. in the
        // "settle"/"done" event's payer field) — no assertion needed either
        // way, just documenting that its presence would be fine.
        void publicKey;
      },
      150_000,
    );
  });

  describe("error paths (no session)", () => {
    it("401s with no secret leak when there is no cookie at all", async () => {
      const req = makeRequest("http://localhost/api/pay", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      const res = await POST(req);
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
        "http://localhost/api/pay",
        { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) },
        `${options.cookieName}=not-a-real-sealed-value`,
      );
      const res = await POST(req);
      const rawText = await res.clone().text();
      const body = JSON.parse(rawText);

      expect(res.status).toBe(401);
      assertNoSecretKeyField(body);
      expect(rawText).not.toMatch(STELLAR_SECRET_KEY_SHAPE);
    });

    it("401s with no secret leak for an expired session", async () => {
      const options = getIronSessionOptions();
      const secretKey = "SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"; // shape-only, not a real key
      const sessionData: SessionData = {
        publicKey: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        secretKey,
        createdAt: Date.now() - 31 * 60 * 1000, // 31 minutes ago — past the 30-minute cutoff
        network: "testnet",
      };
      const sealed = await sealData(sessionData, { password: options.password });
      const req = makeRequest(
        "http://localhost/api/pay",
        { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) },
        `${options.cookieName}=${encodeURIComponent(sealed)}`,
      );
      const res = await POST(req);
      const rawText = await res.clone().text();
      const body = JSON.parse(rawText);

      expect(res.status).toBe(401);
      expect(body.error).toBe("session_expired");
      assertNoSecretKeyField(body);
      expect(rawText).not.toContain(secretKey);
    });
  });
});
