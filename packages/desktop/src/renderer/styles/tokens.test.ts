/**
 * Токены Organic (кусок 1 плана «Organic», спека окна 2026-09-29, раздел 4).
 *
 * Переменные shadcn выражены через палитру — `var()` и `color-mix()`, — а не держат hex, поэтому
 * тест разворачивает их сам (`test-utils/css-tokens.ts`) так же, как браузер: палитра одна, в CSS,
 * без второй копии в тестах. Контраст — по формуле WCAG 2.x, прозрачные заливки (`text 9%`,
 * `text 4%`) кладутся на свой фон и округляются до пикселя. Пороги: вторичный текст — 4.5:1 в обеих
 * темах, признак состояния (заливка выбранного, кольцо фокуса, разделитель) — 3:1.
 *
 * Что здесь держится:
 *  1. палитра и тени — дословно по разделу 4 спеки (сам блок читается из спеки);
 *  2. переменные shadcn — строка в строку по таблице раздела 4 и по решениям 1 и 2;
 *  3. контраст пар из брифа куска: `neutral-700` на всех фонах, главная кнопка, hover карточки;
 *  4. прежние имена (`--status-warning-text`, `--agent-question`, `--work-sidebar*`…) живы —
 *     значения новые, имена прежние — и ссылки в коде ни на одну пропавшую переменную не смотрят;
 *  5. правило приглушения `dimmed.css` — текст цветом, значки прозрачностью — на новых токенах.
 */

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { compositeOver, contrastRatio, type Rgb } from '../test-utils/contrast.js';
import {
  colorOver,
  parseThemeInline,
  parseTokens,
  rawValue,
  resolveColor,
  substituted,
  type Theme,
} from '../test-utils/css-tokens.js';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const css = readFileSync(path.join(dirname, 'tokens.css'), 'utf8');
const dimmedCss = readFileSync(path.join(dirname, 'dimmed.css'), 'utf8');
const tokens = parseTokens(css);
const THEMES: readonly Theme[] = ['light', 'dark'];

const TEXT = 4.5;
const NON_TEXT = 3;

/** Сплошной цвет токена; прозрачный — ошибка: его контраст зависит от фона и считается через `on`. */
function solid(theme: Theme, name: string): Rgb {
  const { rgb, alpha } = resolveColor(tokens, theme, name);
  if (alpha !== 1) throw new Error(`${name} (${theme}) прозрачный: alpha ${alpha}`);
  return rgb;
}

/** Токен поверх сплошного фона `backdrop`. */
const on = (theme: Theme, name: string, backdrop: Rgb): Rgb => colorOver(tokens, theme, name, backdrop);

const same = (theme: Theme, a: string, b: string): void =>
  expect(resolveColor(tokens, theme, a), `${a} = ${b} (${theme})`).toEqual(resolveColor(tokens, theme, b));

/**
 * Фоны, на которых стоит вторичный текст окна (спека 4: замеры в конце таблицы shadcn). Функции, а
 * не готовые цвета: пропавший токен роняет один тест с его именем, а не весь файл при сборе.
 */
const TEXT_BACKGROUNDS: Record<string, (theme: Theme) => Rgb> = {
  'фон окна (--background)': (theme) => solid(theme, '--background'),
  'активная карточка, вкладка, меню (--card)': (theme) => solid(theme, '--card'),
  'лист центра (--sheet)': (theme) => solid(theme, '--sheet'),
  'заливка --secondary и --muted': (theme) => solid(theme, '--secondary'),
  'выбранная строка активной карточки (--card + --accent)': (theme) => on(theme, '--accent', solid(theme, '--card')),
  'hover неактивной карточки (--background + --card-hover)': (theme) => on(theme, '--card-hover', solid(theme, '--background')),
  'подкраска blocked (accent-200)': (theme) => solid(theme, '--color-accent-200'),
  'подкраска unseen (accent-2-200)': (theme) => solid(theme, '--color-accent-2-200'),
};

// ── 1. Спека: палитра и тени дословно ────────────────────────────────────────────────────────

