import { headers } from "next/headers";
import { valkey } from "@/lib/valkey";

export type RateLimitBucket = "login" | "register" | "two-factor";

export interface RateLimitConfig {
  limit: number;
  windowSeconds: number;
}

export const RATE_LIMIT_CONFIGS: Record<RateLimitBucket, RateLimitConfig> = {
  login: { limit: 10, windowSeconds: 60 },
  register: { limit: 10, windowSeconds: 60 * 60 },
  "two-factor": { limit: 5, windowSeconds: 60 * 10 },
};

export class RateLimitExceededError extends Error {
  constructor(
    message: string,
    public readonly retryAfterSeconds: number,
  ) {
    super(message);
    this.name = "RateLimitExceededError";
  }
}

export interface RateLimiterStore {
  increment(key: string, windowSeconds: number): Promise<number>;
}

const defaultStore: RateLimiterStore = {
  async increment(key, windowSeconds) {
    const results = await valkey
      .multi()
      .incr(key)
      .expire(key, windowSeconds)
      .exec();
    return (results?.[0]?.[1] as number) ?? 0;
  },
};

export function rateLimitKey(
  bucket: RateLimitBucket,
  discriminator: string,
): string {
  return `ratelimit:${bucket}:${discriminator}`;
}

/** Increment a rate-limit bucket; throws RateLimitExceededError when over the limit. */
export async function checkRateLimit(
  bucket: RateLimitBucket,
  discriminator: string,
  store: RateLimiterStore = defaultStore,
): Promise<void> {
  const config = RATE_LIMIT_CONFIGS[bucket];
  const count = await store.increment(
    rateLimitKey(bucket, discriminator),
    config.windowSeconds,
  );
  if (count > config.limit) {
    throw new RateLimitExceededError(
      "Too many attempts. Please try again later.",
      config.windowSeconds,
    );
  }
}

export function rateLimitErrorMessage(): string {
  return "Too many attempts. Please try again later.";
}

/** Best-effort client IP from forwarding headers. Falls back to "unknown". */
export async function getClientIp(): Promise<string> {
  try {
    const headerStore = await headers();
    const forwardedFor = headerStore.get("x-forwarded-for");
    if (forwardedFor) {
      const first = forwardedFor.split(",")[0]?.trim();
      if (first) return first;
    }
    const realIp = headerStore.get("x-real-ip");
    if (realIp) return realIp;
  } catch {
    // next/headers is only available in request scope.
  }
  return "unknown";
}