import { createServer } from "http";
import { fileURLToPath } from "url";
import path from "path";
import express from "express";
import { Server } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { HouseRoom } from "./rooms/HouseRoom.js";
import { LobbyRoom } from "./rooms/LobbyRoom.js";
import { authState } from "./authState.js";
import { LIVE_ENABLED, PROVIDER_LABEL } from "./ai/llm.js";

const PORT = Number(process.env.PORT) || 2567;
// Accounts, friend codes and the lobby only exist when a database is wired up.
// Without one the game still runs — it falls back to anonymous quick-play, and
// the live site keeps working until a Postgres URL is provisioned (SOW §6, §7).
const AUTH_ENABLED = !!process.env.DATABASE_URL;

const here = path.dirname(fileURLToPath(import.meta.url));
// dist/server/index.js -> dist/public
const publicDir = path.resolve(here, "../public");

const app = express();

// Render pings this to decide whether the service is alive.
app.get("/health", (_req, res) => res.json({ ok: true, uptime: process.uptime() }));

// True once Better Auth is actually wired and its tables exist. Distinct from
// AUTH_ENABLED (which only means DATABASE_URL was set) so a broken database
// setup degrades to quick-play instead of lying to the client.
let authReady = false;

// The client asks this on load to decide whether to show the sign-in + lobby
// flow or the anonymous quick-play fallback.
app.get("/api/config", (_req, res) => res.json({ auth: authReady }));

async function start() {
  // Mount Better Auth only when there's a database. The import is dynamic so a
  // DB-less run never touches db/index.ts (which would throw). Table creation
  // runs here too, so provisioning a database is all it takes to go live — no
  // separate migrate step. Any failure falls back to anonymous quick-play so a
  // misconfigured database can't take the whole site down.
  if (AUTH_ENABLED) {
    try {
      const { db } = await import("./db/index.js");
      const { migrate } = await import("drizzle-orm/node-postgres/migrator");
      await migrate(db, { migrationsFolder: "./drizzle" });

      const { toNodeHandler } = await import("better-auth/node");
      const { auth } = await import("./auth.js");
      // Must come before any body parser; Better Auth reads the raw request.
      app.all("/api/auth/*", toNodeHandler(auth));
      // Let the rooms resolve a session from the WS handshake headers (cookies).
      authState.setResolver(async (headers) => {
        const h = new Headers();
        for (const [k, v] of Object.entries(headers)) {
          if (typeof v === "string") h.set(k, v);
          else if (Array.isArray(v)) h.set(k, v.join(", "));
        }
        const s = await auth.api.getSession({ headers: h });
        if (!s?.user) return null;
        const u = s.user as { id: string; name: string; friendCode?: string | null };
        return { id: u.id, name: u.name, friendCode: u.friendCode ?? null };
      });
      authReady = true;
      console.log("[cotm] auth: ENABLED (accounts + friend codes + lobby)");
    } catch (err) {
      console.error("[cotm] auth setup FAILED — running anonymous quick-play instead:", err);
    }
  } else {
    console.log("[cotm] auth: DISABLED (no DATABASE_URL) — anonymous quick-play");
  }

  app.use(express.static(publicDir));

  // The client is a single page; hand any unmatched GET (but not the API) back
  // to it so client-side routing works on refresh.
  app.get(/^\/(?!health|api\/).*/, (_req, res) => {
    res.sendFile(path.join(publicDir, "index.html"));
  });

  const httpServer = createServer(app);
  const gameServer = new Server({
    transport: new WebSocketTransport({ server: httpServer }),
  });

  gameServer.define("house", HouseRoom);
  gameServer.define("lobby", LobbyRoom);

  await gameServer.listen(PORT);
  console.log(`[cotm] listening on :${PORT}`);
  console.log(`[cotm] serving client from ${publicDir}`);
  if (LIVE_ENABLED) {
    console.log(`[cotm] interviews: LIVE — ${PROVIDER_LABEL}`);
  } else {
    console.log(
      `[cotm] interviews: AUTHORED FALLBACK — ${PROVIDER_LABEL}. Install the claude CLI or set ANTHROPIC_API_KEY for live conversation.`
    );
  }

  // Render sends SIGTERM on deploy. Let rooms drain instead of dropping players.
  const shutdown = () => {
    console.log("[cotm] shutting down");
    gameServer.gracefullyShutdown().then(() => process.exit(0));
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

start().catch((err) => {
  console.error("[cotm] failed to start:", err);
  process.exit(1);
});
