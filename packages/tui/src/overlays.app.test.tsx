/**
 * Оверлеи в живой композиции: детали, пикеры, справка, запуск, возобновление,
 * дозаказ резюме и сайдбар оверлеем (дизайн TUI v2, 2.4 и 5.2–5.3; макеты
 * 4.0–4.9). Чек-лист спецификации: пункты 31 и 33.
 *
 * Настоящий `claude` здесь не запускается никогда: вместо него stub-бинарь,
 * а `~/.harnas`, проект и корни истории — во временных каталогах.
 */

import {
  addSession,
  createWork,
  readMap,
  transitionSession,
  updateMap,
  workPaths,
  type SessionIndex,
  type WorkSession,
} from '@harnas/core';
import { render } from 'ink-testing-library';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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

const PREFIX = String.fromCharCode(0x11);
/** Префикс после смены `prefix` на `w` (сценарий настроек). */
const PREFIX_W = String.fromCharCode(0x17);
const ENTER = '\r';
const ESC = '\u001B';
const DOWN = '\u001B[B';
const LEFT = '\u001B[D';
const RIGHT = '\u001B[C';
const BACKSPACE = '\u007F';

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

/** Ждём состояния карты: запись идёт после кадра, а не вместе с ним. */
const waitMap = async (
  workId: string,
  check: (map: Awaited<ReturnType<typeof readMap>>) => boolean,
  timeoutMs = 8000,
): Promise<void> => {
  const started = Date.now();
  while (!check(await readMap(project, workId))) {
    if (Date.now() - started > timeoutMs) throw new Error('карта не дождалась');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

/** Ink подписывается на stdin эффектом: до подписки запись теряется молча. */
const mounted = async (app: ReturnType<typeof render>): Promise<void> => {
  await waitFor(() => app.stdin.listenerCount('data') > 0);
  await new Promise((resolve) => setTimeout(resolve, 120));
};

/**
 * Оверлей подписывается на ввод эффектом Ink: клавиша, посланная в тот же такт,
 * что и его первый кадр, пропала бы молча.
 */
const settled = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 150));

const open = (sessions: SessionIndex[] = []): ReturnType<typeof render> =>
  render(<App sessions={sessions} root={logs} codexRoot={logs} projectPath={project} />);

/** Работа с одной сессией в нужном статусе: на ней и открываются оверлеи. */
const workWith = async (
  label: string,
  status: WorkSession['status'],
  over: Partial<WorkSession> = {},
): Promise<{ workId: string; id: string }> => {
  const created = await createWork(project, { title: 'Авторизация', goal: '' });
  let id = '';
  await updateMap(project, created.work.id, (map) => {
    const session = addSession(map, { provider: 'claude', label, task: 'шаги 1–3' });
    if (status !== 'pending') transitionSession(map, session.id, 'active');
    if (status !== 'pending' && status !== 'active') {
      transitionSession(map, session.id, status, { exitCode: 0 });
    }
    Object.assign(session, over);
    id = session.id;
  });
  await mkdir(workPaths(project, created.work.id).events, { recursive: true });
  return { workId: created.work.id, id };
};

/** Запись индекса логов: по ней живут пикер истории, детали и метрики. */
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
    startedAt: '2026-09-05T08:00:00.000Z',
    endedAt: '2026-09-05T08:41:00.000Z',
    lastUserRecordAt: null,
    durationMs: 41 * 60_000,
    records: 5,
    malformedLines: 0,
    models: {},
    tools: {},
    roles: {},
    recordTypes: {},
    primaryModel: 'claude-opus-5',
    subsessionCount: 0,
    provider: 'claude',
    tokens: { input: 12_000, output: 3100, cacheRead: 0, cacheWrite: 0 },
  };
}

