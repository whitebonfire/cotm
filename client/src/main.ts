import * as THREE from "three";
import { Client, getStateCallbacks } from "colyseus.js";
import type { Room } from "colyseus.js";
import type { HouseState, Player } from "../../server/src/schema/GameState";
import { resolveCollisions, roomAt } from "../../server/src/world/house";
import { buildHouse, buildRoomLabels } from "./house";

/** Must match HouseRoom.ts, or prediction fights the server. */
const SPEED = 4.2;

const EYE = 1.25;
const CAM_DIST = 6.0;
const CAM_MIN = 1.1;

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

// Moonlight through the (imaginary) roof. This is the only shadow caster.
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
buildRoomLabels(scene);

// ---------------------------------------------------------------- avatars

interface Avatar {
  group: THREE.Group;
  player: Player;
  target: THREE.Vector3;
}

const avatars = new Map<string, Avatar>();

function makeAvatar(hue: number, isSelf: boolean): THREE.Group {
  const group = new THREE.Group();
  const color = new THREE.Color().setHSL(hue / 360, isSelf ? 0.5 : 0.32, isSelf ? 0.62 : 0.48);

  const body = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.36, 1.05, 6, 14),
    new THREE.MeshStandardMaterial({ color, roughness: 0.62 })
  );
  body.position.y = 0.9;
  body.castShadow = true;
  group.add(body);

  // Nose points +Z. Server sends yaw = atan2(dx, dz), so rotation.y = yaw aims
  // this the way the body is actually moving.
  const nose = new THREE.Mesh(
    new THREE.ConeGeometry(0.11, 0.3, 10),
    new THREE.MeshStandardMaterial({ color: 0xe8e6e1, roughness: 0.5 })
  );
  nose.rotation.x = Math.PI / 2;
  nose.position.set(0, 1.18, 0.36);
  nose.castShadow = true;
  group.add(nose);

  return group;
}

// ---------------------------------------------------------------- input

const keys = new Set<string>();
let camYaw = Math.PI;
let camPitch = 0.3;
let locked = false;

window.addEventListener("keydown", (e) => {
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
  camPitch = Math.max(-0.2, Math.min(1.1, camPitch - e.movementY * 0.0022));
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

/** Predicted local position. Server still owns the truth; this just hides RTT. */
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

function wire(room: Room<HouseState>) {
  const $ = getStateCallbacks(room);

  $(room.state).players.onAdd((player: Player, sessionId: string) => {
    const isSelf = sessionId === room.sessionId;
    const group = makeAvatar(player.hue, isSelf);
    group.position.set(player.x, player.y, player.z);
    scene.add(group);

    avatars.set(sessionId, { group, player, target: new THREE.Vector3(player.x, player.y, player.z) });

    if (isSelf) {
      localPos.set(player.x, player.y, player.z);
      localYaw = player.yaw;
    }
  });

  $(room.state).players.onRemove((_player: Player, sessionId: string) => {
    const avatar = avatars.get(sessionId);
    if (!avatar) return;
    scene.remove(avatar.group);
    avatars.delete(sessionId);
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

function currentInput() {
  const f = (keys.has("KeyW") ? 1 : 0) - (keys.has("KeyS") ? 1 : 0);
  const r = (keys.has("KeyD") ? 1 : 0) - (keys.has("KeyA") ? 1 : 0);
  return { f, r, yaw: camYaw };
}

function tick() {
  requestAnimationFrame(tick);
  const dt = Math.min(clock.getDelta(), 0.1);

  const input = currentInput();

  // Send intent at 20Hz. Never a position — the server decides where we are.
  if (room) {
    sendAccum += dt;
    if (sendAccum >= 0.05) {
      sendAccum = 0;
      room.send("input", input);
    }
  }

  const self = room ? avatars.get(room.sessionId) : undefined;

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

      // Same walls, same maths as the server. If these ever diverge, this is
      // where the rubber-banding starts.
      const solved = resolveCollisions(localPos.x + dx, localPos.z + dz);
      localPos.x = solved.x;
      localPos.z = solved.z;
      localYaw = Math.atan2(dx, dz);
    }

    const server = self.player;
    const drift = Math.hypot(localPos.x - server.x, localPos.z - server.z);
    if (drift > 2) {
      localPos.set(server.x, server.y, server.z);
    } else if (drift > 0.02) {
      const k = 1 - Math.pow(0.0001, dt);
      localPos.x += (server.x - localPos.x) * k;
      localPos.z += (server.z - localPos.z) * k;
    }

    self.group.position.copy(localPos);
    self.group.rotation.y = localYaw;
  }

  // Remote avatars: ease toward the last state we were sent.
  avatars.forEach((avatar, sessionId) => {
    if (room && sessionId === room.sessionId) return;
    avatar.target.set(avatar.player.x, avatar.player.y, avatar.player.z);
    avatar.group.position.lerp(avatar.target, 1 - Math.pow(0.0015, dt));

    let delta = avatar.player.yaw - avatar.group.rotation.y;
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;
    avatar.group.rotation.y += delta * (1 - Math.pow(0.0015, dt));
  });

  // ---- third-person camera, pulled in so it doesn't sit inside a wall
  focusPoint.set(localPos.x, localPos.y + EYE, localPos.z);

  const cosP = Math.cos(camPitch);
  camDir.set(Math.sin(camYaw) * cosP, Math.sin(camPitch), Math.cos(camYaw) * cosP).normalize();

  let dist = CAM_DIST;
  raycaster.set(focusPoint, camDir);
  raycaster.far = CAM_DIST;
  const hits = raycaster.intersectObjects(colliders, false);
  if (hits.length > 0) {
    dist = Math.max(CAM_MIN, hits[0].distance - 0.32);
  }

  camera.position.copy(focusPoint).addScaledVector(camDir, dist);
  camera.lookAt(focusPoint);

  if (room) {
    const here = roomAt(localPos.x, localPos.z);
    hud.innerHTML = [
      `<b>🔎 clues of the mind</b> — milestone 2`,
      `<b>${here?.name ?? "…"}</b>`,
      `room ${room.roomId} · you are <b>${self?.player.name ?? "…"}</b> · <b>${avatars.size}</b> here`,
      locked ? `` : `<b>click</b> to look around`,
    ].join("<br />");
  }

  renderer.render(scene, camera);
}

tick();
