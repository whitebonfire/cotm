/**
 * Where people stand, and how they get there.
 *
 * SHARED CODE, like house.ts — the client needs anchors to know where to draw
 * props (the bar, the bookshelves, the display cases), and the server needs
 * them to route NPCs. Keep it plain data and maths.
 */

import { Action, DOORS, ROOMS, type Door, type Room, roomAt } from "./house.js";

export interface Anchor {
  id: string;
  room: string;
  x: number;
  z: number;
  action: Action;
  /** Optional point to face while standing here — a shelf, a case, a circle. */
  faceX?: number;
  faceZ?: number;
}

/**
 * Hand-placed rather than generated. Where a body stands is characterisation:
 * the person at the display case is examining the jewels, the three in a ring
 * are gossiping. Scattered random points would read as a crowd of strangers
 * standing in a field.
 *
 * TALK anchors come in clusters facing a shared centre, so a conversation
 * looks like a conversation without any conversation logic.
 */
export const ANCHORS: Anchor[] = [
  // Library — reading against the west shelves, a pair chatting by the door
  { id: "lib-read-1", room: "library", x: -17.6, z: -13, action: Action.READ, faceX: -20, faceZ: -13 },
  { id: "lib-read-2", room: "library", x: -17.6, z: -10, action: Action.READ, faceX: -20, faceZ: -10 },
  { id: "lib-read-3", room: "library", x: -17.6, z: -7.2, action: Action.READ, faceX: -20, faceZ: -7.2 },
  { id: "lib-talk-1", room: "library", x: -11.2, z: -10, action: Action.TALK, faceX: -10, faceZ: -10 },
  { id: "lib-talk-2", room: "library", x: -8.8, z: -10, action: Action.TALK, faceX: -10, faceZ: -10 },
  { id: "lib-idle-1", room: "library", x: -8, z: -7, action: Action.IDLE },

  // Study — the display cases along the north wall. Jewels live here.
  { id: "std-exam-1", room: "study", x: -3.5, z: -12.8, action: Action.EXAMINE, faceX: -3.5, faceZ: -15 },
  { id: "std-exam-2", room: "study", x: 0, z: -12.8, action: Action.EXAMINE, faceX: 0, faceZ: -15 },
  { id: "std-exam-3", room: "study", x: 3.5, z: -12.8, action: Action.EXAMINE, faceX: 3.5, faceZ: -15 },
  { id: "std-talk-1", room: "study", x: -1.2, z: -8, action: Action.TALK, faceX: 0, faceZ: -8 },
  { id: "std-talk-2", room: "study", x: 1.2, z: -8, action: Action.TALK, faceX: 0, faceZ: -8 },

  // Kitchen — the counter
  { id: "kit-drink-1", room: "kitchen", x: 9, z: -12.8, action: Action.DRINK, faceX: 9, faceZ: -15 },
  { id: "kit-drink-2", room: "kitchen", x: 11.5, z: -12.8, action: Action.DRINK, faceX: 11.5, faceZ: -15 },
  { id: "kit-drink-3", room: "kitchen", x: 14, z: -12.8, action: Action.DRINK, faceX: 14, faceZ: -15 },
  { id: "kit-talk-1", room: "kitchen", x: 16.2, z: -8, action: Action.TALK, faceX: 17.4, faceZ: -8 },
  { id: "kit-talk-2", room: "kitchen", x: 18.6, z: -8, action: Action.TALK, faceX: 17.4, faceZ: -8 },

  // Conservatory — the west windows, looking out at the city
  { id: "con-look-1", room: "conservatory", x: -17.6, z: 0, action: Action.LOOK, faceX: -20, faceZ: 0 },
  { id: "con-look-2", room: "conservatory", x: -17.6, z: 4, action: Action.LOOK, faceX: -20, faceZ: 4 },
  { id: "con-look-3", room: "conservatory", x: -17.6, z: 8, action: Action.LOOK, faceX: -20, faceZ: 8 },
  { id: "con-idle-1", room: "conservatory", x: -15, z: 12.5, action: Action.IDLE },

  // Ballroom — the bar, and the big gossip ring in the middle
  { id: "bal-drink-1", room: "ballroom", x: -9.5, z: -3, action: Action.DRINK, faceX: -9.5, faceZ: -5 },
  { id: "bal-drink-2", room: "ballroom", x: -7, z: -3, action: Action.DRINK, faceX: -7, faceZ: -5 },
  { id: "bal-talk-1", room: "ballroom", x: -4.2, z: 0, action: Action.TALK, faceX: -3, faceZ: 0 },
  { id: "bal-talk-2", room: "ballroom", x: -1.8, z: 0, action: Action.TALK, faceX: -3, faceZ: 0 },
  { id: "bal-talk-3", room: "ballroom", x: -3, z: 1.4, action: Action.TALK, faceX: -3, faceZ: 0 },
  { id: "bal-idle-1", room: "ballroom", x: 3.5, z: 3, action: Action.IDLE },
  { id: "bal-idle-2", room: "ballroom", x: 2, z: -3, action: Action.IDLE },

  // Dining — chairs at the table's edges (clear of the table collider, which
  // spans x 9.25..15.75), and a lounge couch by the east wall
  { id: "din-sit-1", room: "dining", x: 8.6, z: 3.4, action: Action.SIT, faceX: 12.5, faceZ: 4 },
  { id: "din-sit-2", room: "dining", x: 8.6, z: 4.6, action: Action.SIT, faceX: 12.5, faceZ: 4 },
  { id: "din-sit-3", room: "dining", x: 16.4, z: 3.4, action: Action.SIT, faceX: 12.5, faceZ: 4 },
  { id: "din-sit-4", room: "dining", x: 16.4, z: 4.6, action: Action.SIT, faceX: 12.5, faceZ: 4 },
  { id: "din-drink-1", room: "dining", x: 12.5, z: 1.2, action: Action.DRINK, faceX: 12.5, faceZ: 4 },
  { id: "din-drink-2", room: "dining", x: 12.5, z: 6.8, action: Action.DRINK, faceX: 12.5, faceZ: 4 },
  { id: "din-couch-1", room: "dining", x: 18.9, z: 9, action: Action.SIT, faceX: 15, faceZ: 9 },
  { id: "din-couch-2", room: "dining", x: 18.9, z: 11, action: Action.SIT, faceX: 15, faceZ: 11 },
  { id: "din-talk-1", room: "dining", x: 9, z: 11.5, action: Action.TALK, faceX: 10.2, faceZ: 11.5 },
  { id: "din-talk-2", room: "dining", x: 11.4, z: 11.5, action: Action.TALK, faceX: 10.2, faceZ: 11.5 },

  // Entrance Hall
  { id: "hal-idle-1", room: "hall", x: -9.5, z: 13, action: Action.IDLE },
  { id: "hal-idle-2", room: "hall", x: 3, z: 13, action: Action.IDLE },
  { id: "hal-talk-1", room: "hall", x: -4.2, z: 9, action: Action.TALK, faceX: -3, faceZ: 9 },
  { id: "hal-talk-2", room: "hall", x: -1.8, z: 9, action: Action.TALK, faceX: -3, faceZ: 9 },
];

