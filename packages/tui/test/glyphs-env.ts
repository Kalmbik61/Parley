/**
 * Набор глифов компоненты берут из окружения (дизайн 6.1): под `LC_ALL=C` они
 * рисуют ASCII-замены, и кадры тестов зависели бы от локали машины или образа CI.
 * Тесты рисования фиксируют Unicode явно и возвращают окружение как было.
 */

import { afterEach, beforeEach } from 'vitest';

const restore = (name: string, value: string | undefined): void => {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
};

export function pinUnicodeGlyphs(): void {
  const saved = { locale: process.env['LC_ALL'], ascii: process.env['HARNAS_ASCII'] };

  beforeEach(() => {
    process.env['LC_ALL'] = 'ru_RU.UTF-8';
    delete process.env['HARNAS_ASCII'];
  });

  afterEach(() => {
    restore('LC_ALL', saved.locale);
    restore('HARNAS_ASCII', saved.ascii);
  });
}
