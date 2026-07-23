import { Room, Client } from "@colyseus/core";
import { HouseState, Person } from "../schema/GameState.js";
import { Action, HOUSE, PLAYER_RADIUS, SPEED, resolveCollisions, roomAt } from "../world/house.js";
import { ANCHORS } from "../world/nav.js";
import { NpcBrain, randomLook, randomName } from "../ai/npc.js";

interface InputMessage {
  /** Forward axis, -1..1 */
  f: number;
  /** Strafe axis, -1..1 */
  r: number;
  /** Camera yaw in radians, which is what movement is relative to. */
  yaw: number;
}

interface StoredInput extends InputMessage {
  at: number;
}

const TICK_MS = 1000 / 20;

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

  /** sessionId -> the action they're holding while stood at an anchor. */
  private held = new Map<string, number>();

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
        at: Date.now(),
      });
    });

    // Join in with whatever happens at the nearest anchor — read the book,
    // take a drink, look out of the window. This is the Spy's camouflage, so
    // it has to be exactly the same set of actions the NPCs perform.
    this.onMessage("act", (client: Client) => {
      const body = this.bodyOf.get(client.sessionId);
      if (!body) return;
      const person = this.state.people.get(body);
      if (!person) return;

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

    this.setSimulationInterval((deltaMs) => this.tick(deltaMs / 1000), TICK_MS);
  }

  /** Fill the house with guests. */
  private populate() {
    const names = new Set<string>();
    const spots = [...ANCHORS].sort(() => Math.random() - 0.5);

    for (let i = 0; i < PARTY_SIZE; i++) {
      const person = new Person();
      const look = randomLook();

      person.name = randomName(names);
      Object.assign(person, look);

      const spot = spots[i % spots.length];
      person.x = spot.x;
      person.z = spot.z;
      person.action = spot.action;

      const id = newBodyId();
      this.state.people.set(id, person);
      this.brains.set(id, new NpcBrain(id, person, this.claimed));
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

  onJoin(client: Client, options?: { name?: string }) {
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

    console.log(
      `[house] a player took over ${person.name} (${this.driverOf.size} human, ${
        PARTY_SIZE - this.driverOf.size
      } NPC)`
    );
  }

  onLeave(client: Client) {
    const bodyId = this.bodyOf.get(client.sessionId);
    if (bodyId) {
      // The guest carries on as if nothing happened.
      this.driverOf.delete(bodyId);
      this.brains.get(bodyId)?.release();
      this.bodyOf.delete(client.sessionId);
    }
    this.inputs.delete(client.sessionId);
    this.held.delete(client.sessionId);
    console.log(`[house] a player left (${this.driverOf.size} human bodies remain)`);
  }

  onDispose() {
    console.log(`[house] room ${this.roomId} disposed`);
  }

  private tick(dt: number) {
    const now = Date.now();

    // ---- human-driven bodies
    for (const [sessionId, bodyId] of this.bodyOf) {
      const person = this.state.people.get(bodyId);
      if (!person) continue;

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
        continue;
      }

      // Moving cancels any performance.
      this.held.delete(sessionId);

      // Normalise so diagonals aren't faster than the axes.
      dx = (dx / len) * SPEED * dt;
      dz = (dz / len) * SPEED * dt;

      // Walls are enforced here, not on the client.
      const solved = resolveCollisions(person.x + dx, person.z + dz);
      person.x = clamp(solved.x, HOUSE.x1, HOUSE.x2);
      person.z = clamp(solved.z, HOUSE.z1, HOUSE.z2);
      person.yaw = Math.atan2(dx, dz);
      person.action = Action.WALK;
    }

    // ---- everyone else
    for (const [bodyId, brain] of this.brains) {
      if (this.driverOf.has(bodyId)) continue;
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
