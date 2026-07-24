import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { schema } from "./schema.js";

/**
 * The database connection (SOW §7). One pool for the process. DATABASE_URL is
 * provided by Render Postgres in production and by a local `.env` in dev; the
 * server refuses to start without it (see index.ts), so it's required here.
 */
const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is not set — the auth/lobby system needs a Postgres database.");
}

// Render Postgres requires TLS; local Postgres does not. Enable it for any
// non-localhost host so the same code works in both places.
const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(connectionString);

export const pool = new pg.Pool({
  connectionString,
  ssl: isLocal ? undefined : { rejectUnauthorized: false },
});

export const db = drizzle(pool, { schema });
