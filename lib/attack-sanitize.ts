/**
 * Station 3 — attack 8 (prompt_injection): a faithful, small port of the
 * facilitator's REAL description sanitizer.
 *
 * WHAT THIS IS, AND IS NOT (be honest — see the task's explicit instruction):
 * this is NOT a live round-trip against the hosted facilitator. Cataloging a
 * new resource (the only way a description ever reaches the facilitator's
 * sanitizer) happens as a side effect of a real settlement, and the
 * playground doesn't control an independent seller identity to construct
 * that settlement with a crafted description attached (same constraint
 * documented for attacks 6/7 — see the task report). This module instead
 * REPLICATES the real algorithm from vellar-facilitator/src/catalog.ts's
 * `sanitizeDescription()` — read directly, ported verbatim below — so a
 * visitor can type their own injection attempt and see exactly what the
 * facilitator's own sanitizer would do to it, live, without a network call.
 *
 * SOURCE OF TRUTH (copy this file, not the mechanics underneath it — same
 * convention as lib/pay.ts's own header comment): vellar-facilitator/
 * src/catalog.ts, `sanitizeDescription()` and its two constants,
 * `MAX_DESCRIPTION_LEN` (256) and `CONTROL_AND_FORMAT`
 * (`/[\p{Cc}\p{Cf}]/gu` — strips Unicode control chars AND bidi/format
 * chars, the latter specifically defeating RTL-override / homoglyph
 * impersonation tricks in an agent's context window). Verified byte-for-byte
 * identical against that file as of this task; if the real facilitator's
 * sanitizer ever changes, this port must be re-synced by hand (there is no
 * shared package boundary between the two repos).
 */

export const MAX_DESCRIPTION_LEN = 256;
export const CONTROL_AND_FORMAT = /[\p{Cc}\p{Cf}]/gu;

/**
 * Clamp + strip a free-text description — identical logic to the real
 * `sanitizeDescription()`. Returns `undefined` for empty/non-string input,
 * same as the original (this port keeps that signature so behavior is
 * comparable field-for-field), but the route wrapping this always has a
 * string to sanitize, so it normalizes `undefined` to `""` at the edge.
 */
export function sanitizeDescription(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value.replace(CONTROL_AND_FORMAT, "").slice(0, MAX_DESCRIPTION_LEN);
  return cleaned.length > 0 ? cleaned : undefined;
}

export interface SanitizeDemoResult {
  input: string;
  inputLength: number;
  sanitized: string;
  sanitizedLength: number;
  /** Number of control/bidi/format characters CONTROL_AND_FORMAT stripped. */
  strippedCharCount: number;
  /** Whether the input was clamped to MAX_DESCRIPTION_LEN. */
  truncated: boolean;
  /** Whether anything changed at all (stripped chars, truncation, or both). */
  changed: boolean;
}

/** Runs the ported sanitizer and reports exactly what changed, for the UI's
 *  "before -> after" demonstration. Never throws — any input type coerces to
 *  a string first, since this is user-typed text from a <textarea>. */
export function demoSanitize(rawInput: string): SanitizeDemoResult {
  const input = rawInput;
  const strippedCharCount = (input.match(CONTROL_AND_FORMAT) ?? []).length;
  const beforeTruncate = input.replace(CONTROL_AND_FORMAT, "");
  const truncated = beforeTruncate.length > MAX_DESCRIPTION_LEN;
  const sanitized = sanitizeDescription(input) ?? "";
  return {
    input,
    inputLength: input.length,
    sanitized,
    sanitizedLength: sanitized.length,
    strippedCharCount,
    truncated,
    changed: strippedCharCount > 0 || truncated,
  };
}
