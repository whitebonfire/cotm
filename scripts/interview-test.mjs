// Interview acceptance test (SOW §5) — the live-chat version. Run the server
// with fast reply pacing so it doesn't wait seconds per reply:
//   COTM_REPLY_MIN_MS=40 COTM_REPLY_MAX_MS=120 COTM_REPLY_PER_CHAR_MS=0 node dist/server/index.js
import { Client } from "colyseus.js";

const ENDPOINT = "ws://localhost:2567";
const REVEAL_MS = Number(process.env.COTM_REVEAL_MS) || 800;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass });
  console.log(`${pass ? "  PASS" : "  FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};

const TYPES = [
  "you",
  "interview_open",
  "interview_typing",
  "interview_msg",
  "interview_denied",
  "interview_begin",
  "interview_question",
  "interview_end",
  "role_pick",
  "role_wait",
  "your_role",
];

async function join(name) {
  const room = await new Client(ENDPOINT).joinOrCreate("house", { name });
  const inbox = [];
  for (const type of TYPES) room.onMessage(type, (m) => inbox.push({ type, m, at: Date.now() }));
  const waitFor = async (type, ms = 4000) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      const hit = inbox.find((e) => e.type === type);
      if (hit) return hit.m;
      await sleep(20);
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

// ---- roles: alice (host) is the detective, bob the spy
check("host gets to pick", !!(await a.waitFor("role_pick", 1500)));
check("other player waits", !!(await b.waitFor("role_wait", 1500)));
a.room.send("pick_role", { role: "detective" });
check("host becomes detective", (await a.waitFor("your_role"))?.role === "detective");
check("other becomes spy", (await b.waitFor("your_role"))?.role === "spy");
a.clearInbox();
b.clearInbox();

const keys = [...a.room.state.people.keys()];
const npc = keys.find((k) => k !== a.me.body && k !== b.me.body);
const VALID_EXPR = ["neutral", "wary", "loose", "nervous", "composed", "warm", "flat"];

// ---- the spy has no tablet
b.room.send("interview", { target: npc });
check("the spy cannot interview", !!(await b.waitFor("interview_denied", 1000)));
b.clearInbox();

// ---- can't question yourself
a.room.send("interview", { target: a.me.body });
check("can't interview your own body", !!(await a.waitFor("interview_denied", 1000)));
a.clearInbox();

// ---- open a chat with an NPC and hold a conversation
a.room.send("interview", { target: npc });
const opened = await a.waitFor("interview_open", 1500);
check("opening a chat confirms the guest", !!opened && opened.target === npc, opened?.name);

const askedAt = Date.now();
a.room.send("interview_ask", { text: "why are you here tonight?" });
const typing = await a.waitFor("interview_typing", 1000);
check("the guest shows as typing before replying", !!typing);
const noEarly = await a.waitFor("interview_msg", Math.max(0, REVEAL_MS - 300));
check("no answer before the reveal window is up", !noEarly, noEarly ? "arrived early!" : "");
const reply1 = await a.waitFor("interview_msg", REVEAL_MS + 3000);
const waited = Date.now() - askedAt;
check("a live reply comes back to the question", !!reply1 && reply1.text.length > 0, `"${reply1?.text?.slice(0, 40)}…"`);
check("the reply waits the fixed reveal window", waited >= REVEAL_MS - 250, `${waited}ms vs ${REVEAL_MS}ms window`);
check("reply carries a valid expression", VALID_EXPR.includes(reply1?.expression), reply1?.expression);
check("reply has no machine tells (no em-dash/semicolon)", !/[—–;]/.test(reply1?.text ?? ""), reply1?.text?.slice(0, 40));

// Second turn — the conversation continues.
a.clearInbox();
a.room.send("interview_ask", { text: "and what do you do for a living?" });
const reply2 = await a.waitFor("interview_msg", REVEAL_MS + 3000);
check("the conversation continues (a second reply)", !!reply2 && reply2.text.length > 0, `"${reply2?.text?.slice(0, 40)}…"`);
a.clearInbox();

// ---- question a HUMAN: they type back, live
a.room.send("interview", { target: b.me.body });
await a.waitFor("interview_open", 1500);
const begin = await b.waitFor("interview_begin", 1500);
check("the questioned human gets the chat + a persona", !!begin?.persona?.job, JSON.stringify(begin?.persona ?? {}));

a.clearInbox();
a.room.send("interview_ask", { text: "who invited you?" });
const q = await b.waitFor("interview_question", 1500);
check("the human receives the detective's question", q?.text === "who invited you?", q?.text);

const HUMAN_REPLY = "an old friend of the host, if you must know";
b.room.send("interview_answer", { text: HUMAN_REPLY });
// Held until the reveal window, just like an NPC's — the detective can't see it
// arrive early even though the human submitted at once.
const humanMsg = await a.waitFor("interview_msg", REVEAL_MS + 2000);
check("the human's typed reply reaches the detective", humanMsg?.text === HUMAN_REPLY, `"${humanMsg?.text}"`);

// ---- closing the chat releases the human
a.room.send("interview_close", {});
check("closing the chat ends it for the human", !!(await b.waitFor("interview_end", 1500)));

// ---- the disguise holds: personas/answers never enter synced state
const ALLOWED = [
  "name", "x", "y", "z", "yaw", "action",
  "skin", "hair", "hairHue", "outfitHue", "outfitVal", "age", "hat", "acc", "height",
].sort();
const fields = Object.keys(a.room.state.people.get(keys[0]).toJSON()).sort();
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
