import Anthropic from "@anthropic-ai/sdk";
import { spawn, execFileSync } from "child_process";
import os from "os";
import { scrub, ANSWER_CAP, type Persona } from "./persona.js";

/**
 * Live text generation for interviews and guest names (SOW §5).
 *
 * Three providers, in order of preference:
 *   1. "api" — the Anthropic SDK, when ANTHROPIC_API_KEY is set (works deployed).
 *   2. "cli" — the local `claude` CLI, using the player's existing Claude Code
 *      login, so live generation works with no separate API key (local only).
 *   3. "off" — neither available: callers fall back to authored content.
 *
 * Force one with COTM_AI_PROVIDER=api|cli|off.
 */

const KEY = process.env.ANTHROPIC_API_KEY;
const API_MODEL = process.env.COTM_MODEL || "claude-haiku-4-5-20251001";
const CLI_MODEL = process.env.COTM_CLI_MODEL || "haiku";
const TIMEOUT_MS = Number(process.env.COTM_LLM_TIMEOUT_MS) || 22000;

function claudeCliAvailable(): boolean {
  try {
    execFileSync("claude", ["--version"], { stdio: "ignore", timeout: 6000 });
    return true;
  } catch {
    return false;
  }
}

function decideProvider(): "api" | "cli" | "off" {
  const forced = process.env.COTM_AI_PROVIDER;
  if (forced === "off") return "off";
  if (forced === "api") return KEY ? "api" : "off";
  if (forced === "cli") return claudeCliAvailable() ? "cli" : "off";
  if (KEY) return "api";
  if (claudeCliAvailable()) return "cli";
  return "off";
}

export const PROVIDER = decideProvider();
export const LIVE_ENABLED = PROVIDER !== "off";
export const PROVIDER_LABEL =
  PROVIDER === "api"
    ? `Anthropic API (${API_MODEL})`
    : PROVIDER === "cli"
      ? `local claude CLI (${CLI_MODEL})`
      : "authored fallback (no key or CLI)";

const client = PROVIDER === "api" && KEY ? new Anthropic({ apiKey: KEY }) : null;

export interface ChatTurn {
  role: "detective" | "guest";
  text: string;
}

// ---------------------------------------------------------------- content guard

// A bad word must never reach the screen. Anything flagged is dropped and the
// caller uses the clean authored line instead. Mild ones included on purpose.
const BANNED =
  /\b(hell|damn(ed)?|bloody|crap|ass|arse|asshole|bastard|bitch|shit|piss|dick|cock|f+u+c+k+|cunt|slut|whore|goddamn|gods?|jesus|christs?|prick|wank|bollocks|twat)\b/i;

function isClean(text: string): boolean {
  return !BANNED.test(text);
}

/** Scrub, cap, and reject empty or unclean output → null (caller falls back). */
function finalize(raw: string): string | null {
  const cleaned = scrub(raw).slice(0, ANSWER_CAP);
  if (!cleaned || !isClean(cleaned)) return null;
  return cleaned;
}

// ---------------------------------------------------------------- provider calls

/** Single-turn API completion → raw text, or null on failure. */
async function apiRun(system: string, messages: Anthropic.MessageParam[], maxTokens: number): Promise<string | null> {
  if (!client) return null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const res = await client.messages.create(
      { model: API_MODEL, max_tokens: maxTokens, ...(system ? { system } : {}), messages },
      { signal: controller.signal }
    );
    clearTimeout(timer);
    const block = res.content.find((b) => b.type === "text");
    return block && block.type === "text" ? block.text : null;
  } catch {
    return null;
  }
}

