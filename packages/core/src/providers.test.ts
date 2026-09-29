import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  PROVIDERS,
  commandInPath,
  commandBinary,
  loadProviders,
  printCommand,
  providersFile,
  providersWithHistory,
  resumeCommand,
  selectableModels,
  startCommand,
  substituteArgs,
  supportsEffort,
  supportsModel,
  type ProviderEntry,
} from './providers.js';

describe('реестр провайдеров', () => {
  it('claude возобновляет сессию через --resume', () => {
    expect(resumeCommand(PROVIDERS.claude, { providerSessionId: 'сессия-1' })).toEqual({
      command: 'claude',
      args: ['--resume', 'сессия-1'],
    });
  });

  it('codex возобновляет сессию подкомандой resume', () => {
    expect(resumeCommand(PROVIDERS.codex, { providerSessionId: 'uuid-1' })).toEqual({
      command: 'codex',
      args: ['resume', 'uuid-1'],
    });
  });

  it('GLM запускается без аргументов: истории у него нет', () => {
    expect(resumeCommand(PROVIDERS.glm, { providerSessionId: 'что-угодно' })).toEqual({
      command: 'glm',
      args: [],
    });
    expect(PROVIDERS.glm.hasHistory).toBe(false);
  });

  it('без id запускается чистая сессия', () => {
    expect(startCommand(PROVIDERS.claude)).toEqual({ command: 'claude', args: [] });
    expect(startCommand(PROVIDERS.codex)).toEqual({ command: 'codex', args: [] });
  });

  it('в списке сессий участвуют только провайдеры с историей', () => {
    expect(
      providersWithHistory()
        .map((p) => p.id)
        .sort(),
    ).toEqual(['claude', 'codex']);
  });

  it('у каждого провайдера есть подпись и команда', () => {
    for (const provider of Object.values(PROVIDERS)) {
      expect(provider.label).not.toBe('');
      expect(provider.runner.command).not.toBe('');
    }
  });
});

