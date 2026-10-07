import { describe, expect, it } from 'vitest';
import { DEFAULT_UI, fitRightSidebar, LEFT_SIDEBAR, normalizeUi, RIGHT_SIDEBAR } from './ui-types.js';

describe('normalizeUi', () => {
  it('пустой объект → DEFAULT_UI', () => {
    expect(normalizeUi({})).toEqual(DEFAULT_UI);
  });

  it('ширина левого сайдбара приводится к пределам 220–500', () => {
    expect(normalizeUi({ leftSidebar: { width: 9999 } }).leftSidebar.width).toBe(500);
    expect(normalizeUi({ leftSidebar: { width: 10 } }).leftSidebar.width).toBe(220);
  });

  it('неизвестный appearance → system', () => {
    expect(normalizeUi({ appearance: 'blue' }).appearance).toBe('system');
  });

  it('лишний ключ верхнего уровня выкинут', () => {
    const result = normalizeUi({ mystery: 'value' }) as UiFileWithMystery;
    expect(result.mystery).toBeUndefined();
    expect(result).toEqual(DEFAULT_UI);
  });

  // Тест 11 раунда исправлений: граница — инвариант по диапазону, не одно число.
  // `Math.max/min` с NaN-аргументом дают NaN (спецификация ECMA) — раньше
  // `normalizeUi` пропускала NaN/±Infinity в клапан пределов как есть.
  it('ширина левого сайдбара — всегда конечное число в 220–500 (тест 11)', () => {
    const garbage: unknown[] = [NaN, Infinity, -Infinity, '300', null, undefined, {}, []];
    for (const value of garbage) {
      const width = normalizeUi({ leftSidebar: { width: value } }).leftSidebar.width;
      expect(Number.isFinite(width), `width для ${String(value)}`).toBe(true);
      expect(width).toBeGreaterThanOrEqual(LEFT_SIDEBAR.min);
      expect(width).toBeLessThanOrEqual(LEFT_SIDEBAR.max);
    }
    for (let value = -1_000_000_000; value <= 1_000_000_000; value += 137_000_000) {
      const width = normalizeUi({ leftSidebar: { width: value } }).leftSidebar.width;
      expect(Number.isFinite(width)).toBe(true);
      expect(width).toBeGreaterThanOrEqual(LEFT_SIDEBAR.min);
      expect(width).toBeLessThanOrEqual(LEFT_SIDEBAR.max);
    }
  });

  it('ширина правого сайдбара — всегда конечное число ≥ 220 (тест 11)', () => {
    const garbage: unknown[] = [NaN, Infinity, -Infinity, '300', null, undefined, {}, []];
    for (const value of garbage) {
      const width = normalizeUi({ rightSidebar: { width: value } }).rightSidebar.width;
      expect(Number.isFinite(width), `width для ${String(value)}`).toBe(true);
      expect(width).toBeGreaterThanOrEqual(RIGHT_SIDEBAR.min);
    }
    for (let value = -1_000_000_000; value <= 1_000_000_000; value += 137_000_000) {
      const width = normalizeUi({ rightSidebar: { width: value } }).rightSidebar.width;
      expect(Number.isFinite(width)).toBe(true);
      expect(width).toBeGreaterThanOrEqual(RIGHT_SIDEBAR.min);
    }
  });
});

// Проверка новой версии (V6 плана релиза 0.1.0): переключатель включён по умолчанию, закрытая версия — строка.
describe('проверка новой версии в ui.json', () => {
  it('по умолчанию включена, закрытой версии нет', () => {
    expect(DEFAULT_UI.checkForUpdates).toBe(true);
    expect(DEFAULT_UI.dismissedUpdate).toBeNull();
    expect(normalizeUi({}).checkForUpdates).toBe(true);
    expect(normalizeUi({}).dismissedUpdate).toBeNull();
  });

  it('файл прежней версии без новых ключей читается с проверкой включённой', () => {
    const old = normalizeUi({ version: 1, appearance: 'dark', lastProvider: 'claude' });
    expect(old.checkForUpdates).toBe(true);
    expect(old.dismissedUpdate).toBeNull();
    expect(old.appearance).toBe('dark');
  });

  it('выключенный переключатель и закрытая версия сохраняются как есть', () => {
    const ui = normalizeUi({ checkForUpdates: false, dismissedUpdate: '0.2.0' });
    expect(ui.checkForUpdates).toBe(false);
    expect(ui.dismissedUpdate).toBe('0.2.0');
  });

  it('значения чужого типа — по умолчанию: «выключить» может только настоящее false', () => {
    for (const garbage of [0, 1, 'false', 'off', null, {}, []]) {
      expect(normalizeUi({ checkForUpdates: garbage }).checkForUpdates, `checkForUpdates ${JSON.stringify(garbage)}`).toBe(true);
    }
    for (const garbage of [0, true, null, {}, ['0.2.0']]) {
      expect(normalizeUi({ dismissedUpdate: garbage }).dismissedUpdate, `dismissedUpdate ${JSON.stringify(garbage)}`).toBeNull();
    }
  });
});