describe('пикер истории: возобновление (5.3, чек-лист 31)', () => {
  it('31: Enter регистрирует сессию в текущей работе и запускает --resume', async () => {
    const { workId } = await workWith('план', 'exited');
    const uuid = '7fa0e1ee-cc7b-4f3a-9a11-000000000001';
    const app = open([logIndex(uuid, 'исправить flaky-тест auth')]);
    try {
      await mounted(app);
      await waitFor(() => (app.lastFrame() ?? '').includes('сессии · '));

      app.stdin.write(`${PREFIX}g`);
      await waitFor(() => (app.lastFrame() ?? '').includes('┌ история · '));
      const picker = app.lastFrame() ?? '';
      // Заголовок — путь проекта, а не одно его имя (макет 4.3).
      expect(picker).toContain('┌ история · /');
      expect(picker).toContain('исправить flaky-тест auth');
      // Возраст, длительность и токены — правая колонка макета 4.3.
      expect(picker).toContain('41м');
      expect(picker).toContain('Enter — возобновить в «Авторизация»');

      await settled();
      app.stdin.write(ENTER);
      await waitFor(() => (app.lastFrame() ?? '').includes('stub готов'));

      // История сессии начинается с `active`: `pending` у неё не было (5.3).
      const created = (await readMap(project, workId)).sessions.find(
        (item) => item.providerSessionId === uuid,
      );
      expect(created?.status).toBe('active');
      expect(created?.history.map((step) => step.status)).toEqual(['active']);
      expect(created?.label).toBe('исправить flaky-тест auth');

      // До бинаря доехали `--resume`, конфиг MCP и файл хуков.
      expect(app.lastFrame()).toContain('flags=--resume,--mcp-config,--settings');
      expect(app.lastFrame()).toContain(`harnas=${created?.id ?? '?'}@${workId}`);

      // Метрики считаются по всему транскрипту, включая часть до регистрации.
      await waitFor(() => (app.lastFrame() ?? '').includes('↑12к ↓3.1к'));
    } finally {
      app.unmount();
    }
  }, 30_000);
});

describe('битый конфиг (раздел 10, чек-лист 33)', () => {
  it('33: дефолты остаются в силе, а причина уезжает в строку статуса', async () => {
    await writeFile(path.join(home, 'config.json'), '{ это не json', 'utf8');
    const app = open();
    try {
      await mounted(app);
      // Путь временного HARNAS_HOME длинный: на 100 колонках хвост события
      // обрезался бы строкой статуса (§3).
      Object.defineProperty(app.stdout, 'columns', { value: 200, configurable: true });
      app.stdout.emit('resize');
      await waitFor(() => (app.lastFrame() ?? '').includes('не читается'));
      expect(app.lastFrame()).toContain('⚑');
      expect(app.lastFrame()).toContain('работаю с дефолтами');

      // Префикс остался дефолтным: `ctrl+q` по-прежнему ловится харнессом.
      app.stdin.write(PREFIX);
      await waitFor(() => (app.lastFrame() ?? '').includes('ctrl+q …'));
    } finally {
      app.unmount();
    }
  }, 30_000);

  it('ascii из настроек включает запасной набор глифов (раздел 7)', async () => {
    await writeFile(path.join(home, 'config.json'), JSON.stringify({ ascii: true }), 'utf8');
    const app = open();
    try {
      await mounted(app);
      // Локаль здесь юникодная, а `HARNAS_ASCII` не задан: запасной набор мог
      // прийти только из `config.ascii` — другого источника у глифов нет.
      await waitFor(() => !(app.lastFrame() ?? '').includes('│'));
      expect(app.lastFrame()).toContain('|');
    } finally {
      app.unmount();
    }
  }, 30_000);
});

describe('детали сессии (макет 4.1)', () => {
  it('открываются по prefix i и правят цель работы по e', async () => {
    const { workId } = await workWith('бэкенд', 'active');
    const app = open();
    try {
      await mounted(app);
      await waitFor(() => (app.lastFrame() ?? '').includes('сессии · '));

      app.stdin.write(`${PREFIX}i`);
      await waitFor(() => (app.lastFrame() ?? '').includes('┌ детали · бэкенд'));
      expect(app.lastFrame()).toContain('ЗАДАЧА');
      expect(app.lastFrame()).toContain('шаги 1–3');
      expect(app.lastFrame()).toContain('ЦЕЛЬ');

      // `e` открывает однострочное поле, `Enter` сохраняет цель в карту (решение №8).
      await settled();
      app.stdin.write('e');
      await waitFor(() => (app.lastFrame() ?? '').includes('Enter — сохранить цель'));
      await settled();
      app.stdin.write('логин');
      await waitFor(() => (app.lastFrame() ?? '').includes('логин▌'));
      await settled();

      // Клик при открытом оверлее не делает ничего и в поле не попадает (3.1):
      // Ink слушает тот же stdin и отдал бы событие мыши текстом.
      app.stdin.write(`${ESC}[<0;12;5M${ESC}[<0;12;5m`);
      await settled();
      expect(app.lastFrame()).toContain('логин▌');
      expect(app.lastFrame()).not.toContain('[<');

      app.stdin.write(ENTER);
      await settled();
      await waitMap(workId, (map) => map.work.goal === 'логин');

      // Esc закрывает оверлей без изменений (§4.0).
      app.stdin.write(ESC);
      await waitFor(() => !(app.lastFrame() ?? '').includes('┌ детали'));
    } finally {
      app.unmount();
    }
  }, 30_000);
});

