import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, readlink, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { stopApp } from './stop-app.js';
import { stopHost } from './stop-host.js';
import { makeTempHome, makeTempProject } from './tmp.js';

/**
 * Сквозная офлайн-проверка апгрейда Parley (P32a, этап 11 единого плана): матрица приёмки на настоящем хосте и окне Electron,
 * но без платных моделей. Вместо `claude` и `codex` — заглушки `stub-echo-agent.mjs` и `stub-codex-agent.mjs`; они пишут в
 * файлы теста свой argv и окружение (`STUB_ARGV_LOG`) и результаты вызовов настоящего `parley-mcp` (`STUB_MCP_LOG`), поэтому
 * тест видит ровно то, что хост передал агенту: флаги, системный слой, переменные навигатора, файл `--settings`, конфиг MCP.
 *
 * Дом человека подменён: `HOME`, `CLAUDE_CONFIG_DIR` и `CODEX_HOME` указывают в каталог теста. В нём лежат скиллы, настройки и
 * конфиги «человека»; в конце каждого теста их побайтный слепок обязан совпасть с исходным (рамка: Parley в `~/.claude`,
 * `~/.codex`, `~/.agents`, `~/.claude.json` не пишет). Каталог скиллов Claude — вложение `skill_listing` в транскрипте: тест
 * кладёт его в `PARLEY_CLAUDE_PROJECTS_DIR`, как это делает сам Claude Code.
 *
 * Чего здесь нет и быть не может: выбор скилла моделью, экономия токенов, разметка человека, настоящий `codex skills/list`
 * и хуки настоящего Claude Code. Это живые проверки (`docs/research/2026-10-03-parley-integration-spike.md`).
 */

const dirname = path.dirname(fileURLToPath(import.meta.url));
const mainEntry = path.resolve(dirname, '../out/main/index.js');
const stubClaude = path.resolve(dirname, 'stub-echo-agent.mjs');
const stubCodex = path.resolve(dirname, 'stub-codex-agent.mjs');
const run = promisify(execFile);

/** Метки, по которым тест узнаёт содержимое чужих файлов там, где оно не должно оказаться. */
const SKILL_BODY = 'BODY_CANARY_7F3A';
const SESSION_LAYER_HEAD = 'You are inside Parley';
const BUDGET_UNVERIFIED = 'Skill navigator availability is unverified for this launch; the full native skill list remains enabled.';

type Parley = { parley: { call: (m: string, p: unknown) => Promise<unknown>; notify: (m: string, p: unknown) => void } };

async function call<T>(window: Page, method: string, params: unknown): Promise<T> {
  return window.evaluate(([m, p]) => (globalThis as unknown as Parley).parley.call(m, p), [method, params] as const) as Promise<T>;
}

const git = async (dir: string, ...args: string[]): Promise<string> => (await run('git', ['-C', dir, ...args])).stdout;

async function initRepo(dir: string): Promise<void> {
  await run('git', ['init', '-b', 'main', dir]);
  await git(dir, 'config', 'user.email', 'e2e@parley');
  await git(dir, 'config', 'user.name', 'e2e');
  await writeFile(path.join(dir, 'README.md'), 'старт\n', 'utf8');
  await writeFile(path.join(dir, 'PARLEY.md'), 'RULES COMMITTED\n', 'utf8');
  await git(dir, 'add', 'README.md', 'PARLEY.md');
  await git(dir, 'commit', '-m', 'первый');
}

async function put(file: string, text: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text, 'utf8');
}

const skillMd = (name: string, description: string, extra = ''): string => `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n${extra}---\n${SKILL_BODY}_${name}\n`;

/** Слепок файлов и каталогов побайтно: путь, вид, хеш содержимого или цель ссылки. */
async function digest(target: string): Promise<string[]> {
  const lines: string[] = [];
  async function walk(item: string): Promise<void> {
    let info;
    try {
      info = await lstat(item);
    } catch {
      lines.push(`${item} missing`);
      return;
    }
    if (info.isSymbolicLink()) lines.push(`${item} link ${await readlink(item)}`);
    else if (info.isDirectory()) {
      lines.push(`${item} dir`);
      for (const entry of (await readdir(item)).sort()) await walk(path.join(item, entry));
    } else lines.push(`${item} file ${createHash('sha256').update(await readFile(item)).digest('hex')}`);
  }
  await walk(target);
  return lines;
}

interface Launch {
  argv: string[];
  env: Record<string, string>;
  cwd: string;
}

interface McpResult {
  session: string;
  tool: string;
  isError: boolean;
  text: string;
}

const flagValue = (argv: readonly string[], flag: string): string | undefined => {
  const at = argv.indexOf(flag);
  return at === -1 ? undefined : argv[at + 1];
};

/** Значения всех `-c` Codex в порядке argv. */
const codexConfigs = (argv: readonly string[]): string[] => argv.flatMap((arg, index) => (argv[index - 1] === '-c' ? [arg] : []));
const codexConfig = (argv: readonly string[], key: string): string | undefined => codexConfigs(argv).find((value) => value.startsWith(`${key}=`));

/** Системный слой запуска: у Claude — `--append-system-prompt`, у Codex — `developer_instructions` (JSON-строка TOML). */
function layerOf(launch: Launch): string {
  const claude = flagValue(launch.argv, '--append-system-prompt');
  if (claude !== undefined) return claude;
  const codex = codexConfig(launch.argv, 'developer_instructions');
  return codex === undefined ? '' : (JSON.parse(codex.slice('developer_instructions='.length)) as string);
}

