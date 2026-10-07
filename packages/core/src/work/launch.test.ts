import { readNativeContext, readNativeSkillCatalog } from './native-context.js';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseTomlAssignment, type TomlValue } from '../../test/toml-mini.js';
import { CODEX_NOTIFY_ENTRY } from './codex-notify.js';
import type { SkillCatalog } from '../skills/catalog.js';
import { claudeSkillRoute, codexSkillRoute } from './skill-reduction.js';
import {
  applyAutoTitle,
  autoTitleOf,
  createChildSession,
  createNewSession,
  createPendingSession,
  finishExited,
  isNewLabel,
  isUntitledWork,
  linkSession,
  NEW_LABEL,
  planLaunch,
  planNew,
  planResume,
  readBrief,
  resetPointerLabel,
  startSession,
  UNTITLED_WORK,
} from './launch.js';
import { setResult } from './map.js';
import { addRoom } from './rooms.js';
import { workSettingsJson } from './settings-file.js';
import { createWork, readMap, updateMap, workPaths } from './store.js';

/** Пути к бинарям подменяются на заглушку: настоящий агент здесь не запускается. */
const STUB = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'test',
  'stub-agent.mjs',
);

let home = '';
let project = '';
let logs = '';
const saved: Record<string, string | undefined> = {};

const setEnv = (name: string, value: string | undefined): void => {
  // Исходное значение — при первой подмене: повторная подмена в том же тесте не должна сохранить подменённое.
  if (!(name in saved)) saved[name] = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
};

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'parley-home-'));
  project = await mkdtemp(path.join(tmpdir(), 'parley-project-'));
  // Пустой корень истории: метрики читаются отсюда, а не из настоящего ~/.claude.
  logs = await mkdtemp(path.join(tmpdir(), 'parley-logs-'));
  process.env['PARLEY_HOME'] = home;
  setEnv('PARLEY_CLAUDE_BIN', STUB);
  setEnv('PARLEY_CODEX_BIN', STUB);
  setEnv('PARLEY_GLM_BIN', '');
  // Навигатор включён по умолчанию (с 2026-10-06): тесты вне блоков про навигатор проверяют запуск без него и
  // потому выключают его явно, а блоки про навигатор включают его сами (`setEnv('PARLEY_SKILL_NAVIGATOR', '1')`
  // или `undefined` для значения по умолчанию).
  setEnv('PARLEY_SKILL_NAVIGATOR', '0');
  setEnv('HARNAS_SKILL_NAVIGATOR', undefined);
  // План возобновления Claude ищет транскрипт сессии в корне истории — здесь, а не в настоящем ~/.claude.
  setEnv('PARLEY_CLAUDE_PROJECTS_DIR', logs);
});

const defaultCatalog = codexSkillRoute.catalog;
afterEach(async () => {
  claudeSkillRoute.catalogReady = true;
  codexSkillRoute.catalog = defaultCatalog;
  delete process.env['PARLEY_HOME'];
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
    delete saved[name];
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

/**
 * Транскрипт Claude Code с этим id в корне истории (`logs`): он появляется после первого сообщения
 * сессии, и только тогда её есть что продолжать по `--resume`.
 */
async function claudeTranscript(id: string): Promise<void> {
  const dir = path.join(logs, '-private-tmp-parley-project');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${id}.jsonl`), '{"type":"user"}\n');
}

/**
 * Конфигурация Claude Code этого теста: пустая папка вместо настоящего `~/.claude`, где у разработчика может стоять мод jev.
 * Лежит внутри `home` и уходит вместе с ним.
 */
async function claudeConfig(plugins: Array<{ name?: string; folder?: string }> = []): Promise<string> {
  const dir = path.join(home, 'claude-config');
  await mkdir(dir, { recursive: true });
  setEnv('CLAUDE_CONFIG_DIR', dir);
  for (const plugin of plugins) {
    const manifest = path.join(dir, 'skills', plugin.folder ?? 'jev-skill-suggestion', '.claude-plugin');
    await mkdir(manifest, { recursive: true });
    await writeFile(path.join(manifest, 'plugin.json'), JSON.stringify({ name: plugin.name ?? 'jev-skill-suggestion', version: '0.1.0' }));
  }
  return dir;
}

describe('создание pending сессии', () => {
  it('кладёт запись в карту и пишет бриф на диск', async () => {
    const { workId, sessionId } = await pending('claude');
    const session = await sessionOf(workId, sessionId);

    expect(session.lifecycle).toBe('pending');
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

/** Окружение сессии работы: два имени на одно значение (R3) — новое читают все, прежнее — старые скрипты. */
const sessionEnv = (workDir: string, sessionId: string): Record<string, string> => ({
  PARLEY_WORK_DIR: workDir,
  PARLEY_SESSION_ID: sessionId,
  HARNAS_WORK_DIR: workDir,
  HARNAS_SESSION_ID: sessionId,
  PARLEY_SKILL_NAVIGATOR: '0',
  HARNAS_SKILL_NAVIGATOR: '0',
  PARLEY_NATIVE_CONTEXT_REVISION: expect.any(String),
  HARNAS_NATIVE_CONTEXT_REVISION: expect.any(String),
});

describe('метки быстрой сессии и автозаголовок', () => {
  it('быстрая сессия в проекте без работ: работа и ярлык — английские метки', async () => {
    const created = await createNewSession(project, null);
    const map = await readMap(project, created.workId);

    expect(map.work.title).toBe(UNTITLED_WORK);
    expect(created.session.label).toBe(NEW_LABEL);
    expect(`${UNTITLED_WORK} ${NEW_LABEL}`).not.toMatch(/[А-Яа-яЁё]/);
  });

  it('бриф дочерней сессии не несёт русской метки: агент читает её в «Your session»', async () => {
    const { workId, sessionId } = await pending('claude');
    const { session: child } = await createChildSession(project, workId, sessionId);
    const brief = await readFile(
      path.join(workPaths(project, workId).briefs, `${child.id}.md`),
      'utf8',
    );

    expect(brief).toContain(`## Your session: ${child.id} — ${NEW_LABEL}`);
  });

  it('метки узнаются и в прежней русской записи: карты старых сборок', () => {
    expect(isNewLabel(NEW_LABEL)).toBe(true);
    expect(isNewLabel('новая сессия')).toBe(true);
    expect(isNewLabel('бэкенд')).toBe(false);
    expect(isNewLabel('')).toBe(false);
    expect(isUntitledWork(UNTITLED_WORK)).toBe(true);
    expect(isUntitledWork('без названия')).toBe(true);
    expect(isUntitledWork('Авторизация')).toBe(false);
  });

  it('служебный текст вместо ярлыка (автозаголовок сборок до 0.2.0) — ярлыка нет, автозаголовок переименует', async () => {
    const polluted =
      '<local-command-caveat>The command below was run directly in Claude Code, not sent to you as a request, and its output goes straight to the user.</loca…';
    expect(isNewLabel(polluted)).toBe(true);
    expect(isNewLabel('<command-name>/model</command-name>')).toBe(true);
    expect(isNewLabel('<b>бэкенд</b>')).toBe(false);

    const created = await createNewSession(project, null);
    await updateMap(project, created.workId, (map) => {
      map.sessions[0]!.label = polluted;
      // Заголовок безымянной работы тот же автозаголовок портил вместе с ярлыком.
      map.work.title = polluted;
    });
    expect(isUntitledWork(polluted)).toBe(true);
    await applyAutoTitle(project, created.workId, created.session.id, 'Orca мобильное приложение');
    const healed = await readMap(project, created.workId);
    expect(healed.sessions[0]?.label).toBe('Orca мобильное приложение');
    expect(healed.work.title).toBe('Orca мобильное приложение');
  });

  // Ярлык агента комнаты из карты пользователя (w-0043, сборка 0.7.0): автозаголовок взял указатель на письма.
  const POINTER = 'New messages (1) in r-01 "Second". Call check_inbox.';

  it('указатель на письма вместо ярлыка и заголовка работы — не имя (сборки до 0.7.0 включительно)', () => {
    expect(isNewLabel(POINTER)).toBe(true);
    expect(isNewLabel('New messages (2). Call check_inbox.')).toBe(true);
    expect(isUntitledWork(POINTER)).toBe(true);
    // Похожее, но своё имя — имя.
    expect(isNewLabel('New messages handling')).toBe(false);
  });

  it('applyAutoTitle указатель именем не ставит, карту не переписывает', async () => {
    const created = await createNewSession(project, null);
    const before = await readFile(workPaths(project, created.workId).map, 'utf8');

    await applyAutoTitle(project, created.workId, created.session.id, POINTER);

    expect(await readFile(workPaths(project, created.workId).map, 'utf8')).toBe(before);
    const map = await readMap(project, created.workId);
    expect(map.sessions[0]?.label).toBe(NEW_LABEL);
    expect(map.work.title).toBe(UNTITLED_WORK);
  });

  it('autoTitleOf: разговор, начатый указателем, имени из лога не получает — кроме /rename человека', () => {
    const fromPointer = { firstPromptPointer: true as const };
    // `ai-title`, сгенерированный по указателю, и сам указатель из реплики — не имя.
    expect(autoTitleOf({ title: 'Проверка входящих сообщений', titleSource: 'ai', ...fromPointer })).toBeNull();
    expect(autoTitleOf({ title: POINTER, titleSource: 'last-prompt', ...fromPointer })).toBeNull();
    expect(autoTitleOf({ title: POINTER, titleSource: 'first-text', ...fromPointer })).toBeNull();
    // `custom-title` пишет только `/rename` человека — явный выбор имени.
    expect(autoTitleOf({ title: 'ревьюер', titleSource: 'custom', ...fromPointer })).toBe('ревьюер');
    // Обычное начало: указатель, пришедший последним, — не имя (ждём ai-title), прочее — как было.
    expect(autoTitleOf({ title: POINTER, titleSource: 'last-prompt' })).toBeNull();
    expect(autoTitleOf({ title: 'Починить сборку', titleSource: 'ai' })).toBe('Починить сборку');
    expect(autoTitleOf({ title: 'почини парсер', titleSource: 'last-prompt' })).toBe('почини парсер');
    expect(autoTitleOf({ title: null, titleSource: null })).toBeNull();
    expect(autoTitleOf(undefined)).toBeNull();
  });

  it('resetPointerLabel: ярлык-указатель и такой же заголовок работы — снова метки; updatedAt не сдвигается', async () => {
    const created = await createNewSession(project, null);
    const other = await createNewSession(project, created.workId);
    await updateMap(project, created.workId, (map) => {
      map.sessions[0]!.label = POINTER;
      map.work.title = POINTER;
      map.sessions[1]!.label = POINTER;
    });
    const before = (await readMap(project, created.workId)).work.updatedAt;

    await resetPointerLabel(project, created.workId, created.session.id);

    const map = await readMap(project, created.workId);
    expect(map.sessions[0]?.label).toBe(NEW_LABEL);
    expect(map.work.title).toBe(UNTITLED_WORK);
    // Чинится только названная сессия: соседнюю хост вернёт своим вызовом.
    expect(map.sessions.find((item) => item.id === other.session.id)?.label).toBe(POINTER);
    expect(map.work.updatedAt).toBe(before);
  });

  it('resetPointerLabel: настоящее имя и название не трогает', async () => {
    const { workId } = await pending('claude');
    const quick = await createNewSession(project, workId);
    await updateMap(project, workId, (map) => {
      map.sessions.find((item) => item.id === quick.session.id)!.label = 'бэкенд';
    });

    await resetPointerLabel(project, workId, quick.session.id);

    const map = await readMap(project, workId);
    expect(map.sessions.find((item) => item.id === quick.session.id)?.label).toBe('бэкенд');
    expect(map.work.title).toBe('Авторизация');
  });

  it('автозаголовок переименует быструю сессию и безымянную работу один раз', async () => {
    const created = await createNewSession(project, null);

    await applyAutoTitle(project, created.workId, created.session.id, 'Починить сборку');
    const map = await readMap(project, created.workId);
    expect(map.sessions[0]?.label).toBe('Починить сборку');
    expect(map.work.title).toBe('Починить сборку');

    // Ярлык уже не метка: второй заголовок ничего не меняет.
    await applyAutoTitle(project, created.workId, created.session.id, 'Другой заголовок');
    const again = await readMap(project, created.workId);
    expect(again.sessions[0]?.label).toBe('Починить сборку');
    expect(again.work.title).toBe('Починить сборку');
  });

  it('карта старой сборки: русские метки тоже переименуются автозаголовком', async () => {
    const created = await createNewSession(project, null);
    await updateMap(project, created.workId, (map) => {
      map.work.title = 'без названия';
      const session = map.sessions[0];
      if (session !== undefined) session.label = 'новая сессия';
    });

    await applyAutoTitle(project, created.workId, created.session.id, 'Починить сборку');
    const map = await readMap(project, created.workId);
    expect(map.sessions[0]?.label).toBe('Починить сборку');
    expect(map.work.title).toBe('Починить сборку');
  });

  it('названную человеком работу автозаголовок не трогает, а ярлык быстрой сессии меняет', async () => {
    const { workId } = await pending('claude');
    const quick = await createNewSession(project, workId);

    await applyAutoTitle(project, workId, quick.session.id, 'Починить сборку');
    const map = await readMap(project, workId);
    expect(map.work.title).toBe('Авторизация');
    expect(map.sessions.find((item) => item.id === quick.session.id)?.label).toBe(
      'Починить сборку',
    );
  });

  it('переименованную руками сессию автозаголовок не трогает', async () => {
    const created = await createNewSession(project, null);
    await updateMap(project, created.workId, (map) => {
      const session = map.sessions[0];
      if (session !== undefined) session.label = 'бэкенд';
    });

    await applyAutoTitle(project, created.workId, created.session.id, 'Починить сборку');
    const map = await readMap(project, created.workId);
    expect(map.sessions[0]?.label).toBe('бэкенд');
    expect(map.work.title).toBe(UNTITLED_WORK);
  });
});

