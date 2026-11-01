/**
 * Доверие к папке для Claude Code (спека мобильного приложения 2026-10-29, 4.2 «Claude и экран доверия»; план A29).
 *
 * Ни один запуск, в том числе с телефона, не должен ждать нажатия в терминале. Codex получает доверие флагом
 * `projects=…` (`trustArgs`), у Claude Code флага нет: он читает `projects[<папка>].hasTrustDialogAccepted` из файла
 * состояния профиля. Поэтому перед запуском Claude (и GLM, и своих провайдеров на его базе) в папке, у которой есть
 * запись в `trust.json`, Parley отмечает эту же папку (её realpath — ключ `trust.json`) принятой в файле профиля.
 *
 * Как устроено у самого CLI (проверено на Claude Code 2.1.316):
 * - файл состояния лежит в `CLAUDE_CONFIG_DIR`, без неё — в HOME; прежний `<папка конфигурации>/.config.json` главнее,
 *   если он есть (`getGlobalClaudeFile`; имена — в `claudeStateFile`);
 * - ключ доверия — канонический корень git-репозитория (worktree сводится к главному), затем папки вверх от cwd до
 *   корня: отметка папки проекта снимает экран и в её подпапках, и в worktree этого репозитория;
 * - CLI пишет файл часто и под блокировкой `<файл>.lock` (proper-lockfile: каталог, созданный `mkdir`), а под ней
 *   перечитывает файл и сливает `projects` с диском. Parley берёт ту же блокировку: запись CLI после нашей нашу
 *   отметку не потеряет, наша — его поля тоже.
 *
 * Граница записи: меняется только `projects[<эта папка>].hasTrustDialogAccepted`, остальное содержимое файла идёт как
 * было; нет файла, он не разбирается или занят дольше срока — ничего не пишется, запуск идёт дальше, а CLI покажет
 * свой экран, как раньше.
 */

import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, realpath, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { isTrusted, trustKey } from './trust.js';

/** Чем кончилась попытка отметить папку: `written` и `present` — папка принята, остальное — экран CLI, как раньше. */
export type ClaudeTrustOutcome =
  /** Записи в `trust.json` нет: файл Claude не читался и не менялся. */
  | 'not-trusted'
  /** Отметка уже стояла: файл не переписывался. */
  | 'present'
  | 'written'
  /** Файла состояния профиля нет (CLI ещё не запускался с этим профилем): Parley его не создаёт. */
  | 'no-config'
  /** Файл не разбирается как JSON-объект или `projects` чужой формы: не трогаем. */
  | 'unreadable'
  /** Блокировку держали дольше срока или файл менялся на каждой попытке. */
  | 'busy';

export interface ClaudeTrustOptions {
  /** Сколько ждать блокировку CLI, мс. */
  lockWaitMs?: number;
  /** Сколько раз перечитать файл, если он изменился между чтением и заменой. */
  attempts?: number;
  /** Для тестов: зовётся после записи временного файла, перед проверкой и заменой. */
  beforeCommit?: () => Promise<void>;
}

const LOCK_WAIT_MS = 2_000;
const ATTEMPTS = 3;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const exists = (file: string): Promise<boolean> => stat(file).then(() => true, () => false);

/**
 * Файл состояния Claude Code профиля — как его выбирает CLI. `configDir` — `CLAUDE_CONFIG_DIR` процесса (уже
 * разрешённый в абсолютный путь), `undefined` — профиль по умолчанию в `home`.
 */
export async function claudeStateFile(configDir: string | undefined, home: string): Promise<string> {
  const current = path.join(configDir ?? home, '.claude.json');
  const legacy = path.join(configDir ?? path.join(home, '.claude'), '.config.json');
  try {
    const info = await stat(legacy);
    if (info.isFile() && (info.size > 0 || ((info.mode & 0o222) !== 0 && !(await exists(current))))) return legacy;
  } catch { /* нет прежнего файла — обычный */ }
  return current;
}

