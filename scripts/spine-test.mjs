// Netcode + disguise acceptance test: two clients, one party, server-owned
// movement, and no way to tell a human body from an AI one over the wire.
import { Client, getStateCallbacks } from "colyseus.js";
// The real pathfinder, from the built server. Bodies now start wherever their
// guest happened to be standing, so the test has to actually navigate the
// house — and walking a straight line at a target just presses you into a wall.
import { roomAt } from "../dist/server/world/house.js";
import { routeTo } from "../dist/server/world/nav.js";

const ENDPOINT = "ws://localhost:2567";
const PARTY_SIZE = 12;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "  PASS" : "  FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};

/** Join, and wait for the server to say which body is ours. */
async function join(name) {
  const room = await new Client(ENDPOINT).joinOrCreate("house", { name });
  const me = await new Promise((resolve) => room.onMessage("you", resolve));
  return { room, me };
}

const a = await join("alice");
const b = await join("bob");
await sleep(700);

// ---- the party
check("party is 12 bodies", a.room.state.people.size === PARTY_SIZE, `saw ${a.room.state.people.size}`);
check(
  "a joining player TAKES OVER a guest rather than adding one",
  b.room.state.people.size === PARTY_SIZE,
  `still ${b.room.state.people.size} after 2 joins`
);
check("both clients agree on the party", a.room.state.people.size === b.room.state.people.size);
check("the two players got different bodies", a.me.body !== b.me.body, `${a.me.body} vs ${b.me.body}`);
check("your body has a real guest's name", typeof a.me.name === "string" && a.me.name.includes(" "), a.me.name);

// ---- THE DISGUISE. This is the point of the whole architecture.
const keys = [...a.room.state.people.keys()];

check(
  "body IDs are not session IDs",
  !keys.includes(a.room.sessionId) && !keys.includes(b.room.sessionId),
  "a client could otherwise find humans by matching its own key format"
);
check(
  // The real invariant: IDs are opaque tokens with no separator or label, so a
  // key like "npc-4" or "player_1" can't exist. (Substring-matching random
  // base36 for "ai"/"bot" false-positives by chance — the IDs are still opaque.)
  "body IDs are opaque tokens, not labels like npc-4",
  keys.every((k) => /^b[0-9a-z]{7,}$/.test(k)),
  keys.slice(0, 3).join(", ") + " …"
);
check(
  "human and NPC body IDs are indistinguishable in shape",
  new Set(keys.map((k) => k.length)).size === 1,
  `id lengths: ${[...new Set(keys.map((k) => k.length))].join("/")}`
);

// The fields on a body are a whitelist. If anyone ever adds `isSpy` or
// `isHuman` to the Person schema, this fails — which is the entire idea.
const ALLOWED = [
  "name", "x", "y", "z", "yaw", "action",
  "skin", "hair", "hairHue", "outfitHue", "outfitVal", "age", "hat", "acc", "height",
].sort();

const mine = a.room.state.people.get(a.me.body);
const someoneElse = a.room.state.people.get(keys.find((k) => k !== a.me.body && k !== b.me.body));

const fieldsOf = (p) => Object.keys(p.toJSON()).sort();
check(
  "a body exposes only the whitelisted fields",
  JSON.stringify(fieldsOf(mine)) === JSON.stringify(ALLOWED),
  fieldsOf(mine).filter((f) => !ALLOWED.includes(f)).join(",") || "clean"
);
check(
  "a human body and an NPC body expose the SAME fields",
  JSON.stringify(fieldsOf(mine)) === JSON.stringify(fieldsOf(someoneElse)),
  "any asymmetry here is a free answer for the Detective"
);
check(
  "state carries no players/npcs split",
  !("players" in a.room.state) && !("npcs" in a.room.state),
  Object.keys(a.room.state.toJSON()).join(",")
);

// ---- movement. Steer by position: bodies now spawn wherever their guest was
// standing, so nothing can assume a fixed start point.
const body = () => b.room.state.people.get(a.me.body); // alice, as seen by bob
const EAST = -Math.PI / 2;

/**
 * Walk a body toward a point, sidestepping when jammed. Furniture and other
 * guests are solid now, so a naive straight line snags on them; when progress
 * stalls, strafe perpendicular for a moment (alternating sides) to slip around.
 * Parameterised by room + position getter so it drives either human.
 */
