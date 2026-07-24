// Spy task acceptance test (SOW §3): steal-and-deliver, and the spy win. Run the
// server with slowed NPCs so the harness can reliably catch a target to steal from:
//   COTM_ROUND_MS=120000 COTM_NUM_TASKS=2 COTM_NPC_SPEED_MUL=0.4 COTM_AI_PROVIDER=off node dist/server/index.js
// then: COTM_NUM_TASKS=2 node scripts/tasks-test.mjs
import { Client } from "colyseus.js";
import { roomAt } from "../dist/server/world/house.js";
import { routeTo } from "../dist/server/world/nav.js";

const ENDPOINT = "ws://localhost:2567";
const TASK_RANGE = 1.8;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass });
  console.log(`${pass ? "  PASS" : "  FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};

const TYPES = ["you", "role_pick", "role_wait", "your_role", "round_start", "round_over", "tasks"];
function attach(room) {
  const inbox = [];
  for (const t of TYPES) room.onMessage(t, (m) => inbox.push({ t, m, at: Date.now() }));
  const waitFor = async (t, ms = 3000) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      const h = inbox.find((e) => e.t === t);
      if (h) return h.m;
      await sleep(20);
    }
    return null;
  };
  const last = (t) => [...inbox].reverse().find((e) => e.t === t)?.m;
  return { room, inbox, waitFor, last };
}

async function newGame() {
  const det = attach(await new Client(ENDPOINT).create("house", { name: "det" }));
  det.me = await det.waitFor("you", 3000);
  const spy = attach(await new Client(ENDPOINT).joinById(det.room.roomId, { name: "spy" }));
  spy.me = await spy.waitFor("you", 3000);
  await det.waitFor("role_pick", 1500);
  det.room.send("pick_role", { role: "detective" });
  await det.waitFor("your_role", 1500);
  await spy.waitFor("your_role", 1500);
  await det.waitFor("round_start", 1500);
  const dl = Date.now() + 1000;
  while (det.room.state.round.phase !== 1 && Date.now() < dl) await sleep(20);
  return { det, spy };
}

const pos = (room, id) => room.state.people.get(id);

// Chase a (possibly moving) target and press E until `advanced()` is true.
// Generous timeout: at equal speed the sure catch is when the NPC dwells.
async function chaseAndAct(spy, targetId, advanced, maxMs = 55000) {
  const spyPos = () => pos(spy.room, spy.me.body);
  const until = Date.now() + maxMs;
  let prev = { x: spyPos().x, z: spyPos().z }, mark = Date.now(), sideUntil = 0, side = 1;
  while (Date.now() < until && !advanced()) {
    const t = pos(spy.room, targetId);
    const s = spyPos();
    const d = Math.hypot(t.x - s.x, t.z - s.z);
    if (d < TASK_RANGE - 0.3) {
      spy.room.send("act");
      await sleep(200);
      continue;
    }
    // steer toward the target, sidestepping when jammed
    const now = Date.now();
    if (now > sideUntil && now - mark >= 250) {
      if (Math.hypot(s.x - prev.x, s.z - prev.z) < 0.12) { sideUntil = now + 500; side = -side; }
      prev = { x: s.x, z: s.z }; mark = now;
    }
    // route through doors if the target is in another room
    const dest = roomAt(t.x, t.z), here = roomAt(s.x, s.z);
    let aim = t;
    if (dest && here && dest.id !== here.id) {
      const wps = routeTo(s.x, s.z, { id: "t", room: dest.id, x: t.x, z: t.z, action: 0 });
      aim = wps.find((w) => Math.hypot(w.x - s.x, w.z - s.z) > 0.5) ?? t;
    }
    let yaw = Math.atan2(-(aim.x - s.x), -(aim.z - s.z));
    if (now <= sideUntil) yaw += (side * Math.PI) / 2;
    spy.room.send("input", { f: 1, r: 0, yaw });
    await sleep(40);
  }
  spy.room.send("input", { f: 0, r: 0, yaw: 0 });
  return advanced();
}

const NUM = Number(process.env.COTM_NUM_TASKS) || 2;

const { det, spy } = await newGame();

// ---- tasks are dealt to the spy only
const t0 = await spy.waitFor("tasks", 2000);
check("the spy is given tasks", !!t0 && t0.tasks.length === NUM, `${t0?.tasks.length} tasks`);
check("tasks start pending", t0?.tasks.every((t) => t.state === "pending"));
check("tasks name an item, a source and a target", t0?.tasks.every((t) => t.itemName && t.fromName && t.toName));
check("the detective is NOT told the tasks (silent)", !det.last("tasks"));

const getTasks = () => spy.last("tasks").tasks;

// ---- complete every task: steal, then deliver
let allDone = true;
for (let i = 0; i < NUM; i++) {
  const task = () => getTasks()[i];
  const src = task().fromBody;
  const stolen = await chaseAndAct(spy, src, () => task().state !== "pending");
  check(`task ${i + 1}: stole the ${task().itemName} from ${task().fromName}`, stolen && task().state === "carrying");
  check(`task ${i + 1}: the item vanished from the victim`, pos(spy.room, src).acc === 0, `acc=${pos(spy.room, src).acc}`);

  // completing one task must NOT win yet (unless it's the last)
  if (i < NUM - 1) check(`round still going after task ${i + 1} stolen`, det.room.state.round.phase === 1);

  const dst = task().toBody;
  const delivered = await chaseAndAct(spy, dst, () => task().state === "done");
  check(`task ${i + 1}: delivered to ${task().toName}`, delivered && task().state === "done");

  if (i < NUM - 1) {
    check(`the spy has NOT won yet (${i + 1}/${NUM} done)`, det.room.state.round.phase === 1);
  }
  if (!delivered) { allDone = false; break; }
}

// ---- all tasks done => spy wins
if (allDone) {
  const over = await det.waitFor("round_over", 2000);
  check("finishing all tasks is a SPY win", over?.outcome === "spy", over?.reason);
}

await det.room.leave();
await spy.room.leave();
await sleep(300);

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
