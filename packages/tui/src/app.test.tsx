import {
  addSession,
  createWork,
  readMap,
  readWorksIndex,
  transitionSession,
  updateMap,
  workPaths,
} from '@harnas/core';
import { render } from 'ink-testing-library';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pinUnicodeGlyphs } from '../test/glyphs-env.js';
import { App } from './app.js';
import { createPendingSession } from './work-launch.js';

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

  it('ДЕТАЛИ показывают выбранную сессию, а не работу (дизайн 3)', async () => {
    const created = await createWork(project, { title: 'Авторизация', goal: 'логин по e-mail' });
    await updateMap(project, created.work.id, (map) => {
      addSession(map, { provider: 'codex', label: 'бэкенд', task: 'реализовать шаги 1–3' });
    });

    const app = render(<App sessions={[]} projectPath={project} />);
    await press(app, 'w');
    await waitFor(() => (app.lastFrame() ?? '').includes('бэкенд'));
    // Выбрана работа — в панели её сводка.
    expect(app.lastFrame()).toContain('логин по e-mail');

    await press(app, 'j');
    // Панель меряет свою высоту эффектом, поэтому секции появляются не первым
    // кадром: ждём последнюю из них, а не первую.
    await waitFor(() => (app.lastFrame() ?? '').includes('ист:'));
    const frame = app.lastFrame() ?? '';
    expect(frame).toContain('реализовать шаги');
    expect(frame).toContain('ДЕТАЛИ — бэкенд');
    // Задача, статус, отсутствие отчёта и история — секции панели (дизайн 3).
    expect(lineWith(frame, 'pending')).toContain('◌');
    expect(frame).toContain('(отчёта нет)');
    expect(frame).toContain('ист: ◌');
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
});

