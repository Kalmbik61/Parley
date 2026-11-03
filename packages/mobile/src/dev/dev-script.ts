// DEVELOPER BUILD ONLY (A44 evidence): a timed script from the `dev` route param, so that a real state of the feed is
// reached on a simulator without a finger: `focus` raises the keyboard after the feed settled, `draft` types a
// several-line draft, `up` scrolls the list up (a position change, as a person leaving the end), `more` adds items, `card`
// lets a permission card arrive. Items run 1.3 s apart from 4 s after the screen mounted.
type Listener = () => void;
const listeners = new Set<Listener>();
/** The composer's text field listens here: focus it late (DEV_FOCUS focuses it at mount, still under the pin). */
export const devFocus = {
  listen(l: Listener): () => void {
    listeners.add(l);
    return () => void listeners.delete(l);
  },
  fire(): void {
    listeners.forEach((l) => l());
  },
};

export const LONG_DRAFT = 'First line of a long draft\nSecond line of the draft\nThird line of the draft\nFourth line of the draft';

export type DevStep = 'focus' | 'draft' | 'up' | 'more' | 'card';

export function runDevScript(spec: string, run: Record<DevStep, () => void>): () => void {
  const timers = spec
    .split(',')
    .filter((s): s is DevStep => s in run)
    .map((s, i) => setTimeout(run[s], 4000 + i * 1300));
  return () => timers.forEach(clearTimeout);
}
