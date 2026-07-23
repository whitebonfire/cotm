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
 * The anchors in nav.ts already say "someone reads here", "someone drinks
 * here". This gives those claims something to be true about — a body reading
 * at a bare wall reads as a bug, not as a guest.
 */
export function buildFurniture(scene: THREE.Scene) {
  const group = new THREE.Group();
  scene.add(group);

  const wood = new THREE.MeshStandardMaterial({ color: 0x4a3a24, roughness: 0.8 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x2e2620, roughness: 0.85 });
  const cloth = new THREE.MeshStandardMaterial({ color: 0x5c3a48, roughness: 0.9 });
  const glass = new THREE.MeshStandardMaterial({
    color: 0x9fd6e8,
    roughness: 0.15,
    metalness: 0.1,
    transparent: true,
    opacity: 0.34,
  });

  const box = (
    mat: THREE.Material,
    w: number,
    h: number,
    d: number,
    x: number,
    y: number,
    z: number
  ) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
    return mesh;
  };

  // Library: shelves down the west wall, packed with books to take down
  const bookMat: THREE.MeshStandardMaterial[] = [];
  for (let i = 0; i < 8; i++) {
    bookMat.push(
      new THREE.MeshStandardMaterial({
        color: new THREE.Color().setHSL(Math.random(), 0.4, 0.3),
        roughness: 0.8,
      })
    );
  }
  for (let z = -14; z <= -6; z += 2) {
    box(wood, 0.5, 2.4, 1.8, -19.5, 1.2, z);
    // Spines on the room-facing side, in three rows.
    for (const shelfY of [0.55, 1.2, 1.85]) {
      let bz = z - 0.78;
      while (bz < z + 0.78) {
        const w = 0.05 + Math.random() * 0.04;
        const h = 0.28 + Math.random() * 0.12;
        const spine = new THREE.Mesh(
          new THREE.BoxGeometry(0.16, h, w),
          bookMat[Math.floor(Math.random() * bookMat.length)]
        );
        spine.position.set(-19.18, shelfY + h / 2 - 0.02, bz + w / 2);
        spine.castShadow = true;
        group.add(spine);
        bz += w + 0.012;
      }
    }
  }

  // Study: display cases along the north wall — the jewels live here
  for (const x of [-3.5, 0, 3.5]) {
    box(dark, 1.6, 0.9, 0.6, x, 0.45, -14.4);
    box(glass, 1.5, 0.7, 0.5, x, 1.25, -14.4);
  }

  // Kitchen: counter
  box(dark, 12, 0.95, 0.7, 11.5, 0.48, -14.4);

  // Conservatory: windows onto the city, and a couple of plants
  for (const z of [0, 4, 8]) box(glass, 0.12, 2.2, 3.4, -19.7, 1.5, z);
  box(dark, 0.5, 0.5, 0.5, -16.5, 0.25, 11);

  // Ballroom: the bar
  box(wood, 5, 1.05, 0.8, -8.2, 0.52, -4.4);

  // Dining: the long table, on its legs
  box(cloth, 6.5, 0.08, 2.6, 12.5, 0.78, 4);
  for (const [x, z] of [
    [9.7, 3],
    [15.3, 3],
    [9.7, 5],
    [15.3, 5],
  ])
    box(dark, 0.12, 0.78, 0.12, x, 0.39, z);

  // A dining chair, seat facing (faceX, faceZ). Matches the SIT anchors so a
  // seated guest lands on the cushion rather than hovering beside it.
  const chair = (x: number, z: number, faceX: number, faceZ: number) => {
    const c = new THREE.Group();
    c.position.set(x, 0, z);
    c.rotation.y = Math.atan2(faceX - x, faceZ - z); // +z local points at the table
    const seat = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.08, 0.5), wood);
    seat.position.y = 0.46;
    seat.castShadow = true;
    seat.receiveShadow = true;
    c.add(seat);
    const back = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.08), cloth);
    back.position.set(0, 0.72, -0.24); // behind the sitter
    back.castShadow = true;
    c.add(back);
    for (const [lx, lz] of [
      [-0.21, -0.21],
      [0.21, -0.21],
      [-0.21, 0.21],
      [0.21, 0.21],
    ]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.46, 0.06), dark);
      leg.position.set(lx, 0.23, lz);
      c.add(leg);
    }
    group.add(c);
  };

  chair(9.4, 3, 12.5, 4);
  chair(9.4, 5, 12.5, 4);
  chair(15.6, 3, 12.5, 4);
  chair(15.6, 5, 12.5, 4);

  // A couch against the east wall, seat facing west — the din-couch anchors sit here.
  // Cushion top sits at ~0.5, matching the chairs, so a seated guest (whose
  // hips drop to ~0.48) rests on it rather than hovering above or sinking in.
  const couch = new THREE.Group();
  couch.position.set(19.1, 0, 10);
  couch.rotation.y = -Math.PI / 2; // local +z faces west, into the room
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

  // Entrance Hall: a console table by the door
  box(wood, 2.2, 0.8, 0.5, 3, 0.4, 14.4);
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
