import { chmod, lstat, mkdir, mkdtemp, readlink, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildHostEnv,
  changedFiles,
  checkSecretsOption,
  classifyScreen,
  codexTurnEnded,
  findCodexRollout,
  findTranscript,
  linkSecrets,
  modelAlias,
  parseJournal,
  providerProblem,
  runSession,
  selectedOption,
  sessionModel,
  stopCount,
  turnEnded,
  type HostClient,
} from './parley-token-benchmark-drive.js';

let tmp: string;
beforeEach(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), 'parley-drive-test-'));
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const WORK_ROOT = '/repo/.parley/benchmark/work';
const COPY = `${WORK_ROOT}/obvious.native.cold.jev-off.skill-off.r1/project`;

/** Диалог доверия как в снимке: пробелы между словами теряются. */
const trustScreen = (selected: 'yes' | 'no', shownPath = COPY): string =>
  [
    'Accessing workspace:',
    shownPath,
    'Quicksafetycheck:Isthisaprojectyoucreatedoroneyoutrust?',
    selected === 'no' ? '❯ 1.No,exit' : '  1.No,exit',
    selected === 'yes' ? '❯ 2.Yes,Itrustthisfolder' : '  2.Yes,Itrustthisfolder',
    'Enter to confirm · Esc to cancel',
  ].join('\n');

describe('classifyScreen', () => {
  it('доверие: выделено No в копии прогона', () => {
    expect(classifyScreen(trustScreen('no'), COPY, WORK_ROOT)).toEqual({ kind: 'trust', selected: 'no', ours: true });
  });

  it('доверие: выделено Yes в копии прогона', () => {
    expect(classifyScreen(trustScreen('yes'), COPY, WORK_ROOT)).toEqual({ kind: 'trust', selected: 'yes', ours: true });
  });

  it('доверие: путь на экране чужой — не наша копия', () => {
    const screen = classifyScreen(trustScreen('yes', '/Users/someone/project'), COPY, WORK_ROOT);
    expect(screen).toEqual({ kind: 'trust', selected: 'yes', ours: false });
  });

  it('доверие: копия не под <out>/work — не наша, даже если путь показан', () => {
    const outside = '/Users/someone/project';
    expect(classifyScreen(trustScreen('yes', outside), outside, WORK_ROOT)).toMatchObject({ kind: 'trust', ours: false });
  });

  it('доверие: путь, разбитый переносом строки, всё равно находится', () => {
    const half = Math.floor(COPY.length / 2);
    const wrapped = trustScreen('no', `${COPY.slice(0, half)}\n${COPY.slice(half)}`);
    expect(classifyScreen(wrapped, COPY, WORK_ROOT)).toMatchObject({ kind: 'trust', selected: 'no', ours: true });
  });

  it('MCP проекта: «Esc to reject all»', () => {
    const text = '6newMCPserversfoundinthisproject\n❯ 1.Usethisandallfuture\nEsctorejectall';
    expect(classifyScreen(text, COPY, WORK_ROOT)).toEqual({ kind: 'mcp' });
    expect(classifyScreen('1 new MCP server found in this project\nEsc to reject all', COPY, WORK_ROOT)).toEqual({ kind: 'mcp' });
  });

  it('MCP без «Esc to reject all» не считается диалогом отказа', () => {
    expect(classifyScreen('6newMCPserversfoundinthisproject', COPY, WORK_ROOT)).toEqual({ kind: 'other' });
  });

  it('предупреждение о development channel', () => {
    const text = 'WARNING:Loadingdevelopmentchannels\n❯ 1.Iamusingthisforlocaldevelopment';
    expect(classifyScreen(text, COPY, WORK_ROOT)).toEqual({ kind: 'channel' });
  });

  it('обычный экран и пустой снимок — other', () => {
    expect(classifyScreen('>  \n? for shortcuts', COPY, WORK_ROOT)).toEqual({ kind: 'other' });
    expect(classifyScreen('', COPY, WORK_ROOT)).toEqual({ kind: 'other' });
  });
});

