/**
 * Solid furniture — the things you can't walk through.
 *
 * SHARED CODE, like the walls (house.ts) and the nav mesh (nav.ts). The server
 * collides against these boxes; the client renders them from the same list, so
 * what you see is exactly what stops you. One definition, both consumers.
 *
 * Seats are deliberately NOT here. You have to be able to sit ON a chair or a
 * couch, and in a top-down collision model "sit on it" and "can't walk through
 * it" are the same query with opposite answers. So chairs and the couch are
 * pass-through decoration (rendered client-side); only the bulky obstacles a
 * body should walk around live here.
 *
 * Every box is axis-aligned, which keeps the collision test a simple
 * circle-vs-rectangle. Keep it that way — no rotated furniture in this list.
 */

export const WOOD = 0x4a3a24;
export const DARK = 0x2e2620;

export interface Solid {
  id: string;
  /** Centre. */
  cx: number;
  cz: number;
  /** Half-extents on X and Z. */
  hw: number;
  hd: number;
  /** Visual: vertical centre and height, and colour. */
  y: number;
  h: number;
  color: number;
  /** If false, the client draws its own richer mesh (e.g. the table); the box
   *  is still a collider. */
  render: boolean;
}

export const SOLIDS: Solid[] = [
  // Library — bookshelves down the west wall
  { id: "shelf-0", cx: -19.5, cz: -14, hw: 0.25, hd: 0.9, y: 1.2, h: 2.4, color: WOOD, render: true },
  { id: "shelf-1", cx: -19.5, cz: -12, hw: 0.25, hd: 0.9, y: 1.2, h: 2.4, color: WOOD, render: true },
  { id: "shelf-2", cx: -19.5, cz: -10, hw: 0.25, hd: 0.9, y: 1.2, h: 2.4, color: WOOD, render: true },
  { id: "shelf-3", cx: -19.5, cz: -8, hw: 0.25, hd: 0.9, y: 1.2, h: 2.4, color: WOOD, render: true },
  { id: "shelf-4", cx: -19.5, cz: -6, hw: 0.25, hd: 0.9, y: 1.2, h: 2.4, color: WOOD, render: true },

  // Study — display cases along the north wall (jewels live here)
  { id: "case-0", cx: -3.5, cz: -14.4, hw: 0.8, hd: 0.3, y: 0.45, h: 0.9, color: DARK, render: true },
  { id: "case-1", cx: 0, cz: -14.4, hw: 0.8, hd: 0.3, y: 0.45, h: 0.9, color: DARK, render: true },
  { id: "case-2", cx: 3.5, cz: -14.4, hw: 0.8, hd: 0.3, y: 0.45, h: 0.9, color: DARK, render: true },

  // Kitchen — the counter
  { id: "counter", cx: 11.5, cz: -14.4, hw: 6, hd: 0.35, y: 0.48, h: 0.95, color: DARK, render: true },

  // Ballroom — the bar
  { id: "bar", cx: -8.2, cz: -4.4, hw: 2.5, hd: 0.4, y: 0.52, h: 1.05, color: WOOD, render: true },

  // Dining — the long table. Rendered specially (top + legs) so it isn't a
  // solid block to the floor; the collider is its footprint.
  { id: "table", cx: 12.5, cz: 4, hw: 3.25, hd: 1.3, y: 0.78, h: 0.08, color: 0x5c3a48, render: false },

  // Conservatory — a planter
  { id: "plant", cx: -16.5, cz: 11, hw: 0.28, hd: 0.28, y: 0.25, h: 0.5, color: DARK, render: true },

  // Entrance Hall — console table by the door
  { id: "console", cx: 3, cz: 14.4, hw: 1.1, hd: 0.25, y: 0.4, h: 0.8, color: WOOD, render: true },
];

/**
 * Push a circle of radius r out of any solid it overlaps. Returns the corrected
 * position. Deterministic — server and client must agree to the last decimal.
 */
export function resolveAgainstSolids(x: number, z: number, r: number): { x: number; z: number } {
  for (const s of SOLIDS) {
    const minX = s.cx - s.hw;
    const maxX = s.cx + s.hw;
    const minZ = s.cz - s.hd;
    const maxZ = s.cz + s.hd;

    // Closest point on the box to the circle centre.
    const px = x < minX ? minX : x > maxX ? maxX : x;
    const pz = z < minZ ? minZ : z > maxZ ? maxZ : z;

    let dx = x - px;
    let dz = z - pz;
    const dist = Math.hypot(dx, dz);

    if (dist > r) continue;

    if (dist > 1e-6) {
      // Outside the box but within r — push straight out.
      x = px + (dx / dist) * r;
      z = pz + (dz / dist) * r;
    } else {
      // Centre is inside the box — eject along the shallowest wall.
      const toLeft = x - minX;
      const toRight = maxX - x;
      const toNear = z - minZ;
      const toFar = maxZ - z;
      const min = Math.min(toLeft, toRight, toNear, toFar);
      if (min === toLeft) x = minX - r;
      else if (min === toRight) x = maxX + r;
      else if (min === toNear) z = minZ - r;
      else z = maxZ + r;
    }
  }

  return { x, z };
}
