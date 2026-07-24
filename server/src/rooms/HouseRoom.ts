import { Room, Client } from "@colyseus/core";
import { HouseState, Person } from "../schema/GameState.js";
import { Action, HOUSE, PLAYER_RADIUS, SPEED, resolveCollisions, roomAt } from "../world/house.js";
import { ANCHORS } from "../world/nav.js";
import { NpcBrain, randomLook } from "../ai/npc.js";
import { drawNames } from "../ai/names.js";
import {
  assignVoices,
  generatePersona,
  authoredReply,
  expressionFor,
  scrub,
  ANSWER_CAP,
  HOSTS,
  type Persona,
} from "../ai/persona.js";
import { liveReply, type ChatTurn } from "../ai/llm.js";

/**
 * The reveal delay (SOW §5.2/§5.3). After a question, EVERY answer is held back
 * and revealed exactly this long later — whether the NPC generated it in half a
 * second or the human spent fifteen seconds typing. Since the wait from question
 * to answer is identical for both, answer SPEED tells you nothing; the Detective
 * has to read the writing itself. The delay absorbs generation time and the
 * human's typing time alike. (Explicit env parse so 0 is honoured, for tests.)
 */
const REVEAL_DELAY_MS =
  process.env.COTM_REVEAL_MS !== undefined ? Number(process.env.COTM_REVEAL_MS) : 50000;

/** Auto-close an interview the Detective has gone quiet on, so a human target
 *  isn't pinned in the chat (and on autopilot) forever. */
const INTERVIEW_IDLE_MS = REVEAL_DELAY_MS + 30000;

interface Interview {
  detective: string; // sessionId asking
  target: string; // bodyId being questioned
  humanTarget: string | null; // sessionId if the target is a person
  history: ChatTurn[]; // the conversation so far
  busy: boolean; // a question is out; its answer hasn't been revealed yet
  /** When the current question was asked — the reveal fires at askedAt + delay. */
  askedAt: number;
  /** A human target's submitted reply, held until the reveal fires. */
  pendingHuman: string | null;
  lastActivity: number;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface InputMessage {
  /** Forward axis, -1..1 */
  f: number;
  /** Strafe axis, -1..1 */
  r: number;
  /** Camera yaw in radians, which is what movement is relative to. */
  yaw: number;
  /** Detective looking through the magnifying glass — first person, slower. */
  mag?: boolean;
}

interface StoredInput extends InputMessage {
  at: number;
}

const TICK_MS = 1000 / 20;

/** Walking speed while the Detective is peering through the magnifying glass —
 *  the cost of looking closely is that you can't move quickly (SOW §4.2). */
const MAGNIFY_SPEED = 2.1;

/** The Spy's `hack`: cut the lights for everyone but the Spy (SOW §4.3). */
const HACK_DURATION_MS = 10000;
const HACK_COOLDOWN_MS = 60000;

/** The Detective's `hide`: blend in as an ordinary guest, so the Spy's marker
 *  on you goes dark and they lose track of who to snap/avoid (SOW §4.2). */
const HIDE_DURATION_MS = 20000;
const HIDE_COOLDOWN_MS = 60000;

/** The Detective's `inspection`: seal the room you stand in. The Spy can't
 *  steal or deliver in a sealed room until it lifts (SOW §4.2). */
const SEAL_DURATION_MS = 30000;
const SEAL_COOLDOWN_MS = 120000;

/** The Spy's `impersonate`: move with a perfect NPC gait — while it's up, an
 *  idle Spy fidgets like a guest instead of standing frozen (SOW §4.3). */
const IMPERSONATE_DURATION_MS = 20000;
const IMPERSONATE_COOLDOWN_MS = 50000;

/** The Spy's `snap`: photograph the Detective for +1 minute on the clock
 *  (SOW §4.3, §2.1). You must be close to the one person hunting you. The SOW
 *  lists no cooldown; a short one is kept purely as a balance guard so a Spy
 *  can't stand on the Detective and mint minutes (SOW §2.2). */
const SNAP_RANGE = 3.0;
const SNAP_BONUS_MS = 60000;
const SNAP_COOLDOWN_MS = 20000;

/** The round clock (SOW §2, §4). Ten minutes; env-tunable for tests. */
const ROUND_MS = process.env.COTM_ROUND_MS !== undefined ? Number(process.env.COTM_ROUND_MS) : 10 * 60 * 1000;
/** The Detective gets two accusations (SOW §2.1). */
const MAX_GUESSES = 2;

/** How many steal-and-deliver tasks the Spy must finish to win (SOW §3). */
const NUM_TASKS = process.env.COTM_NUM_TASKS !== undefined ? Number(process.env.COTM_NUM_TASKS) : 3;
/** How close the Spy must be to a guest to steal from / deliver to them. */
const TASK_RANGE = 1.8;

const ITEM_NAMES = ["", "purse", "necklace", "monocle", "cane", "brooch", "pocket-watch"];

interface Task {
  item: number; // accessory id (1-6)
  fromBody: string; // steal it from here
  toBody: string; // deliver it to here
  state: "pending" | "carrying" | "done";
}

/** Bodies at the party. The Spy will be one of these, not a thirteenth guest. */
export const PARTY_SIZE = 12;

/**
 * Inputs expire. Clients send at 20Hz, so anything older than this means the
 * client went quiet — a lag spike, a backgrounded tab, a closing laptop.
 * Without expiry the server would keep applying the last input forever and
 * walk them into a wall while they weren't even connected.
 */
const INPUT_STALE_MS = 250;

/** How close you must stand to an anchor to join in with what happens there. */
const ACT_RANGE = 1.6;

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

let bodyCounter = 0;
/**
 * Opaque body IDs. Deliberately uniform and meaningless: if human bodies were
 * keyed by session ID and NPCs by "npc-4", the disguise would be readable
 * straight off the wire.
 */
const newBodyId = () => `b${(bodyCounter++).toString(36)}${Math.random().toString(36).slice(2, 8)}`;

export class HouseRoom extends Room<HouseState> {
  maxClients = 8;

