/** Расшифровка встаёт на место каретки (спека 3.3): один пробел слева, если перед кареткой текст без пробела. */

export function joinTranscript(before: string, transcript: string): string {
  return before === '' || /\s$/.test(before) ? transcript : ` ${transcript}`;
}

export function spliceTranscript(value: string, caret: number, transcript: string): { value: string; caret: number } {
  const at = Math.max(0, Math.min(caret, value.length));
  const piece = joinTranscript(value.slice(0, at), transcript);
  return { value: value.slice(0, at) + piece + value.slice(at), caret: at + piece.length };
}
