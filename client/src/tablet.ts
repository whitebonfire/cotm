import * as THREE from "three";
import { SKINS } from "./person";

/**
 * The Detective's tablet (SOW §4.4).
 *
 * One device, three panels cycled with the arrow keys. Interview and Guess are
 * stubbed rosters at this milestone — the real interview is M5, guessing needs
 * roles at M7 — so the live mechanic here is the camera.
 *
 * The camera's whole point is a trade-off: while you watch its feed you cannot
 * see your own surroundings (SOW §4.2). We honour that literally — when the
 * feed is up, the screen renders from the camera, not from behind the
 * detective, so you really are standing blind in a house with a Spy in it.
 *
 * The feed is rendered by the game's single WebGL renderer from a second
 * camera; the DOM here is only the frame around it. For the roster panels the
 * frame is opaque and hides the world.
 */

const PANELS = ["INTERVIEW", "CAMERA", "GUESS"] as const;
export const CAMERA_PANEL = 1;

const ACC_NAME = ["", "a purse", "a necklace", "a monocle", "a cane", "a brooch", "a pocket-watch"];
const AGE_NAME = ["late twenties", "forties", "sixties", "elderly"];

export interface RosterEntry {
  id: string;
  name: string;
  skin: number;
  age: number;
  acc: number;
}

export class Tablet {
  up = false;
  panel = CAMERA_PANEL;
  hasCamera = false;

  readonly feedCam: THREE.PerspectiveCamera;

  private marker: THREE.Group;
  private root!: HTMLDivElement;
  private tabsEl!: HTMLDivElement;
  private screenEl!: HTMLDivElement;
  private roster: RosterEntry[] = [];
  private myId = "";

  constructor(scene: THREE.Scene) {
    this.feedCam = new THREE.PerspectiveCamera(64, 1, 0.1, 260);
    this.marker = buildMarker();
    this.marker.visible = false;
    scene.add(this.marker);
    this.buildDom();
    this.render();
  }

  /** Feed is being watched right now — the caller should render from feedCam. */
  get feedActive(): boolean {
    return this.up && this.panel === CAMERA_PANEL && this.hasCamera;
  }

  setAspect(aspect: number) {
    this.feedCam.aspect = aspect;
    this.feedCam.updateProjectionMatrix();
  }

  toggle() {
    this.up = !this.up;
    this.render();
  }

  close() {
    if (!this.up) return;
    this.up = false;
    this.render();
  }

  cycle(dir: number) {
    if (!this.up) return;
    this.panel = (this.panel + dir + PANELS.length) % PANELS.length;
    this.render();
  }

  /** Drop (or move) the camera to a spot, looking along a forward vector. */
  place(x: number, z: number, forwardX: number, forwardZ: number) {
    // Sit the lens just in front of and above its own tripod, so the marker
    // isn't a dark blur in the corner of its own feed.
    this.feedCam.position.set(x + forwardX * 0.2, 1.85, z + forwardZ * 0.2);
    this.feedCam.lookAt(x + forwardX * 6, 1.15, z + forwardZ * 6);

    this.marker.position.set(x, 0, z);
    this.marker.rotation.y = Math.atan2(forwardX, forwardZ);
    this.marker.visible = true;
    this.hasCamera = true;
    if (this.up) this.render();
  }

  setRoster(entries: RosterEntry[], myId: string) {
    this.roster = entries;
    this.myId = myId;
    if (this.up && this.panel !== CAMERA_PANEL) this.render();
  }

  // ---- DOM

  private buildDom() {
    const root = document.createElement("div");
    root.id = "tablet";
    root.innerHTML = `
      <div class="frame">
        <div class="tabs"></div>
        <div class="screen"></div>
        <div class="foot"><kbd>◀</kbd> <kbd>▶</kbd> switch panel &middot; <kbd>Q</kbd> lower tablet</div>
      </div>`;
    document.body.appendChild(root);
    this.root = root;
    this.tabsEl = root.querySelector(".tabs") as HTMLDivElement;
    this.screenEl = root.querySelector(".screen") as HTMLDivElement;
  }

  private render() {
    this.root.classList.toggle("hidden", !this.up);
    // Opaque frame for the roster panels; transparent so the live feed shows
    // through for the camera panel.
    this.root.classList.toggle("opaque", !this.feedActive);

    this.tabsEl.innerHTML = PANELS.map(
      (name, i) => `<span class="${i === this.panel ? "active" : ""}">${name}</span>`
    ).join('<em>·</em>');

    if (this.panel === CAMERA_PANEL) {
      this.screenEl.innerHTML = this.hasCamera
        ? `<div class="feedtag">● LIVE</div>`
        : `<div class="empty">No camera placed.<br /><span>Lower the tablet and press <kbd>F</kbd> to drop one where you stand.</span></div>`;
      return;
    }

    // Interview / Guess: the roster, with the action stubbed for its milestone.
    const isInterview = this.panel === 0;
    const note = isInterview
      ? `Interviews arrive next milestone — pick someone and read what they type.`
      : `Guessing unlocks once roles are dealt.`;

    const rows = this.roster
      .map((e) => {
        const swatch = `#${new THREE.Color(SKINS[e.skin % SKINS.length]).getHexString()}`;
        const you = e.id === this.myId ? ` <em>(you)</em>` : "";
        const detail = [AGE_NAME[e.age] ?? "", e.acc ? `with ${ACC_NAME[e.acc]}` : ""]
          .filter(Boolean)
          .join(", ");
        return `<li>
            <span class="face" style="background:${swatch}"></span>
            <span class="who"><b>${e.name}</b>${you}<span class="detail">${detail}</span></span>
            <button disabled>${isInterview ? "Interview" : "Accuse"}</button>
          </li>`;
      })
      .join("");

    this.screenEl.innerHTML = `<div class="note">${note}</div><ul class="roster">${rows}</ul>`;
  }
}

/** A little tripod camera left in the room, so the device is a physical object. */
function buildMarker(): THREE.Group {
  const g = new THREE.Group();
  const metal = new THREE.MeshStandardMaterial({ color: 0x2a2d34, roughness: 0.5, metalness: 0.4 });

  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 1.5, 8), metal);
  pole.position.y = 0.75;
  pole.castShadow = true;
  g.add(pole);

  const head = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.16, 0.16), metal);
  head.position.y = 1.55;
  head.castShadow = true;
  g.add(head);

  // Lens, pointing +z (the marker is rotated so +z is the view direction).
  const lens = new THREE.Mesh(
    new THREE.CylinderGeometry(0.05, 0.06, 0.08, 12),
    new THREE.MeshStandardMaterial({ color: 0x11141a, roughness: 0.2, metalness: 0.6 })
  );
  lens.rotation.x = Math.PI / 2;
  lens.position.set(0, 1.55, 0.12);
  g.add(lens);

  // A red tally light, so it reads as "recording".
  const tally = new THREE.Mesh(
    new THREE.SphereGeometry(0.02, 8, 6),
    new THREE.MeshStandardMaterial({ color: 0xff3b3b, emissive: 0xff2020, emissiveIntensity: 1.4 })
  );
  tally.position.set(0.08, 1.62, 0.05);
  g.add(tally);

  // Splayed legs.
  const legMat = metal;
  for (let i = 0; i < 3; i++) {
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 0.55, 6), legMat);
    const a = (i / 3) * Math.PI * 2;
    leg.position.set(Math.sin(a) * 0.14, 0.22, Math.cos(a) * 0.14);
    leg.rotation.z = Math.sin(a) * 0.4;
    leg.rotation.x = -Math.cos(a) * 0.4;
    g.add(leg);
  }

  return g;
}