  private inputs = new Map<string, StoredInput>();

  /** bodyId -> brain. A body with a suspended brain is being driven by a human. */
  private brains = new Map<string, NpcBrain>();

  /** Anchor claims for this party only. */
  private claimed = new Set<string>();

  // ---- PRIVATE. These two maps are the disguise. They are server memory and
  // must never become Schema fields, or the Detective's client can read who is
  // human straight out of the state. See SOW section 7.1.
  private bodyOf = new Map<string, string>(); // sessionId -> bodyId
  private driverOf = new Map<string, string>(); // bodyId -> sessionId

  // ---- roles. Also the disguise: a role is sent ONLY to the player it belongs
  // to (see grantRole), never into Schema — the Detective must never be able to
  // read who the Spy is. The host picks first; the next player takes the other.
  private roles = new Map<string, "detective" | "spy">(); // sessionId -> role
  private hostSession: string | null = null;

  /** sessionId -> the action they're holding while stood at an anchor. */
  private held = new Map<string, number>();

  // ---- interviews (SOW §5). Personas are server memory only — never Schema.
  private personas = new Map<string, Persona>(); // bodyId -> who they are
  private host = HOSTS[0];
  /** One open chat per Detective. */
  private interviews = new Map<string, Interview>(); // detective sessionId -> interview
  /** Bodies currently on autopilot because their human is being questioned. */
  private autopilot = new Set<string>(); // bodyId

  // ---- abilities: per-player cooldowns, keyed by ability id -> ready-at time.
  private cooldowns = new Map<string, Map<string, number>>();

  // ---- the round
  private roundEndsAt = 0;
  /** The Spy's steal-and-deliver tasks — server memory, sent only to the Spy. */
  private tasks: Task[] = [];

  // ---- ability windows (server memory; there's one Detective and one Spy).
  /** While < now, the Detective is visible to the Spy's marker; while > now,
   *  they're hidden (the `hide` ability is up). */
  private hideUntil = 0;
  /** The Spy's `impersonate` window — idle ambient plays while > now. */
  private impersonateUntil = 0;
  /** The active `inspection` seal, or null. `room` is a world/house room id. */
  private seal: { room: string; until: number } | null = null;

  onCreate() {
    this.setState(new HouseState());
    this.setPatchRate(50);

    this.populate();

    this.onMessage("input", (client: Client, msg: InputMessage) => {
      // Never trust the wire: clamp the axes and drop anything non-finite.
      this.inputs.set(client.sessionId, {
        f: clamp(num(msg?.f), -1, 1),
        r: clamp(num(msg?.r), -1, 1),
        yaw: num(msg?.yaw),
        // Magnifying glass is Detective-only; ignore the flag from anyone else.
        mag: !!msg?.mag && this.roles.get(client.sessionId) === "detective",
        at: Date.now(),
      });
    });

    // Triggered abilities with cooldowns (SOW §4.3). Magnify is a held state
    // (in `input`), not one of these.
    this.onMessage("ability", (client: Client, msg: { id?: string }) => {
      this.useAbility(client, typeof msg?.id === "string" ? msg.id : "");
    });

    // The Detective's accusation (SOW §2.1).
    this.onMessage("guess", (client: Client, msg: { target?: string }) => {
      this.makeGuess(client, typeof msg?.target === "string" ? msg.target : "");
    });

    // Join in with whatever happens at the nearest anchor — read the book,
    // take a drink, look out of the window. This is the Spy's camouflage, so
    // it has to be exactly the same set of actions the NPCs perform.
    this.onMessage("act", (client: Client) => {
      const body = this.bodyOf.get(client.sessionId);
      if (!body) return;
      const person = this.state.people.get(body);
      if (!person) return;

      // For the Spy, E first tries a task (steal/deliver a nearby item); only if
      // there's nothing to do does it fall through to the camouflage join-in.
      if (this.trySpyTask(client.sessionId)) return;

      if (this.held.has(client.sessionId)) {
        this.held.delete(client.sessionId);
        person.action = Action.IDLE;
        return;
      }

      const anchor = this.nearestAnchor(person.x, person.z);
      if (!anchor) return;

      // Snap onto the spot itself, not wherever you happened to press E. The
      // anchor is exactly where an NPC would stand, which for a seat means ON
      // the cushion — without this you sit in mid-air a metre off the couch.
      // The client predicts to the same place, so it glides you onto the seat.
      person.x = anchor.x;
      person.z = anchor.z;
      this.held.set(client.sessionId, anchor.action);
      person.action = anchor.action;
      if (anchor.faceX !== undefined && anchor.faceZ !== undefined) {
        person.yaw = Math.atan2(anchor.faceX - anchor.x, anchor.faceZ - anchor.z);
      }
    });

    // ---- roles: only the host picks, and only once.
    this.onMessage("pick_role", (client: Client, msg: { role?: string }) => {
      if (client.sessionId !== this.hostSession) return; // host picks first
      if (this.roles.has(client.sessionId)) return; // already chose
      const role = msg?.role === "spy" ? "spy" : "detective";
      this.grantRole(client.sessionId, role);
      // Hand the leftover role to whoever's been waiting.
      const other = role === "detective" ? "spy" : "detective";
      const waiting = this.clients.find(
        (c) => c.sessionId !== this.hostSession && !this.roles.has(c.sessionId)
      );
      if (waiting) this.grantRole(waiting.sessionId, other);
    });

    // ---- interviews (SOW §5): a live chat the Detective drives by typing.
    this.onMessage("interview", (client: Client, msg: { target?: string }) => {
      this.openInterview(client, typeof msg?.target === "string" ? msg.target : "");
    });
    this.onMessage("interview_ask", (client: Client, msg: { text?: string }) => {
      this.askQuestion(client, typeof msg?.text === "string" ? msg.text : "");
    });
    this.onMessage("interview_answer", (client: Client, msg: { text?: string }) => {
      this.humanReply(client, typeof msg?.text === "string" ? msg.text : "");
    });
    this.onMessage("interview_close", (client: Client) => {
      this.closeInterview(client.sessionId);
    });

    this.setSimulationInterval((deltaMs) => this.tick(deltaMs / 1000), TICK_MS);
  }

