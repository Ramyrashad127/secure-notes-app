import { beforeEach, describe, expect, it } from "vitest";

import { InvalidCredentialsError, loginUser } from "@/lib/auth/auth-service";
import { getSession, hashSessionToken } from "@/lib/auth/session";
import {
  consumeRecoveryCode,
  verifyLoginChallenge,
  type TwoFactorDeps,
} from "@/lib/auth/two-factor-service";
import {
  createNote,
  updateNote,
  type NotesDeps,
} from "@/lib/notes/notes-service";
import type { Session, User } from "@/db/schema";
import { registry } from "@/lib/metrics";

const now = new Date();

function hashOf(password: string): string {
  return `hash:${Buffer.from(password).toString("base64")}`;
}

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: "user-id",
    email: "user@example.com",
    passwordHash: hashOf("pass"),
    twoFactorEnabled: false,
    twoFactorSecretEncrypted: null,
    twoFactorBackupCodes: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "session-id",
    userId: "user-id",
    tokenHash: "hash",
    expiresAt: new Date(Date.now() + 60_000),
    lastUsedAt: null,
    revokedAt: null,
    revokedReason: null,
    ipAddress: null,
    userAgent: null,
    createdAt: now,
    ...overrides,
  };
}

async function readCounter(name: string): Promise<string> {
  return registry.getSingleMetricAsString(name);
}

