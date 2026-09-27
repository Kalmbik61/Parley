/**
 * Раунд исправлений 1 куска 1.3, находка B№1 (линза B, живой рендер): в
 * светлой теме `--muted-foreground` (`#737373`) даёт 3.94:1 на
 * `--work-sidebar-accent` (`#eaeaea`) при тексте 11px (строки сессий,
 * `WorkList.tsx`/`SessionTree.tsx`/`MetricsLine.tsx`) — 11px не «крупный»
 * текст по WCAG (порог начинается с 18.66px жирным/24px обычным), так что
 * нужные 4.5:1 не снижаются до 3:1. Тест читает значения из самого tokens.css
 * (а не полагается на память о них) и считает контраст по формуле WCAG 2.x,
 * чтобы дефект не вернулся тихо, если кто-то поправит цвет обратно.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { compositeOver, contrastRatio as contrastOf, type Rgb } from '../test-utils/contrast.js';

const TOKENS_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'tokens.css');

/** Значение переменной из светлого блока `:root { … }` — до первого `.dark {`, где те же имена переопределены под тёмную тему. */
function readLightVar(css: string, name: string): string {
  const start = css.indexOf(':root {');
  const end = css.indexOf('.dark {');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('tokens.css: не нашёл границы блоков :root/.dark');
  }
  const lightBlock = css.slice(start, end);
  const match = lightBlock.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6});`));
  if (match === null) throw new Error(`tokens.css: токен --${name} не найден в :root`);
  return match[1] as string;
}

function srgbChannelToLinear(channel255: number): number {
  const c = channel255 / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** Относительная яркость по WCAG 2.x (sRGB, без гаммы дисплея). */
function relativeLuminance(hex: string): number {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return 0.2126 * srgbChannelToLinear(r) + 0.7152 * srgbChannelToLinear(g) + 0.0722 * srgbChannelToLinear(b);
}

/** Контраст WCAG 2.x: (L1+0.05)/(L2+0.05), где L1 — более светлый цвет. */
function contrastRatio(hexA: string, hexB: string): number {
  const [lighter, darker] = [relativeLuminance(hexA), relativeLuminance(hexB)].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}

const WCAG_AA_SMALL_TEXT = 4.5;

describe('tokens.css — контраст --muted-foreground в светлой теме (раунд исправлений 1, находка B№1)', () => {
  const css = readFileSync(TOKENS_PATH, 'utf8');
  const mutedForeground = readLightVar(css, 'muted-foreground');
  const workSidebar = readLightVar(css, 'work-sidebar');
  const workSidebarAccent = readLightVar(css, 'work-sidebar-accent');

  it('на --work-sidebar-accent (самый тёмный фон строки сайдбара) — не ниже 4.5:1', () => {
    expect(contrastRatio(mutedForeground, workSidebarAccent)).toBeGreaterThanOrEqual(WCAG_AA_SMALL_TEXT);
  });

  it('на --work-sidebar — не ниже 4.5:1', () => {
    expect(contrastRatio(mutedForeground, workSidebar)).toBeGreaterThanOrEqual(WCAG_AA_SMALL_TEXT);
  });

  it('на белом (--card/--background/--popover светлой темы) — не ниже 4.5:1', () => {
    expect(contrastRatio(mutedForeground, '#ffffff')).toBeGreaterThanOrEqual(WCAG_AA_SMALL_TEXT);
  });
});

/**
 * Тест 14 куска 3.3: самый тёмный фон сайдбара теперь — активная карточка
 * (`color-mix` 8% `--work-sidebar-foreground`, в тёмной 10%, спека 6.3), а поверх
 * неё — подсветка amber-500/10 строки «ждёт тебя» и «не просмотрено». На ней
 * `--muted-foreground` ниже 4.5:1 (светлая 4.44, тёмная 4.09), поэтому вторичный
 * текст карточек — свой токен `--work-sidebar-muted-foreground`.
 */
describe('tokens.css — вторичный текст карточек сайдбара (кусок 3.3, тест 14)', () => {
  const css = readFileSync(TOKENS_PATH, 'utf8');

  /** Значение `--name` в блоке темы: светлая — `:root { … }` до `.dark {`, тёмная — `.dark { … }`. */
  function readHex(theme: 'light' | 'dark', name: string): Rgb {
    const rootStart = css.indexOf(':root {');
    const darkStart = css.indexOf('.dark {');
    if (rootStart === -1 || darkStart === -1 || darkStart <= rootStart) throw new Error('tokens.css: нет блоков :root/.dark');
    const block = theme === 'light' ? css.slice(rootStart, darkStart) : css.slice(darkStart, css.indexOf('}', darkStart));
    const match = block.match(new RegExp(`--${name}:\\s*#([0-9a-fA-F]{6});`));
    if (match === null) throw new Error(`tokens.css: --${name} не найден (${theme})`);
    const hex = match[1] as string;
    return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
  }

  // amber-500 Tailwind 4 — oklch(76.9% 0.188 70.08), в sRGB ≈ #fe9a00.
  const AMBER_500: Rgb = [254, 154, 0];
  const CARD_MIX = { light: 0.08, dark: 0.1 } as const;

  for (const theme of ['light', 'dark'] as const) {
    const text = readHex(theme, 'work-sidebar-muted-foreground');
    const sidebar = readHex(theme, 'work-sidebar');
    const activeCard = compositeOver(readHex(theme, 'work-sidebar-foreground'), CARD_MIX[theme], sidebar);
    const amberOnCard = compositeOver(AMBER_500, 0.1, activeCard);
    const selectedRow = readHex(theme, 'work-sidebar-accent');

    it(`${theme}: на активной карточке — не ниже 4.5:1`, () => {
      expect(contrastOf(text, activeCard)).toBeGreaterThanOrEqual(WCAG_AA_SMALL_TEXT);
    });

    it(`${theme}: на amber-500/10 поверх активной карточки — не ниже 4.5:1`, () => {
      expect(contrastOf(text, amberOnCard)).toBeGreaterThanOrEqual(WCAG_AA_SMALL_TEXT);
    });

    it(`${theme}: на выбранной строке (--work-sidebar-accent) и на фоне сайдбара — не ниже 4.5:1`, () => {
      expect(contrastOf(text, selectedRow)).toBeGreaterThanOrEqual(WCAG_AA_SMALL_TEXT);
      expect(contrastOf(text, sidebar)).toBeGreaterThanOrEqual(WCAG_AA_SMALL_TEXT);
      expect(contrastOf(text, compositeOver(AMBER_500, 0.1, sidebar))).toBeGreaterThanOrEqual(WCAG_AA_SMALL_TEXT);
    });
  }
});

