import { Box, Text } from 'ink';
import type { ReactNode } from 'react';
import { truncate } from '../format.js';
import { glyphs } from '../glyphs.js';
import type { StatusEvent } from '../use-status.js';

export interface StatusBarProps {
  /** Непросмотренные события: число рядом с флажком (дизайн 5). */
  count: number;
  event: Pick<StatusEvent, 'text' | 'hint'> | null;
  width: number;
  /** Имя префикса в подсказке и в списке действий (дизайн TUI v2, 3.1). */
  prefix: string;
  /** Нажат префикс, ждём вторую клавишу: вместо события — список действий (§3). */
  awaiting?: boolean;
}

/**
 * Действия префикса в порядке макета §3. Отбрасываются с конца, пока строка не
 * влезет; `? все` не отбрасывается никогда.
 */
const ACTIONS: readonly string[] = [
  'c новая',
  'w работы',
  'g история',
  'i детали',
  's сайдбар',
  'j/k сессии',
  'x закрыть',
  'r возобновить',
];
const HELP = '? все';

/** Список действий по ширине: с конца, пока влезает (макеты §3). */
export function prefixHint(prefix: string, width: number): string {
  const head = ` ${prefix} … `;
  const room = Math.max(0, width - head.length);
  for (let count = ACTIONS.length; count > 0; count--) {
    const line = [...ACTIONS.slice(0, count), HELP].join(' · ');
    if (line.length <= room) return `${head}${line}`;
  }
  return `${head}${HELP}`;
}

/**
 * Строка статуса — единственный канал уведомлений (дизайн координации TUI, 5).
 * Живёт вне сетки сайдбара, на всю ширину терминала. Четыре состояния макетов
 * §3: пустое, событие `⚑`, ожидание второй клавиши префикса и предупреждение
 * (оно приходит обычным событием).
 */
export function StatusBar({
  count,
  event,
  width,
  prefix,
  awaiting = false,
}: StatusBarProps): ReactNode {
  const g = glyphs();
  const tail = `${prefix} ?`;

  // Пока ждём вторую клавишу, справа ничего нет: подсказка занимает всю строку.
  if (awaiting) {
    return (
      <Box width={width}>
        <Text wrap="truncate">{prefixHint(prefix, width)}</Text>
      </Box>
    );
  }

  // Строка события начинается с пробела, как в макете; хвост стоит у правого
  // края, между ними остаётся зазор (макеты §3).
  const room = Math.max(0, width - tail.length - 3);
  const flag = count > 1 ? `${g.flag}${count}` : g.flag;
  const head = event === null ? '' : `${flag} ${event.text}`;
  const hint = event === null || event.hint === undefined ? '' : ` · ${event.hint}`;
  const left = truncate(`${head}${hint}`, room, g.ellipsis);

  return (
    <Box width={width} justifyContent="space-between">
      <Text wrap="truncate">
        {event === null ? (
          ''
        ) : (
          <>
            {' '}
            <Text color="yellow" bold>
              {left.slice(0, flag.length)}
            </Text>
            {left.slice(flag.length)}
          </>
        )}
      </Text>
      <Text dimColor>{tail}</Text>
    </Box>
  );
}
