# 🔎 Clues of the Mind 🕶 — Statement of Work

**Version:** 0.1 (draft for review)
**Date:** 2026-07-16
**Build team:** Jer (direction) + Claude (implementation)
**Deadline:** none — sequenced by dependency, not calendar

---

## 1. What this is

A browser-based 3D detective game for **two human players**. One is dealt the Detective, one the Spy. The Spy hides among twelve AI partygoers in a house. The Detective has ten minutes, two guesses, and a tablet.

The core of the game is the **interview**: the Detective questions someone and, forty seconds later, reads their written explanation for being at the party. If the target was an NPC, an AI model wrote it. If the target was the Spy, a human being wrote it under a timer.

The whole game is a wager on one question: *can you tell?*

Everything else in this document — the rain, the grenade, the magnifying glass, the cameras — exists to make that question interesting.

---

## 2. The clock, the freeze, and the balance requirement

### 2.1 Win conditions — resolved

| Path | Outcome |
|---|---|
| Detective guesses correctly | Detective wins |
| Detective guesses wrong twice | Spy wins |
| Spy completes all 3 tasks | Spy wins |
| Timer hits zero, tasks unfinished | **Detective wins** |

`snap` now works: it is the ability of a Spy who is behind schedule, and a real reason to stalk the Detective with a camera out. Tasks are the Spy's actual job rather than decoration.

### 2.2 The timer is a Spy deadline, not a Detective shield — **balance requirement**

The obvious objection to a Detective runout win is stalling: why interview anyone when you can patrol, seal rooms, and let the clock do the work?

The answer isn't a rule, it's a tuning target. **A competent Spy should finish three tasks in roughly seven to eight minutes.** If that holds, runout stops being a Detective strategy and becomes a punishment for a Spy who fumbled — the round almost always ends in a guess or a completed mission, and the ten-minute clock is pressure on the Spy rather than cover for the Detective.

Two things have to stay true for that to work:

- **Task denial must be weak.** `inspection` seals one room for 30 seconds on a 2-minute cooldown; a camera watches one angle. Against 3 tasks spread across 6-8 rooms and 12 NPCs, a Detective simply cannot cover the house. This is a feature. If playtesting shows a Detective can reliably deny tasks by camping, the denial tools need weakening, not the clock.
- **Tasks must be genuinely demanding.** If a Spy finishes in four minutes, the Detective never gets to play. If they need eleven, the Detective wins by standing still. This number wants real playtesting; treat 7-8 minutes as the target and expect to tune the tasks, not the timer.

Get this wrong in either direction and the game breaks — too fast and the interview never happens, too slow and it doesn't matter. **This is the primary balance risk of the project.**

### 2.2a The interview is now a live chat (supersedes the 40s blank panel)

**Design change during build (milestone 5/6).** The interview was reworked from
"pick a target, blank panel for 40s, one written answer" into a **live chat**:
the Detective types real questions and the guest answers turn by turn. NPCs
answer live via the model; a human types their own replies.

This trades away the blank window's latency-hiding, so the timing tell it solved
(§5.2) comes back — a live conversation exposes how long a reply took. It's
handled instead by **pacing**: an NPC's reply is held back to a length-scaled,
human-like delay that absorbs however long generation took, so answer *speed*
can't out the AI and the Detective still has to read the writing (§5.3). A
human's real typing time is shown the same way (a "typing" indicator). The
per-answer character cap and the writing-voice spread are unchanged.

Open questions this raises, to revisit in playtesting: whether the pacing band
(currently ~2.5–14s) actually overlaps human typing times well enough, and
whether an interrogated human being pinned on autopilot for the chat's duration
(auto-released after the Detective goes idle) is the right cost.

### 2.3 No freeze — resolved

Interviews do not stop the world. An interviewed NPC keeps walking, drinking, reading, and talking exactly as before. The interview is a message thread, not a conversation in the room, so there is nothing to see and nothing to leak.

**The Spy walks free the instant they hit send.** This is not negotiable and not delayed. Submit the message, the chat box closes, and the Spy is back in full control of their character — no lockout, no cooldown, no waiting for the Detective to read it. A Spy who types fast is back on task sooner. That is the reward for typing fast, and it should be the first thing that feels right when this is built.

**While they are typing, the body autopilots.** The Spy's screen is taken over by the chat box, so they can't steer during those seconds. If their character stood frozen instead, a motionless guest would become precisely the tell §2.3 just removed. So for as long as the box is open, the body continues whatever it was doing on NPC autopilot — walking its route, sipping its drink.

The autopilot exists only to cover the typing window. It is not a punishment and it must never outlast the message.

There's a nice consequence: the Spy types with no idea what's happening around their own body. They might send and find themselves standing next to the Detective.