describe('selectedOption', () => {
  it('различает Yes, No и чужой пункт; без стрелки — null', () => {
    expect(selectedOption(trustScreen('yes'))).toBe('yes');
    expect(selectedOption(trustScreen('no'))).toBe('no');
    expect(selectedOption('❯ 3.Somethingelse')).toBe('other');
    expect(selectedOption('Yes, I trust this folder')).toBeNull();
  });

  it('выделенным считается последняя строка с маркером: выше может остаться выделение прошлого экрана', () => {
    expect(selectedOption(`❯ 1.Somethingold\n${trustScreen('yes')}`)).toBe('yes');
    expect(selectedOption(`${trustScreen('yes')}\n❯ 3.Somethingelse`)).toBe('other');
  });
});

describe('modelAlias', () => {
  it('claude-… → псевдоним провайдера', () => {
    expect(modelAlias('claude-sonnet-5-5')).toBe('sonnet');
    expect(modelAlias('claude-opus-4-1')).toBe('opus');
    expect(modelAlias('claude-haiku-4-5')).toBe('haiku');
    expect(modelAlias('sonnet')).toBe('sonnet');
  });

  it('неизвестная модель — отказ', () => {
    expect(() => modelAlias('gpt-6-luna')).toThrow(/нет псевдонима/);
    expect(() => modelAlias('claude-fable-1')).toThrow(/нет псевдонима/);
  });
});

describe('buildHostEnv', () => {
  const operator: NodeJS.ProcessEnv = {
    HOME: '/Users/op', USER: 'op', LOGNAME: 'op', PATH: '/usr/bin:/bin', SHELL: '/bin/zsh', LANG: 'ru_RU.UTF-8', TERM: 'dumb',
    CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_CODE_SSE_PORT: '123', CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: '1',
    ANTHROPIC_API_KEY: 'sk-secret', ANTHROPIC_BASE_URL: 'https://x', AWS_SECRET_ACCESS_KEY: 'x', NODE_OPTIONS: '--inspect',
  };
  const runEnv = ['PARLEY_SKILL_NAVIGATOR=true', 'PARLEY_AGENT_SKILLS=false', 'CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=0'];
  const build = (claudeBinDir: string | null = null) => buildHostEnv({ base: operator, home: '/tmp/pbh', runEnv, tmpDir: '/var/tmp/x/', claudeBinDir });

  it('только разрешённый список, строка прогона и DISABLE_AUTOUPDATER=1', () => {
    expect(build()).toEqual({
      HOME: '/Users/op', USER: 'op', LOGNAME: 'op', PATH: '/usr/bin:/bin', SHELL: '/bin/zsh', LANG: 'en_US.UTF-8', TERM: 'xterm-256color',
      TMPDIR: '/var/tmp/x/', PARLEY_HOME: '/tmp/pbh',
      PARLEY_SKILL_NAVIGATOR: 'true', PARLEY_AGENT_SKILLS: 'false', CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: '0',
      DISABLE_AUTOUPDATER: '1',
    });
  });

  it('нет меток родительской сессии, ключей API и чужого окружения; функциональные хуки — из строки прогона', () => {
    const env = build();
    expect(env).not.toHaveProperty('CLAUDECODE');
    expect(env).not.toHaveProperty('CLAUDE_CODE_ENTRYPOINT');
    expect(env).not.toHaveProperty('CLAUDE_CODE_SSE_PORT');
    expect(Object.keys(env).filter((k) => k.startsWith('ANTHROPIC_'))).toEqual([]);
    expect(env).not.toHaveProperty('NODE_OPTIONS');
    expect(env['CLAUDE_CODE_ENABLE_FUNCTION_HOOKS']).toBe('0');
  });

  it('каталог --claude-bin первым в PATH', () => {
    expect(build('/tmp/bin-x')['PATH']).toBe('/tmp/bin-x:/usr/bin:/bin');
  });

  it('строка прогона с меткой родительской сессии или ключом — отказ', () => {
    for (const bad of ['CLAUDECODE=1', 'CLAUDE_CODE_SSE_PORT=1', 'ANTHROPIC_API_KEY=x', 'novalue']) {
      expect(() => buildHostEnv({ base: operator, home: '/tmp/pbh', runEnv: [bad], tmpDir: '/t' })).toThrow(/не годится/);
    }
  });
});

