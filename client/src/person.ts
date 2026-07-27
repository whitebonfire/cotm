import * as THREE from "three";
import { Action } from "../../server/src/world/house";

/**
 * Procedural partygoers.
 *
 * Stylized low-poly is the target (SOW §3), but an asset pipeline is not this
 * milestone's problem — these are built from primitives so the behaviour and
 * the disguise can be tested now. Swapping in modelled characters later means
 * replacing buildPerson() and animatePerson() and nothing else.
 *
 * CRITICAL: this function does not know, and must never know, whether a body
 * is a human or an NPC. It takes a look and returns a figure. The moment a
 * human's body renders differently from an AI's, the game is over.
 */

export interface Look {
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

export const SKINS = [0xf1d3b6, 0xe2b48c, 0xc68a63, 0x8d5a3b, 0x5c3a25, 0x3d2517];

/** Metres of travel per full leg cycle. A cycle is two steps (~0.75m each). */
const STRIDE_METRES = 1.5;
/** How long the reach-and-grab takes when an action begins, seconds. */
const GRAB_TIME = 0.5;

export interface PersonRig {
  group: THREE.Group;
  legL: THREE.Object3D;
  legR: THREE.Object3D;
  armL: THREE.Object3D;
  armR: THREE.Object3D;
  torso: THREE.Object3D;
  head: THREE.Object3D;
  /** A book, held in the right hand. Grabbed from a shelf to read. */
  book: THREE.Mesh;
  /** A glass, held in the right hand. */
  glass: THREE.Object3D;
  /** The worn accessory, if any — hidden when a Spy steals it (task, SOW §3). */
  accessory: THREE.Object3D | null;
  /** Random per body, so identical actions don't tick in lockstep. */
  phase: number;
  baseLean: number;

  // ---- animation state, advanced by animatePerson each frame
  /** Accumulated stride angle, driven by distance moved — not by the clock.
   *  This is what stops the feet skating: a foot plants per metre, not per
   *  second, so it stays put on the ground however fast the body travels. */
  stride: number;
  /** The action currently being animated, to detect changes. */
  curAction: number;
  /** Seconds spent in the current action, for the grab/reach-in. */
  actionT: number;
}

/** A rounded limb (capsule) hanging from a pivot at the top, so animatePerson
 *  can swing it with rotation.x exactly as before. Optionally caps the far end
 *  with a hand or a shoe. */
function limb(
  color: number,
  w: number,
  h: number,
  d: number,
  pivotY: number,
  end?: { color: number; kind: "hand" | "shoe" }
): THREE.Group {
  const pivot = new THREE.Group();
  const r = Math.min(w, d) / 2;
  const len = Math.max(0.02, h - 2 * r);
  const mesh = new THREE.Mesh(
    new THREE.CapsuleGeometry(r, len, 2, 6),
    new THREE.MeshStandardMaterial({ color, roughness: 0.8, flatShading: true })
  );
  mesh.position.y = -h / 2;
  mesh.castShadow = true;
  pivot.add(mesh);

  if (end?.kind === "hand") {
    const hand = new THREE.Mesh(
      new THREE.SphereGeometry(r * 1.1, 6, 5),
      new THREE.MeshStandardMaterial({ color: end.color, roughness: 0.85, flatShading: true })
    );
    hand.position.y = -h;
    hand.scale.set(1, 1.25, 0.75);
    hand.castShadow = true;
    pivot.add(hand);
  } else if (end?.kind === "shoe") {
    const shoe = new THREE.Mesh(
      new THREE.BoxGeometry(w * 1.2, 0.08, d * 2.0),
      new THREE.MeshStandardMaterial({ color: end.color, roughness: 0.5, flatShading: true })
    );
    shoe.position.set(0, -h - 0.01, d * 0.55); // toe points forward
    shoe.castShadow = true;
    pivot.add(shoe);
  }

  pivot.position.y = pivotY;
  return pivot;
}

/**
 * A low-poly HEAD, not a ball: an icosahedron elongated a little, tapered below
 * the cheekbones into a jaw and chin, with the face plane flattened. Geometry is
 * centred on its own origin; the caller positions it. flatShading on the
 * material makes the facets read.
 */
function makeHeadGeometry(): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(0.135, 1);
  const p = g.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    v.y *= 1.2; // taller than wide
    if (v.y < 0) {
      // jaw: pull the sides in toward a chin the lower we go
      const t = Math.min(1, -v.y / 0.16);
      const taper = 1 - 0.5 * t;
      v.x *= taper;
      v.z *= taper;
      v.y -= 0.035 * t * t; // extend the chin down
    }
    if (v.z > 0) v.z *= 0.9; // flatten the face
    p.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  return g;
}

