import Anthropic from "@anthropic-ai/sdk";
import { QUESTION, scrub, ANSWER_CAP, type Persona } from "./persona.js";

/**
 * Live answer generation.
 *
 * Optional by design. With no ANTHROPIC_API_KEY the game runs entirely on the
 * authored answers in persona.ts — which is also the fallback whenever a live
 * call is slow or fails. So the interview never breaks: a silent NPC would look
 * exactly like a stalling Spy, and that must never happen (SOW §5.2).
 *
 * The Detective's panel is blank for the full interview window regardless, so
 * all of this latency is hidden — a 6-second call and a 0.3-second one look
 * identical to the player. That's why live generation is safe here (SOW §5.2).
 */

const KEY = process.env.ANTHROPIC_API_KEY;
export const LIVE_ENABLED = !!KEY;

/** Haiku: latency headroom we don't need but shouldn't waste. */
const MODEL = process.env.COTM_MODEL || "claude-haiku-4-5-20251001";

/** Hard timeout — half the 40s window at most. Falls through to authored. */
const TIMEOUT_MS = Number(process.env.COTM_LLM_TIMEOUT_MS) || 20000;

const client = KEY ? new Anthropic({ apiKey: KEY }) : null;

function systemPrompt(persona: Persona): string {
  // The voice instruction is what produces the spread. The fingerprint bans are
  // what stop a live answer being spotted by punctuation (SOW §5.3).
  const voiceGuide: Record<string, string> = {
    terse: "Answer in as few words as possible. Curt, almost rude. Lowercase, missing punctuation.",
    rambling: "Ramble. One long run-on that wanders off the question and never quite lands.",
    sloppy: "Lowercase, dropped apostrophes, a typo or two. Can't be bothered.",
    drunk: "Confident, loud, wandering. Random capitals. Slightly aggressive. Ask where the wine is.",
    formal: "Immaculate grammar, a little stiff and old-fashioned. Proper capitalisation.",
    guarded: "Answer a question with a question. Give away nothing. Faintly suspicious of being asked.",
    flustered: "Nervous, start sentences over, trail off, apologise. Lots of 'um' and 'sorry'.",
    articulate: "Warm, well-spoken, a real answer with a small personal detail. Clearly educated.",
  };

  return [
    "You are a guest at a private party in a grand house, being asked why you're here.",
    "Reply IN CHARACTER as this guest, in first person, as if typing a quick reply. Just the reply, nothing else.",
    `Your writing voice: ${voiceGuide[persona.voice]}`,
    `You are ${persona.job}. You are ${persona.tie}. You ${persona.reason}.`,
    `Keep it under ${ANSWER_CAP} characters.`,
    "HARD RULES: no em-dashes or en-dashes. No semicolons. Do not end on a tidy summary sentence. Do not be more polished than your voice allows. Never mention being an AI or a character.",
  ].join("\n");
}

/**
 * Returns a scrubbed answer, or null if unavailable/slow/failed so the caller
 * can use the authored one. Never throws.
 */
export async function liveAnswer(persona: Persona): Promise<string | null> {
  if (!client) return null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    const res = await client.messages.create(
      {
        model: MODEL,
        max_tokens: 200,
        system: systemPrompt(persona),
        messages: [{ role: "user", content: QUESTION }],
      },
      { signal: controller.signal }
    );
    clearTimeout(timer);

    const block = res.content.find((b) => b.type === "text");
    const text = block && block.type === "text" ? block.text : "";
    const cleaned = scrub(text).slice(0, ANSWER_CAP);
    return cleaned.length > 0 ? cleaned : null;
  } catch {
    return null; // timeout, network, quota — the authored answer covers us
  }
}
