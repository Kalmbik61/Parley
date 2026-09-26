import { describe, expect, it } from 'vitest';
import { PALETTES } from '../../theme/palettes.js';
import { paletteToXtermTheme, themeNameToXtermTheme } from './xterm-theme.js';

describe('paletteToXtermTheme', () => {
  it('фон, текст и выделение берутся из палитры как есть', () => {
    const theme = paletteToXtermTheme(PALETTES.mocha);
    expect(theme.background).toBe(PALETTES.mocha.base);
    expect(theme.foreground).toBe(PALETTES.mocha.text);
    expect(theme.selectionBackground).toBe(PALETTES.mocha.selection);
    expect(theme.red).toBe(PALETTES.mocha.red);
  });

  it('bright-цветов в палитре нет — используются обычные', () => {
    const theme = paletteToXtermTheme(PALETTES.nord);
    expect(theme.brightRed).toBe(PALETTES.nord.red);
    expect(theme.brightBlue).toBe(PALETTES.nord.blue);
  });
});

describe('themeNameToXtermTheme', () => {
  it('известное имя — своя палитра', () => {
    expect(themeNameToXtermTheme('gruvbox').background).toBe(PALETTES.gruvbox.base);
  });

  it('«terminal» и неизвестное имя — mocha, как в apply-theme', () => {
    expect(themeNameToXtermTheme('terminal').background).toBe(PALETTES.mocha.base);
    expect(themeNameToXtermTheme('вымышленная').background).toBe(PALETTES.mocha.base);
  });
});
