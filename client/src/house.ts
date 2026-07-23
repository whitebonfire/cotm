import * as THREE from "three";
import {
  ROOMS,
  WALL_SPECS,
  WALLS,
  DOORS,
  HOUSE,
  WALL_HEIGHT,
  WALL_THICKNESS,
  DOOR_WIDTH,
  DOOR_HEIGHT,
} from "../../server/src/world/house";
import { SOLIDS } from "../../server/src/world/furniture";

/**
 * Builds the house from the shared floor plan.
 *
 * Every wall drawn here comes from the same WALLS array the server collides
 * against, so what you can see is exactly what you can't walk through.
 */
export function buildHouse(scene: THREE.Scene): { colliders: THREE.Object3D[] } {
  const group = new THREE.Group();
  scene.add(group);

  // ---- floors, one per room so each place has its own tint
  for (const room of ROOMS) {
    const w = room.x2 - room.x1;
    const d = room.z2 - room.z1;

    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(w, d),
      new THREE.MeshStandardMaterial({ color: room.color, roughness: 0.94, metalness: 0.02 })
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(room.x1 + w / 2, 0, room.z1 + d / 2);
    floor.receiveShadow = true;
    group.add(floor);

    // A lamp per room. No shadows from these — seven shadow-casting point
    // lights would cost more than they're worth. The directional light does
    // the shadow work.
    const lamp = new THREE.PointLight(room.light, 26, Math.max(w, d) * 1.25, 2);
    lamp.position.set(room.x1 + w / 2, 2.7, room.z1 + d / 2);
    group.add(lamp);
  }

  // ---- walls
  const wallMat = new THREE.MeshStandardMaterial({ color: 0x4a4f5c, roughness: 0.88 });
  const trimMat = new THREE.MeshStandardMaterial({ color: 0x2b2f3a, roughness: 0.8 });
  const colliders: THREE.Object3D[] = [];

  for (const w of WALLS) {
    const len = Math.hypot(w.x2 - w.x1, w.z2 - w.z1);
    const alongX = Math.abs(w.x2 - w.x1) > Math.abs(w.z2 - w.z1);

    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(
        alongX ? len : WALL_THICKNESS,
        WALL_HEIGHT,
        alongX ? WALL_THICKNESS : len
      ),
      wallMat
    );
    mesh.position.set((w.x1 + w.x2) / 2, WALL_HEIGHT / 2, (w.z1 + w.z2) / 2);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
    colliders.push(mesh);

    // Skirting, so walls meet the floor rather than float.
    const skirt = new THREE.Mesh(
      new THREE.BoxGeometry(
        alongX ? len : WALL_THICKNESS + 0.08,
        0.16,
        alongX ? WALL_THICKNESS + 0.08 : len
      ),
      trimMat
    );
    skirt.position.set((w.x1 + w.x2) / 2, 0.08, (w.z1 + w.z2) / 2);
    group.add(skirt);
  }

  // ---- door lintels: the wall above each opening, so doors read as doors
  // rather than as gaps someone forgot to fill in.
  const lintelH = WALL_HEIGHT - DOOR_HEIGHT;
  if (lintelH > 0.02) {
    for (const door of DOORS) {
      const alongX = door.axis === "z"; // a 'z' wall runs along X
      const lintel = new THREE.Mesh(
        new THREE.BoxGeometry(
          alongX ? DOOR_WIDTH : WALL_THICKNESS,
          lintelH,
          alongX ? WALL_THICKNESS : DOOR_WIDTH
        ),
        wallMat
      );
      lintel.position.set(door.x, DOOR_HEIGHT + lintelH / 2, door.z);
      lintel.castShadow = true;
      group.add(lintel);
      colliders.push(lintel);
    }
  }

  // ---- ground outside the shell, so the house doesn't sit on a void
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(160, 160),
    new THREE.MeshStandardMaterial({ color: 0x14171d, roughness: 1 })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.02;
  ground.receiveShadow = true;
  scene.add(ground);

  return { colliders };
}

/**
 * The things people are standing at.
 *
 * The bulky obstacles come straight from the shared SOLIDS list, so every piece
 * of furniture you can see is one you can't walk through, and vice versa — the
 * same guarantee the walls have. Decorative extras (book spines, glass tops,
 * table legs) and the pass-through seats (chairs, couch) are added on top; they
 * carry no collider, which is why you can sit on them.
 */