/**
 * Кусок 3.4, решение контролёра 4: пункты-«разрушители» меню сайдбара (Delete…, Archive)
 * должны читаться и на подсветке фокуса. У прежнего `SessionMenu` фокус красил пункт в
 * `--destructive` с `--destructive-foreground`, а в тёмной это 1.66:1. Поэтому у меню свой
 * токен текста `--menu-destructive`; фон фокуса — общий `--accent` пункта (`ui/glass.ts`).
 */
describe('tokens.css — «разрушители» меню (кусок 3.4, решение 4)', () => {
  const css = readFileSync(TOKENS_PATH, 'utf8');

  function readHex(theme: 'light' | 'dark', name: string): Rgb {
    const rootStart = css.indexOf(':root {');
    const darkStart = css.indexOf('.dark {');
    const block = theme === 'light' ? css.slice(rootStart, darkStart) : css.slice(darkStart, css.indexOf('}', darkStart));
    const match = block.match(new RegExp(`--${name}:\\s*#([0-9a-fA-F]{6});`));
    if (match === null) throw new Error(`tokens.css: --${name} не найден (${theme})`);
    const hex = match[1] as string;
    return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
  }

  // «Стекло» меню (`ui/glass.ts`): светлая — white/82%, тёмная — black/72% поверх того, что под меню.
  const GLASS = { light: { color: [255, 255, 255] as Rgb, alpha: 0.82 }, dark: { color: [0, 0, 0] as Rgb, alpha: 0.72 } } as const;

  for (const theme of ['light', 'dark'] as const) {
    const text = readHex(theme, 'menu-destructive');
    it(`${theme}: на подсветке фокуса (--accent) — не ниже 4.5:1`, () => {
      expect(contrastOf(text, readHex(theme, 'accent'))).toBeGreaterThanOrEqual(WCAG_AA_SMALL_TEXT);
    });
    it(`${theme}: на стекле поверх сайдбара и центра (--editor-surface) — не ниже 4.5:1`, () => {
      for (const under of ['work-sidebar', 'editor-surface']) {
        const glass = compositeOver(GLASS[theme].color, GLASS[theme].alpha, readHex(theme, under));
        expect(contrastOf(text, glass)).toBeGreaterThanOrEqual(WCAG_AA_SMALL_TEXT);
      }
    });
  }
});
