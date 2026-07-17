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

// yaw 0 => forward is -Z
const t0 = Date.now();
for (let i = 0; i < 30; i++) {
  a.send("input", { f: 1, r: 0, yaw: 0 });
  await sleep(50);
}
// Stop deliberately. Measure the walk against real elapsed time, not the time
// the sleeps were supposed to take.
const held = (Date.now() - t0) / 1000;
a.send("input", { f: 0, r: 0, yaw: 0 });
await sleep(400);

const end = { x: aInB().x, z: aInB().z };
const moved = Math.hypot(end.x - start.x, end.z - start.z);

check("bob sees alice move", moved > 1, `moved ${moved.toFixed(2)}m`);
check("forward at yaw 0 goes -Z", end.z < start.z - 1, `z ${start.z.toFixed(2)} -> ${end.z.toFixed(2)}`);
check("no sideways drift", Math.abs(end.x - start.x) < 0.01, `dx ${(end.x - start.x).toFixed(4)}`);

// 5. speed is sane. One tick of slop either side of the held window.
const speed = moved / held;
check("speed within tolerance of 4.2 m/s", speed > 3.8 && speed < 4.6, `${speed.toFixed(2)} m/s over ${held.toFixed(2)}s`);

// 5b. a client that goes silent mid-stride must STOP, not coast into a wall.
const silentStart = { x: aInB().x, z: aInB().z };
for (let i = 0; i < 6; i++) {
  a.send("input", { f: 1, r: 0, yaw: 0 });
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
a.send("input", { f: 0, r: 0, yaw: 0, x: 999, z: 999 });        // extra fields
a.send("input", { f: 99, r: 0, yaw: 0 });                        // out-of-range axis
a.send("input", { f: NaN, r: Infinity, yaw: NaN });               // garbage
await sleep(500);
const after = aInB();
check("teleport fields in input are ignored", Math.hypot(after.x - 999, after.z - 999) > 100);
check("state stays finite after NaN/Infinity input", Number.isFinite(after.x) && Number.isFinite(after.z), `x=${after.x} z=${after.z}`);

// clamped f=99 should move at most the normal speed, not 99x
const cheatDist = Math.hypot(after.x - before.x, after.z - before.z);
check("out-of-range axis is clamped", cheatDist < 4, `moved ${cheatDist.toFixed(2)}m in 0.5s`);

// 8. bounds hold
for (let i = 0; i < 140; i++) {
  a.send("input", { f: 1, r: 0, yaw: 0 });
  await sleep(20);
}
await sleep(400);
const walled = aInB();
check("player cannot leave the room", walled.z >= -19.001, `z=${walled.z.toFixed(3)}`);

// 9. leaving removes you from everyone else's state
await a.leave();
await sleep(600);
check("bob sees alice disappear on leave", b.state.players.size === 1, `${b.state.players.size} left`);

await b.leave();
await sleep(300);

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
