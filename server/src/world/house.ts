/**
 * The house — floor plan, walls, and collision.
 *
 * SHARED CODE. The server imports this to simulate; the client imports the
 * same file to render and to predict. That is not a convenience, it's a
 * requirement: if the two sides disagree about where a wall is by even a few
 * centimetres, the client predicts through it, the server refuses, and the
 * player rubber-bands. One definition, both consumers.
 *
 * It lives under server/ so the server's tsc build (rootDir server/src) can
 * reach it. The client imports across the tree; Vite bundles it fine.
 *
 * No decorators, no Schema, no imports — plain data and maths on purpose.
 */

export const WALL_HEIGHT = 3.2;
export const WALL_THICKNESS = 0.3;
export const DOOR_WIDTH = 2.4;
export const DOOR_HEIGHT = 2.3;
export const PLAYER_RADIUS = 0.42;

/**
 * Metres per second — for EVERY body in the house, player and NPC alike.
 *
 * This is a game rule wearing a constant's clothes. If NPCs strolled at 2.5
 * and a player moved at 4.2, the Spy would be the one power-walking through a
 * cocktail party and the Detective would spot them in four seconds flat. The
 * disguise only works if a human body and an AI body move at the same rate,
 * so there is one constant and both sides import it.
 *
 * The intended tell is pathing *style* — humans stutter, backtrack, and stop
 * dead; NPCs glide between anchors — not raw speed. See SOW section 4.3
 * (`impersonate`), which exists precisely to paper over that difference.
 */
export const SPEED = 4.2;

/** What a body is doing. Players can do all of these too — that's the point. */
export enum Action {
  IDLE = 0,
  WALK = 1,
  READ = 2,
  DRINK = 3,
  EXAMINE = 4,
  TALK = 5,
  LOOK = 6,
}

/** Footprint. Everything lives inside this. */
export const HOUSE = { x1: -20, z1: -15, x2: 20, z2: 15 } as const;

export interface Room {
  id: string;
  name: string;
  x1: number;
  z1: number;
  x2: number;
  z2: number;
  /** Floor tint, so rooms read as distinct places rather than one grey field. */
  color: number;
  /** Lamp colour. */
  light: number;
}

/**
 * Seven rooms. Deliberately laid out with loops rather than a tree — a Spy
 * needs to be able to leave a room by a door they didn't come in by, and a
 * Detective needs to be losable. A dead-end house is a bad hiding game.
 */
export const ROOMS: Room[] = [
  { id: "library",  name: "Library",       x1: -20, z1: -15, x2: -6, z2: -5, color: 0x3a3129, light: 0xffd9a0 },
  { id: "study",    name: "Study",         x1: -6,  z1: -15, x2: 6,  z2: -5, color: 0x33302c, light: 0xffcf8f },
  { id: "kitchen",  name: "Kitchen",       x1: 6,   z1: -15, x2: 20, z2: -5, color: 0x2f3538, light: 0xdcecff },
  { id: "conservatory", name: "Conservatory", x1: -20, z1: -5, x2: -12, z2: 15, color: 0x2b3a33, light: 0xbfe6d0 },
  { id: "ballroom", name: "Ballroom",      x1: -12, z1: -5,  x2: 6,  z2: 5,  color: 0x3d3340, light: 0xffc9de },
  { id: "dining",   name: "Dining Room",   x1: 6,   z1: -5,  x2: 20, z2: 15, color: 0x3b302b, light: 0xffbf7a },
  { id: "hall",     name: "Entrance Hall", x1: -12, z1: 5,   x2: 6,  z2: 15, color: 0x353a42, light: 0xfff0cf },
];

export interface WallSpec {
  /** 'x' = a wall running along Z at a fixed X. 'z' = running along X at a fixed Z. */
  axis: "x" | "z";
  at: number;
  from: number;
  to: number;
  /** Centres of door openings along the wall's running axis. */
  doors?: number[];
}

