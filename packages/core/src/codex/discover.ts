import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { envValue } from '../names.js';

/**
 * Корень истории Codex. Каталог только для чтения.
 *
 * 🚫 Соседний `~/.codex/auth.json` не читать никогда — там учётные данные,
 * ровно как `~/.claude/.credentials.json`.
 */
export function defaultCodexRoot(): string {
  const override = envValue(process.env, CODEX_SESSIONS_DIR_KEY);
  if (override !== undefined) return override;
  return path.join(homedir(), '.codex', 'sessions');
}

/**
 * Переопределение корня истории Codex — только для тестов, как `PARLEY_CLAUDE_PROJECTS_DIR` (lane-r3, п. 1).
 * Ключ без префикса: `PARLEY_CODEX_SESSIONS_DIR`, прежняя `HARNAS_CODEX_SESSIONS_DIR` читается тоже.
 */
export const CODEX_SESSIONS_DIR_KEY = 'CODEX_SESSIONS_DIR';

export interface DiscoveredCodexSession {
  file: string;
  /** uuid из имени файла; сверяется с session_meta при индексации. */
  id: string;
}

/**
 * `rollout-<время>-<тред>.jsonl`; у «откатанных» тредов имя `rollout-<время>-<тред>_<rollout>.jsonl` —
 * суффикс после «_» это id rollout, а не треда (`codex-rs/rollout/src/rollout_file_name.rs`), и id
 * сессии — тред: под ним её знает карта (`session_meta.id`, `_meta.threadId`). Ленивое `.*?` и
 * привязка к концу имени берут ровно первый uuid после времени.
 */
const ROLLOUT = /^rollout-.*?-([0-9a-f-]{36})(?:_[0-9a-f-]{36})?\.jsonl$/;

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
 * Один файл — один тред. Подагенты и внутренние треды Codex (у `session_meta` задан
 * `parent_thread_id` или `source` не `cli`) лежат в тех же каталогах отдельными логами — их различает
 * индекс (`SessionIndex.spawned`), а не обход.
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
