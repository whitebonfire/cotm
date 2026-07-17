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

const SKINS = [0xf1d3b6, 0xe2b48c, 0xc68a63, 0x8d5a3b, 0x5c3a25, 0x3d2517];

export interface PersonRig {
  group: THREE.Group;
  legL: THREE.Object3D;
  legR: THREE.Object3D;
  armL: THREE.Object3D;
  armR: THREE.Object3D;
  torso: THREE.Object3D;
  head: THREE.Object3D;
  /** Whatever they're holding — book, glass, jewel. Hidden unless in use. */
  prop: THREE.Mesh;
  /** Random per body, so identical actions don't tick in lockstep. */
  phase: number;
  /** Stooping elders lean; kept here so animation doesn't fight the base pose. */
  baseLean: number;
}

function limb(color: number, w: number, h: number, d: number, pivotY: number): THREE.Group {
  const pivot = new THREE.Group();
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(w, h, d),
    new THREE.MeshStandardMaterial({ color, roughness: 0.75 })
  );
  mesh.position.y = -h / 2;
  mesh.castShadow = true;
  pivot.add(mesh);
  pivot.position.y = pivotY;
  return pivot;
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

  // ---- legs
  const legL = limb(trousers.getHex(), 0.17, 0.78, 0.19, 0.82);
  const legR = limb(trousers.getHex(), 0.17, 0.78, 0.19, 0.82);
  legL.position.x = -0.11;
  legR.position.x = 0.11;
  inner.add(legL, legR);

  // ---- torso
  const torso = new THREE.Group();
  torso.position.y = 0.82;
  const chest = new THREE.Mesh(
    new THREE.BoxGeometry(0.46, 0.62, 0.26),
    new THREE.MeshStandardMaterial({ color: outfit, roughness: 0.7 })
  );
  chest.position.y = 0.31;
  chest.castShadow = true;
  torso.add(chest);
  inner.add(torso);

  // ---- arms, hung from the shoulders
  const armL = limb(outfit.getHex(), 0.12, 0.6, 0.14, 0.56);
  const armR = limb(outfit.getHex(), 0.12, 0.6, 0.14, 0.56);
  armL.position.x = -0.29;
  armR.position.x = 0.29;
  torso.add(armL, armR);

  // ---- head
  const head = new THREE.Group();
  head.position.y = 0.64;
  const skull = new THREE.Mesh(
    new THREE.BoxGeometry(0.26, 0.28, 0.25),
    new THREE.MeshStandardMaterial({ color: skin, roughness: 0.8 })
  );
  skull.position.y = 0.14;
  skull.castShadow = true;
  head.add(skull);

  // Nose, so a body's facing is readable across a room.
  const nose = new THREE.Mesh(
    new THREE.BoxGeometry(0.05, 0.05, 0.06),
    new THREE.MeshStandardMaterial({ color: skin, roughness: 0.8 })
  );
  nose.position.set(0, 0.13, 0.14);
  head.add(nose);

  if (look.hair > 0) {
    const hair = new THREE.Mesh(
      new THREE.BoxGeometry(0.28, look.hair === 1 ? 0.08 : 0.14, 0.27),
      new THREE.MeshStandardMaterial({ color: hairColor, roughness: 0.9 })
    );
    hair.position.y = look.hair === 1 ? 0.26 : 0.24;
    hair.castShadow = true;
    head.add(hair);

    if (look.hair >= 3) {
      // Longer hair down the back.
      const back = new THREE.Mesh(
        new THREE.BoxGeometry(0.26, 0.22, 0.08),
        new THREE.MeshStandardMaterial({ color: hairColor, roughness: 0.9 })
      );
      back.position.set(0, 0.08, -0.13);
      head.add(back);
    }
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

  // ---- accessories. Some of these become Spy targets at milestone 7, so they
  // are attached in named, findable places rather than baked into the mesh.
  const gold = new THREE.MeshStandardMaterial({ color: 0xd8b46a, roughness: 0.3, metalness: 0.7 });

  if (look.acc === 1) {
    // purse, hanging from the left hand
    const purse = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.12, 0.06), new THREE.MeshStandardMaterial({ color: 0x5a2d3a, roughness: 0.6 }));
    purse.position.y = -0.62;
    purse.castShadow = true;
    armL.add(purse);
  } else if (look.acc === 2) {
    const necklace = new THREE.Mesh(new THREE.TorusGeometry(0.09, 0.015, 6, 14), gold);
    necklace.rotation.x = Math.PI / 2;
    necklace.position.y = 0.52;
    torso.add(necklace);
  } else if (look.acc === 3) {
    const monocle = new THREE.Mesh(new THREE.TorusGeometry(0.045, 0.01, 6, 12), gold);
    monocle.position.set(0.07, 0.15, 0.13);
    head.add(monocle);
  } else if (look.acc === 4) {
    const cane = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 0.9, 6), new THREE.MeshStandardMaterial({ color: 0x3a2418, roughness: 0.6 }));
    cane.position.set(0.06, -0.75, 0.05);
    armR.add(cane);
  } else if (look.acc === 5) {
    const brooch = new THREE.Mesh(new THREE.SphereGeometry(0.035, 8, 6), gold);
    brooch.position.set(0.15, 0.46, 0.13);
    torso.add(brooch);
  } else if (look.acc === 6) {
    const watch = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.012, 10), gold);
    watch.rotation.x = Math.PI / 2;
    watch.position.set(-0.1, 0.2, 0.14);
    torso.add(watch);
  }

  // ---- held prop, shown only for the action that needs it
  const prop = new THREE.Mesh(
    new THREE.BoxGeometry(0.16, 0.2, 0.05),
    new THREE.MeshStandardMaterial({ color: 0x8a2f2f, roughness: 0.7 })
  );
  prop.position.set(0, -0.5, 0.16);
  prop.visible = false;
  prop.castShadow = true;
  armR.add(prop);

  // Elderly guests stoop.
  const baseLean = look.age >= 3 ? 0.17 : look.age === 2 ? 0.06 : 0;
  torso.rotation.x = baseLean;

  return { group, legL, legR, armL, armR, torso, head, prop, phase: Math.random() * Math.PI * 2, baseLean };
}