// ---------------------------------------------------------------- room graph

export interface Link {
  to: string;
  door: Door;
}

/** roomId -> the rooms you can reach from it, and the door you'd use. */
export const GRAPH: Map<string, Link[]> = (() => {
  const graph = new Map<string, Link[]>();
  for (const room of ROOMS) graph.set(room.id, []);

  for (const door of DOORS) {
    // Probe just off each side of the opening to find the two rooms it joins.
    const probes: Array<[number, number]> =
      door.axis === "x"
        ? [
            [door.x - 0.9, door.z],
            [door.x + 0.9, door.z],
          ]
        : [
            [door.x, door.z - 0.9],
            [door.x, door.z + 0.9],
          ];

    const a = roomAt(probes[0][0], probes[0][1]);
    const b = roomAt(probes[1][0], probes[1][1]);
    if (!a || !b || a.id === b.id) continue;

    graph.get(a.id)!.push({ to: b.id, door });
    graph.get(b.id)!.push({ to: a.id, door });
  }

  return graph;
})();

/**
 * Breadth-first room-to-room route, returned as the doors to walk through.
 * The house is seven rooms; anything cleverer would be a waste.
 */
export function findDoorPath(fromRoom: string, toRoom: string): Door[] {
  if (fromRoom === toRoom) return [];

  const prev = new Map<string, { room: string; door: Door }>();
  const seen = new Set<string>([fromRoom]);
  const queue: string[] = [fromRoom];

  while (queue.length) {
    const current = queue.shift()!;
    for (const link of GRAPH.get(current) ?? []) {
      if (seen.has(link.to)) continue;
      seen.add(link.to);
      prev.set(link.to, { room: current, door: link.door });
      if (link.to === toRoom) {
        // Walk the chain back to the start.
        const doors: Door[] = [];
        let at = toRoom;
        while (at !== fromRoom) {
          const step = prev.get(at)!;
          doors.unshift(step.door);
          at = step.room;
        }
        return doors;
      }
      queue.push(link.to);
    }
  }

  return []; // unreachable — house-check asserts this can't happen
}

/**
 * The dining table is the one obstacle a within-room straight line can cut
 * through: it sits in the middle of the room with seats all around it, so a
 * guest walking to a seat on the far side aims a line right across it, gets
 * stopped by the collider, and grinds back and forth along the edge. Doorways
 * are the only waypoints routeTo plans otherwise, so we special-case the table
 * and steer around it via its corners. Must match the collider in furniture.ts
 * (cx 12.5, cz 4, hw 3.25, hd 1.3 -> x 9.25..15.75, z 2.7..5.3).
 */
const TABLE = { xmin: 9.25, xmax: 15.75, zmin: 2.7, zmax: 5.3 };

/** Does the segment A->B pass through the table (padded by `pad`)? Liang-Barsky
 *  segment/box clip. */
