import { beforeEach, describe, expect, it, vi } from "vitest";

const memory = new Map<string, string>();
const setCalls: { key: string; value: string; ttl: number }[] = [];

vi.mock("@/lib/valkey", () => ({
  valkey: {
    async get(key: string) {
      return memory.get(key) ?? null;
    },
    async set(key: string, value: string, mode: string, ttl: number) {
      memory.set(key, value);
      setCalls.push({ key, value, ttl });
      void mode;
      return "OK";
    },
    async del(key: string) {
      memory.delete(key);
    },
    multi() {
      throw new Error("multi not used here");
    },
  },
}));

import {
  challengeKey,
  createTwoFactorChallenge,
  destroyTwoFactorChallenge,
  generateChallengeToken,
  hashChallengeToken,
  PENDING_2FA_CHALLENGE_COOKIE,
  resolveTwoFactorChallenge,
  TWO_FACTOR_CHALLENGE_TTL_SECONDS,
} from "./two-factor-challenge";

describe("challenge token primitives", () => {
  it("generates opaque, unique tokens that reveal no user data", () => {
    const tokenA = generateChallengeToken();
    const tokenB = generateChallengeToken();

    expect(tokenA).not.toBe(tokenB);
    expect(tokenA).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(tokenA).not.toContain("user-id");
    expect(tokenA).not.toContain("user@example.com");
  });

  it("hashes tokens deterministically with sha256", () => {
    expect(hashChallengeToken("abc")).toBe(hashChallengeToken("abc"));
    expect(hashChallengeToken("abc")).not.toBe(hashChallengeToken("abd"));
    expect(challengeKey(hashChallengeToken("abc"))).toBe(
      "2fa-challenge:" + hashChallengeToken("abc"),
    );
  });

  it("uses the opaque challenge cookie name, not the user id", () => {
    expect(PENDING_2FA_CHALLENGE_COOKIE).toBe("pending_2fa_challenge");
    expect(PENDING_2FA_CHALLENGE_COOKIE).not.toContain("user");
  });
});

describe("Valkey-backed challenge lifecycle", () => {
  beforeEach(() => {
    memory.clear();
    setCalls.length = 0;
  });

  it("creates a challenge and resolves it back to the user id", async () => {
    const token = await createTwoFactorChallenge("user-42");

    expect(token).toBeTruthy();
    const record = await resolveTwoFactorChallenge(token);
    expect(record?.userId).toBe("user-42");
    expect(record?.createdAt).toBeTruthy();
  });

  it("persists only a hashed key with the challenge TTL", async () => {
    const token = await createTwoFactorChallenge("user-42");

    expect(memory.has(challengeKey(hashChallengeToken(token)))).toBe(true);
    const set = setCalls.find((c) => c.key === challengeKey(hashChallengeToken(token)));
    expect(set).toBeTruthy();
    expect(set?.ttl).toBe(TWO_FACTOR_CHALLENGE_TTL_SECONDS);
    expect(set?.value).toContain('"userId":"user-42"');
  });

  it("returns null for an unknown or expired token", async () => {
    expect(await resolveTwoFactorChallenge("does-not-exist")).toBeNull();
  });

  it("does not consume the challenge on resolve (repeatable before success)", async () => {
    const token = await createTwoFactorChallenge("user-42");

    expect((await resolveTwoFactorChallenge(token))?.userId).toBe("user-42");
    expect((await resolveTwoFactorChallenge(token))?.userId).toBe("user-42");
  });

  it("invalidates the challenge on destroy", async () => {
    const token = await createTwoFactorChallenge("user-42");
    expect((await resolveTwoFactorChallenge(token))?.userId).toBe("user-42");

    await destroyTwoFactorChallenge(token);
    expect(await resolveTwoFactorChallenge(token)).toBeNull();
  });

  it("keeps challenges isolated between users", async () => {
    const tokenA = await createTwoFactorChallenge("user-a");
    const tokenB = await createTwoFactorChallenge("user-b");

    expect((await resolveTwoFactorChallenge(tokenA))?.userId).toBe("user-a");
    expect((await resolveTwoFactorChallenge(tokenB))?.userId).toBe("user-b");
  });
});