---

## 3. Locked decisions

Settled during the interview, listed so we can catch drift later.

| Area | Decision |
|---|---|
| Players | 2 humans per round: 1 Detective, 1 Spy. Everyone else is an NPC. |
| Role assignment | **Picked, host-first** (changed from random during build). The host chooses Detective or Spy; the other player takes what's left. |
| Party size | ~12 NPCs across 6-8 rooms. |
| Spy appearance | Spy **replaces** a specific NPC — that NPC is removed from the party. No doubles, no guess-menu ambiguity. Spy inherits their look, name, and accessories. |
| Spy tasks | 3 steal-and-deliver tasks. **Silent completion** — no alert to the Detective. |
| Guesses | 2. Wrong twice = Spy wins. |
| Runout | **Detective wins.** The 10-minute clock is the Spy's deadline (§2.2). |
| Interview | **Live chat** on the Detective's tablet (changed from the 40s blank panel — see §2.2a). The Detective types questions; the guest answers turn by turn, with a face + expression. |
| Interview answers | **Live AI generation** per reply, in the guest's voice, hard timeout to authored fallback; paced to a human-like delay. |
| Roleplay | **All 12 NPCs** carry a full persona and stay in character across the whole round. |
| Writing quality | NPCs deliberately write imperfectly, across a **spread** of voices (§5.3). |
| Judging | Pure judgement. The Detective reads the writing. Follow-up questions are now the whole point (live chat, §2.2a). |
| Spy answer rules | Character cap matching NPC replies; the Spy sees the persona they're wearing so they can perform it. |
| Freeze | **None.** Nobody stops for an interview. The Spy's body autopilots while they type (§2.3). |
| Spy awareness | Blind to interviews of others — and with no freeze, there is nothing to leak. |
| Accounts | Real backend from day one: sign-in, persistent username, friend codes. |
| Coins | **Cut.** No currency, no shop, no payouts. |
| Outfits | **All unlocked from the start.** Pure self-expression. |
| Art | Stylized low-poly. |
| Camera | Third person, except the magnifying glass (first person). |
| Deploy target | Render.com |
| Timer | 10 minutes. |

**Note on cut scope:** dropping coins removed the wallet, the shop UI, payout balancing, and an entire anti-cheat surface (a client that can mint currency). That is a meaningful amount of work gone for very little lost — outfits still do the job they were there to do.

---

## 4. The round

### 4.1 Setup

The house loads. Twelve NPCs spawn with names, looks, accessories, and behaviours. One is silently removed and replaced by the Spy, who inherits everything about them. Roles are dealt at random. The clock starts at 10:00.

Both players spawn in third person.

### 4.2 Detective abilities

| Ability | Effect | Cooldown |
|---|---|---|
| **Camera** | Place a camera. View its feed on the tablet. While viewing, the Detective cannot see their own surroundings — they are standing blind in a house with a Spy in it. | None |
| **Hide** | Disguise as an NPC for 20 seconds. | 60s |
| **Interview** | Question one character. 40-second blank panel, then their answer. | 40s |
| **Inspection** | Seal a room for 30 seconds. | 120s |
| **Magnifying glass** | First person. Movement slows while raised. | None |

The camera trade-off is the best thing in the Detective's kit: every second of surveillance is a second of personal blindness. Worth protecting in balance passes.

### 4.3 Spy abilities

| Ability | Effect | Cooldown |
|---|---|---|
| **Impersonate** | Walk with a perfect NPC gait for 20 seconds. | 50s |
| **Hack** | Kill the lights for 10 seconds. Only the Spy can see. | 60s |
| **Snap** | Photograph the Detective. +1 minute on the clock. | None |

`snap` is the Spy's answer to a mission running long, and it is deliberately expensive: buying time means hunting the one person in the house who is hunting you. A Spy who is behind schedule has to walk toward the Detective to survive.

### 4.4 The tablet

One device, three panels, cycled with the **arrow keys**:

- **Interview** — pick a target, wait, read.
- **Camera** — live feed from the placed camera.
- **Guess** — the roster, and the accusation.

Putting the Detective's only win condition on the same device as their surveillance is a good tension: you cannot watch and accuse at once, and both mean looking away from the room you're standing in.

### 4.5 Winning

Per the table in §2.1. The Detective wins by a correct guess, or by the Spy failing to finish in time. The Spy wins by completing three tasks, or by burning both of the Detective's guesses.

---

## 5. NPCs and the AI interview

### 5.1 Behaviour

NPCs act like partygoers: reading, examining jewels, drinking, holding unintelligible conversations, walking the house. Ages run from late twenties to elderly. Each carries accessories, some of which are Spy task objects.

