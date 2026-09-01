import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "./password";

describe("password hashing", () => {
  it("produces an argon2id hash", async () => {
    const hashed = await hashPassword("correct horse battery staple");
    expect(hashed).toMatch(/^\$argon2id\$/);
    expect(hashed).not.toContain("correct horse battery staple");
  });

  it("verifies a correct password", async () => {
    const password = "s3cret-passw0rd!";
    const hashed = await hashPassword(password);
    await expect(verifyPassword(password, hashed)).resolves.toBe(true);
  });

  it("rejects an incorrect password", async () => {
    const hashed = await hashPassword("correct-password");
    await expect(verifyPassword("wrong-password", hashed)).resolves.toBe(false);
  });

  it("produces unique hashes for the same password", async () => {
    const password = "same-password";
    const [a, b] = await Promise.all([
      hashPassword(password),
      hashPassword(password),
    ]);
    expect(a).not.toBe(b);
  });
});