export const WALL_SPECS: WallSpec[] = [
  // Outer shell
  { axis: "z", at: -15, from: -20, to: 20 },
  { axis: "z", at: 15, from: -20, to: 20 },
  { axis: "x", at: -20, from: -15, to: 15 },
  { axis: "x", at: 20, from: -15, to: 15 },

  // North row divider: Library | Study | Kitchen  ->  rooms below
  { axis: "z", at: -5, from: -20, to: 20, doors: [-13, 0, 13] },

  // Library | Study | Kitchen
  { axis: "x", at: -6, from: -15, to: -5, doors: [-10] },
  { axis: "x", at: 6, from: -15, to: -5, doors: [-10] },

  // Conservatory | (Ballroom, Hall)
  { axis: "x", at: -12, from: -5, to: 15, doors: [0, 10] },

  // (Ballroom, Hall) | Dining
  { axis: "x", at: 6, from: -5, to: 15, doors: [0, 10] },

  // Ballroom | Entrance Hall
  { axis: "z", at: 5, from: -12, to: 6, doors: [-3] },
];

export interface Wall {
  x1: number;
  z1: number;
  x2: number;
  z2: number;
}

export interface Door {
  axis: "x" | "z";
  /** Centre of the opening. */
  x: number;
  z: number;
}

function buildWalls(): { walls: Wall[]; doors: Door[] } {
  const walls: Wall[] = [];
  const doors: Door[] = [];

  for (const spec of WALL_SPECS) {
    const cuts: number[] = [];
    for (const d of spec.doors ?? []) {
      cuts.push(d - DOOR_WIDTH / 2, d + DOOR_WIDTH / 2);
      doors.push(
        spec.axis === "x" ? { axis: "x", x: spec.at, z: d } : { axis: "z", x: d, z: spec.at }
      );
    }
    cuts.sort((a, b) => a - b);

    // Walk the run, emitting solid stretches between the door gaps.
    const points = [spec.from, ...cuts, spec.to];
    for (let i = 0; i < points.length; i += 2) {
      const a = points[i];
      const b = points[i + 1];
      if (b - a <= 0.05) continue;
      walls.push(
        spec.axis === "x"
          ? { x1: spec.at, z1: a, x2: spec.at, z2: b }
          : { x1: a, z1: spec.at, x2: b, z2: spec.at }
      );
    }
  }

  return { walls, doors };
}

const built = buildWalls();
export const WALLS: Wall[] = built.walls;
export const DOORS: Door[] = built.doors;

/**
 * Push a body out of any wall it has ended up inside, sliding along the
 * surface rather than stopping dead.
 *
 * Both the server (authority) and the client (prediction) call this with the
 * same arguments and must get the same answer. Keep it deterministic: no time,
 * no randomness, no floating-point tricks that differ across engines.
 */
export function resolveCollisions(
  x: number,
  z: number,
  radius: number = PLAYER_RADIUS
): { x: number; z: number } {
  const r = radius + WALL_THICKNESS / 2;

  // A few passes so corners (two walls at once) settle instead of jittering.
  for (let pass = 0; pass < 4; pass++) {
    let touched = false;

    for (const w of WALLS) {
      const dx = w.x2 - w.x1;
      const dz = w.z2 - w.z1;
      const len2 = dx * dx + dz * dz;

      // Closest point on the wall segment to the body.
      let t = len2 > 0 ? ((x - w.x1) * dx + (z - w.z1) * dz) / len2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const cx = w.x1 + dx * t;
      const cz = w.z1 + dz * t;

      let ox = x - cx;
      let oz = z - cz;
      let dist = Math.hypot(ox, oz);
      if (dist >= r) continue;

      if (dist < 1e-6) {
        // Exactly on the centreline. Pick a direction rather than divide by zero.
        ox = 1;
        oz = 0;
        dist = 1;
      }

      x = cx + (ox / dist) * r;
      z = cz + (oz / dist) * r;
      touched = true;
    }

    if (!touched) break;
  }

  return { x, z };
}

/** Which room a point is in, or null if it's in a wall or outside. */
export function roomAt(x: number, z: number): Room | null {
  for (const r of ROOMS) {
    if (x >= r.x1 && x <= r.x2 && z >= r.z1 && z <= r.z2) return r;
  }
  return null;
}

/**
 * Fixed spawn points in the Entrance Hall.
 *
 * Deliberately clear of walls and doorways — a body spawned inside a door
 * frame gets shoved out by resolveCollisions and looks like a teleport.
 */
export const SPAWNS: Array<{ x: number; z: number }> = [
  { x: -8, z: 12 },
  { x: -4, z: 12 },
  { x: 0, z: 12 },
  { x: 4, z: 12 },
  { x: -8, z: 8 },
  { x: -4, z: 8 },
  { x: 0, z: 8 },
  { x: 4, z: 8 },
];
