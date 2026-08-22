import { unsealData } from "iron-session";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getIronSessionOptions, type SessionData } from "@/lib/session";
import { GET } from "./route";
import { POST } from "./create/route";

// The single most important property of Step 2: no code path — success,
// friendbot failure, or an unexpected exception — may ever put the secret
// key anywhere an HTTP caller can see it (response body, in particular).
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
 * Recursively asserts a value (typically a parsed JSON body) never contains a
 * key literally named "secretKey" anywhere in its structure.
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
      "POST /api/session/create response never contains the secret key",
      async () => {
        const req = makeRequest("http://localhost/api/session/create", { method: "POST" });
        const res = await POST(req);
        const rawText = await res.clone().text();
        const body = JSON.parse(rawText);

        expect(res.status).toBe(200);
        expect(body.publicKey).toBeDefined();
        assertNoSecretKeyField(body);
        expect(rawText).not.toMatch(STELLAR_SECRET_KEY_SHAPE);

        // Recover the REAL secret directly from the sealed cookie (never from
        // the HTTP response) and confirm it's genuinely absent from the body.
        const setCookie = res.headers.getSetCookie();
        expect(setCookie.length, "expected a session cookie to be set on success").toBeGreaterThan(0);
        const session = await readSealedSessionFromSetCookie(setCookie);
        expect(session?.secretKey).toBeDefined();
        expect(session!.secretKey!).toMatch(STELLAR_SECRET_KEY_SHAPE);
        expect(rawText).not.toContain(session!.secretKey!);
        expect(rawText.includes("secretKey")).toBe(false);

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
  });

  describe("friendbot failure path (mocked — no real network failure needed)", () => {
    it("returns an error with no secret leak and writes NO session cookie", async () => {
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
      const rawText = await res.clone().text();
      const body = JSON.parse(rawText);

      expect(res.status).toBe(503);
      expect(body.error).toBe("funding_failed");
      // Human-readable, not a raw technical string.
      expect(body.message).toBeTruthy();
      expect(body.message.toLowerCase()).not.toContain("econnrefused");
      expect(body.message.toLowerCase()).not.toContain("fetch failed");

      assertNoSecretKeyField(body);
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
      const rawText = await res.clone().text();
      const body = JSON.parse(rawText);

      expect(res.status).toBe(503);
      expect(body.error).toBe("funding_failed");
      assertNoSecretKeyField(body);
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
