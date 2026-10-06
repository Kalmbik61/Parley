/**
 * Смена effort идущей сессии Claude Code из окна (спека нормалайзера, 5.7): хост печатает `/effort`, открывает
 * ползунок, ставит уровень стрелками и жмёт `s` — «только для этой сессии». Так уровень не становится умолчанием
 * человека: `Enter` в ползунке и `/effort <уровень>` пишут его в настройки CLI, а `s` — нет (живая проверка на
 * Claude Code 2.1.289, 2026-10-06). Образец — `mode-switch.ts`: печать хоста, чтение экрана, ожидание тишины.
 *
 * Где сейчас бегунок, хост не читает: `←` упирается в нижний край, поэтому их на одно больше, чем уровней; дальше
 * `→` до цели по порядку уровней модели. Итог сверяется по подвалу, который Claude Code показывает после `s`
 * («◐ medium · /effort»); знак перед уровнем не читается («◉ xhigh · /effort»). Подвал показал другое
 * (предел администратора, потерянная клавиша) — Esc, если ползунок ещё открыт, и ответ тем, что видно. Карту
 * меняет вызывающий и только при `verified: true`.
 *
 * Ползунок уже открыт до печати (его оставил человек в терминале) — хост ничего не жмёт и отвечает `busy`: Enter
 * после `/effort` сохранил бы уровень этого ползунка умолчанием человека.
 */

import { HOST_ERROR_REASONS, refKey } from '@parley/protocol';
import type { SessionRef } from '@parley/protocol';
import { HostError } from '../errors.js';
import { POLL_MS, QUIET_MAX_MS, QUIET_MS } from './mode-switch.js';
import type { PtyManager } from './pty-manager.js';

/** Команда ползунка и Enter, которым она уходит. */
const COMMAND = '/effort';
const ENTER = '\r';
/** Стрелки и Esc — как их шлёт терминал. */
const LEFT = '\x1b[D';
const RIGHT = '\x1b[C';
const ESC = '\x1b';
/** «Только для этой сессии»: уровень применяется без записи умолчания человека. */
const SESSION_ONLY = 's';
/** Подсказка открытого ползунка: «←/→ to adjust · Enter to confirm · s for this session only · Esc to cancel». */
const HINT_SESSION = 's for this session only';
const HINT_CANCEL = 'Esc to cancel';
/** Сколько нижних непустых строк экрана смотрим: подсказка ползунка стоит у нижнего края. */
const SLIDER_TAIL_LINES = 8;
/** Сколько ждать ползунка после Enter (спека 5.7, п. 2). */
const SLIDER_MAX_MS = 3_000;
/** Сколько ждать подвала с уровнем после `s` (спека 5.7, п. 4). */
const FOOTER_MAX_MS = 2_000;
/** Пауза между нажатиями: пачку стрелок CLI мог бы прочесть одним вводом. */
const KEY_GAP_MS = 50;
/** Подвал после `s`: «◐ medium · /effort». */
const FOOTER = /(?:^|\s)([a-z]+)\s*·\s*\/effort\b/;

export interface EffortSwitchResult {
  /** Что показал подвал в конце; `null` — подвала с уровнем нет. */
  effort: string | null;
  /** Подвал показал ровно целевой уровень. */
  verified: boolean;
}

export interface EffortSwitchDeps {
  pty: Pick<PtyManager, 'write' | 'on' | 'get' | 'screenText'>;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
}

/**
 * Открыт ли ползунок `/effort`: среди последних восьми непустых строк экрана — подсказка самого ползунка, обе её
 * части сразу (`s for this session only` и `Esc to cancel`) в одной строке или в двух соседних: на узком терминале
 * подсказка переносится. Одна фраза в тексте ответа агента (она есть в коде и тестах самого Parley) — не ползунок.
 */
export function sliderOnScreen(lines: readonly string[]): boolean {
  const tail = lines
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(-SLIDER_TAIL_LINES);
  const hinted = (text: string): boolean => text.includes(HINT_SESSION) && text.includes(HINT_CANCEL);
  return tail.some((line, i) => hinted(line) || (i > 0 && hinted(`${tail[i - 1]} ${line}`)));
}

/**
 * Идёт смена модели или effort либо на экране открыт ползунок `/effort`: печатать в такую сессию нельзя — текст
 * ушёл бы в ползунок, а Enter сохранил бы его уровень умолчанием человека. Одна проверка для `pty.send` и будильника.
 * `switching` — замок смены сессии (`SessionsService.exclusive.held`); без него смотрится только экран.
 */
export function choiceInProgress(
  ref: SessionRef,
  deps: { pty: Pick<PtyManager, 'screenText'>; switching?: (ref: SessionRef) => boolean },
): boolean {
  return deps.switching?.(ref) === true || sliderOnScreen(deps.pty.screenText(ref) ?? []);
}

/** Уровень по подвалу: нижняя строка с ним побеждает; нет — `null`. */
export function effortFromFooter(lines: readonly string[]): string | null {
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const match = FOOTER.exec(lines[i] as string);
    if (match !== null) return match[1] as string;
  }
  return null;
}

/**
 * Ставит уровень `target` ползунком. `levels` — уровни модели сессии по порядку (`effortsFor`): их же показывает
 * ползунок. Проверку уровня по модели и занятость агента ведёт вызывающий.
 */
export async function switchEffort(
  ref: SessionRef,
  target: string,
  levels: readonly string[],
  deps: EffortSwitchDeps,
): Promise<EffortSwitchResult> {
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

  // Вся видимая область, как у смены режима: у короткого разговора подвал стоит не в последней строке.
  const screen = (): readonly string[] => pty.screenText(ref) ?? [];
  const sliderOpen = (): boolean => sliderOnScreen(screen());
  const shown = (): string | null => effortFromFooter(screen());

  /** Ждёт `QUIET_MS` без вывода PTY, но не дольше `QUIET_MAX_MS`: печать в разгар перерисовки теряется. */
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

  /** Опрашивает экран раз в `POLL_MS`, пока `done` не скажет «да», но не дольше `maxMs`. */
  const poll = async (done: () => boolean, maxMs: number): Promise<void> => {
    for (let waited = 0; !done() && waited < maxMs; waited += POLL_MS) await sleep(POLL_MS);
  };

  const press = async (data: string, count: number): Promise<void> => {
    for (let i = 0; i < count; i += 1) {
      pty.write(ref, data);
      await sleep(KEY_GAP_MS);
    }
  };

  await waitQuiet();
  if (sliderOpen()) {
    throw new HostError('conflict', 'The /effort slider is already open in the terminal; close it first', {
      reason: HOST_ERROR_REASONS.busy,
    });
  }
  pty.write(ref, COMMAND);
  await waitQuiet();
  pty.write(ref, ENTER);
  await poll(sliderOpen, SLIDER_MAX_MS);
  if (!sliderOpen()) {
    pty.write(ref, ESC);
    return { effort: shown(), verified: false };
  }
  // `←` на одно больше, чем уровней: упор в нижний край, с какого бы уровня бегунок ни начал.
  await press(LEFT, levels.length + 1);
  await press(RIGHT, levels.indexOf(target));
  pty.write(ref, SESSION_ONLY);
  // Подвал мог ещё показывать прежний уровень этой сессии: ждём цель, а не первое увиденное.
  await poll(() => shown() === target, FOOTER_MAX_MS);
  const seen = shown();
  if (seen === target) return { effort: seen, verified: true };
  if (sliderOpen()) pty.write(ref, ESC);
  return { effort: seen, verified: false };
}
