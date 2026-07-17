# 🔎 Clues of the Mind 🕶

A browser-based 3D detective game. One Detective, one Spy, twelve AI partygoers, ten minutes.

See [SOW.md](./SOW.md) for the design. This README is about running the thing.

**Current state: milestone 2 — the house.** Seven lit rooms you can walk around with a friend, with walls the server enforces. No NPCs, no roles, no abilities yet.

```
        -20        -6    0    6              20
   -15   ┌───────────────┬─────┬──────────────┐
         │   LIBRARY     │STUDY│   KITCHEN    │
    -5   ├────┬──────────┴──┬──┴──────────────┤
         │    │             │                 │
         │CON-│  BALLROOM   │                 │
     5   │SER-├─────┬───────┤     DINING      │
         │VAT-│     │       │                 │
         │ORY │ ENTRANCE    │                 │
    15   └────┴─────────────┴─────────────────┘

   gaps in the lines are doorways · you spawn in the Entrance Hall
```

Every room has at least two ways out — the Ballroom has four. That's deliberate: a Spy needs to leave by a door they didn't come in by, and a Detective needs to be losable. `npm run test:house` enforces it.

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
npm run test:house   # geometry only, no server needed

npm start &          # this one needs a server
npm run test:spine
```

`scripts/house-check.mjs` validates the floor plan itself: flood-fills the house from the front door and asserts every room is reachable, every room has two or more exits, no pocket of floor is walled off, and no spawn point sits inside a wall.

`scripts/spine-test.mjs` is the netcode acceptance test. It connects two real clients and asserts they share a room, see each other move, that speed and direction are right, that walls stop you and doorways don't, that nobody can escape the house, that leaving cleans up — and that the server ignores a client trying to teleport itself.

Worth keeping green. Between them they caught the stale-input bug and confirmed collision lands within a millimetre of where the maths says it should.

---

## Layout

```
client/          browser: three.js renderer, camera, input
  index.html
  src/main.ts
  src/house.ts         builds geometry from the shared floor plan
server/          authoritative game server
  src/index.ts         express + colyseus + static hosting
  src/rooms/HouseRoom.ts   movement simulation
  src/schema/GameState.ts  what crosses the wire
  src/world/house.ts   SHARED floor plan + collision (see below)
scripts/
  house-check.mjs  floor plan validation, no server needed
  spine-test.mjs   two-client netcode acceptance test
render.yaml      deploy blueprint
```

## Architecture notes

**The server owns every position.** Clients send *intent* — which keys are down, where the camera points — and never a coordinate. The client predicts locally so movement feels instant, then eases toward whatever the server says. `HouseRoom.tick()` is the only code in the project allowed to decide where a body is.

**`server/src/world/house.ts` is shared code.** The server imports it to collide; the client imports the same file to render and to predict. This is not tidiness — it's a requirement. If the two sides disagree about where a wall is by even a few centimetres, the client predicts through it, the server refuses, and the player rubber-bands. One definition, both consumers.

It lives under `server/` so the server's `tsc` build (`rootDir: server/src`) can reach it. The client imports across the tree and Vite bundles it. Keep it free of decorators, Schema, and imports — plain data and maths, so both build systems can eat it.

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
