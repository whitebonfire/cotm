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
export const INTERVIEW_PANEL = 0;

const ACC_NAME = ["", "a purse", "a necklace", "a monocle", "a cane", "a brooch", "a pocket-watch"];
const AGE_NAME = ["late twenties", "forties", "sixties", "elderly"];

export type Expression = "neutral" | "wary" | "loose" | "nervous" | "composed" | "warm" | "flat";

export interface RosterEntry {
  id: string;
  name: string;
  skin: number;
  age: number;
  acc: number;
  hair: number;
  hat: number;
  hairHue: number;
}

interface ChatMsg {
  from: "detective" | "guest";
  text: string;
}

interface InterviewView {
  status: "idle" | "chat";
  target?: string;
  name?: string;
  expression?: Expression;
  messages: ChatMsg[];
  /** The guest is composing a reply — show a "…" bubble. */
  typing: boolean;
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

  private interview: InterviewView = { status: "idle", messages: [], typing: false };
  private denied = "";
  /** When the guest's reply will be revealed — the fixed wait after a question. */
  private revealUntil = 0;
  private revealTimer: ReturnType<typeof setInterval> | null = null;
  /** Set by main. onInterview opens a chat with a guest; onAsk sends a typed
   *  question; onCloseInterview ends the chat. */
  onInterview: ((id: string) => void) | null = null;
  onAsk: ((text: string) => void) | null = null;
  onCloseInterview: (() => void) | null = null;

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

  // ---- interview (SOW §5): a live chat

  get interviewing(): boolean {
    return this.interview.status !== "idle";
  }

  /** The chat opened — show an empty thread with this guest. */
  interviewOpen(target: string, name: string) {
    this.interview = { status: "chat", target, name, messages: [], typing: false };
    this.denied = "";
    this.clearReveal();
    this.render();
    this.focusInput();
  }

  private clearReveal() {
    this.revealUntil = 0;
    if (this.revealTimer) clearInterval(this.revealTimer);
    this.revealTimer = null;
  }

  /** Locally echo the Detective's own question. The guest's reply won't come
   *  back until the reveal window is up — the same wait for AI and human alike. */
  interviewAsked(text: string) {
    if (this.interview.status !== "chat") return;
    this.interview.messages.push({ from: "detective", text });
    this.render();
  }

  interviewTyping(revealMs?: number) {
    if (this.interview.status !== "chat") return;
    this.interview.typing = true;
    // Count down the reveal window under the "typing" bubble, so the wait reads
    // as intentional rather than a hang.
    this.clearReveal();
    if (revealMs && revealMs > 0) {
      this.revealUntil = Date.now() + revealMs;
      this.revealTimer = setInterval(() => {
        if (this.interview.typing && Date.now() < this.revealUntil) this.updateRevealDisplay();
      }, 500);
    }
    this.render();
  }

  interviewMsg(msg: { name: string; text: string; expression: Expression }) {
    if (this.interview.status !== "chat") return;
    this.clearReveal();
    this.interview.typing = false;
    this.interview.expression = msg.expression;
    this.interview.messages.push({ from: "guest", text: msg.text });
    this.render();
    this.focusInput(); // input is free again immediately — the wait was before
  }

  /** Update the reveal countdown under the typing dots without a full re-render. */
  private updateRevealDisplay() {
    const el = this.screenEl.querySelector(".reveal-left") as HTMLElement | null;
    if (el) el.textContent = `${Math.max(0, Math.ceil((this.revealUntil - Date.now()) / 1000))}s`;
  }

  interviewDenied(reason: string) {
    this.denied = reason;
    this.render();
  }

  /** Called when the chat ends (back button, or server closed it). */
  private closeInterview(tellServer = true) {
    this.interview = { status: "idle", messages: [], typing: false };
    this.clearReveal();
    if (tellServer) this.onCloseInterview?.();
    this.render();
  }

  /** Server closed the chat from its side (e.g. it went idle). */
  interviewClosedByServer() {
    if (this.interview.status === "chat") this.closeInterview(false);
  }

