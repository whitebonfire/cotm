import * as THREE from "three";
import { Client, getStateCallbacks } from "colyseus.js";
import type { Room } from "colyseus.js";
import type { HouseState, Person } from "../../server/src/schema/GameState";
import { Action, SPEED, resolveCollisions, roomAt } from "../../server/src/world/house";
import { buildHouse, buildRoomLabels, buildFurniture } from "./house";
import { buildPerson, animatePerson, type PersonRig } from "./person";
import { Tablet, type RosterEntry } from "./tablet";
import { InterviewBox } from "./interview";
import { createAuthClient } from "better-auth/client";
import type { LobbyState, LobbyPlayer } from "../../server/src/schema/LobbyState";

const EYE = 1.25;
const CAM_DIST = 6.0;
const CAM_MIN = 1.1;
/** Must match MAGNIFY_SPEED on the server, or prediction fights it. */
const MAGNIFY_SPEED = 2.1;
const BASE_FOV = 58;
/** Zoomed field of view while looking through the magnifying glass. */
const MAG_FOV = 28;
/** Must match TASK_RANGE on the server. */
const TASK_RANGE = 1.8;

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

// ---- abilities
/** Detective peering through the magnifying glass: first person, slower walk. */
let magnify = false;
/** Spy `hack` cooldown ends at this time (0 = ready). */
let hackReadyAt = 0;
/** Detective `hide`: cooldown ends / disguise lasts until these times. */
let hideReadyAt = 0;
let hideActiveUntil = 0;
/** Detective `inspection` (seal a room): cooldown ends at this time. */
let sealReadyAt = 0;
/** Spy `impersonate`: cooldown ends / NPC gait lasts until these times. */
let impersonateReadyAt = 0;
let impersonateActiveUntil = 0;
/** Spy `snap`: short balance cooldown ends at this time. */
let snapReadyAt = 0;
/** Spy only: the body that is the Detective, so the Spy can find their hunter.
 *  Null when unknown or while the Detective is hidden (SOW §4.3). */
let markBody: string | null = null;
/** The lights are cut for us (a Spy hacked): black out until this time. */
let blackoutUntil = 0;
const blackout = document.getElementById("blackout") as HTMLDivElement;
const magVignette = document.getElementById("magvignette") as HTMLDivElement;
const abilityBar = document.getElementById("abilities") as HTMLDivElement;
const tasksPanel = document.getElementById("tasks") as HTMLDivElement;
const taskPrompt = document.getElementById("taskprompt") as HTMLDivElement;

interface SpyTask {
  item: number;
  itemName: string;
  fromBody: string;
  fromName: string;
  toBody: string;
  toName: string;
  state: "pending" | "carrying" | "done";
}
/** The Spy's tasks (empty for the Detective). */
let tasks: SpyTask[] = [];

const DOT: Record<string, string> = { pending: "○", carrying: "◈", done: "●" };

function renderTasks() {
  if (myRole !== "spy" || tasks.length === 0) {
    tasksPanel.classList.add("hidden");
    return;
  }
  const done = tasks.filter((t) => t.state === "done").length;
  tasksPanel.classList.remove("hidden");
  tasksPanel.innerHTML =
    `<div class="th"><span>🕶 YOUR TASKS</span><span>${done}/${tasks.length}</span></div>` +
    tasks
      .map((t) => {
        const body =
          t.state === "carrying"
            ? `carrying the <b>${t.itemName}</b> — give it to <b>${t.toName}</b>`
            : t.state === "done"
              ? `${t.itemName}: <b>${t.fromName}</b> → <b>${t.toName}</b>`
              : `steal the <b>${t.itemName}</b> from <b>${t.fromName}</b>`;
        return `<div class="task ${t.state}"><span class="dot">${DOT[t.state]}</span><span>${body}</span></div>`;
      })
      .join("");
}

let lastAbilityHtml = "";
/** One ability chip. `readyAt` drives a cooldown countdown; `activeUntil` counts
 *  down a timed effect that's currently up; `on` is a plain toggle (no number).
 *  Omit all three for an always-available tool. */
