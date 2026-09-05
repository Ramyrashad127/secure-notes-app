import { createHash, randomBytes } from "node:crypto";
import { valkey } from "@/lib/valkey";

/** HttpOnly cookie carrying the opaque challenge token while a 2FA login is pending. */
export const PENDING_2FA_CHALLENGE_COOKIE = "pending_2fa_challenge";

export const TWO_FACTOR_CHALLENGE_TTL_SECONDS = 60 * 10;

const VALKEY_KEY_PREFIX = "2fa-challenge:";

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
  },
  async resolve(token) {
    const raw = await valkey.get(challengeKey(hashChallengeToken(token)));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as TwoFactorChallengeRecord;
    } catch {
      return null;
    }
  },
  async destroy(token) {
    await valkey.del(challengeKey(hashChallengeToken(token)));
  },
};

export async function createTwoFactorChallenge(
  userId: string,
  store: TwoFactorChallengeStore = defaultStore,
): Promise<string> {
  return store.create(userId);
}

export async function resolveTwoFactorChallenge(
  token: string,
  store: TwoFactorChallengeStore = defaultStore,
): Promise<TwoFactorChallengeRecord | null> {
  return store.resolve(token);
}

export async function destroyTwoFactorChallenge(
  token: string,
  store: TwoFactorChallengeStore = defaultStore,
): Promise<void> {
  await store.destroy(token);
}