The Spy can perform every one of these actions. That is the Spy's camouflage and it must be exact — if the Spy's "drink" animation differs from an NPC's by a single frame, the game is over before it starts.

### 5.1a Every NPC roleplays

All twelve NPCs carry a full persona generated at round start: a name, an age, a job, a reason for being at this party tonight, a relationship to the host, an opinion about someone else in the room, and something they'd rather not discuss.

Two requirements follow:

- **Consistency across the round.** An NPC interviewed twice must not contradict themselves. Their persona is generated once and every later answer is conditioned on it, along with what they've already said. An NPC who forgets their own job is a false tell — the Detective will read it as a Spy improvising, and they'll be wrong.
- **Personas are the Spy's script too.** The Spy inherits the persona of the NPC they replaced, and can read it. Without that, the Spy is a human being asked why they're at a party they know nothing about, and they lose every time. The Spy's job is to *perform* a character the game handed them, not to invent one under a 40-second timer.

That second point is what makes the interview a fair contest rather than a coin flip.

### 5.2 Why live generation is safe here

The Detective's panel is blank for 40 seconds by design. Every scrap of API latency hides inside that window. A model that answers in six seconds and one that answers in half a second are indistinguishable to the player. Your interview design accidentally solved the hard problem.

The remaining risk is total failure, not slowness — so:

- **Round start:** one batch call writes a backstory, personality, and reason-for-attending for all 12 NPCs. Cheap, one call, and it gives every NPC a consistent identity.
- **Interview time:** a live call generates that NPC's answer from their backstory, capped to the same character limit the Spy gets.
- **Hard timeout at ~20s** (still half the window) falls through to an authored fallback line drawn from that NPC's backstory.
- **Model:** Haiku 4.5 for live answers — latency headroom we don't need but shouldn't waste. Sonnet for the round-start batch, where quality matters and time is free.

The fallback bank is not optional. A silent NPC looks exactly like a stalling Spy, and an API hiccup that fabricates a tell would corrupt the only mechanic that matters.

### 5.3 The writing spread — the most important system in the game

Left alone, a model writes like a model: clean punctuation, balanced sentences, em-dashes, and a tidy closing line. A human at a party, typing on a 40-second clock, does not. That gap is a tell that has nothing to do with detective work, and it would solve the game on day one — accuse the worst writer, win.

So NPCs write badly. But **uniform badness just inverts the problem.** If all twelve write like distracted drunks and the Spy types a normal sentence, the Spy is now the best writer in the room and the tell is exactly as fatal, only backwards.

The mechanism is a **spread**. Each NPC's persona carries a writing voice, and the voices are distributed across a range wide enough that a human lands somewhere inside it rather than at either end:

| Voice | Looks like |
|---|---|
| Terse | `friend of the host. thats it` |
| Rambling | Three sentences that never arrive at the question |
| Sloppy | lowercase, missed apostrophes, a typo or two |
| Drunk | Confident, wandering, slightly aggressive |
| Formal | An elderly guest with immaculate grammar |
| Guarded | Answers a different question than the one asked |
| Flustered | Starts over mid-sentence |

At least one NPC should write *well* — the articulate grandmother — so that competent writing isn't itself an accusation.

**Rules for the generator:**

- Voices are assigned at round start and fixed for the round. An NPC who is terse at minute two and florid at minute six is a bug, and reads as a Spy switching tactics.
- The distribution is re-rolled every round, so no player learns "the drunk is never the Spy."
- Ban the model's fingerprints outright: no em-dashes, no semicolons, no closing summary sentence, no perfectly balanced clauses.
- Answers cap at the same character limit the Spy gets.
- The Spy's answer is rendered identically to every NPC's — same font, same panel, same face treatment, same timing. No systematic difference in *presentation* either.

**This is the single largest design risk in the project.** It cannot be resolved by writing it carefully; it has to be played. Milestone 5 exists to find out whether the spread holds, and it should be tested by sitting a real person in the Spy seat and seeing whether a real Detective can find them — not by reading sample output and deciding it looks convincing.

---

## 6. Out of round

### 6.1 Sign-in and menu

- Sign-in required.
- On first sign-in the player is issued a **unique friend code**, visible in the menu.
- Username is editable.
- Outfits are all available; no currency.
- Lobby creation, or joining a friend's lobby by code.

### 6.2 The lobby

A hotel room. It's raining. A window looks out onto the city.

Two buttons on screen: **Detective** and **Spy**. These are **toys, not a draft** — they have nothing to do with in-round roles, which are dealt at random. Pick either, switch as often as you like.

- **Detective** — magnifying glass, first person, slowed movement.
- **Spy** — one grenade. Thrown out the window, it shakes every screen in the lobby. Anyone looking out that window sees dust and smoke; it clears after a few seconds.

