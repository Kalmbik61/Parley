/**
 * Роли темы (дизайн темы TUI, 3.2 и 4.1): компоненты видят только их и
 * никогда не hex. Роль отдаёт пропсы Ink, а не строку — образец формы,
 * `statusColor` в `glyphs.ts`. Ветвление по уровню цвета живёт здесь и
 * больше нигде: компонент спрашивает роль и получает пропсы, которые на
 * этом уровне имеют смысл, плюс общий флаг `fills` — добивать ли строку.
 */

import type { Palette } from './palettes.js';

/** Пропсы Ink для роли; пустых полей нет — `exactOptionalPropertyTypes`. */
export interface RoleProps {
  color?: string;
  backgroundColor?: string;
  dimColor?: boolean;
}

export interface Theme {
  bg: {
    /** Заливка панели агента и карточки. */
    panel: RoleProps;
    /** Заливка блоков сайдбара. */
    sidebar: RoleProps;
    /** Строка статуса. */
    status: RoleProps;
    /** Оверлеи и диалоги. */
    overlay: RoleProps;
    /** Ячейки PTY без своего фона. */
    agent: RoleProps;
    /** Выбранный ряд во всех списках. */
    selection: RoleProps;
    /** Плашка `new` — фон только под текстом. */
    badge: RoleProps;
  };
  border: {
    /** Рамка активной зоны. */
    active: RoleProps;
    /** Рамка неактивной зоны. */
    idle: RoleProps;
  };
  fg: {
    /** Тело, заголовки и label сессий. */
    default: RoleProps;
    /** Цитата брифа, второй ряд строки. */
    second: RoleProps;
    /** Время, токены, заголовки проектов, `pending`, прочитанные. */
    muted: RoleProps;
    /** Провайдер, заголовки workflow, `▤`. */
    accent: RoleProps;
  };
  status: {
    /** `●` active, `✓` done. */
    live: RoleProps;
    /** `◐` idle, `○` exited, `⚑`, предупреждения. */
    warn: RoleProps;
    /** `✗` failed, ошибки запуска. */
    fail: RoleProps;
  };
  /** Добивать ли строку зоны до ширины блока фоном (5.1). */
  fills: boolean;
}

const EMPTY: RoleProps = {};
const DIM: RoleProps = { dimColor: true };
const fg = (hex: string): RoleProps => ({ color: hex });
const bg = (hex: string): RoleProps => ({ backgroundColor: hex });
const ansiColor = (name: string): RoleProps => ({ color: name });
const ansiBg = (name: string): RoleProps => ({ backgroundColor: name });

/** Уровни 3 и 2 (truecolor, 256 цветов): hex палитры, заливка включена. */
function colorRoles(p: Palette): Theme {
  return {
    bg: {
      panel: bg(p.base),
      sidebar: bg(p.mantle),
      status: bg(p.mantle),
      overlay: bg(p.crust),
      agent: bg(p.base),
      selection: bg(p.surface),
      badge: bg(p.surface),
    },
    border: {
      active: fg(p.cyan),
      idle: fg(p.overlay),
    },
    fg: {
      default: fg(p.text),
      second: fg(p.subtext),
      muted: fg(p.muted),
      accent: fg(p.magenta),
    },
    status: {
      live: fg(p.green),
      warn: fg(p.yellow),
      fail: fg(p.red),
    },
    fills: true,
  };
}

/**
 * Уровень 1 (16 цветов) — ветка `terminal` (3.4): имена ANSI и `dimColor`,
 * заливки нет. Соответствие теми же цветами смысла, что и сегодня у
 * `statusColor`/`selectionProps`/`frameColor` в `glyphs.ts`/`sidebar.tsx`.
 */
function terminalRoles(): Theme {
  return {
    bg: {
      panel: EMPTY,
      sidebar: EMPTY,
      status: EMPTY,
      overlay: EMPTY,
      agent: EMPTY,
      selection: ansiBg('blackBright'),
      badge: ansiBg('blackBright'),
    },
    border: {
      active: ansiColor('cyan'),
      idle: DIM,
    },
    fg: {
      default: EMPTY,
      second: DIM,
      muted: DIM,
      accent: ansiColor('magenta'),
    },
    status: {
      live: ansiColor('green'),
      warn: ansiColor('yellow'),
      fail: ansiColor('red'),
    },
    fills: false,
  };
}

/** Уровень 0 (`NO_COLOR`, не TTY, `TERM=dumb`): пусто — chalk снимет коды. */
function monoRoles(): Theme {
  return {
    bg: {
      panel: EMPTY,
      sidebar: EMPTY,
      status: EMPTY,
      overlay: EMPTY,
      agent: EMPTY,
      selection: EMPTY,
      badge: EMPTY,
    },
    border: {
      active: EMPTY,
      idle: EMPTY,
    },
    fg: {
      default: EMPTY,
      second: EMPTY,
      muted: EMPTY,
      accent: EMPTY,
    },
    status: {
      live: EMPTY,
      warn: EMPTY,
      fail: EMPTY,
    },
    fills: false,
  };
}

/** Роли по палитре и уровню цвета — единственная точка ветвления (4.1). */
export function roles(palette: Palette, level: number): Theme {
  if (level >= 2) return colorRoles(palette);
  if (level === 1) return terminalRoles();
  return monoRoles();
}
