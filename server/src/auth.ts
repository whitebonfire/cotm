import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { db } from "./db/index.js";
import { schema } from "./db/schema.js";

/** A friendly, shareable code like "CLUE-8XK3". No ambiguous 0/O/1/I/L chars,
 *  so it survives being read aloud or copied by hand (SOW §6.1). */
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
export function generateFriendCode(): string {
  let body = "";
  for (let i = 0; i < 4; i++) {
    body += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  }
  return `CLUE-${body}`;
}

// A hard fail if the deploy forgot the secret would be a silent security hole,
// so require it in production; allow a throwaway in local dev only.
const secret =
  process.env.BETTER_AUTH_SECRET ||
  (process.env.NODE_ENV === "production"
    ? (() => {
        throw new Error("BETTER_AUTH_SECRET is required in production.");
      })()
    : "dev-only-insecure-secret-change-me");

/**
 * Better Auth (SOW §7): email + password, sessions owned by the library, our
 * own user table so a friend code can live on it. Mounted at /api/auth/* by
 * index.ts. On every sign-up we mint a friend code in a before-create hook.
 */
export const auth = betterAuth({
  database: drizzleAdapter(db, { provider: "pg", schema }),
  secret,
  baseURL: process.env.BETTER_AUTH_URL || "http://localhost:2567",
  // The client is same-origin (served by this server), so the app's own origin
  // is trusted; add the explicit URL too for safety behind Render's proxy.
  trustedOrigins: [process.env.BETTER_AUTH_URL || "http://localhost:2567"],
  emailAndPassword: {
    enabled: true,
    // No email service wired up yet; a two-friend game doesn't need verify.
    requireEmailVerification: false,
  },
  user: {
    additionalFields: {
      // Set by the hook below; never accepted from client input.
      friendCode: { type: "string", required: false, input: false },
    },
  },
  databaseHooks: {
    user: {
      create: {
        before: async (u) => ({ data: { ...u, friendCode: generateFriendCode() } }),
      },
    },
  },
});
