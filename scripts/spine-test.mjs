// Milestone 1 acceptance test: two clients, one room, server-owned movement.
import { Client, getStateCallbacks } from "colyseus.js";

const ENDPOINT = "ws://localhost:2567";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "  PASS" : "  FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};

const a = await new Client(ENDPOINT).joinOrCreate("house", { name: "alice" });
const b = await new Client(ENDPOINT).joinOrCreate("house", { name: "bob" });
await sleep(600);

// 1. same room
check("both clients land in the same room", a.roomId === b.roomId, `${a.roomId} / ${b.roomId}`);

// 2. each sees two players
check("alice sees 2 players", a.state.players.size === 2, `saw ${a.state.players.size}`);
check("bob sees 2 players", b.state.players.size === 2, `saw ${b.state.players.size}`);

// 3. names arrived
const aSelf = a.state.players.get(a.sessionId);
check("name from join options applied", aSelf?.name === "alice", `got "${aSelf?.name}"`);

// 4. alice walks; bob must observe it
const aInB = () => b.state.players.get(a.sessionId);
const start = { x: aInB().x, z: aInB().z };

// Alice spawns at (-8, 12) in the Entrance Hall. yaw -PI/2 => forward is +X,
// which is ~14m of clear floor before the wall at x=6. Chosen deliberately:
// a route with no doorway on it, so the walk tests movement and not geometry.
const EAST = -Math.PI / 2;

const t0 = Date.now();
for (let i = 0; i < 30; i++) {
  a.send("input", { f: 1, r: 0, yaw: EAST });
  await sleep(50);
}
// Stop deliberately. Measure the walk against real elapsed time, not the time
// the sleeps were supposed to take.
const held = (Date.now() - t0) / 1000;
a.send("input", { f: 0, r: 0, yaw: EAST });
await sleep(400);

const end = { x: aInB().x, z: aInB().z };
const moved = Math.hypot(end.x - start.x, end.z - start.z);

check("bob sees alice move", moved > 1, `moved ${moved.toFixed(2)}m`);
check("forward at yaw -PI/2 goes +X", end.x > start.x + 1, `x ${start.x.toFixed(2)} -> ${end.x.toFixed(2)}`);
check("no sideways drift", Math.abs(end.z - start.z) < 0.01, `dz ${(end.z - start.z).toFixed(4)}`);

// 5. speed is sane. One tick of slop either side of the held window.
const speed = moved / held;
check("speed within tolerance of 4.2 m/s", speed > 3.8 && speed < 4.6, `${speed.toFixed(2)} m/s over ${held.toFixed(2)}s`);

// 5b. a client that goes silent mid-stride must STOP, not coast into a wall.
const silentStart = { x: aInB().x, z: aInB().z };
for (let i = 0; i < 6; i++) {
  a.send("input", { f: 1, r: 0, yaw: EAST });
  await sleep(50);
}
const atSilence = { x: aInB().x, z: aInB().z };
await sleep(1200); // say nothing at all
const afterSilence = aInB();
const coasted = Math.hypot(afterSilence.x - atSilence.x, afterSilence.z - atSilence.z);
check("moved while sending", Math.hypot(atSilence.x - silentStart.x, atSilence.z - silentStart.z) > 0.5);

// Contract: input goes stale after INPUT_STALE_MS (250ms), so a silent client
// coasts at most SPEED * 0.25 = 1.05m, plus one 50ms tick of slop. It must not
// keep walking for the full 1.2s of silence (which would be ~5m).
check(
  "stops within the stale-input window when client goes silent",
  coasted < 1.3,
  `coasted ${coasted.toFixed(2)}m in 1.2s of silence (budget 1.26m)`
);

// 6. bob stayed put — no input, no movement
const bSelf = b.state.players.get(b.sessionId);
const bStart = { x: bSelf.x, z: bSelf.z };
await sleep(400);
check("idle player does not drift", Math.hypot(bSelf.x - bStart.x, bSelf.z - bStart.z) < 0.001);