describe('палитра Organic — раздел 4 спеки дословно', () => {
  const spec = readFileSync(
    path.resolve(dirname, '../../../../../docs/specs/2026-09-29-desktop-rooms-organic-design.md'),
    'utf8',
  );
  const section = spec.slice(spec.indexOf('## 4. Токены'), spec.indexOf('## 5. Ассеты'));
  const block = /```css\n([\s\S]*?)```/.exec(section)?.[1];
  const fromSpec = parseTokens(block ?? '');

  it('в спеке нашёлся блок :root/.dark: по 38 переменных — 6 базовых, 27 ступеней рамп, 3 тени, --sheet и --scrim', () => {
    expect(fromSpec.light.size).toBeGreaterThanOrEqual(38);
    expect(fromSpec.darkOverrides.size).toBeGreaterThanOrEqual(38);
  });

  it('каждая переменная светлой темы из спеки совпадает с tokens.css', () => {
    for (const [name, value] of fromSpec.light) expect(rawValue(tokens, 'light', name), name).toBe(value);
  });

  it('каждая переменная тёмной темы из спеки совпадает с tokens.css', () => {
    for (const [name, value] of fromSpec.darkOverrides) expect(rawValue(tokens, 'dark', name), name).toBe(value);
  });
});

// ── 2. Переменные shadcn через палитру ───────────────────────────────────────────────────────

describe('переменные shadcn — таблица раздела 4 спеки', () => {
  for (const theme of THEMES) {
    it(`${theme}: фон, текст, карточки, вторичные, рамки, кольцо`, () => {
      same(theme, '--background', '--color-surface');
      same(theme, '--foreground', '--color-text');
      same(theme, '--card', '--color-neutral-100');
      same(theme, '--popover', '--color-neutral-100');
      same(theme, '--card-foreground', '--color-text');
      same(theme, '--popover-foreground', '--color-text');
      same(theme, '--secondary', '--color-neutral-200');
      same(theme, '--muted', '--color-neutral-200');
      same(theme, '--muted-foreground', '--color-neutral-700');
      same(theme, '--destructive', '--color-accent-700');
      same(theme, '--border', '--color-divider');
      same(theme, '--input', '--color-divider');
    });

    it(`${theme}: --accent — выбранная строка, text 9 % (не терракотовый accent палитры)`, () => {
      const accent = resolveColor(tokens, theme, '--accent');
      expect(accent.rgb).toEqual(resolveColor(tokens, theme, '--color-text').rgb);
      expect(accent.alpha).toBeCloseTo(0.09, 10);
      same(theme, '--accent-foreground', '--color-text');
    });

    it(`${theme}: сайдбары без своего фона, выбранная строка — text 9 %`, () => {
      same(theme, '--work-sidebar', '--color-surface');
      same(theme, '--sidebar', '--color-surface');
      same(theme, '--work-sidebar-accent', '--accent');
    });

    it(`${theme}: --agent-question — accent-600, --status-success — accent-2-600`, () => {
      same(theme, '--agent-question', '--color-accent-600');
      same(theme, '--status-success', '--color-accent-2-600');
    });
  }

  it('--radius — 16px', () => {
    expect(rawValue(tokens, 'light', '--radius')).toBe('16px');
  });

  it('радиусы: sm 8, md 16, lg 28, диалоги и карточки 32 (раздел 4)', () => {
    const theme = parseThemeInline(css);
    expect(theme.get('--radius-sm')).toBe('8px');
    expect(theme.get('--radius-md')).toBe('16px');
    expect(theme.get('--radius-lg')).toBe('28px');
    expect(theme.get('--radius-xl')).toBe('32px');
  });
});

/**
 * Кольцо фокуса — признак состояния, порог 3:1 (WCAG 1.4.11). Чистый `accent` (таблица спеки) к фону
 * окна в светлой теме — 2.69:1, поэтому светлая берёт `accent-600` (3.35:1 к фону окна, 4.10 к
 * карточке и листу); тёмная — `accent`, как в таблице (6.07:1). Кольцо рисуется снаружи элемента
 * (`outline-offset: 2px`, `ring-1`) или на самой вкладке (вспышка `attention-flash.css`), то есть на
 * фоне окна, карточки, листа или подкраски blocked / unseen.
 */
