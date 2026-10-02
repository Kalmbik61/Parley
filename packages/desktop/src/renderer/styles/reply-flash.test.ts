/**
 * Подсветка оригинала цитаты (`reply-flash.css`, Parley 0.3.0): `RoomPanel` ставит `data-reply-flash` на строку
 * сообщения на 1.2 с. Здесь держится сам CSS — селектор, длительность, затухание акцента в прозрачный, правило
 * `prefers-reduced-motion` — и контраст текста на фоне подсветки: порог 4.5:1, как у остального текста окна
 * (`tokens.test.ts`). Атрибут и таймер проверяет `components/rooms/RoomPanel.test.tsx`.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { compositeOver, contrastRatio, type Rgb } from '../test-utils/contrast.js';
import { parseTokens, resolveColor, type Theme } from '../test-utils/css-tokens.js';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const css = readFileSync(path.join(dirname, 'reply-flash.css'), 'utf8');
const tokens = parseTokens(readFileSync(path.join(dirname, 'tokens.css'), 'utf8'));

/** Доля акцента в заливке: `color-mix(in srgb, var(--color-accent) N%, transparent)`. */
const ACCENT_FILL =
  /background-color:\s*color-mix\(in srgb, var\(--color-accent\) (\d+)%, transparent\)/;

const keyframes = /@keyframes reply-flash\s*\{\s*from\s*\{([^}]*)\}\s*to\s*\{([^}]*)\}\s*\}/.exec(
  css,
);
const reducedMotion = /@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*)\}\s*$/.exec(
  css,
)?.[1];
const fillOf = (block: string | undefined): number =>
  Number(ACCENT_FILL.exec(block ?? '')?.[1] ?? Number.NaN);

function solid(theme: Theme, name: string): Rgb {
  const { rgb, alpha } = resolveColor(tokens, theme, name);
  if (alpha !== 1) throw new Error(`${name} (${theme}) прозрачный: alpha ${alpha}`);
  return rgb;
}

describe('reply-flash.css — подсветка оригинала цитаты', () => {
  it('строка сообщения с data-reply-flash — анимация reply-flash на 1200 мс, как в RoomPanel', () => {
    expect(css).toMatch(
      /\[data-message-id\]\[data-reply-flash\]\s*\{[^}]*animation:\s*reply-flash 1200ms/,
    );
  });

  it('фон — акцент, который гаснет до прозрачного; поле в 6px дописывает тень и раскладку не двигает', () => {
    expect(keyframes, '@keyframes reply-flash { from {…} to {…} }').not.toBeNull();
    const [, from, to] = keyframes as RegExpExecArray;
    expect(fillOf(from)).toBeGreaterThan(0);
    expect(to).toMatch(/background-color:\s*transparent/);
    expect(from).toMatch(/box-shadow:\s*0 0 0 6px color-mix/);
    expect(to).toMatch(/box-shadow:\s*0 0 0 6px transparent/);
  });

  it('prefers-reduced-motion: без анимации, фон просто стоит — той же доли акцента', () => {
    expect(reducedMotion, '@media (prefers-reduced-motion: reduce)').toBeDefined();
    expect(reducedMotion).toMatch(/\[data-message-id\]\[data-reply-flash\]/);
    expect(reducedMotion).toMatch(/animation:\s*none/);
    expect(fillOf(reducedMotion)).toBe(fillOf(keyframes?.[1]));
  });

  for (const theme of ['light', 'dark'] as const) {
    it(`${theme}: основной и вторичный текст на подсвеченном фоне (акцент поверх листа центра) — не ниже 4.5:1`, () => {
      const backdrop = compositeOver(
        solid(theme, '--color-accent'),
        fillOf(keyframes?.[1]) / 100,
        solid(theme, '--sheet'),
      );
      for (const name of ['--foreground', '--muted-foreground']) {
        expect(contrastRatio(solid(theme, name), backdrop), name).toBeGreaterThanOrEqual(4.5);
      }
    });
  }
});