function chip(key: string, label: string, readyAt = 0, activeUntil = 0, on = false) {
  const now = Date.now();
  const cd = Math.ceil((readyAt - now) / 1000);
  const active = on || now < activeUntil;
  const cls = active ? "active" : cd > 0 ? "cooling" : "";
  const state =
    !on && now < activeUntil
      ? `<span class="cd">${Math.ceil((activeUntil - now) / 1000)}s</span>`
      : !active && cd > 0
        ? `<span class="cd">${cd}s</span>`
        : "";
  return `<div class="ab ${cls}"><kbd>${key}</kbd> ${label} ${state}</div>`;
}

/** Render the ability bar for the current role (only touches the DOM on change). */
function updateAbilityBar() {
  let html = "";
  if (myRole === "detective") {
    html =
      chip("G", "magnifier", 0, 0, magnify) +
      chip("F", "camera") +
      chip("H", "hide", hideReadyAt, hideActiveUntil) +
      chip("R", "seal room", sealReadyAt);
  } else if (myRole === "spy") {
    html =
      chip("H", "hack", hackReadyAt) +
      chip("R", "impersonate", impersonateReadyAt, impersonateActiveUntil) +
      chip("C", "snap", snapReadyAt);
  }
  if (html !== lastAbilityHtml) {
    abilityBar.innerHTML = html;
    lastAbilityHtml = html;
  }
}

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
  /** Floating name label; hidden on your own body. */
  label: THREE.Sprite;
}

const bodies = new Map<string, Body>();

/**
 * A floating name label above a guest's head. Drawn to a canvas and shown on a
 * camera-facing sprite. Names are already known to every client (they're on the
 * schema), and the Spy wears the name of the guest they took over, so a label
 * gives nothing away — it's just a readability aid.
 */
function makeNameLabel(name: string): THREE.Sprite {
  const dpr = 2; // render at 2x for crisp text
  const font = `600 ${22 * dpr}px ui-monospace, "SF Mono", Menlo, monospace`;
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d")!;
  ctx.font = font;
  const padX = 14 * dpr;
  const w = Math.ceil(ctx.measureText(name).width) + padX * 2;
  const h = 34 * dpr;
  canvas.width = w;
  canvas.height = h;
  // measureText resets after the resize above, so restore the font.
  ctx.font = font;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  // A soft dark pill behind the text so it reads over any background.
  ctx.fillStyle = "rgba(10, 12, 16, 0.55)";
  ctx.beginPath();
  ctx.roundRect(0, 0, w, h, 9 * dpr);
  ctx.fill();
  ctx.fillStyle = "#eae7df";
  ctx.fillText(name, w / 2, h / 2 + dpr);

  const tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = THREE.LinearFilter;
  tex.colorSpace = THREE.SRGBColorSpace;
  const spr = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false })
  );
  const s = 0.0038; // world units per canvas pixel
  spr.scale.set(w * s, h * s, 1);
  spr.position.set(0, 2.05, 0); // above the head; the detective pin sits higher
  spr.renderOrder = 900;
  return spr;
}

/**
 * The Spy-only marker floating over the Detective (SOW §4.3). A small red
 * inverted pin so the Spy can pick their hunter out of the crowd — and lose
 * them the moment the Detective uses `hide`. Added to the scene only for the
 * Spy; hidden until `markBody` is known.
 */
