import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { POST } from "./route";

function makeRequest(body: unknown): Request {
  return new Request("http://localhost/api/attack/sanitize", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/attack/sanitize has no session/secret involvement", () => {
  it("route.ts never imports lib/session.ts, calls getSession(), or reads a cookie header", () => {
    // Strip comments first — the module doc comment legitimately discusses
    // "no session involvement" in prose; this test checks the CODE.
    const source = readFileSync(join(__dirname, "route.ts"), "utf8");
    const codeOnly = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(codeOnly).not.toMatch(/from ["']@\/lib\/session["']/);
    expect(codeOnly).not.toMatch(/getSession\s*\(/);
    expect(codeOnly.toLowerCase()).not.toMatch(/\.headers\.get\(["']cookie["']\)/);
  });

  it("issues no outbound network fetch — pure local text transformation", () => {
    const source = readFileSync(join(__dirname, "route.ts"), "utf8");
    const codeOnly = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(codeOnly).not.toMatch(/\bfetch\(/);
  });
});

describe("POST /api/attack/sanitize — faithful sanitizer port behavior", () => {
  it("strips control/bidi/format characters and reports what changed", async () => {
    const rtlOverride = String.fromCodePoint(0x202e);
    const input = `Free stuff!${rtlOverride}evil`;
    const res = await POST(makeRequest({ text: input }));
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.attackId).toBe("prompt_injection");
    expect(body.checkMethod).toBe("content_inspection");
    expect(body.passed).toBe(true);
    expect(body.rawResponse.sanitized).not.toContain(rtlOverride);
    expect(body.rawResponse.strippedCharCount).toBeGreaterThan(0);
  });

  it("truncates to 256 chars, matching the real facilitator's MAX_DESCRIPTION_LEN", async () => {
    const input = "A".repeat(300);
    const res = await POST(makeRequest({ text: input }));
    const body = await res.json();

    expect(body.rawResponse.truncated).toBe(true);
    expect(body.rawResponse.sanitizedLength).toBe(256);
    expect(body.passed).toBe(true);
  });

  it("reports passed:false (nothing to demonstrate) for already-clean input", async () => {
    const res = await POST(makeRequest({ text: "A totally normal description." }));
    const body = await res.json();

    expect(body.rawResponse.changed).toBe(false);
    expect(body.passed).toBe(false);
    expect(body.rawResponse.sanitized).toBe("A totally normal description.");
  });

  it("400s on a non-string text field", async () => {
    const res = await POST(makeRequest({ text: 12345 }));
    expect(res.status).toBe(400);
  });

  it("400s on invalid JSON", async () => {
    const req = new Request("http://localhost/api/attack/sanitize", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not valid json",
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("413s on an oversized body", async () => {
    const req = new Request("http://localhost/api/attack/sanitize", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": "999999" },
      body: JSON.stringify({ text: "x" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(413);
  });
});
