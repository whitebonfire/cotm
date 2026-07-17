// Floor plan validation. Runs against the built shared house module, with no
// server and no network — this is about the geometry, not the netcode.
//
// The failure this exists to catch: a room that is sealed, or reachable only
// one way. A hiding game needs loops. If the Spy can be cornered in a dead end
// the round stops being a chase and becomes a formality.
import {
  ROOMS,
  WALLS,
  DOORS,
  HOUSE,
  SPAWNS,
  PLAYER_RADIUS,
  WALL_THICKNESS,
  resolveCollisions,
  roomAt,
} from "../dist/server/world/house.js";
import { ANCHORS, GRAPH, findDoorPath } from "../dist/server/world/nav.js";

const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass });
  console.log(`${pass ? "  PASS" : "  FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};

const STEP = 0.25;
const clearance = PLAYER_RADIUS + WALL_THICKNESS / 2;

/** A cell is walkable if a body standing there isn't intersecting a wall. */
const walkable = (x, z) => {
  if (x <= HOUSE.x1 || x >= HOUSE.x2 || z <= HOUSE.z1 || z >= HOUSE.z2) return false;
  const solved = resolveCollisions(x, z);
  return Math.hypot(solved.x - x, solved.z - z) < 1e-6;
};

// ---- spawns must be in the open
for (const [i, s] of SPAWNS.entries()) {
  const solved = resolveCollisions(s.x, s.z);
  const shoved = Math.hypot(solved.x - s.x, solved.z - s.z);
  const room = roomAt(s.x, s.z);
  check(
    `spawn ${i} (${s.x},${s.z}) is clear of walls`,
    shoved < 1e-6 && room !== null,
    room ? `in ${room.name}, shoved ${shoved.toFixed(3)}m` : "not in any room"
  );
}

// ---- flood fill from the front door
const key = (ix, iz) => `${ix},${iz}`;
const toIx = (v) => Math.round((v - HOUSE.x1) / STEP);
const toIz = (v) => Math.round((v - HOUSE.z1) / STEP);
const fromIx = (i) => HOUSE.x1 + i * STEP;
const fromIz = (i) => HOUSE.z1 + i * STEP;

const seen = new Set();
const queue = [[toIx(SPAWNS[0].x), toIz(SPAWNS[0].z)]];
seen.add(key(queue[0][0], queue[0][1]));

while (queue.length) {
  const [ix, iz] = queue.pop();
  for (const [dx, dz] of [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ]) {
    const nx = ix + dx;
    const nz = iz + dz;
    const k = key(nx, nz);
    if (seen.has(k)) continue;
    if (!walkable(fromIx(nx), fromIz(nz))) continue;
    seen.add(k);
    queue.push([nx, nz]);
  }
}

console.log(`\n  flood fill reached ${seen.size} cells from the front door\n`);

// ---- every room must be reachable
const reachedRooms = new Set();
for (const k of seen) {
  const [ix, iz] = k.split(",").map(Number);
  const room = roomAt(fromIx(ix), fromIz(iz));
  if (room) reachedRooms.add(room.id);
}

for (const room of ROOMS) {
  check(`${room.name} is reachable from the front door`, reachedRooms.has(room.id));
}

// ---- loops: every room needs at least two ways out, or it's a dead end
const doorsPerRoom = new Map(ROOMS.map((r) => [r.id, 0]));
for (const door of DOORS) {
  // Look just off each side of the opening to see which rooms it joins.
  const probes =
    door.axis === "x"
      ? [
          [door.x - 0.9, door.z],
          [door.x + 0.9, door.z],
        ]
      : [
          [door.x, door.z - 0.9],
          [door.x, door.z + 0.9],
        ];
  for (const [px, pz] of probes) {
    const room = roomAt(px, pz);
    if (room) doorsPerRoom.set(room.id, doorsPerRoom.get(room.id) + 1);
  }
}

for (const room of ROOMS) {
  const n = doorsPerRoom.get(room.id);
  check(`${room.name} has more than one way out`, n >= 2, `${n} doors`);
}

// ---- no orphan pockets: walkable floor that the fill never reached
let orphans = 0;
for (const room of ROOMS) {
  for (let x = room.x1 + STEP; x < room.x2; x += STEP) {
    for (let z = room.z1 + STEP; z < room.z2; z += STEP) {
      if (!walkable(x, z)) continue;
      if (!seen.has(key(toIx(x), toIz(z)))) orphans++;
    }
  }
}
check("no walled-off pockets of floor", orphans === 0, `${orphans} unreachable cells`);

// ---- anchors: every place a guest can stand must be standable
let buried = 0;
let misfiled = 0;
let unreachable = 0;
for (const anchor of ANCHORS) {
  const solved = resolveCollisions(anchor.x, anchor.z);
  if (Math.hypot(solved.x - anchor.x, solved.z - anchor.z) > 1e-6) {
    buried++;
    console.log(`         ${anchor.id} is inside a wall`);
  }
  const room = roomAt(anchor.x, anchor.z);
  if (!room || room.id !== anchor.room) {
    misfiled++;
    console.log(`         ${anchor.id} claims room "${anchor.room}" but sits in "${room?.id ?? "nowhere"}"`);
  }
  if (!seen.has(key(toIx(anchor.x), toIz(anchor.z)))) unreachable++;
}
check("no anchor is buried in a wall", buried === 0, `${buried} of ${ANCHORS.length}`);
check("every anchor is in the room it claims", misfiled === 0, `${misfiled} of ${ANCHORS.length}`);
check("every anchor is reachable on foot", unreachable === 0, `${unreachable} of ${ANCHORS.length}`);

// Two guests must never be sent to the same spot.
const tooClose = [];
for (let i = 0; i < ANCHORS.length; i++) {
  for (let j = i + 1; j < ANCHORS.length; j++) {
    const d = Math.hypot(ANCHORS[i].x - ANCHORS[j].x, ANCHORS[i].z - ANCHORS[j].z);
    if (d < 0.9) tooClose.push(`${ANCHORS[i].id}~${ANCHORS[j].id} (${d.toFixed(2)}m)`);
  }
}
check("no two anchors overlap", tooClose.length === 0, tooClose.join(", ") || "all clear");

// The party is 12 bodies; there must be somewhere for all of them to be.
check("enough anchors for the whole party", ANCHORS.length >= 12, `${ANCHORS.length} anchors for 12 guests`);

// ---- pathfinding must work between every pair of rooms, or an NPC routed
// somewhere unreachable simply stands still forever.
let noRoute = 0;
for (const from of ROOMS) {
  for (const to of ROOMS) {
    if (from.id === to.id) continue;
    if (findDoorPath(from.id, to.id).length === 0) {
      noRoute++;
      console.log(`         no route ${from.id} -> ${to.id}`);
    }
  }
}
check("every room can be routed to from every other room", noRoute === 0, `${noRoute} broken pairs`);

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
