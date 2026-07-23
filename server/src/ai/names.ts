import { generateNames } from "./llm.js";

/**
 * Guest names, kept fresh (SOW §5). Names are drawn from a pool the AI keeps
 * topped up in the background, so a party never draws from a small canned list —
 * you won't see the same names, or two guests sharing a first name, round after
 * round. drawNames() is synchronous (never blocks room creation): it takes from
 * whatever's pooled and fills any shortfall from a broad procedural fallback,
 * which is also what's used when the AI is off.
 */

// A broad fallback pool — bigger and more varied than a hand list of a dozen, so
// even with no AI the party doesn't feel canned.
const FIRST = [
  "Margot", "Cecily", "Rupert", "Iris", "Desmond", "Vivian", "Nigel", "Perdita",
  "Ambrose", "Rosalind", "Clive", "Beatrix", "Hugo", "Winifred", "Lionel", "Constance",
  "Barnaby", "Ottoline", "Gerald", "Sylvia", "Quentin", "Harriet", "Alaric", "Dorothy",
  "Percival", "Millicent", "Edmund", "Agatha", "Cornelius", "Blanche", "Reginald", "Prudence",
  "Horace", "Evangeline", "Cyril", "Adelaide", "Montague", "Cordelia", "Basil", "Henrietta",
  "Aldous", "Genevieve", "Rowena", "Tobias", "Marguerite", "Wilfred", "Isadora", "Leopold",
  "Cressida", "Ignatius", "Lavinia", "Ellsworth", "Georgiana", "Rafferty", "Philippa", "Crispin",
  "Arabella", "Percy", "Estelle", "Roderick", "Clementine", "Bartholomew", "Wilhelmina",
];

const LAST = [
  "Ashcombe", "Bellweather", "Crane", "Dunmore", "Ellery", "Fairholt", "Grieve",
  "Harrowgate", "Ives", "Larkspur", "Mowbray", "Quill", "Ravensworth", "Sable",
  "Thorne", "Vaughan", "Wren", "Yarrow", "Ashby", "Blackwood", "Carrington", "Devereux",
  "Fanshawe", "Glanville", "Hartley", "Kingsley", "Loxley", "Merriweather", "Northcote",
  "Pemberton", "Rutherford", "Sinclair", "Trevelyan", "Underhill", "Wycliffe", "Ashworth",
  "Beaumont", "Carslake", "Dunhill", "Fotheringay", "Halloway", "Marchmain", "Prendergast",
  "Sackville", "Wentworth", "Cavendish", "Fitzgerald", "Kensington", "Ormsby", "Selwyn",
];

const pick = <T>(a: readonly T[]): T => a[Math.floor(Math.random() * a.length)];

const pool: string[] = [];
let refilling = false;

/** Top the pool up in the background when it runs low. Fire-and-forget. */
async function refill(): Promise<void> {
  if (refilling || pool.length >= 40) return;
  refilling = true;
  try {
    const fresh = await generateNames(24);
    if (fresh) for (const name of fresh) if (!pool.includes(name)) pool.push(name);
  } catch {
    /* leave the pool; procedural fallback covers it */
  } finally {
    refilling = false;
  }
}

// Pre-warm at startup so the first party can already use live names.
void refill();

function proceduralName(usedFirst: Set<string>): string {
  for (let i = 0; i < 300; i++) {
    const first = pick(FIRST);
    if (usedFirst.has(first.toLowerCase())) continue;
    usedFirst.add(first.toLowerCase());
    return `${first} ${pick(LAST)}`;
  }
  return `Guest ${usedFirst.size + 1}`;
}

/** Draw `count` names with distinct first names — AI-pooled first, then
 *  procedural for any shortfall. Synchronous; never blocks. */
export function drawNames(count: number): string[] {
  void refill(); // keep it stocked for next time
  const usedFirst = new Set<string>();
  const result: string[] = [];

  while (result.length < count && pool.length > 0) {
    const name = pool.shift()!;
    const first = name.split(" ")[0]?.toLowerCase() ?? "";
    if (!first || usedFirst.has(first)) continue;
    usedFirst.add(first);
    result.push(name);
  }
  while (result.length < count) result.push(proceduralName(usedFirst));

  return result;
}