describe("telemetry integration (services -> counters)", () => {
  beforeEach(() => {
    registry.resetMetrics();
  });

  it("records login success and invalid-credential failures", async () => {
    const user = makeUser();
    const deps = {
      userStore: {
        async findByEmail(email: string) {
          return email === user.email ? user : null;
        },
        async findById(id: string) {
          return id === user.id ? user : null;
        },
        async insert() {
          return user;
        },
      },
      passwordStore: {
        async hash(p: string) {
          return hashOf(p);
        },
        async verify(password: string, hash: string) {
          return hash === hashOf(password);
        },
      },
      sessionStore: {
        async create() {
          return { token: "t" };
        },
        async resolve() {
          return makeSession();
        },
        async revoke() {},
      },
      auditLogger() {},
    };

    await loginUser({ email: user.email, password: "pass" }, deps as never);
    await expect(
      loginUser({ email: user.email, password: "wrong" }, deps as never),
    ).rejects.toThrow(InvalidCredentialsError);

    const out = await readCounter("auth_events_total");
    expect(out).toContain('auth_events_total{type="login",status="success",reason=""} 1');
    expect(out).toContain(
      'auth_events_total{type="login",status="failure",reason="invalid_credentials"} 1',
    );
  });

  it("records 2FA challenge failures with an invalid_code label", async () => {
    const deps: TwoFactorDeps = {
      userStore: {
        async findById() {
          return makeUser({
            twoFactorEnabled: true,
            twoFactorSecretEncrypted: "encrypted-secret",
          });
        },
        async updateTwoFactor() {},
      },
      sessionStore: {
        async create() {
          return { token: "t" };
        },
      },
      crypto: {
        generateTotpSecret: () => "A",
        generateTotpUri: () => "otpauth://",
        encryptSecret: (s: string) => s,
        decryptSecret: (s: string) => s,
        verifyTotp: () => false,
        generateRecoveryCodes: () => [],
        hashRecoveryCode: async (c: string) => c,
      },
      auditLogger() {},
    };

    await expect(verifyLoginChallenge("user-id", "000000", deps)).rejects.toThrow();

    const out = await readCounter("auth_events_total");
    expect(out).toContain('auth_events_total{type="2fa",status="failure",reason="invalid_code"} 1');
  });

  it("records recovery-code failures with an invalid_recovery_code label", async () => {
    const deps: TwoFactorDeps = {
      userStore: {
        async findById() {
          return makeUser({
            twoFactorEnabled: true,
            twoFactorBackupCodes: ["XXXX-XXXX-XXXX-XXXX"],
          });
        },
        async updateTwoFactor() {},
      },
      sessionStore: {
        async create() {
          return { token: "t" };
        },
      },
      crypto: {
        generateTotpSecret: () => "A",
        generateTotpUri: () => "otpauth://",
        encryptSecret: (s: string) => s,
        decryptSecret: (s: string) => s,
        verifyTotp: () => false,
        generateRecoveryCodes: () => [],
        hashRecoveryCode: async (c: string) => c.toLowerCase(),
      },
      auditLogger() {},
    };

    await expect(consumeRecoveryCode("user-id", "NOPE-NOPE-NOPE-NOPE", deps)).rejects.toThrow();

    const out = await readCounter("auth_events_total");
    expect(out).toContain(
      'auth_events_total{type="2fa",status="failure",reason="invalid_recovery_code"} 1',
    );
  });

  it("records note creation, manual updates, autosaves, skips, and autosave failures", async () => {
    const state = {
      notes: [] as Array<{
        id: string;
        userId: string;
        title: string;
        content: string;
        deletedAt: Date | null;
        createdAt: Date;
        updatedAt: Date;
      }>,
      versions: [] as Array<{
        id: string;
        noteId: string;
        userId: string;
        version: number;
        title: string;
        content: string;
        createdAt: Date;
      }>,
    };

    const deps: Required<NotesDeps> = {
      noteStore: {
        async listByUserId(userId: string) {
          return state.notes.filter((n) => n.userId === userId && !n.deletedAt);
        },
        async findByIdAndUserId(id: string, userId: string) {
          return state.notes.find((n) => n.id === id && n.userId === userId && !n.deletedAt) ?? null;
        },
        async insert(data) {
          const note = {
            id: `note-${state.notes.length + 1}`,
            deletedAt: null,
            createdAt: now,
            updatedAt: now,
            ...data,
          };
          state.notes.push(note);
          return note as never;
        },
        async update(id, userId, data) {
          const note = state.notes.find((n) => n.id === id && n.userId === userId);
          if (!note) throw new Error("not found");
          note.title = data.title;
          note.content = data.content;
          note.updatedAt = new Date();
          return note as never;
        },
        async softDelete(id: string, userId: string) {
          const note = state.notes.find((n) => n.id === id && n.userId === userId);
          if (note) note.deletedAt = new Date();
        },
      },
      versionStore: {
        async insert(data) {
          const version = {
            id: `ver-${state.versions.length + 1}`,
            createdAt: new Date(),
            ...data,
          };
          state.versions.push(version);
          return version;
        },
        async latestVersion(noteId: string) {
          const found = state.versions
            .filter((v) => v.noteId === noteId)
            .sort((a, b) => b.version - a.version)[0];
          return found ?? null;
        },
        async listByNoteId(noteId: string) {
          return state.versions
            .filter((v) => v.noteId === noteId)
            .sort((a, b) => b.version - a.version);
        },
        async findByIdAndNoteId() {
          return null;
        },
      },
      sessionStore: {
        async resolve() {
          return { userId: "user-id" };
        },
      },
      auditLogger() {},
    };

    const created = await createNote(
      { title: "T", content: "C" },
      "token",
      deps,
    );
    await updateNote(
      created.id,
      { title: "T2", content: "C2", isManualSave: true },
      "token",
      deps,
    );
    await updateNote(
      created.id,
      { title: "T3", content: "C3", isManualSave: false },
      "token",
      deps,
    );
    // Redundant autosave (content unchanged) -> skipped
    await updateNote(
      created.id,
      { title: "T3", content: "C3", isManualSave: false },
      "token",
      deps,
    );
    // Conflict on an autosave with stale clientUpdatedAt -> autosave_failure
    await expect(
      updateNote(
        created.id,
        {
          title: "T4",
          content: "C4",
          isManualSave: false,
          clientUpdatedAt: new Date(now.getTime() - 10_000),
        },
        "token",
        deps,
      ),
    ).rejects.toThrow("updated elsewhere");

    const out = await readCounter("note_operations_total");
    expect(out).toContain('note_operations_total{operation="create"} 1');
    expect(out).toContain('note_operations_total{operation="update"} 1');
    expect(out).toContain('note_operations_total{operation="autosave"} 1');
    expect(out).toContain('note_operations_total{operation="autosave_skipped"} 1');
    expect(out).toContain('note_operations_total{operation="autosave_failure"} 1');
  });

  it("records cache hits and misses during session resolution", async () => {
    const cache = new Map<string, string>();
    const dbRows = new Map<string, Session>();

    const deps = {
      valkeyStore: {
        async get(key: string) {
          return cache.get(key) ?? null;
        },
        async set(key: string, value: string, ttlSeconds: number) {
          cache.set(key, value);
          void ttlSeconds;
        },
        async del(key: string) {
          cache.delete(key);
        },
      },
      dbStore: {
        async insert() {
          return makeSession();
        },
        async findByTokenHash(tokenHash: string) {
          return dbRows.get(tokenHash) ?? null;
        },
        async revoke() {},
      },
    };

    const token = "token-a";
    dbRows.set(hashSessionToken(token), makeSession());

    // Miss (empty cache) then re-populates cache
    await getSession(token, new Date(), deps as never);
    // Hit (cached)
    await getSession(token, new Date(), deps as never);

    const out = await readCounter("cache_operations_total");
    expect(out).toContain('cache_operations_total{result="miss"} 1');
    expect(out).toContain('cache_operations_total{result="hit"} 1');
  });
});