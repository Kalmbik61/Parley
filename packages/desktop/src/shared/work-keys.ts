/**
 * Ключи работ и корней — один формат у main и рендерера (спека 10.8, кусок 5.2):
 * main строит ими реестр корней, рендерер — раскладки и файловые сторы. Разойдись
 * форматы — все `files.*` получали бы отказ.
 */
import type { FileRoot } from './files-types.js';

/** Ключ работы: id уникален только внутри проекта. */
export function workKey(projectPath: string, workId: string): string {
  return `${projectPath} ${workId}`;
}

/** Ключ корня (спека 10.8): workKey, вид и sessionId. */
export function rootKey(root: FileRoot): string {
  return root.spec.kind === 'project'
    ? `${root.workKey} project`
    : `${root.workKey} worktree ${root.spec.sessionId}`;
}

/**
 * Формат id сессии core: `s-` и цифры (`core/work/map.ts#nextSessionId`, та же регулярка в
 * `core/work/thread.ts`). Main пускает только его там, где id идёт в имя файла как есть
 * (заметки, кусок 8.4a): иначе `../..` из рендерера вёл бы запись вне своего каталога.
 */
export function isSessionId(id: string): boolean {
  return /^s-\d+$/.test(id);
}
