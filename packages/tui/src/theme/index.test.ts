/**
 * Реестр тем (дизайн темы TUI, 3.4 и 7.1): имя палитры меняется, уровень
 * цвета липкий. Общий setup тестов уже позвал `pinTheme(1)`.
 */

import { describe, expect, it } from 'vitest';
import { applyThemeConfig, theme } from './index.js';
import { PALETTES } from './palettes.js';

/** Уровень 1 отличается от 0 именно подсветкой ряда: у монохрома её нет. */
const ansiSelection = { backgroundColor: 'blackBright' };

describe('applyThemeConfig', () => {
  it('без уровня меняет палитру, но не уровень', () => {
    applyThemeConfig('nord');
    expect(theme().bg.selection).toEqual(ansiSelection);
  });

  it('явный уровень перекрывает прежний и запоминается', () => {
    applyThemeConfig('nord', 3);
    expect(theme().bg.panel).toEqual({ backgroundColor: PALETTES.nord.base });
    applyThemeConfig('gruvbox');
    expect(theme().bg.panel).toEqual({ backgroundColor: PALETTES.gruvbox.base });
  });

  it('`terminal` не опускает уровень навсегда: возврат к палитре красит снова', () => {
    applyThemeConfig('mocha', 3);
    applyThemeConfig('terminal');
    expect(theme().bg.selection).toEqual(ansiSelection);
    expect(theme().fills).toBe(false);
    applyThemeConfig('mocha');
    expect(theme().bg.panel).toEqual({ backgroundColor: PALETTES.mocha.base });
    expect(theme().fills).toBe(true);
  });

  it('неизвестное имя — молча дефолт, уровень не трогается', () => {
    applyThemeConfig('такой-темы-нет', 3);
    expect(theme().bg.panel).toEqual({ backgroundColor: PALETTES.mocha.base });
  });
});