describe('план запуска', () => {
  it('claude получает id сессии, конфиг MCP файлом и бриф промптом', async () => {
    const { workId, sessionId } = await pending('claude');
    const plan = await planLaunch(project, workId, await sessionOf(workId, sessionId));
    const paths = workPaths(project, workId);

    expect(plan.command).toBe('claude');
    expect(plan.cwd).toBe(project);
    expect(plan.env).toEqual(sessionEnv(paths.dir, sessionId));
    expect(plan.providerSessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/);
    expect(plan.args.slice(0, 2)).toEqual(['--session-id', plan.providerSessionId]);

    const configFile = plan.args[plan.args.indexOf('--mcp-config') + 1];
    expect(configFile).toBe(path.join(paths.mcp, `${sessionId}.json`));
    const config = JSON.parse(await readFile(configFile as string, 'utf8'));
    expect(config.mcpServers.parley.env).toEqual(sessionEnv(paths.dir, sessionId));

    expect(plan.args.at(-1)).toContain('прогнать e2e');
  });

  it('codex получает сервер значением -c, файла конфига ему не пишется', async () => {
    const { workId, sessionId } = await pending('codex');
    const plan = await planLaunch(project, workId, await sessionOf(workId, sessionId));

    expect(plan.command).toBe('codex');
    const mcp = plan.args.find((arg) => arg.startsWith('mcp_servers.parley='));
    expect(mcp).toContain(workPaths(project, workId).dir);
    expect(plan.args[plan.args.indexOf(mcp as string) - 1]).toBe('-c');
    // Id снаружи codex не принимает — гадать за него нечего.
    expect(plan.providerSessionId).toBeNull();
    expect(plan.args).not.toContain('--session-id');
    await expect(
      readFile(path.join(workPaths(project, workId).mcp, `${sessionId}.json`), 'utf8'),
    ).rejects.toThrow();
  });

  it('codex: серверу, которому Codex режет окружение, уходит PARLEY_HOME запускающего', async () => {
    const { workId, sessionId } = await pending('codex');
    const plan = await planLaunch(project, workId, await sessionOf(workId, sessionId));

    const mcp = plan.args.find((arg) => arg.startsWith('mcp_servers.parley=')) as string;
    const { value } = parseTomlAssignment(mcp);
    expect((value as Record<string, TomlValue>)['env']).toMatchObject({
      ...sessionEnv(workPaths(project, workId).dir, sessionId),
      PARLEY_HOME: home,
      PARLEY_CODEX_BIN: STUB,
    });
  });

  it('codex: notify — node и скрипт харнесса, а каталог events/ для его журнала заведён', async () => {
    const { workId, sessionId } = await pending('codex');
    await expect(stat(workPaths(project, workId).events)).rejects.toThrow();
    const plan = await planLaunch(project, workId, await sessionOf(workId, sessionId));

    const notify = plan.args.find((arg) => arg.startsWith('notify=')) as string;
    expect(plan.args[plan.args.indexOf(notify) - 1]).toBe('-c');
    expect(parseTomlAssignment(notify).value).toEqual([process.execPath, CODEX_NOTIFY_ENTRY]);
    // Хуков у codex нет, `--settings` не заводит каталог за него — его заводит запуск.
    expect((await stat(workPaths(project, workId).events)).isDirectory()).toBe(true);
    // Как и у Claude Code, сессия живёт под теми же переменными (оба имени): notify берёт адрес из них.
    expect(plan.env).toEqual(sessionEnv(workPaths(project, workId).dir, sessionId));
  });

  it('hookUrl доезжает до файла --settings: HTTP-хуки ленты; без него файл прежний (вид «Chat»)', async () => {
    const { workId, sessionId } = await pending('claude');
    const url = 'http://127.0.0.1:41234/hooks';

    const withFeed = await planLaunch(project, workId, await sessionOf(workId, sessionId), {
      hookUrl: url,
    });
    const file = withFeed.args[withFeed.args.indexOf('--settings') + 1] as string;
    expect(await readFile(file, 'utf8')).toBe(workSettingsJson({ hookUrl: url }));

    const resumed = await planResume(project, workId, await sessionOf(workId, sessionId));
    expect(resumed.args[resumed.args.indexOf('--settings') + 1]).toBe(file);
    expect(await readFile(file, 'utf8')).toBe(workSettingsJson());
  });

  it('у claude ни notify, ни каталога codex-журнала запуск не добавляет', async () => {
    const { workId, sessionId } = await pending('claude');
    const plan = await planLaunch(project, workId, await sessionOf(workId, sessionId));
    expect(plan.args.join(' ')).not.toContain('notify=');
  });

  it('бриф перечитывается с диска: правку до запуска агент видит', async () => {
    const { workId, sessionId } = await pending('claude');
    const brief = path.join(workPaths(project, workId).briefs, `${sessionId}.md`);
    await writeFile(brief, 'правленый бриф\n', 'utf8');

    const plan = await planLaunch(project, workId, await sessionOf(workId, sessionId));
    expect(plan.args.at(-1)).toBe('правленый бриф\n');
  });

  it('с push в команде появляется флаг канала, а в конфиге MCP — PARLEY_CHANNEL', async () => {
    const { workId, sessionId } = await pending('claude');
    const plan = await planLaunch(project, workId, await sessionOf(workId, sessionId), {
      channel: true,
    });

    const at = plan.args.indexOf('--dangerously-load-development-channels');
    expect(at).toBeGreaterThan(-1);
    expect(plan.args[at + 1]).toBe('server:parley');
    expect(plan.warnings).toEqual([]);

    const configFile = plan.args[plan.args.indexOf('--mcp-config') + 1] as string;
    const config = JSON.parse(await readFile(configFile, 'utf8'));
    expect(config.mcpServers.parley.env.PARLEY_CHANNEL).toBe('1');
    expect(config.mcpServers.parley.env.HARNAS_CHANNEL).toBe('1');
  });

  it('без push ни флага, ни переменной: сессия живёт по pull', async () => {
    const { workId, sessionId } = await pending('claude');
    const plan = await planLaunch(project, workId, await sessionOf(workId, sessionId));

    expect(plan.args).not.toContain('--dangerously-load-development-channels');
    const configFile = plan.args[plan.args.indexOf('--mcp-config') + 1] as string;
    const config = JSON.parse(await readFile(configFile, 'utf8'));
    expect(config.mcpServers.parley.env).not.toHaveProperty('PARLEY_CHANNEL');
    expect(config.mcpServers.parley.env).not.toHaveProperty('HARNAS_CHANNEL');
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
    expect(plan.warnings).toEqual(['providers.json has no {channel}: push is off']);
  });

  it('роль сессии уезжает флагом --agent; без роли пара выпадает целиком', async () => {
    // Пикера агентов при запуске нет: роль выбрана при создании записи, и запуск
    // обязан её донести — иначе сессия стартует обычным claude (5.1).
    const created = await createWork(project, { title: 'Авторизация', goal: '' });
    const workId = created.work.id;
    const roled = await createPendingSession(project, workId, {
      provider: 'claude',
      label: 'ревью',
      task: 'посмотреть шаги 1–3',
      agent: 'reviewer',
    });
    await mkdir(path.join(project, '.claude', 'agents'), { recursive: true });
    await writeFile(path.join(project, '.claude', 'agents', 'different-file.md'), '---\nname: reviewer\ndescription: Review\n---\nNative role.');
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

describe('модель и усилие в плане запуска (дизайн комнат, 3.2)', () => {
  it('claude: выбор из диалога уезжает флагами --model и --effort', async () => {
    const { workId, sessionId } = await pending('claude');
    const plan = await planLaunch(project, workId, await sessionOf(workId, sessionId), {
      model: 'opus',
      effort: 'high',
    });

    expect(plan.args[plan.args.indexOf('--model') + 1]).toBe('opus');
    expect(plan.args[plan.args.indexOf('--effort') + 1]).toBe('high');
    // Бриф по-прежнему последним аргументом: позиционный промпт флагами не сдвигается.
    expect(plan.args.at(-1)).toContain('прогнать e2e');
  });

  it('быстрая сессия new несёт выбор так же', async () => {
    const created = await createNewSession(project, null);
    const plan = await planNew(project, created.workId, created.session, { effort: 'low' });

    expect(plan.args[plan.args.indexOf('--effort') + 1]).toBe('low');
    expect(plan.args).not.toContain('--model');
  });

  it('codex: --model и -c model_reasoning_effort рядом с MCP-переопределением', async () => {
    const { workId, sessionId } = await pending('codex');
    const plan = await planLaunch(project, workId, await sessionOf(workId, sessionId), {
      model: 'gpt-5.5',
      effort: 'medium',
    });

    expect(plan.args.some((arg) => arg.startsWith('mcp_servers.parley='))).toBe(true);
    expect(plan.args[plan.args.indexOf('--model') + 1]).toBe('gpt-5.5');
    expect(plan.args).toContain('model_reasoning_effort="medium"');
  });

  it('без выбора флагов нет: сессия живёт на модели и усилии по умолчанию', async () => {
    for (const provider of ['claude', 'codex']) {
      const { workId, sessionId } = await pending(provider);
      const plan = await planLaunch(project, workId, await sessionOf(workId, sessionId));
      expect(plan.args).not.toContain('--model');
      expect(plan.args).not.toContain('--effort');
      expect(plan.args.join(' ')).not.toContain('model_reasoning_effort');
    }
  });

  it('провайдер без флага в шаблоне выбор не получает — ни отказа, ни висячего значения', async () => {
    await writeFile(
      path.join(home, 'providers.json'),
      JSON.stringify({ claude: { args: ['--session-id', '{sessionUuid}', '{prompt}'] } }),
      'utf8',
    );
    const { workId, sessionId } = await pending('claude');
    const plan = await planLaunch(project, workId, await sessionOf(workId, sessionId), {
      model: 'opus',
      effort: 'high',
    });

    expect(plan.args).toEqual(['--session-id', plan.providerSessionId, plan.args.at(-1)]);
  });

  it('выбор, записанный spawn_session, уезжает флагами: хост поднимает pending без диалога', async () => {
    const created = await createWork(project, { title: 'Авторизация', goal: 'логин по e-mail' });
    const workId = created.work.id;
    const sessionId = await createPendingSession(project, workId, {
      provider: 'claude',
      label: 'тесты',
      task: 'прогнать e2e',
      model: 'opus',
      effort: 'high',
    });
    const stored = await sessionOf(workId, sessionId);
    expect(stored).toMatchObject({ model: 'opus', effort: 'high' });

    const plan = await planLaunch(project, workId, stored);

    expect(plan.args[plan.args.indexOf('--model') + 1]).toBe('opus');
    expect(plan.args[plan.args.indexOf('--effort') + 1]).toBe('high');
    // Бриф по-прежнему последним аргументом: позиционный промпт флагами не сдвигается.
    expect(plan.args.at(-1)).toContain('прогнать e2e');
  });

  it('codex: записанный выбор — --model и -c model_reasoning_effort', async () => {
    const created = await createWork(project, { title: 'Авторизация', goal: '' });
    const sessionId = await createPendingSession(project, created.work.id, {
      provider: 'codex',
      label: 'тесты',
      task: 'прогнать e2e',
      model: 'gpt-6-sol',
      effort: 'low',
    });
    const plan = await planLaunch(project, created.work.id, await sessionOf(created.work.id, sessionId));

    expect(plan.args[plan.args.indexOf('--model') + 1]).toBe('gpt-6-sol');
    expect(plan.args).toContain('model_reasoning_effort="low"');
  });

  it('выбор из диалога окна главнее записанного; невыбранное поле берётся из записи', async () => {
    const created = await createWork(project, { title: 'Авторизация', goal: '' });
    const workId = created.work.id;
    const sessionId = await createPendingSession(project, workId, {
      provider: 'claude',
      label: 'тесты',
      task: 'прогнать e2e',
      model: 'opus',
      effort: 'high',
    });
    const plan = await planLaunch(project, workId, await sessionOf(workId, sessionId), {
      model: 'sonnet',
    });

    expect(plan.args[plan.args.indexOf('--model') + 1]).toBe('sonnet');
    expect(plan.args[plan.args.indexOf('--effort') + 1]).toBe('high');
  });

  it('пустая запись без выбора: флагов нет, а поля model и effort в карте не появляются', async () => {
    const { workId, sessionId } = await pending('claude');
    const stored = await sessionOf(workId, sessionId);

    expect('model' in stored).toBe(false);
    expect('effort' in stored).toBe(false);
  });

  /** Сессия с записанным выбором, которую есть что продолжать: id у провайдера, у Claude — и транскрипт. */
  async function resumable(
    provider: string,
    choice: { model?: string; effort?: string },
    providerSessionId: string,
  ): Promise<{ workId: string; sessionId: string }> {
    const created = await createWork(project, { title: 'Авторизация', goal: '' });
    const sessionId = await createPendingSession(project, created.work.id, {
      provider,
      label: 'тесты',
      task: 'прогнать e2e',
      ...choice,
    });
    await updateMap(project, created.work.id, (map) => {
      const session = map.sessions.find((item) => item.id === sessionId);
      if (session !== undefined) session.providerSessionId = providerSessionId;
    });
    if (provider === 'claude') await claudeTranscript(providerSessionId);
    return { workId: created.work.id, sessionId };
  }

  it('возобновление Claude несёт записанные модель и усилие: effort при --resume Claude Code сам не вернёт', async () => {
    const id = 'c0ffee00-1111-2222-3333-444455556666';
    const { workId, sessionId } = await resumable('claude', { model: 'opus', effort: 'low' }, id);
    const plan = await planResume(project, workId, await sessionOf(workId, sessionId));

    expect(plan.args.slice(0, 2)).toEqual(['--resume', id]);
    expect(plan.args[plan.args.indexOf('--model') + 1]).toBe('opus');
    expect(plan.args[plan.args.indexOf('--effort') + 1]).toBe('low');
    expect(plan.args.filter((arg) => arg === '--effort')).toHaveLength(1);
  });

  it('при возобновлении выбор запуска главнее записанного; невыбранное поле берётся из карты', async () => {
    const { workId, sessionId } = await resumable(
      'claude',
      { model: 'opus', effort: 'low' },
      'c0ffee00-1111-2222-3333-444455556666',
    );
    const plan = await planResume(project, workId, await sessionOf(workId, sessionId), { model: 'sonnet' });

    expect(plan.args[plan.args.indexOf('--model') + 1]).toBe('sonnet');
    expect(plan.args[plan.args.indexOf('--effort') + 1]).toBe('low');
  });

  it('возобновление без записанного выбора — без флагов: модель Claude Code восстанавливает сам', async () => {
    const id = 'c0ffee00-1111-2222-3333-444455556666';
    const { workId, sessionId } = await resumable('claude', {}, id);
    const plan = await planResume(project, workId, await sessionOf(workId, sessionId));

    expect(plan.args.slice(0, 2)).toEqual(['--resume', id]);
    expect(plan.args).not.toContain('--model');
    expect(plan.args).not.toContain('--effort');
  });

  it('codex при возобновлении ни модели, ни усилия не несёт, даже записанных: тред помнит их сам', async () => {
    const { workId, sessionId } = await resumable(
      'codex',
      { model: 'gpt-6-sol', effort: 'ultra' },
      '7fa0e1ee-cc7b-4a1e-9d4e-000000000001',
    );
    const plan = await planResume(project, workId, await sessionOf(workId, sessionId));

    expect(plan.args[0]).toBe('resume');
    expect(plan.args).not.toContain('--model');
    expect(plan.args.join(' ')).not.toContain('model_reasoning_effort');
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
    expect(plan.args.slice(0, 3)).toEqual([
      'resume',
      '7fa0e1ee-cc7b-4a1e-9d4e-000000000001',
      '-c',
    ]);
    // Только `-c`: `--no-daemon` и `-a` после `resume <id>` не проверены на живом Codex (спека 3.6: «те же `-c`»).
    expect(plan.args).not.toContain('--no-daemon');
    expect(plan.args).not.toContain('-a');
    // Те же `-c`, что у запуска: MCP и notify в тред Codex не сохраняются.
    expect(plan.args.some((arg) => arg.startsWith('mcp_servers.parley='))).toBe(true);
    expect(plan.args.some((arg) => arg.startsWith('notify='))).toBe(true);
    // Бриф второй раз не подставляется: сессия продолжается, а не начинается.
    expect(plan.args.join(' ')).not.toContain('прогнать e2e');
    // Указателя нет (ручной подъём) — промпта в конце нет, последним идёт `-c notify=…`.
    expect(plan.args.at(-1)?.startsWith('notify=')).toBe(true);
  });

  it('codex: указатель на письма при подъёме — последним аргументом resume', async () => {
    const { workId, sessionId } = await pending('codex');
    await updateMap(project, workId, (map) => {
      const session = map.sessions.find((item) => item.id === sessionId);
      if (session !== undefined) session.providerSessionId = '7fa0e1ee-cc7b-4a1e-9d4e-000000000001';
    });
    const plan = await planResume(project, workId, await sessionOf(workId, sessionId), {
      prompt: 'New messages (1). Call check_inbox.',
    });
    expect(plan.args.at(-1)).toBe('New messages (1). Call check_inbox.');
    // Модель и усилие Codex восстанавливает из треда, флагами их не передаём.
    expect(plan.args).not.toContain('--model');
  });

  it('возобновление с push тоже несёт флаг канала: сессия просыпается и после resume', async () => {
    const { workId, sessionId } = await pending('claude');
    await updateMap(project, workId, (map) => {
      const session = map.sessions.find((item) => item.id === sessionId);
      if (session !== undefined) session.providerSessionId = 'c0ffee00-1111-2222-3333-444455556666';
    });
    await claudeTranscript('c0ffee00-1111-2222-3333-444455556666');
    const plan = await planResume(project, workId, await sessionOf(workId, sessionId), {
      channel: true,
    });

    const at = plan.args.indexOf('--dangerously-load-development-channels');
    expect(plan.args[at + 1]).toBe('server:parley');
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
    await claudeTranscript('c0ffee00-1111-2222-3333-444455556666');

    await mkdir(path.join(project, '.claude', 'agents'), { recursive: true });
    await writeFile(path.join(project, '.claude', 'agents', 'filename.md'), '---\nname: reviewer\ndescription: Review\n---\nNative prompt only.');
    const plan = await planResume(project, workId, await sessionOf(workId, sessionId));
    expect(plan.args[plan.args.indexOf('--agent') + 1]).toBe('reviewer');
    expect(plan.args[plan.args.indexOf('--append-system-prompt') + 1]).not.toContain('Native prompt only.');
  });

  it('без id у провайдера запускает новый процесс по брифу', async () => {
    const { workId, sessionId } = await pending('codex');
    const plan = await planResume(project, workId, await sessionOf(workId, sessionId));

    expect(plan.args).not.toContain('resume');
    expect(plan.args.at(-1)).toContain('прогнать e2e');
  });

  describe('claude: --resume только при разговоре (транскрипт пишется с первого сообщения)', () => {
    const id = 'c0ffee00-aaaa-bbbb-cccc-000000000001';
    const pointer = 'New messages (1). Call check_inbox.';

    /** Сессия Claude, которой харнесс уже выдал id (`--session-id` первого запуска). */
    async function withId(workId: string, sessionId: string): Promise<void> {
      await updateMap(project, workId, (map) => {
        const session = map.sessions.find((item) => item.id === sessionId);
        if (session !== undefined) session.providerSessionId = id;
      });
    }

    it('транскрипта нет — новый процесс с тем же --session-id, бриф снова первым сообщением', async () => {
      const { workId, sessionId } = await pending('claude');
      await withId(workId, sessionId);

      const plan = await planResume(project, workId, await sessionOf(workId, sessionId));
      expect(plan.args).not.toContain('--resume');
      expect(plan.args[plan.args.indexOf('--session-id') + 1]).toBe(id);
      expect(plan.providerSessionId).toBe(id);
      expect(plan.args.at(-1)).toContain('прогнать e2e');
    });

    it('транскрипт есть — --resume с этим id', async () => {
      const { workId, sessionId } = await pending('claude');
      await withId(workId, sessionId);
      await claudeTranscript(id);

      const plan = await planResume(project, workId, await sessionOf(workId, sessionId));
      expect(plan.args.slice(0, 2)).toEqual(['--resume', id]);
      expect(plan.args).not.toContain('--session-id');
    });

    it('CLAUDE_CONFIG_DIR: транскрипт в его projects — --resume, а не новый процесс с занятым id', async () => {
      const home = await mkdtemp(path.join(tmpdir(), 'parley-claude-home-'));
      const config = await mkdtemp(path.join(tmpdir(), 'parley-claude-config-'));
      try {
        setEnv('PARLEY_CLAUDE_PROJECTS_DIR', undefined);
        setEnv('HOME', home);
        setEnv('CLAUDE_CONFIG_DIR', config);
        await mkdir(path.join(config, 'projects', '-p'), { recursive: true });
        await writeFile(path.join(config, 'projects', '-p', `${id}.jsonl`), '{"type":"user"}\n');
        const { workId, sessionId } = await pending('claude');
        await withId(workId, sessionId);

        const plan = await planResume(project, workId, await sessionOf(workId, sessionId));
        expect(plan.args.slice(0, 2)).toEqual(['--resume', id]);
      } finally {
        await Promise.all([home, config].map((dir) => rm(dir, { recursive: true, force: true })));
      }
    });

    it('ни один корень истории не прочитать — ответа нет, остаётся --resume', async () => {
      setEnv('PARLEY_CLAUDE_PROJECTS_DIR', path.join(logs, 'нет-такого-каталога'));
      const { workId, sessionId } = await pending('claude');
      await withId(workId, sessionId);

      const plan = await planResume(project, workId, await sessionOf(workId, sessionId));
      expect(plan.args.slice(0, 2)).toEqual(['--resume', id]);
    });

    it('тихую сессию без разговора будит письмо — указатель её первым сообщением', async () => {
      const { workId, session } = await createNewSession(project, null);
      await withId(workId, session.id);

      const plan = await planResume(project, workId, await sessionOf(workId, session.id), {
        prompt: pointer,
      });
      expect(plan.args).not.toContain('--resume');
      expect(plan.args[plan.args.indexOf('--session-id') + 1]).toBe(id);
      expect(plan.args.at(-1)).toBe(pointer);
    });

    it('сессию с задачей без разговора будит письмо — бриф и указатель одним первым сообщением', async () => {
      const { workId, sessionId } = await pending('claude');
      await withId(workId, sessionId);

      const plan = await planResume(project, workId, await sessionOf(workId, sessionId), {
        prompt: pointer,
      });
      expect(plan.args).not.toContain('--resume');
      expect(plan.args.at(-1)).toContain('прогнать e2e');
      expect(plan.args.at(-1)).toContain(pointer);
    });
  });
});

describe('системная вставка гида', () => {
  it('custom GLM command is refused before plan settings are generated', async () => {
    const { workId, sessionId } = await pending('glm');
    const session = await sessionOf(workId, sessionId);
    await writeFile(path.join(home, 'providers.json'), JSON.stringify({ glm: { command: 'wrapper' } }));
    for (const makePlan of [planLaunch, planNew, planResume]) {
      await expect(makePlan(project, workId, session)).rejects.toThrow(/official claude/);
    }
    await expect(stat(path.join(workPaths(project, workId).dir, 'settings-glm.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
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
    await claudeTranscript('7fa0e1ee-cc7b-4a1e-9d4e-000000000002');
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
    await claudeTranscript('7fa0e1ee-cc7b-4a1e-9d4e-000000000003');

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
    await claudeTranscript('7fa0e1ee-cc7b-4a1e-9d4e-000000000004');

    const plan = await planResume(project, workId, await sessionOf(workId, sessionId));
    expect(plan.args).toContain('--resume');
    expect(guidanceOf(plan.args)).not.toContain('прогнать e2e');
  });

  it('быстрой сессии new брифа не пишется: вставка остаётся одной вставкой', async () => {
    const { workId } = await pending('claude');
    const quick = await createNewSession(project, workId);

    const plan = await planNew(project, workId, quick.session);
    expect(guidanceOf(plan.args)).not.toContain('# Workspace');
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
    expect(session.lifecycle).toBe('active');
    expect(session.providerSessionId).toBe('uuid-1');
    expect(session.startedAt).not.toBeNull();
    expect(session.history.map((entry) => entry.event)).toEqual(['pending', 'active']);
  });

  it('startSession с приметами процесса пишет в карту launchedBy: host', async () => {
    const { workId, sessionId } = await pending('claude');
    await startSession(project, workId, sessionId, 'uuid-host', {
      pid: 4242,
      startedAtProcess: null,
      launchedBy: 'host',
    });

    const session = await sessionOf(workId, sessionId);
    expect(session.pid).toBe(4242);
    expect(session.startedAtProcess).toBeNull();
    expect(session.launchedBy).toBe('host');
  });

  it('выход процесса переводит active → sleeping и пишет код выхода в history', async () => {
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
    expect(session.lifecycle).toBe('sleeping');
    expect(session.history.at(-1)).toMatchObject({ event: 'sleeping', exitCode: 3 });
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

  it('выход процесса итог отчёта не трогает: done остаётся, сессия спит', async () => {
    const { workId, sessionId } = await pending('claude');
    await startSession(project, workId, sessionId, null);
    await updateMap(project, workId, (map) => {
      const session = setResult(map, sessionId, 'done');
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
    expect(session.result).toBe('done');
    expect(session.lifecycle).toBe('sleeping');
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

  describe('две сессии codex в одном каталоге', () => {
    const FIRST_START = '2026-09-02T10:00:00.000Z';
    const SECOND_START = '2026-09-02T10:00:03.000Z';

    /** Работа с двумя запущенными сессиями codex, чьи старты записаны в карту вручную — время задаёт тест. */
    async function twoSessions(): Promise<{ workId: string; first: string; second: string }> {
      const created = await createWork(project, { title: 'Комната', goal: '' });
      const workId = created.work.id;
      const first = await createPendingSession(project, workId, { provider: 'codex', label: 'а', task: 'x' });
      const second = await createPendingSession(project, workId, { provider: 'codex', label: 'б', task: 'x' });
      await startSession(project, workId, first, null);
      await startSession(project, workId, second, null);
      await updateMap(project, workId, (map) => {
        for (const session of map.sessions) {
          session.startedAt = session.id === first ? FIRST_START : SECOND_START;
        }
      });
      return { workId, first, second };
    }

    it('лог первой сессии, уже привязанный, второй не достаётся: она берёт свой', async () => {
      const { workId, first, second } = await twoSessions();
      // Лог первой лежит в допуске второй и раньше её собственного.
      await writeRollout('лог-первой', project, '2026-09-02T10:00:01.000Z');
      await writeRollout('лог-второй', project, '2026-09-02T10:00:04.000Z');
      await updateMap(project, workId, (map) => {
        const target = map.sessions.find((session) => session.id === first);
        if (target !== undefined) target.providerSessionId = 'лог-первой';
      });

      const found = await linkSession(project, workId, await sessionOf(workId, second), { codexRoot: logs });

      expect(found).toBe('лог-второй');
      expect((await sessionOf(workId, second)).providerSessionId).toBe('лог-второй');
      expect((await sessionOf(workId, first)).providerSessionId).toBe('лог-первой');
    });

    it('обе ищут одновременно и видят один лог: его получает одна, вторая остаётся без привязки', async () => {
      const { workId, first, second } = await twoSessions();
      await writeRollout('единственный-лог', project, '2026-09-02T10:00:01.000Z');

      const results = await Promise.all([
        linkSession(project, workId, await sessionOf(workId, first), { codexRoot: logs }),
        linkSession(project, workId, await sessionOf(workId, second), { codexRoot: logs }),
      ]);

      const holders = (await readMap(project, workId)).sessions.filter(
        (session) => session.providerSessionId === 'единственный-лог',
      );
      expect(holders).toHaveLength(1);
      // Проигравшая ничего не записала и говорит об этом: «привязывать нечего».
      expect(results.filter((result) => result === null)).toHaveLength(1);
    });
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

describe('common session layer delivery', () => {
  const codexLayer = (args: string[]): string => {
    const arg = args.find((value) => value.startsWith('developer_instructions='));
    if (arg === undefined) throw new Error('developer layer missing');
    return JSON.parse(arg.slice('developer_instructions='.length)) as string;
  };

  it('Codex carries project rules in launch/new/resume and keeps the resume pointer last', async () => {
    const { workId, sessionId } = await pending('codex');
    await writeFile(path.join(project, 'PARLEY.md'), '# Team\n<!-- template -->\nUse fixtures.');
    const session = await sessionOf(workId, sessionId);
    for (const plan of [await planLaunch(project, workId, session), await planNew(project, workId, session),
      await planResume(project, workId, { ...session, providerSessionId: 'codex-thread' }, { prompt: 'INBOX POINTER' })]) {
      const layer = codexLayer(plan.args);
      expect(layer).toContain(`your session is ${sessionId}`);
      expect(layer).toContain('Team rules of this project (PARLEY.md):\n# Team\n\nUse fixtures.');
      expect(layer).not.toContain('template');
      expect(layer).not.toContain('прогнать e2e');
      expect(plan.args).toContain('project_doc_fallback_filenames=["CLAUDE.md"]');
      if (plan.args[0] === 'resume') expect(plan.args.at(-1)).toBe('INBOX POINTER');
    }
  });

  it('quiet Codex gets the existing brief as context, never as a first prompt', async () => {
    const { workId, sessionId } = await pending('codex');
    await updateMap(project, workId, (map) => { map.sessions[0]!.summary = 'QUIET PARENT CONTEXT'; });
    const { session: child } = await createChildSession(project, workId, sessionId);
    child.provider = 'codex';
    for (const plan of [await planLaunch(project, workId, child),
      await planResume(project, workId, { ...child, providerSessionId: 'codex-thread' })]) {
      expect(codexLayer(plan.args)).toContain('QUIET PARENT CONTEXT');
      expect(plan.args.filter((arg) => arg.includes('QUIET PARENT CONTEXT'))).toHaveLength(1);
      expect(plan.args.at(-1)).not.toContain('QUIET PARENT CONTEXT');
    }
  });

  it('uses main-project PARLEY.md with the native bridge condition from worktree cwd', async () => {
    const { workId, sessionId } = await pending('codex');
    const cwd = path.join(project, 'branch');
    await mkdir(cwd);
    await writeFile(path.join(project, 'PARLEY.md'), 'MAIN SHARED RULES');
    await writeFile(path.join(cwd, 'PARLEY.md'), 'BRANCH RULES IGNORED');
    await writeFile(path.join(cwd, 'CLAUDE.md'), 'native rules');
    const session = await sessionOf(workId, sessionId);
    session.worktree = { path: cwd, branch: 'codex/test', base: 'main', createdAt: null };
    const bridged = await planLaunch(project, workId, session);
    expect(bridged.cwd).toBe(cwd);
    expect(codexLayer(bridged.args)).toContain('MAIN SHARED RULES');
    expect(codexLayer(bridged.args)).not.toContain('BRANCH RULES IGNORED');
    expect(codexLayer(bridged.args)).toContain('Project instructions here were written for Claude Code');
    await writeFile(path.join(cwd, 'AGENTS.override.md'), 'native override');
    expect(codexLayer((await planLaunch(project, workId, session)).args)).not.toContain('Project instructions here were written for Claude Code');
  });

  it('custom Codex without a channel warns and launches without rewriting its arrays', async () => {
    const { workId, sessionId } = await pending('codex');
    await writeFile(path.join(home, 'providers.json'), JSON.stringify({ codex: { args: ['CUSTOM', '{prompt}'], resumeArgs: ['AGAIN', '{providerSessionId}', '{prompt}'] } }));
    const session = await sessionOf(workId, sessionId);
    const launch = await planLaunch(project, workId, session);
    expect(launch.args[0]).toBe('CUSTOM');
    expect(launch.args).toHaveLength(2);
    expect(launch.diagnostics?.map((warning) => warning.code)).toEqual(['provider-override-gap']);
    const resume = await planResume(project, workId, { ...session, providerSessionId: 'id' }, { prompt: 'POINTER' });
    expect(resume.args).toEqual(['AGAIN', 'id', 'POINTER']);
    expect(resume.warnings).toHaveLength(1);
    await expect(planLaunch(project, workId, session, { layer: { role: 'MANDATORY ROLE' } }))
      .rejects.toThrow('role-delivery-unavailable');
  });

  it('GLM, a claude-family runner, receives the layer both built-in and through a custom template', async () => {
    const { workId, sessionId } = await pending('codex');
    const session = { ...await sessionOf(workId, sessionId), provider: 'glm' };
    const builtIn = await planLaunch(project, workId, session);
    expect(builtIn.args[builtIn.args.indexOf('--append-system-prompt') + 1]).toContain('Your workspace is');
    await writeFile(path.join(home, 'providers.json'), JSON.stringify({ glm: { args: ['--append-system-prompt', '{systemPrompt}', '{prompt}'] } }));
    await writeFile(path.join(project, 'PARLEY.md'), 'CUSTOM GLM RULES');
    const plan = await planLaunch(project, workId, session);
    expect(plan.args[1]).toContain('CUSTOM GLM RULES');
  });

  it('preprocesses all bounded blocks, but refuses an escaped full mandatory layer overflow', async () => {
    const { workId, sessionId } = await pending('codex');
    const session = await sessionOf(workId, sessionId);
    await writeFile(path.join(project, 'PARLEY.md'), 'first\n' + 'x'.repeat(40000));
    await updateMap(project, workId, (map) => {
      addRoom(map, { title: 'R', creator: 'human', members: [sessionId], lead: sessionId, recipe: { id: 'project:long', name: 'Long', playbook: 'first\n' + 'x'.repeat(40000) } });
    });
    const trimmed = await planLaunch(project, workId, session, { layer: { role: 'first\n' + 'x'.repeat(40000) } });
    expect(trimmed.diagnostics?.map((warning) => warning.code)).toEqual(['parley-md-truncated', 'role-truncated', 'recipe-playbook-truncated']);
    await writeFile(path.join(project, 'PARLEY.md'), '\u0001'.repeat(17000));
    await expect(planLaunch(project, workId, session)).rejects.toThrow('session-layer-too-large');
    await expect(planNew(project, workId, session)).rejects.toThrow('session-layer-too-large');
    await expect(planResume(project, workId, { ...session, providerSessionId: 'id' })).rejects.toThrow('session-layer-too-large');
  });
});

describe('плейбук рецепта в слое ведущего', () => {
  const codexLayer = (args: string[]): string => {
    const arg = args.find((value) => value.startsWith('developer_instructions='));
    if (arg === undefined) throw new Error('developer layer missing');
    return JSON.parse(arg.slice('developer_instructions='.length)) as string;
  };
  const snapshot = { id: 'project:pay', name: 'Payments', playbook: 'SECRET LEAD PLAYBOOK' };

  it('ведущий получает строку рецепта и плейбук на launch/new/resume, участник и сессия вне комнаты — нет', async () => {
    const { workId, sessionId } = await pending('codex');
    const member = await createPendingSession(project, workId, { provider: 'codex', label: 'второй', task: 'x' });
    const outsider = await createPendingSession(project, workId, { provider: 'codex', label: 'третий', task: 'x' });
    await updateMap(project, workId, (map) => {
      addRoom(map, { title: 'R', creator: 'human', members: [sessionId, member], lead: sessionId, recipe: snapshot });
    });
    const lead = { ...await sessionOf(workId, sessionId), providerSessionId: 'id' };
    for (const plan of [await planLaunch(project, workId, lead), await planNew(project, workId, lead), await planResume(project, workId, lead)]) {
      expect(codexLayer(plan.args)).toContain('Recipe: Payments — you lead this room.\nSECRET LEAD PLAYBOOK');
    }
    for (const id of [member, outsider]) {
      const plan = await planLaunch(project, workId, await sessionOf(workId, id));
      expect(codexLayer(plan.args)).not.toContain('SECRET LEAD PLAYBOOK');
      expect(codexLayer(plan.args)).not.toContain('Recipe:');
    }
  });

  it('поля плейбука из options.layer не действуют: решает карта', async () => {
    const { workId, sessionId } = await pending('codex');
    const plan = await planLaunch(project, workId, await sessionOf(workId, sessionId), { layer: { playbook: 'INJECTED', isLead: true } });
    expect(codexLayer(plan.args)).not.toContain('INJECTED');
  });

  it('при смене ведущего плейбук уходит новому ведущему: закрытый прежний больше его не получает', async () => {
    const { workId, sessionId } = await pending('codex');
    const next = await createPendingSession(project, workId, { provider: 'codex', label: 'второй', task: 'x' });
    await updateMap(project, workId, (map) => {
      addRoom(map, { title: 'R', creator: 'human', members: [sessionId, next], lead: sessionId, recipe: snapshot });
      const closed = map.sessions.find((row) => row.id === sessionId)!;
      closed.lifecycle = 'closed';
    });
    expect(codexLayer((await planLaunch(project, workId, await sessionOf(workId, next))).args)).toContain('SECRET LEAD PLAYBOOK');
  });
});

describe('current role delivery on every session mode', () => {
  it.each(['claude', 'codex'])('builtin role text and read-only delivery survive resume (%s)', async provider => {
    const created = await createWork(project, { title: 'Roles', goal: '' });
    const sessionId = await createPendingSession(project, created.work.id, { provider, label: '', task: '', role: { source: 'builtin', name: 'planner' } });
    const session = await sessionOf(created.work.id, sessionId);
    session.providerSessionId = provider === 'claude' ? 'c0ffee00-1111-2222-3333-444455556666' : 'native-id';
    if (provider === 'claude') await claudeTranscript(session.providerSessionId);
    for (const planner of [planNew, planLaunch, planResume]) {
      const plan = await planner(project, created.work.id, session);
      if (provider === 'claude') {
        expect(plan.args[plan.args.indexOf('--disallowedTools') + 1]).toBe('Edit,Write,NotebookEdit');
        expect(plan.args[plan.args.indexOf('--append-system-prompt') + 1]).toContain('Your role in this workspace: Planner (builtin:planner)');
      } else {
        expect(plan.args).toContain('sandbox_mode="read-only"');
        expect(plan.args.find(arg => arg.startsWith('developer_instructions='))).toContain('builtin:planner');
      }
    }
    expect(Object.hasOwn((await sessionOf(created.work.id, sessionId)), 'model')).toBe(false);
  });
  it('GLM: «только чтение» встроенной роли и текст роли доходят при запуске и при resume', async () => {
    const created = await createWork(project, { title: 'Roles', goal: '' });
    const sessionId = await createPendingSession(project, created.work.id, { provider: 'glm', label: '', task: '', role: { source: 'builtin', name: 'planner' } });
    const session = await sessionOf(created.work.id, sessionId);
    session.providerSessionId = 'c0ffee00-1111-2222-3333-444455556666';
    await claudeTranscript(session.providerSessionId);
    for (const planner of [planNew, planLaunch, planResume]) {
      const plan = await planner(project, created.work.id, session);
      expect(plan.args[plan.args.indexOf('--disallowedTools') + 1]).toBe('Edit,Write,NotebookEdit');
      expect(plan.args[plan.args.indexOf('--append-system-prompt') + 1]).toContain('Your role in this workspace: Planner (builtin:planner)');
      // Модель по уровню роли у GLM не подбирается: её флага нет, у GLM своя настроенная модель.
      expect(plan.args).not.toContain('--agent');
    }
    // Роль без «только чтения» — без флага.
    const writer = await createPendingSession(project, created.work.id, { provider: 'glm', label: '', task: '', role: { source: 'builtin', name: 'executor' } });
    expect((await planLaunch(project, created.work.id, await sessionOf(created.work.id, writer))).args).not.toContain('--disallowedTools');
  });
  it('GLM: нативный агент Claude уезжает флагом --agent при запуске и при resume', async () => {
    const created = await createWork(project, { title: 'Roles', goal: '' });
    const sessionId = await createPendingSession(project, created.work.id, { provider: 'glm', label: '', task: '', role: { source: 'claude', name: 'native-reviewer' } });
    const session = await sessionOf(created.work.id, sessionId);
    session.providerSessionId = 'c0ffee00-1111-2222-3333-444455556666';
    await claudeTranscript(session.providerSessionId);
    const roleCatalog = { roles: [{ id: 'claude:native-reviewer', source: 'claude' as const, provider: 'claude' as const, name: 'native-reviewer', description: '', path: '/fixture/native-reviewer.md', nativeAgent: 'native-reviewer', readOnly: false }], diagnostics: [], partial: false };
    for (const planner of [planNew, planLaunch, planResume]) {
      const plan = await planner(project, created.work.id, session, { roleCatalog });
      expect(plan.args[plan.args.indexOf('--agent') + 1]).toBe('native-reviewer');
    }
  });
  it('current native Codex defaults use exact effort and sandbox and do not persist', async () => {
    const created = await createWork(project, { title: 'Roles', goal: '' });
    const sessionId = await createPendingSession(project, created.work.id, { provider: 'codex', label: '', task: '', role: { source: 'codex', name: 'exact' } });
    const catalog = { roles: [{ id: 'codex:exact', source: 'codex' as const, provider: 'codex' as const, name: 'Exact', description: '', path: '/fixture.toml', prompt: 'Native developer role', model: 'native-model', effort: 'xhigh', sandboxMode: 'read-only' as const, readOnly: true }], diagnostics: [], partial: false };
    const session = await sessionOf(created.work.id, sessionId);
    session.providerSessionId = 'native-id';
    for (const planner of [planNew, planResume]) {
      const plan = await planner(project, created.work.id, session, { roleCatalog: catalog });
      if (planner === planNew) { expect(plan.args).toContain('native-model'); expect(plan.args).toContain('model_reasoning_effort="xhigh"'); }
      else { expect(plan.args).not.toContain('--model'); expect(plan.args.join(' ')).not.toContain('model_reasoning_effort'); }
      expect(plan.args).toContain('sandbox_mode="read-only"');
    }
    const removed = await planResume(project, created.work.id, session, { roleCatalog: { roles: [], diagnostics: [], partial: false } });
    expect(removed.diagnostics?.some(item => item.code === 'role-missing')).toBe(true);
    expect(removed.args).not.toContain('sandbox_mode="read-only"'); expect(removed.args).not.toContain('native-model');
  });
  it('foreign sandbox and custom mandatory-channel gaps fail before command construction', async () => {
    const { workId, sessionId } = await pending('claude');
    const session = await sessionOf(workId, sessionId);
    await expect(planLaunch(project, workId, session, { requiredPermissions: { sandboxMode: 'workspace-write' } })).rejects.toThrow('role-permissions-unavailable');
    session.role = { source: 'builtin', name: 'planner' };
    await writeFile(path.join(home, 'providers.json'), JSON.stringify({ claude: { resumeArgs: ['--resume', '{providerSessionId}', '--append-system-prompt', '{systemPrompt}'] } }));
    await expect(planNew(project, workId, session)).rejects.toThrow('role-permissions-unavailable');
  });
});


describe('fresh role defaults versus persisted explicit CLI clears', () => {
  it.each([false, true])('rereads new-launch defaults without storing them (explicit clear %s)', async clear => {
    const { work } = await createWork(project, { title: 'Roles', goal: '' });
    const sessionId = await createPendingSession(project, work.id, { provider: 'codex', label: 'Review', task: '', role: { source: 'codex', name: 'current' }, ...(clear ? { model: null, effort: null } : {}) });
    const session = await sessionOf(work.id, sessionId);
    const catalog = (model: string, effort: string) => ({ roles: [{ id: 'codex:current', source: 'codex' as const, provider: 'codex' as const, name: 'current', description: '', path: '/fixture.toml', prompt: 'Current role', model, effort, sandboxMode: null, readOnly: false }], diagnostics: [], partial: false });
    const first = await planNew(project, work.id, session, { roleCatalog: catalog('first-native-model', 'xhigh') });
    const next = await planNew(project, work.id, session, { roleCatalog: catalog('second-native-model', 'minimal') });
    if (clear) {
      expect(first.args).not.toContain('--model'); expect(next.args).not.toContain('--model');
      expect(next.args.join(' ')).not.toContain('model_reasoning_effort');
    } else {
      expect(first.args).toContain('first-native-model'); expect(next.args).toContain('second-native-model');
      expect(next.args).toContain('model_reasoning_effort="minimal"');
    }
    const stored = await sessionOf(work.id, sessionId);
    expect(Object.hasOwn(stored, 'model')).toBe(clear);
    expect(Object.hasOwn(stored, 'effort')).toBe(clear);
  });
});

describe('immutable skill navigator launch snapshot', () => {
  it('binds exact actual Codex launch and resume env revisions independently of agentSkills', async () => {
    setEnv('PARLEY_SKILL_NAVIGATOR', '1'); setEnv('PARLEY_AGENT_SKILLS', '0');
    const { workId, sessionId } = await pending('codex');
    const session = await sessionOf(workId, sessionId);
    const launch = await planLaunch(project, workId, session);
    const first = await readNativeContext(project, workId, sessionId);
    expect(first).toMatchObject({ provider: 'codex', verified: true, revision: launch.env.PARLEY_NATIVE_CONTEXT_REVISION });
    expect(first?.process).toBeUndefined();
    expect(launch.env.PARLEY_SKILL_NAVIGATOR).toBe('1');
    const launchMcp = parseTomlAssignment(launch.args.find(arg => arg.startsWith('mcp_servers.parley='))!).value as { env: Record<string, string> };
    expect(launchMcp.env.PARLEY_SKILL_NAVIGATOR).toBe('1');
    expect(launchMcp.env.PARLEY_NATIVE_CONTEXT_REVISION).toBe(first?.revision);
    await startSession(project, workId, sessionId, 'native-thread', { pid: 42, startedAtProcess: 'start-1', launchedBy: 'cli' }, first?.revision);
    expect((await readNativeContext(project, workId, sessionId))?.process).toEqual({ pid: 42, startedAtProcess: 'start-1' });
    // A subsequent global setting change cannot alter the already-built MCP configuration.
    process.env.PARLEY_SKILL_NAVIGATOR = '0';
    const resume = await planResume(project, workId, await sessionOf(workId, sessionId));
    expect(resume.env.PARLEY_SKILL_NAVIGATOR).toBe('0');
    const resumeMcp = parseTomlAssignment(resume.args.find(arg => arg.startsWith('mcp_servers.parley='))!).value as { env: Record<string, string> };
    expect(resumeMcp.env.PARLEY_SKILL_NAVIGATOR).toBe('0');
    expect(launchMcp.env.PARLEY_SKILL_NAVIGATOR).toBe('1');
    expect(resume.env.PARLEY_NATIVE_CONTEXT_REVISION).not.toBe(first?.revision);
    expect(launch.args.some(arg => arg.startsWith('skills.config='))).toBe(false);
    expect(resume.args.some(arg => arg.startsWith('skills.config='))).toBe(false);
  });
  it('Claude with a confirmed Skill route reduces the list: budget env, explicit snapshot, no unverified warning', async () => {
    await claudeConfig();
    claudeSkillRoute.catalogReady = true;
    setEnv('PARLEY_SKILL_NAVIGATOR', '1');
    const { workId, sessionId } = await pending('claude');
    const plan = await planLaunch(project, workId, await sessionOf(workId, sessionId));
    const mcp = JSON.parse(await readFile(path.join(workPaths(project, workId).mcp, `${sessionId}.json`), 'utf8'));
    expect(mcp.mcpServers.parley.env.PARLEY_SKILL_NAVIGATOR).toBe('1');
    expect(mcp.mcpServers.parley.env.PARLEY_SKILL_LIST_REDUCED).toBe('1');
    expect(mcp.mcpServers.parley.env.PARLEY_NATIVE_CONTEXT_REVISION).toBe(plan.env.PARLEY_NATIVE_CONTEXT_REVISION);
    expect((await readNativeContext(project, workId, sessionId))?.verified).toBe(false);
    expect(plan.env.SLASH_COMMAND_TOOL_CHAR_BUDGET).toBe('1');
    expect(plan.env.PARLEY_SKILL_LIST_REDUCED).toBe('1');
    expect(plan.warnings.join(' ')).not.toContain('full native skill list');
  });
});

describe('navigator launch settings and fallback', () => {
  it.each([false, true])('Claude quiet=%s uses session-local settings on actual start/resume only when enabled', async quiet => {
    const provider = 'claude';
    await claudeConfig();
    claudeSkillRoute.catalogReady = true;
    setEnv('PARLEY_AGENT_SKILLS', '0');
    setEnv('PARLEY_SKILL_NAVIGATOR', '0');
    const { workId, sessionId } = await pending(provider);
    const session = await sessionOf(workId, sessionId);
    if (quiet) session.task = '';
    const off = await planNew(project, workId, session);
    const legacyFile = off.args[off.args.indexOf('--settings') + 1]!;
    expect(legacyFile).toBe(workPaths(project, workId).settings);
    const legacy = await readFile(legacyFile, 'utf8');
    expect(off.args.join(' ')).not.toContain('find_skill');
    setEnv('PARLEY_SKILL_NAVIGATOR', '1');
    for (const planner of [planNew, planResume]) {
      if (planner === planResume) {
        session.providerSessionId = 'c0ffee00-1111-2222-3333-444455556666';
        await claudeTranscript(session.providerSessionId);
      }
      const plan = await planner(project, workId, session, { hookUrl: 'http://127.0.0.1:40001/hooks' });
      expect(plan.args.includes('--resume')).toBe(planner === planResume);
      const file = plan.args[plan.args.indexOf('--settings') + 1]!;
      expect(file).toBe(path.join(workPaths(project, workId).dir, 'settings', `${sessionId}.json`));
      expect(await readFile(file, 'utf8')).toBe(workSettingsJson({ hookUrl: 'http://127.0.0.1:40001/hooks' }));
      expect(await readFile(legacyFile, 'utf8')).toBe(legacy);
      expect(plan.args.join(' ')).toContain('find_skill');
      expect(plan.env.PARLEY_SKILL_NAVIGATOR).toBe('1');
      expect(plan.env.SLASH_COMMAND_TOOL_CHAR_BUDGET).toBe('1');
      const settings = JSON.parse(await readFile(file, 'utf8'));
      expect(Object.keys(settings).sort()).toEqual(['hooks', 'statusLine']);
      expect(JSON.stringify(settings)).not.toContain('enabledPlugins');
    }
    setEnv('PARLEY_SKILL_NAVIGATOR', '0');
    const restored = await planNew(project, workId, session);
    expect(restored.args[restored.args.indexOf('--settings') + 1]).toBe(legacyFile);
    expect(await readFile(legacyFile, 'utf8')).toBe(legacy);
  });

  it('an actual custom template without MCP gets no navigator hint or native suppression', async () => {
    setEnv('PARLEY_SKILL_NAVIGATOR', '1');
    const { workId, sessionId } = await pending('claude');
    await writeFile(path.join(home, 'providers.json'), JSON.stringify({ claude: { args: ['--append-system-prompt', '{systemPrompt}'] } }));
    const plan = await planNew(project, workId, await sessionOf(workId, sessionId));
    expect(plan.args.join(' ')).not.toContain('find_skill');
    expect(plan.args).not.toContain('--settings');
    expect(plan.warnings.join(' ')).toContain('full native skill list');
    expect(plan.env).not.toHaveProperty('SLASH_COMMAND_TOOL_CHAR_BUDGET');
  });
});

describe('навигатор у GLM (семейство Claude Code)', () => {
  const hookUrl = 'http://127.0.0.1:40001/hooks';
  /** `~/.claude` GLM-сессии: хост срезает у неё `CLAUDE_CONFIG_DIR`, поэтому мод jev ищется здесь. */
  const homeWithJev = async (): Promise<void> => {
    const fakeHome = path.join(home, 'user-home');
    const manifest = path.join(fakeHome, '.claude', 'skills', 'jev-skill-suggestion', '.claude-plugin');
    await mkdir(manifest, { recursive: true });
    await writeFile(path.join(manifest, 'plugin.json'), JSON.stringify({ name: 'jev-skill-suggestion', version: '0.1.0' }));
    setEnv('HOME', fakeHome);
  };

  it('навигатор выключен: файл настроек GLM и окружение как раньше, ничего лишнего', async () => {
    setEnv('PARLEY_SKILL_NAVIGATOR', '0');
    const { workId, sessionId } = await pending('glm');
    for (const planner of [planNew, planResume]) {
      const plan = await planner(project, workId, await sessionOf(workId, sessionId));
      const settingsFile = plan.args[plan.args.indexOf('--settings') + 1]!;
      expect(path.basename(settingsFile)).toBe('settings-glm.json');
      expect(await readFile(settingsFile, 'utf8')).not.toContain('enabledPlugins');
      expect(plan.args.join(' ')).not.toContain('find_skill');
      expect(plan.env).not.toHaveProperty('SLASH_COMMAND_TOOL_CHAR_BUDGET');
      expect(plan.env['PARLEY_SKILL_NAVIGATOR']).toBe('0');
      expect(plan.warnings).toEqual([]);
    }
  });

  it.each(['planNew', 'planResume'] as const)('%s: бюджет в окружении процесса, jev выключен в файле сессии вместе с моделью Z.ai и хуками', async (which) => {
    await homeWithJev();
    // Конфигурация Claude хозяина без jev: GLM её не видит, а значит, не должна по ней решать.
    await claudeConfig();
    claudeSkillRoute.catalogReady = true;
    setEnv('PARLEY_SKILL_NAVIGATOR', '1');
    const { workId, sessionId } = await pending('glm');
    const plan = await (which === 'planNew' ? planNew : planResume)(project, workId, await sessionOf(workId, sessionId), { hookUrl });
    expect(plan.command).toBe('claude');
    expect(plan.env.SLASH_COMMAND_TOOL_CHAR_BUDGET).toBe('1');
    expect(plan.env.PARLEY_SKILL_NAVIGATOR).toBe('1');
    expect(plan.env.PARLEY_SKILL_LIST_REDUCED).toBe('1');
    // Маршрутизация Z.ai из окружения раннера не потеряна.
    expect(plan.env).toMatchObject({ ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic', CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: '1' });
    const file = plan.args[plan.args.indexOf('--settings') + 1]!;
    expect(file).toBe(path.join(workPaths(project, workId).dir, 'settings', `${sessionId}.json`));
    const settings = JSON.parse(await readFile(file, 'utf8'));
    expect(settings.enabledPlugins).toEqual({ 'jev-skill-suggestion@skills-dir': false });
    expect(settings.model).toBe('glm-5.3[1m]');
    delete settings.enabledPlugins;
    // Остальное — то, что пишет master для GLM: модель, токен хуков `PARLEY_HOOK_CAPABILITY`, HTTP-хуки ленты, строка статуса.
    expect(settings).toEqual(JSON.parse(workSettingsJson({ provider: 'glm', model: 'glm-5.3[1m]', hookUrl })));
    expect(JSON.stringify(settings)).toContain('PARLEY_HOOK_CAPABILITY');
    // Файл GLM прежнего вида не заводится.
    await expect(stat(path.join(workPaths(project, workId).dir, 'settings-glm.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(plan.args.join(' ')).toContain('find_skill');
    expect(plan.args.join(' ')).toContain('skill list shows names only');
    expect(plan.warnings).toEqual([]);
  });

  it('jev не установлен: список сокращается, плагины не трогаются', async () => {
    setEnv('HOME', path.join(home, 'empty-home'));
    setEnv('PARLEY_SKILL_NAVIGATOR', '1');
    const { workId, sessionId } = await pending('glm');
    const plan = await planNew(project, workId, await sessionOf(workId, sessionId));
    expect(plan.env.SLASH_COMMAND_TOOL_CHAR_BUDGET).toBe('1');
    const settings = JSON.parse(await readFile(plan.args[plan.args.indexOf('--settings') + 1]!, 'utf8'));
    expect(settings).not.toHaveProperty('enabledPlugins');
    expect(settings.model).toBe('glm-5.3[1m]');
  });

  it('подмена записи glm без {mcpConfig}: список остаётся полным, переменная бюджета не ставится', async () => {
    setEnv('PARLEY_SKILL_NAVIGATOR', '1');
    const { workId, sessionId } = await pending('glm');
    await writeFile(path.join(home, 'providers.json'), JSON.stringify({ glm: { args: ['--append-system-prompt', '{systemPrompt}', '{prompt}'] } }));
    const plan = await planNew(project, workId, await sessionOf(workId, sessionId));
    expect(plan.args.join(' ')).not.toContain('find_skill');
    expect(plan.env).not.toHaveProperty('SLASH_COMMAND_TOOL_CHAR_BUDGET');
    expect(plan.warnings.join(' ')).toContain('full native skill list');
  });
});

describe('native Claude navigator permission gate', () => {
  it('keeps the exact native role and full list without advertising an unverified find_skill permission', async () => {
    setEnv('PARLEY_SKILL_NAVIGATOR', '1');
    const { workId, sessionId } = await pending('claude');
    const session = await sessionOf(workId, sessionId);
    session.role = { source: 'claude', name: 'native-reviewer' };
    const roleCatalog = { roles: [{ id: 'claude:native-reviewer', source: 'claude' as const, provider: 'claude' as const, name: 'native-reviewer', description: '', path: '/fixture/native-reviewer.md', nativeAgent: 'native-reviewer', readOnly: false }], diagnostics: [], partial: false };
    session.providerSessionId = 'c0ffee00-1111-2222-3333-444455556666';
    await claudeTranscript(session.providerSessionId);
    for (const planner of [planNew, planResume]) {
      const plan = await planner(project, workId, session, { roleCatalog });
      expect(plan.args[plan.args.indexOf('--agent') + 1]).toBe('native-reviewer');
      expect(plan.args.join(' ')).not.toContain('find_skill');
      expect(plan.warnings.join(' ')).toContain('full native skill list');
      expect(plan.env).not.toHaveProperty('SLASH_COMMAND_TOOL_CHAR_BUDGET');
    }
  });
});

/** Значение пары `-c <ключ>=…` в аргументах Codex, если она есть. */
const codexConfigValues = (args: string[]): string[] =>
  args.flatMap((arg, index) => (args[index - 1] === '-c' ? [arg] : []));
const SKILL_FLAG = 'skills.include_instructions=false';
/** Каталог, который «прочитал» шов `codexSkillRoute.catalog`: состав навыков Codex подтверждён. */
const codexCatalog: SkillCatalog = { provider: 'codex', skills: [], diagnostics: [], partial: false };

describe('сокращение родного списка скиллов вместе с навигатором', () => {
  it.each([['claude', 'planNew'], ['claude', 'planResume'], ['codex', 'planNew'], ['codex', 'planResume']] as const)(
    '%s %s при выключенном навигаторе: ни переменной, ни флага, ни выключения плагинов',
    async (provider, which) => {
      await claudeConfig([{}]);
      claudeSkillRoute.catalogReady = true;
      setEnv('PARLEY_SKILL_NAVIGATOR', '0');
      const { workId, sessionId } = await pending(provider);
      const session = { ...(await sessionOf(workId, sessionId)), providerSessionId: 'c0ffee00-1111-2222-3333-444455556666' };
      if (provider === 'claude') await claudeTranscript(session.providerSessionId);
      const plan = await (which === 'planNew' ? planNew : planResume)(project, workId, session);
      expect(plan.env).not.toHaveProperty('SLASH_COMMAND_TOOL_CHAR_BUDGET');
      expect(plan.env).not.toHaveProperty('PARLEY_SKILL_LIST_REDUCED');
      expect(plan.env).not.toHaveProperty('HARNAS_SKILL_LIST_REDUCED');
      expect(plan.args.join(' ')).not.toContain('skills.include_instructions');
      expect(plan.args.join(' ')).not.toContain('names only');
      expect(plan.args.join(' ')).not.toContain('find_skill');
      if (provider === 'claude') {
        const settings = await readFile(plan.args[plan.args.indexOf('--settings') + 1]!, 'utf8');
        expect(settings).toBe(workSettingsJson());
        const mcp = JSON.parse(await readFile(path.join(workPaths(project, workId).mcp, `${sessionId}.json`), 'utf8'));
        expect(mcp.mcpServers.parley.env).not.toHaveProperty('PARLEY_SKILL_LIST_REDUCED');
      } else {
        const server = parseTomlAssignment(plan.args.find((arg) => arg.startsWith('mcp_servers.parley='))!).value as { env: Record<string, string> };
        expect(server.env).not.toHaveProperty('PARLEY_SKILL_LIST_REDUCED');
      }
    },
  );

  it.each(['planNew', 'planResume'] as const)('Claude %s: у find_skill нет боевого каталога Claude — список полный, мод jev не трогаем, фразы об именах нет', async (which) => {
    await claudeConfig([{}]);
    claudeSkillRoute.catalogReady = false;
    setEnv('PARLEY_SKILL_NAVIGATOR', '1');
    const { workId, sessionId } = await pending('claude');
    const session = { ...(await sessionOf(workId, sessionId)), providerSessionId: 'c0ffee00-1111-2222-3333-444455556666' };
    await claudeTranscript(session.providerSessionId);
    const plan = await (which === 'planNew' ? planNew : planResume)(project, workId, session, { hookUrl: 'http://127.0.0.1:40001/hooks' });
    expect(plan.env).not.toHaveProperty('SLASH_COMMAND_TOOL_CHAR_BUDGET');
    expect(plan.env).not.toHaveProperty('PARLEY_SKILL_LIST_REDUCED');
    expect(plan.args.join(' ')).not.toContain('names only');
    const settings = JSON.parse(await readFile(plan.args[plan.args.indexOf('--settings') + 1]!, 'utf8'));
    expect(settings).not.toHaveProperty('enabledPlugins');
    expect(plan.warnings.join(' ')).toContain('full native skill list');
  });

  it.each(['planNew', 'planResume'] as const)('Claude %s: budget in the agent env only, jev absent — nothing disabled, hooks intact', async (which) => {
    await claudeConfig();
    claudeSkillRoute.catalogReady = true;
    setEnv('PARLEY_SKILL_NAVIGATOR', '1');
    const { workId, sessionId } = await pending('claude');
    const session = { ...(await sessionOf(workId, sessionId)), providerSessionId: 'c0ffee00-1111-2222-3333-444455556666' };
    await claudeTranscript(session.providerSessionId);
    const plan = await (which === 'planNew' ? planNew : planResume)(project, workId, session);
    expect(plan.env.SLASH_COMMAND_TOOL_CHAR_BUDGET).toBe('1');
    expect(plan.env.HARNAS_SKILL_LIST_REDUCED).toBe('1');
    // The budget is a launch env, not a setting: neither the settings file nor the MCP config carries it.
    const settingsText = await readFile(plan.args[plan.args.indexOf('--settings') + 1]!, 'utf8');
    expect(settingsText).not.toContain('SLASH_COMMAND_TOOL_CHAR_BUDGET');
    expect(JSON.parse(settingsText)).not.toHaveProperty('enabledPlugins');
    expect(settingsText).toBe(workSettingsJson());
    expect(plan.args.join(' ')).toContain('skill list shows names only');
    expect(plan.warnings.join(' ')).not.toContain('full native skill list');
  });

  it.each(['planNew', 'planResume'] as const)('Claude %s: installed jev is disabled by its exact id only in the session file', async (which) => {
    await claudeConfig([{}]);
    claudeSkillRoute.catalogReady = true;
    setEnv('PARLEY_SKILL_NAVIGATOR', '1');
    const { workId, sessionId } = await pending('claude');
    const session = { ...(await sessionOf(workId, sessionId)), providerSessionId: 'c0ffee00-1111-2222-3333-444455556666' };
    await claudeTranscript(session.providerSessionId);
    const plan = await (which === 'planNew' ? planNew : planResume)(project, workId, session, { hookUrl: 'http://127.0.0.1:40001/hooks' });
    const file = plan.args[plan.args.indexOf('--settings') + 1]!;
    expect(file).toBe(path.join(workPaths(project, workId).dir, 'settings', `${sessionId}.json`));
    const settings = JSON.parse(await readFile(file, 'utf8'));
    expect(settings.enabledPlugins).toEqual({ 'jev-skill-suggestion@skills-dir': false });
    // Everything else of the session file is as before: Parley hooks and statusLine are kept.
    delete settings.enabledPlugins;
    expect(settings).toEqual(JSON.parse(workSettingsJson({ hookUrl: 'http://127.0.0.1:40001/hooks' })));
    expect(plan.env.SLASH_COMMAND_TOOL_CHAR_BUDGET).toBe('1');
    expect(plan.env).not.toHaveProperty('CLAUDE_CODE_ENABLE_FUNCTION_HOOKS');
    // The legacy work file and the human's own Claude config stay untouched.
    expect(await exists(path.join(process.env.CLAUDE_CONFIG_DIR!, 'settings.json'))).toBe(false);
  });

  it('Claude: the id comes from the install place — a renamed folder keeps the manifest name, a foreign plugin is left alone', async () => {
    await claudeConfig([{ folder: 'my-copy' }, { name: 'other-plugin', folder: 'other' }]);
    claudeSkillRoute.catalogReady = true;
    setEnv('PARLEY_SKILL_NAVIGATOR', '1');
    const { workId, sessionId } = await pending('claude');
    const plan = await planNew(project, workId, await sessionOf(workId, sessionId));
    const settings = JSON.parse(await readFile(plan.args[plan.args.indexOf('--settings') + 1]!, 'utf8'));
    expect(settings.enabledPlugins).toEqual({ 'jev-skill-suggestion@skills-dir': false });
  });

  it('Claude: jev installed but the runner has no {settingsFile} — it cannot be disabled, so the list stays full', async () => {
    await claudeConfig([{}]);
    claudeSkillRoute.catalogReady = true;
    setEnv('PARLEY_SKILL_NAVIGATOR', '1');
    const { workId, sessionId } = await pending('claude');
    await writeFile(path.join(home, 'providers.json'), JSON.stringify({ claude: { args: ['--mcp-config', '{mcpConfig}', '--append-system-prompt', '{systemPrompt}'] } }));
    const plan = await planNew(project, workId, await sessionOf(workId, sessionId));
    expect(plan.args.join(' ')).toContain('find_skill');
    expect(plan.args.join(' ')).not.toContain('names only');
    expect(plan.env).not.toHaveProperty('SLASH_COMMAND_TOOL_CHAR_BUDGET');
    expect(plan.env).not.toHaveProperty('PARLEY_SKILL_LIST_REDUCED');
    expect(plan.warnings.join(' ')).toContain('full native skill list');
  });

  it('Claude: jev not installed and no {settingsFile} — nothing to disable, the list is reduced', async () => {
    await claudeConfig();
    claudeSkillRoute.catalogReady = true;
    setEnv('PARLEY_SKILL_NAVIGATOR', '1');
    const { workId, sessionId } = await pending('claude');
    await writeFile(path.join(home, 'providers.json'), JSON.stringify({ claude: { args: ['--mcp-config', '{mcpConfig}', '--append-system-prompt', '{systemPrompt}'] } }));
    const plan = await planNew(project, workId, await sessionOf(workId, sessionId));
    expect(plan.env.SLASH_COMMAND_TOOL_CHAR_BUDGET).toBe('1');
  });

  it('Claude: a role without a confirmed Skill route (native agent or native layer) keeps the full list', async () => {
    await claudeConfig();
    claudeSkillRoute.catalogReady = true;
    setEnv('PARLEY_SKILL_NAVIGATOR', '1');
    const { workId, sessionId } = await pending('claude');
    const session = await sessionOf(workId, sessionId);
    const layered = await planNew(project, workId, session, { layer: { nativeClaudeRole: true } });
    expect(layered.env).not.toHaveProperty('SLASH_COMMAND_TOOL_CHAR_BUDGET');
    expect(layered.args.join(' ')).not.toContain('names only');
    expect(layered.warnings.join(' ')).toContain('full native skill list');
    const mcp = JSON.parse(await readFile(path.join(workPaths(project, workId).mcp, `${sessionId}.json`), 'utf8'));
    expect(mcp.mcpServers.parley.env).not.toHaveProperty('PARLEY_SKILL_LIST_REDUCED');
  });

  it.each(['planNew', 'planResume'] as const)('Codex %s: -c skills.include_instructions=false through the template, names promised only now', async (which) => {
    setEnv('PARLEY_SKILL_NAVIGATOR', '1');
    // Состав навыков прочитан у самого Codex (`skills/list`): find_skill отдаёт ровно его, родной список можно убрать.
    const asked: Array<{ cwd: string; command?: string; configArgs?: readonly string[] }> = [];
    codexSkillRoute.catalog = async (options) => { asked.push(options); return codexCatalog; };
    const { workId, sessionId } = await pending('codex');
    const session = { ...(await sessionOf(workId, sessionId)), providerSessionId: 'native-thread' };
    const plan = await (which === 'planNew' ? planNew : planResume)(project, workId, session);
    expect(codexConfigValues(plan.args).filter((value) => value === SKILL_FLAG)).toHaveLength(1);
    expect(plan.args.indexOf(SKILL_FLAG)).toBeGreaterThan(0);
    expect(plan.args[plan.args.indexOf(SKILL_FLAG) - 1]).toBe('-c');
    expect(plan.env.PARLEY_SKILL_LIST_REDUCED).toBe('1');
    const server = parseTomlAssignment(plan.args.find((arg) => arg.startsWith('mcp_servers.parley='))!).value as { env: Record<string, string> };
    expect(server.env.PARLEY_SKILL_LIST_REDUCED).toBe('1');
    expect(server.env.HARNAS_SKILL_LIST_REDUCED).toBe('1');
    const layer = JSON.parse(plan.args.find((arg) => arg.startsWith('developer_instructions='))!.slice('developer_instructions='.length)) as string;
    expect(layer).toContain('no native skill list');
    expect(layer.split('\n').length).toBeLessThanOrEqual(14);
    // The native context for find_skill is read without the flag: the names come from the full inventory.
    expect((await readNativeContext(project, workId, sessionId))?.configArgs).toEqual([]);
    expect(plan.warnings.join(' ')).not.toContain('full native skill list');
    expect(plan.diagnostics?.map((warning) => warning.code)).toEqual([]);
    // Каталог читается по бинарю и аргументам самого запуска, в рабочей папке сессии.
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ command: STUB, configArgs: [] });
    // Тот же каталог сохранён для MCP-сервера сессии, с ревизией этого запуска.
    const revision = (await readNativeContext(project, workId, sessionId))!.revision;
    expect(await readNativeSkillCatalog(project, workId, sessionId, revision)).toEqual(codexCatalog);
    expect(plan.env.PARLEY_NATIVE_CONTEXT_REVISION).toBe(revision);
  });

  it.each(['planNew', 'planResume'] as const)('Codex %s: плагинные и системные навыки в составе Codex не мешают — список убирается, без диагностики', async (which) => {
    setEnv('PARLEY_SKILL_NAVIGATOR', '1');
    const catalog: SkillCatalog = { ...codexCatalog, skills: [
      { provider: 'codex', documentKind: 'skill', name: 'plug:one', description: 'd', source: 'plugin', path: '/p/SKILL.md', modelAvailable: true, unavailableReason: null },
      { provider: 'codex', documentKind: 'skill', name: 'skill-installer', description: 'd', source: 'system', path: '/s/SKILL.md', modelAvailable: true, unavailableReason: null },
    ] };
    codexSkillRoute.catalog = async () => catalog;
    const { workId, sessionId } = await pending('codex');
    const session = { ...(await sessionOf(workId, sessionId)), providerSessionId: 'native-thread' };
    const plan = await (which === 'planNew' ? planNew : planResume)(project, workId, session);
    expect(codexConfigValues(plan.args)).toContain(SKILL_FLAG);
    expect(plan.env.PARLEY_SKILL_LIST_REDUCED).toBe('1');
    expect(plan.diagnostics?.map((warning) => warning.code)).toEqual([]);
    expect(plan.warnings.join(' ')).not.toContain('native skill list');
    // Плагинные и системные навыки сохранены в каталоге сессии вместе с остальными.
    const revision = (await readNativeContext(project, workId, sessionId))!.revision;
    expect(await readNativeSkillCatalog(project, workId, sessionId, revision)).toEqual(catalog);
  });

  it('Codex: каталог не прочитался (skills/list не ответил) — список остаётся, без диагностики, с общим предупреждением', async () => {
    setEnv('PARLEY_SKILL_NAVIGATOR', '1');
    codexSkillRoute.catalog = async () => null;
    const { workId, sessionId } = await pending('codex');
    const plan = await planNew(project, workId, await sessionOf(workId, sessionId));
    expect(plan.args.join(' ')).not.toContain('skills.include_instructions');
    expect(plan.env).not.toHaveProperty('PARLEY_SKILL_LIST_REDUCED');
    expect(plan.diagnostics?.map((warning) => warning.code)).toEqual([]);
    expect(plan.warnings.join(' ')).toContain('full native skill list');
    // Нечего сохранять: файла каталога нет.
    const revision = (await readNativeContext(project, workId, sessionId))!.revision;
    expect(await readNativeSkillCatalog(project, workId, sessionId, revision)).toBeNull();
  });

  it('Codex: каталог прочитан, но не сохранился — список остаётся, с общим предупреждением', async () => {
    setEnv('PARLEY_SKILL_NAVIGATOR', '1');
    const { workId, sessionId } = await pending('codex');
    // Место файла каталога занято папкой: запись упирается в `rename`, а дескриптор уже записан.
    codexSkillRoute.catalog = async () => {
      await mkdir(path.join(project, '.parley/local/native-context', workId, `${sessionId}.skills.json`));
      return codexCatalog;
    };
    const plan = await planNew(project, workId, await sessionOf(workId, sessionId));
    expect(plan.args.join(' ')).not.toContain('skills.include_instructions');
    expect(plan.env).not.toHaveProperty('PARLEY_SKILL_LIST_REDUCED');
    expect(plan.diagnostics?.map((warning) => warning.code)).toEqual([]);
    expect(plan.warnings.join(' ')).toContain('full native skill list');
    const revision = (await readNativeContext(project, workId, sessionId))!.revision;
    expect(await readNativeSkillCatalog(project, workId, sessionId, revision)).toBeNull();
    // Дескриптор подтверждён, и MCP-серверу остаётся прежнее живое чтение.
    expect((await readNativeContext(project, workId, sessionId))?.verified).toBe(true);
  });

  it('Codex: настоящее чтение каталога у заглушки, не знающей app-server, — непрочитано, список остаётся', async () => {
    setEnv('PARLEY_SKILL_NAVIGATOR', '1');
    const { workId, sessionId } = await pending('codex');
    const plan = await planNew(project, workId, await sessionOf(workId, sessionId));
    expect(plan.args.join(' ')).not.toContain('skills.include_instructions');
    expect(plan.warnings.join(' ')).toContain('full native skill list');
  }, 20_000);

  it('Codex: a custom runner without {skillCatalog} keeps the list full and gets provider-override-gap', async () => {
    setEnv('PARLEY_SKILL_NAVIGATOR', '1');
    const { workId, sessionId } = await pending('codex');
    // Same shape as the human's real override: own model and effort, {mcpConfig}, the prompt — no Parley placeholders besides it.
    await writeFile(path.join(home, 'providers.json'), JSON.stringify({ codex: {
      args: ['--model', 'm', '-c', '{mcpConfig}', '-c', '{developerInstructions}', '{prompt}'],
      resumeArgs: ['resume', '{providerSessionId}', '-c', '{mcpConfig}', '-c', '{developerInstructions}', '{prompt}'],
    } }));
    for (const planner of [planNew, planResume]) {
      const plan = await planner(project, workId, { ...(await sessionOf(workId, sessionId)), providerSessionId: 'native-thread' });
      expect(plan.args.join(' ')).not.toContain('skills.include_instructions');
      expect(plan.env).not.toHaveProperty('PARLEY_SKILL_LIST_REDUCED');
      expect(plan.diagnostics?.map((warning) => warning.code)).toEqual(['provider-override-gap']);
      expect(plan.diagnostics?.[0]?.message).toContain('{skillCatalog}');
      const layer = JSON.parse(plan.args.find((arg) => arg.startsWith('developer_instructions='))!.slice('developer_instructions='.length)) as string;
      expect(layer).toContain('find_skill — skills by task, if needed.');
      expect(layer).not.toContain('no native skill list');
    }
  });

  it('Codex: a runner the context cannot verify gets no flag and the generic warning', async () => {
    setEnv('PARLEY_SKILL_NAVIGATOR', '1');
    const { workId, sessionId } = await pending('codex');
    await writeFile(path.join(home, 'providers.json'), JSON.stringify({ codex: {
      args: ['--profile', 'mine', '-c', '{mcpConfig}', '-c', '{developerInstructions}', '-c', '{skillCatalog}', '{prompt}'],
    } }));
    const plan = await planNew(project, workId, await sessionOf(workId, sessionId));
    expect(plan.args.join(' ')).not.toContain('skills.include_instructions');
    expect(plan.diagnostics?.map((warning) => warning.code)).toEqual([]);
    expect(plan.warnings.join(' ')).toContain('full native skill list');
  });

  it('Codex without {mcpConfig} has no find_skill, so its list is not reduced', async () => {
    setEnv('PARLEY_SKILL_NAVIGATOR', '1');
    const { workId, sessionId } = await pending('codex');
    await writeFile(path.join(home, 'providers.json'), JSON.stringify({ codex: {
      args: ['-c', '{developerInstructions}', '-c', '{skillCatalog}', '{prompt}'],
    } }));
    const plan = await planNew(project, workId, await sessionOf(workId, sessionId));
    expect(plan.args.join(' ')).not.toContain('skills.include_instructions');
  });
});

describe('навигатор включён по умолчанию', () => {
  it.each(['claude', 'codex', 'glm'])('%s: без явного включения запуск несёт навигатор, PARLEY_SKILL_NAVIGATOR=0 его выключает', async (provider) => {
    codexSkillRoute.catalog = async () => codexCatalog;
    await claudeConfig();
    // GLM читает настоящий `~/.claude` хозяина: подменяем дом, чтобы там не оказалось мода jev.
    setEnv('HOME', path.join(home, 'empty-home'));
    setEnv('PARLEY_SKILL_NAVIGATOR', undefined);
    const { workId, sessionId } = await pending(provider);
    const on = await planNew(project, workId, await sessionOf(workId, sessionId));
    expect(on.env.PARLEY_SKILL_NAVIGATOR).toBe('1');
    expect(on.args.join(' ')).toContain('find_skill');
    setEnv('PARLEY_SKILL_NAVIGATOR', '0');
    const off = await planNew(project, workId, await sessionOf(workId, sessionId));
    expect(off.env.PARLEY_SKILL_NAVIGATOR).toBe('0');
    expect(off.args.join(' ')).not.toContain('find_skill');
    expect(off.args.join(' ')).not.toContain('skills.include_instructions');
    expect(off.env).not.toHaveProperty('SLASH_COMMAND_TOOL_CHAR_BUDGET');
  });

  it('настройка skillNavigator=false в config.json выключает навигатор, если переменных нет', async () => {
    setEnv('PARLEY_SKILL_NAVIGATOR', undefined);
    await writeFile(path.join(home, 'config.json'), JSON.stringify({ skillNavigator: false }));
    const { workId, sessionId } = await pending('claude');
    const plan = await planNew(project, workId, await sessionOf(workId, sessionId));
    expect(plan.env.PARLEY_SKILL_NAVIGATOR).toBe('0');
    expect(plan.args.join(' ')).not.toContain('find_skill');
  });
});

const exists = async (file: string): Promise<boolean> => stat(file).then(() => true, () => false);

describe('fresh canonical project memory on session assembly', () => {
  const codexLayer = (args: string[]): string => {
    const arg = args.find((value) => value.startsWith('developer_instructions='));
    if (arg === undefined) throw new Error('developer layer missing');
    return JSON.parse(arg.slice('developer_instructions='.length)) as string;
  };
  it('new/launch/resume read main project facts last, not the participant worktree copy or details', async () => {
    const { workId, sessionId } = await pending('codex'); const session = await sessionOf(workId, sessionId);
    const cwd = path.join(project, 'memory-branch'); await mkdir(cwd); await mkdir(path.join(cwd, '.parley'));
    await writeFile(path.join(cwd, '.parley', 'memory.md'), '## Facts\n- BRANCH PRIVATE <!-- m-999 -->\n');
    await writeFile(path.join(project, '.parley', 'memory.md'), '## Facts\n- Main old <!-- m-001 · human -->\n  PRIVATE DETAIL\n');
    session.worktree = { path: cwd, branch: 'memory/test', base: 'main', createdAt: null };
    const first = codexLayer((await planNew(project, workId, session)).args);
    expect(first).toContain('Main old'); expect(first).not.toContain('PRIVATE');
    await writeFile(path.join(project, '.parley', 'memory.md'), '## Facts\n- Main current <!-- m-001 · human -->\n');
    for (const plan of [await planLaunch(project, workId, session), await planResume(project, workId, { ...session, providerSessionId: 'memory-thread' })]) {
      const layer = codexLayer(plan.args); expect(plan.cwd).toBe(cwd); expect(layer).toContain('Main current'); expect(layer).not.toContain('Main old');
      expect(layer.endsWith('Main current')).toBe(true); expect(layer).not.toContain('BRANCH PRIVATE');
    }
  });
  it('missing memory is quiet, conflict memory is omitted with fixed diagnostic, oversized phrases are marked', async () => {
    const { workId, sessionId } = await pending('codex'); const session = await sessionOf(workId, sessionId);
    const empty = await planLaunch(project, workId, session); expect(empty.diagnostics?.some(row => row.code === 'memory-unreadable')).toBe(false);
    await writeFile(path.join(project, '.parley', 'memory.md'), '## Facts\n<<<<<<< PRIVATE CONFLICT\n');
    const unsafe = await planResume(project, workId, { ...session, providerSessionId: 'memory-thread' });
    expect(unsafe.diagnostics?.filter(row => row.code === 'memory-unreadable')).toHaveLength(1); expect(codexLayer(unsafe.args)).not.toContain('PRIVATE CONFLICT');
    await writeFile(path.join(project, '.parley', 'memory.md'), '## Facts\n' + Array.from({ length: 50 }, (_, n) => `- ${'界'.repeat(200)} ${n} <!-- m-${String(n + 1).padStart(3, '0')} -->\n`).join(''));
    const large = await planLaunch(project, workId, session); expect(large.diagnostics?.filter(row => row.code === 'memory-truncated')).toHaveLength(1);
    expect(codexLayer(large.args)).toContain('[Project memory is cut at 12 KiB');
  });
});

describe('ограниченный стартовый контекст (P34)', () => {
  const codexLayer = (args: string[]): string => {
    const arg = args.find((value) => value.startsWith('developer_instructions='));
    if (arg === undefined) throw new Error('developer layer missing');
    return JSON.parse(arg.slice('developer_instructions='.length)) as string;
  };
  const count = (text: string, part: string): number => text.split(part).length - 1;

  it('цель стоит один раз: в брифе, который уходит тем же запуском, а не ещё и во вставке', async () => {
    const { workId, sessionId } = await pending('codex');
    const session = await sessionOf(workId, sessionId);
    // Обычная сессия: бриф первым сообщением, во вставке цели нет.
    const launch = await planLaunch(project, workId, session);
    expect(codexLayer(launch.args)).not.toContain('логин по e-mail');
    expect(launch.args.at(-1)).toContain('Goal: логин по e-mail');

    // Тихий ребёнок: бриф в слое, цель в нём одна.
    const { session: child } = await createChildSession(project, workId, sessionId);
    child.provider = 'codex';
    expect(count(codexLayer((await planLaunch(project, workId, child)).args), 'логин по e-mail')).toBe(1);

    // Быстрая сессия без брифа: цель только во вставке, иначе её нет нигде.
    const quick = await createNewSession(project, workId);
    quick.session.provider = 'codex';
    expect(count(codexLayer((await planNew(project, workId, quick.session)).args), 'логин по e-mail')).toBe(1);
  });

  it('разные id сессий не меняют стабильную политику в начале слоя', async () => {
    const { workId, sessionId } = await pending('codex');
    const { session: child } = await createChildSession(project, workId, sessionId);
    child.provider = 'codex';
    const first = codexLayer((await planLaunch(project, workId, await sessionOf(workId, sessionId))).args);
    const second = codexLayer((await planLaunch(project, workId, child)).args);
    const stable = (text: string): string => text.split('\n').slice(0, 13).join('\n');
    expect(stable(first)).toBe(stable(second));
    expect(stable(first)).not.toContain('your session is');
    expect(first.split('\n')[13]).toContain(`your session is ${sessionId}`);
    expect(second.split('\n')[13]).toContain(`your session is ${child.id}`);
  });

  it('цель в 100 тыс. знаков не раздувает ни вставку, ни бриф: ссылка, размер и хеш', async () => {
    const created = await createWork(project, { title: 'Авторизация', goal: 'ж'.repeat(100_000) });
    const workId = created.work.id;
    const sessionId = await createPendingSession(project, workId, { provider: 'codex', label: 'тесты', task: 'прогнать' });
    const { session: child } = await createChildSession(project, workId, sessionId);
    child.provider = 'codex';
    const launch = await planLaunch(project, workId, await sessionOf(workId, sessionId));
    const quiet = await planLaunch(project, workId, child);
    for (const text of [launch.args.at(-1) ?? '', codexLayer(quiet.args)]) {
      expect(text).toContain('goal is 200000 bytes');
      expect(text).not.toContain('жжжж');
    }
    expect(Buffer.byteLength(codexLayer(quiet.args), 'utf8')).toBeLessThan(40_000);
  });

  it('возобновление: бриф не менялся — указатель на письма уходит как был, без нового подбора скилла', async () => {
    const { workId, sessionId } = await pending('codex');
    const session = { ...(await sessionOf(workId, sessionId)), providerSessionId: 'codex-thread' };
    const plan = await planResume(project, workId, session, { prompt: 'INBOX POINTER' });
    expect(plan.args.at(-1)).toBe('INBOX POINTER');
    expect(plan.args.at(-1)).not.toContain('find_skill');
    expect(plan.args.join(' ')).not.toContain('Your brief changed');
  });

  it('возобновление: задача изменилась — одна строка о новой ревизии перед указателем, файл обновлён, второй подъём тих', async () => {
    const { workId, sessionId } = await pending('codex');
    const file = path.join(workPaths(project, workId).briefs, `${sessionId}.md`);
    const before = await readFile(file, 'utf8');
    await updateMap(project, workId, (map) => { map.sessions[0]!.task = 'новая задача'; });
    const session = { ...(await sessionOf(workId, sessionId)), providerSessionId: 'codex-thread' };

    const first = await planResume(project, workId, session, { prompt: 'INBOX POINTER' });
    const prompt = first.args.at(-1) ?? '';
    expect(prompt).toMatch(/^Your brief changed \(revision [0-9a-f]{12} is outdated\)[^\n]*get_map[^\n]*\n\nINBOX POINTER$/);
    expect(prompt).not.toContain('новая задача');
    expect(await readFile(file, 'utf8')).toContain('новая задача');
    expect(await readFile(file, 'utf8')).not.toBe(before);

    expect((await planResume(project, workId, session, { prompt: 'INBOX POINTER' })).args.at(-1)).toBe('INBOX POINTER');
  });

  it('тихая сессия при возобновлении получает свежий бриф в слое, а не отдельную строку', async () => {
    const { workId, sessionId } = await pending('codex');
    await updateMap(project, workId, (map) => { map.sessions[0]!.summary = 'OLD SUMMARY'; });
    const { session: child } = await createChildSession(project, workId, sessionId);
    child.provider = 'codex';
    await updateMap(project, workId, (map) => { map.sessions[0]!.summary = 'NEW SUMMARY'; });
    const plan = await planResume(project, workId, { ...child, providerSessionId: 'codex-thread' });
    expect(codexLayer(plan.args)).toContain('NEW SUMMARY');
    expect(codexLayer(plan.args)).not.toContain('OLD SUMMARY');
    expect(plan.args.join(' ')).not.toContain('Your brief changed');
  });

  it('разросшийся руками бриф — отказ запуска, а не обрезание', async () => {
    const { workId, sessionId } = await pending('codex');
    const file = path.join(workPaths(project, workId).briefs, `${sessionId}.md`);
    await writeFile(file, `${await readFile(file, 'utf8')}${'я'.repeat(40_000)}`, 'utf8');
    await expect(planLaunch(project, workId, await sessionOf(workId, sessionId))).rejects.toThrow(/context-budget-exceeded/);
  });
});

describe('GLM launch plans', () => {
  it('uses separate settings, nonsensitive routing and no channels', async () => {
    const { workId, sessionId } = await pending('glm');
    const plan = await planLaunch(project, workId, await sessionOf(workId, sessionId), {
      channel: true,
      hookUrl: 'http://127.0.0.1:53123/hooks',
      model: 'glm-5.3-flash[1m]',
    });
    expect(plan.command).toBe('claude');
    expect(plan.args).toContain('--session-id');
    expect(plan.args).toContain('--mcp-config');
    expect(plan.args).not.toContain('--dangerously-load-development-channels');
    expect(plan.warnings).toEqual([]);
    expect(plan.env).toMatchObject({
      ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-5.3[1m]',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-5.3[1m]',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'glm-5.3-flash[1m]',
    });
    expect(plan.env).not.toHaveProperty('ANTHROPIC_AUTH_TOKEN');
    const file = plan.args[plan.args.indexOf('--settings') + 1]!;
    expect(path.basename(file)).toBe('settings-glm.json');
    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ model: 'glm-5.3-flash[1m]' });
    await expect(stat(workPaths(project, workId).settings)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it.each([undefined, 'glm-5.3-flash[1m]'])(
    'native resume starts with configured model %s',
    async (model) => {
      const { workId, sessionId } = await pending('glm');
      const session = await sessionOf(workId, sessionId);
      session.providerSessionId = 'glm-conversation';
      if (model !== undefined) session.model = model;
      const dir = path.join(logs, 'project');
      await mkdir(dir, { recursive: true });
      // A prior Chat /model choice does not replace the configured Parley launch model.
      await writeFile(
        path.join(dir, 'glm-conversation.jsonl'),
        JSON.stringify({ type: 'assistant', message: { model: 'glm-5.3-flash[1m]' } }),
      );
      const plan = await planResume(project, workId, session);
      expect(plan.args.slice(0, 2)).toEqual(['--resume', 'glm-conversation']);
      expect(plan.args[plan.args.indexOf('--model') + 1]).toBe(model ?? 'glm-5.3[1m]');
      const settings = JSON.parse(
        await readFile(plan.args[plan.args.indexOf('--settings') + 1]!, 'utf8'),
      );
      expect(settings.model).toBe(model ?? 'glm-5.3[1m]');
    },
  );

  it('GLM: resume несёт записанный effort сразу за моделью; без записи пара --effort выпадает', async () => {
    const { workId, sessionId } = await pending('glm');
    const session = await sessionOf(workId, sessionId);
    session.providerSessionId = 'glm-conversation';
    const dir = path.join(logs, 'project');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'glm-conversation.jsonl'), '{"type":"user"}\n');

    expect((await planResume(project, workId, session)).args).not.toContain('--effort');

    session.effort = 'max';
    const plan = await planResume(project, workId, session);
    expect(plan.args.slice(0, 2)).toEqual(['--resume', 'glm-conversation']);
    expect(plan.args[plan.args.indexOf('--effort') + 1]).toBe('max');
    expect(plan.args.indexOf('--effort')).toBe(plan.args.indexOf('--model') + 2);
  });

  it('missing GLM transcript starts again with the assigned id', async () => {
    const { workId, sessionId } = await pending('glm');
    const session = await sessionOf(workId, sessionId);
    session.providerSessionId = 'glm-conversation';
    const plan = await planResume(project, workId, session);
    expect(plan.args).not.toContain('--resume');
    expect(plan.args[plan.args.indexOf('--session-id') + 1]).toBe('glm-conversation');
    expect(plan.providerSessionId).toBe('glm-conversation');
  });
});
