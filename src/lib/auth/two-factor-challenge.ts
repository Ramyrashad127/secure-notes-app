import { createHash, randomBytes } from "node:crypto";
import { valkey } from "@/lib/valkey";

/** HttpOnly cookie carrying the opaque challenge token while a 2FA login is pending. */
export const PENDING_2FA_CHALLENGE_COOKIE = "pending_2fa_challenge";

export const TWO_FACTOR_CHALLENGE_TTL_SECONDS = 60 * 10;

const VALKEY_KEY_PREFIX = "2fa-challenge:";

/**
 * Thrown when the 2FA challenge backend (ValKey) is unavailable. The 2FA
 * login challenge MUST fail closed: without the ephemeral cache token we
 * cannot safely establish a challenge, so callers surface an error page
 * instead of letting auth proceed.
 */
export class TwoFactorCacheUnavailableError extends Error {
  constructor() {
    super("Two-factor challenge is temporarily unavailable");
    this.name = "TwoFactorCacheUnavailableError";
  }
}

export interface TwoFactorChallengeRecord {
  userId: string;
  createdAt: string;
}

export interface TwoFactorChallengeStore {
  create(userId: string, ttlSeconds?: number): Promise<string>;
  resolve(token: string): Promise<TwoFactorChallengeRecord | null>;
  destroy(token: string): Promise<void>;
}

export function challengeKey(tokenHash: string): string {
  return `${VALKEY_KEY_PREFIX}${tokenHash}`;
}

export function generateChallengeToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashChallengeToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

const defaultStore: TwoFactorChallengeStore = {
  async create(userId, ttlSeconds = TWO_FACTOR_CHALLENGE_TTL_SECONDS) {
    try {
      const token = generateChallengeToken();
      const record: TwoFactorChallengeRecord = {
        userId,
        createdAt: new Date().toISOString(),
      };
      await valkey.set(
        challengeKey(hashChallengeToken(token)),
        JSON.stringify(record),
        "EX",
        ttlSeconds,
      );
      return token;
    } catch (err) {
      console.error?.(
        "[2FA_CHALLENGE] create failed; failing closed:",
        err instanceof Error ? err.message : String(err),
      );
      throw new TwoFactorCacheUnavailableError();
    }
  },
  async resolve(token) {
    try {
      const raw = await valkey.get(challengeKey(hashChallengeToken(token)));
      if (!raw) return null;
      try {
        return JSON.parse(raw) as TwoFactorChallengeRecord;
      } catch {
        return null;
      }
    } catch (err) {
      console.error?.(
        "[2FA_CHALLENGE] resolve failed; failing closed:",
        err instanceof Error ? err.message : String(err),
      );
      throw new TwoFactorCacheUnavailableError();
    }
  },
  async destroy(token) {
    try {
      await valkey.del(challengeKey(hashChallengeToken(token)));
    } catch (err) {
      // Destroying the challenge is best-effort cleanup; if ValKey is down
      // the TTL will expire it. Do not block the successful login on it.
      console.error?.(
        "[2FA_CHALLENGE] destroy failed (ignored):",
        err instanceof Error ? err.message : String(err),
      );
    }
  },
};

export async function createTwoFactorChallenge(
  userId: string,
  store: TwoFactorChallengeStore = defaultStore,
): Promise<string> {
  try {
    return await store.create(userId);
  } catch (err) {
    console.error?.(
      "[2FA_CHALLENGE] create failed; failing closed:",
      err instanceof Error ? err.message : String(err),
    );
    throw new TwoFactorCacheUnavailableError();
  }
}

export async function resolveTwoFactorChallenge(
  token: string,
  store: TwoFactorChallengeStore = defaultStore,
): Promise<TwoFactorChallengeRecord | null> {
  try {
    return await store.resolve(token);
  } catch (err) {
    console.error?.(
      "[2FA_CHALLENGE] resolve failed; failing closed:",
      err instanceof Error ? err.message : String(err),
    );
    throw new TwoFactorCacheUnavailableError();
  }
}

export async function destroyTwoFactorChallenge(
  token: string,
  store: TwoFactorChallengeStore = defaultStore,
): Promise<void> {
  try {
    await store.destroy(token);
  } catch (err) {
    // Best-effort cleanup; the TTL will expire the challenge.
    console.error?.(
      "[2FA_CHALLENGE] destroy failed (ignored):",
      err instanceof Error ? err.message : String(err),
    );
  }
}