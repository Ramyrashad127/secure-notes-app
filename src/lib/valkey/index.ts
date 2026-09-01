import { Redis } from "ioredis";

declare global {
  var __valkey: Redis | undefined;
}

const connectionString = process.env.VALKEY_URL ?? "redis://localhost:6379";

if (!globalThis.__valkey) {
  globalThis.__valkey = new Redis(connectionString, {
    maxRetriesPerRequest: 2,
    lazyConnect: true,
  });
}

export const valkey = globalThis.__valkey;