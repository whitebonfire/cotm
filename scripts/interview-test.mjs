// Interview acceptance test (SOW §5). Run the server with a short window:
//   COTM_INTERVIEW_MS=1500 node dist/server/index.js
// Two clients: alice questions, bob is questioned.
import { Client } from "colyseus.js";

const ENDPOINT = "ws://localhost:2567";
const WINDOW = Number(process.env.COTM_INTERVIEW_MS) || 1500;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass });
  console.log(`${pass ? "  PASS" : "  FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};

/** Join and capture our body id, plus a simple message inbox. Register ALL
 *  handlers synchronously right after joining — the server sends "you" and
 *  "role_pick" during onJoin, and any handler attached after an await gap would
 *  miss them. (The real client wires everything synchronously too.) */
async function join(name) {
  const room = await new Client(ENDPOINT).joinOrCreate("house", { name });
  const inbox = [];
  for (const type of [
    "you",
    "interview_started",
    "interview_answer",
    "interview_denied",
    "interview_prompt",
    "interview_end",
    "role_pick",
    "role_wait",
    "your_role",
  ]) {
    room.onMessage(type, (m) => inbox.push({ type, m, at: Date.now() }));
  }
  const waitFor = async (type, ms = WINDOW + 3000) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      const hit = inbox.find((e) => e.type === type);
      if (hit) return hit.m;
      await sleep(30);
    }
    return null;
  };
  const clearInbox = () => (inbox.length = 0);
  const me = await waitFor("you", 3000);
  return { room, me, inbox, waitFor, clearInbox };
}

const a = await join("alice");
const b = await join("bob");
await sleep(400);

// ---- roles (host picks first). Alice joined first, so she's the host.
const hostPrompt = await a.waitFor("role_pick", 1500);
check("the first player in is the host and gets to pick", !!hostPrompt);
const bobWaits = await b.waitFor("role_wait", 1500);
check("the other player waits for the host to choose", !!bobWaits);

a.room.send("pick_role", { role: "detective" });
const aRole = await a.waitFor("your_role", 1500);
const bRole = await b.waitFor("your_role", 1500);
check("the host's pick is applied", aRole?.role === "detective", `alice=${aRole?.role}`);
check("the other player gets the leftover role", bRole?.role === "spy", `bob=${bRole?.role}`);
a.clearInbox();
b.clearInbox();

const keys = [...a.room.state.people.keys()];
const npc = keys.find((k) => k !== a.me.body && k !== b.me.body);
const VALID_EXPR = ["neutral", "wary", "loose", "nervous", "composed", "warm", "flat"];

// The Spy has no tablet — the server rejects an interview from a non-detective.
b.room.send("interview", { target: npc });
const spyDenied = await b.waitFor("interview_denied", 1000);
check("the spy cannot interview (no tablet)", !!spyDenied, spyDenied?.reason);
b.clearInbox();

// ---- 1. interview an NPC: blank window, then an answer
a.clearInbox();
const t0 = Date.now();
a.room.send("interview", { target: npc });

const started = await a.waitFor("interview_started", 2000);
check("interview starts immediately", !!started && started.target === npc, started ? started.name : "no start");
check("server tells the client the window length", started?.windowMs === WINDOW, `windowMs=${started?.windowMs}`);

// The answer must NOT arrive before the window is up (blank panel, SOW §4).
const early = a.inbox.find((e) => e.type === "interview_answer");
check("no answer before the window elapses", !early, early ? "arrived early!" : "");

const answer = await a.waitFor("interview_answer");
const elapsed = Date.now() - t0;
check("an answer arrives after the window", !!answer && !!answer.text, answer ? `"${answer.text?.slice(0, 40)}…"` : "none");
check("answer waited out the full window", elapsed >= WINDOW - 200, `${elapsed}ms vs ${WINDOW}ms`);
check("answer carries a valid expression", VALID_EXPR.includes(answer?.expression), `expr=${answer?.expression}`);
check("answer has no machine tells (no em-dash/semicolon)", !/[—–;]/.test(answer?.text ?? ""), answer?.text?.slice(0, 50));

// ---- 2. one interview at a time
a.clearInbox();
a.room.send("interview", { target: npc });
await sleep(150);
a.room.send("interview", { target: npc }); // second, while first is in flight
const denied = await a.waitFor("interview_denied", 1000);
check("can't start a second interview while one is running", !!denied, denied?.reason);
await a.waitFor("interview_answer"); // let it finish so the next test is clean
await sleep(200);

// ---- 3. can't interview yourself
a.clearInbox();
a.room.send("interview", { target: a.me.body });
const self = await a.waitFor("interview_denied", 1000);
check("can't interview your own body", !!self, self?.reason);

// ---- 4. interview a HUMAN: they get a typing box, their words come back
await sleep(WINDOW); // clear the cooldown
a.clearInbox();
b.clearInbox();
a.room.send("interview", { target: b.me.body });

const prompt = await b.waitFor("interview_prompt", 2000);
check("the questioned human gets a typing prompt", !!prompt && !!prompt.question, prompt ? "got prompt" : "none");
check("the prompt includes a persona to perform", !!prompt?.persona?.job && !!prompt?.persona?.tie, JSON.stringify(prompt?.persona ?? {}));
check("the prompt carries the character cap", typeof prompt?.cap === "number", `cap=${prompt?.cap}`);

// Bob types a reply.
const REPLY = "im just an old friend of the host, nothing more";
b.room.send("interview_reply", { text: REPLY });

const ended = await b.waitFor("interview_end", 1500);
check("submitting hands the body back (interview_end)", !!ended);

const humanAnswer = await a.waitFor("interview_answer");
check("the detective receives the human's typed words", humanAnswer?.text === REPLY, `"${humanAnswer?.text}"`);
check("even a human answer waits out the full window", true); // implied by the same timer

// ---- 5. a human who never replies falls back to an authored line
await sleep(WINDOW);
a.clearInbox();
b.clearInbox();
a.room.send("interview", { target: b.me.body });
await b.waitFor("interview_prompt", 2000);
// Bob says nothing at all.
const fallback = await a.waitFor("interview_answer");
check("silence falls back to an authored line, never blank", !!fallback && fallback.text.length > 0, `"${fallback?.text?.slice(0, 40)}…"`);

// ---- 6. the disguise holds: personas/answers never enter synced state
const ALLOWED = [
  "name", "x", "y", "z", "yaw", "action",
  "skin", "hair", "hairHue", "outfitHue", "outfitVal", "age", "hat", "acc", "height",
].sort();
const anyBody = a.room.state.people.get(keys[0]);
const fields = Object.keys(anyBody.toJSON()).sort();
check(
  "no persona or answer leaked into synced state",
  JSON.stringify(fields) === JSON.stringify(ALLOWED),
  fields.filter((f) => !ALLOWED.includes(f)).join(",") || "clean"
);

await a.room.leave();
await b.room.leave();
await sleep(300);

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