  // ---------------------------------------------------------------- interviews
  //
  // A live chat: the Detective opens a conversation with a guest, then types
  // questions. An NPC answers live (llm.ts), paced to a human-like delay so
  // speed can't out it; a human target types their own replies.

  private openInterview(client: Client, target: string) {
    const asker = this.bodyOf.get(client.sessionId);
    if (!asker) return;

    // The tablet — and interviewing — belong to the Detective only.
    if (this.roles.get(client.sessionId) !== "detective") {
      client.send("interview_denied", { reason: "Only the detective can question guests." });
      return;
    }

    const person = this.state.people.get(target);
    if (!person || target === asker) {
      client.send("interview_denied", { reason: "You can't question them." });
      return;
    }

    // Opening a new chat closes any current one.
    this.closeInterview(client.sessionId);

    const interview: Interview = {
      detective: client.sessionId,
      target,
      humanTarget: this.driverOf.get(target) ?? null,
      history: [],
      busy: false,
      askedAt: 0,
      pendingHuman: null,
      lastActivity: Date.now(),
    };
    this.interviews.set(client.sessionId, interview);
    client.send("interview_open", { target, name: person.name });

    if (interview.humanTarget) {
      // Being questioned takes over the human's screen and puts their body on
      // autopilot so it keeps milling about instead of freezing (SOW §2.3).
      this.autopilot.add(target);
      this.brains.get(target)?.resume();
      const persona = this.personas.get(target)!;
      const humanClient = this.clients.find((c) => c.sessionId === interview.humanTarget);
      humanClient?.send("interview_begin", {
        cap: ANSWER_CAP,
        persona: { job: persona.job, tie: persona.tie, reason: persona.reason, host: this.host },
      });
    }
  }

  private askQuestion(client: Client, text: string) {
    const interview = this.interviews.get(client.sessionId);
    if (!interview || interview.busy) return; // one question out at a time
    const q = scrub(text).slice(0, ANSWER_CAP);
    if (!q) return;

    interview.history.push({ role: "detective", text: q });
    interview.askedAt = Date.now();
    interview.lastActivity = interview.askedAt;
    interview.busy = true;
    interview.pendingHuman = null;
    // The Detective waits the full reveal window — this is the delay that hides
    // whether the answer came from the AI in a blink or a human typing hard.
    client.send("interview_typing", { revealMs: REVEAL_DELAY_MS });

    if (interview.humanTarget) {
      // Relay to the human. They type within the window; whatever they've got at
      // reveal time is what the Detective sees.
      const humanClient = this.clients.find((c) => c.sessionId === interview.humanTarget);
      humanClient?.send("interview_question", { text: q, windowMs: REVEAL_DELAY_MS });
      this.clock.setTimeout(() => this.reveal(interview), REVEAL_DELAY_MS);
    } else {
      this.answerAsNpc(interview);
    }
  }

  /** An NPC answers live; the reply is held until the reveal window is up, so it
   *  lands at the same time a human's answer would (SOW §5.2). */
  private async answerAsNpc(interview: Interview) {
    const persona = this.personas.get(interview.target);
    const person = this.state.people.get(interview.target);
    if (!persona || !person) return;

    const q = interview.history[interview.history.length - 1]?.text ?? "";
    const live = await liveReply(persona, this.host, interview.history);
    // Fallback gets the history too, so it won't parrot its own last line.
    const text = live ?? authoredReply(person.name, persona, this.host, q, interview.history);

    if (this.interviews.get(interview.detective) !== interview || !interview.busy) return;

    // Wait out the rest of the reveal window (generation time is absorbed here).
    await sleep(Math.max(0, REVEAL_DELAY_MS - (Date.now() - interview.askedAt)));
    if (this.interviews.get(interview.detective) !== interview || !interview.busy) return;

    this.deliverGuestReply(interview, text, expressionFor(persona.voice));
  }

