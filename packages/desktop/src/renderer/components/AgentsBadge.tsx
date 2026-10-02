/**
 * Бейдж агентов с поповером (план 2026-10-01, решение 13, кусок 4b): «2 agents» в строке сессии сайдбара и своя
 * подпись — строка «Subagent: …» — на карточке участника комнаты. Источник — `metrics.tasks` из `activity.changed`.
 * Поповер — по строке на агента: тип, описание и пометка `background`; клик по строке зовёт `onOpen` (владелец открывает
 * сессию на карточке агента) и закрывает поповер. Длинное описание переносится и обрезается тремя строками (целиком — в
 * подсказке строки), а список при нехватке места в окне прокручивается: поповер не выше свободной высоты.
 *
 * Вид бейджа задаёт владелец (`className`): в строке сессии это пилюля, на карточке участника — строка текста. Бейдж стоит
 * внутри кликабельных строк, поэтому его клик и Enter/пробел дальше не идут, а нажатие мыши внутри поповера не доходит до
 * перетаскивания строки: поповер живёт в портале, но события React всплывают по дереву компонентов.
 */

import { useState, type RefObject } from 'react';
import type { LiveTask } from '@parley/protocol';
import { S } from '../../shared/strings.js';
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from '../ui/popover.js';

export interface AgentsBadgeProps {
  tasks: readonly LiveTask[];
  /** Клик по строке поповера: открыть карточку этого агента в ленте его сессии. */
  onOpen: (task: LiveTask) => void;
  /** Подпись бейджа; по умолчанию «N agents». */
  label?: string;
  /** Подсказка бейджа (`title`). */
  title?: string;
  className?: string;
  /** С какой стороны открывается поповер: сайдбар — справа, шапка комнаты — снизу (по умолчанию). */
  side?: 'bottom' | 'right';
  /** Элемент, от которого отсчитывается положение поповера, вместо самого бейджа: строка сессии — вся строка, а не её середина. */
  anchor?: RefObject<HTMLElement>;
  /** Место в порядке Tab; нет — обычное. Строка сайдбара ведёт Tab курсором (roving tabindex): бейдж вне курсора — `-1`. */
  tabIndex?: number;
  /** Поповер открылся или закрылся: строка сессии на это время прячет свой тултип. */
  onOpenChange?: (open: boolean) => void;
}

export function AgentsBadge({ tasks, onOpen, label, title, className, side = 'bottom', anchor, tabIndex, onOpenChange }: AgentsBadgeProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const change = (next: boolean): void => {
    setOpen(next);
    onOpenChange?.(next);
  };
  return (
    <Popover open={open} onOpenChange={change}>
      {anchor === undefined ? null : <PopoverAnchor virtualRef={anchor} />}
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="agents-badge"
          {...(title === undefined ? {} : { title })}
          {...(className === undefined ? {} : { className })}
          {...(tabIndex === undefined ? {} : { tabIndex })}
          // Строка-владелец открывает сессию по клику и по Enter/пробелу — бейдж открывает свой поповер. Стрелки и прочие
          // клавиши идут дальше: по ним сайдбар ходит по строкам.
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') event.stopPropagation();
          }}
        >
          {label ?? S.chat.agent.count(tasks.length)}
        </button>
      </PopoverTrigger>
      <PopoverContent
        data-testid="agents-popover"
        aria-label={S.chat.agent.list}
        side={side}
        align="start"
        collisionPadding={8}
        onPointerDown={(event) => event.stopPropagation()}
        className="w-72 p-1"
      >
        <div className="flex max-h-[min(20rem,var(--radix-popover-content-available-height))] flex-col gap-0.5 overflow-y-auto">
          {tasks.map((task) => {
            const kind = task.agentType ?? S.chat.agent.fallbackTitle;
            return (
              <button
                key={task.id}
                type="button"
                data-testid="agents-popover-row"
                aria-label={S.chat.agent.open(kind)}
                {...(task.description === null ? {} : { title: task.description })}
                onClick={() => {
                  change(false);
                  onOpen(task);
                }}
                className="flex w-full min-w-0 flex-col gap-0.5 rounded-sm px-2 py-1.5 text-left text-xs hover:bg-foreground/7"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <span className="min-w-0 flex-1 truncate font-semibold">{kind}</span>
                  {task.background ? <span className="shrink-0 text-[10px] text-muted-foreground">{S.chat.agent.background}</span> : null}
                </span>
                {task.description === null ? null : (
                  <span className="line-clamp-3 break-words text-muted-foreground">{task.description}</span>
                )}
              </button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
