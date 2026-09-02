/**
 * Глифы списка работ и их ASCII-замены (дизайн координации TUI, 6.1).
 *
 * Цвет никогда не единственный носитель смысла: каждый статус различим глифом
 * и в монохромном терминале.
 */

import type { SessionStatus } from '@harnas/core';

export interface Glyphs {
  pending: string;
  active: string;
  idle: string;
  exited: string;
  done: string;
  failed: string;
  /** Непрочитанные сообщения: `✉N`. */
  mail: string;
  expanded: string;
  collapsed: string;
  /** Дочерняя сессия — показывается только на широкой колонке. */
  child: string;
  /** Уведомление в строке статуса. */
  flag: string;
  ellipsis: string;
  /** Линейка в заголовке проекта. */
  rule: string;
}

const UNICODE: Glyphs = {
  pending: '◌',
  active: '●',
  idle: '◐',
  exited: '○',
  done: '✓',
  failed: '✗',
  mail: '✉',
  expanded: '▾',
  collapsed: '▸',
  child: '└',
  flag: '⚑',
  ellipsis: '…',
  rule: '─',
};

const ASCII: Glyphs = {
  pending: '.',
  active: '*',
  idle: '~',
  exited: '!',
  done: '+',
  failed: 'x',
  mail: '@',
  expanded: 'v',
  collapsed: '>',
  child: '`',
  flag: '!',
  ellipsis: '~',
  rule: '-',
};

/** Набор глифов: `HARNAS_ASCII=1` переключает на запасной. */
export function glyphs(env: NodeJS.ProcessEnv = process.env): Glyphs {
  const ascii = env['HARNAS_ASCII'];
  return ascii !== undefined && ascii !== '' && ascii !== '0' ? ASCII : UNICODE;
}

export function statusGlyph(status: SessionStatus, g: Glyphs): string {
  return g[status];
}

/** Пропсы Ink для цвета статуса (таблица 6.2). Пустых не передаём — exactOptionalPropertyTypes. */
export function statusColor(status: SessionStatus): { color?: string; dimColor?: boolean } {
  switch (status) {
    case 'active':
    case 'done':
      return { color: 'green' };
    case 'idle':
    case 'exited':
      return { color: 'yellow' };
    case 'failed':
      return { color: 'red' };
    case 'pending':
      return { dimColor: true };
  }
}
