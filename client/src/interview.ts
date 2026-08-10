/**
 * The being-questioned box — what a human sees when the Detective is
 * interviewing their body (SOW §5).
 *
 * Now a live chat: your screen becomes this box, showing the persona you're
 * wearing (so you can PERFORM a character the game handed you, not invent one),
 * and the Detective's questions arrive one at a time. Type a reply to each. The
 * input is only live while a question is waiting; between questions you sit
 * tight. Your body autopilots (server-side) the whole time, so a frozen guest
 * doesn't give you away.
 */

export interface BeginData {
  cap: number;
  /** The guest name you're wearing — the Detective addresses you by it. */
  name: string;
  persona: { job: string; tie: string; reason: string; host: string };
}

export class InterviewBox {
  open = false;
  private root: HTMLDivElement;
  private thread!: HTMLDivElement;
  private field!: HTMLTextAreaElement;
  private countEl!: HTMLDivElement;
  private cap = 320;
  /** True while a question is on the table and we're waiting for their reply. */
  private pending = false;
  private deadline = 0;
  private ticker: ReturnType<typeof setInterval> | null = null;
  private timerEl!: HTMLDivElement;
  onSubmit: ((text: string) => void) | null = null;

  constructor() {
    const root = document.createElement("div");
    root.id = "typebox";
    root.className = "hidden";
    root.innerHTML = `
      <div class="tb-frame">
        <div class="tb-head"><span class="tb-dot">●</span> someone is questioning you<div class="tb-timer"></div></div>
        <div class="tb-persona"></div>
        <div class="tb-thread"></div>
        <div class="tb-compose">
          <textarea class="tb-input" rows="2" placeholder="waiting for their question…" disabled></textarea>
          <div class="tb-foot">
            <div class="tb-count"></div>
            <button class="tb-send" disabled>reply</button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(root);
    this.root = root;
    this.thread = root.querySelector(".tb-thread") as HTMLDivElement;
    this.field = root.querySelector(".tb-input") as HTMLTextAreaElement;
    this.countEl = root.querySelector(".tb-count") as HTMLDivElement;
    this.timerEl = root.querySelector(".tb-timer") as HTMLDivElement;

    this.field.addEventListener("input", () => this.updateCount());
    this.field.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        this.submit();
      }
      e.stopPropagation();
    });
    (root.querySelector(".tb-send") as HTMLButtonElement).addEventListener("click", () => this.submit());
  }

  /** The Detective opened a chat with us. Show the persona; wait for questions. */
  begin(data: BeginData) {
    this.cap = data.cap;
    this.pending = false;
    this.field.maxLength = data.cap;
    this.field.value = "";
    this.thread.innerHTML = "";
    (this.root.querySelector(".tb-persona") as HTMLDivElement).innerHTML = `
      <div class="tb-label">you are</div>
      <div class="tb-name">${escapeHtml(data.name ?? "")}</div>
      ${escapeHtml(data.persona.job)}, ${escapeHtml(data.persona.tie)}.
      You ${escapeHtml(data.persona.reason)}. The host is ${escapeHtml(data.persona.host)}.
      <div class="tb-hint">answer their questions as this guest</div>`;
    this.setEnabled(false, "waiting for their question…");
    this.root.classList.remove("hidden");
    this.open = true;
  }

  /** A question arrived — show it and let them reply within the window. */
  question(text: string, windowMs = 20000) {
    this.addBubble(text, "them");
    this.pending = true;
    this.setEnabled(true, "type your reply…");
    this.field.value = "";
    this.updateCount();
    this.field.focus();

    // Countdown to the reveal. Auto-send a little early so it reaches the server
    // before the window closes; otherwise the detective sees an authored line.
    this.deadline = Date.now() + windowMs;
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = setInterval(() => {
      const left = Math.max(0, this.deadline - Date.now());
      this.timerEl.textContent = `${Math.ceil(left / 1000)}s`;
      this.timerEl.classList.toggle("urgent", left < 6000);
      if (left <= 1200 && this.pending && this.field.value.trim()) this.submit();
    }, 250);
  }

  private submit() {
    if (!this.pending) return;
    const text = this.field.value.trim();
    if (!text) return;
    this.pending = false;
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = null;
    this.timerEl.textContent = "";
    this.addBubble(text, "me");
    this.onSubmit?.(text);
    this.setEnabled(false, "sent — waiting for their next question…");
  }

  private addBubble(text: string, who: "me" | "them") {
    const div = document.createElement("div");
    div.className = `tb-msg ${who}`;
    div.textContent = text;
    this.thread.appendChild(div);
    this.thread.scrollTop = this.thread.scrollHeight;
  }

  private setEnabled(on: boolean, placeholder: string) {
    this.field.disabled = !on;
    (this.root.querySelector(".tb-send") as HTMLButtonElement).disabled = !on;
    this.field.placeholder = placeholder;
  }

  private updateCount() {
    const n = this.field.value.length;
    this.countEl.textContent = `${n}/${this.cap}`;
    this.countEl.classList.toggle("full", n >= this.cap);
  }

  hide() {
    this.root.classList.add("hidden");
    this.open = false;
    this.pending = false;
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = null;
    this.timerEl.textContent = "";
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
