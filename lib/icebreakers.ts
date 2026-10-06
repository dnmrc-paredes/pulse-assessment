// Conversation starters.
//
// These exist because the failure mode of a stranger app is not "nobody talks"
// — it is two people staring at a blank input. A prompt removes the decision of
// what to say first, which is the hardest one to make.
//
// Served entirely from the client: no server round trip, and nothing stored.
// Chosen to be answerable in one line, unremarkable anywhere, and free of
// anything that invites personal disclosure from someone you just met.

export interface Starter {
  text: string;
  /** Shown as a nudge; the prompt itself stays a question. */
  nudge?: string;
}

export const STARTERS: Starter[] = [
  { text: "What’s the weather like where you are right now?", nudge: "start with the weather" },
  { text: "What’s the nearest thing to your place you’d actually recommend to a visitor?", nudge: "local recommendations" },
  { text: "If you had to describe your area in one word, what would it be?" },
  { text: "What’s something small that instantly irritates you?" },
  { text: "Are you more of a night person or a morning person?" },
  { text: "What’s a sound you could identify anywhere in the world?", nudge: "sounds" },
  { text: "What’s the last meal you’d happily eat again?" },
  { text: "What are you looking forward to this week?" },
  { text: "Something you’ll never do in a big city — what is it?" },
  { text: "What’s something most people would find boring that you love?" },
  { text: "Have you got a place nearby you go to when you need to think?" },
  { text: "What’s the best thing you’ve eaten in the last month?", nudge: "food" },
  { text: "What’s a question you hate being asked?" },
  { text: "Is there a book, film, or game you’d happily talk about for an hour?", nudge: "recommendations" },
  { text: "What does your perfect lazy day look like?" },
  { text: "What’s something most people get wrong about your country?" },
  { text: "What would you do with a completely free week?", nudge: "hypotheticals" },
  { text: "What’s a tradition where you live that outsiders never hear about?" },
  { text: "What’s the last thing that made you genuinely laugh?" },
  { text: "Do you prefer cities or the countryside? Why?", nudge: "a quick either/or" },
];

/**
 * Pick a starter, avoiding the most recent one so a reconnect does not repeat
 * itself. Uses the caller's own sequence counter rather than Math.random so the
 * choice is testable.
 */
export function pickStarter(sequence: number, avoid = ""): Starter {
  const usable = STARTERS.filter((s) => s.text !== avoid);
  const pool = usable.length > 0 ? usable : STARTERS;
  return pool[Math.abs(sequence) % pool.length];
}