describe('подстановка аргументов запуска', () => {
  it('claude получает id сессии, MCP-конфиг, файл настроек и бриф', () => {
    expect(
      startCommand(PROVIDERS.claude, {
        sessionUuid: 'bb2137cb-0000-4000-8000-000000000000',
        mcpConfig: '/tmp/s-02.json',
        settingsFile: '/tmp/w-0042/settings.json',
        prompt: '# Работа w-0042',
      }),
    ).toEqual({
      command: 'claude',
      args: [
        '--session-id',
        'bb2137cb-0000-4000-8000-000000000000',
        '--mcp-config',
        '/tmp/s-02.json',
        '--settings',
        '/tmp/w-0042/settings.json',
        '# Работа w-0042',
      ],
    });
  });

  it('claude возобновляется с тем же MCP-конфигом и файлом настроек', () => {
    expect(
      resumeCommand(PROVIDERS.claude, {
        providerSessionId: 'bb2137cb',
        mcpConfig: '/tmp/s-02.json',
        settingsFile: '/tmp/w-0042/settings.json',
      }),
    ).toEqual({
      command: 'claude',
      args: [
        '--resume',
        'bb2137cb',
        '--mcp-config',
        '/tmp/s-02.json',
        '--settings',
        '/tmp/w-0042/settings.json',
      ],
    });
  });

  it('claude получает системную вставку и при запуске, и при возобновлении', () => {
    const guidance = 'Ты в харнессе my-harnas: работа w-0042, твоя сессия s-02.';

    const started = startCommand(PROVIDERS.claude, {
      sessionUuid: 'uuid-1',
      systemPrompt: guidance,
      prompt: 'бриф',
    }).args;
    expect(started[started.indexOf('--append-system-prompt') + 1]).toBe(guidance);

    // Системный промпт не живёт в транскрипте: при `--resume` он собирается заново.
    const resumed = resumeCommand(PROVIDERS.claude, {
      providerSessionId: 'bb2137cb',
      systemPrompt: guidance,
    }).args;
    expect(resumed[resumed.indexOf('--append-system-prompt') + 1]).toBe(guidance);
  });

  it('без вставки флаг --append-system-prompt не остаётся висячим', () => {
    expect(
      startCommand(PROVIDERS.claude, { sessionUuid: 'uuid-1', prompt: 'бриф' }).args,
    ).not.toContain('--append-system-prompt');
    expect(resumeCommand(PROVIDERS.claude, { providerSessionId: 'bb2137cb' }).args).not.toContain(
      '--append-system-prompt',
    );
  });

  it('провайдеру без такой возможности вставка не достаётся', () => {
    const guidance = 'Ты в харнессе my-harnas.';
    // У codex и glm подстановки `{systemPrompt}` в шаблоне нет — она отбрасывается
    // молча, как `{settingsFile}`: своих механизмов системного промпта мы не трогаем.
    expect(startCommand(PROVIDERS.codex, { systemPrompt: guidance, prompt: 'бриф' }).args).toEqual([
      'бриф',
    ]);
    expect(startCommand(PROVIDERS.glm, { systemPrompt: guidance }).args).toEqual([]);
  });

  it('claude с channel получает пару флага канала и при запуске, и при возобновлении', () => {
    expect(
      startCommand(PROVIDERS.claude, {
        sessionUuid: 'uuid-1',
        channel: 'server:harnas',
        prompt: 'бриф',
      }).args,
    ).toEqual([
      '--session-id',
      'uuid-1',
      '--dangerously-load-development-channels',
      'server:harnas',
      'бриф',
    ]);

    // Сервер звонит и в возобновлённую сессию: флаг нужен обоим шаблонам.
    expect(
      resumeCommand(PROVIDERS.claude, {
        providerSessionId: 'bb2137cb',
        channel: 'server:harnas',
      }).args,
    ).toEqual(['--resume', 'bb2137cb', '--dangerously-load-development-channels', 'server:harnas']);
  });

  it('без channel пара выпадает целиком: push выключен — флага нет', () => {
    expect(startCommand(PROVIDERS.claude, { sessionUuid: 'uuid-1', prompt: 'бриф' }).args).toEqual([
      '--session-id',
      'uuid-1',
      'бриф',
    ]);
    expect(resumeCommand(PROVIDERS.claude, { providerSessionId: 'bb2137cb' }).args).toEqual([
      '--resume',
      'bb2137cb',
    ]);
  });

  it('claude с agent получает пару --agent, без agent пара выпадает', () => {
    expect(
      startCommand(PROVIDERS.claude, { sessionUuid: 'uuid-1', agent: 'ревьюер', prompt: 'бриф' })
        .args,
    ).toEqual(['--session-id', 'uuid-1', '--agent', 'ревьюер', 'бриф']);
    expect(
      resumeCommand(PROVIDERS.claude, { providerSessionId: 'bb2137cb', agent: 'ревьюер' }).args,
    ).toEqual(['--resume', 'bb2137cb', '--agent', 'ревьюер']);
    expect(
      startCommand(PROVIDERS.claude, { sessionUuid: 'uuid-1', prompt: 'бриф' }).args,
    ).not.toContain('--agent');
  });

  it('без файла настроек флаг --settings не остаётся висячим', () => {
    expect(startCommand(PROVIDERS.claude, { sessionUuid: 'uuid-1', prompt: 'бриф' }).args).toEqual([
      '--session-id',
      'uuid-1',
      'бриф',
    ]);
  });

  it('незаполненная подстановка уносит с собой свой флаг', () => {
    expect(substituteArgs(['--mcp-config', '{mcpConfig}', '{prompt}'], { prompt: 'бриф' })).toEqual(
      ['бриф'],
    );
    expect(substituteArgs(['--session-id', '{sessionUuid}'], {})).toEqual([]);
  });

  it('подставленное значение, похожее на флаг, соседа не уносит', () => {
    expect(substituteArgs(['{mcpConfig}', '{prompt}'], { mcpConfig: '-c' })).toEqual(['-c']);
  });

  it('codex принимает MCP через -c и стартовый промпт позиционно', () => {
    expect(
      startCommand(PROVIDERS.codex, {
        sessionUuid: 'не-поддерживается',
        mcpConfig: 'mcp_servers.harnas={command="harnas-mcp"}',
        prompt: '# Работа w-0042',
      }),
    ).toEqual({
      command: 'codex',
      args: ['-c', 'mcp_servers.harnas={command="harnas-mcp"}', '# Работа w-0042'],
    });
  });

  it('codex не умеет принять id сессии снаружи — связь по cwd и времени', () => {
    expect(PROVIDERS.codex.linkBy).toBe('cwd+time');
    expect(PROVIDERS.claude.linkBy).toBe('session-id');
    expect(PROVIDERS.codex.runner.args).not.toContain('{sessionUuid}');
  });

  it('GLM остаётся runner-only: ни MCP, ни возобновления', () => {
    expect(PROVIDERS.glm.runner.mcpConfig).toBeUndefined();
    expect(PROVIDERS.glm.runner.resumeArgs).toBeUndefined();
    expect(startCommand(PROVIDERS.glm, { prompt: 'бриф' })).toEqual({ command: 'glm', args: [] });
  });
});

