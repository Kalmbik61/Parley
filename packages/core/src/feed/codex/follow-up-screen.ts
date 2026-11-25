/** Shared view of the native Codex asynchronous question queue as displayed by the TUI. */
const QUEUE = '• Queued follow-up inputs';
const FOOTER = /^enter submit\s+⌃\] skip\s+⇧→ main prompt(?:\s+⇧← next question)?$/u;
const squash = (text: string): string => text.replace(/\s+/gu, ' ').trim();

export interface CodexFollowUpEditor {
  title: string;
  options: string[];
  selected: number;
  input: string;
  next: boolean;
  position: string;
}

export function readCodexFollowUpScreen(lines: readonly string[]): 'collapsed' | CodexFollowUpEditor | null {
  const content = lines.map(line => line.trim());
  const header = content.lastIndexOf(QUEUE);
  if (header === -1) return null;
  const rows = content.slice(header + 1);
  while (rows.at(-1) === '') rows.pop();
  while (rows[0] === '') rows.shift();
  if (/^\? \d+ questions?(?:\s*[·•].*)?$/u.test(rows[0] ?? '') && rows[1] === '⇧← to answer') {
    // Only the main composer and its status/footer may follow a collapsed queue.
    const tail = rows.slice(2).filter(Boolean);
    if (tail[0]?.startsWith('›') && tail.length <= 3 && !tail.some(line => /enter to confirm|enter submit|esc to cancel/i.test(line))) return 'collapsed';
    return null;
  }
  const footer = rows.pop();
  if (!footer || !FOOTER.test(footer)) return null;
  const position = /^\d+ of \d+$/.test(rows[0] ?? '') ? rows.shift()! : '';
  const split = rows.indexOf('');
  if (split < 1) return null;
  const title = squash(rows.slice(0, split).join(' '));
  const body = rows.slice(split + 1).filter(Boolean);
  if (!body.length) return null;
  const navigation = { next: footer.includes('next question'), position };
  if (!body.some(line => /^›\s*\d+\.\s/u.test(line))) {
    return { title, options: [], selected: -1, input: squash(body.join(' ')), ...navigation };
  }
  const options: string[] = [];
  let selected = -1;
  for (const line of body) {
    const option = /^(›\s*)?(\d+)\.\s+(.*)$/u.exec(line);
    if (!option) {
      if (options.length === 0) return null;
      options[options.length - 1] += ' ' + line;
      continue;
    }
    if (Number(option[2]) !== options.length + 1) return null;
    if (option[1]) selected = options.length;
    options.push(option[3]!);
  }
  return { title, options, selected, input: '', ...navigation };
}