describe('журнал хуков', () => {
  const rows = (...names: string[]): string => names.map((hook_event_name) => JSON.stringify({ hook_event_name })).join('\n');

  it('Stop после последнего UserPromptSubmit — ход закончен', () => {
    expect(turnEnded(parseJournal(rows('SessionStart', 'UserPromptSubmit', 'PreToolUse', 'Stop')))).toBe(true);
  });

  it('Stop только от прошлого хода — ход идёт', () => {
    expect(turnEnded(parseJournal(rows('UserPromptSubmit', 'Stop', 'UserPromptSubmit', 'PreToolUse')))).toBe(false);
  });

  it('нет запроса — не закончен, даже со Stop', () => {
    expect(turnEnded(parseJournal(rows('SessionStart', 'Stop')))).toBe(false);
    expect(turnEnded([])).toBe(false);
  });

  it('битая и пустая строки пропускаются', () => {
    const text = `${rows('UserPromptSubmit')}\n\n{"hook_event_na\n${rows('Stop')}\n`;
    expect(parseJournal(text)).toHaveLength(2);
    expect(turnEnded(parseJournal(text))).toBe(true);
  });
});

describe('changedFiles', () => {
  it('служебное не считается, переименование — по новому имени', () => {
    const porcelain = [
      ' M src/range.js',
      '?? notes.md',
      '?? .parley/works/w1/events/s1.jsonl',
      '?? PARLEY.md',
      '?? .omc/state/x.json',
      'R  old.js -> new.js',
      '',
    ].join('\n');
    expect(changedFiles(porcelain)).toEqual(['src/range.js', 'notes.md', 'new.js']);
  });

  it('чистая копия — пусто', () => {
    expect(changedFiles('')).toEqual([]);
  });
});

describe('findTranscript', () => {
  it('находит <uuid>.jsonl в одном из каталогов проектов', async () => {
    await mkdir(path.join(tmp, '-a'), { recursive: true });
    await mkdir(path.join(tmp, '-b'), { recursive: true });
    await writeFile(path.join(tmp, '-b', 'abc.jsonl'), '');
    expect(findTranscript(tmp, 'abc')).toBe(path.join(tmp, '-b', 'abc.jsonl'));
    expect(findTranscript(tmp, 'nope')).toBeNull();
    expect(findTranscript(path.join(tmp, 'missing'), 'abc')).toBeNull();
  });
});

/**
 * Вопрос доверия Codex 0.160.0 как в живом снимке пробной сессии: заголовок «Folder access», путь копии переносится по
 * ширине экрана, в тексте вопроса и у невыделенных пунктов пробелы между словами потеряны (курсорные сдвиги вместо
 * пробелов), у выделенного пункта остались; маркер выделения `›`, подвал «enter continue · esc quit».
 * `selected` — выделенный пункт: «1. Trust and continue» (в Codex он выделен по умолчанию), «2. Quit» или никакой.
 */