const steerBody = async (room, posFn, tx, tz, maxMs = 12000) => {
  const until = Date.now() + maxMs;
  let prev = { x: posFn().x, z: posFn().z };
  let mark = Date.now();
  let sideUntil = 0;
  let sideDir = 1;

  while (Date.now() < until) {
    const p = posFn();
    const dx = tx - p.x;
    const dz = tz - p.z;
    if (Math.hypot(dx, dz) < 0.4) break;

    const now = Date.now();
    if (now > sideUntil && now - mark >= 250) {
      const moved = Math.hypot(p.x - prev.x, p.z - prev.z);
      if (moved < 0.12) {
        sideUntil = now + 500; // strafe for half a second to get around it
        sideDir = -sideDir;
      }
      prev = { x: p.x, z: p.z };
      mark = now;
    }

    let yaw = Math.atan2(-dx, -dz);
    if (now <= sideUntil) yaw += (sideDir * Math.PI) / 2;
    room.send("input", { f: 1, r: 0, yaw });
    await sleep(40);
  }
  room.send("input", { f: 0, r: 0, yaw: 0 });
  await sleep(150);
};

/** Route a body through the house, using the server's own pathfinder. */
const navigateBody = async (room, posFn, tx, tz) => {
  const dest = roomAt(tx, tz);
  const here = posFn();
  const waypoints = routeTo(here.x, here.z, { id: "test", room: dest.id, x: tx, z: tz, action: 0 });
  for (const wp of waypoints) await steerBody(room, posFn, wp.x, wp.z);
  await sleep(200);
};

const steerTo = (tx, tz, maxMs) => steerBody(a.room, body, tx, tz, maxMs);
const navigateTo = (tx, tz) => navigateBody(a.room, body, tx, tz);

// Bob's body never moves on its own (a human drives it, sending no input), so if
// it spawned in a test lane it would sit there and collide every time. Park it
// in a far corner of the Conservatory, well clear of every lane alice uses.
const bobBody = () => a.room.state.people.get(b.me.body);
await navigateBody(b.room, bobBody, -18, 13);

const walk = async (yaw, ms) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    a.room.send("input", { f: 1, r: 0, yaw });
    await sleep(40);
  }
  a.room.send("input", { f: 0, r: 0, yaw });
  await sleep(300);
};

// Park in the Ballroom, west side, at z=3 — clear floor with the x=6 wall
// 12m east and no doorway on that line (the door there is at z=0).
await navigateTo(-6, 3);
const parked = body();
check(
  "can navigate the house to an arbitrary point",
  Math.hypot(parked.x - -6, parked.z - 3) < 0.8,
  `at (${parked.x.toFixed(2)}, ${parked.z.toFixed(2)}) from wherever their guest was standing`
);

// ---- the Spy's camouflage actions: a player can do what the NPCs do.
// Reading requires a bookshelf; sitting requires a seat. Prove both from the
// same body a human is driving.
const ACT = { READ: 2, SIT: 7 };
const actHere = async () => {
  a.room.send("act");
  await sleep(300);
  return body().action;
};

await navigateTo(-17.6, -13); // a library shelf (a READ anchor)
const readAction = await actHere();
check("a player can take a book from the shelf and read", readAction === ACT.READ, `action=${readAction} (want ${ACT.READ})`);
await actHere(); // stand back up

// Stand roughly a metre short of the couch anchor (18.9, 9) and sit. The body
// must SNAP onto the seat, not sit floating where it was standing.
await navigateTo(17.6, 9);
const beforeSit = { x: body().x, z: body().z };
const sitAction = await actHere();
const seated = body();
check("a player can sit down on the furniture", sitAction === ACT.SIT, `action=${sitAction} (want ${ACT.SIT})`);
check(
  "sitting snaps you onto the seat, not the air where you stood",
  Math.hypot(seated.x - 18.9, seated.z - 9) < 0.4 && Math.hypot(beforeSit.x - 18.9, beforeSit.z - 9) > 0.6,
  `stood at (${beforeSit.x.toFixed(2)},${beforeSit.z.toFixed(2)}), landed at (${seated.x.toFixed(2)},${seated.z.toFixed(2)})`
);
await actHere(); // stand back up

