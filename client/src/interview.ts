/**
 * The typing box — what the Spy (or any human) sees when the Detective questions
 * their body (SOW §5).
 *
 * Your screen becomes this box. It shows the question, and the persona you're
 * wearing, so you can PERFORM a character the game handed you rather than invent
 * one cold under a 40-second timer. Type your reply, capped to the same length
 * the NPCs get, so a wall of text can't itself be the tell. The moment you
 * submit you get your body back; while you type, it autopilots (server-side), so
 * a frozen guest doesn't give you away.
 */

export interface PromptData {
  question: string;
  cap: number;
  persona: { job: string; tie: string; reason: string; host: string };
}

export class InterviewBox {
  open = false;
  private root: HTMLDivElement;
  private field!: HTMLTextAreaElement;
  private countEl!: HTMLDivElement;
  private timerEl!: HTMLDivElement;
  private cap = 320;
  private deadline = 0;
  private ticker: ReturnType<typeof setInterval> | null = null;
  private submitted = false;
  onSubmit: ((text: string) => void) | null = null;

  /** Window length in ms — matches the server, for the countdown + auto-submit. */
  windowMs = 40000;

  constructor() {
    const root = document.createElement("div");
    root.id = "typebox";
    root.className = "hidden";
    root.innerHTML = `
      <div class="tb-frame">
        <div class="tb-head">
          <span class="tb-dot">●</span> someone is questioning you
          <div class="tb-timer"></div>
        </div>
        <div class="tb-q"></div>
        <div class="tb-persona"></div>
        <textarea class="tb-input" rows="3" placeholder="type your reply…"></textarea>
        <div class="tb-foot">
          <div class="tb-count"></div>
          <button class="tb-send">reply &amp; get moving</button>
        </div>
      </div>`;
    document.body.appendChild(root);
    this.root = root;
    this.field = root.querySelector(".tb-input") as HTMLTextAreaElement;
    this.countEl = root.querySelector(".tb-count") as HTMLDivElement;
    this.timerEl = root.querySelector(".tb-timer") as HTMLDivElement;

    this.field.addEventListener("input", () => this.updateCount());
    this.field.addEventListener("keydown", (e) => {
      // Enter sends; Shift+Enter is a newline. Stop keys leaking to the game.
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        this.submit();
      }
      e.stopPropagation();
    });
    (root.querySelector(".tb-send") as HTMLButtonElement).addEventListener("click", () => this.submit());
  }

  show(data: PromptData) {
    this.cap = data.cap;
    this.submitted = false;
    this.deadline = Date.now() + this.windowMs;
    this.field.value = "";
    this.field.maxLength = data.cap;

    (this.root.querySelector(".tb-q") as HTMLDivElement).textContent = data.question;
    (this.root.querySelector(".tb-persona") as HTMLDivElement).innerHTML = `
      <div class="tb-label">you are</div>
      ${escapeHtml(data.persona.job)}, ${escapeHtml(data.persona.tie)}.
      You ${escapeHtml(data.persona.reason)}. The host is ${escapeHtml(data.persona.host)}.
      <div class="tb-hint">answer as them, before the clock runs out</div>`;

    this.root.classList.remove("hidden");
    this.open = true;
    this.updateCount();
    this.field.focus();

    if (this.ticker) clearInterval(this.ticker);
    this.ticker = setInterval(() => this.tick(), 250);
  }

  private tick() {
    const left = Math.max(0, this.deadline - Date.now());
    this.timerEl.textContent = `${Math.ceil(left / 1000)}s`;
    this.timerEl.classList.toggle("urgent", left < 8000);
    // Auto-send a little before the window closes, so what's typed still counts
    // rather than falling back to the authored line.
    if (left <= 1200 && !this.submitted) this.submit();
  }

  private updateCount() {
    const n = this.field.value.length;
    this.countEl.textContent = `${n}/${this.cap}`;
    this.countEl.classList.toggle("full", n >= this.cap);
  }

  private submit() {
    if (this.submitted) return;
    this.submitted = true;
    const text = this.field.value.trim();
    this.onSubmit?.(text);
    // Don't hide yet — wait for the server's interview_end so control returns in
    // step with the body coming off autopilot.
  }

  hide() {
    this.root.classList.add("hidden");
    this.open = false;
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = null;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
