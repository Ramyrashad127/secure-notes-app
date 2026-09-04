import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  decryptSecret,
  encryptSecret,
  generateRecoveryCodes,
  generateTotpSecret,
  generateTotpUri,
  hashRecoveryCode,
  verifyRecoveryCode,
  verifyTotp,
} from "./two-factor";

// RFC 6238 test secret: ASCII "12345678901234567890" base32-encoded.
const RFC6238_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

const KEY = Buffer.from("0123456789abcdef0123456789abcdef", "utf8").toString(
  "base64",
);

beforeEach(() => {
  process.env.TWO_FACTOR_ENCRYPTION_KEY = KEY;
});

afterEach(() => {
  delete process.env.TWO_FACTOR_ENCRYPTION_KEY;
});

describe("two-factor: secret encryption", () => {
  it("encrypts then decrypts a secret back to the original", () => {
    const secret = "JBSWY3DPEHPK3PXP";
    const encrypted = encryptSecret(secret);
    expect(encrypted).not.toBe(secret);
    expect(decryptSecret(encrypted)).toBe(secret);
  });

  it("produces a unique ciphertext for the same secret on each call", () => {
    const secret = "JBSWY3DPEHPK3PXP";
    const first = encryptSecret(secret);
    const second = encryptSecret(secret);
    expect(first).not.toBe(second);
    expect(decryptSecret(first)).toBe(secret);
    expect(decryptSecret(second)).toBe(secret);
  });

  it("throws when the encryption key is not configured", () => {
    delete process.env.TWO_FACTOR_ENCRYPTION_KEY;
    expect(() => encryptSecret("JBSWY3DPEHPK3PXP")).toThrow();
    expect(() => decryptSecret("anything")).toThrow();
  });

  it("throws when decrypting a tampered ciphertext", () => {
    const encrypted = encryptSecret("JBSWY3DPEHPK3PXP");
    const corrupted = encrypted.slice(0, -4) + "AAAA";
    expect(() => decryptSecret(corrupted)).toThrow();
  });
});

describe("two-factor: TOTP secret generation", () => {
  it("generates a base32 secret of 32 characters", () => {
    const secret = generateTotpSecret();
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
  });

  it("generates a unique secret on each call", () => {
    expect(generateTotpSecret()).not.toBe(generateTotpSecret());
  });
});

describe("two-factor: otpauth URI", () => {
  it("builds an otpauth://totp URI with issuer, label, and secret", () => {
    const uri = generateTotpUri({
      secret: RFC6238_SECRET,
      accountName: "user@example.com",
      issuer: "Secure Notes",
    });
    expect(uri).toBe(
      "otpauth://totp/Secure%20Notes:user%40example.com?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=Secure%20Notes&algorithm=SHA1&digits=6&period=30",
    );
  });
});

describe("two-factor: TOTP verification", () => {
  it("accepts the current RFC 6238 token", () => {
    expect(verifyTotp(RFC6238_SECRET, "005924", 1234567890)).toBe(true);
  });

  it("rejects an incorrect token", () => {
    expect(verifyTotp(RFC6238_SECRET, "000000", 1234567890)).toBe(false);
  });

  it("accepts a token within the 30-second window", () => {
    expect(verifyTotp(RFC6238_SECRET, "590587", 1234567920)).toBe(true);
  });

  it("rejects a malformed token", () => {
    expect(verifyTotp(RFC6238_SECRET, "12ab", 1234567890)).toBe(false);
    expect(verifyTotp(RFC6238_SECRET, "", 1234567890)).toBe(false);
  });
});

describe("two-factor: recovery codes", () => {
  it("generates 10 recovery codes in the expected format", () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(10);
    for (const code of codes) {
      expect(code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    }
  });

  it("generates unique recovery codes", () => {
    const codes = generateRecoveryCodes();
    expect(new Set(codes).size).toBe(10);
  });

  it("hashes a recovery code deterministically", async () => {
    const hash = await hashRecoveryCode("ABCD-EFGH-IJKL-MNOP");
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(await hashRecoveryCode("ABCD-EFGH-IJKL-MNOP")).toBe(hash);
  });

  it("does not store the plaintext recovery code in the hash", async () => {
    const hash = await hashRecoveryCode("ABCD-EFGH-IJKL-MNOP");
    expect(hash).not.toContain("ABCD-EFGH-IJKL-MNOP");
  });

  it("verifies a correct recovery code against its hash", async () => {
    const hash = await hashRecoveryCode("ABCD-EFGH-IJKL-MNOP");
    expect(await verifyRecoveryCode("ABCD-EFGH-IJKL-MNOP", hash)).toBe(true);
  });

  it("rejects an incorrect recovery code", async () => {
    const hash = await hashRecoveryCode("ABCD-EFGH-IJKL-MNOP");
    expect(await verifyRecoveryCode("ZZZZ-YYYY-XXXX-WWWW", hash)).toBe(false);
  });
});