test.describe('сквозная проверка апгрейда Parley, офлайн (P32a)', () => {
  let home: string;
  let base: string;
  let project: string;
  let userHome: string;
  let projects: string;
  let argvLog: string;
  let mcpLog: string;
  let app: ElectronApplication | null = null;
  let window: Page;
  let frameBefore: string[] = [];

  /** Что у «человека» лежит в конфигах агентов: Parley обязан оставить это побайтно как есть. */
  const frameTargets = (): string[] => [
    path.join(userHome, '.claude'),
    path.join(userHome, '.claude.json'),
    path.join(userHome, '.codex'),
    path.join(userHome, '.agents'),
  ];
  const frameDigest = async (): Promise<string[]> => (await Promise.all(frameTargets().map(digest))).flat();

  test.beforeEach(async () => {
    home = await makeTempHome('integration');
    base = await makeTempProject('integration');
    project = path.join(base, 'shop');
    userHome = path.join(base, 'user');
    projects = path.join(base, 'claude-projects');
    argvLog = path.join(base, 'argv.jsonl');
    mcpLog = path.join(base, 'mcp.jsonl');
    await mkdir(project, { recursive: true });
    await mkdir(projects, { recursive: true });
    // «Человек»: настройки с выключенным им скиллом, личные скиллы, мод jev, конфиги обоих CLI.
    await put(path.join(userHome, '.claude', 'settings.json'), `${JSON.stringify({ skillOverrides: { 'hidden-by-human': 'off' } })}\n`);
    await put(path.join(userHome, '.claude.json'), '{"projects":{}}\n');
    await put(path.join(userHome, '.claude', 'skills', 'deploy-check', 'SKILL.md'), skillMd('deploy-check', 'Check deployment readiness before a release: rollback plan, canary rollout and smoke tests.'));
    await put(path.join(userHome, '.claude', 'skills', 'hidden-by-human', 'SKILL.md'), skillMd('hidden-by-human', 'Secret rollout rehearsal runbook for the quarterly outage drill.'));
    await put(path.join(userHome, '.claude', 'skills', 'jev-skill-suggestion', '.claude-plugin', 'plugin.json'), '{"name":"jev-skill-suggestion"}\n');
    await put(path.join(userHome, '.codex', 'config.toml'), 'model = "stub"\n');
    await put(path.join(userHome, '.agents', 'skills', 'personal-note', 'SKILL.md'), skillMd('personal-note', 'Keep personal notes.'));
    await put(path.join(project, '.claude', 'skills', 'project-lint', 'SKILL.md'), skillMd('project-lint', 'Lint the storefront templates and fix accessibility warnings.'));
    frameBefore = await frameDigest();
    // Слепок не пуст: сравнение в конце теста что-то да сторожит.
    expect(frameBefore.length).toBeGreaterThan(10);
  });

  test.afterEach(async () => {
    await stopApp(app);
    app = null;
    await stopHost(home);
    await rm(home, { recursive: true, force: true });
    await rm(base, { recursive: true, force: true });
  });

  async function openApp(extraEnv: Record<string, string> = {}): Promise<void> {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      // Настройки навигатора и скиллов задаёт тест через `settings.set`, а не окружение разработчика.
      if (value !== undefined && !/^(PARLEY|HARNAS)_(SKILL_NAVIGATOR|AGENT_SKILLS)$/.test(key)) env[key] = value;
    }
    Object.assign(env, {
      PARLEY_HOME: home,
      PARLEY_CLAUDE_BIN: stubClaude,
      PARLEY_CODEX_BIN: stubCodex,
      PARLEY_CLAUDE_PROJECTS_DIR: projects,
      PARLEY_WORKTREE_ROOT: path.join(base, 'worktrees'),
      PARLEY_TERMINAL_RENDERER: 'dom',
      HOME: userHome,
      CLAUDE_CONFIG_DIR: path.join(userHome, '.claude'),
      CODEX_HOME: path.join(userHome, '.codex'),
      STUB_ARGV_LOG: argvLog,
      STUB_MCP_LOG: mcpLog,
      ...extraEnv,
    });
    app = await electron.launch({ args: [mainEntry], env });
    window = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, width: 1400, height: 900 }));
    await expect(window.getByTestId('landing')).toBeVisible();
    // Уведомления хоста копятся в странице: по ним тест видит ровно то, что получил бы человек.
    await window.evaluate(() => {
      const target = globalThis as unknown as { __notices: unknown[]; parley: { on: (e: string, f: (d: unknown) => void) => void } };
      target.__notices = [];
      target.parley.on('host.notice', (notice) => target.__notices.push(notice));
    });
    // Будильник печатал бы в терминал заглушки указатели на письма, склеиваясь со строками вызовов.
    await call(window, 'wake.pause', {});
  }

  const setting = (key: string, value: boolean): Promise<unknown> => call(window, 'settings.set', { key, value: String(value) });

  async function newWork(title = 'integration'): Promise<string> {
    return (await call<{ workId: string }>(window, 'works.create', { projectPath: project, title, goal: 'Ship it' })).workId;
  }

  interface SessionOptions {
    provider?: 'claude' | 'codex';
    task?: string;
    worktree?: boolean;
    agent?: string;
    role?: { source: 'builtin' | 'claude' | 'codex'; name: string };
    projectPath?: string;
  }

  async function newSession(workId: string, options: SessionOptions = {}): Promise<string> {
    const { ref } = await call<{ ref: { sessionId: string } }>(window, 'sessions.create', {
      projectPath: options.projectPath ?? project,
      workId,
      provider: options.provider ?? 'claude',
      label: 'agent',
      task: options.task ?? '',
      parent: null,
      ...(options.worktree ? { worktree: true } : {}),
      ...(options.agent ? { agent: options.agent } : {}),
      ...(options.role ? { role: options.role } : {}),
    });
    return ref.sessionId;
  }

  async function readLines<T>(file: string): Promise<T[]> {
    return (await readFile(file, 'utf8').catch(() => ''))
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as T);
  }

  /** Запуски одной сессии в порядке argv-журнала; ждёт, пока их станет хотя бы `count`. */
  async function launches(sessionId: string, count = 1): Promise<Launch[]> {
    await expect
      .poll(async () => (await readLines<Launch>(argvLog)).filter((launch) => launch.env['PARLEY_SESSION_ID'] === sessionId).length, { timeout: 20_000 })
      .toBeGreaterThanOrEqual(count);
    return (await readLines<Launch>(argvLog)).filter((launch) => launch.env['PARLEY_SESSION_ID'] === sessionId);
  }

  const lastLaunch = async (sessionId: string, count = 1): Promise<Launch> => (await launches(sessionId, count)).at(-1) as Launch;

  /** Агент зовёт инструмент настоящего `parley-mcp`: строка `STUB_MCP` в его терминал, результат — из журнала заглушки. */
  async function agentCalls(sessionId: string, workId: string, tool: string, args: unknown = {}): Promise<McpResult> {
    const before = (await readLines<McpResult>(mcpLog)).length;
    await window.evaluate(
      ([ref, line]) => (globalThis as unknown as Parley).parley.notify('pty.input', { ref, data: line }),
      [{ projectPath: project, workId, sessionId }, `STUB_MCP ${tool} ${JSON.stringify(args)}\r`] as const,
    );
    await expect.poll(async () => (await readLines<McpResult>(mcpLog)).length, { timeout: 30_000 }).toBeGreaterThan(before);
    const entry = (await readLines<McpResult>(mcpLog))[before] as McpResult;
    expect(entry.session).toBe(sessionId);
    return entry;
  }

  const json = <T>(result: McpResult): T => JSON.parse(result.text) as T;

  interface Found {
    provider: string;
    skills: Array<{ name: string; description?: string; source: string; load: string }>;
    message?: string;
    reason?: string;
  }

  const toolNames = async (sessionId: string, workId: string): Promise<Array<{ name: string; description: string }>> =>
    json(await agentCalls(sessionId, workId, 'tools/list'));

  /** Транскрипт Claude Code с вложением `skill_listing`: имена, которые он показал модели. */
  async function transcript(launch: Launch, names: string[], isInitial = true): Promise<void> {
    const uuid = flagValue(launch.argv, '--session-id') ?? flagValue(launch.argv, '--resume');
    if (uuid === undefined) throw new Error('у запуска нет id разговора Claude');
    const file = path.join(projects, '-e2e', `${uuid}.jsonl`);
    const listing = { type: 'attachment', attachment: { type: 'skill_listing', content: names.map((name) => `- ${name}`).join('\n'), skillCount: names.length, isInitial, names } };
    await mkdir(path.dirname(file), { recursive: true });
    const existing = await readFile(file, 'utf8').catch(() => `${JSON.stringify({ type: 'user', message: { content: 'hi' } })}\n`);
    await writeFile(file, `${existing}${JSON.stringify(listing)}\n`, 'utf8');
  }

  const notices = (): Promise<Array<{ kind: string; text: string; ref?: unknown }>> =>
    window.evaluate(() => (globalThis as unknown as { __notices: Array<{ kind: string; text: string }> }).__notices);

  const diskMap = async (workId: string, dir = project): Promise<{ sessions: Array<Record<string, unknown>>; rooms: Array<Record<string, unknown>>; plans?: Array<Record<string, unknown>> }> =>
    JSON.parse(await readFile(path.join(dir, '.parley', 'works', workId, 'map.json'), 'utf8')) as { sessions: []; rooms: [] };

  const hostLog = (): Promise<string> => readFile(path.join(home, 'host', 'host.log'), 'utf8').catch(() => '');

  /**
   * Ничего из внутренней кухни запуска не попадает в окно: ни путей конфигов и дома, ни ревизии нативного контекста, ни id
   * разговора CLI, ни тел скиллов, ни имён флагов сокращения списка. Проверяется видимый текст окна, уведомления хоста и
   * снимок работ, который окно получает от хоста.
   */
  async function assertNoLeaks(workId: string): Promise<void> {
    const all = await readLines<Launch>(argvLog);
    const revisions = new Set(all.map((launch) => launch.env['PARLEY_NATIVE_CONTEXT_REVISION']).filter((value): value is string => value !== undefined));
    const providerIds = new Set(
      all.map((launch) => flagValue(launch.argv, '--session-id') ?? flagValue(launch.argv, '--resume')).filter((value): value is string => value !== undefined),
    );
    const internal = [userHome, home, 'native-context', `${path.sep}settings${path.sep}`, `${path.sep}mcp${path.sep}`, SKILL_BODY, 'enabledPlugins', 'jev-skill-suggestion', 'SLASH_COMMAND_TOOL_CHAR_BUDGET', 'skills.include_instructions', ...revisions];
    // Окно нарисовано: работа на месте, иначе проверка молчала бы на пустой странице.
    await expect(window.getByTestId('app-shell')).toBeVisible({ timeout: 15_000 });
    await expect.poll(() => window.evaluate(() => document.body.innerText), { timeout: 15_000 }).toContain('integration');
    const visible = [await window.evaluate(() => document.body.innerText), JSON.stringify(await notices())];
    for (const text of visible) {
      for (const needle of [...internal, ...providerIds]) expect(text, `в окне нашлось «${needle}»`).not.toContain(needle);
    }
    const snapshot = JSON.stringify(await call(window, 'works.list', {}));
    for (const needle of [...internal]) expect(snapshot, `в снимке работ нашлось «${needle}»`).not.toContain(needle);
    // Ровно та же работа жива в окне: проверка не молчит на пустой странице.
    expect(workId).toMatch(/^w-\d+$/);
  }

  async function assertFrame(): Promise<void> {
    expect(await frameDigest(), 'Parley изменил конфиги и скиллы человека в ~/.claude, ~/.codex, ~/.agents или ~/.claude.json').toEqual(frameBefore);
  }

  test('навигатор выключен по умолчанию: нет find_skill, бюджета и отдельного settings; остальное работает независимо', async () => {
    test.setTimeout(90_000);
    await openApp();
    expect(((await call(window, 'settings.get', {})) as { config: { skillNavigator: boolean; agentSkills: boolean } }).config).toMatchObject({ skillNavigator: false, agentSkills: true });
    const workId = await newWork();
    const claude = await newSession(workId);
    const codex = await newSession(workId, { provider: 'codex' });

    const launch = await lastLaunch(claude);
    expect(launch.env['PARLEY_SKILL_NAVIGATOR']).toBe('0');
    expect(launch.env['PARLEY_SKILL_LIST_REDUCED']).toBeUndefined();
    expect(launch.env['SLASH_COMMAND_TOOL_CHAR_BUDGET']).toBeUndefined();
    const work = path.join(project, '.parley', 'works', workId);
    // Выключенный навигатор оставляет прежний путь: один settings.json работы, без файла на сессию и без нативного контекста.
    expect(flagValue(launch.argv, '--settings')).toBe(path.join(work, 'settings.json'));
    await expect(lstat(path.join(work, 'settings'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(path.join(project, '.parley', 'local', 'native-context'))).rejects.toMatchObject({ code: 'ENOENT' });
    const settings = JSON.parse(await readFile(path.join(work, 'settings.json'), 'utf8')) as { hooks: Record<string, unknown>; statusLine: unknown; enabledPlugins?: unknown };
    expect(Object.keys(settings.hooks)).toEqual(expect.arrayContaining(['UserPromptSubmit', 'Stop', 'SessionStart']));
    expect(settings.statusLine).toBeTruthy();
    expect(settings.enabledPlugins).toBeUndefined();
    expect(layerOf(launch)).toContain(SESSION_LAYER_HEAD);
    expect(layerOf(launch)).not.toContain('find_skill');

    // MCP-сервер жив и отвечает, но инструмента навигатора в нём нет, а прямой вызов отказывает с понятным текстом.
    const names = (await toolNames(claude, workId)).map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining(['get_map', 'report', 'read_guide']));
    expect(names).not.toContain('find_skill');
    const refused = await agentCalls(claude, workId, 'find_skill', { query: 'deploy' });
    expect(refused).toMatchObject({ isError: true, text: 'Skill navigator is disabled for this launch.' });
    const map = await agentCalls(claude, workId, 'get_map');
    expect(map.isError).toBe(false);
    expect(map.text).toContain(workId);

    // Codex: ни сокращения каталога, ни подсказки, а сервер получил выключенный снимок.
    const codexLaunch = await lastLaunch(codex);
    expect(codexConfig(codexLaunch.argv, 'skills.include_instructions')).toBeUndefined();
    expect(codexConfig(codexLaunch.argv, 'mcp_servers.parley')).toContain('PARLEY_SKILL_NAVIGATOR="0"');
    expect(codexConfig(codexLaunch.argv, 'mcp_servers.parley')).not.toContain('PARLEY_SKILL_LIST_REDUCED');
    expect(layerOf(codexLaunch)).toContain(SESSION_LAYER_HEAD);
    expect(layerOf(codexLaunch)).not.toContain('find_skill');

    // Скилл `parley` и PARLEY.md к навигатору отношения не имеют: ставятся и при выключенном.
    expect(await readFile(path.join(project, '.agents', 'skills', 'parley', 'SKILL.md'), 'utf8')).toContain('name: parley');
    expect(await readFile(path.join(project, 'PARLEY.md'), 'utf8')).toContain('Team rules for agents');
    await assertNoLeaks(workId);
    await assertFrame();
  });

  test('навигатор включён, agentSkills выключен: короткий список Claude, find_skill находит свои скиллы, спрятанные не показывает', async () => {
    test.setTimeout(120_000);
    await openApp();
    await setting('agentSkills', false);
    const workId = await newWork();
    // Сначала без навигатора: прежний файл работы — эталон хуков и строки статуса.
    const plain = await newSession(workId);
    await lastLaunch(plain);
    const legacy = JSON.parse(await readFile(path.join(project, '.parley', 'works', workId, 'settings.json'), 'utf8')) as { hooks: unknown; statusLine: unknown };

    await setting('skillNavigator', true);
    const claude = await newSession(workId);
    const launch = await lastLaunch(claude);

    expect(launch.env).toMatchObject({ PARLEY_SKILL_NAVIGATOR: '1', PARLEY_SKILL_LIST_REDUCED: '1', SLASH_COMMAND_TOOL_CHAR_BUDGET: '1' });
    // Отдельный файл на сессию: хуки и строка статуса те же, а мод jev выключен ровно по обнаруженному id.
    const perSession = path.join(project, '.parley', 'works', workId, 'settings', `${claude}.json`);
    expect(flagValue(launch.argv, '--settings')).toBe(perSession);
    const perSessionText = await readFile(perSession, 'utf8');
    const settings = JSON.parse(perSessionText) as { hooks: unknown; statusLine: unknown; enabledPlugins?: Record<string, false> };
    expect(settings.hooks).toEqual(legacy.hooks);
    expect(settings.statusLine).toEqual(legacy.statusLine);
    expect(settings.enabledPlugins).toEqual({ 'jev-skill-suggestion@skills-dir': false });
    expect(layerOf(launch)).toContain('find_skill — skills by task (your skill list shows names only).');
    // agentSkills выключен: скилл не ставится, но PARLEY.md и MCP живут.
    await expect(lstat(path.join(project, '.agents'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(path.join(project, 'PARLEY.md'), 'utf8')).toContain('Team rules for agents');

    const tool = (await toolNames(claude, workId)).find((item) => item.name === 'find_skill');
    expect(tool?.description).toContain('names only');

    // Транскрипта ещё нет: честная причина, а не пустой успех.
    const early = json<Found>(await agentCalls(claude, workId, 'find_skill', { query: 'deployment rollback canary' }));
    expect(early.skills).toEqual([]);
    expect(early.reason).toMatch(/transcript|listed skills/i);

    // Claude показал модели три имени; скилл, спрятанный человеком, среди них не значится.
    await transcript(launch, ['deploy-check', 'project-lint', 'parley']);
    const found = json<Found>(await agentCalls(claude, workId, 'find_skill', { query: 'deployment rollback canary' }));
    expect(found.provider).toBe('claude');
    expect(found.skills[0]).toMatchObject({ name: 'deploy-check', source: 'user', load: 'Use the Skill tool with "deploy-check".' });
    expect(found.skills[0]?.description).toContain('rollback plan');
    const hidden = json<Found>(await agentCalls(claude, workId, 'find_skill', { query: 'secret rollout rehearsal outage drill' }));
    expect(hidden.skills.map((skill) => skill.name)).not.toContain('hidden-by-human');
    // Контроль: тот же скилл находится, как только Claude показывает его имя модели другой сессии.
    const sibling = await newSession(workId);
    await transcript(await lastLaunch(sibling), ['hidden-by-human']);
    expect(json<Found>(await agentCalls(sibling, workId, 'find_skill', { query: 'secret rollout rehearsal outage drill' })).skills[0]?.name).toBe('hidden-by-human');
    // Проектный скилл найден по своему слову; тело скилла в ответ не попадает.
    const project1 = await agentCalls(claude, workId, 'find_skill', { query: 'lint storefront accessibility' });
    expect(json<Found>(project1).skills[0]).toMatchObject({ name: 'project-lint', source: 'project' });
    expect(project1.text).not.toContain(SKILL_BODY);

    // Пустые поиски: первый допускает поправку, второй подряд — отказ от поиска до находки.
    const miss1 = json<Found>(await agentCalls(claude, workId, 'find_skill', { query: 'quantum gardening' }));
    expect(miss1.skills).toEqual([]);
    expect(miss1.message).toContain('try other words once');
    expect(json<Found>(await agentCalls(claude, workId, 'find_skill', { query: 'astral cooking' })).message).toContain('do not search for this task any more');
    expect(json<Found>(await agentCalls(claude, workId, 'find_skill', { query: 'deployment' })).skills[0]?.name).toBe('deploy-check');
    expect(json<Found>(await agentCalls(claude, workId, 'find_skill', { query: 'quantum gardening' })).message).toContain('try other words once');

    // Один снимок запуска: переключение настройки не трогает идущую сессию, а новая сессия получает новое значение.
    await setting('skillNavigator', false);
    expect((await toolNames(claude, workId)).map((item) => item.name)).toContain('find_skill');
    const later = await newSession(workId);
    const laterLaunch = await lastLaunch(later);
    expect(laterLaunch.env['PARLEY_SKILL_NAVIGATOR']).toBe('0');
    expect(laterLaunch.env['SLASH_COMMAND_TOOL_CHAR_BUDGET']).toBeUndefined();
    expect(flagValue(laterLaunch.argv, '--settings')).toBe(path.join(project, '.parley', 'works', workId, 'settings.json'));
    expect((await toolNames(later, workId)).map((item) => item.name)).not.toContain('find_skill');
    // Файл настроек идущей сессии новые запуски не переписывают.
    expect(await readFile(perSession, 'utf8')).toBe(perSessionText);

    await assertNoLeaks(workId);
    await assertFrame();
  });

  test('панель Refresh не обновляет индекс идущего MCP; новый запуск видит свежий каталог', async () => {
    test.setTimeout(90_000);
    await openApp();
    await setting('skillNavigator', true);
    const workId = await newWork();
    const claude = await newSession(workId);
    const first = await lastLaunch(claude);
    await transcript(first, ['deploy-check']);
    const initial = await agentCalls(claude, workId, 'find_skill', { query: 'deployment' });
    expect(json<Found>(initial).skills[0]?.name, initial.text).toBe('deploy-check');

    // Появился новый скилл, Claude показал его имя, панель обновлена кнопкой Refresh.
    await put(path.join(project, '.claude', 'skills', 'fresh-skill', 'SKILL.md'), skillMd('fresh-skill', 'Rotate the staging certificates every quarter.'));
    await transcript(first, ['deploy-check', 'fresh-skill'], false);
    await call(window, 'capabilities.refresh', { projectPath: project });
    expect(json<Found>(await agentCalls(claude, workId, 'find_skill', { query: 'rotate staging certificates' })).skills).toEqual([]);

    // Новый запуск того же разговора (возобновление) — новый MCP-процесс и свежий индекс.
    await call(window, 'sessions.stop', { ref: { projectPath: project, workId, sessionId: claude } });
    await call(window, 'sessions.resume', { ref: { projectPath: project, workId, sessionId: claude } });
    const second = await lastLaunch(claude, 2);
    expect(flagValue(second.argv, '--resume')).toBe(flagValue(first.argv, '--session-id'));
    expect(json<Found>(await agentCalls(claude, workId, 'find_skill', { query: 'rotate staging certificates' })).skills[0]?.name).toBe('fresh-skill');
    await assertNoLeaks(workId);
    await assertFrame();
  });

  test('Codex: каталог сокращён вместе с навигатором, найдена и подсказка; чужой путь до CLI — запасной полный список', async () => {
    test.setTimeout(90_000);
    await openApp();
    await setting('skillNavigator', true);
    const workId = await newWork();
    const codex = await newSession(workId, { provider: 'codex' });
    const launch = await lastLaunch(codex);

    expect(codexConfigs(launch.argv)).toContain('skills.include_instructions=false');
    const server = codexConfig(launch.argv, 'mcp_servers.parley') ?? '';
    expect(server).toContain('PARLEY_SKILL_NAVIGATOR="1"');
    expect(server).toContain('PARLEY_SKILL_LIST_REDUCED="1"');
    expect(layerOf(launch)).toContain("find_skill — skills by task (no native skill list: the tool's description names yours).");
    // Нативный контекст лежит локально и не в git; запуск не записал ничего в конфиг Codex человека.
    const descriptor = JSON.parse(await readFile(path.join(project, '.parley', 'local', 'native-context', workId, `${codex}.json`), 'utf8')) as { verified: boolean };
    expect(descriptor.verified).toBe(true);
    const ignore = await readFile(path.join(project, '.parley', '.gitignore'), 'utf8');
    expect(ignore.startsWith('*\n')).toBe(true);
    expect(ignore).not.toContain('local');

    // Ведущий-Claude ищет скиллы участника-Codex: заглушка не отвечает как `codex`, и это честная причина, а не чужой список.
    const lead = await newSession(workId);
    await lastLaunch(lead);
    const other = json<Found>(await agentCalls(lead, workId, 'find_skill', { query: 'deployment', for: codex }));
    expect(other.provider).toBe('codex');
    expect(other.skills).toEqual([]);
    expect(other.reason).toContain('unverified');

    // Запись `codex` в providers.json с неизвестным флагом: контекст не подтверждён, сокращения нет, подсказка без обещаний.
    await put(
      path.join(home, 'providers.json'),
      `${JSON.stringify({ codex: { args: ['--profile', 'custom', '-c', '{mcpConfig}', '-c', '{developerInstructions}', '-c', '{skillCatalog}', '{prompt}'] } })}\n`,
    );
    const unknown = await newSession(workId, { provider: 'codex' });
    const unknownLaunch = await lastLaunch(unknown);
    expect(codexConfigs(unknownLaunch.argv)).not.toContain('skills.include_instructions=false');
    expect(codexConfig(unknownLaunch.argv, 'mcp_servers.parley')).not.toContain('PARLEY_SKILL_LIST_REDUCED');
    expect(layerOf(unknownLaunch)).toContain('find_skill — skills by task, if needed.');
    expect(layerOf(unknownLaunch)).not.toContain('no native skill list');
    await expect.poll(hostLog).toContain(BUDGET_UNVERIFIED);

    // Запись без `{skillCatalog}`: сокращение молча не выдумывается, человек получает адресное объяснение.
    await put(path.join(home, 'providers.json'), `${JSON.stringify({ codex: { args: ['-c', '{mcpConfig}', '-c', '{developerInstructions}', '{prompt}'] } })}\n`);
    const gap = await newSession(workId, { provider: 'codex' });
    const gapLaunch = await lastLaunch(gap);
    expect(codexConfigs(gapLaunch.argv)).not.toContain('skills.include_instructions=false');
    await expect
      .poll(async () => (await notices()).find((notice) => notice.kind === 'provider-override-gap')?.text ?? '')
      .toContain('{skillCatalog}');
    await assertNoLeaks(workId);
    await assertFrame();
  });

  test('тихая сессия, запуск с задачей, возобновление и смена настройки между запусками', async () => {
    test.setTimeout(120_000);
    await openApp();
    const workId = await newWork();
    const quiet = await newSession(workId);
    const withTask = await newSession(workId, { task: 'Polish the checkout page' });
    const quietLaunch = await lastLaunch(quiet);
    const taskLaunch = await lastLaunch(withTask);

    // Тихая сессия получает системный слой и ждёт человека; с задачей — тот же слой и бриф первым сообщением.
    expect(quietLaunch.argv.at(-1)).toBe(layerOf(quietLaunch));
    expect(taskLaunch.argv.at(-1)).toContain('Brief revision:');
    expect(taskLaunch.argv.at(-1)).toContain('Polish the checkout page');
    expect(layerOf(taskLaunch)).toContain(SESSION_LAYER_HEAD);

    // Разговор уже записан у Claude: возобновление идёт по `--resume`, без `--session-id`, модели и усилия, а бриф не повторяется.
    await transcript(taskLaunch, []);
    await call(window, 'sessions.stop', { ref: { projectPath: project, workId, sessionId: withTask } });
    await setting('skillNavigator', true);
    await call(window, 'sessions.resume', { ref: { projectPath: project, workId, sessionId: withTask } });
    const resumed = await lastLaunch(withTask, 2);
    expect(flagValue(resumed.argv, '--resume')).toBe(flagValue(taskLaunch.argv, '--session-id'));
    for (const flag of ['--session-id', '--model', '--effort']) expect(resumed.argv).not.toContain(flag);
    expect(resumed.argv.some((arg) => arg.includes('Brief revision:'))).toBe(false);
    // Переключатель действует на возобновлённую сессию: бюджет, подсказка и отдельный settings появились.
    expect(resumed.env).toMatchObject({ PARLEY_SKILL_NAVIGATOR: '1', PARLEY_SKILL_LIST_REDUCED: '1', SLASH_COMMAND_TOOL_CHAR_BUDGET: '1' });
    expect(layerOf(resumed)).toContain('find_skill — skills by task (your skill list shows names only).');
    expect(flagValue(resumed.argv, '--settings')).toBe(path.join(project, '.parley', 'works', workId, 'settings', `${withTask}.json`));

    // Работа изменилась (появилась комната): возобновление передаёт одну строку о новой ревизии брифа, а не весь бриф.
    await call(window, 'rooms.create', { projectPath: project, workId, title: 'room', members: [withTask, quiet], lead: withTask, quiet: true });
    await call(window, 'sessions.stop', { ref: { projectPath: project, workId, sessionId: withTask } });
    await call(window, 'sessions.resume', { ref: { projectPath: project, workId, sessionId: withTask } });
    const amended = await lastLaunch(withTask, 3);
    expect(amended.argv.at(-1)).toMatch(/^Your brief changed \(revision .+ is outdated\)/);
    expect(amended.argv.at(-1)).not.toContain('Polish the checkout page');
    // Без новых изменений следующее возобновление молчит: повторного поручения и подбора скилла ему не навязывают.
    await call(window, 'sessions.stop', { ref: { projectPath: project, workId, sessionId: withTask } });
    await call(window, 'sessions.resume', { ref: { projectPath: project, workId, sessionId: withTask } });
    const calm = await lastLaunch(withTask, 4);
    expect(calm.argv.some((arg) => arg.startsWith('Your brief changed'))).toBe(false);

    // Разговора у Claude нет (сессия уснула раньше первого сообщения): запуск заново с тем же id, а не битый `--resume`.
    await call(window, 'sessions.stop', { ref: { projectPath: project, workId, sessionId: quiet } });
    await call(window, 'sessions.resume', { ref: { projectPath: project, workId, sessionId: quiet } });
    const fresh = await lastLaunch(quiet, 2);
    expect(flagValue(fresh.argv, '--session-id')).toBe(flagValue(quietLaunch.argv, '--session-id'));
    expect(fresh.argv).not.toContain('--resume');
    await assertNoLeaks(workId);
    await assertFrame();
  });

  test('worktree: скиллы каждого свои, правила проекта, поиск участника и путь settings — основного проекта', async () => {
    test.setTimeout(120_000);
    await initRepo(project);
    await openApp();
    await setting('skillNavigator', true);
    const workId = await newWork();
    const root = await newSession(workId);
    const rootLaunch = await lastLaunch(root);
    // Правила команды правятся в основном проекте после коммита: worktree несёт старую копию, агенты читают правила проекта.
    await writeFile(path.join(project, 'PARLEY.md'), 'RULES EDITED MAIN\n', 'utf8');
    const inTree = await newSession(workId, { worktree: true });
    const treeLaunch = await lastLaunch(inTree);
    const map = await diskMap(workId);
    const tree = (map.sessions.find((session) => session.id === inTree)?.worktree as { path: string } | null)?.path;
    if (tree === undefined) throw new Error('у сессии нет worktree');
    expect(treeLaunch.cwd).toBe(tree);
    expect(rootLaunch.cwd).toBe(project);
    expect(layerOf(treeLaunch)).toContain('RULES EDITED MAIN');
    expect(layerOf(treeLaunch)).not.toContain('RULES COMMITTED');
    // Файл настроек и карта работы живут в основном проекте, не в worktree.
    expect(flagValue(treeLaunch.argv, '--settings')).toBe(path.join(project, '.parley', 'works', workId, 'settings', `${inTree}.json`));
    await expect(lstat(path.join(tree, '.parley', 'works'))).rejects.toMatchObject({ code: 'ENOENT' });

    // Свой проектный скилл у каждого: в worktree лежит только worktree-skill, в основном проекте — project-lint.
    await put(path.join(tree, '.claude', 'skills', 'worktree-only', 'SKILL.md'), skillMd('worktree-only', 'Regenerate the checkout snapshots inside the feature branch.'));
    await transcript(rootLaunch, ['deploy-check', 'project-lint']);
    await transcript(treeLaunch, ['deploy-check', 'worktree-only']);
    expect(json<Found>(await agentCalls(root, workId, 'find_skill', { query: 'lint storefront accessibility' })).skills[0]?.name).toBe('project-lint');
    expect(json<Found>(await agentCalls(root, workId, 'find_skill', { query: 'regenerate checkout snapshots' })).skills).toEqual([]);
    // Ведущий ищет за участника: берётся каталог и cwd участника, а не ведущего.
    expect(json<Found>(await agentCalls(root, workId, 'find_skill', { query: 'regenerate checkout snapshots', for: inTree })).skills[0]?.name).toBe('worktree-only');
    expect(json<Found>(await agentCalls(inTree, workId, 'find_skill', { query: 'lint storefront accessibility' })).skills).toEqual([]);
    // Сессия не из этой работы — ошибка, а не подмена каталогом основной копии.
    const wrong = await agentCalls(root, workId, 'find_skill', { query: 'lint', for: 's-99' });
    expect(wrong).toMatchObject({ isError: true });
    await assertNoLeaks(workId);
    await assertFrame();
  });

  test('роль с урезанными инструментами: короткий список не включается без пути загрузки; предупреждение и запасной путь', async () => {
    test.setTimeout(120_000);
    await put(path.join(project, '.claude', 'agents', 'scout.md'), '---\nname: scout\ndescription: Read-only scout\ntools: Read, Grep\n---\nYou scout.\n');
    await openApp();
    await setting('skillNavigator', true);
    const workId = await newWork();

    // Нативная роль Claude берёт список инструментов у себя: Skill и find_skill ей не гарантированы.
    const scout = await newSession(workId, { agent: 'scout' });
    const scoutLaunch = await lastLaunch(scout);
    expect(flagValue(scoutLaunch.argv, '--agent')).toBe('scout');
    expect(scoutLaunch.env['SLASH_COMMAND_TOOL_CHAR_BUDGET']).toBeUndefined();
    expect(scoutLaunch.env['PARLEY_SKILL_LIST_REDUCED']).toBeUndefined();
    expect(layerOf(scoutLaunch)).not.toContain('find_skill');
    const settings = JSON.parse(await readFile(String(flagValue(scoutLaunch.argv, '--settings')), 'utf8')) as { enabledPlugins?: unknown };
    expect(settings.enabledPlugins).toBeUndefined();
    const tool = (await toolNames(scout, workId)).find((item) => item.name === 'find_skill');
    expect(tool?.description).not.toContain('names only');
    await expect.poll(hostLog).toContain(BUDGET_UNVERIFIED);

    // Встроенная роль только для чтения: запись запрещена флагом, список сокращён обычным путём, роль — в системном слое.
    const planner = await newSession(workId, { role: { source: 'builtin', name: 'planner' } });
    const plannerLaunch = await lastLaunch(planner);
    expect(flagValue(plannerLaunch.argv, '--disallowedTools')).toBe('Edit,Write,NotebookEdit');
    expect(layerOf(plannerLaunch)).toContain('You are the planner.');
    expect(plannerLaunch.env['PARLEY_SKILL_LIST_REDUCED']).toBe('1');

    // Запись `claude` в providers.json без канала для слоя: роль без доставки не создаётся, сессия без роли стартует с полным списком.
    await put(path.join(home, 'providers.json'), `${JSON.stringify({ claude: { args: ['--session-id', '{sessionUuid}'], resumeArgs: ['--resume', '{providerSessionId}'] } })}\n`);
    for (const name of ['executor', 'planner']) {
      await expect(newSession(workId, { role: { source: 'builtin', name } })).rejects.toThrow(/role-(delivery|permissions)-unavailable/);
    }
    const before = (await diskMap(workId)).sessions.length;
    const bare = await newSession(workId);
    const bareLaunch = await lastLaunch(bare);
    expect(bareLaunch.argv).toEqual(['--session-id', expect.any(String)]);
    expect(bareLaunch.env['PARLEY_SKILL_LIST_REDUCED']).toBeUndefined();
    expect(bareLaunch.env['SLASH_COMMAND_TOOL_CHAR_BUDGET']).toBeUndefined();
    expect((await diskMap(workId)).sessions.length).toBe(before + 1);
    await assertNoLeaks(workId);
    await assertFrame();
  });

  test('большие слои: UTF-8 в пределах argv проходит, раздутый экранированием слой Codex отвергается до spawn', async () => {
    test.setTimeout(90_000);
    await openApp();
    const workId = await newWork();
    // 32 000 байт четырёхбайтных знаков в правилах: argv Claude несёт их как есть (предел 96 КиБ на аргумент).
    await writeFile(path.join(project, 'PARLEY.md'), '\u{1F600}'.repeat(8000), 'utf8');
    const claude = await newSession(workId);
    const launch = await lastLaunch(claude);
    expect(Buffer.byteLength(layerOf(launch), 'utf8')).toBeGreaterThan(32_000);
    expect(layerOf(launch)).toContain('\u{1F600}'.repeat(100));

    // Тот же размер управляющих знаков при записи в TOML вырастает в шесть раз: запуск Codex отказывает до процесса.
    await writeFile(path.join(project, 'PARLEY.md'), '\x01'.repeat(32_768), 'utf8');
    const before = (await readLines<Launch>(argvLog)).length;
    await expect(newSession(workId, { provider: 'codex' })).rejects.toThrow(/session-layer-too-large: shorten the session rules or context before launching\./);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect((await readLines<Launch>(argvLog)).length).toBe(before);
    // Файл человека не тронут отказом.
    expect(await readFile(path.join(project, 'PARLEY.md'), 'utf8')).toBe('\x01'.repeat(32_768));
    await assertNoLeaks(workId);
    await assertFrame();
  });

  /** Комната Verified с ведущим, исполнителем и проверяющим; тихий старт. */
  async function verifiedRoom(workId: string): Promise<{ lead: string; exec: string; verifier: string; roomId: string }> {
    const lead = await newSession(workId);
    const exec = await newSession(workId);
    const verifier = await newSession(workId);
    const { roomId } = await call<{ roomId: string }>(window, 'rooms.create', {
      projectPath: project,
      workId,
      title: 'plan room',
      members: [lead, exec, verifier],
      lead,
      quiet: true,
      mode: 'verified',
    });
    return { lead, exec, verifier, roomId };
  }

  const plan = (owner: string, verifier: string, scope: string, extra: object = {}): object => ({
    mode: 'verified',
    goal: 'Ship the checkout',
    items: [{ id: 1, title: 'Work', owner, scope, criteria: ['Tests pass'], verifier }],
    ...extra,
  });

  test('ревизия плана: две принятые версии — отдельные решения и снимки, старая ревизия отклонена, результат инвалидирован', async () => {
    test.setTimeout(120_000);
    await openApp();
    const workId = await newWork();
    const { lead, exec, verifier, roomId } = await verifiedRoom(workId);
    const proposed = json<{ proposalId: string; rev: number }>(await agentCalls(lead, workId, 'propose_decision', { room: roomId, plan: plan(exec, verifier, 'src'), text: 'Build it' }));
    expect(proposed).toMatchObject({ proposalId: 'p-01', rev: 0 });
    await call(window, 'rooms.resolveProposal', { projectPath: project, workId, roomId, proposalId: 'p-01', action: 'accept', rev: 0, planId: 'pl-01', planRev: 0 });
    // Исполнитель сдаёт результат ревизии 0.
    expect((await agentCalls(exec, workId, 'plan_submit', { planId: 'pl-01', rev: 0, item: 1, evidence: { text: 'Done', artifacts: [] } })).isError).toBe(false);

    // Ведущий меняет объём принятого пункта: новая ревизия ждёт человека, прежняя остаётся действующей.
    const amended = json<{ proposalId: string }>(await agentCalls(lead, workId, 'propose_decision', { room: roomId, plan: { id: 'pl-01', rev: 0, ...plan(exec, verifier, 'src and tests') }, text: 'Widen it' }));
    expect(amended.proposalId).toBe('p-02');
    // Старая карточка не принимается второй раз и не принимается с чужой ревизией плана.
    await expect(
      call(window, 'rooms.resolveProposal', { projectPath: project, workId, roomId, proposalId: 'p-01', action: 'accept', rev: 0, planId: 'pl-01', planRev: 0 }),
    ).rejects.toThrow(/conflict|proposal/i);
    await call(window, 'rooms.resolveProposal', { projectPath: project, workId, roomId, proposalId: 'p-02', action: 'accept', rev: 0, planId: 'pl-01', planRev: 1 });

    // Результат ревизии 0 инвалидирован: пункт снова готов к работе, проверка по старой ревизии отклоняется.
    const active = (await diskMap(workId)).plans?.[0] as { rev: number; items: Array<{ status: string; evidence: unknown; log: Array<{ note: string | null }> }> };
    expect(active.rev).toBe(1);
    expect(active.items[0]).toMatchObject({ status: 'ready', evidence: null });
    expect(active.items[0]?.log.at(-1)?.note).toBe('Assignment changed; previous evidence invalidated.');
    expect(await agentCalls(verifier, workId, 'plan_verify', { planId: 'pl-01', rev: 0, item: 1, verdict: 'verified', note: 'Looks fine' })).toMatchObject({
      isError: true,
      text: 'Plan revision or item changed; refresh get_map.',
    });
    expect(await agentCalls(exec, workId, 'plan_submit', { planId: 'pl-01', rev: 0, item: 1, evidence: { text: 'Stale', artifacts: [] } })).toMatchObject({ isError: true });

    // Каждая принятая версия оставила своё решение и свой снимок плана; старый снимок не переписан новым.
    const plans = path.join(project, '.parley', 'plans');
    const rev0 = await readFile(path.join(plans, `${workId}-${roomId}-pl-01-rev-0-accepted.md`), 'utf8');
    const rev1 = await readFile(path.join(plans, `${workId}-${roomId}-pl-01-rev-1-accepted.md`), 'utf8');
    expect(rev0).toContain('Scope:\nsrc\n');
    expect(rev1).toContain('src and tests');
    expect(rev0).not.toContain('src and tests');
    expect((await readdir(path.join(project, '.parley', 'decisions'))).filter((file) => /-p-0[12]-rev-00\.md$/.test(file))).toHaveLength(2);
    await assertNoLeaks(workId);
    await assertFrame();
  });

  test('конфликт файла снимка: чужой файл цел, принятый план сохранён, человек получает уведомление без путей', async () => {
    test.setTimeout(120_000);
    await openApp();
    const workId = await newWork();
    const { lead, exec, verifier, roomId } = await verifiedRoom(workId);
    const foreign = path.join(project, '.parley', 'plans', `${workId}-${roomId}-pl-01-rev-0-accepted.md`);
    await put(foreign, 'FOREIGN FILE\n');
    await agentCalls(lead, workId, 'propose_decision', { room: roomId, plan: plan(exec, verifier, 'src'), text: 'Build it' });
    const accepted = await call<{ effects?: { conflictCount?: number } }>(window, 'rooms.resolveProposal', {
      projectPath: project,
      workId,
      roomId,
      proposalId: 'p-01',
      action: 'accept',
      rev: 0,
      planId: 'pl-01',
      planRev: 0,
    });
    // Решение принято и записано в карту, хотя снимок не лёг на чужое место.
    expect((await diskMap(workId)).plans?.[0]).toMatchObject({ id: 'pl-01', rev: 0, status: 'active' });
    expect(await readFile(foreign, 'utf8')).toBe('FOREIGN FILE\n');
    expect(JSON.stringify(accepted)).not.toContain(project);
    // Человек получает одно уведомление без путей: два кода сбоя (снимок и журнал решения) не дают двух карточек.
    await expect.poll(async () => (await notices()).filter((notice) => notice.kind === 'plan-effect-failed').length).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 500));
    const failed = (await notices()).filter((notice) => notice.kind === 'plan-effect-failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]?.text).toBe('Plan delivery or export remains pending. Open the plan and retry after resolving the conflict.');
    // Остальные действия плана живут: исполнитель сдаёт результат по принятой ревизии.
    expect((await agentCalls(exec, workId, 'plan_submit', { planId: 'pl-01', rev: 0, item: 1, evidence: { text: 'Done', artifacts: [] } })).isError).toBe(false);
    await assertNoLeaks(workId);
    await assertFrame();
  });

  test('ошибки диска: конфликт памяти и недоступный файл settings не ломают чужое, сообщения без путей, запуск восстановим', async () => {
    test.setTimeout(120_000);
    await openApp();
    await setting('skillNavigator', true);
    const workId = await newWork();
    const conflicted = '<<<<<<< ours\n- a <!-- m-01 -->\n=======\n- b <!-- m-01 -->\n>>>>>>> theirs\n';
    await put(path.join(project, '.parley', 'memory.md'), conflicted);
    const first = await newSession(workId);
    const launch = await lastLaunch(first);
    // Конфликт памяти: сессия стартовала без памяти, человек видит адресное уведомление, файл не переписан.
    expect(layerOf(launch)).toContain(SESSION_LAYER_HEAD);
    await expect
      .poll(async () => (await notices()).find((notice) => notice.kind === 'memory-unreadable')?.text ?? '')
      .toBe('Parley could not read project memory; resolve memory.md conflicts or access errors before the next launch.');
    expect(await readFile(path.join(project, '.parley', 'memory.md'), 'utf8')).toBe(conflicted);

    // Место под файл настроек сессии занято каталогом: отказ с безопасным кодом без путей, запись сессии и первый запуск целы.
    const blocker = path.join(project, '.parley', 'works', workId, 'settings', 's-02.json');
    await mkdir(blocker, { recursive: true });
    await expect(newSession(workId)).rejects.toThrow(/unsafe-session-settings-path/);
    try {
      await newSession(workId);
    } catch (error) {
      expect(String(error)).not.toContain(project);
      expect(String(error)).not.toContain(home);
    }
    const sessions = (await diskMap(workId)).sessions.map((session) => session.id);
    expect(sessions).toContain('s-01');
    expect(sessions).toContain('s-02');
    expect((await agentCalls(first, workId, 'get_map')).isError).toBe(false);
    // Занято снято — запись сессии поднимается обычным возобновлением.
    await rm(blocker, { recursive: true, force: true });
    await call(window, 'sessions.resume', { ref: { projectPath: project, workId, sessionId: 's-02' } });
    expect(flagValue((await lastLaunch('s-02')).argv, '--settings')).toBe(path.join(project, '.parley', 'works', workId, 'settings', 's-02.json'));
    await assertNoLeaks(workId);
    await assertFrame();
  });
});