  /** A human's reply is stored, not shown — the reveal timer delivers it so it
   *  appears on the same clock as an NPC's, hiding how long they took to type. */
  private humanReply(client: Client, text: string) {
    for (const interview of this.interviews.values()) {
      if (interview.humanTarget === client.sessionId && interview.busy) {
        interview.pendingHuman = scrub(text).slice(0, ANSWER_CAP);
        return;
      }
    }
  }

  /** Fires at askedAt + reveal window for a human target: shows whatever they
   *  submitted, or an authored line if the clock beat them. */
  private reveal(interview: Interview) {
    if (this.interviews.get(interview.detective) !== interview || !interview.busy) return;
    const persona = this.personas.get(interview.target);
    const person = this.state.people.get(interview.target);
    const q = interview.history[interview.history.length - 1]?.text ?? "";
    const text =
      interview.pendingHuman ??
      (person && persona ? authoredReply(person.name, persona, this.host, q, interview.history) : "…");
    this.deliverGuestReply(interview, text, persona ? expressionFor(persona.voice) : "neutral");
  }

  private deliverGuestReply(interview: Interview, text: string, expression: string) {
    interview.history.push({ role: "guest", text });
    interview.busy = false;
    interview.pendingHuman = null;
    interview.lastActivity = Date.now();
    const detective = this.clients.find((c) => c.sessionId === interview.detective);
    const person = this.state.people.get(interview.target);
    detective?.send("interview_msg", {
      from: "guest",
      name: person?.name ?? "",
      text,
      expression,
    });
  }

  private closeInterview(detectiveSession: string) {
    const interview = this.interviews.get(detectiveSession);
    if (!interview) return;
    this.interviews.delete(detectiveSession);
    this.endAutopilot(interview.target);
    if (interview.humanTarget) {
      const humanClient = this.clients.find((c) => c.sessionId === interview.humanTarget);
      humanClient?.send("interview_end", {});
    }
  }

  private endAutopilot(bodyId: string) {
    if (!this.autopilot.has(bodyId)) return;
    this.autopilot.delete(bodyId);
    // Stop the AI and hand control back to the human standing at this body.
    this.brains.get(bodyId)?.suspend();
    const person = this.state.people.get(bodyId);
    if (person && person.action === Action.WALK) person.action = Action.IDLE;
  }

  // ---------------------------------------------------------------- abilities

  private cooldownReady(session: string, id: string): number {
    return this.cooldowns.get(session)?.get(id) ?? 0;
  }

  private setCooldown(session: string, id: string, ms: number) {
    let m = this.cooldowns.get(session);
    if (!m) this.cooldowns.set(session, (m = new Map()));
    m.set(id, Date.now() + ms);
  }

  private useAbility(client: Client, id: string) {
    const session = client.sessionId;
    const role = this.roles.get(session);
    const now = Date.now();

    if (id === "hack") {
      if (role !== "spy") {
        client.send("ability_denied", { id, reason: "Only the spy can do that." });
        return;
      }
      const left = this.cooldownReady(session, id) - now;
      if (left > 0) {
        client.send("ability_denied", { id, reason: `hack recharging (${Math.ceil(left / 1000)}s)` });
        return;
      }
      this.setCooldown(session, id, HACK_COOLDOWN_MS);
      // Cut the lights for everyone BUT the hacker — only the Spy can see
      // (SOW §4.3). NPCs have no client, so in practice this darkens the
      // Detective's screen while the Spy moves freely.
      for (const c of this.clients) {
        if (c.sessionId === session) continue;
        c.send("lights", { off: true, ms: HACK_DURATION_MS });
      }
      client.send("ability_used", { id, cooldownMs: HACK_COOLDOWN_MS, durationMs: HACK_DURATION_MS });
      return;
    }

    if (id === "hide") {
      if (role !== "detective") {
        client.send("ability_denied", { id, reason: "Only the detective can do that." });
        return;
      }
      const left = this.cooldownReady(session, id) - now;
      if (left > 0) {
        client.send("ability_denied", { id, reason: `hide recharging (${Math.ceil(left / 1000)}s)` });
        return;
      }
      this.setCooldown(session, id, HIDE_COOLDOWN_MS);
      this.hideUntil = now + HIDE_DURATION_MS;
      // The Spy's marker on the Detective goes dark for the duration.
      this.sendDetectiveMark();
      client.send("ability_used", { id, cooldownMs: HIDE_COOLDOWN_MS, durationMs: HIDE_DURATION_MS });
      return;
    }

    if (id === "inspection") {
      if (role !== "detective") {
        client.send("ability_denied", { id, reason: "Only the detective can do that." });
        return;
      }
      const left = this.cooldownReady(session, id) - now;
      if (left > 0) {
        client.send("ability_denied", { id, reason: `inspection recharging (${Math.ceil(left / 1000)}s)` });
        return;
      }
      const body = this.bodyOf.get(session);
      const me = body ? this.state.people.get(body) : null;
      const room = me ? roomAt(me.x, me.z) : null;
      if (!room) {
        client.send("ability_denied", { id, reason: "Stand inside a room to seal it." });
        return;
      }
      this.setCooldown(session, id, SEAL_COOLDOWN_MS);
      this.seal = { room: room.id, until: now + SEAL_DURATION_MS };
      // Everyone sees the seal go up (a visible cordon); the Spy learns a room
      // just closed to them.
      this.broadcast("seal", { room: room.id, name: room.name, ms: SEAL_DURATION_MS });
      client.send("ability_used", { id, cooldownMs: SEAL_COOLDOWN_MS, durationMs: SEAL_DURATION_MS });
      return;
    }

    if (id === "impersonate") {
      if (role !== "spy") {
        client.send("ability_denied", { id, reason: "Only the spy can do that." });
        return;
      }
      const left = this.cooldownReady(session, id) - now;
      if (left > 0) {
        client.send("ability_denied", { id, reason: `impersonate recharging (${Math.ceil(left / 1000)}s)` });
        return;
      }
      this.setCooldown(session, id, IMPERSONATE_COOLDOWN_MS);
      this.impersonateUntil = now + IMPERSONATE_DURATION_MS;
      client.send("ability_used", { id, cooldownMs: IMPERSONATE_COOLDOWN_MS, durationMs: IMPERSONATE_DURATION_MS });
      return;
    }

    if (id === "snap") {
      if (role !== "spy") {
        client.send("ability_denied", { id, reason: "Only the spy can do that." });
        return;
      }
      const left = this.cooldownReady(session, id) - now;
      if (left > 0) {
        client.send("ability_denied", { id, reason: `camera busy (${Math.ceil(left / 1000)}s)` });
        return;
      }
      const body = this.bodyOf.get(session);
      const me = body ? this.state.people.get(body) : null;
      const detBody = this.detectiveBodyId();
      const det = detBody ? this.state.people.get(detBody) : null;
      if (!me || !det || Math.hypot(det.x - me.x, det.z - me.z) > SNAP_RANGE) {
        client.send("ability_denied", { id, reason: "Get closer to the detective to snap them." });
        return;
      }
      this.setCooldown(session, id, SNAP_COOLDOWN_MS);
      // Buy time: push the deadline (and the visible clock) out by a minute.
      this.roundEndsAt += SNAP_BONUS_MS;
      this.state.round.secondsLeft = Math.max(0, Math.ceil((this.roundEndsAt - now) / 1000));
      client.send("ability_used", { id, cooldownMs: SNAP_COOLDOWN_MS, bonusMs: SNAP_BONUS_MS });
      const detClient = this.clients.find((c) => c.sessionId === this.sessionWithRole("detective"));
      detClient?.send("photographed", { secondsAdded: Math.round(SNAP_BONUS_MS / 1000) });
      return;
    }

    client.send("ability_denied", { id, reason: "Unknown ability." });
  }

