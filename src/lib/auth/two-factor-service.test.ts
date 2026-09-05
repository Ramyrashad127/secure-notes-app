import { describe, expect, it } from "vitest";
import type { User } from "@/db/schema";
import type { SessionCookie } from "@/lib/auth/auth-service";
import {
  consumeRecoveryCode,
  disableTwoFactor,
  initiateTwoFactorSetup,
  InvalidPasswordFor2FADisableError,
  InvalidTwoFactorCodeError,
  RecoveryCodeInvalidError,
  TwoFactorNotEnabledError,
  TwoFactorSetupIncompleteError,
  TwoFactorUserNotFoundError,
  verifyAndEnableTwoFactor,
  verifyLoginChallenge,
  type TwoFactorDeps,
} from "./two-factor-service";

function makeUser(overrides: Partial<User> = {}): User {
  const now = new Date();
  return {
    id: "user-id",
    email: "user@example.com",
    passwordHash: "hash:Str0ngPass!",
    twoFactorEnabled: false,
    twoFactorSecretEncrypted: null,
    twoFactorBackupCodes: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

interface FakeState {
  users: User[];
  createdSessions: string[];
  secret: string;
  audits: Array<{
    userId: string | null;
    eventType: string;
    payload?: Record<string, unknown>;
  }>;
}

function createFakeDeps(initialUser: User): { deps: TwoFactorDeps; state: FakeState } {
  const state: FakeState = {
    users: [initialUser],
    createdSessions: [],
    secret: "JBSWY3DPEHPK3PXP",
    audits: [],
  };

  const deps: TwoFactorDeps = {
    userStore: {
      async findById(id) {
        return state.users.find((u) => u.id === id) ?? null;
      },
      async updateTwoFactor(userId, patch) {
        const user = state.users.find((u) => u.id === userId);
        if (!user) throw new Error("missing user");
        Object.assign(user, patch);
      },
    },
    sessionStore: {
      async create(userId) {
        state.createdSessions.push(userId);
        return { token: "session-token" };
      },
    },
    crypto: {
      generateTotpSecret: () => state.secret,
      generateTotpUri: ({ secret, accountName, issuer }) =>
        `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(accountName)}?secret=${secret}`,
      encryptSecret: (secret) => `enc:${secret}`,
      decryptSecret: (payload) => payload.replace("enc:", ""),
      verifyTotp: (_secret, code) => code === "123456",
      generateRecoveryCodes: () => [
        "AAAA-AAAA-AAAA-AAAA",
        "BBBB-BBBB-BBBB-BBBB",
        "CCCC-CCCC-CCCC-CCCC",
        "DDDD-DDDD-DDDD-DDDD",
        "EEEE-EEEE-EEEE-EEEE",
        "FFFF-FFFF-FFFF-FFFF",
        "GGGG-GGGG-GGGG-GGGG",
        "HHHH-HHHH-HHHH-HHHH",
        "IIII-IIII-IIII-IIII",
        "JJJJ-JJJJ-JJJJ-JJJJ",
      ],
      hashRecoveryCode: (code) => Promise.resolve(`hash:${code.toLowerCase()}`),
    },
    passwordStore: {
      async verify(password, passwordHash) {
        return passwordHash === `hash:${password}`;
      },
    },
    auditLogger(userId, eventType, payload) {
      state.audits.push({ userId, eventType, payload });
    },
  };

  return { deps, state };
}

describe("initiateTwoFactorSetup", () => {
  it("saves an encrypted secret and keeps twoFactorEnabled false", async () => {
    const user = makeUser();
    const { deps, state } = createFakeDeps(user);

    const result = await initiateTwoFactorSetup("user-id", deps);

    expect(result.secret).toBe("JBSWY3DPEHPK3PXP");
    expect(result.uri).toContain("user%40example.com");
    expect(state.users[0].twoFactorSecretEncrypted).toBe("enc:JBSWY3DPEHPK3PXP");
    expect(state.users[0].twoFactorEnabled).toBe(false);
    expect(state.users[0].twoFactorBackupCodes).toBeNull();
  });

  it("returns an otpauth URI containing the issuer and account", async () => {
    const { deps } = createFakeDeps(makeUser());

    const result = await initiateTwoFactorSetup("user-id", deps);

    expect(result.uri).toBe(
      "otpauth://totp/Secure%20Notes:user%40example.com?secret=JBSWY3DPEHPK3PXP",
    );
  });

  it("throws for an unknown user", async () => {
    const { deps } = createFakeDeps(makeUser());

    await expect(initiateTwoFactorSetup("missing", deps)).rejects.toBeInstanceOf(
      TwoFactorUserNotFoundError,
    );
  });
});

describe("verifyAndEnableTwoFactor", () => {
  it("enables 2FA and returns the plaintext recovery codes once", async () => {
    const user = makeUser({ twoFactorSecretEncrypted: "enc:JBSWY3DPEHPK3PXP" });
    const { deps, state } = createFakeDeps(user);

    const codes = await verifyAndEnableTwoFactor("user-id", "123456", deps);

    expect(codes).toHaveLength(10);
    expect(state.users[0].twoFactorEnabled).toBe(true);
    expect(state.users[0].twoFactorBackupCodes).toEqual(
      codes.map((c) => `hash:${c.toLowerCase()}`),
    );
    expect(state.users[0].twoFactorBackupCodes![0]).not.toContain("AAAA");

    expect(state.audits).toContainEqual(
      expect.objectContaining({ eventType: "2FA_ENABLED", userId: "user-id" }),
    );
  });

  it("rejects an invalid code and does not enable 2FA", async () => {
    const user = makeUser({ twoFactorSecretEncrypted: "enc:JBSWY3DPEHPK3PXP" });
    const { deps, state } = createFakeDeps(user);

    await expect(
      verifyAndEnableTwoFactor("user-id", "000000", deps),
    ).rejects.toBeInstanceOf(InvalidTwoFactorCodeError);

    expect(state.users[0].twoFactorEnabled).toBe(false);
    expect(state.users[0].twoFactorBackupCodes).toBeNull();
  });

  it("throws when no secret has been staged", async () => {
    const { deps } = createFakeDeps(makeUser());

    await expect(
      verifyAndEnableTwoFactor("user-id", "123456", deps),
    ).rejects.toBeInstanceOf(TwoFactorSetupIncompleteError);
  });
});

describe("verifyLoginChallenge", () => {
  it("establishes a session for a valid code when 2FA is enabled", async () => {
    const user = makeUser({
      twoFactorEnabled: true,
      twoFactorSecretEncrypted: "enc:JBSWY3DPEHPK3PXP",
    });
    const { deps, state } = createFakeDeps(user);

    const cookie = await verifyLoginChallenge("user-id", "123456", deps);

    expect(state.createdSessions).toContain("user-id");
    expect(cookie.name).toBe("session");
    expect(cookie.value).toBe("session-token");

    expect(state.audits).toContainEqual(
      expect.objectContaining({
        eventType: "LOGIN_SUCCESS",
        userId: "user-id",
        payload: { method: "totp", userId: "user-id" },
      }),
    );
  });

  it("rejects an invalid code", async () => {
    const user = makeUser({
      twoFactorEnabled: true,
      twoFactorSecretEncrypted: "enc:JBSWY3DPEHPK3PXP",
    });
    const { deps, state } = createFakeDeps(user);

    await expect(
      verifyLoginChallenge("user-id", "111111", deps),
    ).rejects.toBeInstanceOf(InvalidTwoFactorCodeError);
    expect(state.createdSessions).toHaveLength(0);
  });

  it("rejects a user without 2FA enabled", async () => {
    const { deps } = createFakeDeps(makeUser());

    await expect(
      verifyLoginChallenge("user-id", "123456", deps),
    ).rejects.toBeInstanceOf(TwoFactorNotEnabledError);
  });
});

describe("consumeRecoveryCode", () => {
  it("consumes a matching code, removes it, and establishes a session", async () => {
    const user = makeUser({
      twoFactorEnabled: true,
      twoFactorBackupCodes: [
        "hash:aaaa-aaaa-aaaa-aaaa",
        "hash:bbbb-bbbb-bbbb-bbbb",
      ],
    });
    const { deps, state } = createFakeDeps(user);

    const cookie = await consumeRecoveryCode("user-id", "AAAA-AAAA-AAAA-AAAA", deps);

    expect(state.createdSessions).toContain("user-id");
    expect(cookie.value).toBe("session-token");
    expect(state.users[0].twoFactorBackupCodes).toEqual([
      "hash:bbbb-bbbb-bbbb-bbbb",
    ]);
    expect(state.audits).toContainEqual(
      expect.objectContaining({ eventType: "RECOVERY_CODE_USED", userId: "user-id" }),
    );
    expect(state.audits).toContainEqual(
      expect.objectContaining({
        eventType: "LOGIN_SUCCESS",
        payload: { method: "recovery", userId: "user-id" },
      }),
    );
  });

  it("rejects an unknown code", async () => {
    const user = makeUser({
      twoFactorEnabled: true,
      twoFactorBackupCodes: ["hash:aaaa-aaaa-aaaa-aaaa"],
    });
    const { deps, state } = createFakeDeps(user);

    await expect(
      consumeRecoveryCode("user-id", "ZZZZ-ZZZZ-ZZZZ-ZZZZ", deps),
    ).rejects.toBeInstanceOf(RecoveryCodeInvalidError);

    expect(state.createdSessions).toHaveLength(0);
    expect(state.users[0].twoFactorBackupCodes).toHaveLength(1);
  });

  it("rejects when no backup codes remain", async () => {
    const user = makeUser({
      twoFactorEnabled: true,
      twoFactorBackupCodes: [],
    });
    const { deps } = createFakeDeps(user);

    await expect(
      consumeRecoveryCode("user-id", "AAAA-AAAA-AAAA-AAAA", deps),
    ).rejects.toBeInstanceOf(RecoveryCodeInvalidError);
  });

  it("rejects a user without 2FA enabled", async () => {
    const { deps } = createFakeDeps(makeUser());

    await expect(
      consumeRecoveryCode("user-id", "AAAA-AAAA-AAAA-AAAA", deps),
    ).rejects.toBeInstanceOf(TwoFactorNotEnabledError);
  });
});

describe("disableTwoFactor", () => {
  it("disables 2FA with the correct current password", async () => {
    const user = makeUser({
      twoFactorEnabled: true,
      twoFactorSecretEncrypted: "enc:JBSWY3DPEHPK3PXP",
      twoFactorBackupCodes: ["hash:aaaa-aaaa-aaaa-aaaa"],
    });
    const { deps, state } = createFakeDeps(user);

    await disableTwoFactor("user-id", "Str0ngPass!", deps);

    expect(state.users[0].twoFactorEnabled).toBe(false);
    expect(state.users[0].twoFactorSecretEncrypted).toBeNull();
    expect(state.users[0].twoFactorBackupCodes).toBeNull();
    expect(state.audits).toContainEqual(
      expect.objectContaining({ eventType: "2FA_DISABLED", userId: "user-id" }),
    );
  });

  it("rejects an incorrect password and leaves 2FA enabled", async () => {
    const user = makeUser({
      twoFactorEnabled: true,
      twoFactorSecretEncrypted: "enc:JBSWY3DPEHPK3PXP",
      twoFactorBackupCodes: ["hash:aaaa-aaaa-aaaa-aaaa"],
    });
    const { deps, state } = createFakeDeps(user);

    await expect(
      disableTwoFactor("user-id", "WrongPassword!", deps),
    ).rejects.toBeInstanceOf(InvalidPasswordFor2FADisableError);

    expect(state.users[0].twoFactorEnabled).toBe(true);
    expect(state.users[0].twoFactorSecretEncrypted).toBe("enc:JBSWY3DPEHPK3PXP");
    expect(state.users[0].twoFactorBackupCodes).toHaveLength(1);
  });

  it("throws for an unknown user without touching anything", async () => {
    const { deps } = createFakeDeps(makeUser());

    await expect(
      disableTwoFactor("missing", "Str0ngPass!", deps),
    ).rejects.toBeInstanceOf(TwoFactorUserNotFoundError);
  });
});

describe("session cookie shape", () => {
  it("produces an httpOnly session cookie", async () => {
    const user = makeUser({
      twoFactorEnabled: true,
      twoFactorSecretEncrypted: "enc:JBSWY3DPEHPK3PXP",
    });
    const { deps } = createFakeDeps(user);

    const cookie: SessionCookie = await verifyLoginChallenge(
      "user-id",
      "123456",
      deps,
    );

    expect(cookie.options.httpOnly).toBe(true);
    expect(cookie.options.sameSite).toBe("strict");
    expect(cookie.options.path).toBe("/");
  });
});