// 7. SERVER AUTHORITY: a malicious client cannot set its own position.
const before = { x: aInB().x, z: aInB().z };
a.send("input", { f: 0, r: 0, yaw: EAST, x: 999, z: 999 });      // extra fields
a.send("input", { f: 99, r: 0, yaw: EAST });                     // out-of-range axis
a.send("input", { f: NaN, r: Infinity, yaw: NaN });              // garbage
await sleep(500);
const after = aInB();
check("teleport fields in input are ignored", Math.hypot(after.x - 999, after.z - 999) > 100);
check("state stays finite after NaN/Infinity input", Number.isFinite(after.x) && Number.isFinite(after.z), `x=${after.x} z=${after.z}`);

// clamped f=99 should move at most the normal speed, not 99x
const cheatDist = Math.hypot(after.x - before.x, after.z - before.z);
check("out-of-range axis is clamped", cheatDist < 4, `moved ${cheatDist.toFixed(2)}m in 0.5s`);

// 8. THE HOUSE: walls stop you.
// Alice is at z=12 in the Entrance Hall. The wall at x=6 has doors at z=0 and
// z=10 — neither is anywhere near z=12, so walking east must stop her dead at
// the wall face: x = 6 - (PLAYER_RADIUS 0.42 + WALL_THICKNESS/2 0.15) = 5.43.
const walk = async (yaw, ms) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    a.send("input", { f: 1, r: 0, yaw });
    await sleep(40);
  }
  a.send("input", { f: 0, r: 0, yaw });
  await sleep(300);
};

await walk(EAST, 4000);
const walled = aInB();
check("wall stops the player", walled.x < 5.6 && walled.x > 5.2, `x=${walled.x.toFixed(3)} (expected ~5.43)`);
check("wall did not shove them off-axis", Math.abs(walled.z - 12) < 0.2, `z=${walled.z.toFixed(3)}`);

// 9. doors let you through. Walk back west to the x=-12 wall, which HAS a door
// at z=10 — but alice is at z=12, so she should be stopped, not pass through.
await walk(Math.PI / 2, 5000); // west
const west = aInB();
check("stopped by west wall away from its door", west.x > -11.6, `x=${west.x.toFixed(3)} (expected ~-11.43)`);

// Now line up with the doorway at z=10 and go through into the Conservatory.
// Steer by actual position rather than by timing — walking for a fixed
// duration and hoping you stopped in the right place is how you end up
// testing your own arithmetic instead of the game.
const steerTo = async (tx, tz, maxMs = 8000) => {
  const until = Date.now() + maxMs;
  while (Date.now() < until) {
    const p = aInB();
    const dx = tx - p.x;
    const dz = tz - p.z;
    if (Math.hypot(dx, dz) < 0.3) break;
    // forward = (-sin yaw, -cos yaw), so aim it down (dx, dz)
    a.send("input", { f: 1, r: 0, yaw: Math.atan2(-dx, -dz) });
    await sleep(40);
  }
  a.send("input", { f: 0, r: 0, yaw: 0 });
  await sleep(250);
};

await steerTo(-11.2, 10); // stand in front of the opening
const lined = aInB();
check("can line up with a doorway", Math.abs(lined.z - 10) < 0.5, `z=${lined.z.toFixed(2)}`);

await walk(Math.PI / 2, 2500); // west, through the door
const through = aInB();
check("player fits through a doorway", through.x < -12.5, `x=${through.x.toFixed(3)} (through = past -12)`);

// 10. nobody escapes the shell, however hard they push.
for (const yaw of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) await walk(yaw, 2600);
const loose = aInB();
const inside = loose.x > -20 && loose.x < 20 && loose.z > -15 && loose.z < 15;
check("player cannot escape the house", inside, `at (${loose.x.toFixed(2)}, ${loose.z.toFixed(2)})`);

// 11. leaving removes you from everyone else's state
await a.leave();
await sleep(600);
check("bob sees alice disappear on leave", b.state.players.size === 1, `${b.state.players.size} left`);

await b.leave();
await sleep(300);

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