describe('кольцо фокуса --ring — признак состояния, не ниже 3:1', () => {
  it('тёмная — accent (таблица спеки), светлая — accent-600', () => {
    same('dark', '--ring', '--color-accent');
    same('light', '--ring', '--color-accent-600');
  });

  for (const theme of THEMES) {
    it(`${theme}: --ring к фону окна, карточке, листу и подкраскам blocked и unseen — не ниже 3:1`, () => {
      const ring = solid(theme, '--ring');
      const unders = {
        'фон окна': solid(theme, '--background'),
        карточка: solid(theme, '--card'),
        лист: solid(theme, '--sheet'),
        blocked: solid(theme, '--color-accent-200'),
        unseen: solid(theme, '--color-accent-2-200'),
      };
      for (const [name, under] of Object.entries(unders)) {
        expect(contrastRatio(ring, under), name).toBeGreaterThanOrEqual(NON_TEXT);
      }
    });

    it(`${theme}: рамка переименования в сайдбаре (--work-sidebar-ring) — то же кольцо, что --ring`, () => {
      same(theme, '--work-sidebar-ring', '--ring');
    });
  }
});

describe('решение 1: главная кнопка', () => {
  it('светлая: фон accent-700, hover accent-800, active accent-900, текст bg', () => {
    same('light', '--primary', '--color-accent-700');
    same('light', '--primary-hover', '--color-accent-800');
    same('light', '--primary-active', '--color-accent-900');
    same('light', '--primary-foreground', '--color-bg');
  });

  it('тёмная: фон accent, hover accent-600, active accent-700, текст bg', () => {
    same('dark', '--primary', '--color-accent');
    same('dark', '--primary-hover', '--color-accent-600');
    same('dark', '--primary-active', '--color-accent-700');
    same('dark', '--primary-foreground', '--color-bg');
  });

  for (const theme of THEMES) {
    it(`${theme}: текст на главной кнопке во всех состояниях — не ниже 4.5:1`, () => {
      const text = solid(theme, '--primary-foreground');
      for (const fill of ['--primary', '--primary-hover', '--primary-active']) {
        expect(contrastRatio(text, solid(theme, fill)), fill).toBeGreaterThanOrEqual(TEXT);
      }
    });

    it(`${theme}: destructive-кнопка — текст на заливке и на её hover (90 %) не ниже 4.5:1`, () => {
      const text = solid(theme, '--destructive-foreground');
      expect(contrastRatio(text, solid(theme, '--destructive'))).toBeGreaterThanOrEqual(TEXT);
      // `hover:bg-destructive/90` — 90 % заливки поверх фона окна.
      const hover = compositeOver(solid(theme, '--destructive'), 0.9, solid(theme, '--background'));
      expect(contrastRatio(text, hover)).toBeGreaterThanOrEqual(TEXT);
    });

    it(`${theme}: заливка выбранного пункта сегмента (--primary) — признак состояния, не ниже 3:1 к фону окна и карточки`, () => {
      const fill = solid(theme, '--primary');
      expect(contrastRatio(fill, solid(theme, '--background'))).toBeGreaterThanOrEqual(NON_TEXT);
      expect(contrastRatio(fill, solid(theme, '--card'))).toBeGreaterThanOrEqual(NON_TEXT);
    });
  }
});

describe('решение 2: hover неактивной карточки', () => {
  it('--card-hover — text 4 %: на 5 % neutral-700 на surface 4.47:1, ниже порога 4.5, на 4 % — 4.56:1', () => {
    for (const theme of THEMES) {
      const hover = resolveColor(tokens, theme, '--card-hover');
      expect(hover.rgb).toEqual(resolveColor(tokens, theme, '--color-text').rgb);
      expect(hover.alpha).toBeCloseTo(0.04, 10);
    }
  });

  it('hover заметнее фона окна, но слабее выбранной строки (text 9 %)', () => {
    for (const theme of THEMES) {
      expect(resolveColor(tokens, theme, '--card-hover').alpha).toBeLessThan(resolveColor(tokens, theme, '--accent').alpha);
    }
  });
});

// ── 3. Контраст вторичного текста ────────────────────────────────────────────────────────────

