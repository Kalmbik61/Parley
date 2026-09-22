import { afterEach, describe, expect, it } from 'vitest';
import { applyThemeConfig, theme } from './index.js';
import { PALETTES } from './palettes.js';
import { roles, type RoleProps, type Theme } from './roles.js';

/** Все листовые роли темы, плоским списком. */
function leaves(t: Theme): RoleProps[] {
  return [
    t.bg.panel,
    t.bg.sidebar,
    t.bg.status,
    t.bg.overlay,
    t.bg.agent,
    t.bg.selection,
    t.bg.badge,
    t.border.active,
    t.border.idle,
    t.fg.default,
    t.fg.second,
    t.fg.muted,
    t.fg.accent,
    t.fg.badge,
    t.status.live,
    t.status.warn,
    t.status.fail,
    t.status.unseen,
  ];
}

describe('уровни 3 и 2 — hex своей палитры, fills: true (приёмка A)', () => {
  for (const level of [3, 2] as const) {
    for (const [name, palette] of Object.entries(PALETTES)) {
      it(`${name} на уровне ${level}: каждая роль отдаёт ровно один hex`, () => {
        const t = roles(palette, level);
        expect(t.fills).toBe(true);
        for (const role of leaves(t)) {
          const values = Object.values(role);
          expect(values).toHaveLength(1);
          expect(values[0]).toMatch(/^#[0-9a-f]{6}$/);
        }
      });
    }
  }
});

describe('bg.badge — слот cyan, не surface (дизайн 3.2, уточнён)', () => {
  for (const level of [3, 2] as const) {
    for (const [name, palette] of Object.entries(PALETTES)) {
      it(`${name} на уровне ${level}: bg.badge = cyan палитры, отдельно от bg.selection (surface)`, () => {
        const t = roles(palette, level);
        expect(t.bg.badge).toEqual({ backgroundColor: palette.cyan });
        expect(t.bg.badge).not.toEqual(t.bg.selection);
      });
    }
  }
});

describe('уровень 1 — только имена ANSI и dimColor, ни одного hex (приёмка A)', () => {
  for (const [name, palette] of Object.entries(PALETTES)) {
    it(`${name}: ни в одной роли нет символа '#', fills === false`, () => {
      const t = roles(palette, 1);
      expect(t.fills).toBe(false);
      expect(JSON.stringify(t)).not.toContain('#');
    });

    it(`${name}: fg.second и fg.muted оба dimColor (таблица 6.1 — цитата брифа и вторая строка ряда — dim)`, () => {
      const t = roles(palette, 1);
      expect(t.fg.second).toEqual({ dimColor: true });
      expect(t.fg.muted).toEqual({ dimColor: true });
    });

    // Дизайн 3.2 (уточнён): плашка не может делить слот с выбранным рядом —
    // общий `surface`/`blackBright` сделал бы её невидимой ровно там, где она
    // нужна. У неё свой акцент — тот же ANSI `cyan`, что и в сегодняшнем коде
    // (`sidebar.tsx` `buttonProps`), и он отличается от подсветки `bg.selection`.
    it(`${name}: bg.badge — ANSI 'cyan', отдельно от bg.selection`, () => {
      const t = roles(palette, 1);
      expect(t.bg.badge).toEqual({ backgroundColor: 'cyan' });
      expect(t.bg.badge).not.toEqual(t.bg.selection);
    });

    it(`${name}: fg.badge пуст — текст плашки сегодня не подкрашен отдельно`, () => {
      const t = roles(palette, 1);
      expect(t.fg.badge).toEqual({});
    });

    it(`${name}: status.unseen — ANSI 'blue' (точка непрочитанного в компактной строке)`, () => {
      const t = roles(palette, 1);
      expect(t.status.unseen).toEqual({ color: 'blue' });
    });
  }
});

describe('уровень 0 — все роли пустой объект, fills === false (приёмка A)', () => {
  for (const [name, palette] of Object.entries(PALETTES)) {
    it(`${name}: каждая роль — {}`, () => {
      const t = roles(palette, 0);
      expect(t.fills).toBe(false);
      for (const role of leaves(t)) {
        expect(role).toEqual({});
      }
    });
  }
});

describe('реестр — applyThemeConfig/theme (index.ts)', () => {
  afterEach(() => applyThemeConfig('mocha'));

  it("'terminal' на уровнях 3, 2 и 1 даёт одно и то же", () => {
    applyThemeConfig('terminal', 1);
    const atOne = theme();
    for (const level of [3, 2, 1]) {
      applyThemeConfig('terminal', level);
      expect(theme()).toEqual(atOne);
    }
  });

  it('неизвестное имя в applyThemeConfig — молча дефолт mocha, не бросает', () => {
    expect(() => applyThemeConfig('совсем-не-тема', 3)).not.toThrow();
    expect(theme()).toEqual(roles(PALETTES.mocha, 3));
  });

  it('известное имя применяется как есть', () => {
    applyThemeConfig('nord', 3);
    expect(theme()).toEqual(roles(PALETTES.nord, 3));
  });
});