const codexTrustScreen = (selected: 'yes' | 'no' | 'none', shownPath = COPY): string => {
  const cut = Math.floor(shownPath.length * 0.75);
  return [
    '  Folder access',
    shownPath.slice(0, cut),
    shownPath.slice(cut),
    'Trustthisfolder?Codexcanread,edit,andrunfileshere,subjecttoyourpermissionsettings.Foldersettings',
    'canruncodeautomatically,evenwithoutamodelrequest.Continueonlyifyoutrustthesefiles.Yourtrust',
    'decisionwillbesaved.',
    selected === 'yes' ? '› 1. Trust and continue' : '1.Trustandcontinue',
    selected === 'no' ? '› 2. Quit' : '2.Quit',
    'enter continue · esc quit',
  ].join('\n');
};

describe('экраны запуска Codex', () => {
  it('вопрос доверия к копии: выделено «Trust and continue», выделено «Quit», выделения нет', () => {
    expect(classifyScreen(codexTrustScreen('yes'), COPY, WORK_ROOT, 'codex')).toEqual({ kind: 'trust', selected: 'yes', ours: true });
    expect(classifyScreen(codexTrustScreen('no'), COPY, WORK_ROOT, 'codex')).toEqual({ kind: 'trust', selected: 'no', ours: true });
    expect(classifyScreen(codexTrustScreen('none'), COPY, WORK_ROOT, 'codex')).toEqual({ kind: 'trust', selected: null, ours: true });
  });

  it('снимок пробы 0.160.0 узнаётся и с пробелами, и без них; это вопрос доверия, а не обновление', () => {
    const screen = codexTrustScreen('yes');
    expect(screen).toContain('› 1. Trust and continue');
    expect(classifyScreen(screen, COPY, WORK_ROOT, 'codex')).toEqual({ kind: 'trust', selected: 'yes', ours: true });
    expect(classifyScreen(screen.replace(/ /g, ''), COPY, WORK_ROOT, 'codex')).toEqual({ kind: 'trust', selected: 'yes', ours: true });
  });

  it('нужны все три признака: «Trust this folder?», пункт «Trust and continue» и подвал «esc quit»', () => {
    const screen = codexTrustScreen('yes');
    expect(classifyScreen(screen.replace('Trustthisfolder?', ''), COPY, WORK_ROOT, 'codex')).toEqual({ kind: 'other' });
    expect(classifyScreen(screen.replace('Trust and continue', 'Continue'), COPY, WORK_ROOT, 'codex')).toEqual({ kind: 'other' });
    expect(classifyScreen(screen.replace('esc quit', 'esc cancel'), COPY, WORK_ROOT, 'codex')).toEqual({ kind: 'other' });
  });

  it('чужой путь и копия вне <out>/work — не наша; незнакомый пункт под выделением — other', () => {
    expect(classifyScreen(codexTrustScreen('yes', '/Users/someone/project'), COPY, WORK_ROOT, 'codex')).toMatchObject({ kind: 'trust', ours: false });
    const outside = '/Users/someone/project';
    expect(classifyScreen(codexTrustScreen('yes', outside), outside, WORK_ROOT, 'codex')).toMatchObject({ ours: false });
    expect(selectedOption('› 1.Allowworkwithoutasking', 'codex')).toBe('other');
    expect(selectedOption('› 1. Trust and continue', 'codex')).toBe('yes');
    expect(selectedOption('› 1.Trustandcontinue', 'codex')).toBe('yes');
    expect(selectedOption('❯ 2.Quit', 'codex')).toBe('no');
    // Прежняя догадка о тексте («Yes, …») больше не «да»: Enter на неё не уйдёт.
    expect(selectedOption('› 1.Yes,continue', 'codex')).toBe('other');
  });

  it('текст Claude Code у Codex не вопрос доверия, и наоборот; незнакомый экран — other', () => {
    expect(classifyScreen(trustScreen('yes'), COPY, WORK_ROOT, 'codex')).toEqual({ kind: 'other' });
    expect(classifyScreen(codexTrustScreen('yes'), COPY, WORK_ROOT)).toEqual({ kind: 'other' });
    expect(classifyScreen('Updateavailable!0.1->0.2\n› 1.Updatenow\n  2.Skip', COPY, WORK_ROOT, 'codex')).toEqual({ kind: 'other' });
  });

  it('маркер › у провайдера claude выделением не считается', () => {
    expect(selectedOption('› 1. Trust and continue')).toBeNull();
  });
});