  private focusInput() {
    requestAnimationFrame(() => {
      const input = this.screenEl.querySelector(".chat-input") as HTMLInputElement | null;
      input?.focus();
      const list = this.screenEl.querySelector(".chat-list") as HTMLElement | null;
      if (list) list.scrollTop = list.scrollHeight;
    });
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

    // Delegated clicks for the interview panel's buttons.
    this.screenEl.addEventListener("click", (ev) => {
      const el = ev.target as HTMLElement;
      const ask = el.closest("button[data-interview]") as HTMLElement | null;
      if (ask && this.onInterview) {
        this.onInterview(ask.getAttribute("data-interview")!);
        return;
      }
      if (el.closest("[data-send]")) {
        this.sendQuestion();
        return;
      }
      if (el.closest("[data-back]")) this.closeInterview();
    });

    // The chat input: Enter sends, and keys must not leak to the game/tablet
    // (so typing a question doesn't toggle panels or lower the tablet).
    this.screenEl.addEventListener("keydown", (ev) => {
      const input = (ev.target as HTMLElement).closest(".chat-input");
      if (!input) return;
      ev.stopPropagation();
      if (ev.key === "Enter") {
        ev.preventDefault();
        this.sendQuestion();
      }
    });
  }

  private sendQuestion() {
    const input = this.screenEl.querySelector(".chat-input") as HTMLInputElement | null;
    if (!input || this.interview.status !== "chat" || this.interview.typing) return;
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    this.interviewAsked(text);
    this.onAsk?.(text);
  }

  private faceHtml(entry: RosterEntry | undefined, expression: Expression, size: number): string {
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    drawFace(canvas.getContext("2d")!, entry, expression, size);
    return `<img class="portrait" width="${size}" height="${size}" src="${canvas.toDataURL()}" />`;
  }

  private renderInterview() {
    // A live chat with the guest: their face and name up top, the thread of
    // messages, and an input to type the next question.
    if (this.interview.status === "chat") {
      const entry = this.roster.find((e) => e.id === this.interview.target);
      const face = this.faceHtml(entry, this.interview.expression ?? "neutral", 56);
      // While waiting for the reply, the input is locked — you get one question
      // per reveal window, then read the answer when it lands.
      const waiting = this.interview.typing;
      const revealLeft = Math.max(0, Math.ceil((this.revealUntil - Date.now()) / 1000));
      const bubbles = this.interview.messages
        .map((m) =>
          m.from === "detective"
            ? `<div class="msg me">${escapeHtml(m.text)}</div>`
            : `<div class="msg them">${escapeHtml(m.text)}</div>`
        )
        .join("");
      const typing = waiting
        ? `<div class="msg them typing"><span></span><span></span><span></span>${
            this.revealUntil ? `<em class="reveal-left">${revealLeft}s</em>` : ""
          }</div>`
        : "";
      this.screenEl.innerHTML = `
        <div class="chat">
          <div class="chat-head">
            ${face}
            <div class="chat-who">${escapeHtml(this.interview.name ?? "")}</div>
            <button class="chat-back" data-back>× end</button>
          </div>
          <div class="chat-list">${bubbles}${typing}
            ${this.interview.messages.length === 0 && !waiting
              ? `<div class="chat-empty">Ask them anything. Read how they answer.</div>`
              : ""}
          </div>
          <div class="chat-compose">
            <input class="chat-input" type="text" maxlength="180"
              placeholder="${waiting ? "waiting for their reply…" : "type a question…"}"
              ${waiting ? "disabled" : ""} />
            <button class="chat-send" data-send ${waiting ? "disabled" : ""}>ask</button>
          </div>
        </div>`;
      return;
    }

    // Idle: the roster, each with a live Interview button.
    this.screenEl.innerHTML =
      (this.denied ? `<div class="denied">${escapeHtml(this.denied)}</div>` : "") +
      `<div class="note">Question a guest. Read how they answer.</div>` +
      `<ul class="roster">${this.rosterRows(true)}</ul>`;
  }