describe('модель и усилие новой сессии (дизайн комнат, 3.2)', () => {
  it('claude: --model и --effort — парами перед промптом', () => {
    expect(
      startCommand(PROVIDERS.claude, {
        sessionUuid: 'uuid-1',
        model: 'opus',
        effort: 'high',
        prompt: 'бриф',
      }).args,
    ).toEqual(['--session-id', 'uuid-1', '--model', 'opus', '--effort', 'high', 'бриф']);
  });

  it('claude: без выбора — ни флагов, ни висячих значений; выбрана одна из двух — идёт она', () => {
    const base = { sessionUuid: 'uuid-1', prompt: 'бриф' };
    expect(startCommand(PROVIDERS.claude, base).args).toEqual(['--session-id', 'uuid-1', 'бриф']);
    expect(startCommand(PROVIDERS.claude, { ...base, model: 'sonnet' }).args).toEqual([
      '--session-id',
      'uuid-1',
      '--model',
      'sonnet',
      'бриф',
    ]);
    expect(startCommand(PROVIDERS.claude, { ...base, effort: 'low' }).args).toEqual([
      '--session-id',
      'uuid-1',
      '--effort',
      'low',
      'бриф',
    ]);
  });

  it('claude при возобновлении модель и усилие не несёт: модель CLI возвращает сам', () => {
    expect(
      resumeCommand(PROVIDERS.claude, { providerSessionId: 'bb2137cb', model: 'opus', effort: 'high' })
        .args,
    ).toEqual(['--resume', 'bb2137cb']);
  });

  it('codex: модель — флагом --model, усилие — переопределением конфига -c model_reasoning_effort', () => {
    expect(
      startCommand(PROVIDERS.codex, {
        mcpConfig: 'mcp_servers.harnas={command="harnas-mcp"}',
        model: 'gpt-5.5',
        effort: 'high',
        prompt: 'бриф',
      }).args,
    ).toEqual([
      '-c',
      'mcp_servers.harnas={command="harnas-mcp"}',
      '--model',
      'gpt-5.5',
      '-c',
      'model_reasoning_effort="high"',
      'бриф',
    ]);
  });

  it('codex: без усилия строка -c выпадает вместе со своим флагом, MCP-пара остаётся', () => {
    expect(
      startCommand(PROVIDERS.codex, { mcpConfig: 'mcp_servers.harnas={}', model: 'gpt-5.5', prompt: 'бриф' })
        .args,
    ).toEqual(['-c', 'mcp_servers.harnas={}', '--model', 'gpt-5.5', 'бриф']);
    expect(startCommand(PROVIDERS.codex, { prompt: 'бриф' }).args).toEqual(['бриф']);
  });

  it('codex при возобновлении модель и усилие тоже не несёт', () => {
    expect(
      resumeCommand(PROVIDERS.codex, {
        providerSessionId: 'uuid-1',
        mcpConfig: 'mcp_servers.harnas={}',
        model: 'gpt-5.5',
        effort: 'low',
      }).args,
    ).toEqual(['resume', 'uuid-1', '-c', 'mcp_servers.harnas={}']);
  });

  it('glm флагов не знает: выбор молча отбрасывается', () => {
    expect(startCommand(PROVIDERS.glm, { model: 'x', effort: 'high' })).toEqual({
      command: 'glm',
      args: [],
    });
  });

  it('значение внутри строки шаблона подставляется в неё; пропавшее уносит строку и её флаг', () => {
    const template = ['-c', '{mcpConfig}', '-c', 'model_reasoning_effort="{effort}"', '{prompt}'];
    expect(substituteArgs(template, { mcpConfig: 'm', effort: 'medium', prompt: 'p' })).toEqual([
      '-c',
      'm',
      '-c',
      'model_reasoning_effort="medium"',
      'p',
    ]);
    expect(substituteArgs(template, { mcpConfig: 'm', prompt: 'p' })).toEqual(['-c', 'm', 'p']);
  });

  it('строка с фигурными скобками без известной подстановки остаётся как есть', () => {
    expect(substituteArgs(['--json', '{"a":1}', '{prompt}'], { prompt: 'p' })).toEqual([
      '--json',
      '{"a":1}',
      'p',
    ]);
  });

  it('поддержка решается шаблоном запуска: claude и codex умеют оба флага, glm — ни одного', () => {
    for (const entry of [PROVIDERS.claude, PROVIDERS.codex]) {
      expect(supportsModel(entry)).toBe(true);
      expect(supportsEffort(entry)).toBe(true);
    }
    expect(supportsModel(PROVIDERS.glm)).toBe(false);
    expect(supportsEffort(PROVIDERS.glm)).toBe(false);
  });

  it('закрытого списка моделей у встроенных провайдеров нет: документация его не даёт', () => {
    for (const entry of Object.values(PROVIDERS)) expect(selectableModels(entry)).toBeNull();
  });

  it('список из providers.json отдаётся, только если шаблон запуска принимает модель', () => {
    const custom = (args: string[], models?: string[]): ProviderEntry => ({
      id: 'мой',
      label: 'Мой',
      mark: 'Мо',
      hasHistory: false,
      linkBy: 'cwd+time',
      runner: { command: 'мой', args },
      ...(models === undefined ? {} : { models }),
    });

    expect(selectableModels(custom(['--model', '{model}', '{prompt}'], ['a', 'b']))).toEqual(['a', 'b']);
    // Список без флага в шаблоне окну не нужен: выбранная модель до команды не доехала бы.
    expect(selectableModels(custom(['{prompt}'], ['a', 'b']))).toBeNull();
    // Пустой список — не список.
    expect(selectableModels(custom(['--model', '{model}'], []))).toBeNull();
    expect(selectableModels(custom(['--model', '{model}']))).toBeNull();
  });

  describe('подстановка внутри строки шаблона', () => {
    const custom = (args: string[]): ProviderEntry => ({
      id: 'мой',
      label: 'Мой',
      mark: 'Мо',
      hasHistory: false,
      linkBy: 'cwd+time',
      runner: { command: 'мой', args },
      models: ['a', 'b'],
    });

    it('{model} — только целым элементом: «--model={model}» модель не принимает и списка не даёт', () => {
      const inline = custom(['--model={model}', '{prompt}']);

      // Иначе окно показало бы контрол, а в команду ушёл бы буквальный «--model={model}».
      expect(substituteArgs(inline.runner.args ?? [], { model: 'a', prompt: 'p' })).toEqual([
        '--model={model}',
        'p',
      ]);
      expect(supportsModel(inline)).toBe(false);
      expect(selectableModels(inline)).toBeNull();
      // Целым элементом — принимает, и список отдаётся.
      expect(supportsModel(custom(['--model', '{model}']))).toBe(true);
      expect(selectableModels(custom(['--model', '{model}']))).toEqual(['a', 'b']);
    });

    it('{effort} можно и внутри строки: его там подставляют, поэтому усилие провайдер принимает', () => {
      const inline = custom(['--effort={effort}', '{prompt}']);

      expect(supportsEffort(inline)).toBe(true);
      expect(startCommand(inline, { effort: 'high', prompt: 'p' }).args).toEqual(['--effort=high', 'p']);
      expect(startCommand(inline, { prompt: 'p' }).args).toEqual(['p']);
    });
  });
});

