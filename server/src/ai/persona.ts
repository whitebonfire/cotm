/**
 * Who each guest is, and how they write.
 *
 * This is the heart of the game (SOW §5). Every guest carries a persona — a
 * reason for being at this party — and a writing VOICE. When the Detective
 * interviews someone, the answer is written in that voice. The Spy is a human
 * typing under a timer; the NPCs are these personas.
 *
 * §5.3, the writing spread, is the single largest design risk. If NPCs all
 * wrote cleanly, the Detective would just accuse the worst writer; if they all
 * wrote badly, they'd accuse the best. So the voices span a deliberate range,
 * and a human under pressure lands somewhere inside it rather than at an end.
 * At least one guest writes well, so being articulate isn't itself an
 * accusation. Voices are fixed for a round and re-rolled between rounds.
 *
 * Personas live in server memory only. They are never Schema fields — the
 * answer text is sent to the interviewing client alone. See SOW §7.1.
 */

export type Voice =
  | "terse"
  | "rambling"
  | "sloppy"
  | "drunk"
  | "formal"
  | "guarded"
  | "flustered"
  | "articulate";

/** Face expression shown with the answer. Rendered on the client. */
export type Expression = "neutral" | "wary" | "loose" | "nervous" | "composed" | "warm" | "flat";

const VOICE_EXPRESSION: Record<Voice, Expression> = {
  terse: "flat",
  rambling: "warm",
  sloppy: "neutral",
  drunk: "loose",
  formal: "composed",
  guarded: "wary",
  flustered: "nervous",
  articulate: "warm",
};

export interface Persona {
  /** Writing voice — how their answers read. */
  voice: Voice;
  job: string;
  /** How they know the host. */
  tie: string;
  /** Why they came tonight. */
  reason: string;
  /** Something they'd rather not be asked about. */
  secret: string;
  /** Their read on another guest — flavour for follow-ups later. */
  opinion: string;
}

/** The party has a host; guests explain themselves in relation to them. */
export const HOSTS = [
  "Lady Ashcombe",
  "the Vaughans",
  "old Cornelius",
  "the Dowager",
  "Sir Edmund",
  "Mrs. Fairholt",
];

const JOBS = [
  "a retired judge", "an art dealer", "a surgeon", "a novelist", "a banker",
  "a museum curator", "a vintner", "a diplomat's widow", "a horse breeder",
  "a professor of history", "a jeweller", "an antiquarian", "a concert pianist",
  "a shipping heir", "a barrister", "a botanist",
];

const TIES = [
  "an old friend of the host", "the host's cousin", "a neighbour of the host",
  "a business partner of the host", "the host's former tutor", "on the host's charity board",
  "an acquaintance from the club", "the host's late husband's friend",
  "someone the host owes a favour", "barely knows the host, honestly",
];

const REASONS = [
  "was simply invited, like everyone",
  "came for the wine and the company",
  "wouldn't miss it for the world",
  "was dragged along and would rather be home",
  "heard the jewels would be on show",
  "came to settle a small matter with someone here",
  "is between engagements and had nowhere better to be",
  "never turns down a good party",
  "came to see the house before it's sold",
  "owed the host an appearance",
];

const SECRETS = [
  "is quietly in debt", "recognises another guest and wishes they didn't",
  "isn't really on the guest list", "is here to avoid someone else entirely",
  "pocketed something small earlier and feels awful about it",
  "has been drinking since noon", "is not who they said they were at the door",
  "came to say a goodbye they haven't managed yet",
];

const OPINIONS = [
  "thinks the man by the window is a bore",
  "finds the woman with the necklace insufferable",
  "suspects the fellow in the hat is a fraud",
  "rather likes the quiet one in the library",
  "can't stand how loudly people are laughing",
  "keeps an eye on whoever's near the jewels",
];

const pick = <T>(a: readonly T[]): T => a[Math.floor(Math.random() * a.length)];

/**
 * Assign voices across the whole party so the spread holds: never all the same,
 * at least one articulate, and re-rolled each round. Returns one voice per body
 * in order.
 */
