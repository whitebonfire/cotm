import { Person } from "../schema/GameState.js";
import { Action, SPEED, resolveCollisions, roomAt } from "../world/house.js";
import { ANCHORS, routeTo, type Anchor } from "../world/nav.js";

/** NPC walking speed. Normally the same as a player's, so a moving guest can't
 *  be outrun; a test hook (COTM_NPC_SPEED_MUL) can slow them for deterministic
 *  chase tests. Never set below play in production. */
const NPC_SPEED = SPEED * (Number(process.env.COTM_NPC_SPEED_MUL) || 1);

/** Accessory ids. Some of these become Spy targets at milestone 7. */
export const ACC = {
  NONE: 0,
  PURSE: 1,
  NECKLACE: 2,
  MONOCLE: 3,
  CANE: 4,
  BROOCH: 5,
  POCKET_WATCH: 6,
} as const;

const pick = <T>(arr: readonly T[]): T => arr[Math.floor(Math.random() * arr.length)];
const range = (lo: number, hi: number) => lo + Math.random() * (hi - lo);

/**
 * How long a body lingers once it arrives somewhere, by action.
 *
 * Long dwells matter. A party where everyone is permanently in transit gives
 * the Detective nothing to look at and makes a walking Spy invisible in the
 * churn. People should mostly be standing still doing something.
 */
const DWELL: Record<number, [number, number]> = {
  [Action.IDLE]: [6, 14],
  [Action.READ]: [18, 40],
  [Action.DRINK]: [10, 24],
  [Action.EXAMINE]: [12, 26],
  [Action.TALK]: [16, 38],
  [Action.LOOK]: [12, 30],
  // People settle in when they sit down.
  [Action.SIT]: [22, 55],
};

export interface NpcLook {
  skin: number;
  hair: number;
  hairHue: number;
  outfitHue: number;
  outfitVal: number;
  age: number;
  hat: number;
  acc: number;
  height: number;
}

/** Ages run late twenties to elderly, per the spec. */
export function randomLook(): NpcLook {
  const age = Math.floor(range(0, 4));
  return {
    skin: Math.floor(range(0, 6)),
    hair: Math.floor(range(0, 5)),
    // Older guests go grey.
    hairHue: age >= 2 && Math.random() < 0.65 ? 0 : Math.floor(range(1, 60)),
    outfitHue: Math.floor(range(0, 255)),
    outfitVal: Math.floor(range(60, 200)),
    age,
    hat: Math.random() < 0.35 ? Math.floor(range(1, 4)) : 0,
    acc: Math.random() < 0.75 ? Math.floor(range(1, 7)) : 0,
    // Elderly guests are a little shorter and stoop.
    height: Math.floor(age >= 3 ? range(96, 118) : range(112, 150)),
  };
}


/**
 * One NPC's head.
 *
 * Deliberately simple: pick somewhere to be, walk there, do the thing for a
 * while, pick somewhere else. The believability is meant to come from where
 * the anchors are and how long bodies stay put, not from clever AI.
 */
export class NpcBrain {
  private path: Array<{ x: number; z: number }> = [];
  private anchor: Anchor | null = null;
  private dwell = 0;
  /** Seconds left in the current sidestep, and which way it's strafing. */
  private sideTimer = 0;
  private sideDir = 1;
  /** Net-progress tracking: where we were a moment ago, and for how long we've
   *  failed to travel anywhere. Measured over time, not per frame — a body that
   *  jitters in place via sidestep still moves each frame but goes nowhere. */
  private checkX = 0;
  private checkZ = 0;
  private checkTimer = 0;
  private noProgress = 0;
  /** Anchors this body recently failed to reach: id -> seconds to keep avoiding.
   *  Stops it re-picking the one seat it can't get to and glitching forever. */
  private avoid = new Map<string, number>();

  /**
   * @param claimed Anchors already taken, so two bodies don't stand inside
   *   each other. Owned by the room and passed in — a static set here would be
   *   shared across every concurrent game, and one party's NPCs would block
   *   another party's.
   */
  constructor(
    public readonly id: string,
    public readonly person: Person,
    private readonly claimed: Set<string>
  ) {
    this.dwell = range(0, 6); // stagger the first move so they don't all set off together
  }

  release() {
    if (this.anchor) this.claimed.delete(this.anchor.id);
    this.anchor = null;
    this.path = [];
    this.sideTimer = 0;
    this.noProgress = 0;
    this.checkTimer = 0;
  }

  /** Drop the current plan and stand still — used when a human takes over. */
  suspend() {
    this.release();
    this.dwell = 0;
  }

  /** Bring the body back to life on autopilot — used while its human is typing
   *  an interview answer, so the body keeps milling about instead of freezing
   *  and giving the Spy away (SOW §2.3). Pauses a beat, then wanders. */
  resume() {
    this.release();
    this.dwell = range(0.4, 1.6);
  }