/** Блокировка CLI: каталог `<файл>.lock`. `false` — не дождались; чужую блокировку не снимаем никогда. */
async function acquireLock(lock: string, waitMs: number): Promise<boolean> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      await mkdir(lock);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    if (Date.now() >= deadline) return false;
    await delay(25 + Math.floor(Math.random() * 50));
  }
}

/**
 * Отмечает `folder` принятой в файле состояния `file` (см. `claudeStateFile`). `folder` — уже ключ: realpath.
 * Ошибки ввода-вывода пробрасываются; содержимое файла в них не попадает.
 */
export async function acceptClaudeFolderTrust(file: string, folder: string, options: ClaudeTrustOptions = {}): Promise<ClaudeTrustOutcome> {
  // Нет файла — не создаём его и блокировку рядом с ним не заводим.
  if (!(await exists(file))) return 'no-config';
  const lock = `${file}.lock`;
  if (!(await acquireLock(lock, options.lockWaitMs ?? LOCK_WAIT_MS))) return 'busy';
  try {
    for (let attempt = 0; attempt < (options.attempts ?? ATTEMPTS); attempt++) {
      // Ссылку (менеджер дотфайлов) не заменяем файлом: пишем туда, куда она ведёт.
      let target: string;
      try {
        target = await realpath(file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'no-config';
        throw error;
      }
      const raw = await readFile(target, 'utf8');
      const mode = (await stat(target)).mode & 0o777;
      let data: unknown;
      try {
        data = JSON.parse(raw);
      } catch {
        return 'unreadable';
      }
      if (!isRecord(data)) return 'unreadable';
      const projects = data['projects'] ?? {};
      if (!isRecord(projects)) return 'unreadable';
      const entry = projects[folder] ?? {};
      if (!isRecord(entry)) return 'unreadable';
      if (entry['hasTrustDialogAccepted'] === true) return 'present';

      const next = { ...data, projects: { ...projects, [folder]: { ...entry, hasTrustDialogAccepted: true } } };
      const tmp = `${target}.parley-${randomUUID()}.tmp`;
      try {
        // Форма файла — как у CLI: два пробела отступа, права прежние.
        await writeFile(tmp, JSON.stringify(next, null, 2), { mode });
        await chmod(tmp, mode);
        await options.beforeCommit?.();
        // Писатель без блокировки (другая сборка CLI) успел между чтением и заменой — перечитываем и сливаем заново.
        if ((await readFile(target, 'utf8')) !== raw) continue;
        await rename(tmp, target);
        return 'written';
      } finally {
        await rm(tmp, { force: true });
      }
    }
    return 'busy';
  } finally {
    await rmdir(lock).catch(() => undefined);
  }
}

/**
 * Перед запуском провайдера семейства Claude Code: папка проекта с записью в `trust.json` отмечается принятой в
 * файле профиля (`configDir` — его `CLAUDE_CONFIG_DIR`, `home` — домашняя папка процесса). Без записи доверия файл
 * Claude не читается. Ошибка не бросается: возвращается строка для лога без содержимого файла.
 */
export async function preacceptClaudeTrust(
  projectPath: string,
  profile: { configDir: string | undefined; home: string },
  options: ClaudeTrustOptions = {},
): Promise<{ outcome: ClaudeTrustOutcome | 'failed'; warning?: string }> {
  try {
    if (!(await isTrusted(projectPath))) return { outcome: 'not-trusted' };
    const folder = await trustKey(projectPath);
    const file = await claudeStateFile(profile.configDir, profile.home);
    const outcome = await acceptClaudeFolderTrust(file, folder, options);
    if (outcome === 'written' || outcome === 'present') return { outcome };
    return { outcome, warning: `Parley could not mark ${folder} as trusted in ${file} (${outcome}); Claude Code may ask to trust the folder in the terminal.` };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? 'error';
    return { outcome: 'failed', warning: `Parley could not mark the project folder as trusted for Claude Code (${code}); Claude Code may ask to trust the folder in the terminal.` };
  }
}
