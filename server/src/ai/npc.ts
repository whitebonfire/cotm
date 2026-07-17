import { Person } from "../schema/GameState.js";
import { Action, SPEED, resolveCollisions, roomAt } from "../world/house.js";
import { ANCHORS, routeTo, type Anchor } from "../world/nav.js";

const FIRST = [
  "Margot", "Cecily", "Rupert", "Iris", "Desmond", "Vivian", "Nigel", "Perdita",
  "Ambrose", "Rosalind", "Clive", "Beatrix", "Hugo", "Winifred", "Lionel", "Constance",
  "Barnaby", "Ottoline", "Gerald", "Sylvia", "Quentin", "Harriet", "Alaric", "Dorothy",
];

const LAST = [
  "Ashcombe", "Bellweather", "Crane", "Dunmore", "Ellery", "Fairholt", "Grieve",
  "Harrowgate", "Ives", "Larkspur", "Mowbray", "Quill", "Ravensworth", "Sable",
  "Thorne", "Vaughan", "Wren", "Yarrow",
];

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

export function randomName(used: Set<string>): string {
  for (let i = 0; i < 200; i++) {
    const name = `${pick(FIRST)} ${pick(LAST)}`;
    if (!used.has(name)) {
      used.add(name);
      return name;
    }
  }
  return `Guest ${used.size + 1}`;
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
  }

  /** Drop the current plan and stand still — used when a human takes over. */
  suspend() {
    this.release();
    this.dwell = 0;
  }

  update(dt: number) {
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

    const free = ANCHORS.filter((a) => !this.claimed.has(a.id) && a.id !== this.anchor?.id);
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
  }

  private step(dt: number) {
    const next = this.path[0];
    const dx = next.x - this.person.x;
    const dz = next.z - this.person.z;
    const dist = Math.hypot(dx, dz);

    if (dist < 0.35) {
      this.path.shift();
      if (this.path.length === 0) {
        // Arrived. Settle in.
        const action = this.anchor?.action ?? Action.IDLE;
        const [lo, hi] = DWELL[action] ?? [6, 12];
        this.dwell = range(lo, hi);
        this.person.action = action;
      }
      return;
    }

    const stepX = (dx / dist) * SPEED * dt;
    const stepZ = (dz / dist) * SPEED * dt;

    const solved = resolveCollisions(this.person.x + stepX, this.person.z + stepZ);
    this.person.x = solved.x;
    this.person.z = solved.z;
    this.person.yaw = Math.atan2(stepX, stepZ);
    this.person.action = Action.WALK;
  }
}
