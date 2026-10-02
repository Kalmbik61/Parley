/**
 * Смена режима разрешений Claude Code из окна (план 2026-10-01, решение 4; кусок 4a): хост жмёт
 * Shift+Tab печатью хоста и после каждого нажатия сверяется с подвалом терминала — режим живёт в
 * самом CLI, и угадать его по числу нажатий нельзя (диалог поверх, режимы вне цикла, потерянная
 * клавиша). Не сошлось — хост останавливается и говорит, что видит; человек решает дальше сам.
 *
 * Порядок цикла Shift+Tab хост не предполагает: у модели с режимом auto он длиннее (живая проверка
 * 2026-10-02 — сессия стояла в auto, стенд этого режима не видел). Хост жмёт по одному, пока подвал
 * не покажет цель, не больше `MAX_PRESSES`; подвал вернулся к исходному режиму — цели в цикле нет.
 * Подпись режима обхода разрешений («bypass permissions on») хост не распознаёт вовсе — само имя
 * этого режима в исходниках запрещено стражем рамки (`test/frame-scan.ts`, YOLO-флаги); в нём подвал
 * считается неизвестным, ответ `mode: null`, нажатий нет, а окно видит режим из хуков ленты.
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
/** Сколько нажатий Shift+Tab хост делает, прежде чем сдаться: режимов в цикле не больше четырёх. */
export const MAX_PRESSES = 5;

/** Подпись подвала → сырая строка режима CLI; со словом «on» — «auto mode unavailable» не режим. */
const FOOTER_LABELS: readonly (readonly [RegExp, string])[] = [
  [/manual mode on/i, 'default'],
  [/accept edits on/i, 'acceptEdits'],
  [/plan mode on/i, 'plan'],
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

  // Читается вся видимая область, а не несколько нижних строк: пока разговор короче экрана, CLI
  // рисует поле ввода и подвал сразу под текстом, и ниже остаются пустые строки (живая проверка
  // 2026-10-02 — «Open the terminal» на каждую смену режима). Прокрутка в видимую область не входит,
  // а внутри неё нижняя подпись — всегда подвал: вывод агента лежит выше поля ввода.
  const read = (): string | null => {
    const lines = pty.screenText(ref);
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

  /** Ждёт, пока подвал покажет что-то кроме `before` (не дольше `STEP_MAX_MS`); возвращает последнее, что видел. */
  const waitChange = async (before: string): Promise<string | null> => {
    let waited = 0;
    let seen = read();
    while (seen === before && waited < STEP_MAX_MS) {
      await sleep(POLL_MS);
      waited += POLL_MS;
      seen = read();
    }
    return seen;
  };

  await waitQuiet();
  const start = read();
  if (start === null) return { mode: null, verified: false };
  if (start === target) return { mode: start, verified: true };

  // Порядок цикла хост не предполагает: у модели с режимом auto он длиннее (живая проверка
  // 2026-10-02 — сессия стояла в auto, и хост отказывался нажимать). Жмём по одному, после каждого
  // ждём смены подвала; цель показалась — готово; подвал вернулся к исходному (полный круг без цели),
  // не сменился (нажатие потеряно) или пропал (диалог поверх) — стоп, отвечаем тем, что видим.
  let shown: string = start;
  for (let press = 0; press < MAX_PRESSES; press += 1) {
    const before = shown;
    pty.write(ref, SHIFT_TAB);
    const seen = await waitChange(before);
    if (seen === null || seen === before) return { mode: seen, verified: false };
    shown = seen;
    if (shown === target) return { mode: shown, verified: true };
    if (shown === start) return { mode: shown, verified: false };
  }
  return { mode: shown, verified: false };
}
