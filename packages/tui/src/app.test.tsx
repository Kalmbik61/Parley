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
  readMap,
  readWorksIndex,
  transitionSession,
  updateMap,
  workPaths,
  type SessionIndex,
  type WorkSession,
} from '@harnas/core';
import { render } from 'ink-testing-library';
import { appendFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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

  it('30: подключение гасит unseen', async () => {
    const { workId, id } = await outsideSession('план');
    await appendFile(path.join(workPaths(project, workId).events, `${id}.jsonl`), hook('Stop'));

    const app = open();
    try {
      await mounted(app.stdin);
      await waitFor(() => lineWith(app.lastFrame() ?? '', 'план').includes('unseen'));

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
    await appendFile(path.join(workPaths(project, workId).events, `${id}.jsonl`), hook('Stop'));

    const app = open();
    try {
      await mounted(app.stdin);
      await waitFor(() => lineWith(app.lastFrame() ?? '', 'план').includes('unseen'));

      app.stdin.write(`${PREFIX}s`);
      await new Promise((resolve) => setTimeout(resolve, 150));
      // Ходьба по сайдбару — это ещё не подключение: `unseen` держится.
      app.stdin.write('j');
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(lineWith(app.lastFrame() ?? '', 'план')).toContain('unseen');

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
