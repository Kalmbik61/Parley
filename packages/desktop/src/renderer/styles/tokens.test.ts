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
