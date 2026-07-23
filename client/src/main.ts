import * as THREE from "three";
import { Client, getStateCallbacks } from "colyseus.js";
import type { Room } from "colyseus.js";
import type { HouseState, Person } from "../../server/src/schema/GameState";
import { Action, SPEED, resolveCollisions, roomAt } from "../../server/src/world/house";
import { buildHouse, buildRoomLabels, buildFurniture } from "./house";
import { buildPerson, animatePerson, type PersonRig } from "./person";
import { Tablet, type RosterEntry } from "./tablet";
import { InterviewBox } from "./interview";

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
  [Action.SIT]: "sitting",
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

const tablet = new Tablet(scene);
tablet.setAspect(window.innerWidth / window.innerHeight);

const interviewBox = new InterviewBox();
/** True while THIS player is being questioned — their body autopilots and their
 *  input is ignored, so the typing box has their full attention (SOW §5). */
let beingInterviewed = false;

/** Transient HUD line, e.g. "camera placed". Cleared after a couple seconds. */
let flash = "";
let flashUntil = 0;
const setFlash = (msg: string) => {
  flash = msg;
  flashUntil = elapsed + 2.2;
};

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
  const fresh = !keys.has(e.code);
  keys.add(e.code);
  if (e.code === "Space") e.preventDefault();
  if (!fresh || !room) return;

  switch (e.code) {
    case "KeyE":
      if (!tablet.up) room.send("act");
      break;
    case "KeyQ":
      // The tablet is the Detective's device. The Spy has no tablet at all.
      if (myRole !== "detective") {
        if (myRole === "spy") setFlash("spies don't carry a tablet");
        break;
      }
      // Raising the tablet frees the cursor (for the roster buttons) and stops
      // you moving — you're standing still, looking at a screen.
      tablet.toggle();
      if (tablet.up) {
        refreshRoster();
        document.exitPointerLock();
      } else if (!locked) {
        renderer.domElement.requestPointerLock();
      }
      break;
    case "KeyF":
      // Placing a camera is a Detective tool too.
      if (myRole === "detective" && !tablet.up) {
        // Drop the camera where you stand, looking the way you face.
        tablet.place(localPos.x, localPos.z, -Math.sin(camYaw), -Math.cos(camYaw));
        setFlash("📷 camera placed — raise the tablet (Q) to watch");
      }
      break;
    case "ArrowLeft":
      if (tablet.up) { tablet.cycle(-1); e.preventDefault(); }
      break;
    case "ArrowRight":
      if (tablet.up) { tablet.cycle(1); e.preventDefault(); }
      break;
    case "Escape":
      tablet.close();
      break;
  }
});
window.addEventListener("keyup", (e) => keys.delete(e.code));
window.addEventListener("blur", () => keys.clear());

renderer.domElement.addEventListener("click", () => {
  // Don't grab the cursor back while the tablet is up — it's needed for the UI.
  if (room && !locked && !tablet.up) renderer.domElement.requestPointerLock();
});

/** Rebuild the roster from whoever's currently at the party — everyone but you.
 *  You can't interview or accuse yourself, so your own body has no place on the
 *  list. */
function refreshRoster() {
  const entries: RosterEntry[] = [];
  bodies.forEach((body, id) => {
    if (id === myBody) return;
    entries.push({
      id,
      name: body.person.name,
      skin: body.person.skin,
      age: body.person.age,
      acc: body.person.acc,
      hair: body.person.hair,
      hat: body.person.hat,
      hairHue: body.person.hairHue,
    });
  });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  tablet.setRoster(entries, myBody ?? "");
}

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
  const aspect = window.innerWidth / window.innerHeight;
  camera.aspect = aspect;
  camera.updateProjectionMatrix();
  tablet.setAspect(aspect);
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
const roleOverlay = document.getElementById("roleoverlay") as HTMLDivElement;
const roleBody = roleOverlay.querySelector(".role-body") as HTMLDivElement;

/** Your role for the round. null until the server assigns it. The Spy has no
 *  tablet — only the Detective does (SOW §7.1 / tablet-is-detective-only). */
let myRole: "detective" | "spy" | "none" | null = null;

