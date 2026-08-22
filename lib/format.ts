/**
 * Small formatting helpers shared across pages that render facilitator data
 * (the guided demo `app/page.tsx`, and the read-only `/status`, `/catalog`,
 * `/console` pages added in this step). Factored out once a second page
 * needed the exact same atomic-amount/truncation logic `app/page.tsx` had
 * inlined — see that file's history for the original versions this was
 * lifted from verbatim (behavior unchanged, `app/page.tsx` still imports
 * from here so there's exactly one copy).
 */

/** Truncate the middle of a long string (keys, tx hashes, resource URLs)
 *  down to `head + "..." + tail`, leaving short strings untouched. */
export function truncateMiddle(s: string, head = 10, tail = 6): string {
  if (s.length <= head + tail + 3) return s;
  return `${s.slice(0, head)}...${s.slice(-tail)}`;
}

/** Format an atomic amount for the (default 7-decimal) Stellar SEP-41 token
 *  convention used by testnet USDC here — see @x402/stellar's
 *  DEFAULT_TOKEN_DECIMALS. Falls back to the raw atomic string if the value
 *  isn't a plain integer string, rather than guessing. */
export function formatAtomicAmount(amount?: string): string {
  if (!amount) return "—";
  if (!/^\d+$/.test(amount)) return amount;
  const decimals = 7;
  const padded = amount.padStart(decimals + 1, "0");
  const whole = padded.slice(0, -decimals).replace(/^0+(?=\d)/, "");
  const frac = padded.slice(-decimals).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

/** Format a whole-number seconds count as a compact human-readable
 *  duration, e.g. 436 -> "7m 16s", 90000 -> "1d 1h 0m", 45 -> "45s". Used by
 *  `/status` for `uptimeSeconds`, which the facilitator hands back as a raw
 *  integer. */
export function formatDuration(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return "—";
  const s = Math.floor(totalSeconds);
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const seconds = s % 60;

  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}
