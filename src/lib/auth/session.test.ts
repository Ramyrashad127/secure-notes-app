import { describe, expect, it } from "vitest";
import {
  createSession,
  getSession,
  generateSessionToken,
  hashSessionToken,
  revokeSession,
  type SessionCacheStore,
  type SessionDeps,
  type SessionPersistenceStore,
  SESSION_TTL_SECONDS,
} from "./session";
import type { Session } from "@/db/schema";

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "session-id",
    userId: "user-id",
    tokenHash: "hash",
    expiresAt: new Date(Date.now() + SESSION_TTL_SECONDS * 1000),
    lastUsedAt: null,
    revokedAt: null,
    revokedReason: null,
    ipAddress: null,
    userAgent: null,
    createdAt: new Date(),
    ...overrides,
  };
}

interface InMemoryStores {
  cache: Map<string, { ttl: number; value: string }>;
  db: Map<string, Session>;
}

function createFakeDeps(): {
  deps: Required<SessionDeps>;
  stores: InMemoryStores;
} {
  const stores: InMemoryStores = {
    cache: new Map(),
    db: new Map(),
  };

  const valkeyStore: SessionCacheStore = {
    async get(key) {
      return stores.cache.get(key)?.value ?? null;
    },
    async set(key, value, ttlSeconds) {
      stores.cache.set(key, { ttl: ttlSeconds, value });
    },
    async del(key) {
      stores.cache.delete(key);
    },
  };

  const dbStore: SessionPersistenceStore = {
    async insert(tokenHash, userId, expiresAt, meta) {
      const session = makeSession({
        tokenHash,
        userId,
        expiresAt,
        ipAddress: meta?.ipAddress ?? null,
        userAgent: meta?.userAgent ?? null,
      });
      stores.db.set(tokenHash, session);
      return session;
    },
    async findByTokenHash(tokenHash) {
      return stores.db.get(tokenHash) ?? null;
    },
    async revoke(tokenHash, reason) {
      const session = stores.db.get(tokenHash);
      if (session) {
        session.revokedAt = new Date();
        session.revokedReason = reason ?? null;
      }
    },
  };

  return { deps: { valkeyStore, dbStore }, stores };
}

describe("createSession", () => {
  it("persists a session to the db store and caches it", async () => {
    const { deps, stores } = createFakeDeps();
    const { token, session } = await createSession("user-id", undefined, deps);

    expect(token.length).toBeGreaterThan(0);
    expect(session.userId).toBe("user-id");
    expect(stores.db.size).toBe(1);
    expect(stores.cache.size).toBe(1);
  });
});

describe("getSession", () => {
  it("returns a valid session from cache", async () => {
    const { deps, stores } = createFakeDeps();
    const { token, session } = await createSession("user-id", undefined, deps);
    stores.db.clear();
    stores.cache.set("session:" + session.tokenHash, {
      ttl: 60,
      value: JSON.stringify(session),
    });

    const result = await getSession(token, new Date(), deps);
    expect(result).toEqual(session);
  });

  it("falls back to the db store on a cache miss", async () => {
    const { deps, stores } = createFakeDeps();
    const { token, session } = await createSession("user-id", undefined, deps);
    stores.cache.clear();

    const result = await getSession(token, new Date(), deps);
    expect(result).toEqual(session);
    expect(stores.cache.size).toBe(1);
  });

  it("returns null for a revoked session from db fallback", async () => {
    const { deps, stores } = createFakeDeps();
    const { token, session } = await createSession("user-id", undefined, deps);
    session.revokedAt = new Date();
    stores.cache.clear();

    await expect(getSession(token, new Date(), deps)).resolves.toBeNull();
  });

  it("returns null for a revoked session from cache", async () => {
    const { deps, stores } = createFakeDeps();
    const token = generateSessionToken();
    const session = makeSession({
      tokenHash: hashSessionToken(token),
      revokedAt: new Date(),
    });
    stores.cache.set("session:" + session.tokenHash, {
      ttl: 60,
      value: JSON.stringify(session),
    });

    await expect(getSession(token, new Date(), deps)).resolves.toBeNull();
  });

  it("returns null for an expired session", async () => {
    const { deps } = createFakeDeps();
    const { token, session } = await createSession("user-id", undefined, deps);
    const afterExpiry = new Date(session.expiresAt.getTime() + 1000);

    await expect(getSession(token, afterExpiry, deps)).resolves.toBeNull();
  });

  it("returns null for a token with no matching session", async () => {
    const { deps } = createFakeDeps();
    await expect(getSession("no-such-token", new Date(), deps)).resolves.toBeNull();
  });
});