const detectiveMarker = (() => {
  const g = new THREE.Group();
  const cone = new THREE.Mesh(
    new THREE.ConeGeometry(0.16, 0.34, 4),
    new THREE.MeshBasicMaterial({ color: 0xff3b3b, transparent: true, opacity: 0.85 })
  );
  cone.rotation.x = Math.PI; // point down at the head
  g.add(cone);
  g.visible = false;
  scene.add(g);
  return g;
})();

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
    case "KeyG":
      // Magnifying glass: first person + slower, the Detective's signature tool.
      if (myRole === "detective" && !tablet.up && !beingInterviewed) {
        magnify = !magnify;
        setFlash(magnify ? "🔍 magnifying glass raised" : "magnifying glass lowered");
      }
      break;
    case "KeyH":
      if (beingInterviewed || tablet.up) break;
      // Spy: hack the lights. Detective: hide — blend in as a guest.
      if (myRole === "spy") {
        if (Date.now() < hackReadyAt) setFlash(`hack recharging (${Math.ceil((hackReadyAt - Date.now()) / 1000)}s)`);
        else room.send("ability", { id: "hack" });
      } else if (myRole === "detective") {
        if (Date.now() < hideReadyAt) setFlash(`hide recharging (${Math.ceil((hideReadyAt - Date.now()) / 1000)}s)`);
        else room.send("ability", { id: "hide" });
      }
      break;
    case "KeyR":
      if (beingInterviewed || tablet.up) break;
      // Detective: seal the room you're in. Spy: impersonate an NPC's gait.
      if (myRole === "detective") {
        if (Date.now() < sealReadyAt) setFlash(`inspection recharging (${Math.ceil((sealReadyAt - Date.now()) / 1000)}s)`);
        else room.send("ability", { id: "inspection" });
      } else if (myRole === "spy") {
        if (Date.now() < impersonateReadyAt) setFlash(`impersonate recharging (${Math.ceil((impersonateReadyAt - Date.now()) / 1000)}s)`);
        else room.send("ability", { id: "impersonate" });
      }
      break;
    case "KeyC":
      // Snap: the Spy photographs the Detective for +1 minute on the clock.
      if (myRole === "spy" && !beingInterviewed && !tablet.up) {
        if (Date.now() < snapReadyAt) setFlash(`camera busy (${Math.ceil((snapReadyAt - Date.now()) / 1000)}s)`);
        else room.send("ability", { id: "snap" });
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
const roundOverlay = document.getElementById("roundover") as HTMLDivElement;
(roundOverlay.querySelector(".ro-again") as HTMLButtonElement).addEventListener("click", () =>
  location.reload()
);

function showRoundOver(m: { outcome: string; reason: string; spyName: string }) {
  const youWon =
    (m.outcome === "detective" && myRole === "detective") ||
    (m.outcome === "spy" && myRole === "spy");
  const winnerEl = roundOverlay.querySelector(".ro-winner") as HTMLDivElement;
  winnerEl.className = `ro-winner ${m.outcome}`;
  winnerEl.textContent = m.outcome === "detective" ? "🔎 DETECTIVE WINS" : "🕶 SPY WINS";
  (roundOverlay.querySelector(".ro-reason") as HTMLDivElement).textContent =
    (youWon ? "You win. " : "You lose. ") + m.reason;
  (roundOverlay.querySelector(".ro-spy") as HTMLDivElement).innerHTML = m.spyName
    ? `the spy was <b>${m.spyName}</b>`
    : "";
  roundOverlay.classList.remove("hidden");
  document.exitPointerLock();
}

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
        <div class="blurb">Find the spy among the guests. Tablet for cameras, interviews and the guess; magnifier to read a face; hide to shake the spy; seal a room to lock them out.</div>
      </div>
      <div class="role-choice" data-role="spy">
        <div class="icon">🕶</div>
        <div class="name">SPY</div>
        <div class="blurb">Hide in plain sight. Steal and deliver to win; hack the lights, impersonate a guest, and snap the detective (the red pin) for more time.</div>
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
  magnify = false;
  hackReadyAt = 0;
  hideReadyAt = 0;
  hideActiveUntil = 0;
  sealReadyAt = 0;
  impersonateReadyAt = 0;
  impersonateActiveUntil = 0;
  snapReadyAt = 0;
  markBody = null;
  detectiveMarker.visible = false;
  blackoutUntil = 0;
  tasks = [];
  renderTasks();
  taskPrompt.classList.add("hidden");
  selfRing.visible = false;
  tablet.close();
  roleOverlay.classList.add("hidden");
  roundOverlay.classList.add("hidden");
}

// ---------------------------------------------------------------- menu & lobby
// The overlay holds several screens (loading, quick-play, sign-in, menu, lobby)
// and we show exactly one at a time. Which flow you see depends on whether the
// server has a database: with one you sign in and use lobbies (SOW §6); without
// one the game falls back to the anonymous "enter the house" quick-play.