  /** The Detective's body id — server memory only, never synced. Symmetric to
   *  spyBodyId(); used so the Spy can be told where their hunter is (SOW §4.3). */
  private detectiveBodyId(): string | null {
    const det = this.sessionWithRole("detective");
    return det ? this.bodyOf.get(det) ?? null : null;
  }

  /**
   * Tell the Spy which body is the Detective — the one asymmetry the disguise
   * allows. The disguise hides the *Spy* from the *Detective*; letting the Spy
   * see their hunter is the whole point of `snap` (SOW §4.3). While `hide` is
   * up, the marker is withheld. Sent only to the Spy's client.
   */
  private sendDetectiveMark() {
    const spy = this.sessionWithRole("spy");
    const client = spy ? this.clients.find((c) => c.sessionId === spy) : null;
    if (!client) return;
    const hidden = Date.now() < this.hideUntil;
    client.send("detective_mark", { body: hidden ? null : this.detectiveBodyId() });
  }

  /** Fill the house with guests, each with a persona and a writing voice. */
  private populate() {
    const spots = [...ANCHORS].sort(() => Math.random() - 0.5);
    // Names come from a pool the AI keeps topped up, so they aren't canned and
    // no two guests share a first name (drawNames; procedural fallback if off).
    const names = drawNames(PARTY_SIZE);
    // Voices are dealt across the whole party and re-rolled each round, so the
    // writing spread holds and no player learns "the drunk is never the Spy".
    const voices = assignVoices(PARTY_SIZE);
    this.host = HOSTS[Math.floor(Math.random() * HOSTS.length)];

    for (let i = 0; i < PARTY_SIZE; i++) {
      const person = new Person();
      const look = randomLook();

      person.name = names[i];
      Object.assign(person, look);

      const spot = spots[i % spots.length];
      person.x = spot.x;
      person.z = spot.z;
      person.action = spot.action;

      const id = newBodyId();
      this.state.people.set(id, person);
      this.brains.set(id, new NpcBrain(id, person, this.claimed));
      this.personas.set(id, generatePersona(voices[i]));
    }

    console.log(`[house] ${PARTY_SIZE} guests arrived`);
  }

  private nearestAnchor(x: number, z: number) {
    let best = null;
    let bestDist = ACT_RANGE;
    for (const anchor of ANCHORS) {
      const d = Math.hypot(anchor.x - x, anchor.z - z);
      if (d < bestDist) {
        bestDist = d;
        best = anchor;
      }
    }
    return best;
  }

