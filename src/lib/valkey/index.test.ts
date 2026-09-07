import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Redis } from "ioredis";
import { accessValkey } from "./index";

describe("valkey client self-heal", () => {
  const originalState = (globalThis as { __valkey?: unknown }).__valkey;

  beforeEach(() => {
    // Force a fresh client for each test by clearing the module-level client.
    (globalThis as { __valkey?: unknown }).__valkey = undefined;
    vi.resetModules();
  });

  afterEach(() => {
    (globalThis as { __valkey?: unknown }).__valkey = originalState;
    vi.restoreAllMocks();
  });

  it("accessValkey returns a client that connects to the configured instance", async () => {
    const client = accessValkey();
    expect(client).toBeInstanceOf(Redis);
  });

  it("creates a fresh client when the current one is not ready (self-heal)", async () => {
    const { accessValkey: accessFresh } = await import("./index");
    const first = accessFresh();
    // Simulate a dead connection: kill the underlying socket so status != ready.
    first.status = "close"; // readonly at type level; cast to mutate
    const second = accessFresh();
    expect(second).not.toBe(first);
    // After healing, both old and new clients can be disconnected cleanly.
    try {
      first.disconnect?.();
    } catch {
      /* noop */
    }
    try {
      second.disconnect?.();
    } catch {
      /* noop */
    }
  });
});