const net = new Client(endpoint);
// Better Auth and /api are HTTP on the same origin the page is served from.
const httpOrigin = import.meta.env.DEV ? "http://localhost:2567" : location.origin;
const authClient = createAuthClient({ baseURL: httpOrigin });

const $id = (id: string) => document.getElementById(id) as HTMLElement;
const SCREENS = ["screen-loading", "screen-quickplay", "screen-auth", "screen-menu", "screen-lobby"];
function showScreen(id: string) {
  overlay.classList.remove("hidden");
  for (const s of SCREENS) $id(s).classList.toggle("hidden", s !== id);
}

let account: { name: string; friendCode: string } | null = null;
let lobbyRoom: Room<LobbyState> | null = null;

/** Drop any old room, join a house room, wire it, and reveal the game. Used by
 *  both quick-play (joinOrCreate) and the lobby hand-off (joinById). */
async function connectHouse(join: (c: Client) => Promise<Room<HouseState>>) {
  // Do NOT await leave(): a dead socket's leave() promise never resolves.
  if (room) {
    try {
      room.leave(false);
    } catch {
      /* already gone */
    }
    room = null;
  }
  clearWorld();
  room = await join(net);
  wire(room);
  overlay.classList.add("hidden");
}

// ---- quick-play (auth disabled)
playBtn.addEventListener("click", async () => {
  playBtn.disabled = true;
  playBtn.textContent = "connecting…";
  try {
    await connectHouse((c) =>
      c.joinOrCreate<HouseState>("house", { name: localStorage.getItem("cotm:name") ?? "" })
    );
  } catch (err) {
    console.error(err);
    playBtn.disabled = false;
    playBtn.textContent = "retry";
    hud.innerHTML = `<b>connection failed</b><br />${String(err)}`;
  }
});

// ---- sign in / sign up
let authMode: "in" | "up" = "in";
function setAuthMode(m: "in" | "up") {
  authMode = m;
  ($id("auth-name") as HTMLInputElement).classList.toggle("hidden", m === "in");
  $id("auth-sub").textContent = m === "in" ? "sign in to play" : "create your account";
  $id("auth-submit").textContent = m === "in" ? "sign in" : "create account";
  $id("auth-toggle-text").textContent = m === "in" ? "New here?" : "Already have an account?";
  $id("auth-toggle").textContent = m === "in" ? "create an account" : "sign in";
  ($id("auth-password") as HTMLInputElement).autocomplete =
    m === "in" ? "current-password" : "new-password";
  $id("auth-error").textContent = "";
}
$id("auth-toggle").addEventListener("click", (e) => {
  e.preventDefault();
  setAuthMode(authMode === "in" ? "up" : "in");
});
$id("auth-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = ($id("auth-name") as HTMLInputElement).value.trim();
  const email = ($id("auth-email") as HTMLInputElement).value.trim();
  const password = ($id("auth-password") as HTMLInputElement).value;
  const err = $id("auth-error");
  const submit = $id("auth-submit") as HTMLButtonElement;
  err.textContent = "";
  submit.disabled = true;
  try {
    const res =
      authMode === "up"
        ? await authClient.signUp.email({ email, password, name: name || email.split("@")[0] })
        : await authClient.signIn.email({ email, password });
    if (res.error) {
      err.textContent = res.error.message || "That didn't work — check your details.";
    } else {
      const { data } = await authClient.getSession();
      if (data?.user) onSignedIn(data.user);
    }
  } catch (ex) {
    err.textContent = String(ex);
  } finally {
    submit.disabled = false;
  }
});

function onSignedIn(user: { name: string; friendCode?: string | null }) {
  account = { name: user.name, friendCode: user.friendCode ?? "" };
  $id("menu-name").textContent = user.name;
  $id("menu-friendcode").textContent = user.friendCode ?? "—";
  showScreen("screen-menu");
}

