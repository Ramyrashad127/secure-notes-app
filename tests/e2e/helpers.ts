import postgres from "postgres";
import { createHmac } from "node:crypto";

import { hashPassword } from "../../src/lib/auth/password";
import { encryptSecret, hashRecoveryCode } from "../../src/lib/two-factor";

export const sql = postgres(process.env.DATABASE_URL as string, {
  max: 5,
});

export async function createUser(
  email: string,
  password: string,
): Promise<{ id: string }> {
  const hash = await hashPassword(password);
  const rows = await sql<{ id: string }[]>`
    INSERT INTO users (email, password_hash)
    VALUES (${email}, ${hash})
    RETURNING id
  `;
  return rows[0];
}

/**
 * Create a user with 2FA already enabled. Returns the plaintext TOTP secret
 * and recovery codes so tests can generate valid codes.
 */
export async function createUserWithTwoFactor(
  email: string,
  password: string,
  secret: string,
  recoveryCodes: string[],
): Promise<{ id: string }> {
  const hash = await hashPassword(password);
  const encrypted = encryptSecret(secret);
  const hashes = await Promise.all(recoveryCodes.map(hashRecoveryCode));
  const rows = await sql<{ id: string }[]>`
    INSERT INTO users (email, password_hash, two_factor_enabled, two_factor_secret_encrypted, two_factor_backup_codes)
    VALUES (${email}, ${hash}, true, ${encrypted}, ${JSON.stringify(hashes)}::jsonb)
    RETURNING id
  `;
  return rows[0];
}

/**
 * Generate the current TOTP code for a base32 secret, using the same
 * HMAC-SHA1 algorithm as src/lib/two-factor.ts.
 */
export function generateTotpCode(secret: string, now = Date.now()): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const normalized = secret.replace(/=+$/g, "").replace(/\s+/g, "");
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of normalized) {
    value = (value << 5) | alphabet.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  const key = Buffer.from(bytes);
  const counter = Math.floor(now / 1000 / 30);
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac("sha1", key).update(counterBuffer).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return String(binary % 1_000_000).padStart(6, "0");
}

export async function deleteUserByEmail(email: string): Promise<void> {
  const rows = await sql<{ id: string }[]>`
    SELECT id FROM users WHERE email = ${email}
  `;
  for (const row of rows) {
    await sql`
      DELETE FROM note_versions
      WHERE user_id = ${row.id}
         OR note_id IN (SELECT id FROM notes WHERE user_id = ${row.id})
    `;
    await sql`
      DELETE FROM audit_events
      WHERE user_id = ${row.id} OR entity_id = ${row.id}
    `;
    await sql`DELETE FROM notes WHERE user_id = ${row.id}`;
    await sql`DELETE FROM users WHERE id = ${row.id}`;
  }
  await sql`
    DELETE FROM audit_events
    WHERE metadata->>'email' = ${email}
  `;
}

export function uniqueEmail(prefix = "e2e"): string {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 10_000)}@example.com`;
}