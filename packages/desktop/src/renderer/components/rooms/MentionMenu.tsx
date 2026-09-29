/**
 * Меню упоминаний над полем ввода комнаты (спека окна 2026-09-29, 1.3, 2.3): участники комнаты, что
 * подошли под `@запрос`. Радиус 16, фон `neutral-100`, `shadow-lg`, до 260px высоты. Пункт — значок
 * агента 16, `S02 бэкенд` (600) и мета `Claude Code · idle`: провайдер и слово состояния, а модели и
 * усилия, как в handoff, тут нет — карта их не хранит (решение контролёра куска 6). Клик — на
 * `mousedown` с `preventDefault`, чтобы поле не теряло фокус и курсор.
 */

import { S } from '../../../shared/strings.js';
import { AgentIcon } from '../AgentIcon.js';
import { cn } from '../../lib/cn.js';
import type { ComposerMember } from './Composer.js';

export interface MentionMenuProps {
  items: readonly ComposerMember[];
  selected: number;
  onPick(member: ComposerMember): void;
  onHover(index: number): void;
}

export function MentionMenu({ items, selected, onPick, onHover }: MentionMenuProps): JSX.Element {
  return (
    <div
      role="listbox"
      aria-label={S.rooms.mentionHeading}
      className="absolute bottom-[calc(100%-4px)] left-9 z-5 flex max-h-[260px] w-[min(380px,calc(100%-72px))] flex-col gap-0.5 overflow-y-auto rounded-md bg-neutral-100 p-1.5 text-foreground shadow-lg"
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
          <span className="min-w-0 flex-1 truncate text-xs text-neutral-700">{S.rooms.providerState(member.providerName, member.word)}</span>
        </div>
      ))}
      {items.length === 0 ? <span className="px-2.5 py-2 text-xs text-neutral-700">{S.rooms.mentionEmpty}</span> : null}
    </div>
  );
}
