import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseTomlAssignment } from '../test/toml-mini.js';
import {
  PROVIDERS,
  commandInPath,
  commandBinary,
  loadProviders,
  modelChoiceError,
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
import { overrideValue, overrideVariable } from './work/find-binary.js';

/**
 * Постоянные `-c` codex, которыми харнесс читает состояние сессии без хуков Codex (спека комнат,
 * 3.6): заголовок окна и уведомления OSC 9. Значения выписаны здесь руками, а не берутся из
 * `CODEX_PARLEY_FLAGS`: тест, ссылающийся на ту же константу, не заметил бы её порчи.
 */
const CODEX_TUI_ARGS = [
  '-c',
  'tui.terminal_title=["spinner","status","session-id"]',
  '-c',
  'tui.notifications=["approval-requested","agent-turn-complete"]',
  '-c',
  'tui.notification_method="osc9"',
  '-c',
  'tui.notification_condition="always"',
];
/** Всё, что codex получает при запуске без единой подстановки. */
const CODEX_STATIC_ARGS = ['--no-daemon', '-a', 'on-request', ...CODEX_TUI_ARGS];

describe('реестр провайдеров', () => {
  it('claude возобновляет сессию через --resume', () => {
    expect(resumeCommand(PROVIDERS.claude, { providerSessionId: 'сессия-1' })).toEqual({
      command: 'claude',
      args: ['--resume', 'сессия-1'],
    });
  });

  it('codex возобновляет сессию подкомандой resume', () => {
    // Только `-c`: `--no-daemon` и `-a` после `resume <id>` не проверены на живом Codex, а спека говорит «те же
    // `-c»; тред хранит политику одобрений, любой `-c` держит запуск встроенным.
    expect(resumeCommand(PROVIDERS.codex, { providerSessionId: 'uuid-1' })).toEqual({
      command: 'codex',
      args: ['resume', 'uuid-1', ...CODEX_TUI_ARGS],
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
    // У codex и без подстановок остаются его постоянные флаги (`--no-daemon`, `-a on-request`, `tui.*`).
    expect(startCommand(PROVIDERS.codex)).toEqual({ command: 'codex', args: CODEX_STATIC_ARGS });
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
    const guidance = 'Ты в харнессе Parley: работа w-0042, твоя сессия s-02.';

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
    const guidance = 'Ты в харнессе Parley.';
    // У codex и glm подстановки `{systemPrompt}` в шаблоне нет — она отбрасывается
    // молча, как `{settingsFile}`: своих механизмов системного промпта мы не трогаем.
    expect(startCommand(PROVIDERS.codex, { systemPrompt: guidance, prompt: 'бриф' }).args).toEqual([
      ...CODEX_STATIC_ARGS,
      'бриф',
    ]);
    expect(startCommand(PROVIDERS.glm, { systemPrompt: guidance }).args).toEqual([]);
  });

  it('claude с channel получает пару флага канала и при запуске, и при возобновлении', () => {
    expect(
      startCommand(PROVIDERS.claude, {
        sessionUuid: 'uuid-1',
        channel: 'server:parley',
        prompt: 'бриф',
      }).args,
    ).toEqual([
      '--session-id',
      'uuid-1',
      '--dangerously-load-development-channels',
      'server:parley',
      'бриф',
    ]);

    // Сервер звонит и в возобновлённую сессию: флаг нужен обоим шаблонам.
    expect(
      resumeCommand(PROVIDERS.claude, {
        providerSessionId: 'bb2137cb',
        channel: 'server:parley',
      }).args,
    ).toEqual(['--resume', 'bb2137cb', '--dangerously-load-development-channels', 'server:parley']);
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
        mcpConfig: 'mcp_servers.parley={command="parley-mcp"}',
        prompt: '# Работа w-0042',
      }),
    ).toEqual({
      command: 'codex',
      args: [
        '--no-daemon',
        '-a',
        'on-request',
        '-c',
        'mcp_servers.parley={command="parley-mcp"}',
        ...CODEX_TUI_ARGS,
        '# Работа w-0042',
      ],
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
        mcpConfig: 'mcp_servers.parley={command="parley-mcp"}',
        model: 'gpt-5.5',
        effort: 'high',
        prompt: 'бриф',
      }).args,
    ).toEqual([
      '--no-daemon',
      '-a',
      'on-request',
      '-c',
      'mcp_servers.parley={command="parley-mcp"}',
      ...CODEX_TUI_ARGS,
      '--model',
      'gpt-5.5',
      '-c',
      'model_reasoning_effort="high"',
      'бриф',
    ]);
  });

  it('codex: без усилия строка -c выпадает вместе со своим флагом, MCP-пара остаётся', () => {
    expect(
      startCommand(PROVIDERS.codex, { mcpConfig: 'mcp_servers.parley={}', model: 'gpt-5.5', prompt: 'бриф' })
        .args,
    ).toEqual([
      '--no-daemon',
      '-a',
      'on-request',
      '-c',
      'mcp_servers.parley={}',
      ...CODEX_TUI_ARGS,
      '--model',
      'gpt-5.5',
      'бриф',
    ]);
    // Ни MCP, ни модели, ни усилия — остаются только постоянные флаги и промпт.
    expect(startCommand(PROVIDERS.codex, { prompt: 'бриф' }).args).toEqual([
      ...CODEX_STATIC_ARGS,
      'бриф',
    ]);
  });

  it('codex при возобновлении модель и усилие тоже не несёт', () => {
    expect(
      resumeCommand(PROVIDERS.codex, {
        providerSessionId: 'uuid-1',
        mcpConfig: 'mcp_servers.parley={}',
        model: 'gpt-5.5',
        effort: 'low',
      }).args,
    ).toEqual(['resume', 'uuid-1', '-c', 'mcp_servers.parley={}', ...CODEX_TUI_ARGS]);
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

  describe('modelChoiceError: выбор модели против записи реестра', () => {
    it('каждое значение встроенных списков годится', () => {
      for (const entry of [PROVIDERS.claude, PROVIDERS.codex]) {
        for (const { id } of selectableModels(entry) ?? []) {
          expect(modelChoiceError(entry, id), `${entry.id}: ${id}`).toBeNull();
        }
      }
    });

    it('не из списка — отказ с провайдером, моделью и допустимыми значениями; сверка точная', () => {
      const refusal = modelChoiceError(PROVIDERS.claude, 'gpt-6-sol');

      expect(refusal).toMatch(/gpt-6-sol.*claude.*opusplan/s);
      for (const model of ['Opus', 'claude-opus-5-5', 'opus ']) {
        expect(modelChoiceError(PROVIDERS.claude, model), model).not.toBeNull();
      }
      // Значение чужого провайдера — тоже не из списка.
      expect(modelChoiceError(PROVIDERS.codex, 'opus')).toMatch(/codex/);
    });

    it('форма: с дефиса, с пробелом или длиннее 200 знаков — отказ, даже когда списка нет', () => {
      for (const model of ['-opus', '--model', 'op us', 'op\tus', 'x'.repeat(201)]) {
        expect(modelChoiceError(PROVIDERS.glm, model), JSON.stringify(model)).not.toBeNull();
      }
      expect(modelChoiceError(PROVIDERS.glm, 'x'.repeat(200))).toBeNull();
    });

    it('провайдер без списка: любое слово годится, дальше решает шаблон запуска', () => {
      expect(PROVIDERS.glm.models ?? null).toBeNull();
      expect(modelChoiceError(PROVIDERS.glm, 'что-угодно')).toBeNull();
      // Список у провайдера, чей шаблон модель не принимает, окну не отдаётся — значит, и не проверяется.
      const plain: ProviderEntry = {
        ...PROVIDERS.claude,
        id: 'plain',
        runner: { command: 'plain', args: ['{prompt}'] },
        models: [{ id: 'a', label: 'А' }],
      };
      expect(modelChoiceError(plain, 'b')).toBeNull();
    });
  });

  describe('списки моделей встроенных провайдеров (открытая документация, проверено 2026-09-29)', () => {
    // Литералы, а не импорт констант: тест держит таблицу из отчёта куска 3b. Порядок — как в источнике.
    const CLAUDE = [
      { id: 'best', label: 'Best' },
      { id: 'fable', label: 'Fable' },
      { id: 'sonnet', label: 'Sonnet' },
      { id: 'opus', label: 'Opus' },
      { id: 'haiku', label: 'Haiku' },
      { id: 'sonnet[1m]', label: 'Sonnet (1M context)' },
      { id: 'opus[1m]', label: 'Opus (1M context)' },
      { id: 'opusplan', label: 'Opus Plan' },
      { id: 'opusplan[1m]', label: 'Opus Plan (1M context)' },
    ];
    const CODEX = [
      { id: 'gpt-6-astra', label: 'GPT-6 Astra' },
      { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol' },
      { id: 'gpt-6-sol', label: 'GPT-6 Sol' },
      { id: 'gpt-6-luna', label: 'GPT-6 Luna' },
    ];

    it('у claude и codex списки непустые и совпадают с таблицей отчёта; у glm списка нет', () => {
      expect(selectableModels(PROVIDERS.claude)).toEqual(CLAUDE);
      expect(selectableModels(PROVIDERS.codex)).toEqual(CODEX);
      expect(selectableModels(PROVIDERS.glm)).toBeNull();
    });

    /** Список провайдера; его отсутствие — провал теста, а не пустой обход, который прошёл бы впустую. */
    const listOf = (entry: ProviderEntry): NonNullable<ReturnType<typeof selectableModels>> => {
      const list = selectableModels(entry);
      if (list === null) throw new Error(`у ${entry.id} нет списка моделей`);
      return list;
    };

    it('«по умолчанию» — не запись списка, а отсутствие выбора: значения default там нет', () => {
      // `default` у Claude Code — «сбросить выбор», документация сама говорит, что это не модель.
      for (const entry of [PROVIDERS.claude, PROVIDERS.codex]) {
        const ids = listOf(entry).map((model) => model.id);
        expect(ids).not.toContain('default');
        expect(ids).not.toContain('');
      }
    });

    it('id — одно слово без дефиса впереди (иначе CLI принял бы его за флаг), id и подписи не повторяются', () => {
      for (const entry of [PROVIDERS.claude, PROVIDERS.codex]) {
        const list = listOf(entry);
        for (const model of list) {
          expect(model.id).toMatch(/^[^\s-]\S*$/);
          expect(model.label).not.toBe('');
        }
        expect(new Set(list.map((model) => model.id)).size).toBe(list.length);
        expect(new Set(list.map((model) => model.label)).size).toBe(list.length);
      }
    });

    it('каждое значение списка доезжает до команды парой --model <id>', () => {
      for (const entry of [PROVIDERS.claude, PROVIDERS.codex]) {
        for (const model of listOf(entry)) {
          const { args } = startCommand(entry, { model: model.id, prompt: 'бриф' });
          expect(args[args.indexOf('--model') + 1]).toBe(model.id);
          expect(args.filter((arg) => arg === '--model')).toHaveLength(1);
        }
      }
    });

    it('окну отдаётся копия: правка ответа встроенный реестр не меняет', () => {
      const list = selectableModels(PROVIDERS.claude);
      if (list === null || list[0] === undefined) throw new Error('у claude нет списка');
      list[0].label = 'испорчено';
      list.pop();

      expect(selectableModels(PROVIDERS.claude)).toEqual(CLAUDE);
    });
  });

  it('список из записи реестра отдаётся, только если шаблон запуска принимает модель', () => {
    const models = [
      { id: 'a', label: 'А' },
      { id: 'b', label: 'Б' },
    ];
    const custom = (args: string[], list?: typeof models | null): ProviderEntry => ({
      id: 'мой',
      label: 'Мой',
      mark: 'Мо',
      hasHistory: false,
      linkBy: 'cwd+time',
      runner: { command: 'мой', args },
      ...(list === undefined ? {} : { models: list }),
    });

    expect(selectableModels(custom(['--model', '{model}', '{prompt}'], models))).toEqual(models);
    // Список без флага в шаблоне окну не нужен: выбранная модель до команды не доехала бы.
    expect(selectableModels(custom(['{prompt}'], models))).toBeNull();
    // Пустой список — не список.
    expect(selectableModels(custom(['--model', '{model}'], []))).toBeNull();
    // `null` и отсутствие поля — одно и то же: списка нет.
    expect(selectableModels(custom(['--model', '{model}'], null))).toBeNull();
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
      models: [
        { id: 'a', label: 'А' },
        { id: 'b', label: 'Б' },
      ],
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
      expect(selectableModels(custom(['--model', '{model}']))).toEqual([
        { id: 'a', label: 'А' },
        { id: 'b', label: 'Б' },
      ]);
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
    dir = await mkdtemp(path.join(tmpdir(), 'parley-path-'));
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
    expect(await commandInPath('claude', { PATH: '', PARLEY_CLAUDE_BIN: file })).toBe(true);
    // Прежнее имя переменной читается тоже (R3).
    expect(await commandInPath('claude', { PATH: '', HARNAS_CLAUDE_BIN: file })).toBe(true);
  });
});

describe('переопределения из PARLEY_HOME/providers.json', () => {
  let home = '';

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), 'parley-home-'));
    process.env.PARLEY_HOME = home;
  });

  afterEach(async () => {
    delete process.env.PARLEY_HOME;
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

  describe('models: свой список моделей для окна', () => {
    const NEW = [
      { id: 'my-new-model', label: 'Моя новая' },
      { id: 'gpt-6-sol', label: 'Sol, как назвал я' },
    ];

    it('список из пар id и label заменяет встроенный целиком, а не дополняет его', async () => {
      await write({ codex: { models: NEW } });
      const registry = await loadProviders();

      expect(selectableModels(registry['codex'] as ProviderEntry)).toEqual(NEW);
      // Прочее у записи не тронуто, а встроенный реестр и соседи остались при своих списках.
      expect(registry['codex']?.runner.args).toEqual(PROVIDERS.codex.runner.args);
      expect(selectableModels(PROVIDERS.codex)?.map((model) => model.id)).toEqual([
        'gpt-6-astra',
        'gpt-6.1-sol',
        'gpt-6-sol',
        'gpt-6-luna',
      ]);
      expect(selectableModels(registry['claude'] as ProviderEntry)).toEqual(selectableModels(PROVIDERS.claude));
    });

    it('без поля models встроенный список остаётся: другие правки записи его не трогают', async () => {
      await write({ claude: { command: '/opt/claude/bin/claude' } });
      const registry = await loadProviders();

      expect(selectableModels(registry['claude'] as ProviderEntry)).toEqual(selectableModels(PROVIDERS.claude));
    });

    it('пустой список убирает встроенный: у провайдера списка больше нет', async () => {
      await write({ claude: { models: [] } });
      const registry = await loadProviders();

      expect(selectableModels(registry['claude'] as ProviderEntry)).toBeNull();
      expect(selectableModels(PROVIDERS.claude)).not.toBeNull();
    });

    it('свой провайдер приходит со списком пар', async () => {
      const models = [
        { id: 'fast', label: 'Быстрая' },
        { id: 'slow', label: 'Медленная' },
      ];
      await write({
        smart: { badge: 'Smart', command: 'smart', args: ['--m', '{model}', '{prompt}'], models },
      });
      const registry = await loadProviders();

      expect(selectableModels(registry['smart'] as ProviderEntry)).toEqual(models);
    });

    it('форма записи: не список пар, пустой id или подпись, чужие типы — ошибка; строки вместо пар нет', async () => {
      const wrong: unknown[] = [
        'opus',
        { id: 'opus', label: 'Opus' },
        ['opus'],
        ['opus', { id: 'slow', label: 'Медленная' }],
        ['opus', 1],
        [null],
        [''],
        [{ id: 'a' }],
        [{ label: 'А' }],
        [{ id: '', label: 'А' }],
        [{ id: 'a', label: '' }],
        [{ id: 'a', label: 3 }],
        [['a', 'А']],
      ];
      for (const models of wrong) {
        await write({ claude: { models } });
        await expect(loadProviders(), JSON.stringify(models)).rejects.toThrow(/claude/);
      }
    });

    it('id проверяется правилом схемы sessions.create: одно слово, не с дефиса, до 200 знаков', async () => {
      // Иначе список загрузился бы, окно показало бы значение, а `sessions.create` с ним падал бы на схеме.
      const wrongIds = ['my model', 'my\tmodel', ' opus', 'opus ', '-opus', '--model', 'x'.repeat(201)];
      for (const id of wrongIds) {
        await write({ claude: { models: [{ id, label: 'Х' }] } });
        await expect(loadProviders(), JSON.stringify(id)).rejects.toThrow(
          /claude.*неожиданная форма записи/,
        );
      }

      // Границы допустимого: скобки и точка внутри значения, дефис не впереди, ровно 200 знаков.
      const rightIds = ['sonnet[1m]', 'gpt-6.1-sol', 'a-b', 'x'.repeat(200)];
      await write({ claude: { models: rightIds.map((id) => ({ id, label: 'Х' })) } });
      const registry = await loadProviders();
      expect(registry['claude']?.models?.map((model) => model.id)).toEqual(rightIds);
    });

    it('повтор id в одном списке — ошибка: окно не различило бы две строки, а хост принял бы любую', async () => {
      await write({
        codex: {
          models: [
            { id: 'a', label: 'А' },
            { id: 'b', label: 'Б' },
            { id: 'a', label: 'Ещё А' },
          ],
        },
      });
      await expect(loadProviders()).rejects.toThrow(/codex.*неожиданная форма записи/);
    });
  });

  it('чужая форма записи — ошибка', async () => {
    await write({ claude: 'просто строка' });
    await expect(loadProviders()).rejects.toThrow(/claude/);
    await write({ claude: { args: 'не массив' } });
    await expect(loadProviders()).rejects.toThrow(/claude/);
  });
});