// ---- main menu: create or join a lobby
$id("menu-copy-code").addEventListener("click", (e) => {
  e.preventDefault();
  if (account?.friendCode) navigator.clipboard?.writeText(account.friendCode);
});
$id("menu-signout").addEventListener("click", async (e) => {
  e.preventDefault();
  await authClient.signOut();
  account = null;
  setAuthMode("in");
  showScreen("screen-auth");
});
const menuError = (m: string) => ($id("menu-error").textContent = m);
$id("menu-create").addEventListener("click", async () => {
  menuError("");
  ($id("menu-create") as HTMLButtonElement).disabled = true;
  try {
    wireLobby(await net.create<LobbyState>("lobby"));
  } catch (err) {
    menuError("Couldn't create a lobby. " + String(err));
  } finally {
    ($id("menu-create") as HTMLButtonElement).disabled = false;
  }
});
$id("join-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const code = ($id("join-code") as HTMLInputElement).value.trim();
  if (!code) return;
  menuError("");
  try {
    wireLobby(await net.joinById<LobbyState>(code));
  } catch {
    menuError("Couldn't find a lobby with that code.");
  }
});

// ---- the lobby
const TOY_NAME = ["", "🔎 detective", "🕶 spy"];
function renderLobby(lobby: Room<LobbyState>) {
  const me = lobby.sessionId;
  const entries = [...lobby.state.players.entries()];
  const cont = $id("lobby-players");
  cont.innerHTML = "";
  let iAmHost = false;
  let myToy = 0;
  for (const [sid, p] of entries) {
    if (sid === me) {
      iAmHost = p.host;
      myToy = p.toy;
    }
    const div = document.createElement("div");
    div.className = "p" + (p.host ? " host" : "");
    const tag = p.host ? "HOST" : TOY_NAME[p.toy] || "here";
    div.innerHTML = `<span>${p.name}${sid === me ? " (you)" : ""}</span><span class="tag">${tag}</span>`;
    cont.appendChild(div);
  }
  const start = $id("lobby-start") as HTMLButtonElement;
  const ready = iAmHost && entries.length >= 2;
  start.disabled = !ready;
  start.textContent = !iAmHost
    ? "waiting for the host…"
    : entries.length < 2
      ? "waiting for a friend…"
      : "start round";
  document.querySelectorAll("#screen-lobby .toy").forEach((b) => {
    const id = b.getAttribute("data-toy") === "detective" ? 1 : 2;
    b.classList.toggle("on", id === myToy);
  });
}

function wireLobby(lobby: Room<LobbyState>) {
  lobbyRoom = lobby;
  $id("lobby-code").textContent = lobby.roomId;
  showScreen("screen-lobby");
  $id("lobby-error").textContent = "";

  const $$ = getStateCallbacks(lobby);
  const render = () => renderLobby(lobby);
  $$(lobby.state).players.onAdd((p: LobbyPlayer) => {
    $$(p).onChange(render);
    render();
  });
  $$(lobby.state).players.onRemove(render);

  lobby.onMessage("start_game", async (m: { roomId: string; host?: boolean }) => {
    lobbyRoom = null;
    try {
      await connectHouse((c) =>
        c.joinById<HouseState>(m.roomId, { name: account?.name ?? "", host: !!m.host })
      );
    } catch (err) {
      showScreen("screen-menu");
      menuError("Couldn't join the round. " + String(err));
    }
  });
  lobby.onMessage("lobby_error", (m: { reason: string }) => ($id("lobby-error").textContent = m.reason));
  lobby.onError((_c, msg) => ($id("lobby-error").textContent = msg ?? "lobby error"));
}

document.querySelectorAll("#screen-lobby .toy").forEach((b) =>
  b.addEventListener("click", () => {
    const toy = b.getAttribute("data-toy");
    // Clicking your current toy turns it off.
    const on = b.classList.contains("on");
    lobbyRoom?.send("set_toy", { toy: on ? "none" : toy });
  })
);
$id("lobby-start").addEventListener("click", () => lobbyRoom?.send("start"));
$id("lobby-copy").addEventListener("click", (e) => {
  e.preventDefault();
  if (lobbyRoom) navigator.clipboard?.writeText(lobbyRoom.roomId);
});
$id("lobby-leave").addEventListener("click", (e) => {
  e.preventDefault();
  lobbyRoom?.leave();
  lobbyRoom = null;
  showScreen("screen-menu");
});

