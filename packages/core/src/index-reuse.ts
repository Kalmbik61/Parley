import { stat } from 'node:fs/promises';
import type { SessionIndex } from './session-index.js';

/**
 * Запись индекса, собранная в прошлый запуск хоста: `get` отдаёт её только при равном ключе,
 * `put` складывает запись (прочитанную или взятую из прошлого) в новую карту.
 */
export interface IndexReuse {
  get(file: string, key: string): SessionIndex | undefined;
  put(file: string, key: string, index: SessionIndex): void;
}

/**
 * Ключ записи индекса по её файлам: на каждый файл путь, размер, `mtimeMs`, `ctimeMs` и `ino`,
 * через '\n' в порядке `files`. Любая дозапись, усечение или подмена файла (в том числе файлом
 * того же размера с возвращённым mtime: `ctime` и `ino` руками не вернуть) меняет ключ.
 * `stat` не удался хотя бы у одного — `null`: такую запись не кладём и не берём.
 */
export async function indexKeyOf(files: readonly string[], salt = ''): Promise<string | null> {
  try {
    const parts = await Promise.all(
      files.map(async (file) => {
        const info = await stat(file);
        return [file, info.size, info.mtimeMs, info.ctimeMs, info.ino].join('\u0000');
      }),
    );
    return [salt, ...parts].join('\n');
  } catch {
    return null;
  }
}

/**
 * Ключ снимается ДО чтения: файл, дописанный во время разбора, при следующей сборке не совпадёт и
 * прочитается снова. Совпал — запись из `reuse`, иначе `read()`; запись кладётся в `reuse` всегда, когда ключ есть.
 * `salt` — то, от чего запись зависит помимо файлов (корень истории).
 */
export async function reuseOrIndex(
  reuse: IndexReuse | undefined,
  files: readonly string[],
  read: () => Promise<SessionIndex>,
  salt = '',
): Promise<SessionIndex> {
  const first = files[0];
  if (reuse === undefined || first === undefined) return read();
  const key = await indexKeyOf(files, salt);
  if (key === null) return read();
  const cached = reuse.get(first, key);
  if (cached !== undefined) {
    reuse.put(first, key, cached);
    return cached;
  }
  const index = await read();
  reuse.put(first, key, index);
  return index;
}
