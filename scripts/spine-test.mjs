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
  "no body ID advertises itself as an NPC",
  !keys.some((k) => /npc|bot|ai|player|human/i.test(k)),
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

/** Straight-line walk. Only safe between waypoints with no wall between them. */
const steerTo = async (tx, tz, maxMs = 9000) => {
  const until = Date.now() + maxMs;
  while (Date.now() < until) {
    const p = body();
    const dx = tx - p.x;
    const dz = tz - p.z;
    if (Math.hypot(dx, dz) < 0.4) break;
    // forward = (-sin yaw, -cos yaw), so aim it down (dx, dz)
    a.room.send("input", { f: 1, r: 0, yaw: Math.atan2(-dx, -dz) });
    await sleep(40);
  }
  a.room.send("input", { f: 0, r: 0, yaw: 0 });
  await sleep(150);
};

/** Route through the house properly, using the server's own pathfinder. */
const navigateTo = async (tx, tz) => {
  const dest = roomAt(tx, tz);
  const here = body();
  const waypoints = routeTo(here.x, here.z, { id: "test", room: dest.id, x: tx, z: tz, action: 0 });
  for (const wp of waypoints) await steerTo(wp.x, wp.z);
  await sleep(200);
};

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

const start = { x: body().x, z: body().z };
const t0 = Date.now();
for (let i = 0; i < 30; i++) {
  a.room.send("input", { f: 1, r: 0, yaw: EAST });
  await sleep(50);
}
const held = (Date.now() - t0) / 1000;
a.room.send("input", { f: 0, r: 0, yaw: EAST });
await sleep(400);

const end = { x: body().x, z: body().z };
const moved = Math.hypot(end.x - start.x, end.z - start.z);

check("bob sees alice move", moved > 1, `moved ${moved.toFixed(2)}m`);
check("forward at yaw -PI/2 goes +X", end.x > start.x + 1, `x ${start.x.toFixed(2)} -> ${end.x.toFixed(2)}`);
check("no sideways drift", Math.abs(end.z - start.z) < 0.02, `dz ${(end.z - start.z).toFixed(4)}`);
check("speed within tolerance of 4.2 m/s", moved / held > 3.8 && moved / held < 4.6, `${(moved / held).toFixed(2)} m/s over ${held.toFixed(2)}s`);

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
  stationarySamples.push(stationaryNow / others.length);
  // Enough evidence — stop early rather than burn the full window.
  if (stirred.size >= 3 && actionsSeen.size > 1 && stationarySamples.length > 40) break;
}

check("NPCs move by themselves", stirred.size > 0, `${stirred.size}/${others.length} left their spot`);
check("NPCs do more than one thing", actionsSeen.size > 1, `actions seen: ${[...actionsSeen].sort().join(",")}`);

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
