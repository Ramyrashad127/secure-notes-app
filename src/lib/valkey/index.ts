import { Redis } from "ioredis";

declare global {
  var __valkey: Redis | undefined;
}

const connectionString = process.env.VALKEY_URL ?? "redis://localhost:6379";

/**
 * Fail-fast ioredis client.
 *
 * - `lazyConnect` + short timeouts mean a down cache surfaces in ~1s, not
 *   ~30s (the original 30s hang came from long connect timeouts + unbounded
 *   reconnects blocking request handling).
 * - No auto-reconnect in the background: callers go through `accessValkey()`
 *   which hands out a working client (recreating it if the current one has
 *   disconnected), so the app self-heals after a ValKey outage.
 */
function makeClient(): Redis {
  return new Redis(connectionString, {
    maxRetriesPerRequest: 1,
    lazyConnect: true,
    connectTimeout: 2_000,
    commandTimeout: 1_500,
    enableReadyCheck: true,
    retryStrategy: () => null,
  });
}

let redis: Redis = (globalThis.__valkey ??= makeClient());

/**
 * Return a usable ValKey client, recreating it if the current instance is
 * no longer connected. This replaces the previous circuit-breaker's
 * "refresh on trip" with a lightweight self-heal: every call site asks for
 * a live client, so a client that died during an outage is swapped for a
 * fresh one automatically (no restart needed once ValKey returns).
 */
export function accessValkey(): Redis {
  if (redis.status !== "ready") {
    const candidate = makeClient();
    const former = redis;
    redis = candidate;
    (globalThis as { __valkey?: Redis }).__valkey = candidate;
    try {
      former.disconnect?.();
    } catch {
      // best effort
    }
  }
  return redis;
}

/**
 * Back-compat surface: forwards every access to the current live client so
 * existing imports of `valkey` (session, rate-limit, two-factor-challenge)
 * always talk to a working instance without a code change.
 */
export const valkey: Redis = new Proxy({} as Redis, {
  get(_target, prop) {
    const client = accessValkey();
    const value = Reflect.get(client, prop, client);
    return typeof value === "function" ? value.bind(client) : value;
  },
  set(_target, prop, value) {
    // Let callers read config/options; mutations belong to makeClient.
    Reflect.set(accessValkey(), prop, value);
    return true;
  },
});