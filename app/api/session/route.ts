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

/**
 * DELETE /api/session — "start fresh". Destroys the encrypted server-side
 * session cookie (same `session.destroy()` call already used internally on
 * the expired-session path in GET, above) so the real source of truth for
 * the wallet's secret key is actually gone, not just hidden client-side.
 *
 * REST-ish naming over an action-ish `/api/session/discard` route: this is a
 * genuine resource deletion (the session resource ceases to exist), which
 * DELETE already expresses without inventing a new URL — consistent with
 * this route file already hosting GET for the same resource.
 *
 * Always returns 200 with a simple success body, even if there was no
 * session to destroy — from the client's perspective "start fresh" succeeds
 * either way (idempotent discard), so there's no need to 401 first.
 */
export async function DELETE(req: Request): Promise<Response> {
  try {
    const scratch = new Response(null);
    const session = await getSession(req, scratch);
    session.destroy();
    // Also stop tracking this IP's active session (same call the expired-
    // session path in GET, above, already makes) — otherwise a same-IP
    // revisit within 30 minutes would silently hand back the very wallet
    // "start fresh" was meant to discard, via POST /api/session/create's
    // Case 2 (IP-tracked session reuse). iron-session's sealed cookie is
    // stateless/self-contained (session.destroy() only clears the browser's
    // copy via Set-Cookie Max-Age=0, it doesn't invalidate the sealed value
    // itself), so this IP-tracker clear is the only server-side state this
    // route can actually revoke.
    clearActiveSessionForIp(getClientIp(req));
    return jsonWithCookies(scratch, { ok: true });
  } catch (err) {
    console.error("DELETE /api/session failed:", err);
    return jsonError(500, "internal_error", "Something went wrong, please try again in a moment.");
  }
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
