import { Keypair } from "@stellar/stellar-sdk";
import { getClientIp } from "@/lib/ip";
import {
  clearActiveSessionForIp,
  getActiveSessionForIp,
  setActiveSessionForIp,
  walletCreationLimiter,
} from "@/lib/rate-limit";
import { getSession, THIRTY_MINUTES_IN_MS } from "@/lib/session";
import { fundWithFriendbot, getXlmBalance } from "@/lib/stellar";

// POST /api/session/create takes no meaningful body. Reject anything over a
// small cap fast, before any other work (keypair generation, friendbot call,
// etc.) — this is cheap insurance against someone pointing a large-body
// request at this route to waste server time/bandwidth.
const MAX_BODY_BYTES = 1024;

function isSessionExpired(createdAt: number | undefined, now: number): boolean {
  if (!createdAt) return true;
  return now - createdAt > THIRTY_MINUTES_IN_MS;
}

function jsonError(status: number, error: string, message: string, extraHeaders?: HeadersInit) {
  return Response.json({ error, message }, { status, headers: extraHeaders });
}

/**
 * Builds the real JSON response, copying over any Set-Cookie header(s) that
 * were written onto `scratch` (the throwaway Response passed to
 * getSession/session.save()/session.destroy()).
 */
function jsonWithCookies(scratch: Response, body: unknown, status = 200): Response {
  const res = Response.json(body, { status });
  for (const cookie of scratch.headers.getSetCookie()) {
    res.headers.append("set-cookie", cookie);
  }
  return res;
}

/**
 * Reads the request body defensively: rejects anything over MAX_BODY_BYTES,
 * and — if a body IS present — requires it to be either empty or a trivial
 * JSON object (`{}` or absent), so a malformed/oversized payload never
 * reaches keypair generation or a friendbot call. Returns `null` when the
 * body is acceptable, or a Response to return immediately when it is not.
 */
async function rejectBadBody(req: Request): Promise<Response | null> {
  const contentLength = req.headers.get("content-length");
  if (contentLength && Number(contentLength) > MAX_BODY_BYTES) {
    return jsonError(
      413,
      "payload_too_large",
      "That request looks too large for this endpoint. Please try again without a request body.",
    );
  }

  // Content-Length can be absent or wrong (chunked transfer, a lying client),
  // so also bound what we actually read regardless of the header.
  const text = await req.text().catch(() => null);
  if (text === null) {
    return jsonError(400, "bad_request", "We couldn't read your request. Please try again.");
  }
  if (text.length > MAX_BODY_BYTES) {
    return jsonError(
      413,
      "payload_too_large",
      "That request looks too large for this endpoint. Please try again without a request body.",
    );
  }
  if (text.trim().length === 0) {
    return null; // no body — the expected case
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return jsonError(
      400,
      "invalid_body",
      "Your request body isn't valid JSON. This endpoint doesn't need a request body — try sending none.",
    );
  }
  const isTrivialObject =
    typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) && Object.keys(parsed).length === 0;
  if (!isTrivialObject) {
    return jsonError(
      400,
      "invalid_body",
      "This endpoint doesn't expect a request body. Please try again without one.",
    );
  }
  return null;
}

export async function POST(req: Request): Promise<Response> {
  try {
    const badBody = await rejectBadBody(req);
    if (badBody) return badBody;

    const ip = getClientIp(req);
    const now = Date.now();

    // Scratch response purely to give getSession/session.save() somewhere to
    // write Set-Cookie; its headers get copied onto whichever real response
    // we return below (see jsonWithCookies).
    const scratch = new Response(null);
    const session = await getSession(req, scratch);

    // Case 1: the requester already has a valid, non-expired session cookie
    // themselves. That cookie already IS their session — hand back its data
    // rather than minting a second wallet.
    if (session.publicKey && session.secretKey && !isSessionExpired(session.createdAt, now)) {
      const balanceXlm = await getXlmBalance(session.publicKey).catch(() => null);
      return jsonWithCookies(scratch, { publicKey: session.publicKey, balanceXlm: balanceXlm ?? "0" });
    }

    // Case 2: no valid cookie, but this IP already has another active,
    // non-expired session tracked server-side (different browser/incognito
    // tab/cleared cookies). Re-issue a cookie for that existing wallet
    // instead of minting a new one. See lib/rate-limit.ts for the tradeoffs
    // of tracking "one session" by IP (NAT/shared-IP users are conflated).
    const tracked = getActiveSessionForIp(ip);
    if (tracked && !isSessionExpired(tracked.createdAt, now)) {
      session.publicKey = tracked.publicKey;
      session.secretKey = tracked.secretKey;
      session.createdAt = tracked.createdAt;
      session.network = "testnet";
      await session.save();

      const balanceXlm = await getXlmBalance(tracked.publicKey).catch(() => null);
      return jsonWithCookies(scratch, { publicKey: tracked.publicKey, balanceXlm: balanceXlm ?? "0" });
    }
    if (tracked) {
      // Was tracked but expired — stop tracking it so it doesn't linger.
      clearActiveSessionForIp(ip);
    }

    // Case 3: genuinely minting a new wallet for this IP. Only now does the
    // 5-per-hour creation limit apply.
    const limit = walletCreationLimiter.check(ip);
    if (!limit.allowed) {
      return jsonError(
        429,
        "rate_limited",
        "You've made a lot of requests recently. Please wait a few minutes and try again.",
        { "Retry-After": String(limit.retryAfterSeconds) },
      );
    }

    const keypair = Keypair.random();
    const publicKey = keypair.publicKey();
    const secretKey = keypair.secret();

    try {
      await fundWithFriendbot(publicKey);
    } catch (err) {
      console.error("friendbot funding failed:", err);
      // No session cookie is written for an unfunded wallet — the spec is
      // explicit that a friendbot failure must not leave a dangling session.
      return jsonError(
        503,
        "funding_failed",
        "We couldn't fund a new testnet wallet right now. Please try again in a moment.",
      );
    }

    let balanceXlm: string;
    try {
      balanceXlm = await getXlmBalance(publicKey);
    } catch (err) {
      // The wallet WAS funded (friendbot succeeded) — this is just the
      // read-back failing. Still don't block the user on it; fall back to a
      // sensible default rather than failing an otherwise-successful create.
      console.error("horizon balance lookup failed after funding:", err);
      balanceXlm = "10000.0000000";
    }

    session.publicKey = publicKey;
    session.secretKey = secretKey;
    session.createdAt = now;
    session.network = "testnet";
    await session.save();

    setActiveSessionForIp(ip, { publicKey, secretKey, createdAt: now });

    return jsonWithCookies(scratch, { publicKey, balanceXlm });
  } catch (err) {
    console.error("POST /api/session/create failed:", err);
    return jsonError(500, "internal_error", "Something went wrong, please try again in a moment.");
  }
}