  private rosterRows(interview: boolean): string {
    // The roster is everyone but you (main filters your body out) — you can't
    // question or accuse yourself, so there's no self row to disable.
    return this.roster
      .map((e) => {
        const swatch = `#${new THREE.Color(SKINS[e.skin % SKINS.length]).getHexString()}`;
        const detail = [AGE_NAME[e.age] ?? "", e.acc ? `with ${ACC_NAME[e.acc]}` : ""]
          .filter(Boolean)
          .join(", ");
        const btn = interview
          ? `<button data-interview="${e.id}">Interview</button>`
          : `<button disabled>Accuse</button>`;
        return `<li>
            <span class="face" style="background:${swatch}"></span>
            <span class="who"><b>${e.name}</b><span class="detail">${detail}</span></span>
            ${btn}
          </li>`;
      })
      .join("");
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

    if (this.panel === INTERVIEW_PANEL) {
      this.renderInterview();
      return;
    }

    // Guess: the roster, with the action stubbed until roles are dealt (M7).
    this.screenEl.innerHTML =
      `<div class="note">Guessing unlocks once roles are dealt.</div>` +
      `<ul class="roster">${this.rosterRows(false)}</ul>`;
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const EXPR_SKINS = SKINS;

/**
 * Draw a guest's face for the interview reveal — skin, hair, hat, and a mouth
 * and brow set by their expression. Crude on purpose (the bodies are boxes);
 * it just has to read as "this person, feeling this way".
 */
function drawFace(
  ctx: CanvasRenderingContext2D,
  entry: RosterEntry | undefined,
  expression: Expression,
  size: number
) {
  const s = size;
  ctx.clearRect(0, 0, s, s);

  // Backdrop
  ctx.fillStyle = "#12151c";
  ctx.fillRect(0, 0, s, s);

  const skin = `#${new THREE.Color(EXPR_SKINS[(entry?.skin ?? 0) % EXPR_SKINS.length]).getHexString()}`;
  const hairHue = entry?.hairHue ?? 0;
  const hairCol =
    hairHue === 0
      ? "#bfbfb8"
      : `#${new THREE.Color().setHSL((hairHue / 255) % 1, 0.5, 0.22).getHexString()}`;

  const cx = s / 2;
  const headW = s * 0.5;
  const headH = s * 0.58;
  const headX = cx - headW / 2;
  const headY = s * 0.24;

  // Hair behind the head
  if ((entry?.hair ?? 0) > 0) {
    ctx.fillStyle = hairCol;
    ctx.fillRect(headX - 4, headY - 8, headW + 8, headH * 0.55);
  }

  // Head
  ctx.fillStyle = skin;
  ctx.fillRect(headX, headY, headW, headH);

  // Hat
  if ((entry?.hat ?? 0) > 0) {
    const hatCol = entry!.hat === 1 ? "#22242c" : entry!.hat === 2 ? "#4a2f22" : "#6b1f2a";
    ctx.fillStyle = hatCol;
    ctx.fillRect(headX - 6, headY - 6, headW + 12, 8);
    ctx.fillRect(cx - headW * 0.3, headY - 22, headW * 0.6, 18);
  }

  const eyeY = headY + headH * 0.4;
  const eyeDx = headW * 0.22;

  // Brows + eyes by expression
  ctx.fillStyle = "#1a1a1a";
  ctx.strokeStyle = "#1a1a1a";
  ctx.lineWidth = Math.max(2, s * 0.02);

  const brow = (tilt: number, lift: number) => {
    for (const dir of [-1, 1]) {
      const ex = cx + dir * eyeDx;
      ctx.beginPath();
      ctx.moveTo(ex - 7, eyeY - 10 + lift + dir * tilt);
      ctx.lineTo(ex + 7, eyeY - 10 + lift - dir * tilt);
      ctx.stroke();
    }
  };
  const eyes = (open: number) => {
    for (const dir of [-1, 1]) {
      const ex = cx + dir * eyeDx;
      ctx.fillRect(ex - 3, eyeY - open / 2, 6, open);
    }
  };
  // Canvas y grows downward, so +sin(t·π) pushes the mouth's middle DOWN and
  // leaves the corners up: a smile. Negative is a frown.
  const mouth = (fn: (x: number) => number, w: number) => {
    ctx.beginPath();
    const my = headY + headH * 0.74;
    for (let i = 0; i <= 10; i++) {
      const t = i / 10;
      const x = cx - w / 2 + t * w;
      const y = my + fn(t) * s * 0.06;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();
  };
  const smile = (a: number) => (t: number) => Math.sin(t * Math.PI) * a; // + = smile, - = frown

  switch (expression) {
    case "wary":
      brow(4, -2);
      eyes(5);
      mouth(smile(-0.15), headW * 0.4); // tight, slightly down
      break;
    case "loose": // drunk
      brow(-2, 3);
      eyes(4);
      mouth(smile(0.6), headW * 0.5); // loose grin
      break;
    case "nervous": // flustered
      brow(6, -3);
      eyes(8);
      mouth(smile(-0.3), headW * 0.3); // small, anxious
      break;
    case "composed": // formal
      brow(0, 0);
      eyes(5);
      mouth(smile(0), headW * 0.4); // flat
      break;
    case "warm": // articulate / rambling
      brow(-1, 1);
      eyes(6);
      mouth(smile(0.5), headW * 0.5); // pleasant smile
      break;
    case "flat": // terse
      brow(0, 2);
      eyes(4);
      mouth(smile(0), headW * 0.35); // flat
      break;
    default: // neutral
      brow(0, 0);
      eyes(6);
      mouth(smile(0.2), headW * 0.4); // faint smile
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