describe('commandBinary', () => {
  const saved = process.env['PARLEY_CLAUDE_BIN'];

  afterEach(() => {
    if (saved === undefined) delete process.env['PARLEY_CLAUDE_BIN'];
    else process.env['PARLEY_CLAUDE_BIN'] = saved;
  });

  it('без оверрайда возвращает саму команду', () => {
    expect(commandBinary('claude', {})).toBe('claude');
  });

  it('оверрайд решает, что именно запускается: в тестах это заглушка', () => {
    expect(commandBinary('claude', { PARLEY_CLAUDE_BIN: '/tmp/stub.mjs' })).toBe('/tmp/stub.mjs');
  });

  it('прежнее HARNAS_<КОМАНДА>_BIN — запасное имя; новое главнее', () => {
    expect(commandBinary('claude', { HARNAS_CLAUDE_BIN: '/tmp/old.mjs' })).toBe('/tmp/old.mjs');
    expect(commandBinary('claude', { HARNAS_CLAUDE_BIN: '/tmp/old.mjs', PARLEY_CLAUDE_BIN: '/tmp/new.mjs' })).toBe(
      '/tmp/new.mjs',
    );
    // Команда с не-буквами в имени: `my-cli.v2` → `MY_CLI_V2_BIN`, под обоими префиксами.
    expect(commandBinary('my-cli.v2', { HARNAS_MY_CLI_V2_BIN: '/tmp/x' })).toBe('/tmp/x');
    expect(commandBinary('my-cli.v2', { PARLEY_MY_CLI_V2_BIN: '/tmp/y' })).toBe('/tmp/y');
  });

  it('пустой оверрайд — заданное «бинаря нет», а не отсутствие подмены (так тест отключает провайдера)', () => {
    expect(commandBinary('glm', { PARLEY_GLM_BIN: '' })).toBe('');
    expect(commandBinary('glm', { HARNAS_GLM_BIN: '' })).toBe('');
    expect(commandBinary('glm', { PARLEY_GLM_BIN: '', HARNAS_GLM_BIN: '/opt/glm' })).toBe('');
  });

  it('переменная для сообщений называется по-новому, а значение читается под обоими именами', () => {
    expect(overrideVariable('claude')).toBe('PARLEY_CLAUDE_BIN');
    expect(overrideValue('claude', { HARNAS_CLAUDE_BIN: '/old' })).toBe('/old');
    expect(overrideValue('claude', {})).toBeUndefined();
  });
});

