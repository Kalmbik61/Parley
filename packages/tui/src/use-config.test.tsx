/**
 * Настройки в работе: `update` пишет файл и применяет значение без перезапуска
 * харнесса (дизайн TUI v2, 3.4; план от 2026-09-18). Тема применяется тем же
 * приёмом, что и `ascii` (дизайн темы TUI, раздел 6; план кусок 2, задача D).
 *
 * Настоящий `~/.harnas` здесь не трогается: `HARNAS_HOME` — временный каталог.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { HarnasConfig } from '@harnas/core';
import { Text, useInput } from 'ink';
import { render } from 'ink-testing-library';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ReactNode } from 'react';
import { pinTheme } from '../test/theme-env.js';
import { theme } from './theme/index.js';
import { PALETTES } from './theme/palettes.js';
import { useConfig } from './use-config.js';
import type { StatusEventInit } from './use-status.js';

let home = '';

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'harnas-config-'));
  process.env['HARNAS_HOME'] = home;
});

afterEach(async () => {
  delete process.env['HARNAS_HOME'];
  await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

const waitFor = async (check: () => boolean, timeoutMs = 8000): Promise<void> => {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('не дождались');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

/** Ink подписывается на stdin эффектом: до подписки запись теряется молча. */
const mounted = async (app: ReturnType<typeof render>): Promise<void> => {
  await waitFor(() => app.stdin.listenerCount('readable') > 0);
  await new Promise((resolve) => setTimeout(resolve, 120));
};

/** Проба показывает значение настройки, а по любой клавише зовёт `update`. */
function Probe({
  events,
  patch,
}: {
  events: StatusEventInit[];
  patch: Partial<HarnasConfig>;
}): ReactNode {
  const { config, update } = useConfig((incoming) => events.push(...incoming));
  useInput(() => update(patch));
  return <Text>{`autoLaunch=${String(config.autoLaunch)} theme=${config.theme}`}</Text>;
}

// Роли уровней 1 и 0 палитры по цвету не различают: тестам ниже, которые
// сверяют `theme()` с конкретной палитрой, нужен уровень с настоящим hex.
pinTheme(3);

describe('useConfig', () => {
  it('update пишет файл и применяет значение без перезапуска', async () => {
    const events: StatusEventInit[] = [];
    const app = render(<Probe events={events} patch={{ autoLaunch: false }} />);
    try {
      await mounted(app);
      expect(app.lastFrame()).toContain('autoLaunch=true');

      app.stdin.write('u');
      await waitFor(() => (app.lastFrame() ?? '').includes('autoLaunch=false'));

      const written: unknown = JSON.parse(
        await readFile(path.join(home, 'config.json'), 'utf8'),
      ) as unknown;
      expect(written).toEqual({ autoLaunch: false });
    } finally {
      app.unmount();
    }
  }, 30_000);

  it('ошибка записи — событие, значение прежнее', async () => {
    // `HARNAS_HOME` — файл, а не каталог: `mkdir` под него не встанет.
    const file = path.join(home, 'не-каталог');
    await writeFile(file, 'я файл\n', 'utf8');
    process.env['HARNAS_HOME'] = file;

    const events: StatusEventInit[] = [];
    const app = render(<Probe events={events} patch={{ autoLaunch: false }} />);
    try {
      await mounted(app);
      app.stdin.write('u');
      await waitFor(() => events.some((event) => event.text.includes('не записался')));
      expect(app.lastFrame()).toContain('autoLaunch=true');
    } finally {
      app.unmount();
    }
  }, 30_000);

  it('при загрузке применяет тему: theme() отдаёт роли выбранной палитры', async () => {
    await writeFile(path.join(home, 'config.json'), JSON.stringify({ theme: 'nord' }), 'utf8');
    const events: StatusEventInit[] = [];
    const app = render(<Probe events={events} patch={{}} />);
    try {
      await mounted(app);
      expect(app.lastFrame()).toContain('theme=nord');
      expect(theme().bg.panel).toEqual({ backgroundColor: PALETTES.nord.base });
      expect(theme().fills).toBe(true);
    } finally {
      app.unmount();
    }
  }, 30_000);

  it('update({ theme }) пишет файл и применяет тему без перезапуска', async () => {
    const events: StatusEventInit[] = [];
    const app = render(<Probe events={events} patch={{ theme: 'gruvbox' }} />);
    try {
      await mounted(app);
      expect(app.lastFrame()).toContain('theme=mocha');

      app.stdin.write('u');
      await waitFor(() => (app.lastFrame() ?? '').includes('theme=gruvbox'));

      const written: unknown = JSON.parse(
        await readFile(path.join(home, 'config.json'), 'utf8'),
      ) as unknown;
      expect(written).toEqual({ theme: 'gruvbox' });
      expect(theme().bg.panel).toEqual({ backgroundColor: PALETTES.gruvbox.base });
    } finally {
      app.unmount();
    }
  }, 30_000);

  it('ошибка записи темы не меняет ни состояние, ни theme()', async () => {
    // `HARNAS_HOME` — файл, а не каталог: `mkdir` под него не встанет.
    const file = path.join(home, 'не-каталог');
    await writeFile(file, 'я файл\n', 'utf8');
    process.env['HARNAS_HOME'] = file;

    const events: StatusEventInit[] = [];
    const app = render(<Probe events={events} patch={{ theme: 'nord' }} />);
    try {
      await mounted(app);
      app.stdin.write('u');
      await waitFor(() => events.some((event) => event.text.includes('не записался')));
      expect(app.lastFrame()).toContain('theme=mocha');
      expect(theme().bg.panel).toEqual({ backgroundColor: PALETTES.mocha.base });
    } finally {
      app.unmount();
    }
  }, 30_000);
});
