import { describe, expect, it } from "vitest";
import {
  loginSchema,
  passwordSchema,
  registerSchema,
} from "./auth";

describe("passwordSchema", () => {
  it("accepts a strong password", () => {
    expect(passwordSchema.safeParse("Str0ngPass!").success).toBe(true);
  });

  it("rejects passwords shorter than 8 characters", () => {
    expect(passwordSchema.safeParse("A1b2c3").success).toBe(false);
  });

  it("rejects passwords without an uppercase letter", () => {
    expect(passwordSchema.safeParse("alllowercase1").success).toBe(false);
  });

  it("rejects passwords without a lowercase letter", () => {
    expect(passwordSchema.safeParse("ALLUPPERCASE1").success).toBe(false);
  });

  it("rejects passwords without a digit", () => {
    expect(passwordSchema.safeParse("NoDigitsHere!").success).toBe(false);
  });
});

describe("registerSchema", () => {
  it("accepts valid input", () => {
    expect(
      registerSchema.safeParse({ email: "user@example.com", password: "Str0ngPass!" }).success,
    ).toBe(true);
  });

  it("rejects an invalid email", () => {
    const result = registerSchema.safeParse({
      email: "not-an-email",
      password: "Str0ngPass!",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a weak password", () => {
    const result = registerSchema.safeParse({
      email: "user@example.com",
      password: "weak",
    });
    expect(result.success).toBe(false);
  });
});

describe("loginSchema", () => {
  it("accepts valid input", () => {
    expect(loginSchema.safeParse({ email: "user@example.com", password: "any-password" }).success).toBe(true);
  });

  it("rejects an invalid email", () => {
    expect(loginSchema.safeParse({ email: "bad", password: "x" }).success).toBe(false);
  });

  it("rejects an empty password", () => {
    expect(loginSchema.safeParse({ email: "user@example.com", password: "" }).success).toBe(false);
  });
});