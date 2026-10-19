/**
 * Структурная сводка карточки ленты, ждущей человека: что просят разрешить, спросить или одобрить.
 * Слов для человека здесь нет — только структура: подписи берёт окно из своих строк, а хост кладёт
 * структуру в предложение помощника. Чистые функции без сторов.
 */

import type { FeedCard, FeedItem } from './types.js';

export type CardGist =
  | { kind: 'run'; command: string }
  | { kind: 'tool'; tool: string; path: string | null }
  | { kind: 'fetch'; url: string }
  | { kind: 'question'; text: string }
  | { kind: 'plan' };

/** Первая непустая строка: команда или вопрос бывают многострочными. */
function firstLine(text: string): string {
  return text.split(/\r?\n/).find((line) => line.trim() !== '')?.trim() ?? '';
}

/** Путь внутри проекта — относительно него (с учётом хвостового `/`), иначе как есть. */
function shownPath(path: string, projectPath: string): string {
  const root = projectPath.replace(/\/+$/, '');
  return root !== '' && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
}

/** Команда карточки целиком: Claude присылает строку, Codex — argv массивом. */
function commandOf(input: Record<string, unknown>): string | null {
  const command = input.command;
  if (Array.isArray(command) && command.every((part) => typeof part === 'string')) return command.join(' ');
  return typeof command === 'string' ? command : null;
}

function isCard(item: FeedItem): item is FeedCard {
  return item.kind === 'permission' || item.kind === 'question' || item.kind === 'plan';
}

export function cardGist(card: FeedCard, projectPath: string): CardGist {
  if (card.kind === 'plan') return { kind: 'plan' };
  if (card.kind === 'question') return { kind: 'question', text: firstLine(card.questions[0]?.question ?? '') };
  const input = card.toolInput;
  const command = commandOf(input);
  if (command !== null) return { kind: 'run', command: firstLine(command) };
  for (const key of ['file_path', 'notebook_path', 'path']) {
    const path = input[key];
    if (typeof path === 'string') return { kind: 'tool', tool: card.toolName, path: shownPath(path, projectPath) };
  }
  if (typeof input.url === 'string') return { kind: 'fetch', url: input.url };
  return { kind: 'tool', tool: card.toolName, path: null };
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Что человек должен увидеть, чтобы решить: команда или правка целиком, вопрос с вариантами, план; обрезка по max с «…». */
export function cardDetail(card: FeedCard, max = 1500): string | null {
  if (card.kind === 'plan') return clip(card.plan, max);
  if (card.kind === 'question') {
    if (card.questions.length === 0) return null;
    const block = (question: (typeof card.questions)[number], label: string): string => [`${label}: ${question.question}`, ...question.options.map((option) => `- ${option.label}`)].join('\n');
    const [only] = card.questions;
    if (card.questions.length === 1 && only !== undefined) return clip(block(only, 'Q'), max);
    return clip(card.questions.map((question, index) => block(question, `Q${index + 1}`)).join('\n\n'), max);
  }
  const command = commandOf(card.toolInput);
  if (command !== null) return clip(command, max);
  const { old_string: before, new_string: after, content, edits, new_source: source } = card.toolInput;
  if (typeof before === 'string' && typeof after === 'string') return clip(`${before}\n→\n${after}`, max);
  if (typeof content === 'string') return clip(content, max);
  if (typeof source === 'string') return clip(source, max);
  if (Array.isArray(edits)) {
    const parts = edits.flatMap((edit: unknown) => {
      const { old_string: from, new_string: to } = (typeof edit === 'object' && edit !== null ? edit : {}) as Record<string, unknown>;
      return typeof from === 'string' && typeof to === 'string' ? [`${from}\n→\n${to}`] : [];
    });
    if (parts.length > 0) return clip(parts.join('\n---\n'), max);
  }
  return null;
}

/** Все карточки, ждущие ответа, по порядку ленты. */
export function pendingCards(items: readonly FeedItem[]): FeedCard[] {
  return items.filter((item): item is FeedCard => isCard(item) && item.state === 'pending');
}
