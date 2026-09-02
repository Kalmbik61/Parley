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
  /** Токены: вход и выход в панели ДЕТАЛИ (6.1). */
  up: string;
  down: string;
  /** Кэш чтения и записи там же. */
  cache: string;
  /**
   * Стрелка цепочки ИСТОРИЯ (макет 2.2). В таблице 6.1 её нет — запасной вид
   * взят по тому же правилу, что и у остальных глифов.
   */
  arrow: string;
  /** Цитата в диалоге запуска: первые строки брифа (макет 4.3). */
  quote: string;
  /** Запасной набор: подсветка выбора в нём — reverse video (6.1). */
  ascii: boolean;
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
  up: '↑',
  down: '↓',
  cache: '⇄',
  arrow: '→',
  quote: '▏',
  ascii: false,
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
  up: 'i',
  down: 'o',
  cache: 'c',
  arrow: '->',
  quote: '|',
  ascii: true,
};

/**
 * Терминал без Unicode: локаль задана и она не UTF-8 (`LC_ALL`, `LC_CTYPE`, `LANG`).
 * Когда о локали не сказано ничего, считаем терминал юникодным — иначе запасной
 * набор включался бы там, где Unicode прекрасно работает.
 */
function unicodeLocale(env: NodeJS.ProcessEnv): boolean {
  const locale = env['LC_ALL'] ?? env['LC_CTYPE'] ?? env['LANG'];
  if (locale === undefined || locale === '') return true;
  return /utf-?8/i.test(locale);
}

/** Набор глифов: запасной включает `HARNAS_ASCII=1` или терминал без Unicode (6.1). */
export function glyphs(env: NodeJS.ProcessEnv = process.env): Glyphs {
  const ascii = env['HARNAS_ASCII'];
  if (ascii !== undefined && ascii !== '' && ascii !== '0') return ASCII;
  return unicodeLocale(env) ? UNICODE : ASCII;
}

/**
 * Подсветка выбранного ряда — общая для всех списков и режимов (дизайн 6.2):
 * фон bright black, а в запасном наборе reverse video (6.1). Текст не меняется.
 */
export function selectionProps(
  selected: boolean,
  g: Glyphs,
): { backgroundColor?: string; inverse?: boolean } {
  if (!selected) return {};
  return g.ascii ? { inverse: true } : { backgroundColor: 'blackBright' };
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
