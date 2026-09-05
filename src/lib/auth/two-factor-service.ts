import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users, type User } from "@/db/schema";
import { toSessionCookie, type SessionCookie } from "@/lib/auth/auth-service";
import {
  createSession as defaultCreateSession,
} from "@/lib/auth/session";
import { logAuditEvent, type AuditLogger } from "@/lib/audit/audit-service";
import { recordAuthEvent } from "@/lib/metrics";
import {
  decryptSecret as defaultDecryptSecret,
  encryptSecret as defaultEncryptSecret,
  generateRecoveryCodes as defaultGenerateRecoveryCodes,
  generateTotpSecret as defaultGenerateTotpSecret,
  generateTotpUri as defaultGenerateTotpUri,
  hashRecoveryCode as defaultHashRecoveryCode,
  verifyTotp as defaultVerifyTotp,
} from "@/lib/two-factor";

export const TWO_FACTOR_ISSUER = "Secure Notes";

/** Cookie identifying the user mid-login while awaiting a 2FA challenge. */
export const PENDING_2FA_COOKIE = "pending_2fa_user";

export class TwoFactorUserNotFoundError extends Error {
  constructor() {
    super("User not found");
    this.name = "TwoFactorUserNotFoundError";
  }
}

export class TwoFactorSetupIncompleteError extends Error {
  constructor() {
    super("Two-factor setup is incomplete");
    this.name = "TwoFactorSetupIncompleteError";
  }
}

export class InvalidTwoFactorCodeError extends Error {
  constructor() {
    super("Invalid two-factor code");
    this.name = "InvalidTwoFactorCodeError";
  }
}

export class TwoFactorNotEnabledError extends Error {
  constructor() {
    super("Two-factor authentication is not enabled");
    this.name = "TwoFactorNotEnabledError";
  }
}

export class RecoveryCodeInvalidError extends Error {
  constructor() {
    super("Invalid recovery code");
    this.name = "RecoveryCodeInvalidError";
  }
}

export interface TwoFactorCrypto {
  generateTotpSecret(): string;
  generateTotpUri(args: {
    secret: string;
    accountName: string;
    issuer: string;
  }): string;
  encryptSecret(secret: string): string;
  decryptSecret(payload: string): string;
  verifyTotp(secret: string, code: string): boolean;
  generateRecoveryCodes(): string[];
  hashRecoveryCode(code: string): Promise<string>;
}

export interface TwoFactorDeps {
  userStore: {
    findById(id: string): Promise<User | null>;
    updateTwoFactor(
      userId: string,
      patch: {
        twoFactorEnabled?: boolean;
        twoFactorSecretEncrypted?: string | null;
        twoFactorBackupCodes?: string[] | null;
      },
    ): Promise<void>;
  };
  sessionStore: {
    create(userId: string): Promise<{ token: string }>;
  };
  crypto: TwoFactorCrypto;
  auditLogger: AuditLogger;
}

const defaultDeps: TwoFactorDeps = {
  userStore: {
    async findById(id) {
      const [user] = await db.select().from(users).where(eq(users.id, id)).limit(1);
      return user ?? null;
    },
    async updateTwoFactor(userId, patch) {
      await db.update(users).set(patch).where(eq(users.id, userId));
    },
  },
  sessionStore: {
    create: defaultCreateSession as (userId: string) => Promise<{ token: string }>,
  },
  crypto: {
    generateTotpSecret: defaultGenerateTotpSecret,
    generateTotpUri: defaultGenerateTotpUri,
    encryptSecret: defaultEncryptSecret,
    decryptSecret: defaultDecryptSecret,
    verifyTotp: defaultVerifyTotp,
    generateRecoveryCodes: defaultGenerateRecoveryCodes,
    hashRecoveryCode: defaultHashRecoveryCode,
  },
  auditLogger: (userId, eventType, payload) => {
    void logAuditEvent(userId, eventType, payload);
  },
};

async function requireUser(userId: string, deps: TwoFactorDeps): Promise<User> {
  const user = await deps.userStore.findById(userId);
  if (!user) throw new TwoFactorUserNotFoundError();
  return user;
}

