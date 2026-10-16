/**
 * Вопрос агента, на который остров отвечает кнопками (спека 2026-10-12, раздел 4): один вопрос, один выбор, от одного
 * до четырёх вариантов. Остальное (несколько вопросов, мультивыбор, свой ответ) — «Open in Parley». Ответ — как у
 * карточки ленты: `answers` по тексту вопроса, значение — подпись варианта.
 */

import type { FeedCard } from '@parley/core';

const MAX_OPTIONS = 4;

export function simpleChoices(card: FeedCard): { question: string; options: string[] } | null {
  if (card.kind !== 'question' || card.questions.length !== 1) return null;
  const [only] = card.questions;
  if (only === undefined || only.multiSelect || only.options.length === 0 || only.options.length > MAX_OPTIONS) return null;
  return { question: only.question, options: only.options.map((option) => option.label) };
}
