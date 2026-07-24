// Round acceptance test (SOW §2.1): timer, guessing, win conditions. Run the
// server with a short round: COTM_ROUND_MS=4000 node dist/server/index.js
import { Client } from "colyseus.js";

const ENDPOINT = "ws://localhost:2567";
const ROUND_MS = Number(process.env.COTM_ROUND_MS) || 4000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass });
  console.log(`${pass ? "  PASS" : "  FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};

const TYPES = ["you", "role_pick", "role_wait", "your_role", "round_start", "round_over", "guess_wrong", "guess_denied"];

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
  return { room, inbox, waitFor, clear: () => (inbox.length = 0) };
}

/** A fresh, isolated room each time: the detective creates it, the spy joins it. */
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
  // The round_start message beats the schema patch that carries phase/seconds;
  // wait for the synced state to catch up before the caller reads it.
  const deadline = Date.now() + 1000;
  while (det.room.state.round.phase !== 1 && Date.now() < deadline) await sleep(20);
  return { det, spy };
}

function npcBody(det, spy) {
  return [...det.room.state.people.keys()].find((k) => k !== det.me.body && k !== spy.me.body);
}

// ---- 1. the round starts, the clock is set and ticking
{
  const { det, spy } = await newGame();
  check("the round starts when both roles are assigned", det.room.state.round.phase === 1);
  const s0 = det.room.state.round.secondsLeft;
  check("the clock is set", s0 > 0 && s0 <= Math.ceil(ROUND_MS / 1000), `${s0}s`);
  check("both players get two guesses", det.room.state.round.guessesLeft === 2);
  await sleep(1200);
  check("the clock counts down", det.room.state.round.secondsLeft < s0, `${s0} -> ${det.room.state.round.secondsLeft}`);
  // the spy can't accuse
  spy.room.send("guess", { target: npcBody(det, spy) });
  check("the spy can't accuse", !!(await spy.waitFor("guess_denied", 1000)));
  // can't accuse yourself
  det.room.send("guess", { target: det.me.body });
  check("can't accuse your own body", !!(await det.waitFor("guess_denied", 1000)));
  await det.room.leave();
  await spy.room.leave();
  await sleep(400);
}

// ---- 2. a correct accusation: the detective wins
{
  const { det, spy } = await newGame();
  det.room.send("guess", { target: spy.me.body }); // the spy's body
  const over = await det.waitFor("round_over", 2000);
  check("accusing the spy ends the round", !!over, over?.reason);
  check("a correct accusation is a DETECTIVE win", over?.outcome === "detective", over?.outcome);
  check("the spy is revealed only at the end", over?.spyBody === spy.me.body, over?.spyName);
  const spyOver = await spy.waitFor("round_over", 1000);
  check("the spy is told the round is over too", !!spyOver);
  await det.room.leave();
  await spy.room.leave();
  await sleep(400);
}

// ---- 3. two wrong accusations: the spy wins
{
  const { det, spy } = await newGame();
  det.room.send("guess", { target: npcBody(det, spy) });
  const w1 = await det.waitFor("guess_wrong", 1500);
  check("a wrong accusation is reported", !!w1 && w1.guessesLeft === 1, `left ${w1?.guessesLeft}`);
  det.clear();
  // a different innocent
  const others = [...det.room.state.people.keys()].filter((k) => k !== det.me.body && k !== spy.me.body);
  det.room.send("guess", { target: others[1] });
  const over = await det.waitFor("round_over", 2000);
  check("two wrong accusations is a SPY win", over?.outcome === "spy", over?.outcome);
  await det.room.leave();
  await spy.room.leave();
  await sleep(400);
}

// ---- 4. the clock runs out: the detective wins
{
  const { det } = await newGame();
  const over = await det.waitFor("round_over", ROUND_MS + 2000);
  check("runout ends the round", !!over, over?.reason);
  check("runout is a DETECTIVE win (spy didn't finish in time)", over?.outcome === "detective", over?.outcome);
  await det.room.leave();
  await sleep(400);
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