describe('вторичный текст — не ниже 4.5:1 в обеих темах (замеры спеки, раздел 4)', () => {
  for (const theme of THEMES) {
    for (const [background, backdrop] of Object.entries(TEXT_BACKGROUNDS)) {
      it(`${theme}: --muted-foreground (neutral-700) на «${background}»`, () => {
        expect(contrastRatio(solid(theme, '--muted-foreground'), backdrop(theme))).toBeGreaterThanOrEqual(TEXT);
      });

      it(`${theme}: --work-sidebar-muted-foreground (текст приглушённых карточек) на «${background}»`, () => {
        expect(contrastRatio(solid(theme, '--work-sidebar-muted-foreground'), backdrop(theme))).toBeGreaterThanOrEqual(TEXT);
      });
    }

    it(`${theme}: основной текст на фоне окна, карточке и листе — не ниже 4.5:1`, () => {
      for (const under of ['--background', '--card', '--sheet']) {
        expect(contrastRatio(solid(theme, '--foreground'), solid(theme, under)), under).toBeGreaterThanOrEqual(TEXT);
      }
    });
  }
});

// ── Пары, на которых стоят примитивы `ui/*` ─────────────────────────────────────────────────

describe('примитивы Organic — текст на своём фоне не ниже 4.5:1', () => {
  for (const theme of THEMES) {
    it(`${theme}: теги — текст 800 на фоне 100 каждого вида (accent, accent-2, neutral)`, () => {
      for (const ramp of ['accent', 'accent-2', 'neutral']) {
        expect(
          contrastRatio(solid(theme, `--color-${ramp}-800`), solid(theme, `--color-${ramp}-100`)),
          `тег ${ramp}`,
        ).toBeGreaterThanOrEqual(TEXT);
      }
    });

    it(`${theme}: kicker карточки (accent-700) на фоне карточки Organic (surface) и на листе`, () => {
      const kicker = solid(theme, '--color-accent-700');
      expect(contrastRatio(kicker, solid(theme, '--background'))).toBeGreaterThanOrEqual(TEXT);
      expect(contrastRatio(kicker, solid(theme, '--sheet'))).toBeGreaterThanOrEqual(TEXT);
    });

    it(`${theme}: placeholder полей (--muted-foreground) на фоне поля (surface) не ниже 4.5:1`, () => {
      expect(contrastRatio(solid(theme, '--muted-foreground'), solid(theme, '--background'))).toBeGreaterThanOrEqual(TEXT);
    });
  }

  it('затемнение под диалогами — токен --scrim: в светлой 50 % neutral-900, в тёмной чёрное 60 %', () => {
    expect(resolveColor(tokens, 'light', '--scrim')).toEqual({ rgb: resolveColor(tokens, 'light', '--color-neutral-900').rgb, alpha: 0.5 });
    expect(resolveColor(tokens, 'dark', '--scrim')).toEqual({ rgb: [0, 0, 0], alpha: 0.6 });
  });
});

// ── 4. Прежние имена, новые значения ────────────────────────────────────────────────────────