function segHitsTable(ax: number, az: number, bx: number, bz: number, pad = 0.5): boolean {
  const xmin = TABLE.xmin - pad;
  const xmax = TABLE.xmax + pad;
  const zmin = TABLE.zmin - pad;
  const zmax = TABLE.zmax + pad;
  const dx = bx - ax;
  const dz = bz - az;
  const p = [-dx, dx, -dz, dz];
  const q = [ax - xmin, xmax - ax, az - zmin, zmax - az];
  let t0 = 0;
  let t1 = 1;
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) {
      if (q[i] < 0) return false; // parallel and outside this slab
    } else {
      const r = q[i] / p[i];
      if (p[i] < 0) {
        if (r > t1) return false;
        if (r > t0) t0 = r;
      } else {
        if (r < t0) return false;
        if (r < t1) t1 = r;
      }
    }
  }
  return t0 <= t1;
}

/** Waypoints to get from A to B around the table, or [] if the straight line is
 *  already clear. The four corners sit outside the collider; we take the
 *  shortest one- or two-corner detour whose legs are all clear. */
function tableDetour(
  ax: number,
  az: number,
  bx: number,
  bz: number
): Array<{ x: number; z: number }> {
  if (!segHitsTable(ax, az, bx, bz)) return [];
  const c = 0.95; // corner clearance, wider than the crossing pad
  const corners = [
    { x: TABLE.xmin - c, z: TABLE.zmin - c },
    { x: TABLE.xmax + c, z: TABLE.zmin - c },
    { x: TABLE.xmin - c, z: TABLE.zmax + c },
    { x: TABLE.xmax + c, z: TABLE.zmax + c },
  ];
  for (const k of corners) {
    if (!segHitsTable(ax, az, k.x, k.z) && !segHitsTable(k.x, k.z, bx, bz)) return [k];
  }
  let best: Array<{ x: number; z: number }> | null = null;
  let bestLen = Infinity;
  for (const k1 of corners) {
    for (const k2 of corners) {
      if (k1 === k2) continue;
      if (
        segHitsTable(ax, az, k1.x, k1.z) ||
        segHitsTable(k1.x, k1.z, k2.x, k2.z) ||
        segHitsTable(k2.x, k2.z, bx, bz)
      )
        continue;
      const len =
        Math.hypot(k1.x - ax, k1.z - az) +
        Math.hypot(k2.x - k1.x, k2.z - k1.z) +
        Math.hypot(bx - k2.x, bz - k2.z);
      if (len < bestLen) {
        bestLen = len;
        best = [k1, k2];
      }
    }
  }
  return best ?? [];
}

/**
 * Waypoints from a position to an anchor: every doorway on the way, then the
 * anchor itself. Doorways are aimed at slightly, not exactly — a body that
 * steers for the precise centre of an opening scrapes the frame on the way in.
 * Segments that lie within the dining room are routed around the table.
 */
export function routeTo(fromX: number, fromZ: number, anchor: Anchor): Array<{ x: number; z: number }> {
  const from = roomAt(fromX, fromZ);
  if (!from) return [{ x: anchor.x, z: anchor.z }];

  const doors = findDoorPath(from.id, anchor.room);
  const points: Array<{ x: number; z: number }> = [];

  for (const door of doors) {
    // Approach and exit points either side of the opening, so bodies line up
    // with the door before entering it instead of cutting the corner.
    if (door.axis === "x") {
      points.push({ x: door.x - 1.1, z: door.z }, { x: door.x + 1.1, z: door.z });
    } else {
      points.push({ x: door.x, z: door.z - 1.1 }, { x: door.x, z: door.z + 1.1 });
    }
  }

  // The pairs above are in wall order, not travel order. Sort each pair so the
  // near side comes first.
  let cx = fromX;
  let cz = fromZ;
  for (let i = 0; i < points.length; i += 2) {
    const a = points[i];
    const b = points[i + 1];
    if (Math.hypot(a.x - cx, a.z - cz) > Math.hypot(b.x - cx, b.z - cz)) {
      points[i] = b;
      points[i + 1] = a;
    }
    cx = points[i + 1].x;
    cz = points[i + 1].z;
  }

  points.push({ x: anchor.x, z: anchor.z });

  // Insert table detours for any segment that runs within the dining room, so a
  // guest crossing to a far seat walks around the table instead of into it.
  const routed: Array<{ x: number; z: number }> = [];
  let px = fromX;
  let pz = fromZ;
  for (const p of points) {
    if (roomAt(px, pz)?.id === "dining" && roomAt(p.x, p.z)?.id === "dining") {
      for (const d of tableDetour(px, pz, p.x, p.z)) routed.push(d);
    }
    routed.push(p);
    px = p.x;
    pz = p.z;
  }
  return routed;
}

export function anchorsIn(roomId: string): Anchor[] {
  return ANCHORS.filter((a) => a.room === roomId);
}

export function roomById(id: string): Room | undefined {
  return ROOMS.find((r) => r.id === id);
}
