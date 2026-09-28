/**
 * Файлы и скриншоты в терминал (кусок 5.4, спека 8.5): путь уходит агенту текстом, в кавычках
 * shell — дом или имя с пробелом, `'` или `$` вложение не ломают.
 */

/** 'a b' → 'a b' в кавычках; ' внутри → '\'' (закрыть, экранированная кавычка, открыть). */
export function shellQuote(path: string): string {
  return `'${path.replaceAll("'", "'\\''")}'`;
}

/** Через пробел, пробел в конце: человек дописывает промпт сразу после пути. */
export function pathsToInput(paths: string[]): string {
  return `${paths.map(shellQuote).join(' ')} `;
}

/** В буфере вставки картинка и нет текста: clipboardData.items с image/* и без text/plain. */
export function pasteHasOnlyImage(data: DataTransfer): boolean {
  const items = Array.from(data.items);
  if (items.some((item) => item.type === 'text/plain')) return false;
  return items.some((item) => item.kind === 'file' && item.type.startsWith('image/'));
}

/** Перетаскивают файлы: dataTransfer.types содержит 'Files'. */
export function dragHasFiles(data: DataTransfer): boolean {
  return Array.from(data.types).includes('Files');
}