describe('codex: запуск и возобновление (спека комнат Organic, 3.6)', () => {
  /** Что launch кладёт в подстановки: MCP и notify — готовые значения `-c`. */
  const subs = {
    mcpConfig: 'mcp_servers.parley={command="/usr/bin/node",args=["/h/mcp/server.js"],env={PARLEY_WORK_DIR="/p/.parley/works/w-0001",PARLEY_SESSION_ID="s-02"},startup_timeout_sec=30,tool_timeout_sec=1860}',
    notify: 'notify=["/usr/bin/node","/h/work/codex-notify-bin.js"]',
    model: 'gpt-6-sol',
    effort: 'high' as const,
    prompt: '# Работа w-0001',
  };

  it('новая сессия: итоговая команда целиком', () => {
    expect(startCommand(PROVIDERS.codex, subs)).toEqual({
      command: 'codex',
      args: [
        '--no-daemon',
        '-a',
        'on-request',
        '-c',
        subs.mcpConfig,
        '-c',
        'tui.terminal_title=["spinner","status","session-id"]',
        '-c',
        'tui.notifications=["approval-requested","agent-turn-complete"]',
        '-c',
        'tui.notification_method="osc9"',
        '-c',
        'tui.notification_condition="always"',
        '-c',
        subs.notify,
        '--model',
        'gpt-6-sol',
        '-c',
        'model_reasoning_effort="high"',
        '# Работа w-0001',
      ],
    });
  });

  it('resume: те же -c, стартовый промпт (указатель на письма) последним; модели и усилия нет', () => {
    expect(
      resumeCommand(PROVIDERS.codex, {
        ...subs,
        providerSessionId: '019ce3d5-584a-7be2-922e-b8185a8d7c19',
        prompt: 'Новые письма (1). Вызови check_inbox.',
      }),
    ).toEqual({
      command: 'codex',
      args: [
        'resume',
        '019ce3d5-584a-7be2-922e-b8185a8d7c19',
        '-c',
        subs.mcpConfig,
        '-c',
        'tui.terminal_title=["spinner","status","session-id"]',
        '-c',
        'tui.notifications=["approval-requested","agent-turn-complete"]',
        '-c',
        'tui.notification_method="osc9"',
        '-c',
        'tui.notification_condition="always"',
        '-c',
        subs.notify,
        'Новые письма (1). Вызови check_inbox.',
      ],
    });
  });

  it('ручной resume без указателя: промпта в конце нет, висячих флагов нет', () => {
    const args = resumeCommand(PROVIDERS.codex, {
      ...subs,
      providerSessionId: 'uuid-1',
      prompt: undefined,
    } as never).args;
    expect(args.at(-1)).toBe(subs.notify);
    expect(args).not.toContain('--model');
    expect(args).not.toContain('model_reasoning_effort="high"');
  });

  it('и запуск, и resume: модель и усилие — только у запуска', () => {
    const resumed = resumeCommand(PROVIDERS.codex, { ...subs, providerSessionId: 'uuid-1' }).args;
    expect(resumed.join(' ')).not.toMatch(/--model|model_reasoning_effort|gpt-6-sol/);
  });

  it('без notify (нет значения) уходит и его -c: висячего флага не остаётся', () => {
    const args = startCommand(PROVIDERS.codex, { ...subs, notify: undefined } as never).args;
    expect(args.join(' ')).not.toContain('notify=');
    // Каждый `-c` в конце пары имеет значение.
    args.forEach((arg, index) => {
      if (arg === '-c') expect(args[index + 1]).toBeDefined();
    });
    expect(args.at(-1)).toBe('# Работа w-0001');
  });

  it('каждое -c — настоящий TOML: Codex не возьмёт его строкой', () => {
    for (const args of [
      startCommand(PROVIDERS.codex, subs).args,
      resumeCommand(PROVIDERS.codex, { ...subs, providerSessionId: 'uuid-1' }).args,
    ]) {
      const overrides = args.flatMap((arg, index) => (args[index - 1] === '-c' ? [arg] : []));
      // Запуск: MCP, заголовок, уведомления, способ, условие, notify, усилие; resume — те же без усилия.
      expect(overrides.length).toBeGreaterThanOrEqual(6);
      for (const override of overrides) {
        expect(() => parseTomlAssignment(override), override).not.toThrow();
      }
      const byKey = Object.fromEntries(
        overrides.map((override) => {
          const { key, value } = parseTomlAssignment(override);
          return [key.join('.'), value];
        }),
      );
      expect(byKey['tui.terminal_title']).toEqual(['spinner', 'status', 'session-id']);
      expect(byKey['tui.notifications']).toEqual(['approval-requested', 'agent-turn-complete']);
      expect(byKey['tui.notification_method']).toBe('osc9');
      expect(byKey['tui.notification_condition']).toBe('always');
      expect(byKey['notify']).toEqual(['/usr/bin/node', '/h/work/codex-notify-bin.js']);
    }
  });

  it('resume несёт только -c: ни --no-daemon, ни -a после `resume <id>` (не проверено на живом Codex)', () => {
    const args = resumeCommand(PROVIDERS.codex, {
      ...subs,
      providerSessionId: 'uuid-1',
      prompt: 'Новые письма (1). Вызови check_inbox.',
    }).args;
    expect(args.slice(0, 2)).toEqual(['resume', 'uuid-1']);
    expect(args.at(-1)).toBe('Новые письма (1). Вызови check_inbox.');
    // Всё между `resume <id>` и промптом — пары `-c <значение>`, других флагов нет.
    const flags = args.slice(2, -1);
    expect(flags.length % 2).toBe(0);
    flags.forEach((arg, index) => {
      if (index % 2 === 0) expect(arg).toBe('-c');
    });
    expect(args).not.toContain('--no-daemon');
    expect(args).not.toContain('-a');
    // Шаблон реестра — то же самое.
    expect(PROVIDERS.codex.runner.resumeArgs).not.toContain('--no-daemon');
    expect(PROVIDERS.codex.runner.resumeArgs).not.toContain('-a');
  });

  it('политика одобрений — явно on-request при запуске, а обходов нет ни в запуске, ни в resume', () => {
    const launched = startCommand(PROVIDERS.codex, subs).args;
    expect(launched[launched.indexOf('-a') + 1]).toBe('on-request');
    expect(launched).toContain('--no-daemon');
    for (const args of [
      launched,
      resumeCommand(PROVIDERS.codex, { ...subs, providerSessionId: 'uuid-1' }).args,
    ]) {
      const line = args.join(' ');
      // Вызовы `parley` при `never` отклоняются, а остальное — самовыдача прав или доверия.
      for (const forbidden of [
        /(^| )-a never/,
        /--ask-for-approval/,
        /--dangerously/,
        /--yolo/,
        /--approve-for-me/,
        /--not-so-yolo/,
        /--full-auto/,
        /(^| )-s( |$)/,
        /--sandbox/,
        /danger-full-access/,
        /(^| )projects[.=]/,
        /(^| )hooks[.=]/,
        /trust_level/,
        /--profile|(^| )-p /,
      ]) {
        expect(line, String(forbidden)).not.toMatch(forbidden);
      }
    }
  });

  it('и в шаблонах реестра нет ни обходов, ни хуков, ни трасти-переопределений', () => {
    const template = [
      ...(PROVIDERS.codex.runner.args ?? []),
      ...(PROVIDERS.codex.runner.resumeArgs ?? []),
    ].join(' ');
    expect(template).not.toMatch(/never|dangerous|yolo|full-auto|danger-full|projects|hooks|trust/i);
  });

  it('подстановка {notify} понимается реестром и не путается с {mcpConfig}', () => {
    expect(PROVIDERS.codex.runner.args).toContain('{notify}');
    expect(PROVIDERS.codex.runner.resumeArgs).toContain('{notify}');
    expect(substituteArgs(['-c', '{notify}'], { notify: 'notify=["a"]' })).toEqual([
      '-c',
      'notify=["a"]',
    ]);
    expect(PROVIDERS.claude.runner.args).not.toContain('{notify}');
  });
});