/** Run the local `claude` CLI on a single prompt → raw stdout, or null. */
function cliRun(prompt: string): Promise<string | null> {
  return new Promise((resolve) => {
    let child;
    try {
      // cwd = tmp so it doesn't pick up this project's CLAUDE.md/tools.
      child = spawn("claude", ["-p", prompt, "--model", CLI_MODEL, "--output-format", "text"], {
        cwd: os.tmpdir(),
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      resolve(null);
      return;
    }
    let out = "";
    let done = false;
    const finish = (val: string | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(val);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(null);
    }, TIMEOUT_MS);
    child.stdout?.on("data", (d) => (out += d.toString()));
    child.on("error", () => finish(null));
    child.on("close", () => finish(out.trim() ? out : null));
  });
}

// ---------------------------------------------------------------- interview

function systemPrompt(persona: Persona, host: string): string {
  const voiceGuide: Record<string, string> = {
    terse: "As few words as possible. Curt, almost rude. Lowercase, missing punctuation.",
    rambling: "Ramble. Run-ons that wander off the question and never quite land.",
    sloppy: "Lowercase, dropped apostrophes, the odd typo. Can't be bothered.",
    drunk: "Confident, loud, wandering, jovial. Random capitals. Ask where the wine is.",
    formal: "Immaculate grammar, a little stiff and old-fashioned.",
    guarded: "Give away nothing. Answer questions with questions. Faintly suspicious.",
    flustered: "Nervous, restart sentences, trail off, apologise. Lots of 'um' and 'sorry'.",
    articulate: "Warm, well-spoken, real answers with a small personal detail.",
  };

  return [
    "You are a guest at a private party in a grand house. A detective is quietly chatting with you, trying to work out who among the guests is a hidden spy. You are NOT the spy — you are a real guest with nothing to hide except small private embarrassments.",
    "Respond naturally to WHATEVER they say, exactly like a real person would in a chat. If they just say 'hi' or 'how are you', say hello back and make small talk. If they ask a real question, answer it in character. Never give a robotic non-answer to a normal greeting or a simple question, and never sound evasive unless your voice is the guarded type.",
    `Who you are: ${persona.job}. You are ${persona.tie}. You ${persona.reason}. The host is ${host}.`,
    `Something you'd rather not discuss: you ${persona.secret}.`,
    `An opinion you hold: you ${persona.opinion}.`,
    `Your writing voice — keep it consistent every reply: ${voiceGuide[persona.voice]}`,
    `Keep it SHORT — one or two brief sentences at most, like a quick text message. Never a paragraph. Reply in first person, just your message. Stay consistent with anything you've already said. Hard limit ${ANSWER_CAP} characters.`,
    "KEEP IT CLEAN: no profanity, swearing, slurs, insults, or crude, sexual, or violent content of any kind — not even mild words like 'hell' or 'damn', and no religious exclamations like 'god', 'oh my god', or 'jesus'. Use 'goodness', 'heavens', 'my word' and the like instead. These are refined, well-mannered guests at an elegant evening. Even the drunk guest is jovial and loud, never coarse.",
    "HARD RULES: no em-dashes or en-dashes. No semicolons. Do not end on a tidy summary sentence. Do not be more polished than your voice allows. Never mention being an AI, a model, a character, or a game.",
  ].join("\n");
}

/**
 * Reply to the latest Detective message given the conversation so far. Returns a
 * scrubbed, clean reply, or null if unavailable/slow/failed/unclean (caller uses
 * the authored fallback). The last turn in `history` must be the new question.
 */
export async function liveReply(persona: Persona, host: string, history: ChatTurn[]): Promise<string | null> {
  if (PROVIDER === "off") return null;
  const system = systemPrompt(persona, host);

  if (PROVIDER === "api") {
    const messages: Anthropic.MessageParam[] = history.map((t) => ({
      role: t.role === "detective" ? "user" : "assistant",
      content: t.text,
    }));
    const raw = await apiRun(system, messages, 110);
    return raw === null ? null : finalize(raw);
  }

  const convo = history.map((t) => (t.role === "detective" ? "Detective: " : "You: ") + t.text).join("\n");
  const prompt = `${system}\n\nConversation so far:\n${convo}\n\nWrite ONLY your next reply as this guest, nothing else:`;
  const raw = await cliRun(prompt);
  return raw === null ? null : finalize(raw);
}

// ---------------------------------------------------------------- names

/**
 * Generate `count` party-guest names live, or null if unavailable. Used to keep
 * a name pool topped up (names.ts) so guests aren't drawn from a canned list.
 */
export async function generateNames(count: number): Promise<string[] | null> {
  if (PROVIDER === "off") return null;
  const prompt = [
    `Invent ${count} names for guests at an elegant, old-fashioned high-society house party (think British aristocracy between the wars).`,
    `One name per line, formatted "Firstname Surname". Use a WIDE variety of first names and surnames, all different from one another — no repeats, no two guests sharing a first name.`,
    `Output only the names. No numbering, no bullets, no commentary, no blank lines.`,
  ].join("\n");

  const raw = PROVIDER === "api" ? await apiRun("", [{ role: "user", content: prompt }], 500) : await cliRun(prompt);
  if (!raw) return null;

  const names = raw
    .split("\n")
    .map((l) => l.replace(/^\s*[-*•\d.)]+\s*/, "").trim())
    .map((l) => {
      const m = l.match(/^([A-Z][A-Za-z'’.-]+)\s+([A-Z][A-Za-z'’.-]+)/);
      return m ? `${m[1]} ${m[2]}` : null;
    })
    .filter((n): n is string => !!n);

  return names.length ? names : null;
}