  update(dt: number) {
    // Age out the avoid list.
    if (this.avoid.size > 0) {
      for (const [id, t] of this.avoid) {
        const left = t - dt;
        if (left <= 0) this.avoid.delete(id);
        else this.avoid.set(id, left);
      }
    }

    // Walking to somewhere?
    if (this.path.length > 0) {
      this.step(dt);
      return;
    }

    // Standing about.
    this.dwell -= dt;
    if (this.dwell > 0) {
      this.person.action = this.anchor ? this.anchor.action : Action.IDLE;
      if (this.anchor?.faceX !== undefined && this.anchor.faceZ !== undefined) {
        this.person.yaw = Math.atan2(
          this.anchor.faceX - this.person.x,
          this.anchor.faceZ - this.person.z
        );
      }
      return;
    }

    this.chooseSomewhere();
  }

  private chooseSomewhere() {
    if (this.anchor) this.claimed.delete(this.anchor.id);

    const free = ANCHORS.filter(
      (a) => !this.claimed.has(a.id) && a.id !== this.anchor?.id && !this.avoid.has(a.id)
    );
    if (free.length === 0) {
      this.dwell = range(4, 8);
      return;
    }

    // Mild preference for staying in the room you're in, so the party doesn't
    // dissolve into everyone constantly migrating.
    const here = roomAt(this.person.x, this.person.z);
    const local = here ? free.filter((a) => a.room === here.id) : [];
    const target = local.length > 0 && Math.random() < 0.35 ? pick(local) : pick(free);

    this.anchor = target;
    this.claimed.add(target.id);
    this.path = routeTo(this.person.x, this.person.z, target);
    this.person.action = Action.WALK;

    // Start fresh progress tracking for the new journey.
    this.checkX = this.person.x;
    this.checkZ = this.person.z;
    this.checkTimer = 0;
    this.noProgress = 0;
    this.sideTimer = 0;
  }

  private step(dt: number) {
    const next = this.path[0];
    const dx = next.x - this.person.x;
    const dz = next.z - this.person.z;
    const dist = Math.hypot(dx, dz);

    if (dist < 0.35) {
      this.path.shift();
      // Fresh progress tracking for the next leg.
      this.checkX = this.person.x;
      this.checkZ = this.person.z;
      this.checkTimer = 0;
      this.noProgress = 0;
      this.sideTimer = 0;
      if (this.path.length === 0) {
        // Arrived. Settle in.
        const action = this.anchor?.action ?? Action.IDLE;
        const [lo, hi] = DWELL[action] ?? [6, 12];
        this.dwell = range(lo, hi);
        this.person.action = action;
      }
      return;
    }

    // Aim at the waypoint — unless we're mid-sidestep, in which case strafe
    // perpendicular to slip around whatever is in the way (a table corner, the
    // couch, another guest). Same trick the test harness uses to navigate.
    let dirX = dx / dist;
    let dirZ = dz / dist;
    if (this.sideTimer > 0) {
      this.sideTimer -= dt;
      const px = -dirZ * this.sideDir;
      const pz = dirX * this.sideDir;
      dirX = px;
      dirZ = pz;
    }

    const stepX = dirX * SPEED * dt;
    const stepZ = dirZ * SPEED * dt;

    const fromX = this.person.x;
    const fromZ = this.person.z;
    const solved = resolveCollisions(this.person.x + stepX, this.person.z + stepZ);
    this.person.x = solved.x;
    this.person.z = solved.z;
    this.person.yaw = Math.atan2(stepX, stepZ);
    this.person.action = Action.WALK;

    // Per-frame block detection: if this step barely moved, kick off a sidestep
    // to try to slip around the obstacle.
    const progressed = Math.hypot(this.person.x - fromX, this.person.z - fromZ);
    if (progressed < SPEED * dt * 0.25 && this.sideTimer <= 0) {
      this.sideTimer = 0.5;
      this.sideDir = -this.sideDir;
    }

    // Give-up is judged by NET travel over time, not per-frame movement — a body
    // jittering in place via sidestep moves every frame but goes nowhere. Every
    // half-second, if it hasn't actually travelled, count that against it; a
    // body that's genuinely getting around an obstacle racks up real distance
    // and resets. Persistent failure means the seat is unreachable from here, so
    // give it up, avoid it for a while, and pick somewhere else — instead of
    // grinding forever, which is the sit/walk glitch.
    this.checkTimer += dt;
    if (this.checkTimer >= 0.5) {
      const travelled = Math.hypot(this.person.x - this.checkX, this.person.z - this.checkZ);
      if (travelled < 0.35) this.noProgress += this.checkTimer;
      else this.noProgress = 0;
      this.checkX = this.person.x;
      this.checkZ = this.person.z;
      this.checkTimer = 0;

      if (this.noProgress >= 2) {
        if (this.anchor) this.avoid.set(this.anchor.id, 15);
        this.release();
      }
    }
  }
}
