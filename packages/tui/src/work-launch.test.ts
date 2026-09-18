import { createWork, readMap, transitionSession, updateMap, workPaths } from '@harnas/core';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createChildSession,
  createNewSession,
  createPendingSession,
  finishExited,
  linkSession,
  planLaunch,
  planNew,
  planResume,
  readBrief,
  startSession,
} from './work-launch.js';

/** Пути к бинарям подменяются на заглушку: настоящий агент здесь не запускается. */
const STUB = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'test',
  'stub-agent.mjs',
);

let home = '';
let project = '';
let logs = '';
const saved: Record<string, string | undefined> = {};

const setEnv = (name: string, value: string | undefined): void => {
  saved[name] = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
};

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'harnas-home-'));
  project = await mkdtemp(path.join(tmpdir(), 'harnas-project-'));
  // Пустой корень истории: метрики читаются отсюда, а не из настоящего ~/.claude.
  logs = await mkdtemp(path.join(tmpdir(), 'harnas-logs-'));
  process.env['HARNAS_HOME'] = home;
  setEnv('HARNAS_CLAUDE_BIN', STUB);
  setEnv('HARNAS_CODEX_BIN', STUB);
  setEnv('HARNAS_GLM_BIN', '');
});

afterEach(async () => {
  delete process.env['HARNAS_HOME'];
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await Promise.all([home, project, logs].map((dir) => rm(dir, { recursive: true, force: true })));
});

/** Работа с одной `pending` сессией — исходная точка всех запусков. */
async function pending(provider: string): Promise<{ workId: string; sessionId: string }> {
  const created = await createWork(project, { title: 'Авторизация', goal: 'логин по e-mail' });
  const workId = created.work.id;
  const sessionId = await createPendingSession(project, workId, {
    provider,
    label: 'тесты',
    task: 'прогнать e2e после шагов 1–3',
  });
  return { workId, sessionId };
}

const sessionOf = async (workId: string, sessionId: string) => {
  const session = (await readMap(project, workId)).sessions.find((item) => item.id === sessionId);
  if (session === undefined) throw new Error(`нет сессии ${sessionId}`);
  return session;
};

describe('создание pending сессии', () => {
  it('кладёт запись в карту и пишет бриф на диск', async () => {
    const { workId, sessionId } = await pending('claude');
    const session = await sessionOf(workId, sessionId);

    expect(session.status).toBe('pending');
    expect(session.parent).toBeNull();
    const brief = await readFile(
      path.join(workPaths(project, workId).briefs, `${sessionId}.md`),
      'utf8',
    );
    expect(brief).toContain('Авторизация');
    expect(brief).toContain('прогнать e2e');
    expect(brief).toContain('report');
  });

  it('дочерняя сессия руками: родитель, контекст и бриф с его резюме (prefix C)', async () => {
    const { workId, sessionId } = await pending('claude');
    await updateMap(project, workId, (map) => {
      const parent = map.sessions.find((item) => item.id === sessionId);
      if (parent !== undefined) parent.summary = 'миграции готовы';
    });

    const { session: child } = await createChildSession(project, workId, sessionId);
    expect(child.parent).toBe(sessionId);
    expect(child.contextFrom).toEqual([sessionId]);
    const brief = await readFile(
      path.join(workPaths(project, workId).briefs, `${child.id}.md`),
      'utf8',
    );
    expect(brief).toContain('тесты');
    expect(brief).toContain('миграции готовы');
  });

  it('пропавший бриф собирается заново — запускать сессию всё равно нужно', async () => {
    const { workId, sessionId } = await pending('claude');
    await rm(path.join(workPaths(project, workId).briefs, `${sessionId}.md`));

    expect(await readBrief(project, workId, sessionId)).toContain('прогнать e2e');
  });
});

