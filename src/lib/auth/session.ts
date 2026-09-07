import { createHash, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { sessions, type Session } from "@/db/schema";
import { valkey } from "@/lib/valkey";
import { recordCacheOperation } from "@/lib/metrics";

export const SESSION_COOKIE_NAME = "session";
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 14;
const VALKEY_KEY_PREFIX = "session:";

export interface SessionCacheStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<unknown>;
  del(key: string): Promise<unknown>;
}

export interface SessionPersistenceStore {
  insert(
    tokenHash: string,
    userId: string,
    expiresAt: Date,
    meta?: SessionMeta,
  ): Promise<Session>;
  findByTokenHash(tokenHash: string): Promise<Session | null>;
  revoke(tokenHash: string, reason?: string): Promise<void>;
}

export interface SessionMeta {
  ipAddress?: string;
  userAgent?: string;
}

export interface SessionDeps {
  valkeyStore?: SessionCacheStore;
  dbStore?: SessionPersistenceStore;
}

const defaultDeps: Required<SessionDeps> = {
  valkeyStore: {
    get(key) {
      return valkey.get(key);
    },
    set(key, value, ttlSeconds) {
      return valkey.set(key, value, "EX", ttlSeconds);
    },
    del(key) {
      return valkey.del(key);
    },
  },
  dbStore: {
    async insert(tokenHash, userId, expiresAt, meta) {
      const [session] = await db
        .insert(sessions)
        .values({
          tokenHash,
          userId,
          expiresAt,
          ipAddress: meta?.ipAddress,
          userAgent: meta?.userAgent,
        })
        .returning();
      if (!session) throw new Error("Failed to create session");
      return session;
    },
    async findByTokenHash(tokenHash) {
      const [session] = await db
        .select()
        .from(sessions)
        .where(eq(sessions.tokenHash, tokenHash));
      return session ?? null;
    },
    async revoke(tokenHash, reason) {
      await db
        .update(sessions)
        .set({ revokedAt: new Date(), revokedReason: reason })
        .where(eq(sessions.tokenHash, tokenHash));
    },
  },
};

function cacheKey(tokenHash: string): string {
  return `${VALKEY_KEY_PREFIX}${tokenHash}`;
}

export function generateSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

async function getCachedSession(
  tokenHash: string,
  store: SessionCacheStore,
): Promise<Session | null> {
  let raw: string | null;
  try {
    raw = await store.get(cacheKey(tokenHash));
  } catch (err) {
    // Cache unavailable: fail open by treating the read as a miss so the
    // caller falls back to PostgreSQL. Never let a cache outage become a 500.
    console.warn?.(
      "[SESSION_CACHE] read failed; falling back to database:",
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Session;
    return {
      ...parsed,
      expiresAt: new Date(parsed.expiresAt),
      createdAt: new Date(parsed.createdAt),
      lastUsedAt: parsed.lastUsedAt ? new Date(parsed.lastUsedAt) : null,
      revokedAt: parsed.revokedAt ? new Date(parsed.revokedAt) : null,
    };
  } catch {
    return null;
  }
}

async function cacheSession(
  tokenHash: string,
  session: Session,
  store: SessionCacheStore,
): Promise<void> {
  try {
    await store.set(
      cacheKey(tokenHash),
      JSON.stringify(session),
      SESSION_TTL_SECONDS,
    );
  } catch (err) {
    // Write failure is non-fatal: the session already exists in the database.
    console.warn?.(
      "[SESSION_CACHE] write failed; continuing without cache:",
      err instanceof Error ? err.message : String(err),
    );
  }
}

function isSessionValid(session: Session, now: Date): boolean {
  if (session.revokedAt) return false;
  if (session.expiresAt.getTime() <= now.getTime()) return false;
  return true;
}

export async function createSession(
  userId: string,
  meta?: SessionMeta,
  deps: Required<SessionDeps> = defaultDeps,
): Promise<{ token: string; session: Session }> {
  const token = generateSessionToken();
  const tokenHash = hashSessionToken(token);
  const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000);
  const session = await deps.dbStore.insert(tokenHash, userId, expiresAt, meta);
  await cacheSession(tokenHash, session, deps.valkeyStore);
  return { token, session };
}

export async function getSession(
  token: string,
  now: Date = new Date(),
  deps: Required<SessionDeps> = defaultDeps,
): Promise<Session | null> {
  const tokenHash = hashSessionToken(token);

  const cached = await getCachedSession(tokenHash, deps.valkeyStore);
  if (cached) {
    recordCacheOperation("hit");
    if (!isSessionValid(cached, now)) return null;
    return cached;
  }

  recordCacheOperation("miss");
  const session = await deps.dbStore.findByTokenHash(tokenHash);
  if (!session || !isSessionValid(session, now)) return null;

  await cacheSession(tokenHash, session, deps.valkeyStore);
  return session;
}

export async function revokeSession(
  token: string,
  reason?: string,
  deps: Required<SessionDeps> = defaultDeps,
): Promise<void> {
  const tokenHash = hashSessionToken(token);
  try {
    await deps.valkeyStore.del(cacheKey(tokenHash));
  } catch (err) {
    // Deleting from the cache is best-effort; the DB revoke is the source of
    // truth and must not be interrupted by a cache outage.
    console.warn?.(
      "[SESSION_CACHE] delete failed; continuing with database revoke:",
      err instanceof Error ? err.message : String(err),
    );
  }
  await deps.dbStore.revoke(tokenHash, reason);
}

export interface SessionCookieOptions {
  httpOnly: boolean;
  secure: boolean;
  sameSite: "strict";
  path: string;
  maxAge: number;
}

export function getSessionCookieOptions(
  secure = process.env.NODE_ENV === "production",
): SessionCookieOptions {
  return {
    httpOnly: true,
    secure,
    sameSite: "strict",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  };
}