import { createServer } from "http";
import { fileURLToPath } from "url";
import path from "path";
import express from "express";
import { Server } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { HouseRoom } from "./rooms/HouseRoom.js";
import { LIVE_ENABLED, PROVIDER_LABEL } from "./ai/llm.js";

const PORT = Number(process.env.PORT) || 2567;

const here = path.dirname(fileURLToPath(import.meta.url));
// dist/server/index.js -> dist/public
const publicDir = path.resolve(here, "../public");

const app = express();

// Render pings this to decide whether the service is alive.
app.get("/health", (_req, res) => res.json({ ok: true, uptime: process.uptime() }));

app.use(express.static(publicDir));

// The client is a single page; hand any unmatched GET back to it.
app.get(/^\/(?!health).*/, (_req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

const httpServer = createServer(app);

const gameServer = new Server({
  transport: new WebSocketTransport({ server: httpServer }),
});

gameServer.define("house", HouseRoom);

gameServer.listen(PORT).then(() => {
  console.log(`[cotm] listening on :${PORT}`);
  console.log(`[cotm] serving client from ${publicDir}`);
  if (LIVE_ENABLED) {
    console.log(`[cotm] interviews: LIVE — ${PROVIDER_LABEL}`);
  } else {
    console.log(`[cotm] interviews: AUTHORED FALLBACK — ${PROVIDER_LABEL}. Install the claude CLI or set ANTHROPIC_API_KEY for live conversation.`);
  }
});

// Render sends SIGTERM on deploy. Let rooms drain instead of dropping players.
const shutdown = () => {
  console.log("[cotm] shutting down");
  gameServer.gracefullyShutdown().then(() => process.exit(0));
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
