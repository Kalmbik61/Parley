import { ANSWER_POLL_MS, ANSWER_STEP_MAX_MS } from './terminal-answer.js';

export interface FolderTrustMenu {
  title: string;
  detail: string;
  options: string[];
  selected: number;
  fingerprint: string;
}

function menu(title: string, detail: string, rows: string[], labels: string[], marker: string): FolderTrustMenu | undefined {
  const selected = rows.findIndex(row => row.startsWith(marker));
  if (selected < 0 || rows.filter(row => row.startsWith(marker)).length !== 1) return;
  return { title, detail, options: labels, selected, fingerprint: JSON.stringify([title, detail, labels]) };
}

export function recogniseQwenFolderTrust(screen: readonly string[]): FolderTrustMenu | undefined {
  const lines = screen.map(line => line.trim()).filter(Boolean);
  if (!/^╰─+╯?$/.test(lines.at(-1) ?? '')) return;
  const top = lines.findLastIndex(line => /^╭─+╮?$/.test(line));
  if (top < 0) return;
  const box = lines.slice(top + 1, -1);
  if (!box.every(line => line.startsWith('│'))) return;
  const body = box.map(line => line.slice(1).replace(/│$/, '').trim()).filter(Boolean);
  const title = 'Do you trust this folder?';
  const detail = body.slice(1, -3).join(' ');
  if (body[0] !== title || detail !== 'Trusting a folder allows Qwen Code to execute commands it suggests. This is a security feature to prevent accidental execution in untrusted directories.') return;
  const rows = body.slice(-3);
  const choices = rows.map(line => line.replace(/^›\s*/, ''));
  if (!/^1\. Trust folder \(.*\)$/.test(choices[0]!) ||
      !/^2\. Trust parent folder \(.*\)$/.test(choices[1]!) || choices[2] !== "3. Don't trust (esc)") return;
  return menu(title, detail, rows, choices.map(choice => choice.slice(3)), '›');
}

export function recogniseKimiFolderTrust(screen: readonly string[], cwd: string): FolderTrustMenu | undefined {
  const lines = screen.map(line => line.trim()).filter(Boolean);
  const title = 'Trust this folder?';
  if (!/^─+$/.test(lines[0] ?? '') || !/^─+$/.test(lines.at(-1) ?? '') || lines[1] !== title ||
      lines[2] !== '↑↓ navigate · Enter select · Esc exit' || lines[3] !== cwd) return;
  const context = lines.slice(4, -3);
  if (!context.join(' ').endsWith('Trust is remembered for this folder, including future project config changes. Tool approvals follow your permission settings.')) return;
  const rows = lines.slice(-3, -1);
  const choices = rows.map(line => line.replace(/^❯\s*/, ''));
  if (choices[0] !== 'Trust and continue' || choices[1] !== 'Exit') return;
  return menu(title, [cwd, ...context].join('\n'), rows, choices, '❯');
}

/** Check ownership, screen identity and highlight between every key. All three native menus bind Esc to their last choice. */
export async function confirmStartupChoice(target: number, count: number, selected: () => number | undefined,
  write: (key: string) => void): Promise<'done' | 'changed' | 'timeout'> {
  let cursor = selected();
  if (cursor === undefined || target < 0 || target >= count) return 'changed';
  if (target === count - 1) {
    write('\x1b');
    return 'done';
  }
  while (cursor !== target) {
    const next: number = cursor + (target > cursor ? 1 : -1);
    write(next > cursor ? '\x1b[B' : '\x1b[A');
    for (let elapsed = 0; ; elapsed += ANSWER_POLL_MS) {
      const highlighted = selected();
      if (highlighted === next) break;
      if (highlighted !== cursor) return 'changed';
      if (elapsed >= ANSWER_STEP_MAX_MS) return 'timeout';
      await new Promise(resolve => setTimeout(resolve, ANSWER_POLL_MS));
    }
    cursor = next;
  }
  write('\r');
  return 'done';
}