  onJoin(client: Client, options?: { name?: string; host?: boolean }) {
    // Take over a guest rather than adding one. This is the Spy mechanic:
    // an existing body at the party quietly stops being driven by the AI and
    // starts being driven by a person. Nothing about the body changes — same
    // ID, same face, same name, same accessory.
    const free = [...this.brains.keys()].filter((id) => !this.driverOf.has(id));
    if (free.length === 0) {
      throw new Error("the party is full");
    }

    const bodyId = free[Math.floor(Math.random() * free.length)];
    const person = this.state.people.get(bodyId)!;

    this.brains.get(bodyId)!.suspend();
    this.bodyOf.set(client.sessionId, bodyId);
    this.driverOf.set(bodyId, client.sessionId);
    person.action = Action.IDLE;

    // The client is told which body is theirs, and nothing about anyone else's.
    client.send("you", { body: bodyId, name: person.name });

    // Roles: the host picks; the other player takes the leftover once they've
    // chosen (SOW §2.1, host-picks-first). When the join comes from a lobby the
    // lobby's host is designated via options.host, so the person who clicked
    // "start" is the one who picks — regardless of who's socket connects first.
    // For anonymous quick-play (no flag) we fall back to first-in-is-host.
    const lobbyHost = options?.host; // true | false | undefined
    if (lobbyHost === true || (lobbyHost === undefined && !this.hostSession)) {
      this.hostSession = client.sessionId;
      client.send("role_pick", {});
    } else {
      const hostRole = this.hostSession ? this.roles.get(this.hostSession) : undefined;
      if (hostRole) {
        const other = hostRole === "detective" ? "spy" : "detective";
        // Give the other role only if it's still free (the 2-human game).
        if (![...this.roles.values()].includes(other)) this.grantRole(client.sessionId, other);
        else client.send("your_role", { role: "none" });
      } else {
        client.send("role_wait", {}); // the host hasn't chosen yet (or hasn't joined)
      }
    }

    console.log(
      `[house] a player took over ${person.name} (${this.driverOf.size} human, ${
        PARTY_SIZE - this.driverOf.size
      } NPC)`
    );
  }

  /** Tell one player their role — and only that player. Never broadcast; the
   *  Detective must never learn who the Spy is (SOW §7.1). */
  private grantRole(sessionId: string, role: "detective" | "spy") {
    this.roles.set(sessionId, role);
    const client = this.clients.find((c) => c.sessionId === sessionId);
    client?.send("your_role", { role });
    console.log(`[house] a player is the ${role}`);
    this.maybeStartRound();
  }

  // ---------------------------------------------------------------- the round

  private sessionWithRole(role: "detective" | "spy"): string | null {
    for (const [s, r] of this.roles) if (r === role) return s;
    return null;
  }

  /** The Spy's body id — server memory only, never synced (SOW §7.1). */
  private spyBodyId(): string | null {
    const spy = this.sessionWithRole("spy");
    return spy ? this.bodyOf.get(spy) ?? null : null;
  }

  /** Start once there's a Detective and a Spy (the two-human game). */
  private maybeStartRound() {
    if (this.state.round.phase !== 0) return;
    if (!this.sessionWithRole("detective") || !this.sessionWithRole("spy")) return;
    this.state.round.phase = 1;
    this.state.round.guessesLeft = MAX_GUESSES;
    this.state.round.secondsLeft = Math.ceil(ROUND_MS / 1000);
    this.roundEndsAt = Date.now() + ROUND_MS;
    this.generateTasks();
    // The Spy is shown where the Detective is (their snap/avoid target).
    this.sendDetectiveMark();
    this.broadcast("round_start", { seconds: this.state.round.secondsLeft });
    console.log(`[house] round started (${this.state.round.secondsLeft}s)`);
  }

  /** Deal the Spy three steal-and-deliver tasks among the NPCs, and send them —
   *  only to the Spy (SOW §3, §7.1). Sources are NPCs wearing an accessory. */
  private generateTasks() {
    const spy = this.sessionWithRole("spy");
    const spyBody = spy ? this.bodyOf.get(spy) : null;
    const detBody = this.bodyOf.get(this.sessionWithRole("detective") ?? "");
    const isNpc = (id: string) => id !== spyBody && id !== detBody;

    const withItems = [...this.state.people.entries()]
      .filter(([id, p]) => isNpc(id) && p.acc > 0)
      .sort(() => Math.random() - 0.5);
    const recipients = [...this.state.people.keys()].filter(isNpc).sort(() => Math.random() - 0.5);

    this.tasks = [];
    for (const [fromBody, p] of withItems) {
      if (this.tasks.length >= NUM_TASKS) break;
      const toBody = recipients.find((r) => r !== fromBody && !this.tasks.some((t) => t.toBody === r));
      if (!toBody) continue;
      this.tasks.push({ item: p.acc, fromBody, toBody, state: "pending" });
    }
    this.sendTasks();
  }

  private sendTasks() {
    const spy = this.sessionWithRole("spy");
    const client = spy ? this.clients.find((c) => c.sessionId === spy) : null;
    if (!client) return;
    client.send("tasks", {
      tasks: this.tasks.map((t) => ({
        item: t.item,
        itemName: ITEM_NAMES[t.item] ?? "item",
        fromBody: t.fromBody,
        fromName: this.state.people.get(t.fromBody)?.name ?? "",
        toBody: t.toBody,
        toName: this.state.people.get(t.toBody)?.name ?? "",
        state: t.state,
      })),
    });
  }