export function assignVoices(count: number): Voice[] {
  // A weighted bag — imperfect voices are common (it's a party, people are
  // distracted and a little drunk), but articulate and formal exist so clean
  // writing isn't itself a tell.
  const bag: Voice[] = [
    "terse", "terse",
    "rambling", "rambling",
    "sloppy", "sloppy",
    "drunk",
    "guarded", "guarded",
    "flustered",
    "formal",
    "articulate", "articulate",
  ];

  const voices: Voice[] = [];
  for (let i = 0; i < count; i++) voices.push(pick(bag));

  // Guarantee at least one articulate and one plain-bad voice, so the range is
  // never accidentally narrow.
  if (!voices.includes("articulate")) voices[0] = "articulate";
  if (!voices.some((v) => v === "terse" || v === "sloppy" || v === "drunk")) {
    voices[voices.length - 1] = "sloppy";
  }
  return voices;
}

export function generatePersona(voice: Voice): Persona {
  return {
    voice,
    job: pick(JOBS),
    tie: pick(TIES),
    reason: pick(REASONS),
    secret: pick(SECRETS),
    opinion: pick(OPINIONS),
  };
}

/** The question the Detective asks. Kept constant so answers are comparable. */
export const QUESTION = "It's a private party. What brings you here tonight?";

export function expressionFor(voice: Voice): Expression {
  return VOICE_EXPRESSION[voice];
}

/**
 * Strip the tells that mark text as machine-written, so an AI answer can't be
 * spotted by punctuation alone (SOW §5.3). Applied to both authored and live
 * answers, so they're rendered on equal terms.
 */
export function scrub(text: string): string {
  return text
    .replace(/\s*[—–]\s*/g, ", ") // em/en dashes -> comma
    .replace(/;/g, ".") // semicolons -> full stop
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Authored answer in the guest's voice. This is the default when there's no API
 * key, and the fallback when a live call is slow or fails — so it must stand on
 * its own. Built from the persona so it stays consistent with who they are.
 */
export function authoredAnswer(name: string, persona: Persona, host: string): string {
  const first = name.split(" ")[0];
  const job = persona.job;
  const tie = persona.tie;

  const byVoice: Record<Voice, () => string> = {
    terse: () => pick([
      `${tie}. thats it`,
      `invited. same as anyone`,
      `i know the host. why`,
      `not much to tell. friend of the family`,
    ]),
    rambling: () => pick([
      `oh gosh well i'm ${tie}, we go back years and years, and honestly i almost didn't come because the weather was dreadful but here i am, is there more of that wine going round`,
      `so i'm ${job} by trade, and ${tie}, and the whole thing is a bit of a blur really, lovely house though, have you seen the library`,
      `funny you ask, i was just saying to someone, i'm ${tie} and i simply adore these evenings, though my feet are killing me and i've lost track of who's who`,
    ]),
    sloppy: () => pick([
      `im ${tie}. good party i guess. bit warm in here`,
      `friend of the host, ${job} if it matters. nice enough evening`,
      `${tie}, thats the short of it. dont mind me`,
    ]),
    drunk: () => pick([
      `THE HOST. love em. we go WAY back. ${tie} or somethin. is there more wine`,
      `im ${job}. did you know that. bet you didnt. great party. GREAT`,
      `who's asking. im ${tie}, thats who. now wheres the bar gone`,
    ]),
    formal: () => pick([
      `I am ${tie}, and was kind enough to be included this evening. A charming gathering.`,
      `${host.replace(/^the /, "The ")} and I are long acquainted. I am ${job}, if that signifies.`,
      `I attend at the host's invitation. One does not decline such things lightly.`,
    ]),
    guarded: () => pick([
      `why do you ask? i was invited. same as everyone here`,
      `i don't see that it's any of your concern. i know the host`,
      `is there a reason you're asking me and not the others`,
    ]),
    flustered: () => pick([
      `oh, i, sorry, i'm here because, well, i was invited? ${first === name ? "" : ""}the host, yes. i'm ${tie}`,
      `um, i, that's, i came because, sorry, ${tie}, i don't know why i'm so, anyway`,
      `oh! i didn't, sorry, i'm just, i know the host, i'm ${tie}, is that, is that alright`,
    ]),
    articulate: () => pick([
      `I've known the host for years. We sat on a committee together once, back when I was still ${job}. They insisted I come, and one doesn't refuse them.`,
      `I'm ${tie}, and frankly I came for the company more than the wine. Though the wine is very good. Have you tried it?`,
      `Truthfully? I ${persona.reason.replace(/^is |^was |^came |^never |^wouldn't |^heard |^owed /, (m) => m)}. But that sounds grander than it is. I'm ${tie}, nothing more.`,
    ]),
  };

  return scrub(byVoice[persona.voice]());
}

/** Rough character cap — the Spy's answer is capped to about this, so a wall of
 *  text can't itself become the tell. */
export const ANSWER_CAP = 320;
