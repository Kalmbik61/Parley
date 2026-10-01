import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addSession } from './map.js';
import { createWork, readMap, updateMap } from './store.js';
import { readTranscript, requestAutoSummary } from './summary.js';

/**
 * Вместо стокового `claude -p` в тестах работает заглушка: настоящий агент не
 * запускается никогда (спецификация координации, раздел 9).
 */
const STUB = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'test',
  'stub-summarizer.mjs',
);

let home = '';
let project = '';
let claudeRoot = '';
let codexRoot = '';
let promptFile = '';
const saved: Record<string, string | undefined> = {};

const setEnv = (name: string, value: string | undefined): void => {
  if (!(name in saved)) saved[name] = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
};

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'parley-home-'));
  project = await mkdtemp(path.join(tmpdir(), 'parley-project-'));
  claudeRoot = await mkdtemp(path.join(tmpdir(), 'parley-claude-'));
  codexRoot = await mkdtemp(path.join(tmpdir(), 'parley-codex-'));
  promptFile = path.join(home, 'prompt.json');
  setEnv('PARLEY_HOME', home);
  setEnv('PARLEY_CLAUDE_BIN', STUB);
  setEnv('PARLEY_STUB_PROMPT', promptFile);
  setEnv('PARLEY_STUB_SUMMARY', undefined);
  setEnv('PARLEY_STUB_FAIL', undefined);
  setEnv('PARLEY_STUB_HANG', undefined);
  setEnv('PARLEY_STUB_ENV', undefined);
});

