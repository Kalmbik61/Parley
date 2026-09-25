/**
 * Пять встроенных палитр темы TUI (дизайн темы TUI, 3.1 и 3.3): четырнадцать
 * именованных цветов плюс пометка светлая/тёмная — единственное, что своё у
 * каждой темы. Имена слотов — Catppuccin, на них ложатся и Nord, и Gruvbox, и
 * Tokyo Night.
 */

export interface Palette {
  kind: 'dark' | 'light';
  /** Фон панели агента и карточки. */
  base: string;
  /** Фон сайдбара и строки статуса — на тон в сторону от `base`. */
  mantle: string;
  /** Фон оверлеев — дальше всех от текста. */
  crust: string;
  /** Слот исходной палитры; выбранный ряд ушёл в `selection`, ролью не занят. */
  surface: string;
  /**
   * Выбранный ряд во всех списках: `cyan` палитры, смешанный с `mantle`.
   * Прежний серый `surface` отличался от фона сайдбара на 1.4:1 и глазом не
   * читался; оттенок акцента заметен и сменой тона. Доля `cyan` — наибольшая,
   * при которой проходит тест контраста выбранного ряда (`contrast.test.ts`).
   */
  selection: string;
  /** Рамка неактивной зоны. */
  overlay: string;
  /** Тело. */
  text: string;
  /** Второстепенное. */
  subtext: string;
  /** Мета: время, токены, заголовки проектов, `pending`. */
  muted: string;
  red: string;
  green: string;
  yellow: string;
  /** Про запас: сегодня не занят ни одной ролью (дизайн 3.2). */
  blue: string;
  magenta: string;
  cyan: string;
}

export type PaletteName = 'mocha' | 'latte' | 'gruvbox' | 'nord' | 'tokyo-night';

/**
 * Значения — таблица 3.3 дизайна дословно, кроме нескольких слотов в двух
 * палитрах: mocha, gruvbox и tokyo-night проходят тест на контраст (7.2,
 * приёмка A) целиком как есть. Правило: `fg.default`/`fg.second` — не ниже
 * 4.5:1 против `base`/`mantle`/`crust`; `fg.muted` — мета, не тело текста,
 * поэтому не ниже 3:1 против всех трёх; акценты и статусы — не ниже 3:1
 * против всех трёх. Против `selection`: `fg.default` не ниже 4.5:1,
 * `fg.second` не ниже 3:1 (мета выбранного ряда рисуется им, а не
 * `fg.muted`), акценты и статусы не ниже 3:1, кроме `red` — ему 2:1: `✗`
 * читается формой, а не только цветом. Плюс инвариант
 * ступеней: `text`→`subtext`→`muted` не ниже 1.2:1 на каждом шаге. При
 * провале правится яркость слота (HSL `l`, тон и насыщенность не трогаются),
 * минимальным сдвигом до прохода:
 *
 * - `nord`: `muted` `#7b88a1` → `#808da5` (3:1 не проходил против `surface`,
 *   2.82), `red` `#bf616a` → `#c7757c` (3:1 не проходил против `surface`,
 *   2.46), `subtext` `#d8dee9` → `#d5dbe7` (ступень `text`/`subtext` не
 *   проходила 1.2:1, было 1.17 — `subtext` сдвинут темнее, `text` не тронут);
 * - `latte`: `subtext` `#6c6f85` → `#606276` (4.5:1 не проходил против
 *   `base`/`mantle`/`crust`, до 4.37), `muted` `#8c8fa1` → `#707389`, `green`
 *   `#40a02b` → `#358524`, `yellow` `#df8e1d` → `#a36715`, `cyan` `#04a5e5` →
 *   `#037cac` (3:1 не проходили против всех четырёх фонов — светлая тема,
 *   сдвиг темнее). Ступени `text`→`subtext`→`muted` после правки не слиты:
 *   1.33 и 1.28.
 */
export const PALETTES: Record<PaletteName, Palette> = {
  mocha: {
    kind: 'dark',
    base: '#1e1e2e',
    mantle: '#181825',
    crust: '#11111b',
    surface: '#313244',
    selection: '#415f6c',
    overlay: '#6c7086',
    text: '#cdd6f4',
    subtext: '#a6adc8',
    muted: '#7f849c',
    red: '#f38ba8',
    green: '#a6e3a1',
    yellow: '#f9e2af',
    blue: '#89b4fa',
    magenta: '#cba6f7',
    cyan: '#89dceb',
  },
  latte: {
    kind: 'light',
    base: '#eff1f5',
    mantle: '#e6e9ef',
    crust: '#dce0e8',
    surface: '#ccd0da',
    selection: '#bbd4e2',
    overlay: '#9ca0b0',
    text: '#4c4f69',
    subtext: '#606276',
    muted: '#707389',
    red: '#d20f39',
    green: '#358524',
    yellow: '#a36715',
    blue: '#1e66f5',
    magenta: '#8839ef',
    cyan: '#037cac',
  },
  gruvbox: {
    kind: 'dark',
    base: '#282828',
    mantle: '#1d2021',
    crust: '#181818',
    surface: '#3c3836',
    selection: '#41533e',
    overlay: '#504945',
    text: '#ebdbb2',
    subtext: '#d5c4a1',
    muted: '#928374',
    red: '#fb4934',
    green: '#b8bb26',
    yellow: '#fabd2f',
    blue: '#83a598',
    magenta: '#d3869b',
    cyan: '#8ec07c',
  },
  nord: {
    kind: 'dark',
    base: '#2e3440',
    mantle: '#272c36',
    crust: '#21252e',
    surface: '#3b4252',
    selection: '#3d4e59',
    overlay: '#4c566a',
    text: '#eceff4',
    subtext: '#d5dbe7',
    muted: '#808da5',
    red: '#c7757c',
    green: '#a3be8c',
    yellow: '#ebcb8b',
    blue: '#81a1c1',
    magenta: '#b48ead',
    cyan: '#88c0d0',
  },
  'tokyo-night': {
    kind: 'dark',
    base: '#1a1b26',
    mantle: '#16161e',
    crust: '#101014',
    surface: '#292e42',
    selection: '#3a576d',
    overlay: '#414868',
    text: '#c0caf5',
    subtext: '#a9b1d6',
    muted: '#7a82ab',
    red: '#f7768e',
    green: '#9ece6a',
    yellow: '#e0af68',
    blue: '#7aa2f7',
    magenta: '#bb9af7',
    cyan: '#7dcfff',
  },
};