describe('пикер работ (макет 4.2)', () => {
  it('показывает работы других проектов и закрепляет выбранную в сайдбаре', async () => {
    await workWith('план', 'active');
    const other = await mkdtemp(path.join(tmpdir(), 'harnas-other-'));
    try {
      await createWork(other, { title: 'Автоплатежи', goal: '' });
      const app = open();
      try {
        await mounted(app);
        await waitFor(() => (app.lastFrame() ?? '').includes('сессии · '));
        // Работы чужого проекта в сайдбаре нет, пока её не выбрали (решение №3).
        expect(app.lastFrame()).not.toContain('Автоплатежи');

        app.stdin.write(`${PREFIX}w`);
        await waitFor(() => (app.lastFrame() ?? '').includes('┌ работы'));
        expect(app.lastFrame()).toContain('Автоплатежи');

        // Фильтр — простой набор текста (макет 4.2).
        await settled();
        app.stdin.write('автоп');
        await waitFor(() => (app.lastFrame() ?? '').includes('> автоп▌'));
        // Отфильтрованной работы в списке оверлея нет (в сайдбаре она осталась).
        expect(app.lastFrame()).not.toContain('│ Авторизация');

        await settled();
        app.stdin.write(ENTER);
        await waitFor(() => (app.lastFrame() ?? '').includes('сессии · Автоплатежи'));
        // Чужая работа закрепилась в сайдбаре (2.1).
        expect(app.lastFrame()).not.toContain('┌ работы');
      } finally {
        app.unmount();
      }
    } finally {
      await rm(other, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  }, 30_000);
});

describe('справка (макет 4.4)', () => {
  it('первой строкой объясняет, как сменить префикс, и фильтруется', async () => {
    const app = open();
    try {
      await mounted(app);
      app.stdin.write(`${PREFIX}?`);
      await waitFor(() => (app.lastFrame() ?? '').includes('┌ привязки · префикс ctrl+q'));
      expect(app.lastFrame()).toContain('префикс перехватывает терминал?');
      expect(app.lastFrame()).toContain('HARNAS_PREFIX');

      await settled();
      app.stdin.write('работ');
      await waitFor(() => !(app.lastFrame() ?? '').includes('эта справка'));
      expect(app.lastFrame()).toContain('пикер работ');

      await settled();
      app.stdin.write(ESC);
      await waitFor(() => !(app.lastFrame() ?? '').includes('┌ привязки'));
    } finally {
      app.unmount();
    }
  }, 30_000);
});

describe('запуск pending (макет 4.5)', () => {
  it('Enter на ◌ показывает бриф с диска и запускает агента', async () => {
    const created = await createWork(project, { title: 'Авторизация', goal: '' });
    const workId = created.work.id;
    const sessionId = await createPendingSession(project, workId, {
      provider: 'claude',
      label: 'тесты',
      task: 'прогнать e2e',
    });
    const brief = path.join(workPaths(project, workId).briefs, `${sessionId}.md`);

    const app = open();
    try {
      await mounted(app);
      await waitFor(() => (app.lastFrame() ?? '').includes('сессии · '));

      // Enter в режиме навигации на `pending` открывает оверлей запуска (§8).
      app.stdin.write(`${PREFIX}s`);
      await new Promise((resolve) => setTimeout(resolve, 150));
      app.stdin.write(ENTER);
      await waitFor(() => (app.lastFrame() ?? '').includes('┌ запуск ◌ тесты'));
      expect(app.lastFrame()).toContain('бриф: .harnas/works/');
      expect(app.lastFrame()).toContain('прогнать e2e');

      // Бриф перечитывается с диска: между показами его правят своим редактором.
      await settled();
      app.stdin.write(ESC);
      await waitFor(() => !(app.lastFrame() ?? '').includes('┌ запуск'));
      await writeFile(brief, 'правленый бриф\n', 'utf8');
      app.stdin.write(`${PREFIX}s`);
      await new Promise((resolve) => setTimeout(resolve, 150));
      app.stdin.write(ENTER);
      await waitFor(() => (app.lastFrame() ?? '').includes('правленый бриф'));

      await new Promise((resolve) => setTimeout(resolve, 150));
      app.stdin.write(ENTER);
      await waitFor(() => (app.lastFrame() ?? '').includes('stub готов'));
      await waitMap(workId, (map) => map.sessions[0]?.status === 'active');
    } finally {
      app.unmount();
    }
  }, 30_000);
});

describe('возобновление и дозаказ резюме (макеты 4.6 и 4.7)', () => {
  it('prefix r возобновляет вышедшую сессию через --resume', async () => {
    const uuid = '7fa0e1ee-cc7b-4f3a-9a11-000000000002';
    const { workId } = await workWith('бэкенд', 'exited', { providerSessionId: uuid });
    const app = open();
    try {
      await mounted(app);
      await waitFor(() => (app.lastFrame() ?? '').includes('сессии · '));

      app.stdin.write(`${PREFIX}r`);
      await waitFor(() => (app.lastFrame() ?? '').includes('┌ возобновить ○ бэкенд'));
      expect(app.lastFrame()).toContain('claude --resume 7fa0e1ee');
      expect(app.lastFrame()).toContain('вышла');

      await new Promise((resolve) => setTimeout(resolve, 150));
      app.stdin.write(ENTER);
      await waitFor(() => (app.lastFrame() ?? '').includes('flags=--resume'));
      await waitMap(workId, (map) => map.sessions[0]?.status === 'active');
      expect((await readMap(project, workId)).sessions[0]?.history.at(-1)?.status).toBe('active');
    } finally {
      app.unmount();
    }
  }, 30_000);

  it('prefix R объясняет дозаказ резюме и закрывается по Esc', async () => {
    await workWith('бэкенд', 'exited');
    const app = open();
    try {
      await mounted(app);
      await waitFor(() => (app.lastFrame() ?? '').includes('сессии · '));

      app.stdin.write(`${PREFIX}R`);
      await waitFor(() => (app.lastFrame() ?? '').includes('┌ резюме для ○ бэкенд'));
      expect(app.lastFrame()).toContain('claude -p по транскрипту');

      await new Promise((resolve) => setTimeout(resolve, 150));
      app.stdin.write(ESC);
      await waitFor(() => !(app.lastFrame() ?? '').includes('┌ резюме'));
    } finally {
      app.unmount();
    }
  }, 30_000);
});

describe('сайдбар оверлеем (макет 1.3, решение №9)', () => {
  it('на терминале уже 60 колонок prefix b открывает и закрывает его', async () => {
    await workWith('план', 'active');
    const app = open();
    try {
      await mounted(app);
      await waitFor(() => (app.lastFrame() ?? '').includes('сессии · '));

      // Терминал сузился: сайдбар прячется сам (2.1).
      Object.defineProperty(app.stdout, 'columns', { value: 50, configurable: true });
      app.stdout.emit('resize');
      await waitFor(() => !(app.lastFrame() ?? '').includes('сессии · '));
      // Клавиши читают настройки из ссылки, которую обновляет эффект: до неё
      // новая ширина не доехала бы (3.1).
      await settled();

      app.stdin.write(`${PREFIX}b`);
      await waitFor(() => (app.lastFrame() ?? '').includes('сессии · '));
      expect(app.lastFrame()).toContain('план');

      // Закрывается повторным `b` (решение №9).
      await settled();
      app.stdin.write('b');
      await waitFor(() => !(app.lastFrame() ?? '').includes('сессии · '));
    } finally {
      app.unmount();
    }
  }, 30_000);
});

describe('настройки (макет 4.14)', () => {
  /**
   * Клавиша за клавишей: Ink отдаёт обработчику каждый кусок stdin целиком, и
   * пять стрелок одной записью были бы одной непонятной последовательностью.
   */
  const press = async (app: ReturnType<typeof render>, key: string, times = 1): Promise<void> => {
    for (let step = 0; step < times; step += 1) {
      app.stdin.write(key);
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
  };

  /** Строка оверлея с этим ключом: значение и подсказка стоят в ней же. */
  const row = (app: ReturnType<typeof render>, key: string): string =>
    (app.lastFrame() ?? '').split('\n').find((line) => line.includes(key)) ?? '';

  /** `config.json` во временном доме; `null` — его ещё нет. */
  const readConfig = async (): Promise<Record<string, unknown> | null> => {
    try {
      return JSON.parse(await readFile(path.join(home, 'config.json'), 'utf8')) as Record<
        string,
        unknown
      >;
    } catch {
      return null;
    }
  };

  /** Запись идёт после кадра: файла ждём отдельно от рамки. */
  const waitConfig = async (
    check: (data: Record<string, unknown> | null) => boolean,
    timeoutMs = 8000,
  ): Promise<void> => {
    const started = Date.now();
    while (!check(await readConfig())) {
      if (Date.now() - started > timeoutMs) throw new Error('настройки не дождались');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };

  const openSettings = async (app: ReturnType<typeof render>): Promise<void> => {
    await mounted(app);
    app.stdin.write(`${PREFIX},`);
    await waitFor(() => (app.lastFrame() ?? '').includes('┌ настройки'));
    await settled();
  };

  it('Enter переключает булеву настройку и сразу пишет её в файл', async () => {
    const app = open();
    try {
      await openSettings(app);
      expect(app.lastFrame()).toContain('autoLaunch');
      await waitFor(() => row(app, 'autoLaunch').includes('да'));

      await press(app, DOWN, 8);
      app.stdin.write(ENTER);
      await waitConfig((data) => data?.['autoLaunch'] === false);
      await waitFor(() => row(app, 'autoLaunch').includes('нет'));

      await settled();
      app.stdin.write(ENTER);
      await waitConfig((data) => data?.['autoLaunch'] === true);
      await waitFor(() => row(app, 'autoLaunch').includes('да'));
    } finally {
      app.unmount();
    }
  }, 30_000);

  it('ввод числа сохраняется, а подвал возвращается к «изменить»', async () => {
    const app = open();
    try {
      await openSettings(app);
      await press(app, DOWN);
      app.stdin.write(ENTER);
      await waitFor(() => row(app, 'sidebarWidth').includes('26▌'));

      await press(app, BACKSPACE, 2);
      await press(app, '40');
      await waitFor(() => row(app, 'sidebarWidth').includes('40▌'));

      app.stdin.write(ENTER);
      await waitConfig((data) => data?.['sidebarWidth'] === 40);
      await waitFor(() => !(app.lastFrame() ?? '').includes('▌'));
      expect(app.lastFrame()).toContain('Enter — изменить');
    } finally {
      app.unmount();
    }
  }, 30_000);

  it('битое значение — событие в строке статуса, ввод остаётся открытым', async () => {
    const app = open();
    try {
      await openSettings(app);
      app.stdin.write(ENTER);
      await waitFor(() => row(app, 'prefix').includes('q▌'));

      await press(app, BACKSPACE);
      await press(app, 'ww');
      app.stdin.write(ENTER);
      await waitFor(() => (app.lastFrame() ?? '').includes('prefix: ожидается один знак'));
      // Ввод никуда не делся: курсор на месте, а файла так и нет.
      expect(row(app, 'prefix')).toContain('ww▌');
      expect(await readConfig()).toBeNull();
    } finally {
      app.unmount();
    }
  }, 30_000);

  it('строка из окружения тусклая, а Enter на ней только объясняет', async () => {
    process.env['HARNAS_MOUSE'] = '0';
    const app = open();
    try {
      await openSettings(app);
      await waitFor(() => row(app, 'mouseCapture').includes('задано HARNAS_MOUSE'));

      await press(app, DOWN, 2);
      app.stdin.write(ENTER);
      await waitFor(() => (app.lastFrame() ?? '').includes('задано окружением HARNAS_MOUSE'));
      expect(await readConfig()).toBeNull();
    } finally {
      app.unmount();
      delete process.env['HARNAS_MOUSE'];
    }
  }, 30_000);

  it('смена prefix действует сразу: справка открывается по новому префиксу', async () => {
    const app = open();
    try {
      await openSettings(app);
      app.stdin.write(ENTER);
      await waitFor(() => row(app, 'prefix').includes('q▌'));

      await press(app, BACKSPACE);
      await press(app, 'w');
      app.stdin.write(ENTER);
      await waitConfig((data) => data?.['prefix'] === 'w');
      await settled();
      app.stdin.write(ESC);
      await waitFor(() => !(app.lastFrame() ?? '').includes('┌ настройки'));

      await settled();
      app.stdin.write(`${PREFIX_W}?`);
      await waitFor(() => (app.lastFrame() ?? '').includes('┌ привязки · префикс ctrl+w'));

      // Прежний `ctrl+q` теперь принадлежит гостю: справку он не открывает.
      await settled();
      app.stdin.write(ESC);
      await waitFor(() => !(app.lastFrame() ?? '').includes('┌ привязки'));
      await settled();
      app.stdin.write(`${PREFIX}?`);
      await settled();
      expect(app.lastFrame()).not.toContain('┌ привязки');
    } finally {
      app.unmount();
    }
  }, 30_000);

  it('Esc закрывает ввод, второй — оверлей, файл не тронут', async () => {
    const app = open();
    try {
      await openSettings(app);
      app.stdin.write(ENTER);
      await waitFor(() => row(app, 'prefix').includes('q▌'));

      await settled();
      app.stdin.write(ESC);
      await waitFor(() => (app.lastFrame() ?? '').includes('Enter — изменить'));
      expect(app.lastFrame()).toContain('┌ настройки');

      await settled();
      app.stdin.write(ESC);
      await waitFor(() => !(app.lastFrame() ?? '').includes('┌ настройки'));
      expect(await readConfig()).toBeNull();
    } finally {
      app.unmount();
    }
  }, 30_000);

  it('14: ascii из оверлея переключает глифы в следующем кадре', async () => {
    const app = open();
    try {
      await openSettings(app);
      await press(app, DOWN, 3);
      app.stdin.write(ENTER);
      // Рамка того же оверлея в следующем кадре — из запасного набора (6.1).
      await waitFor(() => (app.lastFrame() ?? '').includes('+ настройки'));
      expect(app.lastFrame()).not.toContain('┌ настройки');
      expect(row(app, 'ascii')).toContain('да');
    } finally {
      app.unmount();
    }
  }, 30_000);

  it('тема: ←/→ листают THEME_NAMES по кругу, Enter шагает вперёд без ввода', async () => {
    const app = open();
    try {
      await openSettings(app);
      // Тема — последняя строка настроек (SETTINGS, дизайн 3.4): девять шагов вниз.
      await press(app, DOWN, 9);
      await waitFor(() => row(app, 'theme').includes('mocha'));
      expect(app.lastFrame()).toContain('←/→ — палитра');

      // Левый край списка — по кругу на 'terminal', а не застревание на месте.
      app.stdin.write(LEFT);
      await waitConfig((data) => data?.['theme'] === 'terminal');
      await waitFor(() => row(app, 'theme').includes('terminal'));

      app.stdin.write(LEFT);
      await waitConfig((data) => data?.['theme'] === 'tokyo-night');
      await waitFor(() => row(app, 'theme').includes('tokyo-night'));

      app.stdin.write(RIGHT);
      await waitConfig((data) => data?.['theme'] === 'terminal');
      await waitFor(() => row(app, 'theme').includes('terminal'));

      // Правый край списка — по кругу обратно на 'mocha'.
      app.stdin.write(RIGHT);
      await waitConfig((data) => data?.['theme'] === 'mocha');
      await waitFor(() => row(app, 'theme').includes('mocha'));

      // Enter на строке темы шагает вперёд и не открывает ввод текста.
      await settled();
      app.stdin.write(ENTER);
      await waitConfig((data) => data?.['theme'] === 'latte');
      await waitFor(() => row(app, 'theme').includes('latte'));
      expect(app.lastFrame()).not.toContain('▌');
    } finally {
      app.unmount();
    }
  }, 30_000);

  it('тема из HARNAS_THEME: строка тусклая, ←/→ и Enter только объясняют', async () => {
    process.env['HARNAS_THEME'] = 'nord';
    const app = open();
    try {
      await openSettings(app);
      await press(app, DOWN, 9);
      await waitFor(() => row(app, 'theme').includes('задано HARNAS_THEME'));

      app.stdin.write(RIGHT);
      await waitFor(() => (app.lastFrame() ?? '').includes('задано окружением HARNAS_THEME'));
      expect(await readConfig()).toBeNull();

      await settled();
      app.stdin.write(ENTER);
      await waitFor(() => (app.lastFrame() ?? '').includes('задано окружением HARNAS_THEME'));
      expect(await readConfig()).toBeNull();
    } finally {
      app.unmount();
      delete process.env['HARNAS_THEME'];
    }
  }, 30_000);
});
