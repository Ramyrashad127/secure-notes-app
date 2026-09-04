import { describe, expect, it } from "vitest";
import {
  clearSessionCookie,
  DuplicateEmailError,
  getCurrentUser,
  InvalidCredentialsError,
  loginUser,
  logoutUser,
  registerUser,
  toSessionCookie,
  verifyLoginCredentials,
  type AuthDeps,
} from "./auth-service";
import type { Session, User } from "@/db/schema";

function fakeHash(password: string): string {
  return `hash:${Buffer.from(password).toString("base64")}`;
}

function makeUser(overrides: Partial<User> = {}): User {
  const now = new Date();
  return {
    id: "user-id",
    email: "user@example.com",
    passwordHash: fakeHash("Str0ngPass!"),
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
    expiresAt: new Date(Date.now() + 1000 * 60 * 60),
    lastUsedAt: null,
    revokedAt: null,
    revokedReason: null,
    ipAddress: null,
    userAgent: null,
    createdAt: new Date(),
    ...overrides,
  };
}

interface AuditCall {
  userId: string | null;
  eventType: string;
  payload?: Record<string, unknown>;
}

interface FakeAuthState {
  users: User[];
  revokedTokens: string[];
  resolved: string[];
  audits: AuditCall[];
  lastToken: string | null;
}

function createFakeDeps(initialUsers: User[] = []): { deps: AuthDeps; state: FakeAuthState } {
  const state: FakeAuthState = {
    users: [...initialUsers],
    revokedTokens: [],
    resolved: [],
    audits: [],
    lastToken: null,
  };

  const deps: AuthDeps = {
    userStore: {
      async findByEmail(email) {
        return state.users.find((u) => u.email === email) ?? null;
      },
      async findById(id) {
        return state.users.find((u) => u.id === id) ?? null;
      },
      async insert(data) {
        const user = makeUser({ email: data.email, passwordHash: data.passwordHash });
        state.users.push(user);
        return user;
      },
    },
    passwordStore: {
      async hash(password) {
        return `hash:${Buffer.from(password).toString("base64")}`;
      },
      async verify(password, hash) {
        return hash === `hash:${Buffer.from(password).toString("base64")}`;
      },
    },
    sessionStore: {
      async create() {
        const token = "session-token";
        state.lastToken = token;
        return { token };
      },
      async resolve(token) {
        state.resolved.push(token);
        if (state.revokedTokens.includes(token)) return null;
        return makeSession();
      },
      async revoke(token, reason) {
        state.revokedTokens.push(token);
        void reason;
      },
    },
    auditLogger(userId, eventType, payload) {
      state.audits.push({ userId, eventType, payload });
    },
  };

  return { deps, state };
}

describe("toSessionCookie / clearSessionCookie", () => {
  it("builds a secure httpOnly strict cookie", () => {
    const cookie = toSessionCookie("abc");
    expect(cookie.name).toBe("session");
    expect(cookie.value).toBe("abc");
    expect(cookie.options.httpOnly).toBe(true);
    expect(cookie.options.sameSite).toBe("strict");
    expect(cookie.options.path).toBe("/");
  });

  it("clears by expiring the cookie", () => {
    const cookie = clearSessionCookie();
    expect(cookie.value).toBe("");
    expect(cookie.options.maxAge).toBe(0);
  });
});

describe("registerUser", () => {
  it("creates a user, audits USER_REGISTERED, and issues a session", async () => {
    const { deps, state } = createFakeDeps();
    const cookie = await registerUser(
      { email: "new@example.com", password: "Str0ngPass!" },
      deps,
    );

    expect(state.users).toHaveLength(1);
    expect(state.users[0].email).toBe("new@example.com");
    expect(state.users[0].passwordHash).toBe(fakeHash("Str0ngPass!"));
    expect(state.audits.map((a) => a.eventType)).toContain("USER_REGISTERED");
    expect(cookie.value).toBe("session-token");
  });

  it("rejects a duplicate email", async () => {
    const existing = makeUser();
    const { deps } = createFakeDeps([existing]);

    await expect(
      registerUser({ email: existing.email, password: "Str0ngPass!" }, deps),
    ).rejects.toBeInstanceOf(DuplicateEmailError);
  });

  it("does not store the plaintext password", async () => {
    const { deps, state } = createFakeDeps();
    await registerUser({ email: "a@example.com", password: "Str0ngPass!" }, deps);
    expect(state.users[0].passwordHash).not.toContain("Str0ngPass!");
  });
});