  /** The Spy tries to steal from / deliver to a nearby guest. Returns true if it
   *  did a task action (so `act` doesn't also do the camouflage join-in). */
  private trySpyTask(session: string): boolean {
    if (this.roles.get(session) !== "spy" || this.state.round.phase !== 1) return false;
    const body = this.bodyOf.get(session);
    const me = body ? this.state.people.get(body) : null;
    if (!me) return false;

    const near = (id: string) => {
      const p = this.state.people.get(id);
      return p ? Math.hypot(p.x - me.x, p.z - me.z) < TASK_RANGE : false;
    };
    // A sealed room (Detective's inspection) blocks any steal or delivery whose
    // guest is standing inside it, until the seal lifts (SOW §4.2).
    const sealedFor = (id: string) => {
      if (!this.seal || Date.now() >= this.seal.until) return false;
      const p = this.state.people.get(id);
      const room = p ? roomAt(p.x, p.z) : null;
      return room?.id === this.seal.room;
    };

    // Deliver first (finishing a task feels better than picking up another).
    for (const t of this.tasks) {
      if (t.state === "carrying" && near(t.toBody) && !sealedFor(t.toBody)) {
        t.state = "done";
        this.sendTasks();
        if (this.tasks.every((x) => x.state === "done")) {
          this.endRound("spy", "The spy finished the job and slipped away.");
        }
        return true;
      }
    }
    // Steal.
    for (const t of this.tasks) {
      if (t.state === "pending" && near(t.fromBody) && !sealedFor(t.fromBody)) {
        t.state = "carrying";
        const victim = this.state.people.get(t.fromBody);
        if (victim) victim.acc = 0; // the item visibly vanishes from the robbed guest
        this.sendTasks();
        return true;
      }
    }
    return false;
  }

  private makeGuess(client: Client, target: string) {
    const round = this.state.round;
    if (round.phase !== 1) return;
    if (this.roles.get(client.sessionId) !== "detective") {
      client.send("guess_denied", { reason: "Only the detective can accuse." });
      return;
    }
    const person = this.state.people.get(target);
    if (!person || target === this.bodyOf.get(client.sessionId)) {
      client.send("guess_denied", { reason: "You can't accuse them." });
      return;
    }
    if (round.guessesLeft <= 0) return;

    if (target === this.spyBodyId()) {
      this.endRound("detective", "The detective unmasked the spy.");
      return;
    }
    round.guessesLeft -= 1;
    // A wrong accusation. Tell the Detective; the Spy secretly learns they were
    // suspected of nothing (an innocent NPC took the fall) — a small tell later.
    client.send("guess_wrong", { target, name: person.name, guessesLeft: round.guessesLeft });
    if (round.guessesLeft <= 0) {
      this.endRound("spy", "The detective accused two innocents. The spy walks free.");
    }
  }

  private endRound(outcome: "detective" | "spy", reason: string) {
    const round = this.state.round;
    if (round.phase === 2) return;
    round.phase = 2;
    round.outcome = outcome;
    round.reason = reason;

    // Now — and only now — the Spy is revealed.
    const spyBody = this.spyBodyId();
    const spy = spyBody ? this.state.people.get(spyBody) : null;
    this.broadcast("round_over", {
      outcome,
      reason,
      spyBody: spyBody ?? "",
      spyName: spy?.name ?? "",
    });
    console.log(`[house] round over: ${outcome} — ${reason}`);
  }

  onLeave(client: Client) {
    // Close the chat this client was running as Detective.
    this.closeInterview(client.sessionId);
    // If they were the one being questioned, close it from the other side too:
    // drop them as the human target so the chat ends rather than hanging.
    for (const [det, interview] of this.interviews) {
      if (interview.humanTarget === client.sessionId) this.closeInterview(det);
    }

    const bodyId = this.bodyOf.get(client.sessionId);
    if (bodyId) {
      // The guest carries on as if nothing happened.
      this.driverOf.delete(bodyId);
      this.autopilot.delete(bodyId);
      this.brains.get(bodyId)?.release();
      this.bodyOf.delete(client.sessionId);
    }
    this.inputs.delete(client.sessionId);
    this.held.delete(client.sessionId);
    this.roles.delete(client.sessionId);

    // If the host left, promote the next player and let them pick — otherwise
    // roles could deadlock with nobody able to choose.
    if (client.sessionId === this.hostSession) {
      this.hostSession = null;
      const next = this.clients.find((c) => c.sessionId !== client.sessionId);
      if (next) {
        this.hostSession = next.sessionId;
        this.roles.delete(next.sessionId);
        next.send("role_pick", {});
      }
    }
    console.log(`[house] a player left (${this.driverOf.size} human bodies remain)`);
  }

  onDispose() {
    console.log(`[house] room ${this.roomId} disposed`);
  }

