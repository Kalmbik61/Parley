/**
 * Атомарная запись файла и очередь операций на один файл — общее для
 * `ui-store.ts` и `layout-store.ts` (переезд последнего — с куска 2.2).
 * Раунд исправлений 1 куска 1.1 (находка C3): раньше `writeAtomic` каждого
 * стора писал во всегда один и тот же `${file}.tmp`. При двух параллельных
 * `save()` без `await` между ними первый `rename` уводил `.tmp` на место
 * `file`, а второй `rename` над уже не существующим `.tmp` падал `ENOENT` —
 * не тихая потеря обновления, а отклонённый промис IPC. Здесь — то же
 * решение для обеих причин гонки разом: уникальное имя временного файла на
 * каждый вызов и очередь, которая не даёт двум `save()` читать файл
 * одновременно (см. `ui-store.ts`).
 */

import { chmod, mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** Счётчик обеспечивает уникальность внутри процесса; PID — на случай двух процессов на одном `PARLEY_HOME` (тесты). */
let counter = 0;

/**
 * Пишет через временный файл рядом (`<file>.<pid>.<n>.tmp`) и переименовывает
 * поверх целевого — `rename` на одной файловой системе атомарен, читатель не
 * увидит наполовину записанный файл. Имя временного файла уникально на каждый
 * вызов, поэтому два параллельных `writeAtomic` в один и тот же `file` не
 * гоняются за одним `.tmp` и не падают `ENOENT`.
 */
export async function writeAtomic(
  file: string,
  text: string,
  doRename: typeof rename = rename,
): Promise<void> {
  // Заметки, ui.json и layouts.json — текст и пути проектов человека (ревью M8): каталоги 0700,
  // файлы 0600, как у drops/. Каталог, созданный раньше с 0755, приводится при каждой записи;
  // файл — сам собой: rename ставит на место временный, созданный уже с 0600.
  const dir = path.dirname(file);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const tmp = `${file}.${process.pid}.${counter++}.tmp`;
  await writeFile(tmp, text, { encoding: 'utf8', mode: 0o600 });
  await doRename(tmp, file);
}

/**
 * Очередь операций на один файл: следующая стартует только после того, как
 * закончилась предыдущая — успехом или ошибкой. Без этого два `save()` одного
 * стора без `await` между ними читают файл ДО того, как первый дописал свой
 * патч, и второй `save` затирает изменения первого при записи (план куска
 * 1.1, угол атаки №2, тест 8). Ошибка одной операции не должна останавливать
 * очередь для следующих — `tail` поэтому всегда переходит дальше независимо
 * от исхода текущей операции, а сам исход достаётся только её вызывающему
 * через возвращённый промис.
 */
export function createFileQueue(): <T>(operation: () => Promise<T>) => Promise<T> {
  let tail: Promise<void> = Promise.resolve();

  return <T>(operation: () => Promise<T>): Promise<T> => {
    const started = tail.then(operation);
    tail = started.then(
      () => undefined,
      () => undefined,
    );
    return started;
  };
}