/**
 * Short swept hair that hugs the head as a shell: everything below a hairline is
 * collapsed onto that line, and the hairline is HIGH across the forehead and
 * lower at the back and sides — so it never falls over the eyes.
 */
function makeHairGeometry(): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(0.147, 1);
  const p = g.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    v.y *= 1.2;
    const fz = v.z / 0.147; // -1 back .. +1 front
    // high at the front (well above the eyes), low at the back
    const hairline = 0.03 + Math.max(0, fz) * 0.055 - Math.max(0, -fz) * 0.05;
    if (v.y < hairline) {
      v.y = hairline;
      v.x *= 0.95;
      v.z *= 0.95;
    }
    if (v.z > 0) v.z *= 0.9;
    p.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  return g;
}

/**
 * A shaped t-shirt torso, not a slab: a faceted body that's broad at the
 * shoulders and tapers to the waist, flattened front-to-back with a slight
 * chest. Centred on its own origin (y -0.3..+0.3); the caller positions it.
 */
function makeTorsoGeometry(): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(0.21, 0.15, 0.6, 8, 4);
  const p = g.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    v.z *= 0.64; // flatten front-to-back
    if (v.z > 0 && v.y > -0.05) v.z *= 1.18; // a little chest up front
    if (v.y > 0.24) v.x *= 1.05; // square the shoulders off a touch
    p.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  return g;
}

