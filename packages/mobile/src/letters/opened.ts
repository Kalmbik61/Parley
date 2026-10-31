// Letters opened on this phone (D1 §10.2): marked in the app only; the Mac's unread counter is not touched in stage A.
const ids = new Set<string>();
export const openedLetters = {
  add: (id: string): void => void ids.add(id),
  snapshot: (): ReadonlySet<string> => new Set(ids),
};
