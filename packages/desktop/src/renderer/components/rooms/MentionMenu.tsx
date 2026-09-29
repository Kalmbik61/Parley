/**
 * Меню упоминаний над полем ввода комнаты (спека окна 2026-09-29, 1.3, 2.3): участники комнаты, что
 * подошли под `@запрос`. Радиус 16, фон `neutral-100`, `shadow-lg`, до 260px высоты. Пункт — значок
 * агента 16, `S02 бэкенд` (600), `★` у ведущего (решение контролёра 1 куска 6; в снимке handoff его нет) и
 * мета `Opus 5.5 · idle`: модель из живых метрик и слово состояния; модель неизвестна — одно слово
 * состояния, усилие не показывается (его никто не хранит). Клик — на `mousedown` с `preventDefault`, чтобы
 * поле не теряло фокус и курсор.
 *
 * Агентов больше, чем помещается в 260px, — список прокручивается, и выбранный клавишами пункт уходит в
 * видимую часть (`scrollIntoView({ block: 'nearest' })`, отступ от края — `scroll-py-1.5`, как padding
 * списка). Наведением мыши список не двигается: пункт под курсором и так виден, а прокрутка из-под курсора
 * сдвигала бы список ему навстречу.
 */

import { useLayoutEffect, useRef } from 'react';
import { S } from '../../../shared/strings.js';
import { AgentIcon } from '../AgentIcon.js';
import { cn } from '../../lib/cn.js';
import type { ComposerMember } from './Composer.js';

export interface MentionMenuProps {
  items: readonly ComposerMember[];
  selected: number;
  /** Выбор сдвинули клавиши или новый запрос — выбранный пункт надо показать; наведение мыши — нет. */
  reveal: boolean;
  onPick(member: ComposerMember): void;
  onHover(index: number): void;
}

export function MentionMenu({ items, selected, reveal, onPick, onHover }: MentionMenuProps): JSX.Element {
  const listRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    if (!reveal) return;
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [reveal, selected, items.length]);

  return (
    <div
      ref={listRef}
      role="listbox"
      aria-label={S.rooms.mentionHeading}
      className="absolute bottom-[calc(100%-4px)] left-9 z-5 flex max-h-[260px] w-[min(380px,calc(100%-72px))] scroll-py-1.5 flex-col gap-0.5 overflow-y-auto rounded-md bg-neutral-100 p-1.5 text-foreground shadow-lg"
    >
      <span className="px-2.5 pb-0.5 pt-1 text-[11px] font-semibold uppercase tracking-[0.06em] text-neutral-700">
        {S.rooms.mentionHeading}
      </span>
      {items.map((member, index) => (
        <div
          key={member.id}
          role="option"
          aria-selected={index === selected}
          data-mention-item={member.id}
          onMouseDown={(event) => {
            // Без этого поле теряет фокус, а вместе с ним и курсор, куда встанет чип.
            event.preventDefault();
            onPick(member);
          }}
          onMouseMove={() => {
            if (index !== selected) onHover(index);
          }}
          className={cn(
            'flex cursor-pointer items-center gap-2.5 rounded-[10px] px-2.5 py-[7px]',
            index === selected && 'bg-[color-mix(in_srgb,var(--color-text)_9%,transparent)]',
          )}
        >
          <AgentIcon provider={member.provider} size={16} />
          <span className="min-w-0 max-w-[70%] truncate font-semibold">{member.label}</span>
          {member.lead ? (
            <span title={S.rooms.lead} className="shrink-0 text-[11px] text-accent-700">
              ★
            </span>
          ) : null}
          <span className="min-w-0 flex-1 truncate text-xs text-neutral-700">{S.rooms.mentionMeta(member.model, member.word)}</span>
        </div>
      ))}
      {items.length === 0 ? <span className="px-2.5 py-2 text-xs text-neutral-700">{S.rooms.mentionEmpty}</span> : null}
    </div>
  );
}
