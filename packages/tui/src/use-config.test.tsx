/**
 * Настройки в работе: `update` пишет файл и применяет значение без перезапуска
 * харнесса (дизайн TUI v2, 3.4; план от 2026-09-18).
 *
 * Настоящий `~/.harnas` здесь не трогается: `HARNAS_HOME` — временный каталог.
 */

import type { HarnasConfig } from '@harnas/core';
import { Text, useInput } from 'ink';
import { render } from 'ink-testing-library';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
  return <Text>{`autoLaunch=${String(config.autoLaunch)}`}</Text>;
}

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
});