/**
 * Предложение обновиться у Codex 0.160.0 как в снимке пробной сессии: по умолчанию выделено «Update now»
 * (`npm install -g`), в подвале «esc skip». В настоящем снимке пробелы между словами теряются.
 */
const CODEX_UPDATE_SCREEN = [
  'Update available · 0.160.0 → 0.160.1',
  'Release notes: https://github.com/openai/codex/releases/latest',
  '› 1. Update now (runs `npm install -g @openai/codex`)',
  '2.Skip',
  '3.Skipuntilnextversion',
  'enter continue · esc skip',
].join('\n');

describe('предложение обновления Codex: распознавание', () => {
  it('экран из снимка, с пробелами и без, — update; у claude и glm тот же текст — other', () => {
    expect(classifyScreen(CODEX_UPDATE_SCREEN, COPY, WORK_ROOT, 'codex')).toEqual({ kind: 'update' });
    expect(classifyScreen(CODEX_UPDATE_SCREEN.replace(/ /g, ''), COPY, WORK_ROOT, 'codex')).toEqual({ kind: 'update' });
    expect(classifyScreen(CODEX_UPDATE_SCREEN, COPY, WORK_ROOT)).toEqual({ kind: 'other' });
    expect(classifyScreen(CODEX_UPDATE_SCREEN, COPY, WORK_ROOT, 'glm')).toEqual({ kind: 'other' });
  });

  it('нужны оба признака: «Update available» без «esc skip» (в том числе с подвалом «esc quit») и подсказка без заголовка — other', () => {
    expect(classifyScreen('Updateavailable·0.160.0→0.160.1\n› 1.Updatenow\n  2.Skip', COPY, WORK_ROOT, 'codex')).toEqual({ kind: 'other' });
    expect(classifyScreen('Updateavailable·0.160.0→0.160.1\n› 1.Updatenow\nentercontinue·escquit', COPY, WORK_ROOT, 'codex')).toEqual({ kind: 'other' });
    expect(classifyScreen('entercontinue·escskip', COPY, WORK_ROOT, 'codex')).toEqual({ kind: 'other' });
  });

  it('вопрос доверия важнее текста обновления, оставшегося в снимке выше: Esc на доверие не уходит', () => {
    const screen = `${CODEX_UPDATE_SCREEN}\n${codexTrustScreen('yes')}`;
    expect(classifyScreen(screen, COPY, WORK_ROOT, 'codex')).toEqual({ kind: 'trust', selected: 'yes', ours: true });
  });

  it('над вопросом доверия осталось «› 1. Update now»: выделенным считается «Trust and continue» (последняя строка с маркером)', () => {
    expect(selectedOption(`${CODEX_UPDATE_SCREEN}\n${codexTrustScreen('yes')}`, 'codex')).toBe('yes');
    expect(selectedOption(`${CODEX_UPDATE_SCREEN}\n${codexTrustScreen('no')}`, 'codex')).toBe('no');
  });
});

