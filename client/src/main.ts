import * as THREE from "three";
import { Client, getStateCallbacks } from "colyseus.js";
import type { Room } from "colyseus.js";
import type { HouseState, Person } from "../../server/src/schema/GameState";
import { Action, SPEED, resolveCollisions, roomAt } from "../../server/src/world/house";
import { buildHouse, buildRoomLabels, buildFurniture } from "./house";
import { buildPerson, animatePerson, type PersonRig } from "./person";

const EYE = 1.25;
const CAM_DIST = 6.0;
const CAM_MIN = 1.1;

const ACTION_NAME: Record<number, string> = {
  [Action.IDLE]: "standing about",
  [Action.WALK]: "walking",
  [Action.READ]: "reading",
  [Action.DRINK]: "drinking",
  [Action.EXAMINE]: "examining",
  [Action.TALK]: "talking",
  [Action.LOOK]: "looking out",
};

// ---------------------------------------------------------------- scene

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x090b0f);
scene.fog = new THREE.Fog(0x090b0f, 30, 78);

const camera = new THREE.PerspectiveCamera(58, window.innerWidth / window.innerHeight, 0.1, 260);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);

scene.add(new THREE.HemisphereLight(0x5f6b86, 0x1a1712, 0.55));

const key = new THREE.DirectionalLight(0xaebfe0, 0.75);
key.position.set(14, 26, 10);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
key.shadow.camera.left = -30;
key.shadow.camera.right = 30;
key.shadow.camera.top = 26;
key.shadow.camera.bottom = -26;
key.shadow.camera.far = 70;
key.shadow.bias = -0.0012;
scene.add(key);

const { colliders } = buildHouse(scene);
buildFurniture(scene);
buildRoomLabels(scene);

// ---------------------------------------------------------------- bodies

interface Body {
  rig: PersonRig;
  person: Person;
  /** Where the server last said they are. */
  target: THREE.Vector3;
  /** Smoothed metres/sec, for the walk cycle. */
  speed: number;
  prev: THREE.Vector3;
}

const bodies = new Map<string, Body>();

/** Which body is mine. Told to me by the server; nobody else's is knowable. */
let myBody: string | null = null;

/** A faint ring under my own feet — client-side only, never a state field. */
const selfRing = new THREE.Mesh(
  new THREE.RingGeometry(0.42, 0.52, 24),
  new THREE.MeshBasicMaterial({ color: 0xd8b46a, transparent: true, opacity: 0.5, side: THREE.DoubleSide })
);
selfRing.rotation.x = -Math.PI / 2;
selfRing.position.y = 0.03;
selfRing.visible = false;
scene.add(selfRing);

// ---------------------------------------------------------------- input

const keys = new Set<string>();
let camYaw = Math.PI;
let camPitch = 0.3;
let locked = false;

window.addEventListener("keydown", (e) => {
  if (!keys.has(e.code) && e.code === "KeyE" && room) room.send("act");
  keys.add(e.code);
  if (e.code === "Space") e.preventDefault();
});
window.addEventListener("keyup", (e) => keys.delete(e.code));
window.addEventListener("blur", () => keys.clear());

renderer.domElement.addEventListener("click", () => {
  if (room && !locked) renderer.domElement.requestPointerLock();
});

document.addEventListener("pointerlockchange", () => {
  locked = document.pointerLockElement === renderer.domElement;
});

document.addEventListener("mousemove", (e) => {
  if (!locked) return;
  camYaw -= e.movementX * 0.0026;
  // Mouse up => look up. camPitch is the camera's height above the shoulder,
  // so pushing up must LOWER the camera to tilt the view skyward.
  camPitch = Math.max(-0.35, Math.min(1.15, camPitch + e.movementY * 0.0022));
});

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ---------------------------------------------------------------- net

const endpoint = import.meta.env.DEV
  ? "ws://localhost:2567"
  : `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`;

let room: Room<HouseState> | null = null;

const localPos = new THREE.Vector3();
let localYaw = Math.PI;

const overlay = document.getElementById("overlay") as HTMLDivElement;
const playBtn = document.getElementById("play") as HTMLButtonElement;
const hud = document.getElementById("hud") as HTMLDivElement;

playBtn.disabled = false;
playBtn.textContent = "ENTER THE HOUSE";

playBtn.addEventListener("click", async () => {
  playBtn.disabled = true;
  playBtn.textContent = "connecting…";
  try {
    const client = new Client(endpoint);
    room = await client.joinOrCreate<HouseState>("house", {
      name: localStorage.getItem("cotm:name") ?? "",
    });
    wire(room);
    overlay.classList.add("hidden");
    renderer.domElement.requestPointerLock();
  } catch (err) {
    console.error(err);
    playBtn.disabled = false;
    playBtn.textContent = "retry";
    hud.innerHTML = `<b>connection failed</b><br />${String(err)}`;
  }
});

function addBody(person: Person, id: string) {
  const rig = buildPerson({
    skin: person.skin,
    hair: person.hair,
    hairHue: person.hairHue,
    outfitHue: person.outfitHue,
    outfitVal: person.outfitVal,
    age: person.age,
    hat: person.hat,
    acc: person.acc,
    height: person.height,
  });
  rig.group.position.set(person.x, person.y, person.z);
  rig.group.rotation.y = person.yaw;
  scene.add(rig.group);

  bodies.set(id, {
    rig,
    person,
    target: new THREE.Vector3(person.x, person.y, person.z),
    speed: 0,
    prev: new THREE.Vector3(person.x, person.y, person.z),
  });
}

