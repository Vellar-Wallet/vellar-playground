import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getClientIp } from "@/lib/ip";
import { globalApiLimiter } from "@/lib/rate-limit";

/**
 * NOTE ON THE FILENAME: this repo is on Next.js 16, which deprecated the
 * `middleware.ts` convention in favor of `proxy.ts` (exporting a function
 * named `proxy` rather than `middleware`) — see
 * node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md.
 * Functionality is identical; only the file/export name changed. This file
 * is the uniform place — applying to every /api/* route — for the two
 * traffic-management checks that shouldn't be re-implemented per route:
 *
 *   1. A global 60-requests-per-IP-per-rolling-minute cap across all of
 *      /api/*, on top of any route-specific limit (e.g. the 5/hour wallet
 *      creation limit enforced inside POST /api/session/create itself).
 *   2. A body-size cap so an oversized request body is rejected before it
 *      reaches any route handler's own parsing logic.
 */

// Same 1 KiB cap POST /api/session/create enforces itself — kept here too so
// it applies uniformly to any future /api/* route that also expects little
// or no body, without each route having to remember to add it.
const MAX_BODY_BYTES = 1024;

function rateLimitedResponse(retryAfterSeconds: number): NextResponse {
  return NextResponse.json(
    {
      error: "rate_limited",
      message: "You've made a lot of requests recently. Please wait a few minutes and try again.",
    },
    { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
  );
}

function payloadTooLargeResponse(): NextResponse {
  return NextResponse.json(
    {
      error: "payload_too_large",
      message: "That request looks too large for this endpoint. Please try again with a smaller request.",
    },
    { status: 413 },
  );
}

export function proxy(request: NextRequest): NextResponse {
  const contentLength = request.headers.get("content-length");
  if (contentLength && Number(contentLength) > MAX_BODY_BYTES) {
    return payloadTooLargeResponse();
  }

  const ip = getClientIp(request);
  const result = globalApiLimiter.check(ip);
  if (!result.allowed) {
    return rateLimitedResponse(result.retryAfterSeconds);
  }

  return NextResponse.next();
}

export const config = {
  matcher: "/api/:path*",
};