describe('запуск сессии по экранам: обновление и доверие', () => {
  const ref = { projectPath: '/p', workId: 'w1', sessionId: 's1' };
  const ctx: Parameters<typeof runSession>[2] = { copy: COPY, workRoot: WORK_ROOT, prompt: 'запрос сценария', trustCopies: true, timeoutMin: 1, provider: 'codex' };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** Подставной клиент хоста: экраны выдаются по очереди (последний повторяется), отправленное записывается. */
  function fakeHost(screens: string[]) {
    const inputs: string[] = [];
    const sends: unknown[] = [];
    let shown = 0;
    const client = {
      lastActivity: null,
      screen: () => Promise.resolve(screens[Math.min(shown++, screens.length - 1)]!),
      notify: (method: string, params: { data: string }) => {
        if (method === 'pty.input') inputs.push(params.data);
      },
      call: (method: string, params: unknown) => {
        if (method !== 'pty.send') return Promise.reject(new Error(`неожиданный вызов ${method}`));
        sends.push(params);
        // Дальше сценарий не нужен: хост вставил текст, но Enter не нажал — драйвер выходит с `send-input`.
        return Promise.resolve({ inserted: true, submitted: false, reason: 'input' });
      },
    } as unknown as HostClient;
    return { client, inputs, sends };
  }

  async function run(client: HostClient, override: Partial<typeof ctx> = {}): ReturnType<typeof runSession> {
    const finished = runSession(client, ref, { ...ctx, ...override });
    await vi.runAllTimersAsync();
    return finished;
  }

  it('экран не уходит: Esc дважды, Enter никогда, на третьем показе стоп update-prompt-stuck, запрос не отправлен', async () => {
    const { client, inputs, sends } = fakeHost([CODEX_UPDATE_SCREEN]);
    const summary = await run(client);
    expect(summary).toMatchObject({ outcome: 'update-prompt-stuck', updateSkipped: true, trustAnswered: false, sentAt: null });
    expect(inputs).toEqual(['\x1b', '\x1b']);
    expect(sends).toEqual([]);
  });

  it('экран ушёл после Esc: дальше вопрос доверия (Enter только на нём, строки обновления выше) и запрос сценария', async () => {
    const trustAfterUpdate = `${CODEX_UPDATE_SCREEN}\n${codexTrustScreen('yes')}`;
    const { client, inputs, sends } = fakeHost([CODEX_UPDATE_SCREEN, trustAfterUpdate, '› Ask Codex to do anything']);
    const summary = await run(client);
    expect(inputs).toEqual(['\x1b', '\r']);
    expect(sends).toHaveLength(1);
    expect(summary).toMatchObject({ outcome: 'send-input', updateSkipped: true, trustAnswered: true });
  });

  it('Codex, вопрос доверия к копии: ровно один Enter и ни одного Esc, диалог на следующем опросе ещё виден — второго Enter нет', async () => {
    const { client, inputs, sends } = fakeHost([codexTrustScreen('yes'), codexTrustScreen('yes'), '› Ask Codex to do anything']);
    const summary = await run(client);
    expect(inputs).toEqual(['\r']);
    expect(sends).toHaveLength(1);
    expect(summary).toMatchObject({ outcome: 'send-input', trustAnswered: true, updateSkipped: false });
  });

  it('Codex, над вопросом доверия остались строки обновления с «› 1. Update now»: Enter один раз на «Trust and continue», Esc не уходит', async () => {
    const { client, inputs, sends } = fakeHost([`${CODEX_UPDATE_SCREEN}\n${codexTrustScreen('yes')}`, '› Ask Codex to do anything']);
    const summary = await run(client);
    expect(inputs).toEqual(['\r']);
    expect(sends).toHaveLength(1);
    expect(summary).toMatchObject({ outcome: 'send-input', trustAnswered: true, updateSkipped: false });
  });

  it('Codex, диалог доверия не ушёл после Enter: второй Enter не нажимается, через пять опросов стоп trust-unexpected', async () => {
    const { client, inputs, sends } = fakeHost([codexTrustScreen('yes')]);
    const summary = await run(client);
    expect(summary).toMatchObject({ outcome: 'trust-unexpected', trustAnswered: true });
    expect(inputs).toEqual(['\r']);
    expect(sends).toEqual([]);
  });

  it.each<[string, Partial<typeof ctx>, string, string]>([
    ['без --trust-copies', { trustCopies: false }, codexTrustScreen('yes'), 'trust-not-allowed'],
    ['на экране чужой путь', {}, codexTrustScreen('yes', '/Users/someone/project'), 'trust-unexpected'],
    ['копия не под <out>/work', { copy: '/Users/someone/project' }, codexTrustScreen('yes', '/Users/someone/project'), 'trust-unexpected'],
    ['выделено «2. Quit»', {}, codexTrustScreen('no'), 'trust-unexpected'],
    ['выделения нет', {}, codexTrustScreen('none'), 'trust-unexpected'],
  ])('Codex, вопрос доверия: %s — стоп без единого нажатия, запрос не отправлен', async (_case, override, screen, outcome) => {
    const { client, inputs, sends } = fakeHost([screen]);
    const summary = await run(client, override);
    expect(summary).toMatchObject({ outcome, trustAnswered: false, updateSkipped: false, sentAt: null });
    expect(inputs).toEqual([]);
    expect(sends).toEqual([]);
  });

  it('Claude, вопрос доверия как раньше: выделено «No, exit» — стрелка вниз, затем один Enter на «Yes, I trust this folder»', async () => {
    const { client, inputs, sends } = fakeHost([trustScreen('no'), trustScreen('yes'), '? for shortcuts']);
    const summary = await run(client, { provider: 'claude' });
    expect(inputs).toEqual(['\x1b[B', '\r']);
    expect(sends).toHaveLength(1);
    expect(summary).toMatchObject({ outcome: 'send-input', trustAnswered: true });
  });
});