function wire(room: Room<HouseState>) {
  const $ = getStateCallbacks(room);

  room.onMessage("you", (msg: { body: string; name: string }) => {
    myBody = msg.body;
    selfRing.visible = true;
    const mine = bodies.get(msg.body);
    if (mine) {
      localPos.set(mine.person.x, mine.person.y, mine.person.z);
      localYaw = mine.person.yaw;
    }
  });

  $(room.state).people.onAdd((person: Person, id: string) => {
    addBody(person, id);
    if (id === myBody) {
      localPos.set(person.x, person.y, person.z);
      localYaw = person.yaw;
    }
  });

  $(room.state).people.onRemove((_person: Person, id: string) => {
    const body = bodies.get(id);
    if (!body) return;
    scene.remove(body.rig.group);
    bodies.delete(id);
  });

  room.onLeave((code) => {
    hud.innerHTML = `<b>disconnected</b> (code ${code})`;
    overlay.classList.remove("hidden");
    playBtn.disabled = false;
    playBtn.textContent = "rejoin";
  });
}

// ---------------------------------------------------------------- loop

const clock = new THREE.Clock();
const raycaster = new THREE.Raycaster();
const focusPoint = new THREE.Vector3();
const camDir = new THREE.Vector3();
let sendAccum = 0;
let elapsed = 0;

function currentInput() {
  const f = (keys.has("KeyW") ? 1 : 0) - (keys.has("KeyS") ? 1 : 0);
  const r = (keys.has("KeyD") ? 1 : 0) - (keys.has("KeyA") ? 1 : 0);
  return { f, r, yaw: camYaw };
}

function tick() {
  requestAnimationFrame(tick);
  const dt = Math.min(clock.getDelta(), 0.1);
  elapsed += dt;

  const input = currentInput();

  if (room) {
    sendAccum += dt;
    if (sendAccum >= 0.05) {
      sendAccum = 0;
      room.send("input", input);
    }
  }

  const self = myBody ? bodies.get(myBody) : undefined;

  if (self) {
    const forwardX = -Math.sin(camYaw);
    const forwardZ = -Math.cos(camYaw);
    const rightX = Math.cos(camYaw);
    const rightZ = -Math.sin(camYaw);

    let dx = forwardX * input.f + rightX * input.r;
    let dz = forwardZ * input.f + rightZ * input.r;
    const len = Math.hypot(dx, dz);

    if (len > 0.001) {
      dx = (dx / len) * SPEED * dt;
      dz = (dz / len) * SPEED * dt;

      const solved = resolveCollisions(localPos.x + dx, localPos.z + dz);
      localPos.x = solved.x;
      localPos.z = solved.z;
      localYaw = Math.atan2(dx, dz);
    }

    const server = self.person;
    const drift = Math.hypot(localPos.x - server.x, localPos.z - server.z);
    if (drift > 2) {
      localPos.set(server.x, server.y, server.z);
    } else if (drift > 0.02) {
      const k = 1 - Math.pow(0.0001, dt);
      localPos.x += (server.x - localPos.x) * k;
      localPos.z += (server.z - localPos.z) * k;
    }

    self.rig.group.position.copy(localPos);
    // Server owns facing while performing an action (it aims you at the shelf),
    // but movement is predicted, so use the local yaw only while walking.
    self.rig.group.rotation.y = len > 0.001 ? localYaw : server.yaw;

    selfRing.position.set(localPos.x, 0.03, localPos.z);
  }

  // ---- everyone else eases toward the last state we were sent
  bodies.forEach((body, id) => {
    if (id !== myBody) {
      body.target.set(body.person.x, body.person.y, body.person.z);
      body.rig.group.position.lerp(body.target, 1 - Math.pow(0.0015, dt));

      let delta = body.person.yaw - body.rig.group.rotation.y;
      while (delta > Math.PI) delta -= Math.PI * 2;
      while (delta < -Math.PI) delta += Math.PI * 2;
      body.rig.group.rotation.y += delta * (1 - Math.pow(0.0015, dt));
    }

    // Measure real speed from the rendered position rather than trusting the
    // action field — a body being eased toward a distant target should have
    // legs that keep up with where it's actually going.
    const moved = body.rig.group.position.distanceTo(body.prev) / Math.max(dt, 0.001);
    body.speed += (moved - body.speed) * Math.min(1, dt * 9);
    body.prev.copy(body.rig.group.position);

    animatePerson(body.rig, body.person.action, body.speed, elapsed);
  });

  // ---- third-person camera
  focusPoint.set(localPos.x, localPos.y + EYE, localPos.z);

  const cosP = Math.cos(camPitch);
  camDir.set(Math.sin(camYaw) * cosP, Math.sin(camPitch), Math.cos(camYaw) * cosP).normalize();

  let dist = CAM_DIST;
  raycaster.set(focusPoint, camDir);
  raycaster.far = CAM_DIST;
  const hits = raycaster.intersectObjects(colliders, false);
  if (hits.length > 0) dist = Math.max(CAM_MIN, hits[0].distance - 0.32);

  camera.position.copy(focusPoint).addScaledVector(camDir, dist);
  camera.position.y = Math.max(0.35, camera.position.y);
  camera.lookAt(focusPoint);

  if (room) {
    const here = roomAt(localPos.x, localPos.z);
    const doing = self ? ACTION_NAME[self.person.action] ?? "" : "";
    hud.innerHTML = [
      `<b>🔎 clues of the mind</b> — milestone 3`,
      `<b>${here?.name ?? "…"}</b> · ${bodies.size} guests`,
      `you are <b>${self?.person.name ?? "…"}</b>, ${doing}`,
      locked ? `<b>E</b> to join in at a spot` : `<b>click</b> to look around`,
    ].join("<br />");
  }

  renderer.render(scene, camera);
}

tick();
