// T9a harness: `PARLEY_HOME`, `process.env` and the launch skill seams are the process's, and a second user of any of them while one is going would read the first one's
// state without a word. One claim covers all of them: the data module's `withHome` and the launch executor both take it, so neither can run inside the other, and goals
// run strictly one after another.

let holder: string | null = null;

/** Takes the claim for `who`; throws by name when someone holds it. Returns the release (idempotent). */
export function claimProcessHome(who: string): () => void {
  if (holder !== null) throw new Error(`${who} is busy: ${holder} holds PARLEY_HOME and the launch seams, and goals run one after another`);
  holder = who;
  let released = false;
  return () => { if (!released) { released = true; if (holder === who) holder = null; } };
}

/** For a test: who holds the claim, or null. */
export const homeHolder = (): string | null => holder;