describe('провайдер сессии', () => {
  it('модель: у claude псевдоним, у glm и codex id из списка как есть', () => {
    expect(sessionModel('claude', 'claude-sonnet-5-5')).toBe('sonnet');
    expect(sessionModel('glm', 'glm-5.3[1m]')).toBe('glm-5.3[1m]');
    expect(sessionModel('codex', 'gpt-6-luna')).toBe('gpt-6-luna');
    expect(() => sessionModel('claude', 'glm-5.3[1m]')).toThrow(/нет псевдонима/);
  });

  it('готовность по providers.list: нет ключа, нет CLI, нет провайдера, недоступен, готов', () => {
    const list = [
      { id: 'glm', available: false, needs: 'key' as const },
      { id: 'codex', available: false, needs: 'cli' as const },
      { id: 'claude', available: true, needs: null },
      { id: 'other', available: false },
    ];
    expect(providerProblem(list, 'glm')).toMatch(/не видит ключ/);
    expect(providerProblem(list, 'codex')).toMatch(/нет CLI/);
    expect(providerProblem(list, 'nope')).toMatch(/не знает/);
    expect(providerProblem(list, 'other')).toMatch(/недоступен/);
    expect(providerProblem(list, 'claude')).toBeNull();
    expect(providerProblem([{ id: 'glm' }], 'glm')).toBeNull();
  });

  it('ссылка на ключ нужна glm и только ему', () => {
    expect(() => checkSecretsOption('glm', null)).toThrow(/--link-secrets PATH/);
    expect(() => checkSecretsOption('claude', '/x/key')).toThrow(/только прогону с провайдером glm/);
    expect(() => checkSecretsOption('codex', '/x/key')).toThrow(/только прогону с провайдером glm/);
    expect(() => checkSecretsOption('glm', '/x/key')).not.toThrow();
    expect(() => checkSecretsOption('claude', null)).not.toThrow();
    expect(() => checkSecretsOption('codex', null)).not.toThrow();
  });
});