describe('прежние переменные — значения на токенах Organic', () => {
  for (const theme of THEMES) {
    it(`${theme}: предупреждение — accent-700; текст предупреждения на --card, --background, --sidebar, --editor-surface не ниже 4.5:1`, () => {
      same(theme, '--status-warning', '--color-accent-700');
      same(theme, '--status-warning-text', '--color-accent-700');
      const text = solid(theme, '--status-warning-text');
      for (const under of ['--card', '--background', '--sidebar', '--editor-surface']) {
        expect(contrastRatio(text, solid(theme, under)), under).toBeGreaterThanOrEqual(TEXT);
      }
    });

    // Ревью куска 1: `--status-success` (accent-2-600) — заливка и значок, а цветом текста (счётчики
    // «+N» в трёх видах ревью) он даёт 3.14:1 на фоне окна светлой темы. Текст — свой токен, как
    // `--status-warning-text` (ревью M12): accent-2-700, 4.82:1 на фоне окна, 5.90 на карточке и листе.
    it(`${theme}: текст успеха (--status-success-text) — accent-2-700, на --card, --background, --sheet, --editor-surface не ниже 4.5:1`, () => {
      same(theme, '--status-success-text', '--color-accent-2-700');
      const text = solid(theme, '--status-success-text');
      for (const under of ['--card', '--background', '--sheet', '--editor-surface']) {
        expect(contrastRatio(text, solid(theme, under)), under).toBeGreaterThanOrEqual(TEXT);
      }
    });

    it(`${theme}: --agent-question-text — accent-700, читается на подкраске blocked`, () => {
      same(theme, '--agent-question-text', '--color-accent-700');
      expect(contrastRatio(solid(theme, '--agent-question-text'), solid(theme, '--color-accent-200'))).toBeGreaterThanOrEqual(TEXT);
    });

    it(`${theme}: пункты-«разрушители» меню (--menu-destructive) на --popover и на подсветке фокуса не ниже 4.5:1`, () => {
      const text = solid(theme, '--menu-destructive');
      const popover = solid(theme, '--popover');
      expect(contrastRatio(text, popover)).toBeGreaterThanOrEqual(TEXT);
      expect(contrastRatio(text, on(theme, '--accent', popover))).toBeGreaterThanOrEqual(TEXT);
    });

    it(`${theme}: кольцо фокуса сайдбара (--work-sidebar-focus-ring) — не ниже 3:1 к каждому его фону`, () => {
      const ring = solid(theme, '--work-sidebar-focus-ring');
      const surface = solid(theme, '--work-sidebar');
      const card = solid(theme, '--card');
      const unders = {
        сайдбар: surface,
        'активная карточка': card,
        'выбранная строка': on(theme, '--work-sidebar-accent', card),
        'hover карточки': on(theme, '--card-hover', surface),
        blocked: solid(theme, '--color-accent-200'),
        unseen: solid(theme, '--color-accent-2-200'),
      };
      for (const [name, under] of Object.entries(unders)) {
        expect(contrastRatio(ring, under), name).toBeGreaterThanOrEqual(NON_TEXT);
      }
    });

    it(`${theme}: разделитель панелей (--split-divider) — не ниже 3:1 к --card, --background и листу; активный — не слабее`, () => {
      const line = solid(theme, '--split-divider');
      const strong = solid(theme, '--split-divider-strong');
      for (const under of ['--card', '--background', '--sheet']) {
        const bg = solid(theme, under);
        expect(contrastRatio(line, bg), under).toBeGreaterThanOrEqual(NON_TEXT);
        expect(contrastRatio(strong, bg), `${under} (strong)`).toBeGreaterThanOrEqual(contrastRatio(line, bg));
      }
    });

    it(`${theme}: фон редактора — лист центра`, () => {
      same(theme, '--editor-surface', '--sheet');
    });
  }
});

/**
 * Выделенная строка палитры ⌘J (Palette.tsx, спека 9.3): заливка — тон выбранной строки сайдбара,
 * а состояние несёт ещё и край (`ring-palette-selected-edge`): заливка `text 9 %` к фону панели
 * 1.2:1. Фон панели — `bg-background/96` поверх затемнения `bg-black/55`, под которым что угодно
 * от чёрного до белого: проверяются обе крайности. Панель станет `neutral-100` в куске 2 — пары
 * от этого только выигрывают.
 */
describe('выделенная строка палитры', () => {
  const paletteBackground = (theme: Theme, page: Rgb): Rgb =>
    compositeOver(solid(theme, '--background'), 0.96, compositeOver([0, 0, 0], 0.55, page));

  for (const theme of THEMES) {
    it(`${theme}: заливка — тон строки сайдбара, текст — обычный, вторичный не ниже 4.5:1`, () => {
      same(theme, '--palette-selected', '--work-sidebar-accent');
      same(theme, '--palette-selected-foreground', '--foreground');
      for (const page of [[0, 0, 0], [255, 255, 255]] as const) {
        const panel = paletteBackground(theme, page);
        const fill = compositeOver(resolveColor(tokens, theme, '--palette-selected').rgb, resolveColor(tokens, theme, '--palette-selected').alpha, panel);
        expect(contrastRatio(solid(theme, '--palette-selected-foreground'), fill)).toBeGreaterThanOrEqual(TEXT);
        expect(contrastRatio(solid(theme, '--palette-selected-muted'), fill)).toBeGreaterThanOrEqual(TEXT);
      }
    });

    it(`${theme}: край выделения — не ниже 3:1 к фону панели и к заливке`, () => {
      const edge = solid(theme, '--palette-selected-edge');
      const { rgb, alpha } = resolveColor(tokens, theme, '--palette-selected');
      for (const page of [[0, 0, 0], [255, 255, 255]] as const) {
        const panel = paletteBackground(theme, page);
        expect(contrastRatio(edge, panel)).toBeGreaterThanOrEqual(NON_TEXT);
        expect(contrastRatio(edge, compositeOver(rgb, alpha, panel))).toBeGreaterThanOrEqual(NON_TEXT);
      }
    });
  }
});