describe('раздел voice (спека 4.1)', () => {
  it('по умолчанию выключен, модели нет, язык auto', () => {
    expect(normalizeUi({}).voice).toEqual({ enabled: false, model: null, language: 'auto' });
  });

  it('верные значения сохраняются', () => {
    expect(normalizeUi({ voice: { enabled: true, model: 'small', language: 'ru' } }).voice).toEqual({
      enabled: true,
      model: 'small',
      language: 'ru',
    });
  });

  it('чужая модель и язык — по умолчанию; включённый голос без модели — выключен', () => {
    expect(normalizeUi({ voice: { enabled: true, model: 'huge', language: 'xx' } }).voice).toEqual({
      enabled: false,
      model: null,
      language: 'auto',
    });
  });
});

// Размеры Organic (спека окна 2026-09-29, 1.1): сайдбар 288, правый 320; ресайз 220–500 прежний.
describe('размеры сайдбаров по умолчанию', () => {
  it('левый 288, правый 320 — и в DEFAULT_UI, и в константах `initial`', () => {
    expect(DEFAULT_UI.leftSidebar.width).toBe(288);
    expect(DEFAULT_UI.rightSidebar.width).toBe(320);
    expect(LEFT_SIDEBAR.initial).toBe(288);
    expect(RIGHT_SIDEBAR.initial).toBe(320);
  });

  it('пределы ресайза левого остались 220–500, правого — от 220', () => {
    expect(LEFT_SIDEBAR.min).toBe(220);
    expect(LEFT_SIDEBAR.max).toBe(500);
    expect(RIGHT_SIDEBAR.min).toBe(220);
  });

  it('сохранённая ширина прежних окон (280 и 350) не переписывается: это выбор человека', () => {
    const saved = normalizeUi({ leftSidebar: { open: true, width: 280 }, rightSidebar: { open: true, width: 350, tab: 'files' } });
    expect(saved.leftSidebar.width).toBe(280);
    expect(saved.rightSidebar.width).toBe(350);
  });
});

interface UiFileWithMystery {
  mystery?: unknown;
}

// Раунд main-r2, п. 7 (ревью 7.2-A, Important 3): центр — не меньше reserveCenter.
describe('fitRightSidebar', () => {
  it('влезает — сохранённая ширина, предел — окно − левый − reserveCenter', () => {
    expect(fitRightSidebar(350, 1400, 280)).toEqual({ width: 350, max: 800 });
  });

  it('не влезает сохранённая — ужимается до предела, но не ниже min', () => {
    expect(fitRightSidebar(500, 900, 280)).toEqual({ width: 300, max: 300 });
    expect(fitRightSidebar(350, 820, 280)).toEqual({ width: 220, max: 220 });
  });

  it('не влезает и min — null (скрыт на время): 800 px, левый 280', () => {
    expect(fitRightSidebar(350, 800, 280)).toBeNull();
  });

  it('левый закрыт (0) — место есть и на 800 px', () => {
    expect(fitRightSidebar(350, 800, 0)).toEqual({ width: 350, max: 480 });
  });

  it('вкладка правого сайдбара agents сохраняется; незнакомая читается как files', () => {
    expect(normalizeUi({ rightSidebar: { open: true, width: 320, tab: 'agents' } }).rightSidebar.tab).toBe('agents');
    expect(normalizeUi({ rightSidebar: { open: true, width: 320, tab: 'terminal' } }).rightSidebar.tab).toBe('files');
  });
});
