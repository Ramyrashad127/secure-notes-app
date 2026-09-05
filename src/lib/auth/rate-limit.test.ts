import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  checkRateLimit,
  getClientIp,
  RateLimitExceededError,
  rateLimitKey,
  RATE_LIMIT_CONFIGS,
  type RateLimiterStore,
} from "./rate-limit";

function createInMemoryStore(): {
  store: RateLimiterStore;
  counts: Map<string, number>;
} {
  const counts = new Map<string, number>();
  return {
    counts,
    store: {
      async increment(key, windowSeconds) {
        const next = (counts.get(key) ?? 0) + 1;
        counts.set(key, next);
        void windowSeconds;
        return next;
      },
    },
  };
}

describe("checkRateLimit", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("allows requests up to and including the limit", async () => {
    const { store } = createInMemoryStore();
    const limit = RATE_LIMIT_CONFIGS.login.limit;

    for (let i = 0; i < limit; i++) {
      await expect(
        checkRateLimit("login", "127.0.0.1:user@example.com", store),
      ).resolves.toBeUndefined();
    }
  });

  it("rejects once the limit is exceeded", async () => {
    const { store } = createInMemoryStore();
    const limit = RATE_LIMIT_CONFIGS.login.limit;

    for (let i = 0; i < limit; i++) {
      await checkRateLimit("login", "127.0.0.1:user@example.com", store);
    }

    await expect(
      checkRateLimit("login", "127.0.0.1:user@example.com", store),
    ).rejects.toBeInstanceOf(RateLimitExceededError);
  });

  it("reports a retry-after window on the error", async () => {
    const { store } = createInMemoryStore();
    const windowSeconds = RATE_LIMIT_CONFIGS.login.windowSeconds;

    for (let i = 0; i < RATE_LIMIT_CONFIGS.login.limit; i++) {
      await checkRateLimit("login", "k1", store);
    }

    try {
      await checkRateLimit("login", "k1", store);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(RateLimitExceededError);
      expect((error as RateLimitExceededError).retryAfterSeconds).toBe(
        windowSeconds,
      );
    }
  });

  it("keeps distinct discriminators isolated", async () => {
    const { store } = createInMemoryStore();
    const limit = RATE_LIMIT_CONFIGS.login.limit;

    for (let i = 0; i < limit; i++) {
      await checkRateLimit("login", "ip-a:alice@example.com", store);
    }

    await expect(
      checkRateLimit("login", "ip-a:bob@example.com", store),
    ).resolves.toBeUndefined();
    await expect(
      checkRateLimit("login", "ip-b:alice@example.com", store),
    ).resolves.toBeUndefined();
  });

  it("keeps buckets isolated per config", async () => {
    const { store } = createInMemoryStore();
    const twoFactorLimit = RATE_LIMIT_CONFIGS["two-factor"].limit;

    for (let i = 0; i < twoFactorLimit; i++) {
      await checkRateLimit("two-factor", "ip:user", store);
    }

    await expect(
      checkRateLimit("login", "ip:user", store),
    ).resolves.toBeUndefined();
  });
});

describe("rateLimitKey", () => {
  it("namespaces keys by bucket and discriminator", () => {
    expect(rateLimitKey("login", "ip:user@example.com")).toBe(
      "ratelimit:login:ip:user@example.com",
    );
    expect(rateLimitKey("two-factor", "ip:user-1")).toBe(
      "ratelimit:two-factor:ip:user-1",
    );
  });
});

describe("getClientIp", () => {
  it("falls back to unknown outside a request scope", async () => {
    expect(await getClientIp()).toBe("unknown");
  });
});