import { describe, expect, it } from "vitest";
import { generateSessionToken, hashSessionToken } from "./session";

describe("session token generation", () => {
  it("generates a base64url token of 43 characters (32 bytes)", () => {
    const token = generateSessionToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("generates unique tokens", () => {
    const tokens = new Set(Array.from({ length: 1000 }, () => generateSessionToken()));
    expect(tokens.size).toBe(1000);
  });
});

describe("session token hashing", () => {
  it("hashes to a 64-char sha256 hex digest", () => {
    const token = generateSessionToken();
    expect(hashSessionToken(token)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic for the same token", () => {
    const token = generateSessionToken();
    expect(hashSessionToken(token)).toBe(hashSessionToken(token));
  });

  it("does not expose the raw token", () => {
    const token = generateSessionToken();
    expect(hashSessionToken(token)).not.toContain(token);
  });

  it("produces different hashes for different tokens", () => {
    const a = generateSessionToken();
    const b = generateSessionToken();
    expect(hashSessionToken(a)).not.toBe(hashSessionToken(b));
  });
});