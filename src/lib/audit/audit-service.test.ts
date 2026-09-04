import { afterEach, describe, expect, it, vi } from "vitest";

import { logAuditEvent } from "./audit-service";

interface CapturedInsert {
  userId: string | null;
  eventType: string;
  payload: string;
}

function createFakeInsert() {
  const calls: CapturedInsert[] = [];
  const insert = vi.fn(async (input: {
    userId: string | null;
    eventType: string;
    payload: string;
  }) => {
    calls.push(input);
  });
  return { insert, calls };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("logAuditEvent: standard execution", () => {
  it("inserts the event type, user id, and stringified JSON payload", async () => {
    const { insert, calls } = createFakeInsert();

    await logAuditEvent(
      "user-123",
      "NOTE_CREATED",
      { title: "Groceries", noteId: "note-456" },
      { insert },
    );

    expect(insert).toHaveBeenCalledTimes(1);
    expect(calls[0]).toEqual({
      userId: "user-123",
      eventType: "NOTE_CREATED",
      payload: JSON.stringify({ title: "Groceries", noteId: "note-456" }),
    });
  });

  it("accepts a null userId", async () => {
    const { calls, insert } = createFakeInsert();

    await logAuditEvent(null, "AUTH_LOGIN_FAILED", { email: "a@b.com" }, {
      insert,
    });

    expect(calls[0].userId).toBeNull();
  });
});

describe("logAuditEvent: data privacy guard", () => {
  it("strips sensitive top-level keys from the payload before insertion", async () => {
    const { insert, calls } = createFakeInsert();

    await logAuditEvent(
      "user-123",
      "USER_REGISTERED",
      {
        email: "user@example.com",
        password: "Str0ngPass!",
        twoFactorSecret: "JBSWY3DPEHPK3PXP",
        recoveryCode: "AAAA-BBBB-CCCC-DDDD",
        totpCode: "123456",
        content: "sensitive note body",
      },
      { insert },
    );

    const storedPayload = JSON.parse(calls[0].payload);
    expect(storedPayload.email).toBe("user@example.com");
    expect(storedPayload).not.toHaveProperty("password");
    expect(storedPayload).not.toHaveProperty("twoFactorSecret");
    expect(storedPayload).not.toHaveProperty("recoveryCode");
    expect(storedPayload).not.toHaveProperty("totpCode");
    expect(storedPayload).not.toHaveProperty("content");
  });

  it("recursively strips sensitive keys nested inside the payload", async () => {
    const { insert, calls } = createFakeInsert();

    await logAuditEvent(
      "user-123",
      "NOTE_UPDATED",
      {
        noteId: "note-456",
        previous: { title: "Doc", content: "old body" },
        change: { secret: "hidden", password: "p4ss", ok: true },
      },
      { insert },
    );

    const storedPayload = JSON.parse(calls[0].payload);
    expect(storedPayload.noteId).toBe("note-456");
    expect(storedPayload.previous.title).toBe("Doc");
    expect(storedPayload.previous).not.toHaveProperty("content");
    expect(storedPayload.change).not.toHaveProperty("secret");
    expect(storedPayload.change).not.toHaveProperty("password");
    expect(storedPayload.change.ok).toBe(true);
  });
});

describe("logAuditEvent: fail-safe execution", () => {
  it("catches a database error, logs to console.error, and resolves without throwing", async () => {
    const error = new Error("database timeout");
    const insert = vi.fn(async () => {
      throw error;
    });
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    await expect(
      logAuditEvent("user-123", "NOTE_DELETED", { noteId: "x" }, { insert }),
    ).resolves.toBeUndefined();

    expect(consoleErrorSpy).toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.any(String), error);
  });

  it("resolves successfully when the database insertion throws", async () => {
    const insert = vi.fn(async () => {
      throw new Error("db down");
    });
    vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await logAuditEvent(
      "user-123",
      "NOTE_CREATED",
      { title: "T" },
      { insert },
    );

    expect(result).toBeUndefined();
  });
});