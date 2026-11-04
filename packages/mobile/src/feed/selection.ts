// The selected fragment in the Select Text sheet (D1 §9.2). Indices come from the text field (UTF-16 units); a reverse
// selection (end before start) is the same selection; a fragment of blanks is "nothing selected".
export interface Selection {
  start: number;
  end: number;
}

export function selectedFragment(text: string, sel: Selection): string {
  const part = text.slice(Math.min(sel.start, sel.end), Math.max(sel.start, sel.end));
  return part.trim() === '' ? '' : part;
}