  private tick(dt: number) {
    const now = Date.now();

    // ---- the round clock. Runout is a Detective win: the Spy failed to finish
    // in time (SOW §2.1).
    if (this.state.round.phase === 1) {
      const left = Math.max(0, Math.ceil((this.roundEndsAt - now) / 1000));
      if (left !== this.state.round.secondsLeft) this.state.round.secondsLeft = left;
      if (left <= 0) this.endRound("detective", "Time ran out. The spy never finished the job.");
    }

    // ---- ability windows. When `hide` lifts, the Spy's marker on the Detective
    // must come back (it can't self-restore clientside). A spent seal is dropped.
    if (this.hideUntil && now >= this.hideUntil) {
      this.hideUntil = 0;
      this.sendDetectiveMark();
    }
    if (this.seal && now >= this.seal.until) this.seal = null;

    // ---- auto-close idle interviews, so a human target isn't pinned in the
    // chat (and on autopilot) forever if the Detective wanders off.
    for (const [det, interview] of this.interviews) {
      if (!interview.busy && now - interview.lastActivity > INTERVIEW_IDLE_MS) {
        this.closeInterview(det);
      }
    }

    // ---- human-driven bodies
    for (const [sessionId, bodyId] of this.bodyOf) {
      const person = this.state.people.get(bodyId);
      if (!person) continue;

      // While a human is typing an interview answer, their body is on autopilot
      // (driven by the AI loop below) — ignore their input so it keeps milling
      // about instead of freezing (SOW §2.3).
      if (this.autopilot.has(bodyId)) continue;

      const input = this.inputs.get(sessionId);
      if (!input) continue;

      // Client went quiet — stop, don't coast.
      if (now - input.at > INPUT_STALE_MS) {
        this.inputs.delete(sessionId);
        if (person.action === Action.WALK) person.action = Action.IDLE;
        continue;
      }

      // Movement is relative to where the camera is looking. Three.js cameras
      // look down -Z, so forward is (-sin yaw, -cos yaw).
      const forwardX = -Math.sin(input.yaw);
      const forwardZ = -Math.cos(input.yaw);
      const rightX = Math.cos(input.yaw);
      const rightZ = -Math.sin(input.yaw);

      let dx = forwardX * input.f + rightX * input.r;
      let dz = forwardZ * input.f + rightZ * input.r;

      const len = Math.hypot(dx, dz);
      if (len < 0.001) {
        // Standing still: hold whatever they're pretending to do.
        person.action = this.held.get(sessionId) ?? Action.IDLE;
        // Impersonate: while it's up, an idle Spy gently turns to look around —
        // NPCs do this, and a frozen body is the clearest tell of a player who
        // has stopped moving (SOW §4.3).
        if (
          this.roles.get(sessionId) === "spy" &&
          now < this.impersonateUntil &&
          !this.held.has(sessionId)
        ) {
          person.yaw += Math.sin(now / 900) * 0.03;
        }
        continue;
      }

      // Moving cancels any performance.
      this.held.delete(sessionId);

      // Normalise so diagonals aren't faster than the axes. The Detective moves
      // slower while peering through the magnifying glass.
      const speed = input.mag ? MAGNIFY_SPEED : SPEED;
      dx = (dx / len) * speed * dt;
      dz = (dz / len) * speed * dt;

      // Walls are enforced here, not on the client.
      const solved = resolveCollisions(person.x + dx, person.z + dz);
      person.x = clamp(solved.x, HOUSE.x1, HOUSE.x2);
      person.z = clamp(solved.z, HOUSE.z1, HOUSE.z2);
      person.yaw = Math.atan2(dx, dz);
      person.action = Action.WALK;
    }

    // ---- everyone the AI drives: real NPCs, plus any human body currently on
    // autopilot while its person types an interview answer.
    for (const [bodyId, brain] of this.brains) {
      if (this.driverOf.has(bodyId) && !this.autopilot.has(bodyId)) continue;
      brain.update(dt);
    }

    this.separateBodies();
  }

  /**
   * Keep bodies out of each other. Guests shouldn't overlap or walk through one
   * another. The MOVING body yields to the still one — a walker steps around
   * someone who's reading or seated, rather than shoving them off their spot.
   */
  private separateBodies() {
    const min = PLAYER_RADIUS * 2;
    const people = [...this.state.people.entries()];

    for (let iter = 0; iter < 2; iter++) {
      for (let i = 0; i < people.length; i++) {
        for (let j = i + 1; j < people.length; j++) {
          const a = people[i][1];
          const b = people[j][1];

          let dx = b.x - a.x;
          let dz = b.z - a.z;
          let dist = Math.hypot(dx, dz);
          if (dist >= min) continue;

          if (dist < 1e-4) {
            // Exactly stacked — nudge along X rather than divide by zero.
            dx = 1;
            dz = 0;
            dist = 1;
          }

          const overlap = min - dist;
          const nx = dx / dist;
          const nz = dz / dist;

          // Only bodies that are walking get pushed; stationary ones hold their
          // ground. If both are walking, they split the difference.
          const aMoves = a.action === Action.WALK;
          const bMoves = b.action === Action.WALK;
          let aShare = 0;
          let bShare = 0;
          if (aMoves && bMoves) {
            aShare = bShare = 0.5;
          } else if (aMoves) {
            aShare = 1;
          } else if (bMoves) {
            bShare = 1;
          } else {
            // Neither is walking (rare — anchors are spaced apart). Split it so
            // they don't stay interpenetrating.
            aShare = bShare = 0.5;
          }

          a.x -= nx * overlap * aShare;
          a.z -= nz * overlap * aShare;
          b.x += nx * overlap * bShare;
          b.z += nz * overlap * bShare;
        }
      }
    }

    // A separation push can shove someone into a wall or a table; put them back.
    for (const [, p] of people) {
      const solved = resolveCollisions(p.x, p.z);
      p.x = clamp(solved.x, HOUSE.x1, HOUSE.x2);
      p.z = clamp(solved.z, HOUSE.z1, HOUSE.z2);
    }
  }
}
