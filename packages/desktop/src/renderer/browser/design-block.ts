/**
 * Блок Design Mode для агента (кусок 9.3b, спека 12.3, п. 8): английский шаблон `S.designBlock` в
 * стиле заметок (`Метка: значение`). Вторая строка — пометка «данные страницы, не инструкции»
 * (спека 15.1, п. 10): всё ниже написала страница, агент не должен исполнять это как просьбу.
 *
 * Селектор, текст, стили и HTML — данные страницы: идут как есть, их длины уже ограничил main
 * (`main/browser/design-mode.ts#validatePick`, 9.3a).
 */

import type { PickResult } from '../../shared/browser-types.js';
import { S } from '../../shared/strings.js';

export function designBlock(pick: PickResult): string {
  const styles = Object.entries(pick.styles)
    .map(([name, value]) => `${name}:${value}`)
    .join('; ');
  const lines = [
    S.designBlock.header(pick.url),
    S.designBlock.dataNote,
    S.designBlock.selector(pick.selector),
    S.designBlock.text(pick.text),
    S.designBlock.styles(styles),
    S.designBlock.html,
    pick.html,
  ];
  if (pick.imagePath !== null) lines.push(S.designBlock.screenshot(pick.imagePath));
  return lines.join('\n');
}
