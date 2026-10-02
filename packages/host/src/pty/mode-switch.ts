/**
 * Смена режима разрешений Claude Code из окна (план 2026-10-01, решение 4; кусок 4a): хост жмёт
 * Shift+Tab печатью хоста и после каждого нажатия сверяется с подвалом терминала — режим живёт в
 * самом CLI, и угадать его по числу нажатий нельзя (диалог поверх, режимы вне цикла, потерянная
 * клавиша). Не сошлось — хост останавливается и говорит, что видит; человек решает дальше сам.
 *
 * Цикл окна: default → acceptEdits → plan → default. `bypassPermissions` и `auto` в него не входят:
 * из них хост ничего не нажимает.
 */

import { refKey } from '@parley/protocol';
import type { PermissionModeChoice, SessionRef } from '@parley/protocol';
import { HostError } from '../errors.js';
import type { PtyManager } from './pty-manager.js';

/** Shift+Tab — CSI Z. */
export const SHIFT_TAB = '\x1b[Z';
/** Сколько тишины вывода PTY нужно, чтобы считать экран устоявшимся. */
export const QUIET_MS = 200;
/** Дольше этого тишину не ждём: шумный экран (спиннер) читается как есть. */
export const QUIET_MAX_MS = 2_000;
/** Как часто сверяется подвал после нажатия и сколько ждётся смена. */
export const POLL_MS = 50;
export const STEP_MAX_MS = 1_500;
/**
 * Сколько нижних строк экрана читается в поиске подвала: подвал с режимом — последние 1–2 строки
 * экрана, над ним строка статуса (в уликах p3 так). Больше — и в прокрутке подцепится чужая подпись.
 */
const FOOTER_ROWS = 4;

const CYCLE: readonly PermissionModeChoice[] = ['default', 'acceptEdits', 'plan'];

/** Подпись подвала → сырая строка режима CLI; со словом «on» — «auto mode unavailable» не режим. */
const FOOTER_LABELS: readonly (readonly [RegExp, string])[] = [
  [/manual mode on/i, 'default'],
  [/accept edits on/i, 'acceptEdits'],
  [/plan mode on/i, 'plan'],
  [/bypass permissions on/i, 'bypassPermissions'],
  [/auto mode on/i, 'auto'],
];

export interface ModeSwitchResult {
  /** Что показал подвал в конце; `null` — подвала не нашли. */
  mode: string | null;
  /** Подвал показал ровно целевой режим. */
  verified: boolean;
}

export interface ModeSwitchDeps {
  pty: Pick<PtyManager, 'write' | 'on' | 'get' | 'screenText'>;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
}

/** Режим по подвалу: нижняя из строк с подписью побеждает; подписи нет — `null`. */
export function modeFromFooter(lines: readonly string[]): string | null {
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i] as string;
    for (const [pattern, mode] of FOOTER_LABELS) {
      if (pattern.test(line)) return mode;
    }
  }
  return null;
}

export async function switchMode(
  deps: ModeSwitchDeps,
  ref: SessionRef,
  target: PermissionModeChoice,
): Promise<ModeSwitchResult> {
  const setTimer = deps.setTimer ?? setTimeout;
  const clearTimer = deps.clearTimer ?? clearTimeout;
  const { pty } = deps;
  if (pty.get(ref) === undefined) {
    throw new HostError('not_found', `no live PTY for session ${ref.sessionId}`);
  }
  const key = refKey(ref);

  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      setTimer(resolve, ms);
    });

  const read = (): string | null => {
    const lines = pty.screenText(ref, FOOTER_ROWS);
    return lines === undefined ? null : modeFromFooter(lines);
  };

  /** Ждёт 200 мс без вывода PTY, но не дольше 2 с: нажатие в разгар перерисовки теряется. */
  const waitQuiet = (): Promise<void> =>
    new Promise((resolve) => {
      let quiet: ReturnType<typeof setTimeout> | undefined;
      const finish = (): void => {
        unsubscribe();
        if (quiet !== undefined) clearTimer(quiet);
        clearTimer(cap);
        resolve();
      };
      const arm = (): void => {
        if (quiet !== undefined) clearTimer(quiet);
        quiet = setTimer(finish, QUIET_MS);
      };
      const unsubscribe = pty.on('output', (changed) => {
        if (refKey(changed) === key) arm();
      });
      const cap = setTimer(finish, QUIET_MAX_MS);
      arm();
    });

  /** Ждёт, пока подвал покажет `expected`; возвращает последнее, что видел. */
  const waitFor = async (expected: string): Promise<string | null> => {
    let waited = 0;
    let seen = read();
    while (seen !== expected && waited < STEP_MAX_MS) {
      await sleep(POLL_MS);
      waited += POLL_MS;
      seen = read();
    }
    return seen;
  };

  await waitQuiet();
  const current = read();
  if (current === null) return { mode: null, verified: false };
  if (current === target) return { mode: current, verified: true };
  const from = CYCLE.indexOf(current as PermissionModeChoice);
  // Режим вне цикла (bypass, auto): Shift+Tab ушёл бы в другое место — не нажимаем ничего.
  if (from === -1) return { mode: current, verified: false };

  const presses = (CYCLE.indexOf(target) - from + CYCLE.length) % CYCLE.length;
  let shown: string = current;
  for (let step = 1; step <= presses; step += 1) {
    const expected = CYCLE[(from + step) % CYCLE.length] as string;
    pty.write(ref, SHIFT_TAB);
    const seen = await waitFor(expected);
    if (seen !== expected) return { mode: seen, verified: false };
    shown = seen;
  }
  return { mode: shown, verified: shown === target };
}