describe('конец хода Codex', () => {
  const rows = (...names: string[]): string => names.map((hook_event_name) => JSON.stringify({ hook_event_name })).join('\n');

  it('первая Stop сверх уже бывших к отправке запроса; UserPromptSubmit не нужен', () => {
    expect(stopCount(parseJournal(rows('SessionStart', 'Stop', 'Stop')))).toBe(2);
    expect(codexTurnEnded(parseJournal(rows('Stop')), 0)).toBe(true);
    expect(codexTurnEnded(parseJournal(rows()), 0)).toBe(false);
    // Stop от прошлого хода уже была к отправке (1): ход идёт, пока не появится вторая.
    expect(codexTurnEnded(parseJournal(rows('Stop')), 1)).toBe(false);
    expect(codexTurnEnded(parseJournal(rows('Stop', 'Stop')), 1)).toBe(true);
    // Правило Claude Code тут не годится: без UserPromptSubmit оно не видит конца.
    expect(turnEnded(parseJournal(rows('Stop')))).toBe(false);
  });

  it('строка Stop, как её пишет notify Codex (kebab-case поля), считается', () => {
    const row = JSON.stringify({ hook_event_name: 'Stop', last_assistant_message: 'готово', 'thread-id': 't1', 'turn-id': 'u1' });
    expect(codexTurnEnded(parseJournal(`${row}\n`), 0)).toBe(true);
  });
});

describe('журнал Codex по id треда', () => {
  it('находит rollout-…-<id>.jsonl в каталогах по датам; чужой id и пустой корень — null', async () => {
    const day = path.join(tmp, '2026', '10', '06');
    await mkdir(day, { recursive: true });
    await writeFile(path.join(day, 'rollout-2026-10-06T10-00-00-019ce3d5-aaaa.jsonl'), '');
    await writeFile(path.join(day, 'rollout-2026-10-06T10-00-00-019ce3d5-bbbb.jsonl'), '');
    expect(findCodexRollout(tmp, '019ce3d5-aaaa')).toBe(path.join(day, 'rollout-2026-10-06T10-00-00-019ce3d5-aaaa.jsonl'));
    expect(findCodexRollout(tmp, 'нет')).toBeNull();
    expect(findCodexRollout(path.join(tmp, 'нет каталога'), 'x')).toBeNull();
  });
});

describe('ссылка на ключ GLM', () => {
  it('ссылка в доме на файл по указанному пути, имя — имя файла; remove снимает ссылку, файл цел; повтор безвреден', async () => {
    const source = path.join(tmp, 'store', 'keystore.json');
    await mkdir(path.dirname(source), { recursive: true });
    await writeFile(source, 'тестовое-содержимое');
    const home = path.join(tmp, 'home');

    const linked = linkSecrets(source, home);
    expect(linked.link).toBe(path.join(home, 'keystore.json'));
    expect((await lstat(linked.link)).isSymbolicLink()).toBe(true);
    expect(await readlink(linked.link)).toBe(source);

    linked.remove();
    await expect(lstat(linked.link)).rejects.toThrow();
    expect((await lstat(source)).isFile()).toBe(true);
    expect(() => linked.remove()).not.toThrow();
  });

  it('файл не читается: ссылка встаёт и на файл без прав чтения', async () => {
    const source = path.join(tmp, 'keystore.json');
    await writeFile(source, 'x');
    await chmod(source, 0o000);
    try {
      const linked = linkSecrets(source, path.join(tmp, 'home'));
      expect((await lstat(linked.link)).isSymbolicLink()).toBe(true);
      linked.remove();
    } finally {
      await chmod(source, 0o600);
    }
  });

  it('нет файла — отказ без создания дома; занятое имя в доме — отказ, прежнее не тронуто', async () => {
    const home = path.join(tmp, 'home');
    expect(() => linkSecrets(path.join(tmp, 'нет.json'), home)).toThrow(/файла нет/);
    await expect(lstat(home)).rejects.toThrow();

    const source = path.join(tmp, 'keystore.json');
    await writeFile(source, 'x');
    await mkdir(home, { recursive: true });
    await writeFile(path.join(home, 'keystore.json'), 'прежний');
    expect(() => linkSecrets(source, home)).toThrow(/уже что-то лежит/);
    expect((await lstat(path.join(home, 'keystore.json'))).isFile()).toBe(true);
  });
});
