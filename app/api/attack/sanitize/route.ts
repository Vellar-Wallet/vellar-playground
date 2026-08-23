import { demoSanitize } from "@/lib/attack-sanitize";

/**
 * POST /api/attack/sanitize — Station 3's attack 8 (prompt_injection).
 *
 * HONEST FRAMING (be explicit — this is not a live round-trip, see the
 * module doc comment on lib/attack-sanitize.ts for the full reasoning):
 * cataloging a new resource with a crafted description on the shared hosted
 * facilitator is not something this playground can trigger without
 * controlling an independent seller identity (the same constraint as
 * attacks 6/7). This route instead runs a small, faithful PORT of the
 * facilitator's REAL `sanitizeDescription()` (vellar-facilitator/
 * src/catalog.ts) against whatever text the caller sends, live, in this
 * process — no facilitator network call happens here at all. The UI this
 * feeds MUST say so plainly ("the same sanitization algorithm, run locally
 * — not a live round-trip to the facilitator").
 *
 * SECURITY / SCOPE: no session, no cookie, no secret. Takes a plain JSON
 * body `{ text: string }` and returns the sanitizer's before/after — pure
 * text transformation, structurally incapable of touching session state
 * (this file never imports lib/session.ts). See
 * app/api/attack/sanitize/sanitize.no-session.test.ts.
 */

const MAX_BODY_BYTES = 4096;

function jsonError(status: number, error: string, message: string) {
  return Response.json({ error, message }, { status });
}

export async function POST(req: Request): Promise<Response> {
  const contentLength = req.headers.get("content-length");
  if (contentLength && Number(contentLength) > MAX_BODY_BYTES) {
    return jsonError(413, "payload_too_large", "That request looks too large for this endpoint.");
  }
  const text = await req.text().catch(() => null);
  if (text === null) {
    return jsonError(400, "bad_request", "We couldn't read your request. Please try again.");
  }
  if (text.length > MAX_BODY_BYTES) {
    return jsonError(413, "payload_too_large", "That request looks too large for this endpoint.");
  }

  let parsed: unknown;
  try {
    parsed = text.trim().length > 0 ? JSON.parse(text) : {};
  } catch {
    return jsonError(400, "invalid_body", "Your request body isn't valid JSON.");
  }

  const input = typeof parsed === "object" && parsed !== null ? (parsed as { text?: unknown }).text : undefined;
  if (typeof input !== "string") {
    return jsonError(400, "invalid_body", "`text` must be a string.");
  }

  const attemptedAt = Date.now();
  const demo = demoSanitize(input);

  const result = {
    attackId: "prompt_injection",
    endpoint: "local — faithful port of vellar-facilitator/src/catalog.ts's sanitizeDescription()",
    attemptedAt,
    checkMethod: "content_inspection" as const,
    expectedCodes: [] as string[],
    // "passed" for this demonstration means the sanitizer actually changed
    // something dangerous — i.e. the guard did its job on this input. If the
    // input had nothing to strip/truncate, that's an honest "nothing to
    // demonstrate" rather than a pass/fail on the guard itself.
    passed: demo.changed,
    rawResponse: demo,
  };

  return Response.json(result, { status: 200 });
}

export async function GET(): Promise<Response> {
  return jsonError(405, "method_not_allowed", "Use POST with { text } to run the sanitizer demo.");
}