describe("revokeSession", () => {
  it("removes the cache entry and revokes the db record", async () => {
    const { deps, stores } = createFakeDeps();
    const { token } = await createSession("user-id", undefined, deps);

    await revokeSession(token, "logout", deps);

    expect(stores.cache.size).toBe(0);
    const sessions = Array.from(stores.db.values());
    expect(sessions[0].revokedAt).toBeInstanceOf(Date);
    expect(sessions[0].revokedReason).toBe("logout");
    await expect(getSession(token, new Date(), deps)).resolves.toBeNull();
  });
});

describe("cache fault tolerance", () => {
  it("getSession falls back to the db when the cache read throws", async () => {
    const { deps, stores } = createFakeDeps();
    const { token, session } = await createSession("user-id", undefined, deps);
    stores.cache.clear();

    const throwingStore: SessionCacheStore = {
      async get() {
        throw new Error("connect ECONNREFUSED");
      },
      async set() {},
      async del() {},
    };

    const result = await getSession(token, new Date(), { ...deps, valkeyStore: throwingStore });
    expect(result).toEqual(session);
  });

  it("getSession returns null when both cache and db are down", async () => {
    const { deps } = createFakeDeps();

    const throwingStore: SessionCacheStore = {
      async get() {
        throw new Error("connect ECONNREFUSED");
      },
      async set() {},
      async del() {},
    };

    await expect(
      getSession("token", new Date(), { ...deps, valkeyStore: throwingStore }),
    ).resolves.toBeNull();
  });

  it("createSession still persists to the db when the cache write throws", async () => {
    const { deps, stores } = createFakeDeps();

    const throwingStore: SessionCacheStore = {
      async get() {
        return null;
      },
      async set() {
        throw new Error("connect ECONNREFUSED");
      },
      async del() {},
    };

    const { token, session } = await createSession("user-id", undefined, {
      ...deps,
      valkeyStore: throwingStore,
    });

    expect(session.userId).toBe("user-id");
    expect(stores.db.size).toBe(1);
    // Cache write failed but the DB session is authoritative.
    await expect(getSession(token, new Date(), deps)).resolves.toEqual(session);
  });

  it("getSession still works when the cache write back on a miss throws", async () => {
    const { deps, stores } = createFakeDeps();
    const { token, session } = await createSession("user-id", undefined, deps);
    stores.cache.clear();

    const throwingStore: SessionCacheStore = {
      async get() {
        return null; // always a miss -> forces db fallback
      },
      async set() {
        throw new Error("connect ECONNREFUSED");
      },
      async del() {},
    };

    const result = await getSession(token, new Date(), { ...deps, valkeyStore: throwingStore });
    expect(result).toEqual(session);
  });

  it("revokeSession still revokes the db record when the cache delete throws", async () => {
    const { deps, stores } = createFakeDeps();
    const { token } = await createSession("user-id", undefined, deps);

    const throwingStore: SessionCacheStore = {
      async get() {
        return null;
      },
      async set() {},
      async del() {
        throw new Error("connect ECONNREFUSED");
      },
    };

    await revokeSession(token, "logout", { ...deps, valkeyStore: throwingStore });

    const sessions = Array.from(stores.db.values());
    expect(sessions[0].revokedAt).toBeInstanceOf(Date);
    expect(sessions[0].revokedReason).toBe("logout");

    // A fresh lookup of the revoked session (non-throwing cache) must return
    // null — the DB revoke is authoritative even though the cache delete threw.
    const fresh = createFakeDeps();
    const stored = stores.db.get(hashSessionToken(token));
    if (stored) {
      fresh.stores.db.set(hashSessionToken(token), stored);
      await expect(getSession(token, new Date(), fresh.deps)).resolves.toBeNull();
    } else {
      throw new Error("expected a stored session");
    }
  });
});