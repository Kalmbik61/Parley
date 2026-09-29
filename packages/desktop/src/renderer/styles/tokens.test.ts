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
  'плашка решений вкладки «Почта» (accent-2-500 14 % на листе)': (theme) =>
    compositeOver(solid(theme, '--color-accent-2-500'), 0.14, solid(theme, '--sheet')),
};

/**
 * Заливка тега заметки на листе центра — вид `neutral-sheet` в `ui/badge.tsx` (`bg-neutral-200
 * dark:bg-neutral-100`): в светлой теме `neutral-100` — сам лист, там 200; в тёмной 100, как на снимке
 * handoff `dark-08`.
 */
const SHEET_NOTE_FILL: Record<Theme, string> = { light: '--color-neutral-200', dark: '--color-neutral-100' };

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

    it(`${theme}: заливка выбранного пункта сегмента (--primary) — признак состояния, не ниже 3:1 к фону окна и карточки`, () => {
      const fill = solid(theme, '--primary');
      expect(contrastRatio(fill, solid(theme, '--background'))).toBeGreaterThanOrEqual(NON_TEXT);
      expect(contrastRatio(fill, solid(theme, '--card'))).toBeGreaterThanOrEqual(NON_TEXT);
    });
  }
});

/**
 * Решение контролёра куска 2 по `--destructive`: по решению 1 главная кнопка светлой темы — accent-700,
 * и кнопка удаления на том же accent-700 слилась бы с ней, а контракт окна (`ConfirmDialog`, тест «Вид
 * кнопки подтверждения» в `review/ChangesPanel.test.tsx`) требует, чтобы `Discard` и `Delete`
 * отличались от главной. Светлая берёт accent-800, тёмная остаётся на accent-700 (как в таблице спеки).
 */
