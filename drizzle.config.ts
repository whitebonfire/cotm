import { defineConfig } from "drizzle-kit";

// Drizzle Kit: `npm run db:push` syncs the schema to the database in dev;
// `npm run db:generate` writes SQL migrations for production.
export default defineConfig({
  schema: "./server/src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "",
  },
});
