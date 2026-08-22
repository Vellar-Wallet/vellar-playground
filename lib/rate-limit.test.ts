import { describe, expect, it } from "vitest";
import { RateLimiter } from "./rate-limit";

describe("RateLimiter", () => {
  describe("wallet-creation-shaped limit (5 per hour)", () => {
    it("allows exactly 5 creations then rejects the 6th within the hour window", () => {
      const now = 0;
      const limiter = new RateLimiter({ max: 5, windowMs: 60 * 60 * 1000, now: () => now });
      const ip = "1.2.3.4";

      for (let i = 1; i <= 5; i++) {
        const result = limiter.check(ip);
        expect(result.allowed).toBe(true);
        expect(result.count).toBe(i);
      }

      const sixth = limiter.check(ip);
      expect(sixth.allowed).toBe(false);
      expect(sixth.retryAfterSeconds).toBeGreaterThan(0);
    });

    it("does not record rejected attempts (retrying immediately still rejects, doesn't push the window)", () => {
      let now = 0;
      const limiter = new RateLimiter({ max: 5, windowMs: 60 * 60 * 1000, now: () => now });
      const ip = "1.2.3.4";
      for (let i = 0; i < 5; i++) limiter.check(ip);

      const first = limiter.check(ip);
      now += 1000;
      const second = limiter.check(ip);
      // Both rejections should report a retryAfter shrinking towards the
      // *original* oldest hit aging out, not resetting because of the extra
      // rejected attempts in between.
      expect(first.allowed).toBe(false);
      expect(second.allowed).toBe(false);
      expect(second.retryAfterSeconds).toBeLessThanOrEqual(first.retryAfterSeconds);
    });

    it("slides the window correctly: a request just after the oldest hit ages out is allowed", () => {
      let now = 0;
      const windowMs = 60 * 60 * 1000;
      const limiter = new RateLimiter({ max: 5, windowMs, now: () => now });
      const ip = "1.2.3.4";

      // 5 hits at t=0..4ms apart, filling the limit.
      for (let i = 0; i < 5; i++) {
        expect(limiter.check(ip).allowed).toBe(true);
        now += 1;
      }
      // now = 5ms. Immediately blocked.
      expect(limiter.check(ip).allowed).toBe(false);

      // Jump to just before the oldest hit (t=0) ages out of the window —
      // still blocked.
      now = windowMs - 1;
      expect(limiter.check(ip).allowed).toBe(false);

      // Jump to just after the oldest hit ages out — now allowed again.
      now = windowMs + 1;
      const result = limiter.check(ip);
      expect(result.allowed).toBe(true);
    });

    it("tracks a different IP independently — one IP's count doesn't affect another's", () => {
      const now = 0;
      const limiter = new RateLimiter({ max: 5, windowMs: 60 * 60 * 1000, now: () => now });

      for (let i = 0; i < 5; i++) {
        expect(limiter.check("1.1.1.1").allowed).toBe(true);
      }
      expect(limiter.check("1.1.1.1").allowed).toBe(false);

      // A different IP starts fresh, unaffected by 1.1.1.1's exhausted limit.
      for (let i = 0; i < 5; i++) {
        expect(limiter.check("2.2.2.2").allowed).toBe(true);
      }
      expect(limiter.check("2.2.2.2").allowed).toBe(false);
    });
  });

  describe("global limit (60 per minute)", () => {
    it("allows up to the max and rejects beyond it within the window", () => {
      const now = 0;
      const limiter = new RateLimiter({ max: 60, windowMs: 60 * 1000, now: () => now });
      const ip = "9.9.9.9";

      for (let i = 1; i <= 60; i++) {
        expect(limiter.check(ip).allowed).toBe(true);
      }
      const over = limiter.check(ip);
      expect(over.allowed).toBe(false);
      expect(over.retryAfterSeconds).toBeGreaterThan(0);
      expect(over.retryAfterSeconds).toBeLessThanOrEqual(60);
    });

    it("allows requests again once the minute window has fully elapsed", () => {
      let now = 0;
      const windowMs = 60 * 1000;
      const limiter = new RateLimiter({ max: 60, windowMs, now: () => now });
      const ip = "9.9.9.9";

      for (let i = 0; i < 60; i++) limiter.check(ip);
      expect(limiter.check(ip).allowed).toBe(false);

      now += windowMs + 1;
      expect(limiter.check(ip).allowed).toBe(true);
    });
  });

  describe("prune()", () => {
    it("removes keys with no hits left in the window without affecting correctness", () => {
      let now = 0;
      const limiter = new RateLimiter({ max: 2, windowMs: 1000, now: () => now });
      limiter.check("a.a.a.a");
      now += 2000; // ages the hit out
      limiter.prune();

      // Still behaves correctly post-prune — a fresh window for this key.
      expect(limiter.check("a.a.a.a").allowed).toBe(true);
      expect(limiter.check("a.a.a.a").allowed).toBe(true);
      expect(limiter.check("a.a.a.a").allowed).toBe(false);
    });
  });
});