describe('план запуска', () => {
  it('claude получает id сессии, конфиг MCP файлом и бриф промптом', async () => {
    const { workId, sessionId } = await pending('claude');
    const plan = await planLaunch(project, workId, await sessionOf(workId, sessionId));
    const paths = workPaths(project, workId);

    expect(plan.command).toBe('claude');
    expect(plan.cwd).toBe(project);
    expect(plan.env).toEqual({ HARNAS_WORK_DIR: paths.dir, HARNAS_SESSION_ID: sessionId });
    expect(plan.providerSessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/);
    expect(plan.args.slice(0, 2)).toEqual(['--session-id', plan.providerSessionId]);

    const configFile = plan.args[plan.args.indexOf('--mcp-config') + 1];
    expect(configFile).toBe(path.join(paths.mcp, `${sessionId}.json`));
    const config = JSON.parse(await readFile(configFile as string, 'utf8'));
    expect(config.mcpServers.harnas.env).toEqual({
      HARNAS_WORK_DIR: paths.dir,
      HARNAS_SESSION_ID: sessionId,
    });

    expect(plan.args.at(-1)).toContain('прогнать e2e');
  });

  it('codex получает сервер значением -c, файла конфига ему не пишется', async () => {
    const { workId, sessionId } = await pending('codex');
    const plan = await planLaunch(project, workId, await sessionOf(workId, sessionId));

    expect(plan.command).toBe('codex');
    expect(plan.args[0]).toBe('-c');
    expect(plan.args[1]).toContain('mcp_servers.harnas=');
    expect(plan.args[1]).toContain(workPaths(project, workId).dir);
    // Id снаружи codex не принимает — гадать за него нечего.
    expect(plan.providerSessionId).toBeNull();
    expect(plan.args).not.toContain('--session-id');
    await expect(
      readFile(path.join(workPaths(project, workId).mcp, `${sessionId}.json`), 'utf8'),
    ).rejects.toThrow();
  });

  it('бриф перечитывается с диска: правку до запуска агент видит', async () => {
    const { workId, sessionId } = await pending('claude');
    const brief = path.join(workPaths(project, workId).briefs, `${sessionId}.md`);
    await writeFile(brief, 'правленый бриф\n', 'utf8');

    const plan = await planLaunch(project, workId, await sessionOf(workId, sessionId));
    expect(plan.args.at(-1)).toBe('правленый бриф\n');
  });

  it('с push в команде появляется флаг канала, а в конфиге MCP — HARNAS_CHANNEL', async () => {
    const { workId, sessionId } = await pending('claude');
    const plan = await planLaunch(project, workId, await sessionOf(workId, sessionId), {
      channel: true,
    });

    const at = plan.args.indexOf('--dangerously-load-development-channels');
    expect(at).toBeGreaterThan(-1);
    expect(plan.args[at + 1]).toBe('server:harnas');
    expect(plan.warnings).toEqual([]);

    const configFile = plan.args[plan.args.indexOf('--mcp-config') + 1] as string;
    const config = JSON.parse(await readFile(configFile, 'utf8'));
    expect(config.mcpServers.harnas.env.HARNAS_CHANNEL).toBe('1');
  });

  it('без push ни флага, ни переменной: сессия живёт по pull', async () => {
    const { workId, sessionId } = await pending('claude');
    const plan = await planLaunch(project, workId, await sessionOf(workId, sessionId));

    expect(plan.args).not.toContain('--dangerously-load-development-channels');
    const configFile = plan.args[plan.args.indexOf('--mcp-config') + 1] as string;
    const config = JSON.parse(await readFile(configFile, 'utf8'));
    expect(config.mcpServers.harnas.env).not.toHaveProperty('HARNAS_CHANNEL');
  });

  it('оверрайд providers.json без {channel} выключает push, но не молча', async () => {
    // Оверрайд заменяет `args` целиком — это законно, и всё же push пропал бы
    // без следа: харнесс говорит об этом строкой статуса (4.4).
    await writeFile(
      path.join(home, 'providers.json'),
      JSON.stringify({ claude: { args: ['--session-id', '{sessionUuid}', '{prompt}'] } }),
      'utf8',
    );
    const { workId, sessionId } = await pending('claude');
    const plan = await planLaunch(project, workId, await sessionOf(workId, sessionId), {
      channel: true,
    });

    expect(plan.args).not.toContain('--dangerously-load-development-channels');
    expect(plan.warnings).toEqual(['providers.json без {channel}: push выключен']);
  });

  it('роль сессии уезжает флагом --agent; без роли пара выпадает целиком', async () => {
    // Пикера агентов в TUI нет: роль выбрана при создании записи, и запуск
    // обязан её донести — иначе сессия стартует обычным claude (5.1).
    const created = await createWork(project, { title: 'Авторизация', goal: '' });
    const workId = created.work.id;
    const roled = await createPendingSession(project, workId, {
      provider: 'claude',
      label: 'ревью',
      task: 'посмотреть шаги 1–3',
      agent: 'reviewer',
    });
    const plan = await planLaunch(project, workId, await sessionOf(workId, roled));

    const at = plan.args.indexOf('--agent');
    expect(at).toBeGreaterThan(-1);
    expect(plan.args[at + 1]).toBe('reviewer');

    const plain = await createPendingSession(project, workId, {
      provider: 'claude',
      label: 'тесты',
      task: 'прогнать e2e',
    });
    const without = await planLaunch(project, workId, await sessionOf(workId, plain));
    expect(without.args).not.toContain('--agent');
  });

  it('неизвестный провайдер — ошибка, а не запуск наугад', async () => {
    const { workId, sessionId } = await pending('выдуманный');
    await expect(planLaunch(project, workId, await sessionOf(workId, sessionId))).rejects.toThrow(
      /выдуманный/,
    );
  });
});

