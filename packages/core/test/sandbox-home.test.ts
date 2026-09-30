import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Песочница дома (`sandbox-home.ts`): хост Parley экспортирует агентам `PARLEY_HOME` и `HARNAS_HOME`, а тесты гонят
 * и из сессии такого агента. Унаследованный дом перекрыл бы подмену `HOME`: запись из недосчитанного промиса после
 * `afterEach` (ровно то, от чего песочница нужна) ушла бы в настоящий `~/.parley`, а не во временный каталог.
 */

const saved = {
  parley: process.env['PARLEY_HOME'],
  harnas: process.env['HARNAS_HOME'],
  home: process.env['HOME'],
};

afterEach(() => {
  for (const [name, value] of [
    ['PARLEY_HOME', saved.parley],
    ['HARNAS_HOME', saved.harnas],
    ['HOME', saved.home],
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe('песочница дома', () => {
  it('унаследованные PARLEY_HOME и HARNAS_HOME снимаются, HOME — временный каталог процесса', async () => {
    process.env['PARLEY_HOME'] = '/настоящий/дом/parley';
    process.env['HARNAS_HOME'] = '/настоящий/дом/harnas';
    process.env['HOME'] = '/настоящий/человек';

    // Файл настройки исполняется при импорте; сбрасываем кэш модулей, чтобы он отработал ещё раз.
    vi.resetModules();
    await import('./sandbox-home.js');

    expect(process.env['PARLEY_HOME']).toBeUndefined();
    expect(process.env['HARNAS_HOME']).toBeUndefined();
    expect(process.env['HOME']).toBe(process.env['PARLEY_TEST_HOME']);
    expect(process.env['USERPROFILE']).toBe(process.env['PARLEY_TEST_HOME']);
  });
});
