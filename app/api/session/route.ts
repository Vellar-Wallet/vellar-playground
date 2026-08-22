import { getClientIp } from "@/lib/ip";
import { clearActiveSessionForIp } from "@/lib/rate-limit";
import { getSession, THIRTY_MINUTES_IN_MS } from "@/lib/session";
import { getXlmBalance } from "@/lib/stellar";

function jsonError(status: number, error: string, message: string) {
  return Response.json({ error, message }, { status });
}

/**
 * Builds a JSON response, copying over any Set-Cookie header(s) written onto
 * `scratch` (the throwaway Response passed to getSession/session.destroy()).
 */
function jsonWithCookies(scratch: Response, body: unknown, status = 200): Response {
  const res = Response.json(body, { status });
  for (const cookie of scratch.headers.getSetCookie()) {
    res.headers.append("set-cookie", cookie);
  }
  return res;
}

export async function GET(req: Request): Promise<Response> {
  try {
    // This response never needs to set a cookie on the happy path (reading a
    // session doesn't refresh it), but session.destroy() on the expired path
    // does need somewhere to write the cookie-clearing Set-Cookie header, so
    // we still route session access through the same scratch-Response
    // pattern used by POST /api/session/create.
    const scratch = new Response(null);
    const session = await getSession(req, scratch);

    if (!session.publicKey || !session.secretKey || !session.createdAt) {
      return jsonError(401, "no_session", "You don't have an active session yet. Create one to get started.");
    }

    // Defense in depth: don't rely solely on the cookie's own maxAge/expiry.
    // Check server-side against the same 30-minute TTL explicitly.
    const ageMs = Date.now() - session.createdAt;
    if (ageMs > THIRTY_MINUTES_IN_MS) {
      const ip = getClientIp(req);
      clearActiveSessionForIp(ip);
      session.destroy();
      return jsonWithCookies(
        scratch,
        { error: "session_expired", message: "Your session has expired after 30 minutes. Please create a new one." },
        401,
      );
    }

    let balanceXlm: string;
    try {
      balanceXlm = await getXlmBalance(session.publicKey);
    } catch (err) {
      console.error("horizon balance lookup failed:", err);
      return jsonError(
        502,
        "balance_unavailable",
        "We couldn't reach the Stellar network to check your balance right now. Please try again in a moment.",
      );
    }

    return Response.json({
      publicKey: session.publicKey,
      balanceXlm,
      ageSeconds: Math.floor(ageMs / 1000),
    });
  } catch (err) {
    console.error("GET /api/session failed:", err);
    return jsonError(500, "internal_error", "Something went wrong, please try again in a moment.");
  }
}
