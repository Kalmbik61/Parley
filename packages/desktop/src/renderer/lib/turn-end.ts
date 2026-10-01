/**
 * Конец хода агента по смене его живой активности — повод перечитать то, что он мог изменить в файлах
 * (дифф, статус git): коммит и правки агент делает именно в конце хода. `working` перешёл во что-то
 * другое — или остался `working`, но лида теперь держат одни фоновые субагенты (`heldByBackground`
 * стало `true`): его ход окончен, а `Stop` с фоновыми задачами состояния `working` не меняет, и без
 * этого дифф устаревал бы до самого конца фоновых.
 *
 * Хост прежней версии флага не присылает (`undefined`): тогда `working → working` ходом не считается.
 */

import type { SessionActivity } from '@parley/core';

export function workingEnded(
  was: SessionActivity | undefined,
  now: SessionActivity | undefined,
): boolean {
  if (was?.activity !== 'working') return false;
  if (now?.activity !== 'working') return true;
  return was.heldByBackground !== true && now.heldByBackground === true;
}