afterEach(async () => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  for (const key of Object.keys(saved)) delete saved[key];
  await Promise.all(
    [home, project, claudeRoot, codexRoot].map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

const jsonl = (records: unknown[]): string =>
  records.map((record) => JSON.stringify(record)).join('\n');

/** Лог Claude Code: одна сессия — один jsonl, имя файла и есть её id. */
async function claudeLog(id: string, records: unknown[]): Promise<void> {
  const dir = path.join(claudeRoot, '-tmp-проект');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${id}.jsonl`), jsonl(records), 'utf8');
}

/** Rollout-лог Codex: id зашит в имя файла. */
async function codexLog(id: string, records: unknown[]): Promise<void> {
  const dir = path.join(codexRoot, '2026', '09', '02');
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, `rollout-2026-09-02T10-00-00-${id}.jsonl`),
    jsonl(records),
    'utf8',
  );
}

const claudeSay = (role: string, text: string) => ({
  type: role,
  timestamp: '2026-09-02T10:00:00.000Z',
  message: { role, content: [{ type: 'text', text }] },
});

const codexSay = (kind: string, message: string) => ({
  timestamp: '2026-09-02T10:00:00.000Z',
  type: 'event_msg',
  payload: { type: kind, message },
});

const ID = '11111111-2222-3333-4444-555555555555';

describe('транскрипт сессии', () => {
  it('Claude: реплики человека и модели по порядку, без служебных записей', async () => {
    await claudeLog(ID, [
      claudeSay('user', 'почини сборку'),
      {
        type: 'assistant',
        timestamp: '2026-09-02T10:00:01.000Z',
        message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: {} }] },
      },
      claudeSay('assistant', 'сборка починена'),
    ]);

    const text = await readTranscript('claude', ID, { claudeRoot, codexRoot });
    expect(text).toContain('почини сборку');
    expect(text).toContain('сборка починена');
    // Вызовы инструментов в транскрипт не едут: там нет реплик.
    expect(text).not.toContain('Bash');
    expect((text as string).indexOf('почини')).toBeLessThan((text as string).indexOf('починена'));
  });

  it('Claude: реплики субагентов в транскрипт не попадают', async () => {
    await claudeLog(ID, [
      claudeSay('user', 'почини сборку'),
      { ...claudeSay('assistant', 'я субагент'), isSidechain: true },
    ]);

    const text = await readTranscript('claude', ID, { claudeRoot, codexRoot });
    expect(text).not.toContain('я субагент');
  });

  it('Codex: user_message и agent_message адаптером core (решение №7)', async () => {
    await codexLog(ID, [
      { timestamp: '2026-09-02T10:00:00.000Z', type: 'session_meta', payload: { id: ID } },
      codexSay('user_message', 'прогони e2e'),
      codexSay('agent_reasoning', 'думаю про тесты'),
      codexSay('agent_message', 'тесты зелёные'),
    ]);

    const text = await readTranscript('codex', ID, { claudeRoot, codexRoot });
    expect(text).toContain('прогони e2e');
    expect(text).toContain('тесты зелёные');
    // Размышления модели — не реплика: в резюме от них только шум.
    expect(text).not.toContain('думаю про тесты');
  });

  it('провайдер без истории и пропавший лог дают null, а не пустой транскрипт', async () => {
    await claudeLog(ID, [claudeSay('user', 'привет')]);
    expect(await readTranscript('glm', ID, { claudeRoot, codexRoot })).toBeNull();
    expect(await readTranscript('claude', 'нет-такого', { claudeRoot, codexRoot })).toBeNull();
  });

  it('длинный транскрипт режется с головы: важен хвост разговора', async () => {
    const records = [];
    for (let at = 0; at < 200; at++)
      records.push(claudeSay('user', `реплика ${at} ${'x'.repeat(50)}`));
    await claudeLog(ID, records);

    const text = (await readTranscript('claude', ID, { claudeRoot, codexRoot, limit: 500 })) ?? '';
    expect(text.length).toBeLessThanOrEqual(600);
    expect(text).toContain('реплика 199');
    expect(text).not.toContain('реплика 0 ');
  });
});

/** Работа с одной вышедшей сессией — исходная точка дозаказа. */
async function exited(provider: string, providerSessionId: string | null = ID) {
  const created = await createWork(project, { title: 'Авторизация', goal: 'логин по e-mail' });
  const workId = created.work.id;
  let sessionId = '';
  await updateMap(project, workId, (map) => {
    const session = addSession(map, { provider, label: 'бэкенд', task: 'шаги 1–3' });
    sessionId = session.id;
    session.lifecycle = 'sleeping';
    session.providerSessionId = providerSessionId;
  });
  return { workId, sessionId };
}

describe('дозаказ резюме', () => {
  it('зовёт суммаризатора командой реестра и пишет summary с пометкой auto', async () => {
    await claudeLog(ID, [claudeSay('user', 'почини сборку'), claudeSay('assistant', 'починил')]);
    const { workId, sessionId } = await exited('claude');
    setEnv('PARLEY_STUB_SUMMARY', 'Сборка починена, тесты зелёные.');

    const summary = await requestAutoSummary(project, workId, sessionId, {
      claudeRoot,
      codexRoot,
    });
    expect(summary).toBe('Сборка починена, тесты зелёные.');

    const session = (await readMap(project, workId)).sessions[0];
    expect(session?.summary).toBe('Сборка починена, тесты зелёные.');
    expect(session?.summarySource).toBe('auto');
    // Дозаказ статуса не меняет: сессия как вышла без отчёта, так и осталась.
    expect(session?.lifecycle).toBe('sleeping');
    expect(session?.result).toBeNull();

    // Команда и аргументы пришли из реестра — их подменяет providers.json,
    // а не код вызова.
    const args = JSON.parse(await readFile(promptFile, 'utf8')) as string[];
    expect(args[0]).toBe('-p');
    expect(args[1]).toContain('почини сборку');
    expect(args[1]).toContain('Авторизация');
    expect(args[1]).toContain('бэкенд');
    // Язык резюме не менялся вместе с переводом текстов: как и прежде, его просят по-русски.
    expect(args[1]).toContain('Write, in Russian, a summary');
  });

  it('у тихой сессии задачи нет — строки «Its task» в промпте тоже', async () => {
    await claudeLog(ID, [claudeSay('user', 'почини сборку'), claudeSay('assistant', 'починил')]);
    const { workId, sessionId } = await exited('claude');
    await updateMap(project, workId, (map) => {
      const target = map.sessions.find((item) => item.id === sessionId);
      if (target !== undefined) target.task = '';
    });

    await requestAutoSummary(project, workId, sessionId, { claudeRoot, codexRoot });
    const args = JSON.parse(await readFile(promptFile, 'utf8')) as string[];
    expect(args[1]).not.toContain('Its task');
    // Роль сессии и разговор на месте: без задачи резюме всё равно считается.
    expect(args[1]).toContain('бэкенд');
    expect(args[1]).toContain('почини сборку');
  });

  it('транскрипт Codex суммирует тот же claude -p', async () => {
    await codexLog(ID, [codexSay('user_message', 'прогони e2e'), codexSay('agent_message', 'ок')]);
    const { workId, sessionId } = await exited('codex');

    await requestAutoSummary(project, workId, sessionId, { claudeRoot, codexRoot });
    const args = JSON.parse(await readFile(promptFile, 'utf8')) as string[];
    expect(args[1]).toContain('прогони e2e');
  });

  it('для GLM дозаказ недоступен: истории у него нет', async () => {
    const { workId, sessionId } = await exited('glm');
    await expect(
      requestAutoSummary(project, workId, sessionId, { claudeRoot, codexRoot }),
    ).rejects.toThrow(/session history/i);
    expect((await readMap(project, workId)).sessions[0]?.summary).toBeNull();
  });

  it('без id у провайдера дозаказывать не из чего', async () => {
    const { workId, sessionId } = await exited('claude', null);
    await expect(
      requestAutoSummary(project, workId, sessionId, { claudeRoot, codexRoot }),
    ).rejects.toThrow(/provider log/i);
  });

  it('лога с таким id нет — ошибка, карта не трогается', async () => {
    const { workId, sessionId } = await exited('claude');
    await expect(
      requestAutoSummary(project, workId, sessionId, { claudeRoot, codexRoot }),
    ).rejects.toThrow(/does not exist/i);
    expect((await readMap(project, workId)).sessions[0]?.summarySource).toBeNull();
  });

  it('неизвестная сессия — ошибка до запуска суммаризатора', async () => {
    const { workId } = await exited('claude');
    await expect(
      requestAutoSummary(project, workId, 's-99', { claudeRoot, codexRoot }),
    ).rejects.toThrow(/s-99/);
  });

  it('суммаризатор упал — резюме не пишется, причина в ошибке', async () => {
    await claudeLog(ID, [claudeSay('user', 'почини сборку')]);
    const { workId, sessionId } = await exited('claude');
    setEnv('PARLEY_STUB_FAIL', '1');

    await expect(
      requestAutoSummary(project, workId, sessionId, { claudeRoot, codexRoot }),
    ).rejects.toThrow(/суммаризатор/);
    expect((await readMap(project, workId)).sessions[0]?.summary).toBeNull();
  });

  it('пустой ответ суммаризатора резюме не считается', async () => {
    await claudeLog(ID, [claudeSay('user', 'почини сборку')]);
    const { workId, sessionId } = await exited('claude');
    setEnv('PARLEY_STUB_SUMMARY', '');

    await expect(
      requestAutoSummary(project, workId, sessionId, { claudeRoot, codexRoot }),
    ).rejects.toThrow(/empty summary/);
    expect((await readMap(project, workId)).sessions[0]?.summary).toBeNull();
  });

  it('метки родительской сессии Claude Code до суммаризатора не доезжают', async () => {
    await claudeLog(ID, [claudeSay('user', 'почини сборку')]);
    const { workId, sessionId } = await exited('claude');
    // Харнесс, запущенный из сессии Claude Code, наследует её метки; соседняя
    // настройка пользователя при этом доезжает как есть.
    setEnv('CLAUDE_CODE_CHILD_SESSION', '1');
    setEnv('CLAUDE_CODE_SESSION_ID', 'сессия-родителя');
    setEnv('CLAUDE_CODE_BRIDGE_SESSION_ID', 'мост-родителя');
    setEnv('CLAUDE_CODE_MAX_OUTPUT_TOKENS', '8000');
    setEnv(
      'PARLEY_STUB_ENV',
      'CLAUDE_CODE_CHILD_SESSION,CLAUDE_CODE_SESSION_ID,CLAUDE_CODE_BRIDGE_SESSION_ID,CLAUDE_CODE_MAX_OUTPUT_TOKENS',
    );

    // Вместо резюме stub печатает, что увидел в своём окружении.
    const seen = await requestAutoSummary(project, workId, sessionId, { claudeRoot, codexRoot });
    expect(seen.split('\n')).toEqual([
      'env CLAUDE_CODE_CHILD_SESSION=-',
      'env CLAUDE_CODE_SESSION_ID=-',
      'env CLAUDE_CODE_BRIDGE_SESSION_ID=-',
      'env CLAUDE_CODE_MAX_OUTPUT_TOKENS=8000',
    ]);
  });

  it('суммаризатор молчит дольше таймаута — вызов обрывается', async () => {
    await claudeLog(ID, [claudeSay('user', 'почини сборку')]);
    const { workId, sessionId } = await exited('claude');
    setEnv('PARLEY_STUB_HANG', '1');

    await expect(
      requestAutoSummary(project, workId, sessionId, { claudeRoot, codexRoot, timeoutMs: 200 }),
    ).rejects.toThrow(/did not answer/);
  });

  it('прежнее резюме агента перезаписывается дозаказанным', async () => {
    await claudeLog(ID, [claudeSay('user', 'почини сборку')]);
    const { workId, sessionId } = await exited('claude');
    await updateMap(project, workId, (map) => {
      const session = map.sessions[0];
      if (session !== undefined) {
        session.summary = 'старое';
        session.summarySource = 'agent';
      }
    });
    setEnv('PARLEY_STUB_SUMMARY', 'новое');

    await requestAutoSummary(project, workId, sessionId, { claudeRoot, codexRoot });
    const session = (await readMap(project, workId)).sessions[0];
    expect(session?.summary).toBe('новое');
    expect(session?.summarySource).toBe('auto');
  });
});
