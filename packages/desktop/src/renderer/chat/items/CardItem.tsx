/**
 * Карточка разрешения, вопроса или плана (план 2026-10-01, решение 3, кусок 4a): диспетчер по виду.
 * Хост без `feed.decide` (старый) решений принять не может — ждущая карточка остаётся одной строкой
 * «ждёт ответа в терминале», как в куске 3, без кнопок. Рамка, иконка и состояния — `cards/CardFrame`.
 */

import type { FeedCard } from '@parley/core';
import { S } from '../../../shared/strings.js';
import { useHostSupports } from '../../lib/capabilities.js';
import { CardFrame } from '../cards/CardFrame.js';
import { PermissionCard } from '../cards/PermissionCard.js';
import { PlanCard } from '../cards/PlanCard.js';
import { QuestionCard } from '../cards/QuestionCard.js';

export function CardItem({ item }: { item: FeedCard }): JSX.Element {
  const canDecide = useHostSupports('feed.decide');
  if (item.state === 'pending' && !canDecide) return <CardFrame item={item} status={S.chat.waiting} />;
  switch (item.kind) {
    case 'permission':
      return <PermissionCard item={item} />;
    case 'question':
      return <QuestionCard item={item} />;
    case 'plan':
      return <PlanCard item={item} />;
  }
}
