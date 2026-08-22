/**
 * In-memory, per-process sliding-window rate limiter.
 *
 * DELIBERATE LIMITATION: state lives in a plain `Map` in this process's
 * memory. It resets on every restart/redeploy and is NOT shared across
 * multiple server instances (e.g. multiple Vercel serverless invocations, or
 * multiple long-lived server processes behind a load balancer). For a public
 * playground this is an accepted tradeoff, not a bug: the goal is to blunt
 * casual abuse and accidental hammering, not to provide a hard distributed
 * guarantee. A real multi-instance deployment would need a shared store
 * (Redis, etc.) to enforce these limits globally.
 *
 * ALGORITHM: sliding-window log. For each key (typically an IP) we keep a
 * timestamp array of recent hits. On each check we drop timestamps older than
 * `windowMs` from *now*, then compare the remaining count to `max`. This is
 * more accurate than a fixed-window counter (no double-allowance at window
 * boundaries) at the cost of O(hits-in-window) memory per key, which is fine
 * at the request volumes a playground sees. Old keys are never proactively
 * swept — see `RateLimiter.prune()` below for the (optional) mitigation.
 */

export type Clock = () => number;

export interface RateLimitConfig {
  /** Max allowed hits within the window. */
  max: number;
  /** Window size in milliseconds. */
  windowMs: number;
  /** Injectable clock, defaults to Date.now. Exists so tests can control time without real sleeps. */
  now?: Clock;
}

export interface RateLimitResult {
  allowed: boolean;
  /** Hits recorded in the current window, including this one if allowed. */
  count: number;
  /** Seconds until the caller should retry (only meaningful when !allowed). */
  retryAfterSeconds: number;
}

export class RateLimiter {
  private readonly max: number;
  private readonly windowMs: number;
  private readonly now: Clock;
  private readonly hits = new Map<string, number[]>();

  constructor(config: RateLimitConfig) {
    this.max = config.max;
    this.windowMs = config.windowMs;
    this.now = config.now ?? Date.now;
  }

  /**
   * Record and check a hit for `key`. Returns whether it's allowed under the
   * sliding window, the current in-window count, and (if rejected) how many
   * seconds until the oldest hit in the window ages out.
   *
   * Rejected attempts are NOT recorded — a client hammering past the limit
   * doesn't get to keep pushing their retry time out forever.
   */
  check(key: string): RateLimitResult {
    const nowMs = this.now();
    const windowStart = nowMs - this.windowMs;

    const existing = this.hits.get(key) ?? [];
    const inWindow = existing.filter((t) => t > windowStart);

    if (inWindow.length >= this.max) {
      const oldest = inWindow[0];
      const retryAfterMs = oldest + this.windowMs - nowMs;
      this.hits.set(key, inWindow);
      return {
        allowed: false,
        count: inWindow.length,
        retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)),
      };
    }

    inWindow.push(nowMs);
    this.hits.set(key, inWindow);
    return { allowed: true, count: inWindow.length, retryAfterSeconds: 0 };
  }

  /**
   * Drop keys with no hits inside the current window. Not required for
   * correctness (stale entries are harmless — `check` filters them out lazily
   * on next access) but bounds memory growth for a long-lived process seeing
   * many distinct IPs over time. Safe to call periodically or not at all.
   */
  prune(): void {
    const nowMs = this.now();
    const windowStart = nowMs - this.windowMs;
    for (const [key, timestamps] of this.hits) {
      const inWindow = timestamps.filter((t) => t > windowStart);
      if (inWindow.length === 0) {
        this.hits.delete(key);
      } else {
        this.hits.set(key, inWindow);
      }
    }
  }
}

/** Max 5 wallet creations per IP per rolling hour. */
export const walletCreationLimiter = new RateLimiter({
  max: 5,
  windowMs: 60 * 60 * 1000,
});

/** Max 60 requests per IP per rolling minute across all /api/* routes. */
export const globalApiLimiter = new RateLimiter({
  max: 60,
  windowMs: 60 * 1000,
});

// ---------------------------------------------------------------------------
// One active session per IP tracking.
// ---------------------------------------------------------------------------

/**
 * Minimal record of an IP's active playground session, tracked server-side
 * independent of the session cookie itself. This exists so that a request
 * arriving with NO cookie (or an expired/invalid one) — e.g. a different
 * browser, an incognito tab, or a cleared cookie jar — can still be
 * recognized as "this IP already has a live wallet" instead of minting a
 * second concurrent one.
 *
 * JUDGMENT CALL / KNOWN TRADEOFF: tracking by IP is a reasonable proxy for
 * "one person" in a playground context, but it is not the same thing. Any
 * users sharing one public IP — an office/campus NAT, a corporate VPN, CGNAT
 * on some mobile/ISP networks — will be treated as a single session and will
 * see each other's wallet rather than getting their own. This is a real
 * usability cost for a "developers, partners, investors, curious people
 * following a link" audience, some fraction of whom will be behind shared
 * IPs. We accept it here because the alternative (trusting the cookie alone)
 * lets anyone bypass "one session per IP" trivially by clearing cookies or
 * opening a private window, which defeats the point of the limit.
 */
export interface ActiveSessionRecord {
  publicKey: string;
  secretKey: string;
  createdAt: number;
}

const activeSessionsByIp = new Map<string, ActiveSessionRecord>();

/** Look up the tracked active session for an IP, if any. */
export function getActiveSessionForIp(ip: string): ActiveSessionRecord | undefined {
  return activeSessionsByIp.get(ip);
}

/** Record/replace the tracked active session for an IP. */
export function setActiveSessionForIp(ip: string, record: ActiveSessionRecord): void {
  activeSessionsByIp.set(ip, record);
}

/** Remove the tracked active session for an IP (e.g. once it has expired). */
export function clearActiveSessionForIp(ip: string): void {
  activeSessionsByIp.delete(ip);
}