/**
 * Monaco принимает в `editor.background` только полный hex, а тему берёт из `getPropertyValue`
 * на `<html>` (`files/editor/editor-theme.ts`): после подстановки `var()` обе переменные обязаны
 * остаться hex, иначе редактор тихо возьмёт запасные цвета старой темы.
 */
describe('переменные, которые читает Monaco', () => {
  for (const theme of THEMES) {
    it(`${theme}: --editor-surface и --foreground после подстановки — hex`, () => {
      for (const name of ['--editor-surface', '--foreground']) {
        expect(substituted(tokens, theme, name), name).toMatch(/^#([0-9a-f]{6}|[0-9a-f]{3})$/i);
      }
    });
  }
});

/**
 * Нативное окно (`main/window.ts`) красится по теме в конструкторе — это цвет первой отрисовки и
 * полосы при ресайзе, пока рендерер не нарисовал свой фон. Фон рендерера — `--background`: если
 * цвет окна разойдётся с ним, при старте и ресайзе мелькает чужой фон (ревью куска 1: остались
 * прежние `#0a0a0a` и `#ffffff`). Hex в `window.ts` — вторая копия токена, и держит её этот тест.
 */
describe('цвет нативного окна — --background каждой темы', () => {
  const source = readFileSync(path.resolve(dirname, '../../main/window.ts'), 'utf8');
  const match = /backgroundColor:\s*input\.dark\s*\?\s*'(#[0-9a-fA-F]{6})'\s*:\s*'(#[0-9a-fA-F]{6})'/.exec(source);

  it('main/window.ts задаёт backgroundColor парой hex: `input.dark ? тёмный : светлый`', () => {
    expect(match, 'backgroundColor: input.dark ? \'#…\' : \'#…\'').not.toBeNull();
  });

  for (const theme of THEMES) {
    it(`${theme}: цвет окна совпадает с --background`, () => {
      const hex = theme === 'dark' ? match?.[1] : match?.[2];
      expect(hex?.toLowerCase()).toBe(substituted(tokens, theme, '--background').toLowerCase());
    });
  }
});

// ── Целостность: ни одной потерянной переменной ─────────────────────────────────────────────

/** Файлы рендерера, кроме тестов и самих токенов. */
function rendererFiles(extensions: RegExp): string[] {
  const out: string[] = [];
  const stack = [path.resolve(dirname, '..')];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (dir === undefined) continue;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'test-utils') stack.push(full);
      } else if (extensions.test(entry.name) && !/\.test\./.test(entry.name) && entry.name !== 'tokens.css') {
        out.push(full);
      }
    }
  }
  return out;
}

