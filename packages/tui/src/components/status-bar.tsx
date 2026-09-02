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
}

/** Короткая шпаргалка режима: режим переключается `w`, из терминала выходит Ctrl+Q. */
const TAIL = 'w · Ctrl+Q';

/**
 * Строка статуса — единственный канал уведомлений (дизайн координации TUI, 5).
 * Живёт вне рамок, на всю ширину терминала, в обоих режимах левой колонки.
 */
export function StatusBar({ count, event, width }: StatusBarProps): ReactNode {
  const g = glyphs();
  const room = Math.max(0, width - TAIL.length - 2);
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
            <Text color="yellow" bold>
              {left.slice(0, flag.length)}
            </Text>
            {left.slice(flag.length)}
          </>
        )}
      </Text>
      <Text dimColor>{TAIL}</Text>
    </Box>
  );
}