playBtn.disabled = false;
playBtn.textContent = "ENTER THE HOUSE";

function showRolePicker() {
  roleOverlay.classList.remove("hidden");
  roleBody.innerHTML = `
    <div style="font-size:13px;color:#8b90a0;margin-bottom:22px">
      You're hosting, so you choose first. Your friend takes the other role.
    </div>
    <div class="role-choices">
      <div class="role-choice" data-role="detective">
        <div class="icon">🔎</div>
        <div class="name">DETECTIVE</div>
        <div class="blurb">Find the spy among the guests. You carry the tablet: cameras, interviews, and the guess.</div>
      </div>
      <div class="role-choice" data-role="spy">
        <div class="icon">🕶</div>
        <div class="name">SPY</div>
        <div class="blurb">Hide in plain sight. Complete your tasks and answer the detective's questions without giving yourself away.</div>
      </div>
    </div>`;
  roleBody.querySelectorAll(".role-choice").forEach((el) =>
    el.addEventListener("click", () => {
      const role = (el as HTMLElement).getAttribute("data-role");
      room?.send("pick_role", { role });
      roleBody.innerHTML = `<div class="role-wait">locking it in<span class="dots">…</span></div>`;
    })
  );
}

function showRoleWait() {
  roleOverlay.classList.remove("hidden");
  roleBody.innerHTML = `<div class="role-wait">waiting for the host to choose<span class="dots">…</span></div>`;
}

function enterGameWithRole(role: "detective" | "spy" | "none") {
  myRole = role;
  const label = role === "detective" ? "🔎 DETECTIVE" : role === "spy" ? "🕶 SPY" : "GUEST";
  roleOverlay.classList.remove("hidden");
  roleBody.innerHTML = `<div class="role-assigned">you are the<span class="big">${label}</span>
    ${role === "spy" ? "blend in. no tablet — you're one of them." : role === "detective" ? "raise the tablet with Q and start questioning." : ""}</div>`;
  // Beat to read it, then into the house.
  setTimeout(() => {
    roleOverlay.classList.add("hidden");
    if (room && !locked) renderer.domElement.requestPointerLock();
  }, 1700);
}

/**
 * Tear the world down to nothing.
 *
 * A dropped connection does NOT emit people.onRemove for each body, so without
 * this a reconnect (the "rejoin" button) adds a fresh 12 guests on top of the
 * frozen old ones — you end up with 24 ghosts, none of them moving. Clear
 * everything before every join so a fresh room starts from an empty scene.
 */
function clearWorld() {
  bodies.forEach((b) => scene.remove(b.rig.group));
  bodies.clear();
  myBody = null;
  myRole = null;
  selfRing.visible = false;
  tablet.close();
  roleOverlay.classList.add("hidden");
}