// ---- (test) play solo: a fresh private room where the round starts with just
// you and the NPCs — no second player, no sign-in required.
async function enterSolo() {
  try {
    await connectHouse((c) =>
      c.create<HouseState>("house", { solo: true, host: true, name: account?.name ?? "Tester" })
    );
  } catch (err) {
    console.error(err);
    hud.innerHTML = `<b>couldn't start a solo game</b><br />${String(err)}`;
  }
}
document.querySelectorAll(".test-solo").forEach((el) =>
  el.addEventListener("click", (e) => {
    e.preventDefault();
    enterSolo();
  })
);

// ---- decide which flow to show on load
async function initMenu() {
  let cfg: { auth: boolean } = { auth: false };
  try {
    cfg = await fetch(`${httpOrigin}/api/config`).then((r) => r.json());
  } catch {
    /* server unreachable — fall through to quick-play, which will surface it */
  }
  if (!cfg.auth) {
    showScreen("screen-quickplay");
    return;
  }
  try {
    const { data } = await authClient.getSession();
    if (data?.user) {
      onSignedIn(data.user);
      return;
    }
  } catch {
    /* not signed in */
  }
  setAuthMode("in");
  showScreen("screen-auth");
}
initMenu();

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
  // A name floats over every guest's head. Child of the (unscaled) group so it
  // follows the body; sprites always face the camera, so the group's yaw and
  // the label are independent. Removed automatically with the body. Visibility
  // is toggled each frame so your own name doesn't hover over you.
  const label = makeNameLabel(person.name);
  rig.group.add(label);
  scene.add(rig.group);

  bodies.set(id, {
    rig,
    person,
    target: new THREE.Vector3(person.x, person.y, person.z),
    speed: 0,
    prev: new THREE.Vector3(person.x, person.y, person.z),
    label,
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
  room.onMessage("interview_typing", (m: { revealMs?: number }) => tablet.interviewTyping(m?.revealMs));
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
  room.onMessage("interview_question", (m: { text: string; windowMs?: number }) =>
    interviewBox.question(m.text, m.windowMs)
  );
  room.onMessage("interview_end", () => {
    beingInterviewed = false;
    interviewBox.hide();
    tablet.interviewClosedByServer();
  });

  // ---- the spy's tasks (SOW §3)
  room.onMessage("tasks", (m: { tasks: SpyTask[] }) => {
    tasks = m.tasks;
    renderTasks();
  });

  // ---- the round (SOW §2, §7)
  tablet.onGuess = (id: string) => room.send("guess", { target: id });
  room.onMessage("round_start", () => setFlash("the round has begun — find the spy"));
  room.onMessage("guess_wrong", (m: { name: string; guessesLeft: number }) =>
    setFlash(`❌ ${m.name} was innocent — ${m.guessesLeft} guess${m.guessesLeft === 1 ? "" : "es"} left`)
  );
  room.onMessage("guess_denied", (m: { reason: string }) => tablet.guessDenied(m.reason));
  room.onMessage("round_over", (m: { outcome: string; reason: string; spyName: string }) =>
    showRoundOver(m)
  );

  // ---- abilities
  room.onMessage(
    "ability_used",
    (m: { id: string; cooldownMs: number; durationMs?: number; bonusMs?: number }) => {
      const now = Date.now();
      const until = now + (m.durationMs ?? 0);
      if (m.id === "hack") {
        hackReadyAt = now + m.cooldownMs;
        setFlash("🔌 lights cut — move while they're blind");
      } else if (m.id === "hide") {
        hideReadyAt = now + m.cooldownMs;
        hideActiveUntil = until;
        setFlash("🎭 blending in — the spy has lost track of you");
      } else if (m.id === "inspection") {
        sealReadyAt = now + m.cooldownMs;
        setFlash("🔒 room sealed — the spy can't work in here");
      } else if (m.id === "impersonate") {
        impersonateReadyAt = now + m.cooldownMs;
        impersonateActiveUntil = until;
        setFlash("🚶 moving like a guest");
      } else if (m.id === "snap") {
        snapReadyAt = now + m.cooldownMs;
        setFlash(`📸 snapped the detective — +${Math.round((m.bonusMs ?? 60000) / 1000)}s`);
      }
    }
  );
  room.onMessage("ability_denied", (m: { reason: string }) => setFlash(m.reason));
  // Spy learns which body is the Detective (null while they're hidden).
  room.onMessage("detective_mark", (m: { body: string | null }) => {
    markBody = m.body;
  });
  // A room was sealed by an inspection (everyone sees it).
  room.onMessage("seal", (m: { room: string; name: string; ms: number }) => {
    if (myRole === "spy") setFlash(`🔒 ${m.name} sealed for ${Math.round(m.ms / 1000)}s`);
  });
  // The Detective was photographed: the Spy bought a minute.
  room.onMessage("photographed", (m: { secondsAdded: number }) => {
    setFlash(`📸 the spy photographed you — +${m.secondsAdded}s on the clock`);
  });
  room.onMessage("lights", (m: { off: boolean; ms?: number }) => {
    // A spy hacked the lights: our view goes dark (we're not the spy).
    if (m.off) blackoutUntil = Date.now() + (m.ms ?? 10000);
    else blackoutUntil = 0;
  });

  $(room.state).people.onAdd((person: Person, id: string) => {
    addBody(person, id);
    if (id === myBody) {
      localPos.set(person.x, person.y, person.z);
      localYaw = person.yaw;
    }
    // When a guest's accessory is stolen (acc -> 0), it vanishes from them — a
    // clue the Detective can spot (SOW §3).
    $(person).listen("acc", (val: number) => {
      const b = bodies.get(id);
      if (b?.rig.accessory) b.rig.accessory.visible = val > 0;
    });
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
  // Hands are on the tablet, on the typing box, or the body is on NPC autopilot
  // while impersonating — you don't steer in any of those cases.
  if (tablet.up || beingInterviewed || Date.now() < impersonateActiveUntil) {
    return { f: 0, r: 0, yaw: camYaw, mag: magnify };
  }
  const f = (keys.has("KeyW") ? 1 : 0) - (keys.has("KeyS") ? 1 : 0);
  const r = (keys.has("KeyD") ? 1 : 0) - (keys.has("KeyA") ? 1 : 0);
  return { f, r, yaw: camYaw, mag: magnify };
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

  if (self && (beingInterviewed || Date.now() < impersonateActiveUntil)) {
    // The server is autopiloting our body — while we type an interview answer,
    // or while `impersonate` walks us around like a guest. Just follow it, the
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
      const spd = magnify ? MAGNIFY_SPEED : SPEED;
      dx = (dx / len) * spd * dt;
      dz = (dz / len) * spd * dt;

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
    // No name over your own body, and — on the Spy's screen — none over the
    // Detective either (only NPCs and the Spy carry names). `markBody` is the
    // Detective, known only to the Spy; it goes null while the Detective is
    // hiding, so their name reappears then and they blend in like a guest.
    body.label.visible = id !== myBody && id !== markBody;
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

  // ---- Spy's marker over the Detective. Bobs above their head; hidden when we
  // don't have a mark (not the Spy, or the Detective is using `hide`).
  const marked = markBody ? bodies.get(markBody) : null;
  if (marked) {
    const p = marked.rig.group.position;
    detectiveMarker.visible = true;
    detectiveMarker.position.set(p.x, p.y + 2.55 + Math.sin(elapsed * 2.2) * 0.08, p.z);
    detectiveMarker.rotation.y = elapsed * 1.5;
  } else {
    detectiveMarker.visible = false;
  }

  // ---- camera. First person while peering through the magnifying glass;
  // third person orbit otherwise.
  focusPoint.set(localPos.x, localPos.y + EYE, localPos.z);
  const cosP = Math.cos(camPitch);
  camDir.set(Math.sin(camYaw) * cosP, Math.sin(camPitch), Math.cos(camYaw) * cosP).normalize();

  if (magnify && self) {
    // Look out of the guest's own eyes, down the aim direction (-camDir), and
    // zoom in — the point of a magnifier is to read a face from across the room.
    self.rig.group.visible = false; // don't clip our own head
    camera.position.set(localPos.x, localPos.y + 1.5, localPos.z);
    camera.lookAt(camera.position.x - camDir.x, camera.position.y - camDir.y, camera.position.z - camDir.z);
    if (camera.fov !== MAG_FOV) {
      camera.fov = MAG_FOV;
      camera.updateProjectionMatrix();
    }
  } else {
    if (self) self.rig.group.visible = true;
    if (camera.fov !== BASE_FOV) {
      camera.fov = BASE_FOV;
      camera.updateProjectionMatrix();
    }
    let dist = CAM_DIST;
    raycaster.set(focusPoint, camDir);
    raycaster.far = CAM_DIST;
    const hits = raycaster.intersectObjects(colliders, false);
    if (hits.length > 0) dist = Math.max(CAM_MIN, hits[0].distance - 0.32);
    camera.position.copy(focusPoint).addScaledVector(camDir, dist);
    camera.position.y = Math.max(0.35, camera.position.y);
    camera.lookAt(focusPoint);
  }

  // Magnifying-lens vignette, and the hack blackout.
  magVignette.style.opacity = magnify ? "1" : "0";
  blackout.style.opacity = Date.now() < blackoutUntil ? "1" : "0";
  updateAbilityBar();

  // Spy task prompt: near a guest you can steal from or deliver to.
  let prompt = "";
  if (myRole === "spy" && room && room.state.round.phase === 1 && tasks.length && !beingInterviewed) {
    const near = (id: string) => {
      const p = room!.state.people.get(id);
      return p ? Math.hypot(p.x - localPos.x, p.z - localPos.z) < TASK_RANGE : false;
    };
    const carry = tasks.find((t) => t.state === "carrying" && near(t.toBody));
    const steal = tasks.find((t) => t.state === "pending" && near(t.fromBody));
    if (carry) prompt = `<kbd>E</kbd> give the ${carry.itemName} to ${carry.toName}`;
    else if (steal) prompt = `<kbd>E</kbd> steal the ${steal.itemName} from ${steal.fromName}`;
  }
  taskPrompt.innerHTML = prompt;
  taskPrompt.classList.toggle("hidden", !prompt);

  if (room) {
    // Keep the tablet's guess panel in step with the round.
    const round = room.state.round;
    tablet.setRound(round.phase, round.guessesLeft);

    const here = roomAt(localPos.x, localPos.z);
    const doing = self ? ACTION_NAME[self.person.action] ?? "" : "";
    const roleTag =
      myRole === "detective" ? `🔎 <b>DETECTIVE</b>` : myRole === "spy" ? `🕶 <b>SPY</b>` : "";
    const clock =
      round.phase === 1
        ? ` · ⏱ <b>${Math.floor(round.secondsLeft / 60)}:${String(round.secondsLeft % 60).padStart(2, "0")}</b>`
        : "";
    const hint = tablet.up
      ? `watching — <b>Q</b> to lower the tablet`
      : !locked
        ? `<b>click</b> to look around`
        : myRole === "detective"
          ? `<b>Q</b> tablet · <b>E</b> join in · abilities below`
          : `<b>E</b> steal / give / join in · abilities below`;
    const flashLine = elapsed < flashUntil ? `<span style="color:#d8b46a">${flash}</span>` : "";
    // Show your own account username here, not the guest you took over.
    const myName =
      account?.name || localStorage.getItem("cotm:name") || self?.person.name || "…";
    hud.innerHTML = [
      `<b>🔎 clues of the mind</b> ${roleTag}${clock}`,
      `<b>${here?.name ?? "…"}</b> · ${bodies.size} guests`,
      `you are <b>${myName}</b>, ${doing}`,
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