export function buildFurniture(scene: THREE.Scene) {
  const group = new THREE.Group();
  scene.add(group);

  const cloth = new THREE.MeshStandardMaterial({ color: 0x5c3a48, roughness: 0.9 });
  const chairWood = new THREE.MeshStandardMaterial({ color: 0x4a3a24, roughness: 0.8 });
  const legDark = new THREE.MeshStandardMaterial({ color: 0x2e2620, roughness: 0.85 });
  const glass = new THREE.MeshStandardMaterial({
    color: 0x9fd6e8,
    roughness: 0.15,
    metalness: 0.1,
    transparent: true,
    opacity: 0.34,
  });

  const matCache = new Map<number, THREE.MeshStandardMaterial>();
  const mat = (color: number) => {
    let m = matCache.get(color);
    if (!m) {
      m = new THREE.MeshStandardMaterial({ color, roughness: 0.82 });
      matCache.set(color, m);
    }
    return m;
  };

  // ---- solids, drawn from the shared collider list
  for (const s of SOLIDS) {
    if (!s.render) continue;
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(s.hw * 2, s.h, s.hd * 2), mat(s.color));
    mesh.position.set(s.cx, s.y, s.cz);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);

    if (s.id.startsWith("shelf")) {
      // Rows of book spines on the room-facing side, to be taken down and read.
      for (const shelfY of [0.55, 1.2, 1.85]) {
        let bz = s.cz - 0.78;
        while (bz < s.cz + 0.78) {
          const w = 0.05 + Math.random() * 0.04;
          const h = 0.28 + Math.random() * 0.12;
          const spine = new THREE.Mesh(
            new THREE.BoxGeometry(0.16, h, w),
            mat(new THREE.Color().setHSL(Math.random(), 0.4, 0.3).getHex())
          );
          spine.position.set(s.cx + 0.32, shelfY + h / 2 - 0.02, bz + w / 2);
          spine.castShadow = true;
          group.add(spine);
          bz += w + 0.012;
        }
      }
    } else if (s.id.startsWith("case")) {
      // Glass top over the display case.
      const top = new THREE.Mesh(new THREE.BoxGeometry(s.hw * 2 - 0.1, 0.7, s.hd * 2 - 0.1), glass);
      top.position.set(s.cx, s.y + 0.8, s.cz);
      group.add(top);
    }
  }

  // ---- the dining table: a thin top on legs (collider is its footprint)
  const table = SOLIDS.find((s) => s.id === "table")!;
  const top = new THREE.Mesh(new THREE.BoxGeometry(table.hw * 2, 0.08, table.hd * 2), cloth);
  top.position.set(table.cx, 0.78, table.cz);
  top.castShadow = true;
  top.receiveShadow = true;
  group.add(top);
  for (const [x, z] of [
    [table.cx - 2.8, table.cz - 1.0],
    [table.cx + 2.8, table.cz - 1.0],
    [table.cx - 2.8, table.cz + 1.0],
    [table.cx + 2.8, table.cz + 1.0],
  ]) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.78, 0.12), legDark);
    leg.position.set(x, 0.39, z);
    group.add(leg);
  }

  // ---- pass-through seats (no collider — you sit ON them)

  // A dining chair, seat facing (faceX, faceZ), matching the SIT anchors.
  const chair = (x: number, z: number, faceX: number, faceZ: number) => {
    const c = new THREE.Group();
    c.position.set(x, 0, z);
    c.rotation.y = Math.atan2(faceX - x, faceZ - z); // +z local points at the table
    const seat = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.08, 0.5), chairWood);
    seat.position.y = 0.46;
    seat.castShadow = true;
    seat.receiveShadow = true;
    c.add(seat);
    const back = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.08), cloth);
    back.position.set(0, 0.72, -0.24);
    back.castShadow = true;
    c.add(back);
    for (const [lx, lz] of [
      [-0.21, -0.21],
      [0.21, -0.21],
      [-0.21, 0.21],
      [0.21, 0.21],
    ]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.46, 0.06), legDark);
      leg.position.set(lx, 0.23, lz);
      c.add(leg);
    }
    group.add(c);
  };

  chair(8.6, 3.4, 12.5, 4);
  chair(8.6, 4.6, 12.5, 4);
  chair(16.4, 3.4, 12.5, 4);
  chair(16.4, 4.6, 12.5, 4);

  // A couch against the east wall, seat facing west — the din-couch anchors sit
  // here. Cushion top ~0.5, matching the chairs, so a seated guest rests on it.
  const couch = new THREE.Group();
  couch.position.set(19.1, 0, 10);
  couch.rotation.y = -Math.PI / 2;
  const cushion = new THREE.Mesh(new THREE.BoxGeometry(4, 0.32, 1.0), cloth);
  cushion.position.set(0, 0.34, 0);
  cushion.castShadow = true;
  cushion.receiveShadow = true;
  couch.add(cushion);
  const cback = new THREE.Mesh(new THREE.BoxGeometry(4, 0.6, 0.28), cloth);
  cback.position.set(0, 0.62, -0.42);
  cback.castShadow = true;
  couch.add(cback);
  for (const ax of [-2.05, 2.05]) {
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.5, 1.0), cloth);
    arm.position.set(ax, 0.42, 0);
    arm.castShadow = true;
    couch.add(arm);
  }
  group.add(couch);

  // ---- decoration with no collider: the conservatory windows onto the city
  for (const z of [0, 4, 8]) {
    const win = new THREE.Mesh(new THREE.BoxGeometry(0.12, 2.2, 3.4), glass);
    win.position.set(-19.7, 1.5, z);
    group.add(win);
  }
}

/** Floating room names, so it's obvious the floor plan is real. */
export function buildRoomLabels(scene: THREE.Scene) {
  for (const room of ROOMS) {
    const canvas = document.createElement("canvas");
    canvas.width = 512;
    canvas.height = 128;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "rgba(0,0,0,0)";
    ctx.fillRect(0, 0, 512, 128);
    ctx.font = "600 54px ui-monospace, Menlo, monospace";
    ctx.fillStyle = "#e8e6e1";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(room.name.toUpperCase(), 256, 64);

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;

    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: texture, transparent: true, opacity: 0.32, depthWrite: false })
    );
    sprite.scale.set(5.2, 1.3, 1);
    sprite.position.set((room.x1 + room.x2) / 2, 2.95, (room.z1 + room.z2) / 2);
    scene.add(sprite);
  }
}

export { HOUSE };
