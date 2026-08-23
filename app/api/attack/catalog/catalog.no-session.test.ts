import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { POST } from "./route";

// Structural check, same standard as /api/verify-ownership's own
// "POST() takes NO arguments" precedent: this route needs no session/secret
// involvement at all (only public facilitator data), so it should be
// STRUCTURALLY incapable of touching a cookie — not just "happens not to
// today". Two checks: (1) POST takes no Request argument to read a cookie
// from, mirroring /api/verify-ownership's own convention; (2) a grep-level
// proof that this route's source file never imports lib/session.ts or reads
// a "cookie" header.
describe("POST /api/attack/catalog has no session/secret involvement", () => {
  it("POST takes no arguments (cannot read a Request's cookie header)", () => {
    expect(POST.length).toBe(0);
  });

  it("route.ts never imports lib/session.ts, calls getSession(), or reads a cookie header", () => {
    // Strip comments first — the module doc comment legitimately discusses
    // "no session involvement" in prose; this test checks the CODE, not the
    // documentation describing the code.
    const source = readFileSync(join(__dirname, "route.ts"), "utf8");
    const codeOnly = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(codeOnly).not.toMatch(/from ["']@\/lib\/session["']/);
    expect(codeOnly).not.toMatch(/getSession\s*\(/);
    expect(codeOnly.toLowerCase()).not.toMatch(/\.headers\.get\(["']cookie["']\)/);
  });
});

describe("POST /api/attack/catalog runs and streams real NDJSON", () => {
  it(
    "streams a terminal complete event with both attacks reported",
    async () => {
      const res = await POST();
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("application/x-ndjson");

      const rawText = await res.text();
      const events = rawText
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>);

      expect(events.length).toBeGreaterThan(0);
      expect(events.at(-1)?.step).toBe("complete");

      const complete = events.find((e) => e.step === "complete") as { status?: string; results?: unknown[] };
      expect(complete.status).toBe("done");
      expect(Array.isArray(complete.results)).toBe(true);

      const attackIds = (complete.results as { attackId?: string }[]).map((r) => r.attackId);
      expect(attackIds.sort()).toEqual(["displace_verified", "ssrf_linklocal"].sort());
    },
    // A real /health fetch, two real /discovery/resources fetches, and a
    // deliberate multi-second gap between the displace_verified poll pair.
    30_000,
  );
});
