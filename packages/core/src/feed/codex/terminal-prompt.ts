/**
 * Вопросы Codex на экране терминала (план слоя 2, задача 1; замеры — `docs/research/2026-11-18-codex-terminal-prompts-spike.md`).
 * Чистая функция узнаёт вопрос по строкам видимого экрана и даёт клавишу для решения человека. Узнаётся только вся форма:
 * строка-заголовок, варианты с номерами подряд от 1 и строка-подсказка; нет любой из частей или виден знак прокрутки
 * (часть списка скрыта, узкое окно) — `null`, и вопрос остаётся панели слоя 1. Строки экрана наружу не отдаются:
 * в результат попадают только разобранные поля.
 *
 * Привязано к форме Codex 0.166.0: другая версия, у которой форма изменилась, не узнаётся — это безопасная сторона.
 */

import type { FeedDecision } from '../types.js';

export interface CodexPromptOption {
  /** Цифра варианта на экране: нажатие её одной клавишей выбирает вариант (замер: без Enter). */
  digit: string;
  /** Подпись без номера и без подсказки клавиши в скобках `(y)`, `(p)`, `(a)`, `(esc)`; `(Recommended)` остаётся. */
  label: string;
  /** Описание варианта у вопроса (вторая колонка); у одобрений `null`. */
  description: string | null;
}

interface CodexPromptBase {
  options: CodexPromptOption[];
  /** Номер (с нуля) варианта с меткой `›`. */
  selected: number;
  /** Вид + текст команды, пути или вопроса + подписи вариантов; положение метки `›` и спиннеры не входят. */
  fingerprint: string;
}

export type CodexPrompt =
  | (CodexPromptBase & { kind: 'command-approval'; command: string; reason: string | null })
  | (CodexPromptBase & { kind: 'patch-approval'; path: string })
  | (CodexPromptBase & { kind: 'question'; index: number; total: number; question: string });

const COMMAND_HEADER = 'Would you like to run the following command?';
const PATCH_HEADER = 'Would you like to make the following edits?';
const APPROVAL_HINT = 'Press enter to confirm or esc to cancel';
/** Общая часть строки-подсказки вопроса: целиком она меняется (несколько вопросов, узкое окно). */
const QUESTION_HINT = 'tab to add notes | enter to submit';
const QUESTION_HEADER = /^\s*Question (\d+)\/(\d+)\b/;
const OPTION_LINE = /^\s*(›)?\s*(\d+)\.\s+(\S.*)$/;
const SCROLL_ARROW = /^\s*[↓↑]\s*$/;
/** Подсказка клавиши в конце подписи одобрения: `(y)`, `(p)`, `(a)`, `(esc)`. */
const KEY_HINT_TAIL = /\s*\((?:y|p|a|esc)\)$/;

const squash = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** Последняя строка, равная (по `trim`) образцу; `-1` — нет. */
function lastLineIndex(lines: readonly string[], test: (line: string) => boolean): number {
  for (let at = lines.length - 1; at >= 0; at -= 1) if (test(lines[at]!)) return at;
  return -1;
}

interface Raw {
  digit: number;
  marked: boolean;
  /** Первая строка варианта после номера и продолжения строк. */
  parts: string[];
  /** Колонка, с которой начинается описание на первой строке (вопрос); `-1` — описания нет. */
  descAt: number;
}

/** Варианты между `from` и `to` (не включая `to`): номера подряд от 1, продолжения склеиваются; иначе `null`. */
function readOptions(lines: readonly string[], from: number, to: number): Raw[] | null {
  const raws: Raw[] = [];
  let ended = false;
  for (let at = from; at < to; at += 1) {
    const line = lines[at]!;
    if (line.trim() === '') {
      if (raws.length > 0) ended = true;
      continue;
    }
    const match = OPTION_LINE.exec(line);
    if (match !== null) {
      // Номер сразу после текста вопроса или команды — не вариант, пока нет первого; первый обязан быть `1.`.
      if (ended || Number(match[2]) !== raws.length + 1) return null;
      const rest = match[3]!;
      const gap = /\s{2,}/.exec(rest);
      raws.push({
        digit: Number(match[2]),
        marked: match[1] !== undefined,
        parts: [rest],
        descAt: gap === null ? -1 : line.length - rest.length + gap.index + gap[0].length,
      });
      continue;
    }
    // Продолжение подписи предыдущего варианта (перенос строки).
    if (raws.length === 0 || ended) return null;
    raws[raws.length - 1]!.parts.push(line);
  }
  return raws.length === 0 ? null : raws;
}

