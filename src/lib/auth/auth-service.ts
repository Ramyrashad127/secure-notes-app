import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users, type Session, type User } from "@/db/schema";
import { hashPassword as defaultHash, verifyPassword as defaultVerify } from "@/lib/auth/password";
import {
  createSession as defaultCreateSession,
  getSession as defaultGetSession,
  revokeSession as defaultRevokeSession,
  SESSION_COOKIE_NAME,
} from "@/lib/auth/session";
import { logAuditEvent, type AuditLogger } from "@/lib/audit/audit-service";
import { recordAuthEvent } from "@/lib/metrics";
import type { LoginInput, RegisterInput } from "@/lib/validations/auth";

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}

export class DuplicateEmailError extends AuthError {
  constructor() {
    super("An account with this email already exists");
    this.name = "DuplicateEmailError";
  }
}

export class InvalidCredentialsError extends AuthError {
  constructor() {
    super("Invalid email or password");
    this.name = "InvalidCredentialsError";
  }
}

const DUMMY_HASH =
  "$argon2id$v=19$m=65536,t=3,p=1$TTKyNccxu7j6YqtINjUzrA$6s2dw+Kz09xzKjy0zii4pPkhkdCrY8proWJ1Jpo6Vmo";

export interface SessionCookie {
  name: string;
  value: string;
  options: {
    httpOnly: boolean;
    secure: boolean;
    sameSite: "strict";
    path: string;
    maxAge: number;
  };
}

export function toSessionCookie(token: string): SessionCookie {
  const secure = process.env.NODE_ENV === "production";
  return {
    name: SESSION_COOKIE_NAME,
    value: token,
    options: {
      httpOnly: true,
      secure,
      sameSite: "strict",
      path: "/",
      maxAge: 60 * 60 * 24 * 14,
    },
  };
}

export function clearSessionCookie(): SessionCookie {
  return {
    name: SESSION_COOKIE_NAME,
    value: "",
    options: {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      path: "/",
      maxAge: 0,
    },
  };
}

export interface AuthDeps {
  userStore: {
    findByEmail(email: string): Promise<User | null>;
    findById(id: string): Promise<User | null>;
    insert(data: { email: string; passwordHash: string }): Promise<User>;
  };
  passwordStore: {
    hash(password: string): Promise<string>;
    verify(password: string, hash: string): Promise<boolean>;
  };
  sessionStore: {
    create(userId: string): Promise<{ token: string }>;
    resolve(token: string): Promise<Session | null>;
    revoke(token: string, reason?: string): Promise<void>;
  };
  auditLogger: AuditLogger;
}

const defaultDeps: AuthDeps = {
  userStore: {
    async findByEmail(email) {
      const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
      return user ?? null;
    },
    async findById(id) {
      const [user] = await db.select().from(users).where(eq(users.id, id)).limit(1);
      return user ?? null;
    },
    async insert(data) {
      const [user] = await db.insert(users).values(data).returning();
      if (!user) throw new AuthError("Failed to create account");
      return user;
    },
  },
  passwordStore: {
    hash: defaultHash,
    verify: defaultVerify,
  },
  sessionStore: {
    create: defaultCreateSession as (userId: string) => Promise<{ token: string }>,
    resolve: defaultGetSession,
    revoke: defaultRevokeSession,
  },
  auditLogger: (userId, eventType, payload) => {
    void logAuditEvent(userId, eventType, payload);
  },
};

export async function registerUser(
  data: RegisterInput,
  deps: AuthDeps = defaultDeps,
): Promise<SessionCookie> {
  const existing = await deps.userStore.findByEmail(data.email);
  if (existing) {
    throw new DuplicateEmailError();
  }

  const passwordHash = await deps.passwordStore.hash(data.password);
  const user = await deps.userStore.insert({
    email: data.email,
    passwordHash,
  });

  deps.auditLogger(user.id, "USER_REGISTERED", {
    entityType: "user",
    entityId: user.id,
    email: user.email,
  });

  const { token } = await deps.sessionStore.create(user.id);
  return toSessionCookie(token);
}

export async function loginUser(
  data: LoginInput,
  deps: AuthDeps = defaultDeps,
): Promise<SessionCookie> {
  const user = await deps.userStore.findByEmail(data.email);

  if (!user) {
    await deps.passwordStore.verify(data.password, DUMMY_HASH).catch(() => false);
    deps.auditLogger(null, "LOGIN_FAILED", { email: data.email });
    recordAuthEvent({ type: "login", status: "failure", reason: "invalid_credentials" });
    throw new InvalidCredentialsError();
  }

  const passwordValid = await deps.passwordStore.verify(data.password, user.passwordHash);

  if (!passwordValid) {
    deps.auditLogger(user.id, "LOGIN_FAILED", { email: user.email });
    recordAuthEvent({ type: "login", status: "failure", reason: "invalid_credentials" });
    throw new InvalidCredentialsError();
  }

  deps.auditLogger(user.id, "LOGIN_SUCCESS", {
    email: user.email,
    method: "password",
  });
  recordAuthEvent({ type: "login", status: "success", reason: "" });

  const { token } = await deps.sessionStore.create(user.id);
  return toSessionCookie(token);
}

/**
 * Resolve a user by credentials WITHOUT creating a session. Used when the
 * login flow must first pass a 2FA challenge before a session is established.
 * Throws InvalidCredentialsError on bad credentials.
 */
export async function verifyLoginCredentials(
  data: LoginInput,
  deps: AuthDeps = defaultDeps,
): Promise<User> {
  const user = await deps.userStore.findByEmail(data.email);

  if (!user) {
    await deps.passwordStore.verify(data.password, DUMMY_HASH).catch(() => false);
    deps.auditLogger(null, "LOGIN_FAILED", { email: data.email });
    recordAuthEvent({ type: "login", status: "failure", reason: "invalid_credentials" });
    throw new InvalidCredentialsError();
  }

  const passwordValid = await deps.passwordStore.verify(data.password, user.passwordHash);

  if (!passwordValid) {
    deps.auditLogger(user.id, "LOGIN_FAILED", { email: user.email });
    recordAuthEvent({ type: "login", status: "failure", reason: "invalid_credentials" });
    throw new InvalidCredentialsError();
  }

  return user;
}

export async function logoutUser(
  token: string,
  deps: AuthDeps = defaultDeps,
): Promise<SessionCookie> {
  const session = await deps.sessionStore.resolve(token);
  await deps.sessionStore.revoke(token, "logout");
  deps.auditLogger(session?.userId ?? null, "AUTH_LOGOUT", {
    entityType: "user",
    entityId: session?.userId ?? null,
  });
  return clearSessionCookie();
}

export async function getCurrentUser(
  token: string,
  deps: AuthDeps = defaultDeps,
): Promise<User | null> {
  const session = await deps.sessionStore.resolve(token);
  if (!session) return null;
  return deps.userStore.findById(session.userId);
}