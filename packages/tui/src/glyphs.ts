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
  exited: string;
  done: string;
  failed: string;
  /**
   * Вторая фаза мигания `working` (макеты TUI v2, §6): точка чередуется с ним
   * раз в секунду. От `exited` отличается словом справа и самим миганием.
   */
  blink: string;
  /** Живые субагенты в компактной строке: `⋮N` (макеты §6). */
  subagent: string;
  /** Разделитель сайдбара и панели (макеты §6). */
  divider: string;
  /** Непрочитанные сообщения: `▤N`. */
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
  /** Грани рамок зон (план рамок, задача 1); в ASCII-наборе — `+-|`. */
  frame: {
    topLeft: string;
    topRight: string;
    bottomLeft: string;
    bottomRight: string;
    horizontal: string;
    vertical: string;
  };
}

const UNICODE: Glyphs = {
  pending: '◌',
  active: '●',
  exited: '○',
  done: '✓',
  failed: '✗',
  blink: '○',
  subagent: '⋮',
  divider: '│',
  mail: '▤',
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
  frame: {
    topLeft: '╭',
    topRight: '╮',
    bottomLeft: '╰',
    bottomRight: '╯',
    horizontal: '─',
    vertical: '│',
  },
};

const ASCII: Glyphs = {
  pending: '.',
  active: '*',
  exited: '!',
  done: '+',
  failed: 'x',
  blink: 'o',
  subagent: ':',
  divider: '|',
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
  frame: {
    topLeft: '+',
    topRight: '+',
    bottomLeft: '+',
    bottomRight: '+',
    horizontal: '-',
    vertical: '|',
  },
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

/**
 * `config.ascii` из настроек: их читает один загрузчик в core, туда же сведён и
 * `HARNAS_ASCII` (раздел 3.4). До первого чтения набор выбирает одна локаль.
 */
let configured = false;

/** Настройки прочитаны: дальше запасной набор включают они (раздел 7). */
export function applyGlyphsConfig(ascii: boolean): void {
  configured = ascii;
}

/** Набор глифов: запасной включают настройки или терминал без Unicode (6.1). */
export function glyphs(env: NodeJS.ProcessEnv = process.env): Glyphs {
  return configured || !unicodeLocale(env) ? ASCII : UNICODE;
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
    case 'exited':
      return { color: 'yellow' };
    case 'failed':
      return { color: 'red' };
    case 'pending':
      return { dimColor: true };
  }
}