describe('план возобновления', () => {
  it('идёт resumeArgs с id сессии у провайдера', async () => {
    const { workId, sessionId } = await pending('codex');
    await startSession(project, workId, sessionId, null);
    await finishExited(
      project,
      workId,
      sessionId,
      { exitCode: 0, signal: undefined },
      {
        claudeRoot: logs,
        codexRoot: logs,
      },
    );
    const map = await readMap(project, workId);
    map.sessions[0]!.providerSessionId = '7fa0e1ee-cc7b-4a1e-9d4e-000000000001';

    const plan = await planResume(project, workId, map.sessions[0]!);
    expect(plan.command).toBe('codex');
    expect(plan.args.slice(0, 2)).toEqual(['resume', '7fa0e1ee-cc7b-4a1e-9d4e-000000000001']);
    expect(plan.args[2]).toBe('-c');
    // Бриф второй раз не подставляется: сессия продолжается, а не начинается.
    expect(plan.args.join(' ')).not.toContain('прогнать e2e');
  });

  it('возобновление с push тоже несёт флаг канала: сессия просыпается и после resume', async () => {
    const { workId, sessionId } = await pending('claude');
    await updateMap(project, workId, (map) => {
      const session = map.sessions.find((item) => item.id === sessionId);
      if (session !== undefined) session.providerSessionId = 'c0ffee00-1111-2222-3333-444455556666';
    });
    const plan = await planResume(project, workId, await sessionOf(workId, sessionId), {
      channel: true,
    });

    const at = plan.args.indexOf('--dangerously-load-development-channels');
    expect(plan.args[at + 1]).toBe('server:harnas');
  });

  it('возобновление идёт под той же ролью: агент живёт в процессе, а не в транскрипте', async () => {
    const created = await createWork(project, { title: 'Авторизация', goal: '' });
    const workId = created.work.id;
    const sessionId = await createPendingSession(project, workId, {
      provider: 'claude',
      label: 'ревью',
      task: 'посмотреть шаги 1–3',
      agent: 'reviewer',
    });
    await updateMap(project, workId, (map) => {
      const session = map.sessions.find((item) => item.id === sessionId);
      if (session !== undefined) session.providerSessionId = 'c0ffee00-1111-2222-3333-444455556666';
    });

    const plan = await planResume(project, workId, await sessionOf(workId, sessionId));
    expect(plan.args[plan.args.indexOf('--agent') + 1]).toBe('reviewer');
  });

  it('без id у провайдера запускает новый процесс по брифу', async () => {
    const { workId, sessionId } = await pending('codex');
    const plan = await planResume(project, workId, await sessionOf(workId, sessionId));

    expect(plan.args).not.toContain('resume');
    expect(plan.args.at(-1)).toContain('прогнать e2e');
  });
});

