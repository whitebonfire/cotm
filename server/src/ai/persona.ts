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
export const ANSWER_CAP = 180;

/**
 * Authored reply to an ARBITRARY typed question, in the guest's voice. This is
 * the fallback when there's no API key or a live call fails — best-effort, since
 * without the model it can't truly converse. It reads the question for a few
 * common intents (why are you here / who are you) and otherwise deflects in
 * voice. Live AI is what makes the conversation real; this just keeps it from
 * ever going silent.
 */
type Intent = "greeting" | "whyhere" | "who" | "accuse" | "deflect";

function intentOf(q: string): Intent {
  q = q.toLowerCase().trim();
  const isGreeting =
    /^(hi|hey+|hello+|yo|hiya|howdy|sup|heya|ello|oi)\b/.test(q) ||
    /\b(good )?(evening|morning|afternoon)\b/.test(q) ||
    /\bhow('?s| is| are)\b.*\b(you|it going|things|the (party|evening))\b/.test(q) ||
    /\b(you )?(alright|ok|okay)\??$/.test(q) ||
    q.length <= 3;
  if (isGreeting) return "greeting";
  if (/\b(why|what).*(here|come|party|tonight|attend)|bring you/.test(q)) return "whyhere";
  if (/\b(who are you|your name|what.*do|your job|occupation)\b/.test(q)) return "who";
  if (/\b(spy|lying|lie|suspicious|hiding|hide|guilty|did you)\b/.test(q)) return "accuse";
  return "deflect";
}

/**
 * Authored reply to an arbitrary typed question — the no-key / timeout fallback.
 *
 * History-aware so it isn't robotic: it never repeats its own last line word for
 * word, and if the Detective asks the same kind of question again it says so, in
 * voice ("i just told you…"), the way a real guest would. An NPC that parrots
 * itself verbatim would be the one thing that outs it — and let the Detective
 * catch every NPC just by asking twice. (Live AI handles all of this naturally,
 * since it gets the full conversation; this only has to be good enough.)
 */
export function authoredReply(
  name: string,
  persona: Persona,
  host: string,
  question: string,
  history: Array<{ role: "detective" | "guest"; text: string }> = []
): string {
  const q = question.toLowerCase().trim();
  const v = persona.voice;
  const intent = intentOf(q);

  const priorDetective = history.slice(0, -1).filter((t) => t.role === "detective");
  const repeated =
    intent !== "deflect" && priorDetective.some((t) => intentOf(t.text) === intent);
  const lastGuest = [...history].reverse().find((t) => t.role === "guest")?.text ?? "";

  const base: string[] = repeated
    ? REPEAT[v](persona.tie, persona.job, host)
    : intent === "greeting"
      ? GREETING[v]()
      : intent === "whyhere"
        ? WHY_HERE[v](persona.tie, persona.job, host)
        : intent === "who"
          ? WHO[v](persona.tie, persona.job)
          : intent === "accuse"
            ? ACCUSED[v]()
            : DEFLECT[v]();

  // Don't say the exact thing they just said.
  const fresh = base.filter((o) => scrub(o) !== lastGuest);
  return scrub(pick(fresh.length ? fresh : base));
}

/** "You already asked me that" — in voice, the way a real guest gets a bit
 *  impatient at a repeated question rather than parroting the same line. */
const REPEAT: Record<Voice, Lines> = {
  terse: () => [`already told you`, `same as before`, `asked me that`],
  rambling: (tie) => [`goodness, havent we been over this, but yes, ${tie}, like i said, are you quite alright`],
  sloppy: () => [`like i said mate`, `told you already didnt i`],
  drunk: () => [`did i not JUST tell you that. keep UP`, `youre asking me again? honestly`],
  formal: () => [`As I have already said.`, `I believe I answered that.`],
  guarded: () => [`why do you keep asking me the same thing`, `i've told you. once was enough`],
  flustered: () => [`oh, didnt i, sorry, i think i already, um, said`, `oh gosh, again? i, i did answer`],
  articulate: (tie) => [`I did just say, but I don't mind repeating it: I'm ${tie}.`, `You've asked me that already. Same answer, I'm afraid.`],
};

/** Natural greetings, in voice — what a real guest says back to "hi". */
const GREETING: Record<Voice, () => string[]> = {
  terse: () => [`evening`, `hello`, `hi`],
  rambling: () => [`oh, hello! lovely to, well, are you enjoying the party, i keep losing track of everyone`],
  sloppy: () => [`hey. hows it going`, `hi there`, `evening`],
  drunk: () => [`HELLO friend. come to have a drink with me`, `evenin! good to see a friendly face`],
  formal: () => [`Good evening.`, `Hello. A pleasure.`],
  guarded: () => [`hello. do i know you?`, `evening. was there something you wanted`],
  flustered: () => [`oh! hi, hello, sorry, um, hi`, `oh, hello, you startled me`],
  articulate: () => [`Hello there. Enjoying the evening?`, `Good evening. Lovely party, isn't it.`],
};

type Lines = (a?: string, b?: string, c?: string) => string[];

const WHY_HERE: Record<Voice, Lines> = {
  terse: (tie) => [`${tie}. thats it`, `invited. same as anyone`],
  rambling: (tie, job) => [`oh gosh, i'm ${tie}, we go back years, and honestly i almost didnt come but here i am, lovely house isnt it`],
  sloppy: (tie) => [`im ${tie}. good party i guess`],
  drunk: (tie) => [`THE HOST. love em. we go way back. ${tie} or somethin. wheres the wine`],
  formal: (tie, job, host) => [`I am ${tie}. ${host} was kind enough to include me.`],
  guarded: () => [`why do you ask? i was invited, same as everyone`],
  flustered: (tie) => [`oh, i, sorry, i was invited? i'm ${tie}, yes`],
  articulate: (tie) => [`I'm ${tie}. I came for the company more than the wine, truthfully. Though the wine is good.`],
};

const WHO: Record<Voice, Lines> = {
  terse: (tie, job) => [`${job}. why`, `nobody important`],
  rambling: (tie, job) => [`well i'm ${job}, have been for years, though i dabble in all sorts really, its a long story`],
  sloppy: (tie, job) => [`im ${job}. thats about it`],
  drunk: (tie, job) => [`im ${job}. DID you know that. bet you didnt`],
  formal: (tie, job) => [`I am ${job}, and ${tie}.`],
  guarded: () => [`does it matter who i am? i'm a guest`],
  flustered: (tie, job) => [`um, i'm, sorry, i'm ${job}? i think thats, yes`],
  articulate: (tie, job) => [`I'm ${job} by trade, though I'd rather talk about almost anything else.`],
};

const ACCUSED: Record<Voice, () => string[]> = {
  terse: () => [`no`, `dont be daft`],
  rambling: () => [`me? goodness no, i wouldnt even know how, i'm just here for the evening honestly, what a thing to ask`],
  sloppy: () => [`ha. no. wrong person mate`],
  drunk: () => [`a SPY? ME? thats the funniest thing ive heard all night. buy me a drink`],
  formal: () => [`I beg your pardon. I am nothing of the sort.`],
  guarded: () => [`interesting question. why would you think that`],
  flustered: () => [`what?? no, i, why would you, oh gosh, no, i'm just a guest, sorry`],
  articulate: () => [`No. And I'd be a fairly poor one if I were, standing here talking to you.`],
};

const DEFLECT: Record<Voice, () => string[]> = {
  terse: () => [`cant say`, `no idea`, `hm`],
  rambling: () => [`oh, thats a funny one, i'm not sure really, i was just thinking about something else entirely, what were we saying`],
  sloppy: () => [`dunno really. good question tho`],
  drunk: () => [`no idea what you mean. is there more wine going round`],
  formal: () => [`I'm not certain I follow your meaning.`],
  guarded: () => [`why do you want to know that`],
  flustered: () => [`oh, um, i'm not, sorry, i dont really know what to say to that`],
  articulate: () => [`That's a curious thing to ask. I'm not sure I have a good answer for you.`],
};