/** Подпись и описание варианта: у вопроса две колонки (граница — по первой строке), у одобрения одна. */
function finishOption(raw: Raw, descColumn: number, approval: boolean): CodexPromptOption {
  const label: string[] = [];
  const description: string[] = [];
  raw.parts.forEach((part, at) => {
    if (approval || descColumn < 0) {
      label.push(part);
    } else if (at === 0) {
      const gap = /\s{2,}/.exec(part);
      if (gap === null) label.push(part);
      else {
        label.push(part.slice(0, gap.index));
        description.push(part.slice(gap.index + gap[0].length));
      }
    } else {
      // Продолжение: слева от колонки описания — подпись, справа — описание.
      label.push(part.slice(0, descColumn).trim());
      description.push(part.slice(descColumn).trim());
    }
  });
  const text = squash(label.join(' '));
  return {
    digit: String(raw.digit),
    label: approval ? text.replace(KEY_HINT_TAIL, '') : text,
    description: approval || description.length === 0 ? null : squash(description.join(' ')) || null,
  };
}

function build(
  lines: readonly string[],
  headerAt: number,
  hintAt: number,
  firstOptionAt: number,
  approval: boolean,
): { options: CodexPromptOption[]; selected: number } | null {
  // Знак прокрутки внутри блока: часть списка скрыта.
  for (let at = headerAt; at < hintAt; at += 1) if (SCROLL_ARROW.test(lines[at]!)) return null;
  const raws = readOptions(lines, firstOptionAt, hintAt);
  if (raws === null) return null;
  if (approval && raws.length !== 3) return null;
  if (!approval && raws.length < 2) return null;
  // Колонка описания — по первой строке любого варианта с двумя колонками.
  const first = raws.find((raw) => raw.descAt >= 0);
  const descColumn = approval || first === undefined ? -1 : first.descAt;
  const options = raws.map((raw) => finishOption(raw, descColumn, approval));
  const marked = raws.findIndex((raw) => raw.marked);
  return { options, selected: marked < 0 ? 0 : marked };
}

/** Первая строка варианта с номером `1.` после `from`; `-1` — нет. */
function firstOption(lines: readonly string[], from: number, to: number): number {
  for (let at = from; at < to; at += 1) {
    const match = OPTION_LINE.exec(lines[at]!);
    if (match !== null && match[2] === '1') return at;
  }
  return -1;
}