export function buildPerson(look: Look): PersonRig {
  const group = new THREE.Group();

  const scale = 0.86 + (look.height / 255) * 0.34;
  const inner = new THREE.Group();
  inner.scale.setScalar(scale);
  group.add(inner);

  const skin = SKINS[look.skin % SKINS.length];
  const outfit = new THREE.Color().setHSL(
    (look.outfitHue / 255) % 1,
    0.32,
    0.18 + (look.outfitVal / 255) * 0.34
  );
  const trousers = outfit.clone().offsetHSL(0, 0, -0.09);
  const hairColor =
    look.hairHue === 0
      ? new THREE.Color(0xbfbfb8) // grey
      : new THREE.Color().setHSL((look.hairHue / 255) % 1, 0.5, 0.22);

  const skinMat = new THREE.MeshStandardMaterial({ color: skin, roughness: 0.85, flatShading: true });
  const shirtMat = new THREE.MeshStandardMaterial({ color: outfit, roughness: 0.8, flatShading: true });
  const shoeColor = 0x1b1b1f;

  // ---- legs (trousers), slim, ending in shoes
  const legL = limb(trousers.getHex(), 0.15, 0.82, 0.16, 0.82, { color: shoeColor, kind: "shoe" });
  const legR = limb(trousers.getHex(), 0.15, 0.82, 0.16, 0.82, { color: shoeColor, kind: "shoe" });
  legL.position.x = -0.1;
  legR.position.x = 0.1;
  inner.add(legL, legR);

  // ---- torso: a shaped low-poly t-shirt (shoulders -> waist), with a V-neck
  const torso = new THREE.Group();
  torso.position.y = 0.82;
  const chest = new THREE.Mesh(makeTorsoGeometry(), shirtMat);
  chest.position.y = 0.3; // spans hip (0) to shoulders (0.6)
  chest.castShadow = true;
  torso.add(chest);

  // neck (skin, showing above the collar)
  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.07, 0.14, 6), skinMat);
  neck.position.y = 0.585;
  neck.castShadow = true;
  torso.add(neck);

  // V-neck: a small wedge of skin at the throat (apex pointing down)
  const vneck = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.11, 3), skinMat);
  vneck.rotation.x = Math.PI;
  vneck.scale.z = 0.4;
  vneck.position.set(0, 0.52, 0.14);
  torso.add(vneck);

  inner.add(torso);

  // ---- arms: bare skin, with flared short sleeves and hands
  const armL = limb(skin, 0.1, 0.62, 0.11, 0.56, { color: skin, kind: "hand" });
  const armR = limb(skin, 0.1, 0.62, 0.11, 0.56, { color: skin, kind: "hand" });
  armL.position.x = -0.23;
  armR.position.x = 0.23;
  for (const arm of [armL, armR]) {
    // a short cap sleeve, wider at the opening so it flares off the shoulder
    const sleeve = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.1, 0.22, 6), shirtMat);
    sleeve.position.y = -0.09;
    sleeve.castShadow = true;
    arm.add(sleeve);
  }
  torso.add(armL, armR);

  // ---- head: a clean low-poly head. Hair sits ON THE CROWN only, well above
  // the eyes — never over the face.
  const head = new THREE.Group();
  head.position.y = 0.64;

  const skull = new THREE.Mesh(makeHeadGeometry(), skinMat);
  skull.position.y = 0.15;
  skull.castShadow = true;
  head.add(skull);

  // ears
  for (const sx of [-1, 1]) {
    const ear = new THREE.Mesh(new THREE.SphereGeometry(0.026, 5, 4), skinMat);
    ear.scale.set(0.6, 1, 1);
    ear.position.set(sx * 0.118, 0.13, 0);
    head.add(ear);
  }

  // a small nose and understated eyes — no cartoon whites, brows or mouth
  const nose = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.06, 0.05), skinMat);
  nose.position.set(0, 0.115, 0.115);
  head.add(nose);
  const eyeMat = new THREE.MeshStandardMaterial({ color: 0x2a201a, roughness: 0.5, flatShading: true });
  for (const sx of [-1, 1]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.02, 6, 5), eyeMat);
    eye.scale.set(1, 1.25, 0.4);
    eye.position.set(sx * 0.05, 0.145, 0.108);
    head.add(eye);
  }

  // hair: a swept shell hugging the head, hairline high over the forehead
  if (look.hair > 0) {
    const hairMat = new THREE.MeshStandardMaterial({ color: hairColor, roughness: 0.9, flatShading: true });
    const hair = new THREE.Mesh(makeHairGeometry(), hairMat);
    hair.position.copy(skull.position);
    hair.castShadow = true;
    head.add(hair);
  }

  if (look.hat > 0) {
    const hatColor = look.hat === 1 ? 0x22242c : look.hat === 2 ? 0x4a2f22 : 0x6b1f2a;
    const brim = new THREE.Mesh(
      new THREE.CylinderGeometry(0.24, 0.24, 0.02, 12),
      new THREE.MeshStandardMaterial({ color: hatColor, roughness: 0.7 })
    );
    brim.position.y = 0.29;
    brim.castShadow = true;
    head.add(brim);
    const crown = new THREE.Mesh(
      new THREE.CylinderGeometry(0.13, 0.14, 0.16, 12),
      new THREE.MeshStandardMaterial({ color: hatColor, roughness: 0.7 })
    );
    crown.position.y = 0.37;
    crown.castShadow = true;
    head.add(crown);
  }

  torso.add(head);

  // ---- accessories. Some become Spy targets at milestone 7, so they are
  // attached in named, findable places rather than baked into the mesh.
  const gold = new THREE.MeshStandardMaterial({ color: 0xd8b46a, roughness: 0.3, metalness: 0.7 });

  // The accessory is kept as a reference so it can vanish when the Spy steals it
  // (rig.accessory, toggled from the synced acc field). Its shape is the
  // Detective's clue to which guest a task targets.
  let accessory: THREE.Object3D | null = null;
  if (look.acc === 1) {
    const purse = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.12, 0.06), new THREE.MeshStandardMaterial({ color: 0x5a2d3a, roughness: 0.6 }));
    purse.position.y = -0.62;
    purse.castShadow = true;
    armL.add((accessory = purse));
  } else if (look.acc === 2) {
    const necklace = new THREE.Mesh(new THREE.TorusGeometry(0.09, 0.015, 6, 14), gold);
    necklace.rotation.x = Math.PI / 2;
    necklace.position.y = 0.52;
    torso.add((accessory = necklace));
  } else if (look.acc === 3) {
    const monocle = new THREE.Mesh(new THREE.TorusGeometry(0.045, 0.01, 6, 12), gold);
    monocle.position.set(0.07, 0.15, 0.13);
    head.add((accessory = monocle));
  } else if (look.acc === 4) {
    const cane = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 0.9, 6), new THREE.MeshStandardMaterial({ color: 0x3a2418, roughness: 0.6 }));
    cane.position.set(0.06, -0.75, 0.05);
    armR.add((accessory = cane));
  } else if (look.acc === 5) {
    const brooch = new THREE.Mesh(new THREE.SphereGeometry(0.035, 8, 6), gold);
    brooch.position.set(0.15, 0.46, 0.13);
    torso.add((accessory = brooch));
  } else if (look.acc === 6) {
    const watch = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.012, 10), gold);
    watch.rotation.x = Math.PI / 2;
    watch.position.set(-0.1, 0.2, 0.14);
    torso.add((accessory = watch));
  }

  // ---- held objects. Real things now, not a red box: a leather book and a
  // glass, each hidden until grabbed. They live at the end of the right arm.
  const bookColor = new THREE.Color().setHSL(Math.random(), 0.4, 0.28);
  const book = new THREE.Mesh(
    new THREE.BoxGeometry(0.2, 0.26, 0.05),
    new THREE.MeshStandardMaterial({ color: bookColor, roughness: 0.7 })
  );
  const pages = new THREE.Mesh(
    new THREE.BoxGeometry(0.17, 0.23, 0.052),
    new THREE.MeshStandardMaterial({ color: 0xe8e2d0, roughness: 0.9 })
  );
  book.add(pages);
  book.position.set(0, -0.52, 0.17);
  book.castShadow = true;
  book.visible = false;
  armR.add(book);

  const glass = new THREE.Group();
  const cup = new THREE.Mesh(
    new THREE.CylinderGeometry(0.035, 0.026, 0.11, 10),
    new THREE.MeshStandardMaterial({ color: 0xbfe0ea, roughness: 0.12, metalness: 0.05, transparent: true, opacity: 0.5 })
  );
  const wine = new THREE.Mesh(
    new THREE.CylinderGeometry(0.03, 0.022, 0.06, 10),
    new THREE.MeshStandardMaterial({ color: 0x7a1f2b, roughness: 0.3 })
  );
  wine.position.y = -0.02;
  glass.add(cup, wine);
  glass.position.set(0, -0.6, 0.1);
  glass.visible = false;
  armR.add(glass);

  const baseLean = look.age >= 3 ? 0.17 : look.age === 2 ? 0.06 : 0;
  torso.rotation.x = baseLean;

  return {
    group, legL, legR, armL, armR, torso, head, book, glass, accessory,
    phase: Math.random() * Math.PI * 2,
    baseLean,
    stride: 0,
    curAction: -1,
    actionT: 0,
  };
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/**
 * Poses a body for what it's doing.
 *
 * @param speed metres/sec, measured from actual movement rather than taken
 *   from the action — a body being dragged by prediction should still have
 *   legs that keep up with it.
 * @param dt    seconds since last frame, used to advance distance-based stride
 *   and the grab timer.
 */