describe("loginUser", () => {
  it("succeeds with valid credentials and audits LOGIN_SUCCESS", async () => {
    const { deps, state } = createFakeDeps([
      makeUser({ email: "user@example.com", passwordHash: fakeHash("correct-password") }),
    ]);

    const cookie = await loginUser(
      { email: "user@example.com", password: "correct-password" },
      deps,
    );

    expect(state.audits.map((a) => a.eventType)).toContain("LOGIN_SUCCESS");
    expect(state.audits).toContainEqual(
      expect.objectContaining({ eventType: "LOGIN_SUCCESS", userId: "user-id" }),
    );
    expect(
      state.audits.map((a) => a.eventType),
    ).not.toContain("LOGIN_FAILED");
    expect(cookie.value).toBe("session-token");
  });

  it("fails with a wrong password, audits LOGIN_FAILED, and issues no session", async () => {
    const { deps, state } = createFakeDeps([
      makeUser({ email: "user@example.com", passwordHash: fakeHash("correct-password") }),
    ]);

    await expect(
      loginUser({ email: "user@example.com", password: "wrong-password" }, deps),
    ).rejects.toBeInstanceOf(InvalidCredentialsError);

    expect(state.audits.map((a) => a.eventType)).toContain("LOGIN_FAILED");
    expect(state.audits).toContainEqual(
      expect.objectContaining({ eventType: "LOGIN_FAILED", userId: "user-id" }),
    );
    expect(state.lastToken).toBeNull();
  });

  it("fails with unknown email, audits LOGIN_FAILED with null userId, but still performs a dummy verify (timing equalization)", async () => {
    const { deps, state } = createFakeDeps();

    let dummyVerified = false;
    const originalVerify = deps.passwordStore.verify;
    deps.passwordStore.verify = async (password, hash) => {
      if (hash.startsWith("$argon2id$")) {
        dummyVerified = true;
        return originalVerify(password, hash).catch(() => false);
      }
      return originalVerify(password, hash);
    };

    await expect(
      loginUser({ email: "missing@example.com", password: "whatever" }, deps),
    ).rejects.toBeInstanceOf(InvalidCredentialsError);

    expect(dummyVerified).toBe(true);
    expect(state.audits).toContainEqual(
      expect.objectContaining({
        eventType: "LOGIN_FAILED",
        userId: null,
        payload: { email: "missing@example.com" },
      }),
    );
  });
});

describe("verifyLoginCredentials", () => {
  it("resolves the user without creating a session", async () => {
    const { deps, state } = createFakeDeps([
      makeUser({ email: "user@example.com", passwordHash: fakeHash("correct-password") }),
    ]);

    const user = await verifyLoginCredentials(
      { email: "user@example.com", password: "correct-password" },
      deps,
    );

    expect(user.email).toBe("user@example.com");
    expect(state.lastToken).toBeNull();
  });

  it("throws on invalid credentials", async () => {
    const { deps, state } = createFakeDeps([
      makeUser({ email: "user@example.com", passwordHash: fakeHash("correct-password") }),
    ]);

    await expect(
      verifyLoginCredentials(
        { email: "user@example.com", password: "wrong-password" },
        deps,
      ),
    ).rejects.toBeInstanceOf(InvalidCredentialsError);

    expect(state.audits.map((a) => a.eventType)).toContain("LOGIN_FAILED");
  });
});

describe("logoutUser / session revocation", () => {
  it("revokes the session and clears the cookie", async () => {
    const { deps, state } = createFakeDeps([makeUser()]);

    const cookie = await logoutUser("session-token", deps);

    expect(state.revokedTokens).toContain("session-token");
    expect(cookie.value).toBe("");
    expect(state.audits.map((a) => a.eventType)).toContain("AUTH_LOGOUT");
  });

  it("getCurrentUser resolves the owning user from an active token", async () => {
    const { deps } = createFakeDeps([makeUser()]);

    const user = await getCurrentUser("session-token", deps);
    expect(user).not.toBeNull();
    expect(user!.id).toBe("user-id");
    expect(user!.email).toBe("user@example.com");
  });

  it("getCurrentUser returns null after revocation", async () => {
    const { deps } = createFakeDeps([makeUser()]);
    await logoutUser("session-token", deps);

    await expect(getCurrentUser("session-token", deps)).resolves.toBeNull();
  });

  it("getCurrentUser returns null for an unknown token", async () => {
    const { deps, state } = createFakeDeps([makeUser()]);
    state.revokedTokens.push("unknown-token");

    await expect(getCurrentUser("unknown-token", deps)).resolves.toBeNull();
  });
});