function approvalPrompt(lines: readonly string[], headerAt: number, kind: 'command-approval' | 'patch-approval'): CodexPrompt | null {
  const hintAt = lastLineIndex(lines, (line) => line.trim() === APPROVAL_HINT);
  if (hintAt < headerAt) return null;
  const optionsAt = firstOption(lines, headerAt + 1, hintAt);
  if (optionsAt < 0) return null;
  const built = build(lines, headerAt, hintAt, optionsAt, true);
  if (built === null) return null;
  const head = lines.slice(headerAt + 1, optionsAt);
  const labels = built.options.map((option) => option.label);
  if (kind === 'command-approval') {
    const commandAt = head.findIndex((line) => line.trim().startsWith('$ '));
    if (commandAt < 0) return null;
    // Команда и `Reason:` переносятся: склеиваем строки до следующей части формы (пустая строка).
    const reasonAt = head.findIndex((line) => line.trim().startsWith('Reason:'));
    const take = (at: number, strip: string): string => {
      const parts = [head[at]!.trim().slice(strip.length)];
      for (let next = at + 1; next < head.length && head[next]!.trim() !== ''; next += 1) parts.push(head[next]!.trim());
      return squash(parts.join(' '));
    };
    const command = take(commandAt, '$ ');
    if (command === '') return null;
    const reason = reasonAt < 0 ? null : take(reasonAt, 'Reason:') || null;
    return {
      kind,
      command,
      reason,
      options: built.options,
      selected: built.selected,
      fingerprint: [kind, command, ...labels].join('\n'),
    };
  }
  const destinationAt = head.findIndex((line) => line.trim() === 'Destination:');
  if (destinationAt < 0) return null;
  // Путь переносится посреди слова: склеиваем без пробела до пустой строки.
  const parts: string[] = [];
  for (let next = destinationAt + 1; next < head.length && head[next]!.trim() !== ''; next += 1) parts.push(head[next]!.trim());
  const path = parts.join('');
  if (path === '') return null;
  return { kind, path, options: built.options, selected: built.selected, fingerprint: [kind, path, ...labels].join('\n') };
}

function questionPrompt(lines: readonly string[], headerAt: number): CodexPrompt | null {
  const header = QUESTION_HEADER.exec(lines[headerAt]!);
  if (header === null) return null;
  // Подсказка — после вариантов; ищем первую строку с общей частью после заголовка.
  let hintAt = -1;
  for (let at = headerAt + 1; at < lines.length; at += 1) {
    if (lines[at]!.includes(QUESTION_HINT)) {
      hintAt = at;
      break;
    }
  }
  if (hintAt < 0) return null;
  const optionsAt = firstOption(lines, headerAt + 1, hintAt);
  if (optionsAt < 0) return null;
  const built = build(lines, headerAt, hintAt, optionsAt, false);
  if (built === null) return null;
  const question = squash(lines.slice(headerAt + 1, optionsAt).join(' '));
  if (question === '') return null;
  const index = Number(header[1]);
  const total = Number(header[2]);
  return {
    kind: 'question',
    index,
    total,
    question,
    options: built.options,
    selected: built.selected,
    fingerprint: ['question', `${index}/${total}`, question, ...built.options.map((option) => option.label)].join('\n'),
  };
}

/** Вопрос на экране или `null`. Принимает весь видимый экран строками; берётся самый нижний заголовок. */
export function recogniseCodexPrompt(lines: readonly string[]): CodexPrompt | null {
  const headerAt = lastLineIndex(lines, (line) => {
    const text = line.trim();
    return text === COMMAND_HEADER || text === PATCH_HEADER || QUESTION_HEADER.test(line);
  });
  if (headerAt < 0) return null;
  const text = lines[headerAt]!.trim();
  if (text === COMMAND_HEADER) return approvalPrompt(lines, headerAt, 'command-approval');
  if (text === PATCH_HEADER) return approvalPrompt(lines, headerAt, 'patch-approval');
  return questionPrompt(lines, headerAt);
}

/** Клавиша одного нажатия для решения; `null` — решение этим вопросом не выражается одной клавишей. */
export function codexPromptKey(prompt: CodexPrompt, decision: FeedDecision): string | null {
  if (prompt.kind === 'question') {
    if (decision.kind !== 'question') return null;
    const entries = Object.entries(decision.answers);
    const answer = decision.answers[prompt.question] ?? (entries.length === 1 ? entries[0]![1] : undefined);
    if (answer === undefined) return null;
    // Последний вариант — «None of the above»: цифрой он отправляет ответ без текста, свой ответ — отдельный путь.
    const found = prompt.options.slice(0, -1).find((option) => option.label === answer);
    return found === undefined ? null : found.digit;
  }
  if (decision.kind !== 'permission') return null;
  // Отказ — всегда `3`; текст отказа (если есть) хост печатает отдельным сообщением после (задача 4).
  if (decision.behavior === 'deny') return '3';
  return decision.always === true ? '2' : '1';
}