export function animatePerson(rig: PersonRig, action: number, speed: number, dt: number, t: number) {
  const time = t + rig.phase;
  // Measured speed decides the walk cycle for bodies that can be in motion
  // (walking, or standing idle and getting nudged). But an anchored action —
  // sitting, reading, drinking, and so on — is planted: the body is doing that
  // thing in place, so never let a little residual movement (easing into the
  // seat, a settle that hovers around the threshold) flip it to the walk cycle.
  // That flip is what made seated guests glitch between sitting and walking.
  const planted =
    action === Action.SIT ||
    action === Action.READ ||
    action === Action.DRINK ||
    action === Action.EXAMINE ||
    action === Action.TALK ||
    action === Action.LOOK;
  const walking = !planted && speed > 0.3;

  // Stride advances by DISTANCE, not time. One full cycle per STRIDE_METRES,
  // so a planted foot travels with the ground and never skates.
  rig.stride += (speed * dt * Math.PI * 2) / STRIDE_METRES;
  const stride = walking ? Math.min(speed / 4.2, 1.15) : 0;
  const swing = Math.sin(rig.stride) * 0.6 * stride;

  // Grab timer: reset when the action changes, then count up.
  if (action !== rig.curAction) {
    rig.curAction = action;
    rig.actionT = 0;
  }
  rig.actionT += dt;
  const grab = Math.min(1, rig.actionT / GRAB_TIME); // 0 = just started, 1 = settled

  rig.legL.rotation.x = swing;
  rig.legR.rotation.x = -swing;
  rig.legL.position.y = 0.82;
  rig.legR.position.y = 0.82;
  rig.group.position.y = walking ? Math.abs(Math.sin(rig.stride)) * 0.045 : 0;

  let armLx = -swing * 0.7;
  let armRx = swing * 0.7;
  let leanX = rig.baseLean;
  let bookOn = false;
  let glassOn = false;

  if (!walking) {
    switch (action) {
      case Action.READ: {
        bookOn = true;
        // Reach out to the shelf, then settle the book in to read.
        armLx = lerp(-1.7, -1.35, grab);
        armRx = lerp(-1.7, -1.35, grab);
        leanX = rig.baseLean + 0.1 * grab;
        rig.head.rotation.x = 0.3 * grab + Math.sin(time * 0.7) * 0.03;
        break;
      }
      case Action.DRINK: {
        glassOn = true;
        // Reach to the bar, then occasional gentle sips. Smaller amplitude than
        // before — it was reading as a wave.
        const sip = Math.max(0, Math.sin(time * 0.5)) * grab;
        armRx = lerp(-1.5, -0.55 - sip * 0.6, grab);
        armLx = -0.12;
        rig.head.rotation.x = -sip * 0.12;
        break;
      }
      case Action.EXAMINE: {
        leanX = rig.baseLean + 0.26 * grab;
        armRx = -1.1 + Math.sin(time * 1.3) * 0.08;
        armLx = -0.3;
        rig.head.rotation.x = 0.2 * grab;
        break;
      }
      case Action.TALK: {
        const beat = Math.sin(time * 2.1);
        armRx = -0.45 - Math.max(0, beat) * 0.5;
        armLx = -0.18 + Math.sin(time * 1.7) * 0.12;
        rig.head.rotation.y = Math.sin(time * 1.1) * 0.16;
        rig.head.rotation.x = Math.sin(time * 2.6) * 0.05;
        break;
      }
      case Action.LOOK: {
        armLx = 0.28;
        armRx = 0.28;
        rig.head.rotation.y = Math.sin(time * 0.4) * 0.22;
        leanX = rig.baseLean - 0.03;
        break;
      }
      case Action.SIT: {
        // Sink onto the seat: hips drop, thighs go forward, back stays upright.
        const s = grab;
        rig.group.position.y = -0.34 * s;
        rig.legL.rotation.x = -1.45 * s;
        rig.legR.rotation.x = -1.45 * s;
        // Shift the thigh pivots forward a touch so knees clear the seat edge.
        rig.legL.position.y = 0.82 - 0.06 * s;
        rig.legR.position.y = 0.82 - 0.06 * s;
        armLx = -0.2 * s;
        armRx = -0.2 * s;
        leanX = rig.baseLean + 0.05 * s;
        rig.head.rotation.x = 0;
        break;
      }
      case Action.IDLE:
      default: {
        // Breathing and weight-shifting, so standing still doesn't look frozen
        // — which matters enormously once interviews exist and a genuinely
        // frozen body would be a tell.
        armLx = Math.sin(time * 0.9) * 0.05;
        armRx = Math.sin(time * 0.9 + 1) * 0.05;
        rig.head.rotation.y = Math.sin(time * 0.33) * 0.13;
        leanX = rig.baseLean + Math.sin(time * 1.4) * 0.012;
        break;
      }
    }
  } else {
    // Walking overrides everything.
    rig.head.rotation.set(0, 0, 0);
    leanX = rig.baseLean + 0.06;
  }

  rig.armL.rotation.x = armLx;
  rig.armR.rotation.x = armRx;
  rig.torso.rotation.x = leanX;

  // Objects ease in as they're grabbed, instead of teleporting into the hand.
  rig.book.visible = bookOn;
  rig.glass.visible = glassOn;
  if (bookOn) rig.book.scale.setScalar(grab);
  if (glassOn) rig.glass.scale.setScalar(grab);
}
