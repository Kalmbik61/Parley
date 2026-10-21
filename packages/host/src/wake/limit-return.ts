/**
 * Возврат сессии после сброса лимита (спека застрявших 6.3, 6.4, 8 п. 4–6, 11): сроки, предохранители и тексты
 * отказа. Модуль чистый — таймеры, терминал и счётчик возвратов живут в `wake-service.ts`, здесь только решения по
 * снимку: когда пора, что мешает печатать и что сказать человеку, если печатать нельзя.
 */

import { envValue, LIMIT_RETURNS_MAX, type ProviderLimits, type SessionNeed } from '@parley/core';

/**
 * Строка меню лимита Claude Code (6.4): в 2.1.296 за ней бывают хвосты « at …», « shortly», « when the limit resets»,
 * поэтому экран проверяется на вхождение. «Don't continue automatically» признаком не берём: в бинаре её нет простым
 * текстом.
 */
export const LIMIT_MENU_TEXT = 'Wait here, then continue automatically';

/**
 * Когда вернуть сессию (мс от начала эпохи): время сброса плюс запас `graceMs`, чтобы не столкнуться с Claude,
 * который продолжает сам; времени сброса нет — `retryMs` после удара (6.3).
 */
export function limitReturnDue(need: SessionNeed, graceMs: number, retryMs: number): number {
  const reset = need.resetsAt === null ? Number.NaN : Date.parse(need.resetsAt);
  return Number.isNaN(reset) ? Date.parse(need.since) + retryMs : reset + graceMs;
}

/** Время сброса неизвестно, а данные провайдера новее удара и все окна ниже 100 % — окно снова свободно (6.3). */
export function limitWindowFree(need: SessionNeed, limits: ProviderLimits | null): boolean {
  if (need.resetsAt !== null || limits === null) return false;
  const known = [limits.fiveHour, limits.week].filter((window) => window !== null);
  return (
    Date.parse(limits.at) > Date.parse(need.since) &&
    known.length > 0 &&
    known.every((window) => window.usedPercent < 100)
  );
}

/** Что мешает напечатать возврат: черновик человека, меню лимита на экране или два возврата подряд уже были. */
export type ReturnBlock = 'draft' | 'menu' | 'repeated';

/**
 * Почему возврат печатать нельзя; `null` — можно. Сначала счётчик (печатать не будем ни при каких условиях), затем
 * меню (6.4), затем черновик. `screen` — видимые строки терминала (`pty.screenText`); `undefined` — экрана нет.
 */
export function returnBlock(input: {
  hasDraft: boolean;
  screen: readonly string[] | undefined;
  returns: number;
}): ReturnBlock | null {
  if (input.returns >= LIMIT_RETURNS_MAX) return 'repeated';
  if (input.screen?.some((line) => line.includes(LIMIT_MENU_TEXT)) === true) return 'menu';
  return input.hasDraft ? 'draft' : null;
}

/** Причина для уведомления `limit-return-blocked`: «The limit has reset, but S03 could not continue: <причина>» (7.4). */
export function returnBlockReason(block: ReturnBlock): string {
  switch (block) {
    case 'draft':
      return 'unsent text in its terminal';
    case 'menu':
      return 'a menu is open in its terminal';
    case 'repeated':
      return 'it hit the limit again twice';
  }
}

/** Целое число миллисекунд от 100 до часа; всё остальное рычаг не задаёт. */
function leverMs(env: NodeJS.ProcessEnv, key: string): number | undefined {
  const raw = envValue(env, key)?.trim();
  if (raw === undefined || raw === '') return undefined;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 100 && value <= 3_600_000 ? value : undefined;
}

/**
 * Рычаги E2E: `PARLEY_LIMIT_RETURN_GRACE_MS` (запас после сброса) и `PARLEY_LIMIT_RETRY_MS` (срок без времени сброса),
 * а также прежние имена с `HARNAS_`. Тест не может ждать две минуты и пятнадцать. Не целое, меньше 100 мс или больше
 * часа — переменная игнорируется.
 */
export function limitReturnFromEnv(env: NodeJS.ProcessEnv): { graceMs?: number; retryMs?: number } {
  const graceMs = leverMs(env, 'LIMIT_RETURN_GRACE_MS');
  const retryMs = leverMs(env, 'LIMIT_RETRY_MS');
  return {
    ...(graceMs === undefined ? {} : { graceMs }),
    ...(retryMs === undefined ? {} : { retryMs }),
  };
}
