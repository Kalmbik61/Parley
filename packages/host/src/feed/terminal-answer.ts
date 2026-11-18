/**
 * Свой ответ на вопрос Codex в терминале (план слоя 2, задача 4): цифрой варианта «None of the above» ответ уходит
 * без текста, поэтому свой текст печатается по шагам — стрелками до последнего варианта, Tab (поле заметок), текст,
 * Enter. Перед каждой клавишей хост сверяет экран, после каждой ждёт, что шаг показался; не показался — стоп и дальше
 * клавиш нет (вслепую не печатаем). Ничего не логирует: текст ответа и экран наружу не идут.
 */

import { recogniseCodexPrompt } from '@parley/core';
import type { CodexPrompt } from '@parley/core';
import type { SessionRef } from '@parley/protocol';
import type { PtyManager } from '../pty/pty-manager.js';

export type TerminalAnswerOutcome = 'done' | 'screen-changed' | 'timeout';

/** Как часто сверяется экран после клавиши и сколько ждётся шаг — как `POLL_MS` и `STEP_MAX_MS` смены режима. */
export const ANSWER_POLL_MS = 50;
export const ANSWER_STEP_MAX_MS = 1_500;

const ARROW_DOWN = '\u001b[B';
const TAB = '\t';
/** Подсказка экрана, на котором открыто поле заметок (замер: `question-notes-open`). */
const NOTES_HINT = 'tab or esc to clear notes';
/** Сколько знаков начала текста сверяется с экраном: длинный ответ переносится по строкам. */
const SHOWN_PREFIX = 20;

export interface TerminalAnswerDeps {
  pty: Pick<PtyManager, 'write' | 'screenText'>;
  sleep(ms: number): Promise<void>;
  /** Хост останавливается или сессия ушла: дальше клавиш нет. */
  cancelled?(): boolean;
}

/** Ответ без управляющих знаков: Enter внутри текста отправил бы вопрос раньше времени. */
export function cleanAnswer(text: string): string {
  let out = '';
  let control = false;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) {
      // Подряд идущие управляющие знаки — один пробел.
      if (!control) out += ' ';
      control = true;
    } else {
      out += char;
      control = false;
    }
  }
  return out.trim();
}

export async function typeOwnAnswer(
  deps: TerminalAnswerDeps,
  ref: SessionRef,
  prompt: CodexPrompt & { kind: 'question' },
  text: string,
): Promise<TerminalAnswerOutcome> {
  const clean = cleanAnswer(text);
  if (clean === '') return 'timeout';
  const lines = (): string[] => deps.pty.screenText(ref) ?? [];
  const same = (screen: readonly string[]): CodexPrompt | null => {
    const seen = recogniseCodexPrompt(screen);
    return seen !== null && seen.kind === 'question' && seen.fingerprint === prompt.fingerprint ? seen : null;
  };
  const notesOpen = (screen: readonly string[]): boolean => screen.some((line) => line.includes(NOTES_HINT));
  const cancelled = (): boolean => deps.cancelled?.() === true;

  /** Ждёт, что экран отвечает условию: сначала сразу, затем раз в `ANSWER_POLL_MS` до `ANSWER_STEP_MAX_MS`. */
  const waitFor = async (condition: (screen: string[]) => boolean): Promise<boolean> => {
    let waited = 0;
    for (;;) {
      if (cancelled()) return false;
      if (condition(lines())) return true;
      if (waited >= ANSWER_STEP_MAX_MS) return false;
      await deps.sleep(ANSWER_POLL_MS);
      waited += ANSWER_POLL_MS;
    }
  };
  /** Сверка экрана и запись клавиши в одном синхронном шаге: клавиша уходит в тот экран, который только что видели. */
  const press = (key: string, ok: (screen: string[]) => boolean): boolean => {
    if (cancelled()) return false;
    if (!ok(lines())) return false;
    deps.pty.write(ref, key);
    return true;
  };

  const first = same(lines());
  if (first === null) return 'screen-changed';
  const last = prompt.options.length - 1;
  let selected = first.selected;
  while (selected < last) {
    const at = selected;
    if (!press(ARROW_DOWN, (screen) => same(screen)?.selected === at)) return 'screen-changed';
    if (!(await waitFor((screen) => same(screen)?.selected === at + 1))) return 'timeout';
    selected = at + 1;
  }
  if (!press(TAB, (screen) => same(screen)?.selected === last)) return 'screen-changed';
  if (!(await waitFor(notesOpen))) return 'timeout';
  if (!press(clean, notesOpen)) return 'screen-changed';
  const shown = clean.slice(0, SHOWN_PREFIX);
  if (!(await waitFor((screen) => screen.some((line) => line.includes(shown))))) return 'timeout';
  if (!press('\r', notesOpen)) return 'screen-changed';
  // Вопроса нет: ответ принят (последний вопрос) или Codex показал следующий (другой отпечаток).
  return (await waitFor((screen) => !notesOpen(screen) && same(screen) === null)) ? 'done' : 'timeout';
}