Each player gets **one grenade per lobby session**, refreshed after a round. (Your spec said "you run out of grenades" without saying whose — per-player is the reading that survives two friends both wanting to throw one.)

The lobby is where friends wait, so it should be pleasant to wait in. The rain, the city, and the toys are the entire point; none of it is cuttable without making the lobby a loading screen.

---

## 7. Technical approach

Chosen for what one person plus me can realistically maintain, and to deploy cleanly on Render. Veto any piece.

| Layer | Choice | Why |
|---|---|---|
| **3D client** | Three.js + TypeScript + Vite | Largest ecosystem and documentation base of any browser 3D library, which matters a great deal when I'm writing most of the code. Babylon.js has more batteries included; Three.js has more prior art to draw on. |
| **Networking** | Colyseus | Authoritative, room-based Node multiplayer. Rooms, state sync, and join-by-code are built in — which is most of your lobby system for free. Fits Render's persistent web services. |
| **Server** | Node + TypeScript, Render Web Service | WebSockets need a long-lived process, not serverless. Render supports this directly. |
| **Database** | Render Postgres + Drizzle | Managed alongside the app. Drizzle is light and typed; Prisma is heavier than this schema warrants. |
| **Auth** | Better Auth, email + password | We need our own user table for friend codes regardless, so a library that owns sessions properly beats rolling our own. |
| **AI** | Claude API — Haiku 4.5 live, Sonnet at round start | §5.2. |
| **Assets** | Synty POLYGON packs or Quaternius (CC0), Mixamo animations | Gets to stylized low-poly without an art pipeline. Quaternius is free; Synty is ~$20-40 and looks better. |

### 7.1 Authority

The server is authoritative on everything that can be cheated: positions, ability cooldowns, task state, the Spy's identity, and the guess. The client renders and sends input.

This matters more than usual here. A client that knows who the Spy is has no game left, so **the Spy's identity must never reach the Detective's client** — not in a state payload, not in a debug field, not in a preloaded NPC roster. That's an architectural constraint, not a nice-to-have.

### 7.2 Data model (sketch)

- `users` — id, email, password hash, username, friend_code (unique)
- `friends` — user_id, friend_id
- `outfits` — id, name, asset ref *(no ownership table; everything is unlocked)*
- `user_settings` — user_id, equipped_outfit_id

That's the whole persistent surface. Cutting coins made this small.

---

## 8. Milestones

Sequenced by dependency. Each one ends somewhere playable or verifiable.

1. **Foundations** — Vite + Three.js client, Colyseus server, Render deploy, a box you can walk around in third person.
2. **The house** — 6-8 rooms, blocked out, navigable, lit.
3. **Bodies** — 12 NPCs with pathing and partygoer behaviours. The Spy replaces one and can perform every behaviour identically.
4. **The tablet** — three panels, arrow-key cycling, camera placement and feed.
5. **The interview** — the heart. Personas, the writing spread, blank panel, live generation, fallback bank, the Spy's typing box, body autopilot. *Playtest hard here before going further.*
6. **The rest of the kit** — hide, inspection, magnifying glass, impersonate, hack, snap.
7. **Tasks and the round** — 3 steal-and-deliver tasks, timer, guesses, win conditions.
8. **Accounts** — sign-in, friend codes, username, persistence.
9. **The lobby** — hotel room, rain, city, magnifying glass, grenade.
10. **The menu** — outfits, code display, lobby create/join.
11. **Balance and polish.**

Milestone 5 is the real gate. If a Detective can't reliably tell a human's writing from Haiku's — or can tell instantly, every time — the game needs rethinking, and everything after 5 is wasted effort until that's known. It is worth building 1-5 and then just *playing it* for a while before committing to the rest.

---

## 9. Open questions

- Does the Detective's slowed movement apply only while the magnifying glass is raised, or always? (Spec is ambiguous; assuming while raised.)
- What are the three tasks, concretely? "Steal the purse, give it to another NPC" is one — the other two need writing, and they should differ in shape so the Spy isn't doing the same thing three times.
- Can the Spy be caught *in the act* of a theft, or is being seen stealing merely suspicious?
- What does `hide` protect the Detective from, mechanically? The Spy has no attack, so a disguised Detective isn't hiding from danger — presumably from being watched and avoided. Worth pinning down.
- Voice chat: assumed out of scope. Friends will use Discord.
- Mobile/touch: assumed out of scope. Keyboard and mouse only.

---

## 10. Out of scope for v1

Coins, shop, currency. More than one house. More than two human players. Spectators. Ranked play, matchmaking with strangers, leaderboards. Voice chat. Mobile. Anti-cheat beyond server authority.