describe('системная вставка гида', () => {
  /** Значение `--append-system-prompt` в плане запуска; '' — флага нет. */
  const guidanceOf = (args: string[]): string =>
    args[args.indexOf('--append-system-prompt') + 1] ?? '';

  it('доезжает во всех трёх режимах: launch, new и resume', async () => {
    const { workId, sessionId } = await pending('claude');
    const session = await sessionOf(workId, sessionId);

    for (const plan of [
      await planLaunch(project, workId, session),
      await planNew(project, workId, session),
    ]) {
      expect(plan.args).toContain('--append-system-prompt');
      expect(guidanceOf(plan.args)).toContain(sessionId);
      expect(guidanceOf(plan.args)).toContain(workId);
    }

    // Системный промпт живёт в процессе, а не в транскрипте: при `--resume` он
    // собирается заново, иначе агент поднялся бы, не зная про харнесс.
    const map = await readMap(project, workId);
    map.sessions[0]!.providerSessionId = '7fa0e1ee-cc7b-4a1e-9d4e-000000000002';
    const resumed = await planResume(project, workId, map.sessions[0]!);
    expect(resumed.args).toContain('--resume');
    expect(guidanceOf(resumed.args)).toContain(sessionId);
  });

  it('тихий ребёнок: бриф в системной вставке, промптом его нет', async () => {
    const { workId, sessionId } = await pending('claude');
    await updateMap(project, workId, (map) => {
      const parent = map.sessions.find((item) => item.id === sessionId);
      if (parent !== undefined) parent.summary = 'миграции готовы';
    });
    const { session: child } = await createChildSession(project, workId, sessionId);
    expect(child.task).toBe('');

    const plan = await planLaunch(project, workId, child);
    const guidance = guidanceOf(plan.args);
    expect(guidance).toContain(child.id);
    expect(guidance).toContain('миграции готовы');
    // Первым сообщением бриф не идёт: агент ждёт запроса пользователя.
    expect(plan.args.at(-1)).toBe(guidance);
    expect(plan.args.filter((item) => item.includes('миграции готовы'))).toHaveLength(1);
  });

  it('ребёнок с задачей стартует по брифу: бриф промптом, вставка без него', async () => {
    const { workId } = await pending('claude');
    const spawned = await createPendingSession(project, workId, {
      provider: 'claude',
      label: 'бэкенд',
      task: 'реализовать шаги 1–3',
    });

    const plan = await planLaunch(project, workId, await sessionOf(workId, spawned));
    expect(plan.args.at(-1)).toContain('реализовать шаги 1–3');
    expect(guidanceOf(plan.args)).not.toContain('реализовать шаги 1–3');
  });

  it('resume тихого ребёнка снова несёт бриф: транскрипт родительского контекста не хранит', async () => {
    const { workId, sessionId } = await pending('claude');
    await updateMap(project, workId, (map) => {
      const parent = map.sessions.find((item) => item.id === sessionId);
      if (parent !== undefined) parent.summary = 'миграции готовы';
    });
    const { session: child } = await createChildSession(project, workId, sessionId);
    await updateMap(project, workId, (map) => {
      const target = map.sessions.find((item) => item.id === child.id);
      if (target !== undefined) target.providerSessionId = '7fa0e1ee-cc7b-4a1e-9d4e-000000000003';
    });

    const plan = await planResume(project, workId, await sessionOf(workId, child.id));
    expect(plan.args).toContain('--resume');
    expect(guidanceOf(plan.args)).toContain('миграции готовы');
  });

  it('resume сессии с задачей брифа в системной вставке не несёт', async () => {
    const { workId, sessionId } = await pending('claude');
    await updateMap(project, workId, (map) => {
      const target = map.sessions.find((item) => item.id === sessionId);
      if (target !== undefined) target.providerSessionId = '7fa0e1ee-cc7b-4a1e-9d4e-000000000004';
    });

    const plan = await planResume(project, workId, await sessionOf(workId, sessionId));
    expect(plan.args).toContain('--resume');
    expect(guidanceOf(plan.args)).not.toContain('прогнать e2e');
  });

  it('быстрой сессии new брифа не пишется: вставка остаётся одной вставкой', async () => {
    const { workId } = await pending('claude');
    const quick = await createNewSession(project, workId);

    const plan = await planNew(project, workId, quick.session);
    expect(guidanceOf(plan.args)).not.toContain('# Работа');
    await expect(
      readFile(path.join(workPaths(project, workId).briefs, `${quick.session.id}.md`), 'utf8'),
    ).rejects.toThrow();
  });

  it('провайдеру без такой возможности вставка не достаётся', async () => {
    const { workId, sessionId } = await pending('codex');
    const plan = await planLaunch(project, workId, await sessionOf(workId, sessionId));

    expect(plan.args).not.toContain('--append-system-prompt');
  });
});

