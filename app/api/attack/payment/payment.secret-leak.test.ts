import { sealData, unsealData } from "iron-session";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getIronSessionOptions, type SessionData } from "@/lib/session";
import { POST as createSession } from "@/app/api/session/create/route";
import { POST } from "./route";

// The single most important property of this route, same standard as every
// prior step in this build: no code path — success, an attack failing to
// reach the facilitator, or an unexpected exception — may ever put the
// secret key anywhere an HTTP caller can see it (response body, in
// particular). This route is the first Station 3 route that touches the
// session (arms a real signed payload with it), so it needs the exact same
// scrutiny as /api/pay.
//
// This test reads the FULL NDJSON stream to completion, collects every
// emitted line, and asserts the secret key never appears in ANY of them.
//
// SESSION_SECRET must be set before any of the modules under test read it.
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
  // Every test gets its own synthetic client IP — same rationale as the
  // sibling secret-leak test files: avoids tripping over the module-level
  // rate-limit/session-by-IP maps shared across imports of these routes.
  headers.set("x-forwarded-for", ip ?? `192.0.2.${Math.floor(Math.random() * 200) + 1}`);
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

/** Same provisioning helper pattern as pay.secret-leak.test.ts — a real
 *  funded testnet session via the existing (untouched) session/create flow. */
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
        "Cannot arm a real payment without funds — this indicates a testnet/DEX issue, not a bug in the " +
        "code under test.",
    );
  }

  return { cookieHeader, secretKey: session.secretKey!, publicKey: session.publicKey! };
}

describe("secret key never leaks via POST /api/attack/payment", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  // Real flow: a real funded session, arming a real payload, and running all
  // 5 attacks live against the real facilitator (including one real /settle
  // for the replay attack). Slow and network-dependent, but this is the
  // deliverable this task calls out as most important, so the true
  // end-to-end path is exercised rather than mocked away.
  describe(
    "success path (real seller + facilitator, all 5 attacks)",
    () => {
      it(
        "POST /api/attack/payment stream never contains the secret key in any event, across arming and all 5 attacks",
        async () => {
          const { cookieHeader, secretKey } = await provisionFundedSession();

          const req = makeRequest("http://localhost/api/attack/payment", { method: "POST" }, cookieHeader);
          const res = await POST(req);

          expect(res.status).toBe(200);
          expect(res.headers.get("content-type")).toContain("application/x-ndjson");

          const { rawText, events } = await readNdjsonStream(res);

          expect(events.length).toBeGreaterThan(0);
          expect(events.at(-1)?.step).toBe("complete");

          const complete = findCompleteEvent(events);
          expect(complete?.status).toBe("done");
          const results = (complete as { results?: unknown[] } | undefined)?.results;
          expect(Array.isArray(results)).toBe(true);
          expect((results as unknown[]).length).toBe(5);

          const attackIds = (results as { attackId?: string }[]).map((r) => r.attackId);
          expect(attackIds.sort()).toEqual(
            ["redirect_payto", "replay", "strip_signature", "tamper_amount", "wrong_network"].sort(),
          );

          // Assert the secret-key absence property across EVERY individual
          // event object, including nested rawResponse fields.
          for (const event of events) {
            assertNoSecretKeyField(event);
          }

          // And across the raw, concatenated stream text as a whole.
          expect(rawText).not.toMatch(STELLAR_SECRET_KEY_SHAPE);
          expect(rawText.includes("secretKey")).toBe(false);
          // Direct substring check against the REAL secret recovered from the
          // sealed cookie (never from any /api/attack/payment response).
          expect(rawText).not.toContain(secretKey);
        },
        // Provisioning + arming (a real GET->402->sign cycle) + 4 /verify
        // calls + 2 /settle calls (replay's real settlement + its replay),
        // each individually bounded well under a minute — 180s gives real
        // margin above the worst-case sum.
        180_000,
      );
    },
    180_000,
  );

  describe("error paths (no session)", () => {
    it("401s with no secret leak when there is no cookie at all", async () => {
      const req = makeRequest("http://localhost/api/attack/payment", { method: "POST" });
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
        "http://localhost/api/attack/payment",
        { method: "POST" },
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
      const expiredSession: SessionData = {
        publicKey: "GABCDEXPIREDTESTKEYXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
        secretKey: "SABCDEXPIREDTESTSECRETXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
        createdAt: Date.now() - 31 * 60 * 1000, // 31 minutes ago, past the 30-min cap
        network: "testnet",
      };
      const sealValue = await sealData(expiredSession, { password: options.password });
      const req = makeRequest(
        "http://localhost/api/attack/payment",
        { method: "POST" },
        `${options.cookieName}=${encodeURIComponent(sealValue)}`,
      );
      const res = await POST(req);
      const rawText = await res.clone().text();
      const body = JSON.parse(rawText);

      expect(res.status).toBe(401);
      expect(body.error).toBe("session_expired");
      assertNoSecretKeyField(body);
      expect(rawText).not.toMatch(STELLAR_SECRET_KEY_SHAPE);
      expect(rawText).not.toContain(expiredSession.secretKey);
    });
  });
});
