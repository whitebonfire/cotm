# 🔎 Clues of the Mind 🕶

A browser-based 3D detective game. One Detective, one Spy, twelve AI partygoers, ten minutes.

See [SOW.md](./SOW.md) for the design. This README is about running the thing.

**Current state: milestone 6 — roles + the live interview.** You pick a role (host first, friend takes the other): the Detective carries the tablet, the Spy has none. The interview is a **live chat** — the Detective types questions and the guest answers turn by turn. NPCs answer live via Claude, in a distinct writing voice; a human being questioned types their own replies. Answer timing is paced so speed can't out the AI. No win conditions yet (that's M7).

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

   gaps in the lines are doorways · you wake up as whichever guest you took over
```

Every room has at least two ways out — the Ballroom has four. That's deliberate: a Spy needs to leave by a door they didn't come in by, and a Detective needs to be losable. `npm run test:house` enforces it.

**You don't join the party — you take over a guest.** There are always exactly twelve bodies. When you connect, one of them quietly stops being driven by the AI and starts being driven by you, keeping its name, face, and accessory. Leave, and the AI picks it back up mid-stride. That's the Spy mechanic, built early on purpose: it's the only way to know whether the disguise actually holds.

Press `E` near a spot to join in with whatever happens there — read the book, take a drink, look out at the city. Those are the same actions the NPCs perform, from the same list, because that's the camouflage.

---

## Run it locally

```bash
npm install
npm run dev
```

Then open <http://localhost:5173>. Open it twice to see both players.

`npm run dev` runs two processes: the game server on `:2567` and Vite on `:5173` with hot reload. The client points at `localhost:2567` automatically in dev.

### Live AI answers (optional)

Interview answers are written live by Claude when an API key is present, and by
an authored fallback otherwise — so the game runs fully either way. To turn on
live generation:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

The server uses Haiku (`COTM_MODEL` overrides it) with a hard timeout that
falls back to authored in-voice deflections, so a slow or failed call never
leaves an NPC silent. Replies are paced to a human-like delay (`COTM_REPLY_MIN_MS`,
`COTM_REPLY_MAX_MS`, `COTM_REPLY_PER_CHAR_MS`) that absorbs generation latency, so
answer speed can't distinguish the AI from a human typing. **Without a key, NPCs
give in-character deflections but can't truly converse — the live chat needs the
key to shine.**

## Run the production build

```bash
npm run build
npm start
```

Everything is served from <http://localhost:2567> — one process, one port, exactly as it runs on Render.

## Test

```bash
npm run test:house   # geometry only, no server needed

npm start &          # these need a server
npm run test:spine

# the interview test wants a short window:
COTM_INTERVIEW_MS=1500 npm start &
COTM_INTERVIEW_MS=1500 npm run test:interview
```

`scripts/house-check.mjs` validates the floor plan itself: flood-fills the house and asserts every room is reachable, every room has two or more exits, no pocket of floor is walled off, no spawn or anchor sits inside a wall, no two anchors overlap, and every room can be routed to from every other room.

`scripts/spine-test.mjs` is the netcode and disguise acceptance test. Two real clients, one party. It asserts the usual netcode things — shared room, visible movement, correct speed and direction, walls that stop you and doorways that don't, no escaping the house, no client teleporting itself — plus the NPCs being alive and varied, and a body carrying on under AI control after its player leaves.

It also guards **the disguise**, which is the part worth understanding:

- body IDs are never session IDs, never say "npc", and are all the same shape
- a body exposes only whitelisted fields — add `isSpy` to the `Person` schema and this test fails, which is the entire idea
- a human body and an NPC body expose **the same fields**
- there is no `players`/`npcs` split in the state to read

`scripts/interview-test.mjs` drives the live chat: host picks a role and the other takes the leftover, the Spy can't interview, you can't question yourself, opening a chat with an NPC and asking a question returns a live in-voice reply (with a valid expression and no machine tells), the conversation continues across turns, a human target gets the questions and their typed replies reach the Detective, closing the chat releases them, and — the load-bearing one — no persona or answer text ever leaks into synced state. Run it with fast pacing: `COTM_REPLY_MIN_MS=40 COTM_REPLY_MAX_MS=120 COTM_REPLY_PER_CHAR_MS=0`.

Worth keeping green. Between them these caught the stale-input bug, a static anchor-claim set that would have leaked between concurrent games, the sit/walk NPC glitch, and confirmed collision lands within a millimetre of where the maths says it should.

---

## Layout

```
client/          browser: three.js renderer, camera, input
  index.html
  src/main.ts
  src/house.ts         geometry + furniture from the shared floor plan
  src/person.ts        procedural partygoers, and how they're animated
server/          authoritative game server
  src/index.ts         express + colyseus + static hosting
  src/rooms/HouseRoom.ts   simulation, body takeover, actions
  src/schema/GameState.ts  what crosses the wire — read the comment
  src/ai/npc.ts        how the guests decide where to go
  src/ai/persona.ts    who each guest is + the writing-voice spread (SOW §5.3)
  src/ai/llm.ts        optional live answers via Claude, timeout -> authored
  src/world/house.ts   SHARED floor plan + collision (see below)
  src/world/nav.ts     SHARED anchors + room graph + pathfinding
  src/world/furniture.ts  SHARED furniture colliders
client/src/tablet.ts   detective's tablet: camera, roster, interview reveal
client/src/interview.ts the being-questioned typing box
scripts/
  house-check.mjs  floor plan + anchor + routing validation, no server
  spine-test.mjs   two-client netcode and disguise acceptance test
  interview-test.mjs  the interview flow, needs a short-window server
render.yaml      deploy blueprint
```

## Architecture notes

**The server owns every position.** Clients send *intent* — which keys are down, where the camera points — and never a coordinate. The client predicts locally so movement feels instant, then eases toward whatever the server says. `HouseRoom.tick()` is the only code in the project allowed to decide where a body is.

**`server/src/world/house.ts` is shared code.** The server imports it to collide; the client imports the same file to render and to predict. This is not tidiness — it's a requirement. If the two sides disagree about where a wall is by even a few centimetres, the client predicts through it, the server refuses, and the player rubber-bands. One definition, both consumers.

It lives under `server/` so the server's `tsc` build (`rootDir: server/src`) can reach it. The client imports across the tree and Vite bundles it. Keep it free of decorators, Schema, and imports — plain data and maths, so both build systems can eat it.

**One `people` map, opaque IDs, and the session→body mapping stays in server memory.** This is the disguise, and it's a protocol-level concern, not a visual one. If humans lived in `state.players` and NPCs in `state.npcs`, the Detective's client could tell them apart by reading which map a body came from — the costume wouldn't matter. Same if keys were session IDs for humans and `npc-4` for the rest.

The rule as this grows: **nothing that distinguishes a human body from an AI body may ever become a `@type()` field.** Not a role, not a flag, not a hint. `spine-test.mjs` enforces it with a field whitelist. See SOW §7.1.

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