/**
 * Poses a body for what it's doing.
 *
 * @param speed metres/sec, measured from actual movement rather than taken
 *   from the action — a body being dragged by prediction should still have
 *   legs that keep up with it.
 */
export function animatePerson(rig: PersonRig, action: number, speed: number, t: number) {
  const time = t + rig.phase;
  const walking = speed > 0.3;

  // Legs and arms swing to the pace of actual movement.
  const stride = walking ? Math.min(speed / 4.2, 1.2) : 0;
  const swing = Math.sin(time * 9) * 0.62 * stride;

  rig.legL.rotation.x = swing;
  rig.legR.rotation.x = -swing;
  rig.group.position.y = walking ? Math.abs(Math.sin(time * 9)) * 0.045 : 0;

  let armSwing = -swing * 0.7;
  let leanX = rig.baseLean;
  let propVisible = false;
  let armLx = armSwing;
  let armRx = -armSwing;

  switch (action) {
    case Action.READ: {
      // Book held up, head tipped down to it.
      propVisible = true;
      armLx = -1.35;
      armRx = -1.35;
      leanX = rig.baseLean + 0.1;
      rig.head.rotation.x = 0.3 + Math.sin(time * 0.7) * 0.03;
      break;
    }
    case Action.DRINK: {
      // Periodic sip rather than a permanent raised glass.
      propVisible = true;
      const sip = Math.max(0, Math.sin(time * 0.55));
      armRx = -0.5 - sip * 1.0;
      armLx = -0.12;
      rig.head.rotation.x = -sip * 0.16;
      break;
    }
    case Action.EXAMINE: {
      leanX = rig.baseLean + 0.26;
      armRx = -1.15 + Math.sin(time * 1.3) * 0.08;
      armLx = -0.3;
      rig.head.rotation.x = 0.2;
      break;
    }
    case Action.TALK: {
      // Gesturing, and a head that moves while the mouth theoretically does.
      const beat = Math.sin(time * 2.1);
      armRx = -0.45 - Math.max(0, beat) * 0.5;
      armLx = -0.18 + Math.sin(time * 1.7) * 0.12;
      rig.head.rotation.y = Math.sin(time * 1.1) * 0.16;
      rig.head.rotation.x = Math.sin(time * 2.6) * 0.05;
      break;
    }
    case Action.LOOK: {
      // Watching the city. Slow sway, hands behind the back.
      armLx = 0.28;
      armRx = 0.28;
      rig.head.rotation.y = Math.sin(time * 0.4) * 0.22;
      leanX = rig.baseLean - 0.03;
      break;
    }
    case Action.IDLE:
    default: {
      if (!walking) {
        // Breathing and a bit of weight-shifting, so standing still doesn't
        // look like a freeze — which will matter enormously once interviews
        // exist and a genuinely frozen body would be a tell.
        armLx = Math.sin(time * 0.9) * 0.05;
        armRx = Math.sin(time * 0.9 + 1) * 0.05;
        rig.head.rotation.y = Math.sin(time * 0.33) * 0.13;
        leanX = rig.baseLean + Math.sin(time * 1.4) * 0.012;
      }
      break;
    }
  }

  if (walking) {
    rig.head.rotation.x = 0;
    rig.head.rotation.y = 0;
    armLx = armSwing;
    armRx = -armSwing;
    propVisible = false;
    leanX = rig.baseLean + 0.06;
  }

  rig.armL.rotation.x = armLx;
  rig.armR.rotation.x = armRx;
  rig.torso.rotation.x = leanX;
  rig.prop.visible = propVisible;

  if (propVisible) {
    // Book vs glass — same slot, different object.
    const isBook = action === Action.READ;
    rig.prop.scale.set(isBook ? 1 : 0.4, isBook ? 1 : 0.5, isBook ? 1 : 0.4);
  }
}