describe('переходы статусов', () => {
  it('startSession переводит pending → active и записывает providerSessionId', async () => {
    const { workId, sessionId } = await pending('claude');
    await startSession(project, workId, sessionId, 'uuid-1');

    const session = await sessionOf(workId, sessionId);
    expect(session.status).toBe('active');
    expect(session.providerSessionId).toBe('uuid-1');
    expect(session.startedAt).not.toBeNull();
    expect(session.history.map((entry) => entry.status)).toEqual(['pending', 'active']);
  });

  it('выход процесса переводит active → exited и пишет код выхода в history', async () => {
    const { workId, sessionId } = await pending('claude');
    await startSession(project, workId, sessionId, null);
    await finishExited(
      project,
      workId,
      sessionId,
      { exitCode: 3, signal: undefined },
      {
        claudeRoot: logs,
        codexRoot: logs,
      },
    );

    const session = await sessionOf(workId, sessionId);
    expect(session.status).toBe('exited');
    expect(session.history.at(-1)).toMatchObject({ status: 'exited', exitCode: 3 });
    expect(session.endedAt).not.toBeNull();
  });

  it('сигнал пишется рядом с кодом выхода', async () => {
    const { workId, sessionId } = await pending('claude');
    await startSession(project, workId, sessionId, null);
    await finishExited(
      project,
      workId,
      sessionId,
      { exitCode: 0, signal: 9 },
      {
        claudeRoot: logs,
        codexRoot: logs,
      },
    );

    expect((await sessionOf(workId, sessionId)).history.at(-1)).toMatchObject({ signal: 9 });
  });

  it('отчитавшуюся сессию выход процесса не трогает: done важнее exited', async () => {
    const { workId, sessionId } = await pending('claude');
    await startSession(project, workId, sessionId, null);
    await updateMap(project, workId, (map) => {
      const session = transitionSession(map, sessionId, 'done');
      session.summary = 'готово';
    });

    await finishExited(
      project,
      workId,
      sessionId,
      { exitCode: 0, signal: undefined },
      {
        claudeRoot: logs,
        codexRoot: logs,
      },
    );

    const session = await sessionOf(workId, sessionId);
    expect(session.status).toBe('done');
    expect(session.summary).toBe('готово');
  });
});

describe('привязка к логу провайдера без внешнего id', () => {
  /** Rollout-лог Codex: тот же формат, что читает адаптер core. */
  const writeRollout = async (id: string, cwd: string, at: string): Promise<void> => {
    const dir = path.join(logs, '2026', '09', '02');
    await mkdir(dir, { recursive: true });
    const lines = [
      { timestamp: at, type: 'session_meta', payload: { id, timestamp: at, cwd } },
      { timestamp: at, type: 'turn_context', payload: { type: 'turn_context', cwd } },
    ]
      .map((record) => `${JSON.stringify(record)}\n`)
      .join('');
    await writeFile(path.join(dir, `rollout-2026-09-02T10-00-00-${id}.jsonl`), lines);
  };

  it('codex-сессия получает providerSessionId по cwd и времени запуска', async () => {
    const { workId, sessionId } = await pending('codex');
    await startSession(project, workId, sessionId, null);
    const started = (await sessionOf(workId, sessionId)).startedAt as string;

    await writeRollout('чужая', '/другой/проект', started);
    await writeRollout('наша', project, new Date(Date.parse(started) + 1000).toISOString());

    const found = await linkSession(project, workId, await sessionOf(workId, sessionId), {
      codexRoot: logs,
    });

    expect(found).toBe('наша');
    expect((await sessionOf(workId, sessionId)).providerSessionId).toBe('наша');
  });

  it('лога ещё нет — карта не трогается, попробуем на следующем событии', async () => {
    const { workId, sessionId } = await pending('codex');
    await startSession(project, workId, sessionId, null);

    expect(
      await linkSession(project, workId, await sessionOf(workId, sessionId), { codexRoot: logs }),
    ).toBeNull();
    expect((await sessionOf(workId, sessionId)).providerSessionId).toBeNull();
  });

  it('claude привязку по времени не ищет: его id харнесс знает заранее', async () => {
    const { workId, sessionId } = await pending('claude');
    await startSession(project, workId, sessionId, null);

    expect(
      await linkSession(project, workId, await sessionOf(workId, sessionId), { claudeRoot: logs }),
    ).toBeNull();
  });
});
