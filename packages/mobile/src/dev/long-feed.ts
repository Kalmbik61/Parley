// DEVELOPER BUILD ONLY: a long mixed feed and a long room history for A44 (the feeds open at the latest message).
// Routes: `PARLEY_MOBILE_DEV_ROUTE=a44-session|a44-room`. Rows below the window are drawn with estimated heights and
// grow once drawn (Markdown tables, code, long text), which is exactly what made the feed open in the middle.
import { CODE_BLOCK, HUMAN_TABLE } from './md-demo';

const ago = (min: number): string => new Date(Date.now() - min * 60_000).toISOString();

const LONG_TEXT = Array.from({ length: 6 }, (_, i) => `Paragraph ${i + 1}: the projection keeps one row per card, the feed folds tool calls into a work group, and the mobile screen draws every row with the height it really has once Markdown, tables and code are laid out.`).join('\n\n');

export const LAST_TEXT = 'LAST MESSAGE: the long feed ends here.';

/** Feed items for a session: `turns` mixed turns, then the marked last message. */
export function longFeedItems(turns: number, extra = 0): never[] {
  const items: unknown[] = [];
  let n = 0;
  const id = (p: string): string => `${p}${++n}`;
  for (let t = 0; t < turns; t++) {
    const at = (k: number): string => ago((turns - t) * 6 - k);
    items.push({ kind: 'prompt', id: id('p'), at: at(0), text: `Turn ${t + 1}: please check the next part and report.`, images: t % 4 === 0 ? 2 : 0 });
    for (let k = 0; k < 3; k++) {
      items.push({ kind: 'tool', id: id('t'), at: at(1), toolUseId: `tu${n}`, name: k === 1 ? 'Bash' : 'Read', input: k === 1 ? { command: `pnpm test --filter part-${t}` } : { file_path: `src/part-${t}/file-${k}.ts` }, status: 'done' });
    }
    const body = [HUMAN_TABLE, LONG_TEXT, CODE_BLOCK, `## Turn ${t + 1} is done\n- item one\n- item two with \`code\`\n\n${CODE_BLOCK}`][t % 4]!;
    items.push({ kind: 'text', id: id('x'), at: at(2), messageId: `mx${n}`, streaming: false, text: body });
    items.push({ kind: 'turn', id: id('u'), at: at(3), durationMs: 30_000 + t * 1000 });
  }
  items.push({ kind: 'prompt', id: id('p'), at: ago(1), text: 'And one more thing: ', images: 0 });
  items.push({ kind: 'text', id: id('x'), at: ago(0), messageId: `mx${n}`, streaming: false, text: `${LONG_TEXT}\n\n${LAST_TEXT}` });
  for (let i = 1; i <= extra; i++) items.push({ kind: 'text', id: `new${i}`, at: ago(0), messageId: `mnew${i}`, streaming: false, text: `NEW ${i}: an item that arrived while the feed was scrolled up.` });
  return items as never[];
}

/** Room letters, oldest first, the last one marked. */
export function longRoomLetters(roomId: string, count: number): never[] {
  const from = ['greta', 'd1', 'a13'];
  return Array.from({ length: count }, (_, i) => {
    const last = i === count - 1;
    const text = last ? LAST_TEXT : i % 5 === 0 ? HUMAN_TABLE : i % 5 === 2 ? `${LONG_TEXT}` : i % 5 === 3 ? CODE_BLOCK : `Letter ${i + 1}: a short note.`;
    return { id: `lr-${i}`, roomId, from: from[i % 3], to: [], at: ago((count - i) * 3), text, kind: 'note', readBy: {} } as never;
  });
}