describe('диалоги, запуск и жизненный цикл', () => {
  const previousBin = process.env.HARNAS_CLAUDE_BIN;
  let logs = '';

  beforeEach(async () => {
    // Корень истории — пустой временный каталог: настоящий ~/.claude не читаем.
    logs = await mkdtemp(path.join(tmpdir(), 'harnas-logs-'));
    process.env.HARNAS_CLAUDE_BIN = STUB;
    process.env.HARNAS_CODEX_BIN = STUB;
  });

  afterEach(async () => {
    if (previousBin === undefined) delete process.env.HARNAS_CLAUDE_BIN;
    else process.env.HARNAS_CLAUDE_BIN = previousBin;
    delete process.env.HARNAS_CODEX_BIN;
    await rm(logs, { recursive: true, force: true });
  });

  const ENTER = '\r';
  const ESC = '\u001B';

  const open = (): ReturnType<typeof render> =>
    render(<App sessions={[]} root={logs} projectPath={project} />);

  const works = async (app: ReturnType<typeof render>): Promise<void> => {
    await press(app, 'w');
    await waitFor(() => (app.lastFrame() ?? '').includes('РАБОТЫ'));
  };

  /** Ждём состояния карты: запись идёт после кадра с запущенным агентом. */
  const waitMap = async (workId: string, check: (status: string) => boolean): Promise<void> => {
    const started = Date.now();
    for (;;) {
      const session = (await readMap(project, workId)).sessions[0];
      if (session !== undefined && check(session.status)) return;
      if (Date.now() - started > 8000) throw new Error('карта не дождалась');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };

  it('N создаёт работу через диалог (4.1)', async () => {
    const app = open();
    try {
      await works(app);
      await press(app, 'N');
      await waitFor(() => (app.lastFrame() ?? '').includes('НОВАЯ РАБОТА'));
      // Проект в диалоге не выбирается — он всегда cwd харнесса (решение №9).
      expect(app.lastFrame()).toContain('Проект:');

      // Диалог модален: `w` печатается в поле, а не переключает режим колонки.
      await press(app, 'w');
      await press(app, 'Платежи');
      await waitFor(() => (app.lastFrame() ?? '').includes('wПлатежи'));
      expect(app.lastFrame()).toContain('РАБОТЫ');
      await press(app, ENTER);
      await press(app, ENTER);

      await waitFor(() => (app.lastFrame() ?? '').includes('РАБОТЫ (1)'));
      // Диалог закрылся, на его месте снова ДЕТАЛИ.
      expect(app.lastFrame()).toContain('ДЕТАЛИ');
      const index = await readWorksIndex();
      expect(index.works.map((work) => work.title)).toEqual(['wПлатежи']);
    } finally {
      app.unmount();
    }
  }, 30_000);

  it('Esc закрывает диалог, не создавая работы', async () => {
    const app = open();
    try {
      await works(app);
      await press(app, 'N');
      await waitFor(() => (app.lastFrame() ?? '').includes('НОВАЯ РАБОТА'));
      await press(app, ESC);
      await waitFor(() => !(app.lastFrame() ?? '').includes('НОВАЯ РАБОТА'));

      expect((await readWorksIndex()).works).toEqual([]);
    } finally {
      app.unmount();
    }
  }, 30_000);

  it('n в режиме работ создаёт pending сессию с брифом (4.2)', async () => {
    const created = await createWork(project, { title: 'Авторизация' });
    const app = open();
    try {
      await works(app);
      await press(app, 'n');
      await waitFor(() => (app.lastFrame() ?? '').includes('НОВАЯ СЕССИЯ'));
      expect(app.lastFrame()).toContain('Провайдер');
      // Настоящий агент не запускается: диалог живёт в левой колонке, а фокус
      // остаётся на списках — правая панель по-прежнему с подсказкой.
      expect(app.lastFrame()).not.toContain('stub готов');
      expect(app.lastFrame()).toContain('Enter на сессии');

      await press(app, ENTER);
      await press(app, 'тесты');
      await press(app, ENTER);
      await press(app, 'прогнать e2e');
      await press(app, ENTER);

      await waitFor(() => (app.lastFrame() ?? '').includes('тесты'));
      const map = await readMap(project, created.work.id);
      expect(map.sessions).toHaveLength(1);
      expect(map.sessions[0]?.status).toBe('pending');
      const brief = await readFile(
        path.join(workPaths(project, created.work.id).briefs, `${map.sessions[0]?.id}.md`),
        'utf8',
      );
      expect(brief).toContain('прогнать e2e');
    } finally {
      app.unmount();
    }
  }, 30_000);

  it('Enter на ◌ показывает бриф и запускает агента с командой из реестра (4.3)', async () => {
    const created = await createWork(project, { title: 'Авторизация' });
    const workId = created.work.id;
    const sessionId = await createPendingSession(project, workId, {
      provider: 'claude',
      label: 'тесты',
      task: 'прогнать e2e',
    });

    const app = open();
    try {
      await works(app);
      await press(app, 'j');
      await waitFor(() => (app.lastFrame() ?? '').includes('ДЕТАЛИ — тесты'));

      await press(app, ENTER);
      await waitFor(() => (app.lastFrame() ?? '').includes('ЗАПУСК'));
      const dialog = app.lastFrame() ?? '';
      expect(dialog).toContain(`бриф: briefs/${sessionId}.md`);
      // Тело диалога — первые строки брифа с диска.
      expect(dialog).toContain('Авторизация');
      expect(dialog).not.toContain('stub готов');

      await press(app, ENTER);
      await waitFor(() => (app.lastFrame() ?? '').includes('stub готов'));
      // Окружение сессии доехало до процесса: по нему MCP-сервер узнаёт звонящего.
      await waitFor(() => (app.lastFrame() ?? '').includes(`harnas=${sessionId}@${workId}`));
      expect(app.lastFrame()).toContain('--session-id');

      await waitMap(workId, (status) => status === 'active');
      const session = (await readMap(project, workId)).sessions[0];
      expect(session?.providerSessionId).toMatch(/^[0-9a-f]{8}-/);
    } finally {
      app.unmount();
    }
  }, 30_000);

  it('выход процесса переводит сессию в exited с кодом выхода', async () => {
    const created = await createWork(project, { title: 'Авторизация' });
    const workId = created.work.id;
    await createPendingSession(project, workId, {
      provider: 'claude',
      label: 'тесты',
      task: 'прогнать e2e',
    });

    const app = open();
    try {
      await works(app);
      await press(app, 'j');
      await waitFor(() => (app.lastFrame() ?? '').includes('ДЕТАЛИ — тесты'));
      await press(app, ENTER);
      await waitFor(() => (app.lastFrame() ?? '').includes('ЗАПУСК'));
      await press(app, ENTER);
      await waitFor(() => (app.lastFrame() ?? '').includes('stub готов'));
      await waitMap(workId, (status) => status === 'active');

      // Фокус после запуска в терминале — ввод идёт агенту.
      app.stdin.write('exit 3\r');
      await waitMap(workId, (status) => status === 'exited');

      const session = (await readMap(project, workId)).sessions[0];
      expect(session?.history.at(-1)).toMatchObject({ status: 'exited', exitCode: 3 });
    } finally {
      app.unmount();
    }
  }, 30_000);

  it('Enter на живой сессии вне харнесса объясняет, что attach невозможен', async () => {
    const created = await createWork(project, { title: 'Авторизация' });
    await updateMap(project, created.work.id, (map) => {
      const session = addSession(map, { provider: 'codex', label: 'бэкенд', task: 'шаги 1–3' });
      transitionSession(map, session.id, 'active');
    });

    const app = open();
    try {
      await works(app);
      await press(app, 'j');
      await waitFor(() => (app.lastFrame() ?? '').includes('ДЕТАЛИ — бэкенд'));

      await press(app, ENTER);
      await waitFor(() => (app.lastFrame() ?? '').includes('вне харнесса'));
      // Диалога при этом нет: живая сессия открывается справа, а не спрашивает.
      expect(app.lastFrame()).not.toContain('ВОЗОБНОВИТЬ');
      expect(app.lastFrame()).not.toContain('stub готов');
    } finally {
      app.unmount();
    }
  }, 30_000);

  it('Enter на вышедшей сессии предлагает возобновление (4.4)', async () => {
    const created = await createWork(project, { title: 'Авторизация' });
    const workId = created.work.id;
    const sessionId = await createPendingSession(project, workId, {
      provider: 'codex',
      label: 'бэкенд',
      task: 'шаги 1–3',
    });
    await updateMap(project, workId, (map) => {
      const session = transitionSession(map, sessionId, 'active');
      session.providerSessionId = '7fa0e1ee-cc7b-4a1e-9d4e-000000000001';
      transitionSession(map, sessionId, 'exited', { exitCode: 0 });
    });

    const app = open();
    try {
      await works(app);
      await press(app, 'j');
      await waitFor(() => (app.lastFrame() ?? '').includes('ДЕТАЛИ — бэкенд'));

      await press(app, ENTER);
      await waitFor(() => (app.lastFrame() ?? '').includes('ВОЗОБНОВИТЬ'));
      const dialog = app.lastFrame() ?? '';
      expect(dialog).toContain('resume');
      expect(dialog).toContain('код 0');
      expect(dialog).toContain('отчёта не было');

      await press(app, ENTER);
      await waitFor(() => (app.lastFrame() ?? '').includes('stub готов'));
      await waitMap(workId, (status) => status === 'active');

      const session = (await readMap(project, workId)).sessions[0];
      // Id сессии в карте тот же, прежний id у провайдера не потерян.
      expect(session?.id).toBe(sessionId);
      expect(session?.providerSessionId).toBe('7fa0e1ee-cc7b-4a1e-9d4e-000000000001');
    } finally {
      app.unmount();
    }
  }, 30_000);
});
