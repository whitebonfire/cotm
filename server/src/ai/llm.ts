import Anthropic from "@anthropic-ai/sdk";
import { scrub, ANSWER_CAP, type Persona } from "./persona.js";

/**
 * Live conversational replies for an NPC being questioned (SOW §5).
 *
 * The Detective types real questions; the NPC answers them live, in character,
 * with the conversation so far as context — not a pre-canned line. Optional by
 * design: with no ANTHROPIC_API_KEY the game falls back to authored deflections
 * (persona.ts), and the same fallback covers a slow or failed call, so an NPC
 * is never left silent.
 */

const KEY = process.env.ANTHROPIC_API_KEY;
export const LIVE_ENABLED = !!KEY;

const MODEL = process.env.COTM_MODEL || "claude-haiku-4-5-20251001";
const TIMEOUT_MS = Number(process.env.COTM_LLM_TIMEOUT_MS) || 15000;

const client = KEY ? new Anthropic({ apiKey: KEY }) : null;

export interface ChatTurn {
  /** "detective" = the questioner (user); "guest" = this NPC (assistant). */
  role: "detective" | "guest";
  text: string;
}

function systemPrompt(persona: Persona, host: string): string {
  const voiceGuide: Record<string, string> = {
    terse: "As few words as possible. Curt, almost rude. Lowercase, missing punctuation.",
    rambling: "Ramble. Run-ons that wander off the question and never quite land.",
    sloppy: "Lowercase, dropped apostrophes, the odd typo. Can't be bothered.",
    drunk: "Confident, loud, wandering. Random capitals. Ask where the wine is.",
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
    `Reply as if typing a quick chat message. Just your reply, in first person. Stay consistent with anything you've already said. Keep each reply under ${ANSWER_CAP} characters.`,
    "HARD RULES: no em-dashes or en-dashes. No semicolons. Do not end on a tidy summary sentence. Do not be more polished than your voice allows. Never mention being an AI, a model, a character, or a game.",
  ].join("\n");
}

/**
 * Reply to the latest Detective message given the conversation so far. Returns
 * a scrubbed reply, or null if unavailable/slow/failed (caller uses authored).
 * The last turn in `history` must be the Detective's new question.
 */
export async function liveReply(persona: Persona, host: string, history: ChatTurn[]): Promise<string | null> {
  if (!client) return null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    const messages = history.map((t) => ({
      role: t.role === "detective" ? ("user" as const) : ("assistant" as const),
      content: t.text,
    }));
    // The API requires the first message to be from the user; histories always
    // start with a Detective question, so this holds.

    const res = await client.messages.create(
      {
        model: MODEL,
        max_tokens: 200,
        system: systemPrompt(persona, host),
        messages,
      },
      { signal: controller.signal }
    );
    clearTimeout(timer);

    const block = res.content.find((b) => b.type === "text");
    const text = block && block.type === "text" ? block.text : "";
    const cleaned = scrub(text).slice(0, ANSWER_CAP);
    return cleaned.length > 0 ? cleaned : null;
  } catch {
    return null;
  }
}
