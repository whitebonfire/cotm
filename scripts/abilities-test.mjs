// Ability acceptance test (SOW §4.2, §4.3): the full kit — hack, magnifier,
// hide, inspection (seal), impersonate, and snap. Needs a running server.
import { Client } from "colyseus.js";
import { roomAt } from "../dist/server/world/house.js";
import { routeTo } from "../dist/server/world/nav.js";

const ENDPOINT = "ws://localhost:2567";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass });
  console.log(`${pass ? "  PASS" : "  FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};

const TYPES = [
  "you", "role_pick", "role_wait", "your_role",
  "ability_used", "ability_denied", "lights",
  "detective_mark", "seal", "photographed",
];

async function join(name) {
  const room = await new Client(ENDPOINT).joinOrCreate("house", { name });
  const inbox = [];
  for (const t of TYPES) room.onMessage(t, (m) => inbox.push({ t, m, at: Date.now() }));
  const waitFor = async (t, ms = 2000) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      const h = inbox.find((e) => e.t === t);
      if (h) return h.m;
      await sleep(20);
    }
    return null;
  };
  const clear = () => (inbox.length = 0);
  const me = await waitFor("you", 3000);
  return { room, me, inbox, waitFor, clear };
}

// Navigate a body using the server's own pathfinder, sidestepping when jammed.
const steer = async (room, posFn, tx, tz, mag = false, maxMs = 12000) => {
  const until = Date.now() + maxMs;
  let prev = { x: posFn().x, z: posFn().z }, mark = Date.now(), sideUntil = 0, side = 1;
  while (Date.now() < until) {
    const p = posFn();
    const dx = tx - p.x, dz = tz - p.z;
    if (Math.hypot(dx, dz) < 0.4) break;
    const now = Date.now();
    if (now > sideUntil && now - mark >= 250) {
      if (Math.hypot(p.x - prev.x, p.z - prev.z) < 0.12) { sideUntil = now + 500; side = -side; }
      prev = { x: p.x, z: p.z }; mark = now;
    }
    let yaw = Math.atan2(-dx, -dz);
    if (now <= sideUntil) yaw += (side * Math.PI) / 2;
    room.send("input", { f: 1, r: 0, yaw, mag });
    await sleep(40);
  }
  room.send("input", { f: 0, r: 0, yaw: 0, mag });
  await sleep(150);
};
const navigate = async (room, posFn, tx, tz) => {
  const dest = roomAt(tx, tz), here = posFn();
  for (const wp of routeTo(here.x, here.z, { id: "t", room: dest.id, x: tx, z: tz, action: 0 }))
    await steer(room, posFn, wp.x, wp.z);
  await sleep(200);
};

const a = await join("alice"); // host -> detective
const b = await join("bob"); // -> spy
await sleep(400);
await a.waitFor("role_pick", 1500);
a.room.send("pick_role", { role: "detective" });
check("alice is the detective", (await a.waitFor("your_role"))?.role === "detective");
check("bob is the spy", (await b.waitFor("your_role"))?.role === "spy");

// ---- DETECTIVE MARKER: the spy is shown who the detective is (SOW §4.3).
const mark0 = await b.waitFor("detective_mark", 1500);
check("the spy is shown where the detective is", !!mark0 && mark0.body === a.me.body, mark0?.body);
check("the detective is NOT shown the spy's marker", !a.inbox.some((e) => e.t === "detective_mark"));
a.clear(); b.clear();

// Park bob out of the way for the movement measurements.
const bobPos = () => a.room.state.people.get(b.me.body);
await navigate(b.room, bobPos, -18, 13);

// ---- HACK
b.room.send("ability", { id: "hack" });
const used = await b.waitFor("ability_used", 1500);
check("the spy can hack", !!used && used.id === "hack", used ? `cooldown ${used.cooldownMs}ms` : "no");
const lightsForDet = await a.waitFor("lights", 1500);
check("hack cuts the lights for the detective", !!lightsForDet && lightsForDet.off === true);
const lightsForSpy = await b.waitFor("lights", 600);
check("the spy still sees (no blackout for the hacker)", !lightsForSpy);
b.clear();

// cooldown: an immediate second hack is refused
b.room.send("ability", { id: "hack" });
check("hack respects its cooldown", !!(await b.waitFor("ability_denied", 1000)));
b.clear();

// the detective can't hack
a.room.send("ability", { id: "hack" });
check("the detective can't hack", !!(await a.waitFor("ability_denied", 1000)));
a.clear();

// ---- HIDE (detective blends in; the spy's marker goes dark)
a.clear(); b.clear();
a.room.send("ability", { id: "hide" });
const hid = await a.waitFor("ability_used", 1500);
check("the detective can hide", hid?.id === "hide" && hid.durationMs > 0, hid ? `${hid.durationMs}ms` : "no");
const markGone = await b.waitFor("detective_mark", 1500);
check("hiding drops the spy's marker on the detective", !!markGone && markGone.body === null);
b.room.send("ability", { id: "hide" });
check("the spy can't hide", !!(await b.waitFor("ability_denied", 1000)));
a.clear(); b.clear();

// ---- INSPECTION (seal the detective's room)
a.room.send("ability", { id: "inspection" });
const sealed = await a.waitFor("ability_used", 1500);
check("the detective can seal a room", sealed?.id === "inspection" && sealed.durationMs > 0);
const sealMsg = await b.waitFor("seal", 1500);
check("a seal is announced with a room and duration", !!sealMsg && typeof sealMsg.room === "string" && sealMsg.ms > 0);
b.room.send("ability", { id: "inspection" });
check("the spy can't seal", !!(await b.waitFor("ability_denied", 1000)));
a.clear(); b.clear();

// ---- IMPERSONATE role gate. The actual walking test runs LAST, because it
// puts bob's body on NPC autopilot for the ability's duration — which would
// hijack any test that tries to steer bob afterwards.
a.room.send("ability", { id: "impersonate" });
check("the detective can't impersonate", !!(await a.waitFor("ability_denied", 1000)));
a.clear(); b.clear();

// ---- MAGNIFYING GLASS (detective moves slower)
const alicePos = () => b.room.state.people.get(a.me.body);
const EAST = -Math.PI / 2;

// Measure a clean straight walk east from the ballroom west side, with and
// without the magnifier. Retry until an unobstructed run (no NPC in the lane).
async function measure(mag) {
  for (let attempt = 0; attempt < 8; attempt++) {
    await navigate(a.room, alicePos, -6, 3);
    // wait for a clear lane ahead
    let waited = 0;
    const clear = () => {
      const me = alicePos();
      for (const k of a.room.state.people.keys()) {
        if (k === a.me.body) continue;
        const p = a.room.state.people.get(k);
        if (p.x > me.x - 0.5 && p.x < me.x + 3.5 && Math.abs(p.z - me.z) < 0.8) return false;
      }
      return true;
    };
    while (!clear() && waited < 6000) { await sleep(300); waited += 300; }
    const s = { x: alicePos().x, z: alicePos().z };
    const t0 = Date.now();
    for (let i = 0; i < 14; i++) { a.room.send("input", { f: 1, r: 0, yaw: EAST, mag }); await sleep(50); }
    const held = (Date.now() - t0) / 1000;
    a.room.send("input", { f: 0, r: 0, yaw: EAST, mag });
    await sleep(300);
    const e = { x: alicePos().x, z: alicePos().z };
    const drift = Math.abs(e.z - s.z);
    const spd = Math.hypot(e.x - s.x, e.z - s.z) / held;
    if (e.x > s.x + 0.5 && drift < 0.05) return spd;
  }
  return null;
}

const fast = await measure(false);
const slow = await measure(true);
check("normal walk is ~4.2 m/s", fast !== null && fast > 3.9 && fast < 4.5, `${fast?.toFixed(2)} m/s`);
check("magnifying glass slows the detective to ~2.1 m/s", slow !== null && slow > 1.8 && slow < 2.4, `${slow?.toFixed(2)} m/s`);
check("magnifier is meaningfully slower than normal", fast && slow && slow < fast * 0.65, `${slow?.toFixed(2)} vs ${fast?.toFixed(2)}`);

// the spy's magnify flag is ignored (detective-only) — bob walks at full speed
async function bobSpeed(mag) {
  await navigate(b.room, bobPos, -14, 8); // conservatory open floor
  const s = { x: bobPos().x, z: bobPos().z };
  const t0 = Date.now();
  for (let i = 0; i < 12; i++) { b.room.send("input", { f: 1, r: 0, yaw: Math.PI / 2, mag }); await sleep(50); } // west, open
  const held = (Date.now() - t0) / 1000;
  b.room.send("input", { f: 0, r: 0, yaw: Math.PI / 2, mag });
  await sleep(300);
  const e = { x: bobPos().x, z: bobPos().z };
  return Math.hypot(e.x - s.x, e.z - s.z) / held;
}
const spyMag = await bobSpeed(true);
check("the spy can't use the magnifier (moves at full speed)", spyMag > 3.4, `${spyMag.toFixed(2)} m/s with mag=true`);

// ---- SNAP (photograph the detective for +1 minute; must be close)
a.clear(); b.clear();
// bob is across the house from alice right now — a snap should be refused.
b.room.send("ability", { id: "snap" });
const farDenied = await b.waitFor("ability_denied", 1000);
check("snap needs the detective close", !!farDenied && /clos/i.test(farDenied.reason ?? ""), farDenied?.reason);

// the detective can't snap at all
a.room.send("ability", { id: "snap" });
check("the detective can't snap", !!(await a.waitFor("ability_denied", 1000)));
a.clear(); b.clear();

// walk bob onto the (stationary) detective and snap.
const ap = alicePos();
await navigate(b.room, bobPos, ap.x, ap.z);
await steer(b.room, bobPos, alicePos().x, alicePos().z, false, 5000);
const before = a.room.state.round.secondsLeft;
b.room.send("ability", { id: "snap" });
const snapUsed = await b.waitFor("ability_used", 1500);
check("the spy can snap the detective when close", snapUsed?.id === "snap", snapUsed ? "" : "denied");
await sleep(250);
const after = a.room.state.round.secondsLeft;
check("snap adds a minute to the clock", after - before >= 55, `${before} -> ${after}`);
const photo = await a.waitFor("photographed", 1500);
check("the detective is told they were photographed", !!photo && photo.secondsAdded >= 55);

// ---- IMPERSONATE (runs last): the spy's body goes on NPC autopilot and walks
// around on its own, mirroring a guest, with NO input from the player.
b.clear();
b.room.send("ability", { id: "impersonate" });
const imp = await b.waitFor("ability_used", 1500);
check("the spy can impersonate", imp?.id === "impersonate" && imp.durationMs > 0, imp ? `${imp.durationMs}ms` : "no");
const startPos = { x: bobPos().x, z: bobPos().z };
let moved = 0;
for (let i = 0; i < 140; i++) { // up to ~7s, sending NO input
  await sleep(50);
  moved = Math.max(moved, Math.hypot(bobPos().x - startPos.x, bobPos().z - startPos.z));
  if (moved > 0.6) break;
}
check("impersonate walks the spy around on its own (no input)", moved > 0.6, `moved ${moved.toFixed(2)}m`);

await a.room.leave();
await b.room.leave();
await sleep(300);

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
