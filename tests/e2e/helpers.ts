import postgres from "postgres";

import { hashPassword } from "../../src/lib/auth/password";

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

export async function deleteUserByEmail(email: string): Promise<void> {
  const rows = await sql<{ id: string }[]>`
    SELECT id FROM users WHERE email = ${email}
  `;
  for (const row of rows) {
    await sql`
      DELETE FROM audit_events
      WHERE user_id = ${row.id} OR entity_id = ${row.id}
    `;
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