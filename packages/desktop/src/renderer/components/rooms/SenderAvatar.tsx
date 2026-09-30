/**
 * Аватар отправителя в ленте комнаты (спека окна 2026-09-29, 1.3): у агента — значок его провайдера, у
 * человека — круг `accent-2-200` с `User` цвета `accent-2-800`, у системы — круг `neutral-300` с `Hash`
 * цвета `neutral-800`. Удалённая сессия и незнакомый отправитель — буква `?` на подложке `AgentIcon`.
 */

import { Hash, User } from 'lucide-react';
import { S } from '../../../shared/strings.js';
import { cn } from '../../lib/cn.js';
import { AgentIcon } from '../AgentIcon.js';
import type { SenderKind } from './feed-model.js';

export interface SenderAvatarProps {
  kind: SenderKind;
  /** Провайдер агента; `null` — сессии уже нет в карте. */
  provider: string | null;
  size?: number;
}

export function SenderAvatar({ kind, provider, size = 18 }: SenderAvatarProps): JSX.Element {
  if (kind === 'agent') return <AgentIcon provider={provider ?? '?'} size={size} />;
  const human = kind === 'human';
  const Icon = human ? User : Hash;
  return (
    <span
      title={human ? S.participants.human : S.participants.system}
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-full',
        human ? 'bg-accent-2-200 text-accent-2-800' : 'bg-neutral-300 text-neutral-800',
      )}
      style={{ width: size, height: size }}
    >
      <Icon size={Math.round(size * (human ? 0.62 : 0.6))} aria-hidden="true" />
    </span>
  );
}
