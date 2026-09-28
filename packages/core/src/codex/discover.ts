import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

/**
 * Корень истории Codex. Каталог только для чтения.
 *
 * 🚫 Соседний `~/.codex/auth.json` не читать никогда — там учётные данные,
 * ровно как `~/.claude/.credentials.json`.
 */
export function defaultCodexRoot(): string {
  const override = process.env[CODEX_SESSIONS_DIR_ENV];
  if (override !== undefined && override !== '') return override;
  return path.join(homedir(), '.codex', 'sessions');
}

/** Переопределение корня истории Codex — только для тестов, как `HARNAS_CLAUDE_PROJECTS_DIR` (lane-r3, п. 1). */
export const CODEX_SESSIONS_DIR_ENV = 'HARNAS_CODEX_SESSIONS_DIR';

export interface DiscoveredCodexSession {
  file: string;
  /** uuid из имени файла; сверяется с session_meta при индексации. */
  id: string;
}

const ROLLOUT = /^rollout-.*-([0-9a-f-]{36})\.jsonl$/;

async function readDirSafe(dir: string): Promise<import('node:fs').Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    // Каталога нет (Codex не установлен) или он исчез — это не ошибка обхода.
    return [];
  }
}

/**
 * Обходит `~/.codex/sessions/<год>/<месяц>/<день>/` и возвращает rollout-логи.
 * Один файл — одна сессия; подсессий у Codex не бывает (specs/runners.md).
 */
export async function discoverCodexSessions(
  root: string = defaultCodexRoot(),
): Promise<DiscoveredCodexSession[]> {
  const found: DiscoveredCodexSession[] = [];

  const walk = async (dir: string, depth: number): Promise<void> => {
    for (const entry of await readDirSafe(dir)) {
      const full = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        // Раскладка ровно <год>/<месяц>/<день> — ниже дня каталогов не бывает.
        if (depth < 3) await walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;

      const match = ROLLOUT.exec(entry.name);
      found.push({ file: full, id: match?.[1] ?? path.basename(entry.name, '.jsonl') });
    }
  };

  await walk(root, 0);
  return found;
}