// ---- movement speed and direction, measured on an UNOBSTRUCTED run.
// Bodies are solid, so a guest crossing the lane can skew a single measurement.
// The invariant is that movement is exactly right when clear, so: walk a SHORT
// lane east from (-6,3) — 3m, with no anchor in it, so no NPC ever dwells there
// — and only after confirming nothing is in the way. Retry past the occasional
// guest just passing through.
const laneClear = () => {
  const me = body();
  for (const k of a.room.state.people.keys()) {
    if (k === a.me.body) continue;
    const p = a.room.state.people.get(k);
    if (p.x > me.x - 0.5 && p.x < me.x + 3.5 && Math.abs(p.z - me.z) < 0.8) return false;
  }
  return true;
};

let run = null;
let lastRun = null;
for (let attempt = 0; attempt < 8 && !run; attempt++) {
  await navigateTo(-6, 3);

  // Wait for the short lane ahead to be empty (up to ~6s; transiting NPCs clear).
  let waited = 0;
  while (!laneClear() && waited < 6000) {
    await sleep(300);
    waited += 300;
  }

  const s = { x: body().x, z: body().z };
  const t0 = Date.now();
  for (let i = 0; i < 14; i++) {
    a.room.send("input", { f: 1, r: 0, yaw: EAST });
    await sleep(50);
  }
  const held = (Date.now() - t0) / 1000;
  a.room.send("input", { f: 0, r: 0, yaw: EAST });
  await sleep(400);
  const e = { x: body().x, z: body().z };
  const c = { sx: s.x, sz: s.z, ex: e.x, ez: e.z, held };
  c.moved = Math.hypot(e.x - s.x, e.z - s.z);
  c.drift = Math.abs(e.z - s.z);
  c.spd = c.moved / c.held;
  lastRun = c;
  if (c.ex > c.sx + 1 && c.drift < 0.05 && c.spd > 3.9 && c.spd < 4.5) run = c;
}
const r = run || lastRun;
check("bob sees alice move", r.moved > 1, `moved ${r.moved.toFixed(2)}m`);
check("forward at yaw -PI/2 goes +X", r.ex > r.sx + 1, `x ${r.sx.toFixed(2)} -> ${r.ex.toFixed(2)}`);
check(
  "no sideways drift on an unobstructed run",
  !!run,
  run ? `dz ${run.drift.toFixed(4)}` : `no clean run in 6 tries (best drift ${r.drift.toFixed(3)})`
);
check(
  "speed ~4.2 m/s on an unobstructed run",
  !!run,
  run ? `${run.spd.toFixed(2)} m/s over ${run.held.toFixed(2)}s` : `best ${r.spd.toFixed(2)} m/s`
);

// ---- a client that goes silent mid-stride must STOP, not coast into a wall
const atSilence = { x: body().x, z: body().z };
for (let i = 0; i < 6; i++) {
  a.room.send("input", { f: 1, r: 0, yaw: EAST });
  await sleep(50);
}
const mark = { x: body().x, z: body().z };
await sleep(1200); // say nothing at all
const afterSilence = body();
const coasted = Math.hypot(afterSilence.x - mark.x, afterSilence.z - mark.z);
check("moved while sending", Math.hypot(mark.x - atSilence.x, mark.z - atSilence.z) > 0.5);
check(
  "stops within the stale-input window when client goes silent",
  coasted < 1.3,
  `coasted ${coasted.toFixed(2)}m in 1.2s of silence (budget 1.26m)`
);

// ---- SERVER AUTHORITY
const before = { x: body().x, z: body().z };
a.room.send("input", { f: 0, r: 0, yaw: EAST, x: 999, z: 999 });
a.room.send("input", { f: 99, r: 0, yaw: EAST });
a.room.send("input", { f: NaN, r: Infinity, yaw: NaN });
await sleep(500);
const after = body();
check("teleport fields in input are ignored", Math.hypot(after.x - 999, after.z - 999) > 100);
check("state stays finite after NaN/Infinity input", Number.isFinite(after.x) && Number.isFinite(after.z), `x=${after.x} z=${after.z}`);
check("out-of-range axis is clamped", Math.hypot(after.x - before.x, after.z - before.z) < 4, `moved ${Math.hypot(after.x - before.x, after.z - before.z).toFixed(2)}m in 0.5s`);

// ---- walls
await walk(EAST, 5000);
const walled = body();
check("wall stops the player", walled.x < 5.6 && walled.x > 5.2, `x=${walled.x.toFixed(3)} (expected ~5.43)`);

for (const yaw of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) await walk(yaw, 2600);
const loose = body();
check(
  "player cannot escape the house",
  loose.x > -20 && loose.x < 20 && loose.z > -15 && loose.z < 15,
  `at (${loose.x.toFixed(2)}, ${loose.z.toFixed(2)})`
);

