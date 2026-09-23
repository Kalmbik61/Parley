/**
 * Сценарии композиции: `new`, авто-заголовок, события и закрытие сессии
 * (чек-лист спецификации TUI v2, пункты 27–30 и 32).
 *
 * Настоящий `claude` здесь не запускается никогда: вместо него stub-бинарь,
 * а `~/.harnas`, проект и корни истории — во временных каталогах.
 */

import {
  addMessage,
  addSession,
  createWork,
  harnasHome,
  readMap,
  readWorksIndex,
  transitionSession,
  updateMap,
  workPaths,
  type SessionIndex,
  type WorkSession,
} from '@harnas/core';
import { render } from 'ink-testing-library';
import { execFile } from 'node:child_process';
import { appendFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pinUnicodeGlyphs } from '../test/glyphs-env.js';
import { App } from './app.js';
import { createPendingSession } from './work-launch.js';

const STUB = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'test',
  'stub-agent.mjs',
);

/** Префикс харнесса и его действия (дизайн 3.1–3.2). */
const PREFIX = String.fromCharCode(0x11);
const PREFIX_NAME = 'ctrl+q';
const ENTER = '\r';
const ESC = '\u001B';

pinUnicodeGlyphs();

let home = '';
let project = '';
let logs = '';
const previousBin = process.env['HARNAS_CLAUDE_BIN'];

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'harnas-home-'));
  project = await mkdtemp(path.join(tmpdir(), 'harnas-project-'));
  logs = await mkdtemp(path.join(tmpdir(), 'harnas-logs-'));
  process.env['HARNAS_HOME'] = home;
  process.env['HARNAS_CLAUDE_BIN'] = STUB;
});

afterEach(async () => {
  delete process.env['HARNAS_HOME'];
  if (previousBin === undefined) delete process.env['HARNAS_CLAUDE_BIN'];
  else process.env['HARNAS_CLAUDE_BIN'] = previousBin;
  // Stub мог дописывать файлы работы в момент уборки: без повторов `rm` падает
  // с ENOTEMPTY, когда каталог пополнился между чтением и удалением.
  const clean = { recursive: true, force: true, maxRetries: 5, retryDelay: 50 };
  await Promise.all([home, project, logs].map((dir) => rm(dir, clean)));
});

