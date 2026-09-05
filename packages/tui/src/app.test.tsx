/**
 * Сценарии композиции: `new`, авто-заголовок, события и закрытие сессии
 * (чек-лист спецификации TUI v2, пункты 27–30 и 32).
 *
 * Настоящий `claude` здесь не запускается никогда: вместо него stub-бинарь,
 * а `~/.harnas`, проект и корни истории — во временных каталогах.
 */

import {
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
import { appendFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pinUnicodeGlyphs } from '../test/glyphs-env.js';
import { App } from './app.js';

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
    // Свежая работа стоит в сайдбаре первой и выбрана по умолчанию (2.1).
    await new Promise((resolve) => setTimeout(resolve, 10));
    await workWith('Платежи', 'бэкенд');

    const app = open();
    try {
      await mounted(app.stdin);
      await waitFor(() => (app.lastFrame() ?? '').includes('сессии · Платежи'));

      // Курсор входит в сайдбар на выбранной сессии, дальше идёт по работам.
      app.stdin.write(`${PREFIX}s`);
      await new Promise((resolve) => setTimeout(resolve, 150));
      app.stdin.write('j');
      await new Promise((resolve) => setTimeout(resolve, 100));
      app.stdin.write('j');
      await new Promise((resolve) => setTimeout(resolve, 100));
      app.stdin.write(ENTER);

      await waitFor(() => (app.lastFrame() ?? '').includes('сессии · Авторизация'));
      expect(lineWith(app.lastFrame() ?? '', 'план')).toContain('план');
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
      // Обе сессии в сайдбаре: до этого кадра `j`/`k` ходить ещё некуда.
      await waitFor(() => (app.lastFrame() ?? '').split('новая сессия').length > 2);

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

describe('песочница тестов', () => {
  it('без HARNAS_HOME дом уходит во временный каталог, а не в настоящий ~/.harnas', () => {
    // Жёсткое правило задания: настоящие ~/.harnas и ~/.claude тесты не трогают.
    // Панель поднимает процессы, и их запись случается уже после `afterEach` —
    // спасает подменённый `HOME` (см. `test/sandbox-home.ts`).
    delete process.env['HARNAS_HOME'];
    expect(harnasHome().startsWith(tmpdir())).toBe(true);
  });
});