describe('целостность токенов', () => {
  it('каждая утилита @theme inline смотрит на существующую переменную', () => {
    const missing: string[] = [];
    for (const [utility, expression] of parseThemeInline(css)) {
      for (const match of expression.matchAll(/var\((--[\w-]+)/g)) {
        const target = match[1] as string;
        // Радиусы и тени в этом блоке — значения; `--shadow-*` смотрят на одноимённую переменную :root.
        if (!tokens.light.has(target)) missing.push(`${utility} → ${target}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('ни одна ссылка var(--…) в коде и CSS окна не смотрит на переменную, которой нет в tokens.css', () => {
    const dangling: string[] = [];
    for (const file of rendererFiles(/\.(tsx?|css)$/)) {
      for (const match of readFileSync(file, 'utf8').matchAll(/var\((--[\w-]+)/g)) {
        const name = match[1] as string;
        if (name.startsWith('--radix-') || name.startsWith('--tw-')) continue;
        if (!tokens.light.has(name) && !tokens.darkOverrides.has(name)) {
          dangling.push(`${path.relative(dirname, file)}: ${name}`);
        }
      }
    }
    expect(dangling).toEqual([]);
  });

  it('цвет текста «успех» — утилита text-status-success-text; заливочный text-status-success в коде не звать', () => {
    expect(parseThemeInline(css).get('--color-status-success-text')).toBe('var(--status-success-text)');
    const offenders = rendererFiles(/\.tsx?$/)
      .filter((file) => /\btext-status-success(?![\w-])/.test(readFileSync(file, 'utf8')))
      .map((file) => path.relative(dirname, file));
    expect(offenders).toEqual([]);
  });

  it('имена, которые зовёт код, остались: значения на палитре, обе темы читаются', () => {
    const called = [
      '--status-warning-text',
      '--status-warning',
      '--status-warning-background',
      '--status-warning-border',
      '--status-success',
      '--status-success-background',
      '--status-success-border',
      '--status-success-text',
      '--agent-question',
      '--agent-question-text',
      '--work-sidebar',
      '--work-sidebar-foreground',
      '--work-sidebar-accent',
      '--work-sidebar-accent-foreground',
      '--work-sidebar-border',
      '--work-sidebar-ring',
      '--work-sidebar-focus-ring',
      '--work-sidebar-muted-foreground',
      '--muted-foreground',
      '--split-divider',
      '--split-divider-strong',
      '--git-decoration-added',
      '--git-decoration-modified',
      '--git-decoration-deleted',
      '--git-decoration-renamed',
      '--git-decoration-untracked',
      '--git-decoration-copied',
      '--git-decoration-ignored',
      '--menu-destructive',
      '--palette-selected',
      '--palette-selected-foreground',
      '--palette-selected-muted',
      '--palette-selected-edge',
      '--editor-surface',
    ];
    for (const theme of THEMES) {
      for (const name of called) expect(() => resolveColor(tokens, theme, name), `${name} (${theme})`).not.toThrow();
    }
  });

  it('git-декорации читаются на листе и на фоне окна — не ниже 4.5:1, кроме «ignored» (намеренно тусклая, 3:1)', () => {
    for (const theme of THEMES) {
      for (const kind of ['added', 'modified', 'deleted', 'renamed', 'untracked', 'copied']) {
        const color = solid(theme, `--git-decoration-${kind}`);
        for (const under of ['--sheet', '--card', '--background']) {
          expect(contrastRatio(color, solid(theme, under)), `${kind} на ${under} (${theme})`).toBeGreaterThanOrEqual(TEXT);
        }
      }
      for (const under of ['--sheet', '--card', '--background']) {
        expect(contrastRatio(solid(theme, '--git-decoration-ignored'), solid(theme, under))).toBeGreaterThanOrEqual(NON_TEXT);
      }
    }
  });
});

// ── 5. Приглушение dimmed.css ───────────────────────────────────────────────────────────────

/**
 * Ревью M12: done- и архивные карточки и закрытые строки приглушаются не opacity всей карточки
 * (текст падал до 2.4–3.8:1), а цветом текста — основной текст сайдбара становится вторичным, — и
 * прозрачностью 0.6 у того, что не текст: значков и полосы внимания. Правило то же, токены новые:
 * контраст вторичного текста на фонах карточки выше, в разделе 3.
 */
describe('dimmed.css — правило приглушения на новых токенах', () => {
  it('основной текст сайдбара в [data-dimmed] — вторичный токен, без opacity у самого узла', () => {
    const rule = dimmedCss.match(/\[data-dimmed\]\s*\{([^}]*)\}/);
    expect(rule?.[1]).toMatch(/--work-sidebar-foreground:\s*var\(--work-sidebar-muted-foreground\);/);
    expect(rule?.[1]).not.toMatch(/opacity/);
  });

  it('значки и полоса внимания приглушены прозрачностью 0.6 — облик done сохраняется', () => {
    expect(dimmedCss).toMatch(/\[data-dimmed\]\s+:is\([^)]*svg[^)]*\[data-attention-strip\][^)]*\)\s*\{\s*opacity:\s*0\.6;/);
  });

  for (const theme of THEMES) {
    it(`${theme}: приглушённый основной текст (= --work-sidebar-muted-foreground) читается на активной карточке, выбранной строке и hover`, () => {
      const text = solid(theme, '--work-sidebar-muted-foreground');
      const card = solid(theme, '--card');
      const surface = solid(theme, '--work-sidebar');
      for (const under of [card, on(theme, '--work-sidebar-accent', card), on(theme, '--card-hover', surface), surface]) {
        expect(contrastRatio(text, under)).toBeGreaterThanOrEqual(TEXT);
      }
    });
  }
});
