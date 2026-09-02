import { addSession, createWork, updateMap } from '@harnas/core';
import { render } from 'ink-testing-library';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pinUnicodeGlyphs } from '../test/glyphs-env.js';
import { App } from './app.js';

/** Настоящий агент в тестах не запускается никогда (specs/pty.md). */
const STUB = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'test',
  'stub-agent.mjs',
);

const lineWith = (frame: string, text: string): string =>
  frame.split('\n').find((line) => line.includes(text)) ?? '';

pinUnicodeGlyphs();

let home = '';
let project = '';

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'harnas-home-'));
  project = await mkdtemp(path.join(tmpdir(), 'harnas-project-'));
  process.env.HARNAS_HOME = home;
});

afterEach(async () => {
  delete process.env.HARNAS_HOME;
  await Promise.all([home, project].map((dir) => rm(dir, { recursive: true, force: true })));
});

const waitFor = async (check: () => boolean, timeoutMs = 8000): Promise<void> => {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('не дождались');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

/**
 * Ink подписывается на stdin эффектом, а эффекты React выполняет уже после того,
 * как кадр отрисован: между появлением кадра и готовностью обработчика клавиш
 * есть зазор. Поэтому перед каждым нажатием ждём — иначе клавиша достаётся
 * обработчику прошлого рендера.
 */
const press = async (app: { stdin: { write: (data: string) => void } }, key: string) => {
  await new Promise((resolve) => setTimeout(resolve, 150));
  app.stdin.write(key);
};

describe('App', () => {
  it('рисует три панели и число сессий', () => {
    const { lastFrame } = render(<App sessions={[]} projectPath={project} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('SESSIONS (0)');
    expect(frame).toContain('SUBSESSIONS');
    expect(frame).toContain('TERMINAL');
  });

  it('пока ничего не открыто — правая панель подсказывает, что делать', () => {
    const { lastFrame } = render(<App sessions={[]} projectPath={project} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Enter на сессии');
    expect(frame).toContain('Ctrl+Q');
  });

  it('строка статуса со шпаргалкой стоит внизу в обоих режимах', async () => {
    const app = render(<App sessions={[]} projectPath={project} />);

    const bottom = (): string => (app.lastFrame() ?? '').split('\n').at(-1) ?? '';
    expect(bottom()).toContain('w · Ctrl+Q');

    await press(app, 'w');
    await waitFor(() => (app.lastFrame() ?? '').includes('РАБОТЫ'));
    expect(bottom()).toContain('w · Ctrl+Q');
    app.unmount();
  }, 20_000);
});

describe('режим работ', () => {
  it('w переключает левую колонку на работы и обратно', async () => {
    const created = await createWork(project, { title: 'Авторизация' });
    await updateMap(project, created.work.id, (map) => {
      addSession(map, { provider: 'codex', label: 'бэкенд', task: 'шаги 1–3' });
    });

    const app = render(<App sessions={[]} projectPath={project} />);
    await press(app, 'w');
    await waitFor(() => (app.lastFrame() ?? '').includes('РАБОТЫ (1)'));
    const frame = app.lastFrame() ?? '';
    expect(frame).toContain('Авторизация');
    expect(frame).toContain('бэкенд');
    // Нижняя панель в этом режиме — ДЕТАЛИ, а не подсессии (дизайн 1).
    expect(frame).toContain('ДЕТАЛИ');
    expect(frame).not.toContain('SUBSESSIONS');

    await press(app, 'w');
    await waitFor(() => (app.lastFrame() ?? '').includes('SESSIONS (0)'));
    expect(app.lastFrame()).toContain('SUBSESSIONS');
    app.unmount();
  }, 20_000);

  it('без единой работы режим объясняет, что делать', async () => {
    const app = render(<App sessions={[]} projectPath={project} />);
    await press(app, 'w');
    await waitFor(() => (app.lastFrame() ?? '').includes('РАБОТЫ (0)'));
    expect(app.lastFrame()).toContain('Работ нет.');
    app.unmount();
  }, 20_000);

  it('Enter на работе сворачивает и разворачивает её', async () => {
    const created = await createWork(project, { title: 'Авторизация' });
    await updateMap(project, created.work.id, (map) => {
      addSession(map, { provider: 'codex', label: 'бэкенд', task: 'шаги 1–3' });
    });

    const app = render(<App sessions={[]} projectPath={project} />);
    await press(app, 'w');
    await waitFor(() => (app.lastFrame() ?? '').includes('бэкенд'));

    await press(app, '\r');
    await waitFor(() => !(app.lastFrame() ?? '').includes('бэкенд'));
    // Фокус остался на списках: правая панель по-прежнему с подсказкой.
    expect(app.lastFrame()).toContain('Enter на сессии');

    await press(app, '\r');
    await waitFor(() => (app.lastFrame() ?? '').includes('бэкенд'));

    // h сворачивает ту же работу, l разворачивает (дизайн 8).
    await press(app, 'h');
    await waitFor(() => !(app.lastFrame() ?? '').includes('бэкенд'));
    await press(app, 'l');
    await waitFor(() => (app.lastFrame() ?? '').includes('бэкенд'));
    app.unmount();
  }, 20_000);

  it('клавиши дерева работ ничего не делают в режиме «все сессии» (дизайн 8)', async () => {
    const created = await createWork(project, { title: 'Авторизация' });
    await updateMap(project, created.work.id, (map) => {
      addSession(map, { provider: 'codex', label: 'бэкенд', task: 'шаги 1–3' });
    });

    const app = render(<App sessions={[]} projectPath={project} />);
    // Сначала убеждаемся, что работа прочитана и развёрнута.
    await press(app, 'w');
    await waitFor(() => (app.lastFrame() ?? '').includes('бэкенд'));
    await press(app, 'w');
    await waitFor(() => (app.lastFrame() ?? '').includes('SESSIONS (0)'));

    // В чужом режиме h и l трогать дерево не должны: выбранная строка — индекс
    // списка сессий, по нему свернулась бы посторонняя работа.
    await press(app, 'h');
    await press(app, 'l');
    await press(app, 'h');

    await press(app, 'w');
    await waitFor(() => (app.lastFrame() ?? '').includes('РАБОТЫ (1)'));
    expect(app.lastFrame()).toContain('бэкенд');
    expect(lineWith(app.lastFrame() ?? '', 'Авторизация')).toContain('▾');
    app.unmount();
  }, 20_000);

  it('n в режиме работ не запускает агента (диалог 4.2 — отдельная задача)', async () => {
    const previousBin = process.env.HARNAS_CLAUDE_BIN;
    // Даже если бы клавиша сработала, запустился бы stub, а не настоящий агент.
    process.env.HARNAS_CLAUDE_BIN = STUB;
    const created = await createWork(project, { title: 'Авторизация' });
    await updateMap(project, created.work.id, (map) => {
      addSession(map, { provider: 'codex', label: 'бэкенд', task: 'шаги 1–3' });
    });

    const app = render(<App sessions={[]} projectPath={project} />);
    try {
      await press(app, 'w');
      await waitFor(() => (app.lastFrame() ?? '').includes('РАБОТЫ (1)'));

      await press(app, 'n');
      await new Promise((resolve) => setTimeout(resolve, 500));

      expect(app.lastFrame()).not.toContain('stub готов');
      // Правая панель по-прежнему с подсказкой, фокус остался на списках.
      expect(app.lastFrame()).toContain('Enter на сессии');
    } finally {
      if (previousBin === undefined) delete process.env.HARNAS_CLAUDE_BIN;
      else process.env.HARNAS_CLAUDE_BIN = previousBin;
      app.unmount();
    }
  }, 20_000);
});
