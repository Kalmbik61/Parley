import { statSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { LEGACY_STATE_DIR, STATE_DIR } from '../names.js';

/** Каталог ли это. Синхронно: путями работ и домом пользуются и там, где асинхронности нет (`workPaths`). */
export function isDirectorySync(target: string): boolean {
  try {
    return statSync(target).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Каталог состояния проекта (карты работ, почта, журналы) — единственный резолвер (R5): `<проект>/.parley`,
 * если он есть; иначе прежний `<проект>/.harnas`, если есть; иначе — нового ещё нет — `.parley`.
 * Ничего не создаёт: созданием занят `ensureStateDir`.
 *
 * Когда есть оба, главнее `.parley`. Прежний каталог в новый переносит шаг переноса данных, а не
 * чтение: читатель каталогов не сливает.
 */
export function stateDir(projectPath: string): string {
  const current = path.join(projectPath, STATE_DIR);
  if (isDirectorySync(current)) return current;
  const legacy = path.join(projectPath, LEGACY_STATE_DIR);
  return isDirectorySync(legacy) ? legacy : current;
}

/** Строка `.gitignore` каталога состояния: он прячет сам себя и всё, что в нём, от git. */
const SELF_IGNORE = '*\n';

/**
 * Кладёт в каталог состояния `.gitignore` со строкой `*`. Уже лежащий не трогается: его положил соседний
 * процесс (это то же самое) или переписал человек.
 */
export async function writeSelfIgnore(dir: string): Promise<void> {
  try {
    await writeFile(path.join(dir, '.gitignore'), SELF_IGNORE, { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
}

/**
 * Заводит каталог состояния проекта и возвращает его путь. Каталог, созданный этим вызовом под новым
 * именем, сразу получает `.gitignore` со строкой `*`: в чужом репозитории состояние Parley не должно
 * попасть в коммит ни командой человека, ни «Commit all» окна. Уже существующий каталог не
 * трогается — в том числе прежний `.harnas` и `.parley`, у которого `.gitignore` убрал человек.
 */
export async function ensureStateDir(projectPath: string): Promise<string> {
  const dir = stateDir(projectPath);
  // Возвращает первый созданный каталог и `undefined`, если создавать было нечего.
  const created = await mkdir(dir, { recursive: true });
  if (created !== undefined && path.basename(dir) === STATE_DIR) await writeSelfIgnore(dir);
  return dir;
}