/** Ожидание условия, за которым надо сходить на диск: карта или индекс работ. */
const waitFor2 = async (check: () => Promise<boolean>, timeoutMs = 8000): Promise<void> => {
  const started = Date.now();
  while (!(await check())) {
    if (Date.now() - started > timeoutMs) throw new Error('не дождались');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

const waitFor = async (check: () => boolean, timeoutMs = 8000): Promise<void> => {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('не дождались');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

/** Ink подписывается на stdin эффектом: до подписки запись теряется молча. */
const mounted = async (stdin: { listenerCount: (event: string) => number }): Promise<void> => {
  await waitFor(() => stdin.listenerCount('data') > 0 || stdin.listenerCount('readable') > 0);
  await new Promise((resolve) => setTimeout(resolve, 100));
};

const pathExists = (file: string): Promise<boolean> =>
  stat(file).then(
    () => true,
    () => false,
  );

const lineWith = (frame: string, text: string): string =>
  frame.split('\n').find((line) => line.includes(text)) ?? '';

const open = (sessions: SessionIndex[] = []): ReturnType<typeof render> =>
  render(<App sessions={sessions} root={logs} codexRoot={logs} projectPath={project} />);

/** Ждём состояния карты: запись идёт после кадра с запущенным агентом. */
const waitMap = async (
  workId: string,
  check: (session: WorkSession) => boolean,
  timeoutMs = 8000,
): Promise<WorkSession> => {
  const started = Date.now();
  for (;;) {
    const session = (await readMap(project, workId)).sessions[0];
    if (session !== undefined && check(session)) return session;
    if (Date.now() - started > timeoutMs) throw new Error('карта не дождалась');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

/** Сессия работы по признаку: в этих сценариях их в карте несколько. */
const waitSession = async (
  workId: string,
  pick: (session: WorkSession) => boolean,
  timeoutMs = 8000,
): Promise<WorkSession> => {
  const started = Date.now();
  for (;;) {
    const found = (await readMap(project, workId)).sessions.find(pick);
    if (found !== undefined) return found;
    if (Date.now() - started > timeoutMs) throw new Error('карта не дождалась');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

/** Живая сессия, поднятая не харнессом: её состояние ведут хуки. */
const outsideSession = async (label: string): Promise<{ workId: string; id: string }> => {
  const created = await createWork(project, { title: 'Авторизация' });
  let id = '';
  await updateMap(project, created.work.id, (map) => {
    const session = addSession(map, { provider: 'claude', label, task: 'шаги 1–3' });
    transitionSession(map, session.id, 'active');
    id = session.id;
  });
  await mkdir(workPaths(project, created.work.id).events, { recursive: true });
  return { workId: created.work.id, id };
};

const firstWorkId = async (): Promise<string> => {
  const { works } = await readWorksIndex();
  const first = works[0];
  if (first === undefined) throw new Error('работ нет');
  return first.id;
};

/** Индекс лога провайдера: из него берётся заголовок Claude Code (5.1). */
function logIndex(id: string, title: string): SessionIndex {
  return {
    id,
    project: '-tmp',
    projectPath: project,
    cwd: project,
    gitBranch: 'main',
    version: '2.1.247',
    file: path.join(logs, `${id}.jsonl`),
    title,
    titleSource: 'ai',
    startedAt: '2026-09-05T09:00:00.000Z',
    endedAt: '2026-09-05T09:10:00.000Z',
    lastUserRecordAt: null,
    durationMs: 600_000,
    records: 5,
    malformedLines: 0,
    models: {},
    tools: {},
    roles: {},
    recordTypes: {},
    primaryModel: 'claude-opus-5',
    subsessionCount: 0,
    provider: 'claude',
    tokens: null,
  };
}

/** Общее начало сценариев 27, 28 и 32: `prefix c` поднимает stub в панели. */
const launch = async (app: ReturnType<typeof render>): Promise<string> => {
  await mounted(app.stdin);
  app.stdin.write(`${PREFIX}c`);
  await waitFor(() => (app.lastFrame() ?? '').includes('stub готов'));
  // Работа приходит из watcher: до её кадра клавишам харнесса не о чем говорить.
  await waitFor(() => (app.lastFrame() ?? '').includes('сессии · '));
  await new Promise((resolve) => setTimeout(resolve, 100));
  return firstWorkId();
};

describe('new: быстрая сессия без диалога (5.1)', () => {
  it('27: без работ заводит работу «без названия» и запускает агента с хуками', async () => {
    const app = open();
    try {
      const workId = await launch(app);
      const session = await waitMap(workId, (item) => item.status === 'active');

      // Работа создана автоматически, с пустой целью (5.1).
      const { works } = await readWorksIndex();
      expect(works).toHaveLength(1);
      expect(works[0]?.title).toBe('без названия');

      // Аргументы реестра доехали до бинаря: id сессии, MCP и файл хуков.
      const frame = app.lastFrame() ?? '';
      expect(frame).toContain('flags=--session-id,--mcp-config,--settings');
      // Окружение: по нему хук и MCP-сервер узнают, кто звонит.
      expect(frame).toContain(`harnas=${session.id}@${workId}`);

      expect(session.launchedBy).toBe('tui');
      expect(session.pid).toBeGreaterThan(0);
      expect(session.providerSessionId).toMatch(/^[0-9a-f]{8}-/);
      // Бриф быстрой сессии не пишется: она стартует без промпта (5.1).
      expect(frame).not.toContain('{prompt}');
    } finally {
      app.unmount();
    }
  }, 30_000);

  it('28: заголовок Claude Code один раз переименовывает сессию и работу', async () => {
    const app = open();
    try {
      const workId = await launch(app);
      const session = await waitMap(workId, (item) => item.providerSessionId !== null);
      const uuid = session.providerSessionId as string;

      app.rerender(
        <App
          sessions={[logIndex(uuid, 'Починить сборку')]}
          root={logs}
          codexRoot={logs}
          projectPath={project}
        />,
      );
      await waitMap(workId, (item) => item.label === 'Починить сборку');
      expect((await readMap(project, workId)).work.title).toBe('Починить сборку');

      // Ручное переименование авто-заголовок больше не трогает (5.1).
      await updateMap(project, workId, (map) => {
        const target = map.sessions[0];
        if (target !== undefined) target.label = 'мой ярлык';
      });
      app.rerender(
        <App
          sessions={[logIndex(uuid, 'Совсем другой заголовок')]}
          root={logs}
          codexRoot={logs}
          projectPath={project}
        />,
      );
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect((await readMap(project, workId)).sessions[0]?.label).toBe('мой ярлык');
    } finally {
      app.unmount();
    }
  }, 30_000);
});

describe('навигация по сайдбару (3.2, макеты 1.5 и §8)', () => {
  /** Работа с одной `pending`-сессией: процессов такой сценарий не поднимает. */
  const workWith = async (title: string, label: string): Promise<string> => {
    const created = await createWork(project, { title });
    await updateMap(project, created.work.id, (map) => {
      addSession(map, { provider: 'claude', label, task: '' });
    });
    return created.work.id;
  };

  it('курсор доходит до строк работ: Enter выбирает работу и открывает её сессии', async () => {
    await workWith('Авторизация', 'план');
    // Работы идут в порядке создания: первая создана — первая в сайдбаре и
    // выбрана по умолчанию (2.1).
    await new Promise((resolve) => setTimeout(resolve, 10));
    await workWith('Платежи', 'бэкенд');

    const app = open();
    try {
      await mounted(app.stdin);
      await waitFor(() => (app.lastFrame() ?? '').includes('сессии · Авторизация'));

      // Курсор входит в сайдбар на выбранной сессии, по кругу идёт к работам:
      // первый `j` — на первую работу, второй — на вторую.
      app.stdin.write(`${PREFIX}s`);
      await new Promise((resolve) => setTimeout(resolve, 150));
      app.stdin.write('j');
      await new Promise((resolve) => setTimeout(resolve, 100));
      app.stdin.write('j');
      await new Promise((resolve) => setTimeout(resolve, 100));
      app.stdin.write(ENTER);

      await waitFor(() => (app.lastFrame() ?? '').includes('сессии · Платежи'));
      expect(lineWith(app.lastFrame() ?? '', 'бэкенд')).toContain('бэкенд');
    } finally {
      app.unmount();
    }
  }, 30_000);

  /** Курсор входит в сайдбар на выбранной сессии; два `j` доводят его до `new`. */
  const cursorToNew = async (app: ReturnType<typeof render>): Promise<void> => {
    app.stdin.write(`${PREFIX}s`);
    await new Promise((resolve) => setTimeout(resolve, 150));
    app.stdin.write('j');
    await new Promise((resolve) => setTimeout(resolve, 100));
    app.stdin.write('j');
    await new Promise((resolve) => setTimeout(resolve, 100));
  };

  it('строка new заводит вторую работу: Enter по ней — работа «без названия» (5.1)', async () => {
    const app = open();
    try {
      const workId = await launch(app);
      await waitMap(workId, (item) => item.status === 'active');

      // Сессия → работа → `new`: пять строк сайдбара обходятся по кругу (3.2).
      await cursorToNew(app);

      // `Enter` по строке `new` верхнего уровня — новая работа, а не вторая
      // сессия в прежней (5.1).
      app.stdin.write(ENTER);
      await waitFor2(async () => (await readWorksIndex()).works.length === 2);
      const { works } = await readWorksIndex();
      expect(works.map((item) => item.title)).toEqual(['без названия', 'без названия']);
      // В прежней работе сессия по-прежнему одна.
      expect((await readMap(project, workId)).sessions).toHaveLength(1);

      // Панель переехала к агенту новой работы, и ввод идёт ему: у обеих работ
      // сессия называется `s-01`, и по голому id панель осталась бы у первой.
      await waitFor(() => (app.lastFrame() ?? '').includes('@w-0002'));
      app.stdin.write('echo ПРОБА\r');
      await waitFor(() => (app.lastFrame() ?? '').includes('ПРОБА'));
      expect(app.lastFrame()).toContain('@w-0002');
    } finally {
      app.unmount();
    }
  }, 30_000);

  it('prefix c кладёт сессию в выбранную работу и на строке new (3.2)', async () => {
    const app = open();
    try {
      const workId = await launch(app);
      await waitMap(workId, (item) => item.status === 'active');

      // Курсор стоит на `new`, но `c` про курсор не спрашивает: сессия ложится
      // в выбранную работу (3.2).
      await cursorToNew(app);
      app.stdin.write(`${PREFIX}c`);
      await waitFor2(async () => (await readMap(project, workId)).sessions.length === 2);
      expect((await readWorksIndex()).works).toHaveLength(1);
    } finally {
      app.unmount();
    }
  }, 30_000);
});

describe('переключение работ (2.1, 3.2)', () => {
  /** Курсор входит в сайдбар на выбранной сессии; два `j` доводят его до `new`. */
  const cursorToNew = async (app: ReturnType<typeof render>): Promise<void> => {
    app.stdin.write(`${PREFIX}s`);
    await new Promise((resolve) => setTimeout(resolve, 150));
    app.stdin.write('j');
    await new Promise((resolve) => setTimeout(resolve, 100));
    app.stdin.write('j');
    await new Promise((resolve) => setTimeout(resolve, 100));
  };

  /** Две работы с живыми stub: первая сказала «альфа», вторая — «бета». */
  const twoWorks = async (app: ReturnType<typeof render>): Promise<string> => {
    const workId = await launch(app);
    await waitMap(workId, (item) => item.status === 'active');
    app.stdin.write('echo альфа-один\r');
    await waitFor(() => (app.lastFrame() ?? '').includes('альфа-один'));

    await cursorToNew(app);
    app.stdin.write(ENTER);
    await waitFor(() => (app.lastFrame() ?? '').includes('@w-0002'));
    app.stdin.write('echo бета-два\r');
    await waitFor(() => (app.lastFrame() ?? '').includes('бета-два'));
    // Обе работы в сайдбаре: до этого кадра `prefix 1..9` не о ком говорить.
    await waitFor(() => (app.lastFrame() ?? '').includes('2 без названия'));
    return workId;
  };

  it('prefix 1..9 подключает панель к сессии работы, j/k ходят через границу работ', async () => {
    const app = open();
    try {
      await twoWorks(app);
      // Порядок создания: номер 1 у w-0001, номер 2 у w-0002 (2.1).
      app.stdin.write(`${PREFIX}1`);
      await waitFor(() => (app.lastFrame() ?? '').includes('альфа-один'));
      expect(app.lastFrame()).not.toContain('бета-два');

      app.stdin.write(`${PREFIX}2`);
      await waitFor(() => (app.lastFrame() ?? '').includes('бета-два'));

      // `j` с единственной сессии работы шагает в соседнюю работу, а не стоит.
      app.stdin.write(`${PREFIX}j`);
      await waitFor(() => (app.lastFrame() ?? '').includes('альфа-один'));
      app.stdin.write(`${PREFIX}k`);
      await waitFor(() => (app.lastFrame() ?? '').includes('бета-два'));
    } finally {
      app.unmount();
    }
  }, 30_000);

  // Дизайн комнаты, 5: комната работы — остановка ходьбы `j`/`k` после её
  // последней сессии, и уйти с неё можно теми же клавишами.
  it('j/k заходят в комнату работы после её последней сессии и выходят из неё, не трогая панель гостя', async () => {
    const app = open();
    try {
      const workId = await twoWorks(app);
      // Письмо даёт первой работе комнату; второй — нет (сравнение шагов).
      await updateMap(project, workId, (map) => {
        const from = map.sessions[0]?.id ?? 's-01';
        addMessage(map, { from, to: from, text: 'заметка' });
      });

      app.stdin.write(`${PREFIX}1`);
      await waitFor(() => (app.lastFrame() ?? '').includes('альфа-один'));
      await waitFor(() => (app.lastFrame() ?? '').includes('комната'));

      // Один `j` с единственной сессии работы 1 — в её комнату: работа не
      // меняется, панель гостя не трогается (комната, 3-4) — экран прежний.
      app.stdin.write(`${PREFIX}j`);
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(app.lastFrame()).toContain('альфа-один');
      expect(app.lastFrame()).not.toContain('бета-два');

      // Второй `j` — дальше по кругу, в сессию работы 2: комната была
      // промежуточной остановкой, а не пропущена.
      app.stdin.write(`${PREFIX}j`);
      await waitFor(() => (app.lastFrame() ?? '').includes('бета-два'));

      // Обратно: первый `k` возвращает в комнату работы 1 — панель ещё на
      // сессии работы 2, её экран цел (комната не отключает и не подключает).
      app.stdin.write(`${PREFIX}k`);
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(app.lastFrame()).toContain('бета-два');

      // Второй `k` — на сессию работы 1: подключение возвращает прежний экран.
      app.stdin.write(`${PREFIX}k`);
      await waitFor(() => (app.lastFrame() ?? '').includes('альфа-один'));
      expect(app.lastFrame()).not.toContain('бета-два');
    } finally {
      app.unmount();
    }
  }, 30_000);

  it('переключение работы возвращает к последней подключённой в ней сессии', async () => {
    const app = open();
    try {
      const workId = await twoWorks(app);
      // В первой работе вторая сессия; к ней и должна вернуться панель.
      app.stdin.write(`${PREFIX}1`);
      await waitFor(() => (app.lastFrame() ?? '').includes('альфа-один'));
      app.stdin.write(`${PREFIX}c`);
      await waitFor2(async () => (await readMap(project, workId)).sessions.length === 2);
      await waitFor(() => (app.lastFrame() ?? '').includes('@w-0001'));
      app.stdin.write('echo гамма-три\r');
      await waitFor(() => (app.lastFrame() ?? '').includes('гамма-три'));
      // Обе сессии первой работы в сайдбаре: память выбора сверяется с деревом.
      // Ярлык теперь делит колонки с номером сессии и на узком сайдбаре режется —
      // считаем по началу, которое усечение не задевает (план рамок, задача 5;
      // дизайн комнаты, 4).
      await waitFor(() => (app.lastFrame() ?? '').split('новая с').length > 2);

      app.stdin.write(`${PREFIX}2`);
      await waitFor(() => (app.lastFrame() ?? '').includes('бета-два'));
      app.stdin.write(`${PREFIX}1`);
      await waitFor(() => (app.lastFrame() ?? '').includes('гамма-три'));
      expect(app.lastFrame()).not.toContain('альфа-один');
    } finally {
      app.unmount();
    }
  }, 30_000);

  it('13: prefix C заводит дочернюю сессию выбранной и стартует тихо', async () => {
    const app = open();
    try {
      const workId = await launch(app);
      await waitMap(workId, (item) => item.status === 'active');
      await updateMap(project, workId, (map) => {
        const parent = map.sessions[0];
        if (parent !== undefined) parent.summary = 'миграции готовы';
      });

      app.stdin.write(`${PREFIX}C`);
      await waitFor2(async () => (await readMap(project, workId)).sessions.length === 2);
      const child = (await readMap(project, workId)).sessions[1];
      expect(child?.parent).toBe('s-01');
      expect(child?.contextFrom).toEqual(['s-01']);
      // Задачи у неё нет: её напишет пользователь первым сообщением (план B).
      expect(child?.task).toBe('');
      // Дочерняя сессия запущена сразу, а её бриф несёт резюме родителя.
      await waitFor(() => (app.lastFrame() ?? '').includes('harnas=s-02@w-0001'));
      const brief = await readFile(path.join(workPaths(project, workId).briefs, 's-02.md'), 'utf8');
      expect(brief).toContain('миграции готовы');
      // Бриф уехал в системную вставку, а не первым сообщением: в аргументах
      // stub его заголовка нет, и агент ждёт запроса пользователя.
      expect(app.lastFrame()).not.toContain('# Работа');
    } finally {
      app.unmount();
    }
  }, 30_000);

  it('14: первое сообщение пользователя в тихой сессии начинает ход', async () => {
    const created = await createWork(project, { title: 'Авторизация' });
    const workId = created.work.id;
    await createPendingSession(project, workId, {
      provider: 'claude',
      label: 'план',
      task: 'составить план',
    });

    const app = open();
    try {
      await mounted(app.stdin);
      await waitFor(() => (app.lastFrame() ?? '').includes('план'));
      app.stdin.write(`${PREFIX}C`);
      await waitFor2(async () => (await readMap(project, workId)).sessions.length === 2);
      await waitFor(() => (app.lastFrame() ?? '').includes('harnas=s-02@'));
      // Пока пользователь молчит, хода нет: тихая сессия ничего не начинала.
      // Ярлык у дочерней сессии режется и боковыми гранями сайдбара (план рамок,
      // задача 5), и номером сессии перед ним (дизайн комнаты, 4) — ищем строку
      // по началу, которое усечение не задевает.
      expect(lineWith(app.lastFrame() ?? '', 'нов')).not.toContain('working');

      // Первое сообщение пользователя — хук `UserPromptSubmit` (4.2).
      app.stdin.write('event {"hook_event_name":"UserPromptSubmit"}\r');
      await waitFor(() => lineWith(app.lastFrame() ?? '', 'нов').includes('working'));
    } finally {
      app.unmount();
    }
  }, 30_000);

  it('19: сессия закреплённой чужой работы ложится в её проект, а не в харнесса', async () => {
    const other = await mkdtemp(path.join(tmpdir(), 'harnas-other-'));
    try {
      const workId = (await createWork(other, { title: 'Автоплатежи', goal: '' })).work.id;
      const app = open();
      try {
        await mounted(app.stdin);
        app.stdin.write(`${PREFIX}w`);
        await waitFor(() => (app.lastFrame() ?? '').includes('Автоплатежи'));
        await new Promise((resolve) => setTimeout(resolve, 150));
        app.stdin.write(ENTER);
        await waitFor(() => (app.lastFrame() ?? '').includes('сессии · Автоплатежи'));

        app.stdin.write(`${PREFIX}c`);
        await waitFor2(async () => (await readMap(other, workId)).sessions.length === 1);
        await waitFor(() => (app.lastFrame() ?? '').includes('stub готов'));
        // Ярлык делит колонки с номером сессии и на узком сайдбаре режется —
        // считаем по началу (дизайн комнаты, 4).
        await waitFor(() => (app.lastFrame() ?? '').includes('новая с'));

        app.stdin.write(`${PREFIX}C`);
        await waitFor2(async () => (await readMap(other, workId)).sessions.length === 2);
        expect((await readMap(other, workId)).sessions[1]?.parent).toBe('s-01');
        // В проекте харнесса карты этой работы нет вовсе: `rm` и записи ушли бы
        // не в тот проект (хвост TODOS, обязательное условие удаления сессии).
        await expect(readMap(project, workId)).rejects.toThrow();
      } finally {
        app.unmount();
      }
    } finally {
      await rm(other, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  }, 30_000);
});

describe('вторая строка работы (макет 1.1)', () => {
  const git = promisify(execFile);

  it('ветку работы без лога провайдера даёт `.git/HEAD` проекта', async () => {
    await git('git', ['init', '-b', 'feat/pay', project]);
    await createWork(project, { title: 'Авторизация' });

    const app = open();
    try {
      await mounted(app.stdin);
      await waitFor(() => (app.lastFrame() ?? '').includes('feat/pay'));
    } finally {
      app.unmount();
    }
  }, 30_000);
});

describe('события и просмотр (4.1, 6)', () => {
  const hook = (name: string, extra: Record<string, unknown> = {}): string =>
    `${JSON.stringify({ hook_event_name: name, ...extra })}\n`;

  it('29: blocked у неподключённой сессии поднимает ⚑, подключение его гасит', async () => {
    const { workId, id } = await outsideSession('ревью');
    await appendFile(
      path.join(workPaths(project, workId).events, `${id}.jsonl`),
      hook('Notification', { notification_type: 'permission_prompt' }),
    );

    const app = open();
    try {
      await mounted(app.stdin);
      await waitFor(() => (app.lastFrame() ?? '').includes('ревью ждёт ответа'));
      expect(app.lastFrame()).toContain('⚑');

      // Подключение к сессии-источнику гасит событие (дизайн 6).
      app.stdin.write(`${PREFIX}j`);
      await waitFor(() => !(app.lastFrame() ?? '').includes('ждёт ответа'));
    } finally {
      app.unmount();
    }
  }, 30_000);

  it('30: подключение гасит unseen, а оверлей деталей — нет', async () => {
    const { workId, id } = await outsideSession('план');

    const app = open();
    try {
      await mounted(app.stdin);
      // Ход заканчивается при нас: законченный до запуска харнесса считается
      // просмотренным и синим не горит (4.1).
      await waitFor(() => lineWith(app.lastFrame() ?? '', 'план').includes('idle'));
      await appendFile(path.join(workPaths(project, workId).events, `${id}.jsonl`), hook('Stop'));
      await waitFor(() => lineWith(app.lastFrame() ?? '', 'план').includes('unseen'));

      // Оверлей деталей — просмотр, а не подключение: `unseen` держится (4.1).
      app.stdin.write(`${PREFIX}i`);
      await waitFor(() => (app.lastFrame() ?? '').includes('детали · план'));
      await new Promise((resolve) => setTimeout(resolve, 300));
      app.stdin.write(ESC);
      await waitFor(() => !(app.lastFrame() ?? '').includes('детали · план'));
      expect(lineWith(app.lastFrame() ?? '', 'план')).toContain('unseen');

      app.stdin.write(`${PREFIX}j`);
      await waitFor(() => lineWith(app.lastFrame() ?? '', 'план').includes('idle'));
    } finally {
      app.unmount();
    }
  }, 30_000);

  it('29: у подключённой сессии ⚑ не поднимается, даже когда выбор уехал', async () => {
    const { workId, id } = await outsideSession('ревью');

    const app = open();
    try {
      await mounted(app.stdin);
      // Своя сессия в той же работе: панель подключается к ней (5.1).
      app.stdin.write(`${PREFIX}c`);
      await waitFor(() => (app.lastFrame() ?? '').includes('stub готов'));
      const ours = await waitSession(workId, (item) => item.launchedBy === 'tui');

      // Выбор уезжает на чужую сессию, панель остаётся у своей (макет 1.5).
      app.stdin.write(`${PREFIX}s`);
      await new Promise((resolve) => setTimeout(resolve, 150));
      app.stdin.write('k');
      await new Promise((resolve) => setTimeout(resolve, 250));
      // Из режима выходим: пока он идёт, строку статуса занимает он сам (1.5),
      // а проверяем мы события. Выбор при этом остаётся на чужой сессии.
      app.stdin.write(ESC);
      await new Promise((resolve) => setTimeout(resolve, 150));

      // Подключённая сессия на экране: «не подключена» про неё — неправда.
      await appendFile(
        path.join(workPaths(project, workId).events, `${ours.id}.jsonl`),
        hook('Notification', { notification_type: 'permission_prompt' }),
      );
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(app.lastFrame()).not.toContain('ждёт ответа');

      // А неподключённая — поднимает флажок, даже будучи выбранной.
      await appendFile(
        path.join(workPaths(project, workId).events, `${id}.jsonl`),
        hook('Notification', { notification_type: 'permission_prompt' }),
      );
      await waitFor(() => (app.lastFrame() ?? '').includes('ревью ждёт ответа'));
    } finally {
      app.unmount();
    }
  }, 30_000);

  it('в режиме навигации ходьба не подключает, а Enter подключает (3.2)', async () => {
    const { workId, id } = await outsideSession('план');

    const app = open();
    try {
      await mounted(app.stdin);
      await waitFor(() => lineWith(app.lastFrame() ?? '', 'план').includes('idle'));
      await appendFile(path.join(workPaths(project, workId).events, `${id}.jsonl`), hook('Stop'));
      await waitFor(() => lineWith(app.lastFrame() ?? '', 'план').includes('unseen'));

      app.stdin.write(`${PREFIX}s`);
      await new Promise((resolve) => setTimeout(resolve, 150));
      // Круг по всем строкам сайдбара — работа, `new`, снова сессия — это ещё
      // не подключение: `unseen` держится (3.2).
      for (let step = 0; step < 3; step++) {
        app.stdin.write('j');
        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(lineWith(app.lastFrame() ?? '', 'план')).toContain('unseen');
      }

      app.stdin.write(ENTER);
      await waitFor(() => lineWith(app.lastFrame() ?? '', 'план').includes('idle'));
    } finally {
      app.unmount();
    }
  }, 30_000);
});

describe('панель следует за подключённым агентом (2.2, 3.1, макет 1.5)', () => {
  it('ходьба по сайдбару не подменяет живого гостя карточкой', async () => {
    const app = open();
    try {
      const workId = await launch(app);
      const first = await waitMap(workId, (item) => item.status === 'active');

      // Вторая сессия той же работы: панель переезжает на неё.
      app.stdin.write(`${PREFIX}c`);
      await waitFor(() => !(app.lastFrame() ?? '').includes(`harnas=${first.id}@`));
      await waitFor(() => (app.lastFrame() ?? '').includes('stub готов'));

      // Режим навигации: выбор ходит по сайдбару, панель живёт (макет 1.5).
      app.stdin.write(`${PREFIX}s`);
      await new Promise((resolve) => setTimeout(resolve, 150));
      app.stdin.write('k');
      await new Promise((resolve) => setTimeout(resolve, 300));

      const frame = app.lastFrame() ?? '';
      expect(frame).toContain('stub готов');
      expect(frame).not.toContain('вне харнесса');
      // Второй признак режима, рядом с cyan-разделителем: строка статуса (1.5).
      expect(frame).toContain('сайдбар · ↑↓/jk — по строкам');
    } finally {
      app.unmount();
    }
  }, 30_000);

  it('переключение сессий возвращает прежний экран каждого гостя (2.2)', async () => {
    const app = open();
    try {
      const workId = await launch(app);
      await waitMap(workId, (item) => item.status === 'active');

      // Первый гость сказал своё — этот экран должен пережить уход панели.
      app.stdin.write('echo альфа-один\r');
      await waitFor(() => (app.lastFrame() ?? '').includes('альфа-один'));

      // Вторая сессия той же работы: у неё свой, чистый экран.
      app.stdin.write(`${PREFIX}c`);
      await waitFor(() => !(app.lastFrame() ?? '').includes('альфа-один'));
      app.stdin.write('echo бета-два\r');
      await waitFor(() => (app.lastFrame() ?? '').includes('бета-два'));
      // Обе сессии в сайдбаре: до этого кадра `j`/`k` ходить ещё некуда. Ярлык
      // делит колонки с номером сессии и на узком сайдбаре режется — считаем по
      // началу (дизайн комнаты, 4).
      await waitFor(() => (app.lastFrame() ?? '').split('новая с').length > 2);

      // Назад к первой: её экран на месте, чужого на нём нет.
      app.stdin.write(`${PREFIX}k`);
      await waitFor(() => (app.lastFrame() ?? '').includes('альфа-один'));
      expect(app.lastFrame()).not.toContain('бета-два');

      // И обратно ко второй — тем же порядком.
      app.stdin.write(`${PREFIX}j`);
      await waitFor(() => (app.lastFrame() ?? '').includes('бета-два'));
    } finally {
      app.unmount();
    }
  }, 30_000);

  it('пока панель показывает карточку, ввод не уходит чужому агенту', async () => {
    const { workId } = await outsideSession('ревью');
    const app = open();
    try {
      await mounted(app.stdin);
      app.stdin.write(`${PREFIX}c`);
      await waitFor(() => (app.lastFrame() ?? '').includes('stub готов'));
      const ours = await waitSession(workId, (item) => item.launchedBy === 'tui');

      // Уходим на живую сессию, чей PTY не у харнесса: панель отпускает гостя.
      app.stdin.write(`${PREFIX}k`);
      await waitFor(() => (app.lastFrame() ?? '').includes('вне харнесса'));
      expect(app.lastFrame()).not.toContain('stub готов');

      // Команда `exit 7` завершила бы stub, будь ввод по-прежнему у него.
      app.stdin.write('exit 7\r');
      await new Promise((resolve) => setTimeout(resolve, 600));
      expect((await waitSession(workId, (item) => item.id === ours.id)).status).toBe('active');

      // Обратно на нашу сессию, но без подключения: карточка про неё не врёт.
      app.stdin.write(`${PREFIX}s`);
      await new Promise((resolve) => setTimeout(resolve, 150));
      app.stdin.write('j');
      await waitFor(() => (app.lastFrame() ?? '').includes('запущена харнессом'));
      expect(app.lastFrame()).not.toContain('вне харнесса');
    } finally {
      app.unmount();
    }
  }, 30_000);
});

describe('строка статуса (макеты §3)', () => {
  it('после префикса строка показывает список действий, клавиша его убирает', async () => {
    const app = open();
    try {
      await mounted(app.stdin);
      app.stdin.write(PREFIX);
      await waitFor(() => (app.lastFrame() ?? '').includes(`${PREFIX_NAME} …`));
      expect(app.lastFrame()).toContain('? все');

      // Неизвестная клавиша молча отменяет префикс.
      app.stdin.write('z');
      await waitFor(() => !(app.lastFrame() ?? '').includes(`${PREFIX_NAME} …`));
      expect(app.lastFrame()).toContain(`${PREFIX_NAME} ?`);
    } finally {
      app.unmount();
    }
  }, 30_000);
});

describe('гашение событий строки статуса (5, 6)', () => {
  const hook = (name: string, extra: Record<string, unknown> = {}): string =>
    `${JSON.stringify({ hook_event_name: name, ...extra })}\n`;

  it('событие без источника гаснет по следующей клавише, событие с источником — нет', async () => {
    const { workId, id } = await outsideSession('ревью');
    await appendFile(
      path.join(workPaths(project, workId).events, `${id}.jsonl`),
      hook('Notification', { notification_type: 'permission_prompt' }),
    );

    const app = open();
    try {
      await mounted(app.stdin);
      await waitFor(() => (app.lastFrame() ?? '').includes('ревью ждёт ответа'));

      // Событие без источника: живой сессии резюме не дозаказывают (4.7).
      app.stdin.write(`${PREFIX}R`);
      await waitFor(() => (app.lastFrame() ?? '').includes('резюме дозаказывают'));

      // Любая клавиша харнесса гасит его, а событие сессии остаётся ждать
      // подключения к своей строке.
      app.stdin.write(`${PREFIX}z`);
      await waitFor(() => (app.lastFrame() ?? '').includes('ревью ждёт ответа'));
      expect(app.lastFrame()).not.toContain('резюме дозаказывают');

      // Подключение к источнику гасит и его: счётчик ⚑ не растёт без предела.
      app.stdin.write(`${PREFIX}j`);
      await waitFor(() => !(app.lastFrame() ?? '').includes('ждёт ответа'));
      expect(app.lastFrame()).not.toContain('⚑');
    } finally {
      app.unmount();
    }
  }, 30_000);

  it('24: событие решения гаснет при подключении к сессии-получателю', async () => {
    const created = await createWork(project, { title: 'Авторизация' });
    const ids = { plan: '', backend: '', review: '' };
    await updateMap(project, created.work.id, (map) => {
      const plan = addSession(map, { provider: 'claude', label: 'план', task: '' });
      const backend = addSession(map, {
        provider: 'claude',
        label: 'бэкенд',
        task: '',
        parent: plan.id,
      });
      const review = addSession(map, {
        provider: 'claude',
        label: 'ревью',
        task: '',
        parent: plan.id,
      });
      ids.plan = plan.id;
      ids.backend = backend.id;
      ids.review = review.id;
    });

    const app = open();
    try {
      await mounted(app.stdin);
      await waitFor(() => (app.lastFrame() ?? '').includes('сессии · Авторизация'));

      // Договорённость человек должен увидеть в любом случае: решение идёт в
      // строку статуса своей строкой (6.4).
      await updateMap(project, created.work.id, (map) => {
        addMessage(map, {
          from: ids.plan,
          to: ids.review,
          text: 'миграции отдельно',
          kind: 'decision',
        });
      });
      await waitFor(() => (app.lastFrame() ?? '').includes('✓ план: решение «миграции отдельно»'));
      expect(app.lastFrame()).toContain('⚑');

      // Источник события — получатель: соседняя сессия его не гасит.
      app.stdin.write(`${PREFIX}j`);
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(app.lastFrame()).toContain('✓ план: решение «миграции отдельно»');

      // Подключение к получателю — гасит, и счётчик ⚑ падает до нуля (8.24).
      app.stdin.write(`${PREFIX}j`);
      await waitFor(() => !(app.lastFrame() ?? '').includes('решение «миграции отдельно»'));
      expect(app.lastFrame()).not.toContain('⚑');
    } finally {
      app.unmount();
    }
  }, 30_000);
});

describe('закрытие сессии (3.2, макет 4.8)', () => {
  it('32: prefix x спрашивает подтверждение, шлёт SIGHUP и переводит в exited', async () => {
    const app = open();
    try {
      const workId = await launch(app);
      await waitMap(workId, (item) => item.status === 'active');

      app.stdin.write(`${PREFIX}x`);
      await waitFor(() => (app.lastFrame() ?? '').includes('SIGHUP'));
      // Пока подтверждение открыто, ввод ему, а не гостю.
      expect(app.lastFrame()).toContain('Enter — закрыть');

      // Подтверждение подписывается на ввод эффектом: до подписки клавиша пропала бы.
      await new Promise((resolve) => setTimeout(resolve, 150));
      app.stdin.write(ENTER);
      const session = await waitMap(workId, (item) => item.status === 'exited');
      expect(session.history.at(-1)?.status).toBe('exited');
    } finally {
      app.unmount();
    }
  }, 30_000);

  it('Enter на карточке вышедшей сессии открывает возобновление без режима навигации (2.2)', async () => {
    const app = open();
    try {
      const workId = await launch(app);
      await waitMap(workId, (item) => item.status === 'active');

      // Гость вышел сам: в панели карточка «exited» с подсказкой про Enter.
      app.stdin.write('exit 0\r');
      await waitMap(workId, (item) => item.status === 'exited');
      await waitFor(() => (app.lastFrame() ?? '').includes('Enter — возобновить'));

      // Клавише некуда уходить, и Enter делает то, что обещает карточка.
      app.stdin.write(ENTER);
      await waitFor(() => (app.lastFrame() ?? '').includes('--resume'));
      expect(app.lastFrame()).toContain('Enter — возобновить');
      // Префикс на карточке по-прежнему слышен: Esc закрывает, `?` открывает справку.
      app.stdin.write(ESC);
      await waitFor(() => !(app.lastFrame() ?? '').includes('--resume'));
      app.stdin.write(`${PREFIX}?`);
      await waitFor(() => (app.lastFrame() ?? '').includes('привязки'));
    } finally {
      app.unmount();
    }
  }, 30_000);

  it('клик по сайдбару работает и при карточке в панели (3.3)', async () => {
    const app = open();
    try {
      const workId = await launch(app);
      await waitMap(workId, (item) => item.status === 'active');
      app.stdin.write('exit 0\r');
      await waitMap(workId, (item) => item.status === 'exited');
      await waitFor(() => (app.lastFrame() ?? '').includes('Enter — возобновить'));

      // Карточка захватывает клавиши, но мышь по сайдбару пропадать не должна:
      // клик по строке `new` заводит вторую работу (3.3, 5.1).
      const rows = (app.lastFrame() ?? '').split('\n');
      const row = rows.findIndex((line) => / new\b/.test(line));
      expect(row).toBeGreaterThanOrEqual(0);
      app.stdin.write(`${ESC}[<0;3;${row + 1}M${ESC}[<0;3;${row + 1}m`);
      await waitFor2(async () => (await readWorksIndex()).works.length === 2);
    } finally {
      app.unmount();
    }
  }, 30_000);

  it('prefix q без панелей харнесса не обещает завершить чужие процессы (5.4)', async () => {
    await outsideSession('ревью');
    const app = open();
    try {
      await mounted(app.stdin);
      await waitFor(() => (app.lastFrame() ?? '').includes('ревью'));

      // Живая сессия есть, но её PTY не у харнесса: SIGHUP при выходе ей не
      // уйдёт, и подтверждения быть не должно (решение №5).
      app.stdin.write(`${PREFIX}q`);
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(app.lastFrame()).not.toContain('живые сессии');
    } finally {
      app.unmount();
    }
  }, 30_000);

  it('prefix q при живой сессии спрашивает подтверждение выхода (макет 4.9)', async () => {
    const app = open();
    try {
      const workId = await launch(app);
      await waitMap(workId, (item) => item.status === 'active');

      app.stdin.write(`${PREFIX}q`);
      await waitFor(() => (app.lastFrame() ?? '').includes('живые сессии'));
      expect(app.lastFrame()).toContain('Enter — выйти');

      // Esc оставляет харнесс на месте: панель снова у агента.
      await new Promise((resolve) => setTimeout(resolve, 150));
      app.stdin.write(ESC);
      await waitFor(() => (app.lastFrame() ?? '').includes('stub готов'));
    } finally {
      app.unmount();
    }
  }, 30_000);
});

describe('удаление сессии (3.2, макет 4.10)', () => {
  const hook = (name: string, extra: Record<string, unknown> = {}): string =>
    `${JSON.stringify({ hook_event_name: name, ...extra })}\n`;

  /** Оверлей подтверждения подписывается на ввод эффектом: до подписки клавиша пропала бы. */
  const confirm = async (app: ReturnType<typeof render>): Promise<void> => {
    await waitFor(() => (app.lastFrame() ?? '').includes('Enter — удалить'));
    await new Promise((resolve) => setTimeout(resolve, 150));
    app.stdin.write(ENTER);
  };

  /** Ярлык руками: обе быстрые сессии зовутся одинаково, а в кадре их надо различать. */
  const rename = async (workId: string, sessionId: string, label: string): Promise<void> => {
    await updateMap(project, workId, (map) => {
      const session = map.sessions.find((item) => item.id === sessionId);
      if (session !== undefined) session.label = label;
    });
  };

  it('29: prefix d на живой подключённой сессии удаляет её, дети поднимаются', async () => {
    const app = open();
    try {
      const workId = await launch(app);
      await waitMap(workId, (item) => item.status === 'active');
      await rename(workId, 's-01', 'план');
      // Дочерняя сессия: после удаления родителя она поднимется на уровень.
      app.stdin.write(`${PREFIX}C`);
      await waitFor2(async () => (await readMap(project, workId)).sessions.length === 2);
      await rename(workId, 's-02', 'ревью');
      await waitFor(() => (app.lastFrame() ?? '').includes('ревью'));
      await waitFor(() => lineWith(app.lastFrame() ?? '', 'план') !== '');

      // Обратно на родителя: его PTY у харнесса, панель подключена к нему.
      app.stdin.write(`${PREFIX}k`);
      await waitFor(() => (app.lastFrame() ?? '').includes('harnas=s-01@'));

      app.stdin.write(`${PREFIX}d`);
      await waitFor(() => (app.lastFrame() ?? '').includes('удалить'));
      const frame = app.lastFrame() ?? '';
      expect(frame).toContain('удалить ● план');
      expect(frame).toContain('запись, бриф и журнал событий будут удалены');
      expect(frame).toContain('транскрипт в ~/.claude останется');
      expect(frame).toContain('дочерние: ревью → поднимутся на уровень');
      await confirm(app);

      await waitFor2(async () => (await readMap(project, workId)).sessions.length === 1);
      const map = await readMap(project, workId);
      expect(map.sessions.map((item) => item.id)).toEqual(['s-02']);
      // Ребёнок поднялся к родителю удалённой, ссылка на неё вычищена.
      expect(map.sessions[0]?.parent).toBeNull();
      expect(map.sessions[0]?.contextFrom).toEqual([]);
      expect(map.work.deletedSessions).toEqual(['s-01']);
      await waitFor(() => (app.lastFrame() ?? '').includes('сессия удалена'));

      // Выбор чинится сам: панель показывает карточку оставшейся сессии, а не
      // экран удалённой — её PTY харнесс закрыл (2.2).
      await waitFor(() => (app.lastFrame() ?? '').includes('запущена харнессом'));
      expect(lineWith(app.lastFrame() ?? '', 'запущена харнессом')).not.toBe('');
      expect(app.lastFrame()).toContain('ревью');

      // Журнал удалённой сессии, дописанный хуком после удаления, записи не
      // создаёт: настройки одни на работу, и хук пишет по HARNAS_SESSION_ID.
      const paths = workPaths(project, workId);
      await mkdir(paths.events, { recursive: true });
      await appendFile(path.join(paths.events, 's-01.jsonl'), hook('SessionEnd'));
      await new Promise((resolve) => setTimeout(resolve, 600));
      expect((await readMap(project, workId)).sessions.map((item) => item.id)).toEqual(['s-02']);
    } finally {
      app.unmount();
    }
  }, 30_000);

  it('30: живую CLI-сессию удалить нельзя, устаревшую — можно', async () => {
    const { workId } = await outsideSession('ревью');

    const app = open();
    try {
      await mounted(app.stdin);
      await waitFor(() => (app.lastFrame() ?? '').includes('ревью'));

      // pid у неё null, а журнал свежий: по `checkSession` она жива, и её процесс
      // не у харнесса — закрыть его нечем (раздел C).
      app.stdin.write(`${PREFIX}d`);
      await waitFor(() => (app.lastFrame() ?? '').includes('её процесс не у харнесса'));
      expect(app.lastFrame()).toContain('закройте её там, где она запущена');
      expect(app.lastFrame()).not.toContain('Enter — удалить');
      await new Promise((resolve) => setTimeout(resolve, 150));
      app.stdin.write(ESC);
      await waitFor(() => !(app.lastFrame() ?? '').includes('закройте её там'));
      expect((await readMap(project, workId)).sessions).toHaveLength(1);

      // Тот же журнал, но устаревший: сессия давно молчит и живой не считается.
      await updateMap(project, workId, (map) => {
        const session = map.sessions[0];
        if (session !== undefined) session.startedAt = '2020-01-01T00:00:00.000Z';
      });
      await waitFor2(async () => (await readMap(project, workId)).sessions[0]?.status === 'exited');

      app.stdin.write(`${PREFIX}d`);
      await confirm(app);
      await waitFor2(async () => (await readMap(project, workId)).sessions.length === 0);
    } finally {
      app.unmount();
    }
  }, 30_000);

  it('prefix D удаляет работу целиком: процессы закрыты, каталог и запись индекса сняты', async () => {
    const app = open();
    try {
      const workId = await launch(app);
      await waitMap(workId, (item) => item.status === 'active');
      // Вторая, дочерняя сессия: её PTY тоже у харнесса и тоже закрывается.
      app.stdin.write(`${PREFIX}C`);
      await waitFor2(async () => (await readMap(project, workId)).sessions.length === 2);
      // Ребёнок доехал до сайдбара: диалог считает сессии по карте в состоянии.
      await rename(workId, 's-02', 'ребёнок');
      await waitFor(() => (app.lastFrame() ?? '').includes('ребёнок'));
      const paths = workPaths(project, workId);
      await writeFile(path.join(paths.artifacts, 'plan.md'), 'план\n', 'utf8');

      app.stdin.write(`${PREFIX}D`);
      await waitFor(() => (app.lastFrame() ?? '').includes('удалить работу'));
      const frame = app.lastFrame() ?? '';
      expect(frame).toContain(`удалить работу ${workId}`);
      expect(frame).toContain('2 сессии, карта, брифы, журналы и артефакты');
      expect(frame).toContain('запись уйдёт из глобального индекса');
      await confirm(app);

      await waitFor2(async () => !(await pathExists(paths.dir)));
      expect((await readWorksIndex()).works).toEqual([]);
      await waitFor(() => (app.lastFrame() ?? '').includes('работа удалена'));
      // Сайдбар пуст: ни работы, ни её сессий, кнопка `new` наверху блока и
      // подсказка о первой сессии под ней отдельной строкой (план рамок, задача 4).
      await waitFor(() => (app.lastFrame() ?? '').includes('первая сессия'));
      expect(app.lastFrame()).not.toContain(workId);
    } finally {
      app.unmount();
    }
  }, 30_000);

  it('prefix D при живой CLI-сессии отказывает и ничего не трогает', async () => {
    const { workId } = await outsideSession('ревью');

    const app = open();
    try {
      await mounted(app.stdin);
      await waitFor(() => (app.lastFrame() ?? '').includes('ревью'));

      app.stdin.write(`${PREFIX}D`);
      await waitFor(() => (app.lastFrame() ?? '').includes('«ревью» жива'));
      expect(app.lastFrame()).not.toContain('Enter — удалить');
      await new Promise((resolve) => setTimeout(resolve, 150));
      app.stdin.write(ESC);
      await waitFor(() => !(app.lastFrame() ?? '').includes('«ревью» жива'));

      expect(await pathExists(workPaths(project, workId).map)).toBe(true);
      expect((await readWorksIndex()).works).toHaveLength(1);
    } finally {
      app.unmount();
    }
  }, 30_000);

  it('31: Esc в подтверждении ничего не меняет', async () => {
    const app = open();
    try {
      const workId = await launch(app);
      await waitMap(workId, (item) => item.status === 'active');

      app.stdin.write(`${PREFIX}d`);
      await waitFor(() => (app.lastFrame() ?? '').includes('Enter — удалить'));
      await new Promise((resolve) => setTimeout(resolve, 150));
      app.stdin.write(ESC);
      await waitFor(() => !(app.lastFrame() ?? '').includes('Enter — удалить'));

      // Запись на месте, процесс жив: гость по-прежнему слышит ввод.
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect((await readMap(project, workId)).sessions).toHaveLength(1);
      app.stdin.write('echo цела\r');
      await waitFor(() => (app.lastFrame() ?? '').includes('цела'));
    } finally {
      app.unmount();
    }
  }, 30_000);

  it('32: удаление последней сессии оставляет пустую работу, new снова работает', async () => {
    const app = open();
    try {
      const workId = await launch(app);
      await waitMap(workId, (item) => item.status === 'active');

      app.stdin.write(`${PREFIX}d`);
      await confirm(app);
      await waitFor2(async () => (await readMap(project, workId)).sessions.length === 0);

      // Панель показывает карточку «сессий нет», точки у работы больше нет.
      await waitFor(() => (app.lastFrame() ?? '').includes('сессий нет'));

      // `prefix c` кладёт сессию в ту же работу, и её id не переиспользован.
      app.stdin.write(`${PREFIX}c`);
      await waitFor2(async () => (await readMap(project, workId)).sessions.length === 1);
      expect((await readMap(project, workId)).sessions[0]?.id).toBe('s-02');
      expect((await readWorksIndex()).works).toHaveLength(1);
    } finally {
      app.unmount();
    }
  }, 30_000);

  it('33: удаление в закреплённой чужой работе трогает только её проект', async () => {
    const other = await mkdtemp(path.join(tmpdir(), 'harnas-other-'));
    try {
      const workId = (await createWork(other, { title: 'Автоплатежи', goal: '' })).work.id;
      const app = open();
      try {
        await mounted(app.stdin);
        app.stdin.write(`${PREFIX}w`);
        await waitFor(() => (app.lastFrame() ?? '').includes('Автоплатежи'));
        await new Promise((resolve) => setTimeout(resolve, 150));
        app.stdin.write(ENTER);
        await waitFor(() => (app.lastFrame() ?? '').includes('сессии · Автоплатежи'));

        app.stdin.write(`${PREFIX}c`);
        await waitFor2(async () => (await readMap(other, workId)).sessions.length === 1);
        await waitFor(() => (app.lastFrame() ?? '').includes('stub готов'));
        // Сессия доехала до сайдбара: до этого кадра `prefix C` не о ком говорить.
        // Ярлык делит колонки с номером сессии и на узком сайдбаре режется —
        // считаем по началу (дизайн комнаты, 4).
        await waitFor(() => (app.lastFrame() ?? '').includes('новая с'));
        // Дочерняя: у неё есть бриф, и по нему видно, в каком проекте удаляли.
        app.stdin.write(`${PREFIX}C`);
        await waitFor2(async () => (await readMap(other, workId)).sessions.length === 2);
        await waitFor(() => (app.lastFrame() ?? '').includes('harnas=s-02@'));
        // Обе сессии в сайдбаре: до этого кадра выбор ещё стоит на первой.
        // Дочерняя режется боковыми гранями сайдбара (план рамок, задача 5) и
        // отступом с номером сессии перед ярлыком (дизайн комнаты, 4) сильнее
        // родительской — общее начало у обеих короче, чем «новая».
        await waitFor(() => (app.lastFrame() ?? '').split('нов').length > 2);
        const brief = path.join(workPaths(other, workId).briefs, 's-02.md');
        expect(await readFile(brief, 'utf8')).toContain('# Работа');

        app.stdin.write(`${PREFIX}d`);
        await confirm(app);
        await waitFor2(async () => (await readMap(other, workId)).sessions.length === 1);
        await expect(readFile(brief, 'utf8')).rejects.toThrow();
        // В проекте харнесса этой работы нет вовсе — `rm` ушёл бы не туда.
        await expect(readMap(project, workId)).rejects.toThrow();
      } finally {
        app.unmount();
      }
    } finally {
      await rm(other, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  }, 30_000);
});

describe('тред выбранной сессии (6.1–6.3, приёмка 8.20, 8.21, 8.23, 8.37, 8.41)', () => {
  /** Новая ширина терминала: клавиши берут раскладку из эффекта, ему нужен кадр. */
  const resize = async (app: ReturnType<typeof render>, columns: number): Promise<void> => {
    Object.defineProperty(app.stdout, 'columns', { value: columns, configurable: true });
    app.stdout.emit('resize');
    await new Promise((resolve) => setTimeout(resolve, 150));
  };

  /** Работа с двумя поддеревьями и письмом в первом: треды у них разные (3.4). */
  const threadWork = async (): Promise<string> => {
    const created = await createWork(project, { title: 'Авторизация' });
    await updateMap(project, created.work.id, (map) => {
      const plan = addSession(map, { provider: 'claude', label: 'план', task: '' });
      const backend = addSession(map, {
        provider: 'claude',
        label: 'бэкенд',
        task: '',
        parent: plan.id,
      });
      const review = addSession(map, { provider: 'claude', label: 'ревью', task: '' });
      addSession(map, { provider: 'claude', label: 'тесты', task: '', parent: review.id });
      addMessage(map, { from: plan.id, to: backend.id, text: 'где миграция?', kind: 'question' });
    });
    return created.work.id;
  };

  it('20, 21: док отдаёт панели 82 колонки, а набранное по-прежнему идёт гостю', async () => {
    const app = open();
    try {
      await mounted(app.stdin);
      // Макет 6.1: сайдбар 26, панель 82, тред 30 в своей рамке (план рамок,
      // задача 5: разделителя между сайдбаром и панелью больше нет; находка
      // сверки — рамка треда: у самого треда тоже есть правая грань, он занимает
      // 32, а не 31). Порог — 140, не 138: `threadFits` теперь считает по тому,
      // что реально дойдёт до гостя за вычетом рамки панели, а не до неё
      // (находка сверки).
      await resize(app, 140);
      await launch(app);

      app.stdin.write(`${PREFIX}t`);
      // Одинокая корневая сессия видит тред всей работы (3.4).
      await waitFor(() => (app.lastFrame() ?? '').includes('тред · работа'));
      expect(app.lastFrame()).toContain('писем пока нет');
      // PTY узнаёт новые колонки тем же путём, что при ресайзе терминала (6.1);
      // рамка панели отъедает ещё 2 у того, что реально доходит до гостя: 82 − 2
      // (план рамок, задача 6).
      await waitFor(() => (app.lastFrame() ?? '').includes('resize 80x'));

      // Панель треда не модальная: строка уходит агенту, а не харнессу (8.21).
      app.stdin.write('echo привет\r');
      await waitFor(() => (app.lastFrame() ?? '').includes('привет'));

      // Повторное `t` закрывает тред и возвращает панели её колонки (6.1); гостю
      // достаётся 114 − 2 рамки (план рамок, задача 6).
      app.stdin.write(`${PREFIX}t`);
      await waitFor(() => {
        const frame = app.lastFrame() ?? '';
        return frame.lastIndexOf('resize 112x') > frame.lastIndexOf('resize 81x');
      });
      expect(app.lastFrame()).not.toContain('тред · работа');
    } finally {
      app.unmount();
    }
  }, 30_000);

  it('23: смена выбранной сессии меняет тред и его заголовок', async () => {
    await threadWork();
    const app = open();
    try {
      await mounted(app.stdin);
      await waitFor(() => (app.lastFrame() ?? '').includes('сессии · Авторизация'));
      await resize(app, 140);

      app.stdin.write(`${PREFIX}t`);
      await waitFor(() => (app.lastFrame() ?? '').includes('тред · план'));
      // Непрочитанное видно и числом в заголовке, и самой лентой (6.2, 6.3).
      expect(lineWith(app.lastFrame() ?? '', 'тред · план')).toContain('▤1');
      expect(app.lastFrame()).toContain('где миграция?');

      // Две сессии вниз — соседнее поддерево: у него свой тред (3.4).
      app.stdin.write(`${PREFIX}j`);
      await new Promise((resolve) => setTimeout(resolve, 150));
      app.stdin.write(`${PREFIX}j`);
      await waitFor(() => (app.lastFrame() ?? '').includes('тред · ревью'));
      expect(app.lastFrame()).not.toContain('где миграция?');
    } finally {
      app.unmount();
    }
  }, 30_000);

  it('37, 41: узкому терминалу достаётся тот же тред оверлеем-запасником', async () => {
    await threadWork();
    const app = open();
    try {
      await mounted(app.stdin);
      await waitFor(() => (app.lastFrame() ?? '').includes('сессии · Авторизация'));
      await resize(app, 140);

      app.stdin.write(`${PREFIX}t`);
      await waitFor(() => (app.lastFrame() ?? '').includes('тред · план'));
      expect(app.lastFrame()).not.toContain('┌ тред');

      // На 120 колонках панели осталось бы 62 — меньше минимума (решение D21).
      await resize(app, 120);
      await waitFor(() => (app.lastFrame() ?? '').includes('┌ тред · план'));
      // Строки те же: вид один на док и на оверлей (8.41).
      expect(app.lastFrame()).toContain('где миграция?');

      // Терминал вернул ширину — тред вернулся в док.
      await resize(app, 140);
      await waitFor(() => !(app.lastFrame() ?? '').includes('┌ тред'));
      expect(app.lastFrame()).toContain('тред · план');
    } finally {
      app.unmount();
    }
  }, 30_000);

  it('37: ресайз с открытым доком отдаёт PTY колонки в обе стороны', async () => {
    const app = open();
    try {
      await mounted(app.stdin);
      await resize(app, 140);
      await launch(app);

      // Док на 140 колонках: сайдбар 26, панель 82, тред 30 в своей рамке
      // (макет 6.1; план рамок, задача 5: разделителя между сайдбаром и
      // панелью больше нет; находка сверки — рамка треда: тред занимает 32).
      // Порог — 140, не 138: `threadFits` теперь считает по тому, что реально
      // дойдёт до гостя за вычетом рамки панели (находка сверки).
      app.stdin.write(`${PREFIX}t`);
      await waitFor(() => (app.lastFrame() ?? '').includes('тред · работа'));
      // Рамка панели отъедает 2 у того, что доходит до гостя: 82 − 2 (план
      // рамок, задача 6).
      await waitFor(() => (app.lastFrame() ?? '').includes('resize 80x'));

      // Ниже порога док уступает место оверлею, и панель забирает его колонки:
      // 120 − 26 сайдбара = 94, гостю из них — 92 (решение D21; план рамок,
      // задача 6).
      await resize(app, 120);
      await waitFor(() => (app.lastFrame() ?? '').includes('┌ тред'));

      // Оверлей закрывает панель собой, поэтому обе ширины видно в её экране
      // после возврата: 92 пришло на сужении, 80 — на обратном ходе.
      await resize(app, 140);
      await waitFor(() => !(app.lastFrame() ?? '').includes('┌ тред'));
      await waitFor(() => {
        const frame = app.lastFrame() ?? '';
        return (
          frame.includes('resize 92x') &&
          frame.lastIndexOf('resize 80x') > frame.lastIndexOf('resize 92x')
        );
      });
    } finally {
      app.unmount();
    }
  }, 30_000);

  /** Лента на два экрана: письма подписаны двузначно, чтобы не путать 1 и 10. */
  const chattyWork = async (): Promise<string> => {
    const created = await createWork(project, { title: 'Авторизация' });
    await updateMap(project, created.work.id, (map) => {
      const plan = addSession(map, { provider: 'claude', label: 'план', task: '' });
      const backend = addSession(map, {
        provider: 'claude',
        label: 'бэкенд',
        task: '',
        parent: plan.id,
      });
      for (let at = 1; at <= 20; at += 1) {
        const minute = String(at + 9).padStart(2, '0');
        const text = `письмо ${String(at).padStart(2, '0')}`;
        addMessage(map, { from: plan.id, to: backend.id, text }, `2026-09-08T12:${minute}:00.000Z`);
      }
    });
    return created.work.id;
  };

  it('41: лента длиннее окна — и док, и оверлей стоят на её хвосте', async () => {
    await chattyWork();
    const app = open();
    try {
      await mounted(app.stdin);
      await waitFor(() => (app.lastFrame() ?? '').includes('сессии · Авторизация'));
      await resize(app, 140);

      app.stdin.write(`${PREFIX}t`);
      await waitFor(() => (app.lastFrame() ?? '').includes('тред · план'));
      // Док держится хвоста: последнее письмо видно, первое ушло вверх (6.3).
      expect(app.lastFrame()).toContain('письмо 20');
      expect(app.lastFrame()).not.toContain('письмо 01');

      // Оверлей-запасник показывает тот же хвост, а не начало ленты (6.1, 8.41).
      await resize(app, 120);
      await waitFor(() => (app.lastFrame() ?? '').includes('┌ тред · план'));
      expect(app.lastFrame()).toContain('письмо 20');
      expect(app.lastFrame()).not.toContain('письмо 01');
    } finally {
      app.unmount();
    }
  }, 30_000);
});

describe('рамка панели PTY: бюджет размеров (план рамок, задача 6)', () => {
  /** Новые колонки и строки терминала: обеим нужен кадр, чтобы эффект их подхватил. */
  const resize = async (
    app: ReturnType<typeof render>,
    columns: number,
    rows: number,
  ): Promise<void> => {
    Object.defineProperty(app.stdout, 'columns', { value: columns, configurable: true });
    Object.defineProperty(app.stdout, 'rows', { value: rows, configurable: true });
    app.stdout.emit('resize');
    await new Promise((resolve) => setTimeout(resolve, 150));
  };

  it('120×40 с сайдбаром 26: гостю достаётся 92×37 — рамка съедает по 2 на ось', async () => {
    const app = open();
    try {
      await mounted(app.stdin);
      await resize(app, 120, 40);
      await launch(app);

      app.stdin.write('size\r');
      await waitFor(() => (app.lastFrame() ?? '').includes('size 92x37'));
    } finally {
      app.unmount();
    }
  }, 30_000);

  it('узкий терминал 80×24: сайдбар сжимается до 18, гостю — 60×21', async () => {
    const app = open();
    try {
      await mounted(app.stdin);
      await resize(app, 80, 24);
      await launch(app);

      app.stdin.write('size\r');
      await waitFor(() => (app.lastFrame() ?? '').includes('size 60x21'));
    } finally {
      app.unmount();
    }
  }, 30_000);

  it('сайдбар скрыт целиком (< 60 колонок): панели вся ширина минус рамка', async () => {
    const app = open();
    try {
      await mounted(app.stdin);
      await resize(app, 50, 30);
      // На этой ширине сайдбара нет вовсе — нет и строки «сессии · », по
      // которой обычно ждёт `launch`; ждём саму заглушку агента.
      app.stdin.write(`${PREFIX}c`);
      await waitFor(() => (app.lastFrame() ?? '').includes('stub готов'));
      await new Promise((resolve) => setTimeout(resolve, 100));

      app.stdin.write('size\r');
      await waitFor(() => (app.lastFrame() ?? '').includes('size 48x27'));
    } finally {
      app.unmount();
    }
  }, 30_000);

  it('открытый док треда режет ширину тем же способом, что и рамка панели', async () => {
    const app = open();
    try {
      await mounted(app.stdin);
      await resize(app, 140, 40);
      await launch(app);

      app.stdin.write(`${PREFIX}t`);
      await waitFor(() => (app.lastFrame() ?? '').includes('тред · работа'));

      // 140 − 26 сайдбара − 32 дока (30 + рамка треда, находка сверки) − 2 рамки
      // панели = 80; строки те же (37).
      app.stdin.write('size\r');
      await waitFor(() => (app.lastFrame() ?? '').includes('size 80x37'));
    } finally {
      app.unmount();
    }
  }, 30_000);

  it('ресайз терминала в обе стороны: PTY получает уменьшенный размер каждый раз', async () => {
    const app = open();
    try {
      await mounted(app.stdin);
      await resize(app, 120, 40);
      await launch(app);

      await resize(app, 80, 24);
      await waitFor(() => (app.lastFrame() ?? '').includes('resize 60x21'));

      await resize(app, 120, 40);
      await waitFor(() => (app.lastFrame() ?? '').includes('resize 92x37'));
    } finally {
      app.unmount();
    }
  }, 30_000);
});

describe('песочница тестов', () => {
  it('без HARNAS_HOME дом уходит во временный каталог, а не в настоящий ~/.harnas', () => {
    // Жёсткое правило задания: настоящие ~/.harnas и ~/.claude тесты не трогают.
    // Панель поднимает процессы, и их запись случается уже после `afterEach` —
    // спасает подменённый `HOME` (см. `test/sandbox-home.ts`).
    delete process.env['HARNAS_HOME'];
    expect(harnasHome().startsWith(tmpdir())).toBe(true);
  });
});
