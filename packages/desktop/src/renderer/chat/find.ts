/**
 * Поиск по ленте вида «Chat» (план 2026-11-01, задача 9): чистая функция над моделью ленты, без React и DOM.
 * Ищет не по тому, что нарисовано, а по тому, что есть в элементах: список виртуальный (вне экрана строк нет), а вход и
 * вывод инструментов, итог субагента и свёрнутые ходы в DOM не лежат, пока их не раскрыли.
 *
 * Регистр не важен, запрос режется по краям, вхождения считаются без наложения. Ищется текст промптов и ответов, имя,
 * вход и вывод инструментов, задание, вложенные вызовы и итог субагента, карточки (разрешение, вопрос, план) и ошибки.
 * Заплатки диффа (`patch`) не ищутся: старые и новые строки правки уже лежат во входе `Edit`.
 * Текст — исходный, не отрисованный: знаки Markdown (`**`, обратные кавычки) ищутся как есть, а хост усекает длинное
 * (`FEED_TEXT_LIMIT`, `FEED_RESULT_LIMIT`) — усечённый хвост не находится.
 */

import type { FeedItem, FeedTool } from '@parley/core';
import { toolHeadline } from './feed-model.js';

/** Больше стольких совпадений счётчик не считает: «1000+», как в поиске терминала. */
export const FIND_LIMIT = 1000;

/** Где в элементе совпадение; `nth` — номер вхождения внутри части одного элемента. */
export type FindPart = 'text' | 'prompt' | 'tool-name' | 'tool-input' | 'tool-output' | 'agent' | 'card' | 'error';

export interface FindMatch {
  itemId: string;
  part: FindPart;
  nth: number;
}

export interface FindResult {
  matches: FindMatch[];
  /** Совпадений больше `FIND_LIMIT`: список обрезан. */
  capped: boolean;
}

/** Запрос в том виде, в каком его ищут и подсвечивают. */
export function normalizeQuery(query: string): string {
  return query.trim().toLowerCase();
}

/** Вход вызова, как его печатает `ToolItem` в раскрытом виде. Дельты ленты сохраняют ссылки, поэтому JSON считается один раз. */
const inputJson = new WeakMap<object, string>();
function argsText(input: Record<string, unknown>): string {
  let text = inputJson.get(input);
  if (text === undefined) {
    text = JSON.stringify(input, null, 2) ?? '';
    inputJson.set(input, text);
  }
  return text;
}

function toolFields(tool: FeedTool, part: { name: FindPart; input: FindPart; output: FindPart }): Array<[FindPart, string]> {
  return [
    [part.name, toolHeadline(tool.name, tool.input).name],
    [part.input, argsText(tool.input)],
    [part.output, tool.response?.text ?? ''],
  ];
}

/** Строки элемента, в которых ищется, в порядке показа. */
function fields(item: FeedItem): Array<[FindPart, string]> {
  switch (item.kind) {
    case 'prompt':
      return [['prompt', item.text]];
    case 'text':
      return [['text', item.text]];
    case 'tool':
      return toolFields(item, { name: 'tool-name', input: 'tool-input', output: 'tool-output' });
    case 'agent':
      return [
        ['agent', item.description ?? ''],
        ['agent', item.agentType ?? ''],
        ['agent', item.prompt ?? ''],
        ...item.children.flatMap((child) => toolFields(child, { name: 'agent', input: 'agent', output: 'agent' })),
        ['agent', item.result ?? ''],
      ];
    case 'permission':
      return [['card', item.toolName], ['card', item.message ?? '']];
    case 'question':
      return [
        ...item.questions.flatMap((question): Array<[FindPart, string]> => [
          ['card', question.question],
          ['card', question.header ?? ''],
          ...question.options.flatMap((option): Array<[FindPart, string]> => [['card', option.label], ['card', option.description ?? '']]),
        ]),
        ...Object.values(item.answers ?? {}).map((answer): [FindPart, string] => ['card', answer]),
      ];
    case 'plan':
      return [['card', item.plan]];
    case 'error':
      return [['error', item.error], ['error', item.message ?? '']];
    case 'notice':
    case 'turn':
      return [];
  }
}

export function searchFeed(items: readonly FeedItem[], query: string): FindResult {
  const needle = normalizeQuery(query);
  const matches: FindMatch[] = [];
  if (needle === '') return { matches, capped: false };
  for (const item of items) {
    const counts = new Map<FindPart, number>();
    for (const [part, value] of fields(item)) {
      if (value === '') continue;
      const haystack = value.toLowerCase();
      let from = haystack.indexOf(needle);
      while (from !== -1) {
        if (matches.length === FIND_LIMIT) return { matches, capped: true };
        const nth = counts.get(part) ?? 0;
        counts.set(part, nth + 1);
        matches.push({ itemId: item.id, part, nth });
        from = haystack.indexOf(needle, from + needle.length);
      }
    }
  }
  return { matches, capped: false };
}