export async function initiateTwoFactorSetup(
  userId: string,
  deps: TwoFactorDeps = defaultDeps,
): Promise<{ secret: string; uri: string }> {
  const user = await requireUser(userId, deps);
  const secret = deps.crypto.generateTotpSecret();
  const uri = deps.crypto.generateTotpUri({
    secret,
    accountName: user.email,
    issuer: TWO_FACTOR_ISSUER,
  });
  const encrypted = deps.crypto.encryptSecret(secret);
  await deps.userStore.updateTwoFactor(userId, {
    twoFactorSecretEncrypted: encrypted,
    twoFactorEnabled: false,
  });
  return { secret, uri };
}

export async function verifyAndEnableTwoFactor(
  userId: string,
  code: string,
  deps: TwoFactorDeps = defaultDeps,
): Promise<string[]> {
  const user = await requireUser(userId, deps);
  if (!user.twoFactorSecretEncrypted) throw new TwoFactorSetupIncompleteError();
  const secret = deps.crypto.decryptSecret(user.twoFactorSecretEncrypted);
  if (!deps.crypto.verifyTotp(secret, code)) {
    recordAuthEvent({ type: "2fa", status: "failure" });
    throw new InvalidTwoFactorCodeError();
  }

  const recoveryCodes = deps.crypto.generateRecoveryCodes();
  const hashes = await Promise.all(
    recoveryCodes.map((codeItem) => deps.crypto.hashRecoveryCode(codeItem)),
  );
  await deps.userStore.updateTwoFactor(userId, {
    twoFactorEnabled: true,
    twoFactorBackupCodes: hashes,
  });
  deps.auditLogger(userId, "2FA_ENABLED", { method: "totp", userId });
  recordAuthEvent({ type: "2fa", status: "success" });
  return recoveryCodes;
}

export async function verifyLoginChallenge(
  userId: string,
  code: string,
  deps: TwoFactorDeps = defaultDeps,
): Promise<SessionCookie> {
  const user = await requireUser(userId, deps);
  if (!user.twoFactorEnabled) throw new TwoFactorNotEnabledError();
  if (!user.twoFactorSecretEncrypted) throw new TwoFactorSetupIncompleteError();
  const secret = deps.crypto.decryptSecret(user.twoFactorSecretEncrypted);
  if (!deps.crypto.verifyTotp(secret, code)) {
    recordAuthEvent({ type: "2fa", status: "failure" });
    throw new InvalidTwoFactorCodeError();
  }

  const { token } = await deps.sessionStore.create(userId);
  deps.auditLogger(userId, "LOGIN_SUCCESS", { method: "totp", userId });
  recordAuthEvent({ type: "2fa", status: "success" });
  recordAuthEvent({ type: "login", status: "success" });
  return toSessionCookie(token);
}

export async function consumeRecoveryCode(
  userId: string,
  code: string,
  deps: TwoFactorDeps = defaultDeps,
): Promise<SessionCookie> {
  const user = await requireUser(userId, deps);
  if (!user.twoFactorEnabled) throw new TwoFactorNotEnabledError();
  const hashes = user.twoFactorBackupCodes ?? [];
  if (hashes.length === 0) throw new RecoveryCodeInvalidError();

  const incomingHash = (await deps.crypto.hashRecoveryCode(code)).toLowerCase();
  if (!hashes.some((hash) => hash.toLowerCase() === incomingHash)) {
    recordAuthEvent({ type: "2fa", status: "failure" });
    throw new RecoveryCodeInvalidError();
  }

  const remaining = hashes.filter((hash) => hash.toLowerCase() !== incomingHash);
  await deps.userStore.updateTwoFactor(userId, { twoFactorBackupCodes: remaining });

  deps.auditLogger(userId, "RECOVERY_CODE_USED", { userId });

  const { token } = await deps.sessionStore.create(userId);
  deps.auditLogger(userId, "LOGIN_SUCCESS", { method: "recovery", userId });
  recordAuthEvent({ type: "2fa", status: "success" });
  recordAuthEvent({ type: "login", status: "success" });
  return toSessionCookie(token);
}

export async function disableTwoFactor(
  userId: string,
  deps: TwoFactorDeps = defaultDeps,
): Promise<void> {
  await requireUser(userId, deps);
  await deps.userStore.updateTwoFactor(userId, {
    twoFactorEnabled: false,
    twoFactorSecretEncrypted: null,
    twoFactorBackupCodes: null,
  });
  deps.auditLogger(userId, "2FA_DISABLED", { userId });
}