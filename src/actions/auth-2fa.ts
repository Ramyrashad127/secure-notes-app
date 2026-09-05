"use server";

import { cookies } from "next/headers";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth/auth-service";
import { SESSION_COOKIE_NAME } from "@/lib/auth/session";
import {
  consumeRecoveryCode as consumeRecoveryCodeService,
  disableTwoFactor as disableTwoFactorService,
  initiateTwoFactorSetup as initiateTwoFactorSetupService,
  InvalidTwoFactorCodeError,
  RecoveryCodeInvalidError,
  TwoFactorNotEnabledError,
  TwoFactorSetupIncompleteError,
  verifyAndEnableTwoFactor as verifyAndEnableTwoFactorService,
  verifyLoginChallenge as verifyLoginChallengeService,
} from "@/lib/auth/two-factor-service";
import {
  destroyTwoFactorChallenge,
  PENDING_2FA_CHALLENGE_COOKIE,
  resolveTwoFactorChallenge,
} from "@/lib/auth/two-factor-challenge";
import {
  checkRateLimit,
  getClientIp,
  RateLimitExceededError,
} from "@/lib/auth/rate-limit";

const totpCodeSchema = z
  .string()
  .regex(/^\d{6}$/, "Enter the 6-digit code from your authenticator app");

const recoveryCodeSchema = z
  .string()
  .regex(
    /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/i,
    "Enter a recovery code in the format XXXX-XXXX-XXXX-XXXX",
  );

export type TwoFactorActionResult =
  | { success: true }
  | { success: false; error: string };

export type InitiateTwoFactorResult =
  | { success: true; secret: string; uri: string }
  | { success: false; error: string };

export type VerifyAndEnableTwoFactorResult =
  | { success: true; recoveryCodes: string[] }
  | { success: false; error: string };

function twoFactorError(error: unknown): { success: false; error: string } {
  if (error instanceof InvalidTwoFactorCodeError) {
    return { success: false, error: "Invalid code. Please try again." };
  }
  if (error instanceof RecoveryCodeInvalidError) {
    return {
      success: false,
      error: "That recovery code is invalid or has already been used.",
    };
  }
  if (error instanceof TwoFactorNotEnabledError) {
    return {
      success: false,
      error: "Two-factor authentication is not enabled for this account.",
    };
  }
  if (error instanceof TwoFactorSetupIncompleteError) {
    return {
      success: false,
      error: "Two-factor setup is incomplete. Please start setup again.",
    };
  }
  return { success: false, error: "Something went wrong. Please try again." };
}

async function getUserIdFromSession(): Promise<string | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  if (!token) return null;
  const user = await getCurrentUser(token);
  return user?.id ?? null;
}

async function getPendingChallengeToken(): Promise<string | null> {
  const cookieStore = await cookies();
  return cookieStore.get(PENDING_2FA_CHALLENGE_COOKIE)?.value ?? null;
}

async function invalidatePendingChallenge(token: string): Promise<void> {
  await destroyTwoFactorChallenge(token);
  const cookieStore = await cookies();
  cookieStore.delete(PENDING_2FA_CHALLENGE_COOKIE);
}

async function setSessionCookie(value: string): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.set({
    name: SESSION_COOKIE_NAME,
    value,
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
    maxAge: 60 * 60 * 24 * 14,
  });
  cookieStore.delete(PENDING_2FA_CHALLENGE_COOKIE);
}

export async function initiate2FASetup(): Promise<InitiateTwoFactorResult> {
  const userId = await getUserIdFromSession();
  if (!userId) return { success: false, error: "You must be signed in to do that" };

  try {
    const { secret, uri } = await initiateTwoFactorSetupService(userId);
    return { success: true, secret, uri };
  } catch (error) {
    return twoFactorError(error);
  }
}

export async function verifyAndEnable2FA(
  code: string,
): Promise<VerifyAndEnableTwoFactorResult> {
  let parsed;
  try {
    parsed = totpCodeSchema.parse(code);
  } catch (error) {
    const message =
      error instanceof z.ZodError
        ? error.issues[0]?.message ?? "Invalid code"
        : "Invalid code";
    return { success: false, error: message };
  }

  const userId = await getUserIdFromSession();
  if (!userId) return { success: false, error: "You must be signed in to do that" };

  try {
    const recoveryCodes = await verifyAndEnableTwoFactorService(userId, parsed);
    return { success: true, recoveryCodes };
  } catch (error) {
    return twoFactorError(error);
  }
}

export async function verifyLoginChallenge(
  code: string,
): Promise<TwoFactorActionResult> {
  let parsed;
  try {
    parsed = totpCodeSchema.parse(code);
  } catch (error) {
    const message =
      error instanceof z.ZodError
        ? error.issues[0]?.message ?? "Invalid code"
        : "Invalid code";
    return { success: false, error: message };
  }

  const pendingToken = await getPendingChallengeToken();
  const userId = pendingToken
    ? (await resolveTwoFactorChallenge(pendingToken))?.userId ?? null
    : null;
  if (!userId) {
    return {
      success: false,
      error: "Your login session has expired. Please sign in again.",
    };
  }

  try {
    await checkRateLimit(
      "two-factor",
      `${await getClientIp()}:${userId}`,
    );
  } catch (error) {
    if (error instanceof RateLimitExceededError) {
      return { success: false, error: error.message };
    }
  }

  try {
    const cookie = await verifyLoginChallengeService(userId, parsed);
    await setSessionCookie(cookie.value);
    await invalidatePendingChallenge(pendingToken!);
    return { success: true };
  } catch (error) {
    return twoFactorError(error);
  }
}

export async function consumeRecoveryCode(
  code: string,
): Promise<TwoFactorActionResult> {
  let parsed;
  try {
    parsed = recoveryCodeSchema.parse(code);
  } catch (error) {
    const message =
      error instanceof z.ZodError
        ? error.issues[0]?.message ?? "Invalid recovery code"
        : "Invalid recovery code";
    return { success: false, error: message };
  }

  const pendingToken = await getPendingChallengeToken();
  const userId = pendingToken
    ? (await resolveTwoFactorChallenge(pendingToken))?.userId ?? null
    : null;
  if (!userId) {
    return {
      success: false,
      error: "Your login session has expired. Please sign in again.",
    };
  }

  try {
    await checkRateLimit(
      "two-factor",
      `${await getClientIp()}:${userId}`,
    );
  } catch (error) {
    if (error instanceof RateLimitExceededError) {
      return { success: false, error: error.message };
    }
  }

  try {
    const cookie = await consumeRecoveryCodeService(userId, parsed);
    await setSessionCookie(cookie.value);
    await invalidatePendingChallenge(pendingToken!);
    return { success: true };
  } catch (error) {
    return twoFactorError(error);
  }
}

export async function disable2FA(): Promise<TwoFactorActionResult> {
  const userId = await getUserIdFromSession();
  if (!userId) return { success: false, error: "You must be signed in to do that" };

  try {
    await disableTwoFactorService(userId);
    return { success: true };
  } catch (error) {
    return twoFactorError(error);
  }
}