describe('режим одного ответа', () => {
  it('claude отвечает одним ответом на промпт: claude -p', () => {
    expect(printCommand(PROVIDERS.claude, { prompt: 'сожми транскрипт' })).toEqual({
      command: 'claude',
      args: ['-p', 'сожми транскрипт'],
    });
  });

  it('провайдер без режима одного ответа отдаёт пустые аргументы', () => {
    expect(printCommand(PROVIDERS.glm, { prompt: 'сожми' })).toEqual({
      command: 'glm',
      args: [],
    });
  });

  it('шаблон одного ответа лежит в реестре, а не в коде вызова', () => {
    expect(PROVIDERS.claude.runner.printArgs).toEqual(['-p', '{prompt}']);
  });
});

describe('commandInPath', () => {
  let dir = '';

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'harnas-path-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const env = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({ PATH: dir, ...extra });

  it('находит исполняемый файл в PATH', async () => {
    const file = path.join(dir, 'стаб-агент');
    await writeFile(file, '#!/bin/sh\n', 'utf8');
    await chmod(file, 0o755);

    expect(await commandInPath('стаб-агент', env())).toBe(true);
  });

  it('неисполняемый файл и отсутствующая команда — нет в PATH', async () => {
    const file = path.join(dir, 'не-исполняемый');
    await writeFile(file, 'текст', 'utf8');
    await chmod(file, 0o644);

    expect(await commandInPath('не-исполняемый', env())).toBe(false);
    expect(await commandInPath('такого-нет', env())).toBe(false);
  });

  it('переменная-оверрайд пути к бинарю учитывается: она же решает при запуске', async () => {
    const file = path.join(dir, 'вне-пути');
    await writeFile(file, '#!/bin/sh\n', 'utf8');
    await chmod(file, 0o755);

    expect(await commandInPath('claude', { PATH: '' })).toBe(false);
    expect(await commandInPath('claude', { PATH: '', HARNAS_CLAUDE_BIN: file })).toBe(true);
  });
});

