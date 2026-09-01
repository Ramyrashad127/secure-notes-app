"use server";

import { cookies } from "next/headers";
import { z } from "zod";
import {
  getCurrentUser,
  loginUser,
  logoutUser,
  registerUser,
} from "@/lib/auth/auth-service";
import { SESSION_COOKIE_NAME } from "@/lib/auth/session";
import { loginSchema, registerSchema } from "@/lib/validations/auth";

export type AuthActionResult =
  | { success: true }
  | { success: false; error: string };

export interface RegisterActionInput {
  email: string;
  password: string;
}

export interface LoginActionInput {
  email: string;
  password: string;
}

export async function registerAction(
  input: RegisterActionInput,
): Promise<AuthActionResult> {
  let parsed;
  try {
    parsed = registerSchema.parse(input);
  } catch (error) {
    const message =
      error instanceof z.ZodError ? error.issues[0]?.message ?? "Invalid input" : "Invalid input";
    return { success: false, error: message };
  }

  try {
    const cookie = await registerUser(parsed);
    const cookieStore = await cookies();
    cookieStore.set(cookie.name, cookie.value, cookie.options);
    return { success: true };
  } catch {
    return {
      success: false,
      error: "An account with this email already exists",
    };
  }
}

export async function loginAction(
  input: LoginActionInput,
): Promise<AuthActionResult> {
  let parsed;
  try {
    parsed = loginSchema.parse(input);
  } catch (error) {
    const message =
      error instanceof z.ZodError ? error.issues[0]?.message ?? "Invalid input" : "Invalid input";
    return { success: false, error: message };
  }

  try {
    const cookie = await loginUser(parsed);
    const cookieStore = await cookies();
    cookieStore.set(cookie.name, cookie.value, cookie.options);
    return { success: true };
  } catch {
    return { success: false, error: "Invalid email or password" };
  }
}

export async function logoutAction(): Promise<AuthActionResult> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE_NAME)?.value;

  try {
    if (token) {
      await logoutUser(token);
    }
    cookieStore.delete(SESSION_COOKIE_NAME);
    return { success: true };
  } catch {
    return { success: false, error: "Failed to log out" };
  }
}

export async function getCurrentUserAction() {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  if (!token) return null;
  return getCurrentUser(token);
}