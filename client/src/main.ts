import * as THREE from "three";
import { Client, getStateCallbacks } from "colyseus.js";
import type { Room } from "colyseus.js";
import type { HouseState, Player } from "../../server/src/schema/GameState";

/** Must match HouseRoom.ts, or prediction fights the server. */
const SPEED = 4.2;
const BOUND = 19;

const EYE = 1.25;
const CAM_DIST = 6.5;

// ---------------------------------------------------------------- scene

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0d0f14);
scene.fog = new THREE.Fog(0x0d0f14, 22, 52);

const camera = new THREE.PerspectiveCamera(58, window.innerWidth / window.innerHeight, 0.1, 200);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);

scene.add(new THREE.HemisphereLight(0x8899bb, 0x24201c, 1.1));

const key = new THREE.DirectionalLight(0xffe9c4, 1.5);
key.position.set(8, 16, 6);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
key.shadow.camera.left = -26;
key.shadow.camera.right = 26;
key.shadow.camera.top = 26;
key.shadow.camera.bottom = -26;
scene.add(key);

// Floor
const floor = new THREE.Mesh(
  new THREE.PlaneGeometry(BOUND * 2, BOUND * 2),
  new THREE.MeshStandardMaterial({ color: 0x2a2f3a, roughness: 0.95 })
);
floor.rotation.x = -Math.PI / 2;
floor.receiveShadow = true;
scene.add(floor);

const grid = new THREE.GridHelper(BOUND * 2, BOUND * 2, 0x3d4453, 0x333a47);
(grid.material as THREE.Material).transparent = true;
(grid.material as THREE.Material).opacity = 0.35;
grid.position.y = 0.01;
scene.add(grid);

// Walls — just so the bounds are legible and there's something to walk up to.
const wallMat = new THREE.MeshStandardMaterial({ color: 0x333947, roughness: 0.9 });
const WALL_H = 3;
for (let i = 0; i < 4; i++) {
  const horizontal = i % 2 === 0;
  const wall = new THREE.Mesh(
    new THREE.BoxGeometry(horizontal ? BOUND * 2 + 0.4 : 0.4, WALL_H, horizontal ? 0.4 : BOUND * 2 + 0.4),
    wallMat
  );
  wall.position.set(
    horizontal ? 0 : (i === 1 ? BOUND : -BOUND),
    WALL_H / 2,
    horizontal ? (i === 0 ? -BOUND : BOUND) : 0
  );
  wall.castShadow = true;
  wall.receiveShadow = true;
  scene.add(wall);
}

// ---------------------------------------------------------------- avatars

interface Avatar {
  group: THREE.Group;
  player: Player;
  /** Where the server says they are. Remote avatars ease toward this. */
  target: THREE.Vector3;
}

const avatars = new Map<string, Avatar>();

function makeAvatar(hue: number, isSelf: boolean): THREE.Group {
  const group = new THREE.Group();
  const color = new THREE.Color().setHSL(hue / 360, isSelf ? 0.55 : 0.35, isSelf ? 0.6 : 0.45);

  const body = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.36, 1.05, 6, 14),
    new THREE.MeshStandardMaterial({ color, roughness: 0.65 })
  );
  body.position.y = 0.9;
  body.castShadow = true;
  group.add(body);

  // Nose points +Z. The server sends yaw = atan2(dx, dz), so rotation.y = yaw
  // aims this the way the body is actually moving.
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
let camYaw = 0;
let camPitch = 0.32;
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
  camPitch = Math.max(-0.25, Math.min(1.15, camPitch - e.movementY * 0.0022));
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
let localYaw = 0;

const overlay = document.getElementById("overlay") as HTMLDivElement;
const playBtn = document.getElementById("play") as HTMLButtonElement;
const hud = document.getElementById("hud") as HTMLDivElement;

playBtn.disabled = false;
playBtn.textContent = "ENTER THE ROOM";

playBtn.addEventListener("click", async () => {
  playBtn.disabled = true;
  playBtn.textContent = "connecting…";
  try {
    const client = new Client(endpoint);
    room = await client.joinOrCreate<HouseState>("house", { name: localStorage.getItem("cotm:name") ?? "" });
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
    // Predict locally using exactly the server's maths, then ease toward the
    // server's answer. Small errors dissolve; big ones snap.
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
      localPos.x = THREE.MathUtils.clamp(localPos.x + dx, -BOUND, BOUND);
      localPos.z = THREE.MathUtils.clamp(localPos.z + dz, -BOUND, BOUND);
      localYaw = Math.atan2(dx, dz);
    }

    const server = new THREE.Vector3(self.player.x, self.player.y, self.player.z);
    const drift = localPos.distanceTo(server);
    if (drift > 2) {
      localPos.copy(server); // teleported, or we got badly out of sync
    } else if (drift > 0.02) {
      localPos.lerp(server, 1 - Math.pow(0.0001, dt));
    }

    self.group.position.copy(localPos);
    self.group.rotation.y = localYaw;
  }

  // Remote avatars: ease toward the last state we were sent.
  avatars.forEach((avatar, sessionId) => {
    if (room && sessionId === room.sessionId) return;
    avatar.target.set(avatar.player.x, avatar.player.y, avatar.player.z);
    avatar.group.position.lerp(avatar.target, 1 - Math.pow(0.0015, dt));

    // Shortest-path yaw, so they don't spin the long way round.
    let delta = avatar.player.yaw - avatar.group.rotation.y;
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;
    avatar.group.rotation.y += delta * (1 - Math.pow(0.0015, dt));
  });

  // Third-person camera orbiting whatever we're predicting.
  const focus = self ? localPos : new THREE.Vector3(0, 0, 0);
  const cosP = Math.cos(camPitch);
  camera.position.set(
    focus.x + Math.sin(camYaw) * cosP * CAM_DIST,
    focus.y + EYE + Math.sin(camPitch) * CAM_DIST,
    focus.z + Math.cos(camYaw) * cosP * CAM_DIST
  );
  camera.lookAt(focus.x, focus.y + EYE, focus.z);

  if (room) {
    hud.innerHTML = [
      `<b>🔎 clues of the mind</b> — milestone 1`,
      `room <b>${room.roomId}</b> · you are <b>${self?.player.name ?? "…"}</b>`,
      `<b>${avatars.size}</b> in the room`,
      locked ? `` : `<b>click</b> to look around`,
    ].join("<br />");
  }

  renderer.render(scene, camera);
}

tick();
