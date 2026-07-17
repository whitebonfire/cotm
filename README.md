# 🔎 Clues of the Mind 🕶

A browser-based 3D detective game. One Detective, one Spy, twelve AI partygoers, ten minutes.

See [SOW.md](./SOW.md) for the design. This README is about running the thing.

**Current state: milestone 1 — foundations.** A grey room you can walk around in with a friend. No house, no NPCs, no roles. The point is the spine, not the game.

---

## Run it locally

```bash
npm install
npm run dev
```

Then open <http://localhost:5173>. Open it twice to see both players.

`npm run dev` runs two processes: the game server on `:2567` and Vite on `:5173` with hot reload. The client points at `localhost:2567` automatically in dev.

## Run the production build

```bash
npm run build
npm start
```

Everything is served from <http://localhost:2567> — one process, one port, exactly as it runs on Render.

## Test

```bash
npm start &          # the test needs a server
npm run test:spine
```

`scripts/spine-test.mjs` is milestone 1's acceptance criteria as code. It connects two real clients and asserts they share a room, see each other move, that movement speed and direction are right, that walls hold, that leaving cleans up — and that the server ignores a client trying to teleport itself.

Worth keeping green. It caught the stale-input bug during the build.

---

## Layout

```
client/          browser: three.js renderer, camera, input
  index.html
  src/main.ts
server/          authoritative game server
  src/index.ts         express + colyseus + static hosting
  src/rooms/HouseRoom.ts   movement simulation
  src/schema/GameState.ts  what crosses the wire
scripts/
  spine-test.mjs   two-client acceptance test
render.yaml      deploy blueprint
```

## Architecture notes

**The server owns every position.** Clients send *intent* — which keys are down, where the camera points — and never a coordinate. The client predicts locally so movement feels instant, then eases toward whatever the server says. `HouseRoom.tick()` is the only code in the project allowed to decide where a body is.

This matters more than it looks. By milestone 3 there's a Spy identity worth cheating for, and a client that can be trusted with positions is a client that can be trusted with everything else. Doing authority now means never retrofitting it. See SOW §7.1.

**Input goes stale after 250ms.** Clients send at 20Hz. If one goes quiet — lag spike, backgrounded tab — the server stops them rather than applying the last input forever and walking them into a wall.

**Version pinning is deliberate.** Colyseus server is on the 0.16 line, not 0.17. The 0.17 server uses `@colyseus/schema` 4.x but the JS client is still on 0.16 and depends on schema 3.x — mixing them is a wire-format mismatch. All Colyseus packages are pinned exactly, and both server and client dedupe to a single `@colyseus/schema@3.0.76`. **Don't bump one without the others.**

**Decorators are server-only.** `@type()` is a legacy property decorator, so `tsconfig.server.json` sets `experimentalDecorators: true` *and* `useDefineForClassFields: false` — without the second, class field initialisers silently overwrite the property descriptors and nothing syncs. The client imports the schema classes as types only, so no decorator ever reaches the browser bundle.

---

## Deploy to Render

One Web Service serves both the client bundle and the WebSocket server. It must be a **Web Service**, not a Static Site — Colyseus needs a long-lived process holding open sockets.

1. Push this repo to GitHub.
2. In Render: **New → Blueprint**, point it at the repo. It reads `render.yaml`.
3. Deploy.

Render sets `PORT`; the server reads it. Health checks hit `/health`.

**On the free plan**, the service sleeps after ~15 minutes idle and takes ~30s to wake — the first player to arrive after a quiet spell waits, and sleeping drops anyone connected. Fine for testing with friends, not for real rounds. Starter tier removes it.
