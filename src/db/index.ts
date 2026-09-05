import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { instrumentPostgres } from "@/lib/db-metrics";

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error("DATABASE_URL is not set");
}

export const client = instrumentPostgres(
  postgres(connectionString, {
    max: 10,
    onnotice: () => {},
  }),
);

export const db = drizzle(client);