describe('--destructive — кнопка удаления не сливается с главной', () => {
  it('светлая — accent-800, тёмная — accent-700', () => {
    same('light', '--destructive', '--color-accent-800');
    same('dark', '--destructive', '--color-accent-700');
  });

  for (const theme of THEMES) {
    it(`${theme}: --destructive отличается от --primary`, () => {
      expect(resolveColor(tokens, theme, '--destructive')).not.toEqual(resolveColor(tokens, theme, '--primary'));
    });

    it(`${theme}: текст на заливке --destructive и на её hover (bg-destructive/90 поверх фона окна) не ниже 4.5:1`, () => {
      const text = solid(theme, '--destructive-foreground');
      expect(contrastRatio(text, solid(theme, '--destructive'))).toBeGreaterThanOrEqual(TEXT);
      const hover = compositeOver(solid(theme, '--destructive'), 0.9, solid(theme, '--background'));
      expect(contrastRatio(text, hover)).toBeGreaterThanOrEqual(TEXT);
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

// ── Значки состояний (таблица 1.2 спеки, наследство куска 1) ────────────────────────────────

/**
 * Значок состояния — признак состояния, порог 3:1 (WCAG 1.4.11) к каждому фону, на котором он стоит в
 * сайдбаре. Фоны — все заливки сайдбара, а не только три из брифа куска 2 (правки ревью: под курсором
 * заливка темнее, и значок терял контраст):
 *  — `surface` — неактивная карточка и её строки, фон окна;
 *  — hover неактивной карточки — `surface` + `text 4 %` (значок в заголовке карточки);
 *  — hover строки внутри неё — ещё `text 9 %`: самый тёмный фон сайдбара в светлой теме;
 *  — активная карточка (`neutral-100`), её выбранная строка и hover строки — `neutral-100` + `text 9 %`.
 * Ступени таблицы 1.2 для idle (`neutral-400`), pending и «закрыта» (`neutral-500`) держали 1.5–2.2:1;
 * ближайшая ступень рампы `neutral-*`, что держит все эти фоны, — `neutral-700` в светлой и `neutral-600`
 * в тёмной (рампы перевёрнуты), поэтому цвет — токен на тему `--state-inactive`; одна ступень на четыре
 * состояния (idle, pending, «спит», «закрыта») допустима: различает форма — точка, кольцо, луна, тире.
 * Так же и `--state-done` у unseen и done: `accent-2-600` таблицы в светлой теме на hover — 2.9 и 2.5:1,
 * ближайшая держащая ступень — `accent-2-700`; тёмная остаётся на `accent-2-600`, как в таблице.
 * Токены зовёт `components/AgentStateDot.tsx` (`AgentStateDot.test.tsx` сверяет классы).
 *
 * Исключение: закрытая строка (`data-dimmed="row"`, .5) и `done`-карточка (.6) приглушают значки
 * прозрачностью — этого требует спека 1.2, и эффективный контраст там ниже 3:1 (тире «закрыта» — 1.7:1
 * в светлой). Два требования — «.5» и «3:1» — вместе невыполнимы; спека сильнее. Состояние там несёт и
 * слово рядом (`closed`, `done`: вторичный текст ≥ 4.5:1, приглушается цветом, а не прозрачностью), так
 * что значок не единственный признак.
 */
const ROW_HOVER_BACKGROUND = 'hover строки неактивной карточки (--background + --card-hover + --accent)';
const STATE_ICON_BACKGROUNDS: Record<string, (theme: Theme) => Rgb> = {
  'фон окна (--background)': (theme) => solid(theme, '--background'),
  'hover неактивной карточки (--background + --card-hover)': (theme) => on(theme, '--card-hover', solid(theme, '--background')),
  [ROW_HOVER_BACKGROUND]: (theme) => on(theme, '--accent', on(theme, '--card-hover', solid(theme, '--background'))),
  'активная карточка (--card)': (theme) => solid(theme, '--card'),
  'выбранная строка активной карточки (--card + --accent)': (theme) => on(theme, '--accent', solid(theme, '--card')),
};

describe('значки состояний — не ниже 3:1 к фонам сайдбара в обеих темах, включая hover', () => {
  const ICONS: Array<{ name: string; token: string; skip?: readonly string[] }> = [
    { name: 'idle, pending, спит, закрыта (--state-inactive)', token: '--state-inactive' },
    { name: 'working (neutral-700)', token: '--color-neutral-700' },
    // Строка blocked всегда на подкраске accent-200 (hover её не меняет): на заливке hover строки значок
    // blocked не стоит, а в заголовке карточки — стоит (проверяется на остальных фонах).
    { name: 'blocked (--agent-question)', token: '--agent-question', skip: [ROW_HOVER_BACKGROUND] },
    { name: 'unseen и done (--state-done)', token: '--state-done' },
    { name: 'failed (accent-700)', token: '--color-accent-700' },
  ];

  for (const theme of THEMES) {
    for (const { name, token, skip } of ICONS) {
      for (const [background, backdrop] of Object.entries(STATE_ICON_BACKGROUNDS)) {
        if (skip?.includes(background) === true) continue;
        it(`${theme}: ${name} на «${background}»`, () => {
          expect(contrastRatio(solid(theme, token), backdrop(theme))).toBeGreaterThanOrEqual(NON_TEXT);
        });
      }
    }

    it(`${theme}: idle, pending, спит и закрыта читаются и на подкрасках строк комнаты и сессии (accent-200, accent-2-200)`, () => {
      const icon = solid(theme, '--state-inactive');
      for (const tint of ['--color-accent-200', '--color-accent-2-200']) {
        expect(contrastRatio(icon, solid(theme, tint)), tint).toBeGreaterThanOrEqual(NON_TEXT);
      }
    });

    it(`${theme}: blocked читается на подкраске accent-200, unseen — на accent-2-200 (своя строка всегда на подкраске)`, () => {
      expect(contrastRatio(solid(theme, '--agent-question'), solid(theme, '--color-accent-200'))).toBeGreaterThanOrEqual(NON_TEXT);
      expect(contrastRatio(solid(theme, '--state-done'), solid(theme, '--color-accent-2-200'))).toBeGreaterThanOrEqual(NON_TEXT);
    });
  }

  it('--state-inactive: светлая — neutral-700, тёмная — neutral-600; --state-done: светлая — accent-2-700, тёмная — accent-2-600', () => {
    same('light', '--state-inactive', '--color-neutral-700');
    same('dark', '--state-inactive', '--color-neutral-600');
    same('light', '--state-done', '--color-accent-2-700');
    same('dark', '--state-done', '--color-accent-2-600');
  });

  // «Ближайшая ступень»: ступень слабее не держит хотя бы один из фонов — иначе токен можно было бы ослабить.
  for (const { theme, weaker, token } of [
    { theme: 'light' as const, weaker: '--color-neutral-600', token: '--state-inactive' },
    { theme: 'dark' as const, weaker: '--color-neutral-500', token: '--state-inactive' },
    { theme: 'light' as const, weaker: '--color-accent-2-600', token: '--state-done' },
  ]) {
    it(`${theme}: ${token} — ближайшая ступень: ${weaker} не держит хотя бы один из фонов сайдбара`, () => {
      const worst = Math.min(...Object.values(STATE_ICON_BACKGROUNDS).map((backdrop) => contrastRatio(solid(theme, weaker), backdrop(theme))));
      expect(worst).toBeLessThan(NON_TEXT);
    });
  }
});

// ── Цветной текст на hover-заливке правого сайдбара (правки ревью куска 2) ───────────────────

/**
 * Строки правого сайдбара (Files, Changes) лежат на фоне окна, а их hover-заливка — `text 6 %`
 * (`hover:bg-foreground/6`). Цветные счётчики и имена файлов на ней: `+N` и имена added и untracked —
 * `accent-2-700` (4.31:1 в светлой), renamed — `neutral-700` (4.40). Вторичный цвет на hover строки
 * подменяется на основной, но эти цвета идут токенами `--status-success-text` и `--git-decoration-*`, и
 * подмена их не касается: на hover строка берёт ступень 800 тех же рамп. `−N` (`accent-700`, 4.55:1) и
 * modified держат порог сами, deleted — `accent-800`.
 */
describe('правый сайдбар — цветные счётчики и имена файлов на hover-заливке text 6 % не ниже 4.5:1', () => {
  const hoverFill = (theme: Theme): Rgb => compositeOver(solid(theme, '--foreground'), 0.06, solid(theme, '--background'));

  for (const theme of THEMES) {
    it(`${theme}: цвета на hover (accent-2-800, neutral-800) и цвета без подмены (−N accent-700, modified accent-700, deleted accent-800)`, () => {
      const fill = hoverFill(theme);
      for (const name of ['--color-accent-2-800', '--color-neutral-800', '--color-accent-700', '--color-accent-800']) {
        expect(contrastRatio(solid(theme, name), fill), name).toBeGreaterThanOrEqual(TEXT);
      }
    });
  }

  it('светлая: без подмены `+N` и added, untracked (accent-2-700) и renamed (neutral-700) на этой заливке ниже 4.5:1', () => {
    const fill = hoverFill('light');
    for (const name of ['--status-success-text', '--git-decoration-added', '--git-decoration-untracked', '--git-decoration-renamed']) {
      expect(contrastRatio(solid('light', name), fill), name).toBeLessThan(TEXT);
    }
  });
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

    it(`${theme}: тег заметки на листе (вид neutral-sheet) — текст neutral-800 на его заливке не ниже 4.5:1`, () => {
      expect(contrastRatio(solid(theme, '--color-neutral-800'), solid(theme, SHEET_NOTE_FILL[theme]))).toBeGreaterThanOrEqual(TEXT);
    });

    it(`${theme}: заливка тега заметки на листе отличима от листа — читается плашкой, а не «на единицу RGB» (не ниже 1.1:1)`, () => {
      const sheet = solid(theme, '--sheet');
      const fill = solid(theme, SHEET_NOTE_FILL[theme]);
      expect(fill).not.toEqual(sheet);
      expect(contrastRatio(fill, sheet)).toBeGreaterThanOrEqual(1.1);
    });

    if (theme === 'light') {
      it('светлая: neutral-100 — это и есть лист (--sheet), поэтому обычный тег neutral на листе невидим и заметке там нужна заливка 200', () => {
        expect(solid('light', '--color-neutral-100')).toEqual(solid('light', '--sheet'));
      });
    }

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
 * Выделенная строка палитры ⌘J (Palette.tsx, спека 9.3): заливка — тон выбранной строки сайдбара, а
 * состояние несёт ещё и край (`ring-palette-selected-edge`): заливка `text 9 %` к фону панели 1.2:1. С
 * куска 2 панель — непрозрачный `--popover` (`neutral-100`, спека окна 2026-09-29, 1.9), а не стекло над
 * затемнением, поэтому пары считаются от неё без разбега по фону страницы.
 */
describe('выделенная строка палитры', () => {
  for (const theme of THEMES) {
    it(`${theme}: заливка — тон строки сайдбара, текст — обычный, вторичный не ниже 4.5:1`, () => {
      same(theme, '--palette-selected', '--work-sidebar-accent');
      same(theme, '--palette-selected-foreground', '--foreground');
      const fill = on(theme, '--palette-selected', solid(theme, '--popover'));
      expect(contrastRatio(solid(theme, '--palette-selected-foreground'), fill)).toBeGreaterThanOrEqual(TEXT);
      expect(contrastRatio(solid(theme, '--palette-selected-muted'), fill)).toBeGreaterThanOrEqual(TEXT);
      // Вторичный текст невыбранных строк — на панели: подпись, заголовок секции, подвал (на `bg`).
      expect(contrastRatio(solid(theme, '--muted-foreground'), solid(theme, '--popover'))).toBeGreaterThanOrEqual(TEXT);
      expect(contrastRatio(solid(theme, '--muted-foreground'), solid(theme, '--color-bg'))).toBeGreaterThanOrEqual(TEXT);
    });

    it(`${theme}: край выделения — не ниже 3:1 к фону панели и к заливке`, () => {
      const edge = solid(theme, '--palette-selected-edge');
      const panel = solid(theme, '--popover');
      expect(contrastRatio(edge, panel)).toBeGreaterThanOrEqual(NON_TEXT);
      expect(contrastRatio(edge, on(theme, '--palette-selected', panel))).toBeGreaterThanOrEqual(NON_TEXT);
    });

    it(`${theme}: подсказка ⌘1…⌘9 (neutral-800 на neutral-200) читается на панели и на выбранной строке`, () => {
      const pill = solid(theme, '--color-neutral-200');
      expect(contrastRatio(solid(theme, '--color-neutral-800'), pill)).toBeGreaterThanOrEqual(TEXT);
      // Пилюля лежит на панели и на заливке выбранной строки — её границу видно: не слабее 1.05:1.
      expect(contrastRatio(pill, solid(theme, '--popover'))).toBeGreaterThanOrEqual(1.05);
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

  // Спека окна 2026-09-29, 1.2: `done`-карточка — .6, закрытая строка — .5, при правиле dimmed.css: цвет
  // текста меняется, а прозрачность ложится только на значки (полосы внимания слева у карточки больше нет).
  it('значки приглушены прозрачностью: 0.6 у done-карточки, 0.5 у закрытой строки (data-dimmed="row")', () => {
    expect(dimmedCss).toMatch(/\[data-dimmed\]\s+:is\([^)]*svg[^)]*\)[^{]*\{\s*opacity:\s*0\.6;/);
    expect(dimmedCss).toMatch(/\[data-dimmed='row'\]\s+:is\([^)]*svg[^)]*\)[^{]*\{\s*opacity:\s*0\.5;/);
    expect(dimmedCss).not.toContain('data-attention-strip');
  });

  // Правки ревью куска 2: значок провайдера — `<img>` (брендовый SVG), а не `svg`, и правило его не брало:
  // в done-карточке и в закрытой строке звезда Claude оставалась при opacity 1. `AgentIcon` несёт
  // `data-agent-icon` на обоих видах (картинка и буква), правило берёт его в оба списка.
  it('значок провайдера (`[data-agent-icon]`, `<img>`) приглушается тем же .6 и .5, что значки-svg', () => {
    expect(dimmedCss).toMatch(/\[data-dimmed\]\s+:is\([^)]*\[data-agent-icon\][^)]*\)[^{]*\{\s*opacity:\s*0\.6;/);
    expect(dimmedCss).toMatch(/\[data-dimmed='row'\]\s+:is\([^)]*\[data-agent-icon\][^)]*\)[^{]*\{\s*opacity:\s*0\.5;/);
  });

  it('прозрачность значка состояния не перемножается с прозрачностью его внутреннего значка (.6 × .6)', () => {
    expect(dimmedCss).toContain(":not([data-testid='agent-state-dot'] svg)");
  });

  // Правки ревью куска 2: на hover строки в приглушённом поддереве (done-карточка, закрытая строка) текст
  // оставался вторичным (`neutral-700`): подмена вторичной переменной внутри `[data-dimmed]` ничего не
  // меняет — основная там уже равна вторичной. На самой тёмной заливке hover (`surface` + `text 4 %` карточки
  // + `text 9 %` строки) вторичный в светлой — 3.86:1, ниже 4.5; поэтому строка на hover берёт основной
  // цвет текста явно (`hover:[--work-sidebar-foreground:var(--color-text)]`, `SessionRow.tsx`).
  for (const theme of THEMES) {
    it(`${theme}: основной текст на hover строки внутри hover неактивной карточки (surface + text 4 % + text 9 %) не ниже 4.5:1`, () => {
      const surface = solid(theme, '--work-sidebar');
      const hovered = on(theme, '--work-sidebar-accent', on(theme, '--card-hover', surface));
      expect(contrastRatio(solid(theme, '--color-text'), hovered)).toBeGreaterThanOrEqual(TEXT);
    });
  }

  it('светлая: вторичный текст на этой заливке ниже 4.5:1 — потому строка и меняет цвет на hover', () => {
    const surface = solid('light', '--work-sidebar');
    const hovered = on('light', '--work-sidebar-accent', on('light', '--card-hover', surface));
    expect(contrastRatio(solid('light', '--work-sidebar-muted-foreground'), hovered)).toBeLessThan(TEXT);
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

// ── Строка комнаты в сайдбаре (кусок 5 плана «Organic», спека окна 2026-09-29, 1.2) ───────────────────────────────

/**
 * Строка комнаты лежит внутри карточки, поэтому её заливки — прозрачные `text N %` поверх фона карточки: активная
 * (`neutral-100`), неактивная (`surface`) и неактивная под курсором (`surface` + `--card-hover`: указатель над
 * строкой всегда над и её карточкой). Заливки: решение ждёт — `accent-200` (сплошная), выбрана — `text 9 %` (только в
 * активной карточке), развёрнута — `text 4 %` (hover 6 %), свёрнутая на hover — `text 9 %`. Внутри развёрнутой
 * комнаты строка участника кладёт свои `text 9 %` (выбрана, hover) поверх заливки комнаты.
 *
 * Что берёт цвет: время, Hash и шеврон шапки, слово и время участников — `--work-sidebar-muted-foreground`
 * (`neutral-700`); слово «N new» — `neutral-800`; «decision» — `accent-800`; `★` ведущего — `accent-700`; число в
 * кружке-счётчике — основной текст на `neutral-300`. Пары, где `neutral-700` не держит порог, решаются так:
 *  — свёрнутая на hover: заливка `text 9 %` поверх неактивной карточки под курсором — 3.86:1 в светлой; на hover
 *    вторичный и основной цвет строки — `--color-text` (как у строки сессии);
 *  — развёрнутая (`text 4 %`) в неактивной карточке под курсором — 4.25:1 в светлой, а с заливкой строки участника
 *    — 3.60; внутри развёрнутой комнаты вторичный цвет — `neutral-800` (ступень темнее, брифа куска 5).
 *
 * Значки состояний участников (правки ревью куска 5) — признак состояния, порог 3:1 на всех стопках «основание
 * карточки → заливка комнаты → заливка строки участника»; сами по себе значки сайдбара проверены выше, на заливках
 * без комнаты. Значок «нет процесса» (`--state-inactive`) в тёмной на двух стопках активной карточки ниже порога
 * (2.67 и 2.92:1), поэтому внутри развёрнутой комнаты `RoomRow` подменяет токен на `neutral-700` (запись в отчёте).
 */
describe('строка комнаты — контраст на заливках (кусок 5)', () => {
  const CARDS: Record<string, (theme: Theme) => Rgb> = {
    'активная карточка (--card)': (theme) => solid(theme, '--card'),
    'неактивная карточка (--background)': (theme) => solid(theme, '--background'),
    'неактивная карточка под курсором (--background + --card-hover)': (theme) => on(theme, '--card-hover', solid(theme, '--background')),
  };
  const ACTIVE_CARD = 'активная карточка (--card)';
  /** `--foreground` (`text`) с прозрачностью `alpha` поверх `base`: `bg-foreground/N` в классах. */
  const text = (theme: Theme, alpha: number, base: Rgb): Rgb => compositeOver(solid(theme, '--foreground'), alpha, base);
  const member = (theme: Theme, base: Rgb): Rgb => on(theme, '--work-sidebar-accent', base);

  /** Заливки строки комнаты без участников: card → заливка. */
  const ROOM_FILLS: Record<string, { cards: string[]; fill: (theme: Theme, card: Rgb) => Rgb }> = {
    'в покое, без заливки': { cards: Object.keys(CARDS), fill: (_theme, card) => card },
    'выбрана (text 9 %)': { cards: [ACTIVE_CARD], fill: (theme, card) => on(theme, '--work-sidebar-accent', card) },
    'развёрнута (text 4 %)': { cards: Object.keys(CARDS), fill: (theme, card) => text(theme, 0.04, card) },
    'hover развёрнутой (text 6 %)': { cards: Object.keys(CARDS), fill: (theme, card) => text(theme, 0.06, card) },
    'hover свёрнутой (text 9 %)': { cards: Object.keys(CARDS), fill: (theme, card) => text(theme, 0.09, card) },
  };

  /**
   * Значок состояния участника развёрнутой комнаты стоит на стопке: основание карточки → заливка комнаты (развёрнута
   * 4 %, hover 6 %; выбрана 9 % — только в активной карточке; решение ждёт — `accent-200`) → заливка самой строки
   * участника (выбран или под курсором — `text 9 %`) либо её отсутствие. Указатель над строкой участника — над и её
   * комнатой, и её карточкой, поэтому hover складывается на всех трёх этажах. Блокировка (`--agent-question`) сюда не
   * входит: строка blocked всегда на своей подкраске `accent-200` — она сплошная и от стопки не зависит.
   */
  const memberStacks = (theme: Theme): Array<[name: string, backdrop: Rgb]> => {
    const out: Array<[string, Rgb]> = [];
    for (const [cardName, card] of Object.entries(CARDS)) {
      const base = card(theme);
      const rooms: Array<[string, Rgb]> = [
        ['развёрнута 4 %', text(theme, 0.04, base)],
        ['hover развёрнутой 6 %', text(theme, 0.06, base)],
        ...(cardName === ACTIVE_CARD ? [['выбрана 9 %', member(theme, base)] as [string, Rgb]] : []),
      ];
      for (const [roomName, room] of rooms) {
        out.push([`«${cardName}» → ${roomName}`, room]);
        out.push([`«${cardName}» → ${roomName} → участник (выбран или hover, text 9 %)`, member(theme, room)]);
      }
    }
    const pending = solid(theme, '--color-accent-200');
    out.push(['решение ждёт (accent-200)', pending]);
    out.push(['решение ждёт (accent-200) → участник (выбран или hover, text 9 %)', member(theme, pending)]);
    return out;
  };
  /**
   * Значок «нет процесса»: idle, pending, «спит» и «закрыта». Токен `--state-inactive` тёмной темы — `neutral-600` —
   * на стопках «выбрана 9 % → hover участника» и «hover развёрнутой 6 % → hover участника» активной карточки даёт
   * 2.67 и 2.92:1, ниже порога; внутри развёрнутой комнаты `RoomRow` подменяет его на ступень темнее — `neutral-700`
   * (3.8:1 на самой тёмной стопке). В светлой эта ступень и есть `--state-inactive`.
   */
  const IN_ROOM_INACTIVE = '--color-neutral-700';
  const MEMBER_ICONS: Array<[name: string, token: string]> = [
    ['idle, pending, спит, закрыта (значок «нет процесса» в комнате)', IN_ROOM_INACTIVE],
    ['working (neutral-700)', '--color-neutral-700'],
    ['unseen и done (--state-done)', '--state-done'],
    ['failed (accent-700)', '--color-accent-700'],
  ];

  for (const theme of THEMES) {
    describe(theme, () => {
      it('«решение ждёт» (accent-200): вторичный текст, «decision» (accent-800) и значок вопроса читаются', () => {
        const fill = solid(theme, '--color-accent-200');
        expect(contrastRatio(solid(theme, '--work-sidebar-muted-foreground'), fill)).toBeGreaterThanOrEqual(TEXT);
        expect(contrastRatio(solid(theme, '--color-accent-800'), fill)).toBeGreaterThanOrEqual(TEXT);
        expect(contrastRatio(solid(theme, '--agent-question'), fill)).toBeGreaterThanOrEqual(NON_TEXT);
      });

      for (const [name, { cards, fill }] of Object.entries(ROOM_FILLS)) {
        for (const card of cards) {
          it(`«${name}» на «${card}»: слово «N new» (neutral-800) и основной текст ≥ 4.5:1, значки (neutral-800) ≥ 3:1`, () => {
            const under = fill(theme, (CARDS[card] as (theme: Theme) => Rgb)(theme));
            expect(contrastRatio(solid(theme, '--color-neutral-800'), under)).toBeGreaterThanOrEqual(TEXT);
            expect(contrastRatio(solid(theme, '--foreground'), under)).toBeGreaterThanOrEqual(TEXT);
          });
        }
      }

      it('в покое (без заливки, выбрана, ждёт решения) вторичный текст neutral-700 держит 4.5:1: время, Hash и шеврон шапки', () => {
        const muted = solid(theme, '--work-sidebar-muted-foreground');
        for (const card of Object.values(CARDS)) expect(contrastRatio(muted, card(theme))).toBeGreaterThanOrEqual(TEXT);
        expect(contrastRatio(muted, on(theme, '--work-sidebar-accent', solid(theme, '--card')))).toBeGreaterThanOrEqual(TEXT);
      });

      it('свёрнутая на hover — основной текст (--color-text) держит 4.5:1 на text 9 % поверх любой карточки', () => {
        for (const card of Object.values(CARDS)) {
          expect(contrastRatio(solid(theme, '--color-text'), text(theme, 0.09, card(theme)))).toBeGreaterThanOrEqual(TEXT);
        }
      });

      it('развёрнутая: вторичный цвет neutral-800 держит 4.5:1 на заливках комнаты и на заливках строки участника поверх них', () => {
        const ink = solid(theme, '--color-neutral-800');
        for (const card of Object.values(CARDS)) {
          const base = card(theme);
          for (const room of [text(theme, 0.04, base), text(theme, 0.06, base)]) {
            expect(contrastRatio(ink, room)).toBeGreaterThanOrEqual(TEXT);
            expect(contrastRatio(ink, member(theme, room))).toBeGreaterThanOrEqual(TEXT);
          }
        }
        // Выбранная комната (только в активной карточке) и решение, ждущее ответа: заливка + строка участника.
        const selected = on(theme, '--work-sidebar-accent', solid(theme, '--card'));
        expect(contrastRatio(ink, selected)).toBeGreaterThanOrEqual(TEXT);
        expect(contrastRatio(ink, member(theme, selected))).toBeGreaterThanOrEqual(TEXT);
        const pending = solid(theme, '--color-accent-200');
        expect(contrastRatio(ink, pending)).toBeGreaterThanOrEqual(TEXT);
        expect(contrastRatio(ink, member(theme, pending))).toBeGreaterThanOrEqual(TEXT);
      });

      it('участник на hover внутри комнаты — основной текст (--color-text) держит 4.5:1 на заливке комнаты + hover строки', () => {
        for (const card of Object.values(CARDS)) {
          const base = card(theme);
          for (const room of [text(theme, 0.04, base), text(theme, 0.06, base)]) {
            expect(contrastRatio(solid(theme, '--color-text'), member(theme, room))).toBeGreaterThanOrEqual(TEXT);
          }
        }
        expect(contrastRatio(solid(theme, '--color-text'), member(theme, solid(theme, '--color-accent-200')))).toBeGreaterThanOrEqual(TEXT);
      });

      it('★ ведущего (accent-700, 11px, признак состояния) — не ниже 3:1 на заливках комнаты и строки участника; подкраски blocked и unseen — с запасом', () => {
        const star = solid(theme, '--color-accent-700');
        for (const card of Object.values(CARDS)) {
          const base = card(theme);
          for (const room of [base, text(theme, 0.04, base), text(theme, 0.06, base)]) {
            expect(contrastRatio(star, room)).toBeGreaterThanOrEqual(NON_TEXT);
            expect(contrastRatio(star, member(theme, room))).toBeGreaterThanOrEqual(NON_TEXT);
          }
        }
        const selected = on(theme, '--work-sidebar-accent', solid(theme, '--card'));
        expect(contrastRatio(star, selected)).toBeGreaterThanOrEqual(NON_TEXT);
        expect(contrastRatio(star, member(theme, selected))).toBeGreaterThanOrEqual(NON_TEXT);
        for (const tint of ['--color-accent-200', '--color-accent-2-200']) {
          expect(contrastRatio(star, solid(theme, tint)), tint).toBeGreaterThanOrEqual(TEXT);
        }
        expect(contrastRatio(star, member(theme, solid(theme, '--color-accent-200')))).toBeGreaterThanOrEqual(NON_TEXT);
      });

      it('значки состояний участников развёрнутой комнаты — не ниже 3:1 на стопках «заливка комнаты + заливка строки участника» на всех трёх основаниях карточки', () => {
        // Все пары разом, а не первая упавшая: список показывает, какие стопки не держат порог.
        const below: string[] = [];
        for (const [stack, backdrop] of memberStacks(theme)) {
          for (const [icon, token] of MEMBER_ICONS) {
            const ratio = contrastRatio(solid(theme, token), backdrop);
            if (ratio < NON_TEXT) below.push(`${icon} на ${stack}: ${ratio.toFixed(2)}:1`);
          }
        }
        expect(below).toEqual([]);
      });

      it('число в кружке-счётчике — основной текст на neutral-300 — не ниже 4.5:1', () => {
        expect(contrastRatio(solid(theme, '--color-text'), solid(theme, '--color-neutral-300'))).toBeGreaterThanOrEqual(TEXT);
      });

      it('строка «New session or room» под строками активной карточки: вторичный текст на карточке и основной на hover (text 6 %) — не ниже 4.5:1', () => {
        const card = solid(theme, '--card');
        expect(contrastRatio(solid(theme, '--work-sidebar-muted-foreground'), card)).toBeGreaterThanOrEqual(TEXT);
        expect(contrastRatio(solid(theme, '--color-text'), text(theme, 0.06, card))).toBeGreaterThanOrEqual(TEXT);
      });
    });
  }

  // Ступень темнее нужна там, где токен не держит: без неё пары ниже порога (тёмная).
  it('тёмная: --state-inactive (neutral-600) на выбранной комнате и на hover развёрнутой активной карточки со строкой участника — 2.67 и 2.92:1, ниже 3:1; neutral-700 в комнате держит; в светлой токен и есть neutral-700', () => {
    const card = solid('dark', '--card');
    const plain = solid('dark', '--state-inactive');
    const stronger = solid('dark', IN_ROOM_INACTIVE);
    // Выбранная комната (text 9 %) и развёрнутая под курсором (text 6 %) в активной карточке, поверх — строка участника.
    for (const room of [member('dark', card), text('dark', 0.06, card)]) {
      const under = member('dark', room);
      expect(contrastRatio(plain, under)).toBeLessThan(NON_TEXT);
      expect(contrastRatio(stronger, under)).toBeGreaterThanOrEqual(NON_TEXT);
    }
    same('light', '--state-inactive', IN_ROOM_INACTIVE);
  });

  // Ступень темнее нужна там, где neutral-700 не держит: без неё пары ниже порога (светлая).
  it('светлая: neutral-700 на hover свёрнутой (3.86) и внутри развёрнутой в неактивной карточке под курсором (4.25, с строкой участника 3.60) ниже 4.5 — потому основной текст и neutral-800', () => {
    const muted = solid('light', '--work-sidebar-muted-foreground');
    const hovered = on('light', '--card-hover', solid('light', '--background'));
    expect(contrastRatio(muted, text('light', 0.09, hovered))).toBeLessThan(TEXT);
    expect(contrastRatio(muted, text('light', 0.04, hovered))).toBeLessThan(TEXT);
    expect(contrastRatio(muted, member('light', text('light', 0.04, hovered)))).toBeLessThan(TEXT);
  });
});
