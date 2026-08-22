/**
 * Client IP extraction for rate limiting and per-IP session tracking.
 *
 * We read `x-forwarded-for` and take the FIRST address in the comma-separated
 * list. This app is destined for Vercel: Vercel's edge network appends the
 * connecting client's address as the first entry of `x-forwarded-for` before
 * the request reaches the deployment, so in production this header reliably
 * names the real client.
 *
 * Two caveats, both worth being explicit about:
 *
 * 1. Spoofability: `x-forwarded-for` is just a request header. Any client can
 *    set it directly. This is safe to trust ONLY because Vercel's edge sits in
 *    front of the app as a trusted reverse proxy and sets/overwrites this
 *    header itself — a client-supplied value does not survive the hop through
 *    Vercel's network. If this app were ever deployed behind a different (or
 *    no) reverse proxy, this header could be forged by any caller and this
 *    function would need to change (e.g. to a platform-specific header such
 *    as `x-real-ip`, or to trust nothing and rate-limit globally instead).
 *
 * 2. Local dev: `pnpm dev` requests hit Next.js directly with no proxy in
 *    front, so `x-forwarded-for` is normally absent. We fall back to a
 *    constant placeholder ("unknown") in that case. Practically, this means
 *    per-distinct-IP rate limiting is disabled during local dev — every
 *    request is bucketed under the same "unknown" key — unless a developer
 *    manually sets the header (e.g. `curl -H "x-forwarded-for: 1.2.3.4"`) to
 *    exercise the limiter locally. This is an accepted tradeoff for a
 *    playground app, not a bug.
 */
export function getClientIp(req: Request): string {
  const forwardedFor = req.headers.get("x-forwarded-for");
  if (!forwardedFor) {
    return "unknown";
  }
  const firstIp = forwardedFor.split(",")[0]?.trim();
  return firstIp && firstIp.length > 0 ? firstIp : "unknown";
}