// ---- furniture blocks you: you cannot walk through the dining table.
// Stand just south of the table (footprint z 2.7..5.3) and walk straight north
// into it.
await navigateTo(12.5, 0.8);
const beforeTable = { z: body().z };
await walk(Math.PI, 3500); // north = +z, into the table
const atTable = body();
check(
  "furniture stops you — no walking through the table",
  atTable.z > beforeTable.z + 0.4 && atTable.z < 2.5,
  `walked from z=${beforeTable.z.toFixed(2)} to z=${atTable.z.toFixed(2)} (table face at z=2.7)`
);

// ---- the NPCs are actually alive
//
// Sampled over a long window, not a snapshot. Dwells run 16-40s for reading
// and talking, so a short window can legitimately catch every guest mid-dwell
// and conclude the AI is dead. Poll until there's evidence instead.
const others = keys.filter((k) => k !== a.me.body && k !== b.me.body);
const snapshot = others.map((k) => {
  const p = a.room.state.people.get(k);
  return { k, x: p.x, z: p.z };
});

const stirred = new Set();
const actionsSeen = new Set();
const stationarySamples = [];
let minBodyGap = Infinity; // closest any two bodies ever come
const allKeys = [...a.room.state.people.keys()];
const watchUntil = Date.now() + 24000;

while (Date.now() < watchUntil) {
  await sleep(250);
  let stationaryNow = 0;
  for (const s of snapshot) {
    const p = a.room.state.people.get(s.k);
    if (!p) continue;
    actionsSeen.add(p.action);
    if (p.action !== 1) stationaryNow++;
    if (Math.hypot(p.x - s.x, p.z - s.z) > 0.5) stirred.add(s.k);
  }
  // Closest approach between any two bodies this sample — if collision works,
  // nobody ever deeply overlaps (which would read as walking through each other).
  for (let i = 0; i < allKeys.length; i++) {
    for (let j = i + 1; j < allKeys.length; j++) {
      const p = a.room.state.people.get(allKeys[i]);
      const q = a.room.state.people.get(allKeys[j]);
      if (p && q) minBodyGap = Math.min(minBodyGap, Math.hypot(p.x - q.x, p.z - q.z));
    }
  }
  stationarySamples.push(stationaryNow / others.length);
  if (stirred.size >= 3 && actionsSeen.size > 1 && stationarySamples.length > 40) break;
}

check("NPCs move by themselves", stirred.size > 0, `${stirred.size}/${others.length} left their spot`);
check("NPCs do more than one thing", actionsSeen.size > 1, `actions seen: ${[...actionsSeen].sort().join(",")}`);
check(
  "bodies never walk through each other",
  minBodyGap > 0.45,
  `closest two guests ever came was ${minBodyGap.toFixed(2)}m (bodies are 0.42m radius)`
);

const avgStationary = stationarySamples.reduce((a, b) => a + b, 0) / stationarySamples.length;
check(
  "most guests are standing still doing something, not all in transit",
  avgStationary >= 0.5,
  `${(avgStationary * 100).toFixed(0)}% stationary on average over ${stationarySamples.length} samples`
);

// ---- leaving hands the body back to the AI
// Snapshot BEFORE leaving: the AI takes over on the same tick, so anything
// sampled afterwards is already a body in motion. And poll rather than sample
// two moments — the body may reach a nearby anchor and settle into a 6-14s
// dwell, which two snapshots would read as "never moved".
const leftAt = { x: body().x, z: body().z };
await a.room.leave();

let resumedEvidence = null;
const deadline = Date.now() + 20000;
while (Date.now() < deadline && !resumedEvidence) {
  await sleep(200);
  const p = b.room.state.people.get(a.me.body);
  if (!p) break;
  const dist = Math.hypot(p.x - leftAt.x, p.z - leftAt.z);
  if (dist > 0.6) resumedEvidence = `walked ${dist.toFixed(2)}m away on its own`;
}

check("party is still 12 after a player leaves", b.room.state.people.size === PARTY_SIZE, `${b.room.state.people.size}`);

const abandoned = b.room.state.people.get(a.me.body);
check("the abandoned body still exists", !!abandoned, abandoned?.name ?? "gone");
check("the AI picks the body back up", !!resumedEvidence, resumedEvidence ?? "body never moved in 20s");

await b.room.leave();
await sleep(300);

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