playBtn.addEventListener("click", async () => {
  playBtn.disabled = true;
  playBtn.textContent = "connecting…";
  try {
    // Drop any previous room and wipe its bodies before joining a new one.
    // Do NOT await leave(): after a server restart the old socket is already
    // dead, and its leave() promise never resolves — awaiting it hangs the
    // rejoin on "connecting…" forever. Fire it and move on.
    if (room) {
      try {
        room.leave(false);
      } catch {
        /* already gone */
      }
      room = null;
    }
    clearWorld();

    const client = new Client(endpoint);
    room = await client.joinOrCreate<HouseState>("house", {
      name: localStorage.getItem("cotm:name") ?? "",
    });
    wire(room);
    // Don't drop into the house yet — the role overlay takes over until the
    // server assigns a role (host picks; the other player waits then takes the
    // leftover). enterGameWithRole() grabs pointer lock once that's settled.
    overlay.classList.add("hidden");
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

  // ---- roles (host picks first)
  room.onMessage("role_pick", () => showRolePicker());
  room.onMessage("role_wait", () => showRoleWait());
  room.onMessage("your_role", (m: { role: "detective" | "spy" | "none" }) =>
    enterGameWithRole(m.role)
  );

  // ---- interviews (SOW §5): a live chat
  // Detective side: open a chat, type questions, read the replies.
  tablet.onInterview = (id: string) => room.send("interview", { target: id });
  tablet.onAsk = (text: string) => room.send("interview_ask", { text });
  tablet.onCloseInterview = () => room.send("interview_close", {});
  room.onMessage("interview_open", (m: { target: string; name: string }) =>
    tablet.interviewOpen(m.target, m.name)
  );
  room.onMessage("interview_typing", () => tablet.interviewTyping());
  room.onMessage("interview_msg", (m: any) => tablet.interviewMsg(m));
  room.onMessage("interview_denied", (m: { reason: string }) => tablet.interviewDenied(m.reason));

  // Being-questioned side: the chat box takes over the screen.
  interviewBox.onSubmit = (text: string) => room.send("interview_answer", { text });
  room.onMessage("interview_begin", (m: any) => {
    beingInterviewed = true;
    tablet.close();
    document.exitPointerLock();
    interviewBox.begin(m);
  });
  room.onMessage("interview_question", (m: { text: string }) => interviewBox.question(m.text));
  room.onMessage("interview_end", () => {
    beingInterviewed = false;
    interviewBox.hide();
    tablet.interviewClosedByServer();
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
    // Drop the frozen scene immediately rather than leaving 12 stale ghosts
    // sitting behind the overlay waiting to be doubled on rejoin.
    clearWorld();
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
  // Hands are on the tablet, or on the typing box — you don't walk either way.
  if (tablet.up || beingInterviewed) return { f: 0, r: 0, yaw: camYaw };
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

  if (self && beingInterviewed) {
    // The server is autopiloting our body while we type — just follow it, the
    // same way we follow any other guest, so we don't fight the AI's steering.
    localPos.lerp(new THREE.Vector3(self.person.x, self.person.y, self.person.z), 1 - Math.pow(0.0015, dt));
    self.rig.group.position.copy(localPos);
    let d = self.person.yaw - self.rig.group.rotation.y;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    self.rig.group.rotation.y += d * (1 - Math.pow(0.0015, dt));
    selfRing.position.set(localPos.x, 0.03, localPos.z);
  } else if (self) {
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

      // Predict body-to-body collision too, using the rendered positions of the
      // others, so bumping into a guest feels solid instead of rubber-banding
      // as the server pushes back. The server is still the authority.
      const minSep = 0.84;
      bodies.forEach((other, id) => {
        if (id === myBody) return;
        const ox = localPos.x - other.rig.group.position.x;
        const oz = localPos.z - other.rig.group.position.z;
        const od = Math.hypot(ox, oz);
        if (od < minSep && od > 1e-3) {
          localPos.x = other.rig.group.position.x + (ox / od) * minSep;
          localPos.z = other.rig.group.position.z + (oz / od) * minSep;
        }
      });
      const reSolved = resolveCollisions(localPos.x, localPos.z);
      localPos.x = reSolved.x;
      localPos.z = reSolved.z;

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

    animatePerson(body.rig, body.person.action, body.speed, dt, elapsed);
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
    const roleTag =
      myRole === "detective" ? `🔎 <b>DETECTIVE</b>` : myRole === "spy" ? `🕶 <b>SPY</b>` : "";
    const hint = tablet.up
      ? `watching — <b>Q</b> to lower the tablet`
      : !locked
        ? `<b>click</b> to look around`
        : myRole === "detective"
          ? `<b>F</b> camera · <b>Q</b> tablet · <b>E</b> join in`
          : `<b>E</b> join in at a spot`;
    const flashLine = elapsed < flashUntil ? `<span style="color:#d8b46a">${flash}</span>` : "";
    hud.innerHTML = [
      `<b>🔎 clues of the mind</b> — milestone 6 ${roleTag}`,
      `<b>${here?.name ?? "…"}</b> · ${bodies.size} guests`,
      `you are <b>${self?.person.name ?? "…"}</b>, ${doing}`,
      hint,
      flashLine,
    ].filter(Boolean).join("<br />");
  }

  // The camera feed IS the view while you watch it — you're blind to where you
  // actually stand. Otherwise render the detective's own third-person view.
  if (tablet.feedActive) {
    renderer.render(scene, tablet.feedCam);
  } else {
    renderer.render(scene, camera);
  }
}

tick();