describe('переопределения из HARNAS_HOME/providers.json', () => {
  let home = '';

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), 'harnas-home-'));
    process.env.HARNAS_HOME = home;
  });

  afterEach(async () => {
    delete process.env.HARNAS_HOME;
    await rm(home, { recursive: true, force: true });
  });

  const write = (data: unknown): Promise<void> =>
    writeFile(providersFile(), JSON.stringify(data), 'utf8');

  it('файла нет — работает встроенный реестр', async () => {
    const registry = await loadProviders();
    expect(Object.keys(registry).sort()).toEqual(['claude', 'codex', 'glm']);
    expect(registry['claude']?.runner.command).toBe('claude');
  });

  it('merge по id: меняется только указанное поле', async () => {
    await write({ claude: { command: '/opt/claude/bin/claude' } });
    const registry = await loadProviders();

    expect(registry['claude']?.runner.command).toBe('/opt/claude/bin/claude');
    expect(registry['claude']?.label).toBe('Claude');
    expect(registry['claude']?.runner.args).toEqual(PROVIDERS.claude.runner.args);
    expect(registry['codex']?.runner.command).toBe('codex');
  });

  it('свой провайдер добавляется целиком', async () => {
    await write({
      opencode: {
        badge: 'OpenCode',
        command: 'opencode',
        args: ['{prompt}'],
      },
    });
    const registry = await loadProviders();
    const opencode = registry['opencode'];
    if (opencode === undefined) throw new Error('свой провайдер не попал в реестр');

    expect(opencode).toEqual({
      id: 'opencode',
      label: 'OpenCode',
      mark: 'Op',
      hasHistory: false,
      linkBy: 'cwd+time',
      runner: { command: 'opencode', args: ['{prompt}'] },
    });
    expect(startCommand(opencode, { prompt: 'бриф' })).toEqual({
      command: 'opencode',
      args: ['бриф'],
    });
  });

  it('встроенный реестр не мутируется переопределениями', async () => {
    await write({ claude: { command: '/opt/claude/bin/claude' } });
    await loadProviders();
    expect(PROVIDERS.claude.runner.command).toBe('claude');
  });

  it('новому провайдеру нужны badge и command', async () => {
    await write({ мой: { args: ['{prompt}'] } });
    await expect(loadProviders()).rejects.toThrow(/мой/);
  });

  it('битый файл — ошибка, а не тихий откат к встроенному реестру', async () => {
    await writeFile(providersFile(), '{не json', 'utf8');
    await expect(loadProviders()).rejects.toThrow(/не парсится/);
  });

  it('printArgs переопределяется как остальные аргументы', async () => {
    await write({ claude: { printArgs: ['--print', '{prompt}'] } });
    const registry = await loadProviders();
    expect(printCommand(registry['claude'] as ProviderEntry, { prompt: 'сожми' })).toEqual({
      command: 'claude',
      args: ['--print', 'сожми'],
    });
  });

  it('models — список строк: ложится в запись, переживает merge и не мутирует встроенный реестр', async () => {
    await write({ codex: { models: ['gpt-5.5', 'gpt-5.5-mini'] } });
    const registry = await loadProviders();

    expect(registry['codex']?.models).toEqual(['gpt-5.5', 'gpt-5.5-mini']);
    expect(selectableModels(registry['codex'] as ProviderEntry)).toEqual(['gpt-5.5', 'gpt-5.5-mini']);
    expect(registry['codex']?.runner.args).toEqual(PROVIDERS.codex.runner.args);
    expect(PROVIDERS.codex.models).toBeUndefined();
    expect(registry['claude']?.models).toBeUndefined();
  });

  it('models не списком строк — ошибка', async () => {
    await write({ claude: { models: 'opus' } });
    await expect(loadProviders()).rejects.toThrow(/claude/);
    await write({ claude: { models: ['opus', 1] } });
    await expect(loadProviders()).rejects.toThrow(/claude/);
  });

  it('чужая форма записи — ошибка', async () => {
    await write({ claude: 'просто строка' });
    await expect(loadProviders()).rejects.toThrow(/claude/);
    await write({ claude: { args: 'не массив' } });
    await expect(loadProviders()).rejects.toThrow(/claude/);
  });
});

describe('commandBinary', () => {
  const saved = process.env['HARNAS_CLAUDE_BIN'];

  afterEach(() => {
    if (saved === undefined) delete process.env['HARNAS_CLAUDE_BIN'];
    else process.env['HARNAS_CLAUDE_BIN'] = saved;
  });

  it('без оверрайда возвращает саму команду', () => {
    expect(commandBinary('claude', {})).toBe('claude');
  });

  it('оверрайд решает, что именно запускается: в тестах это заглушка', () => {
    expect(commandBinary('claude', { HARNAS_CLAUDE_BIN: '/tmp/stub.mjs' })).toBe('/tmp/stub.mjs');
  });
});
