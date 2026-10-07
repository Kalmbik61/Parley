import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseTomlAssignment } from '../test/toml-mini.js';
import {
  EFFORT_DESCRIPTION_MAX,
  EFFORT_TOKEN,
  MODEL_LABEL_MAX,
  PROVIDERS,
  codexModelsFile,
  commandInPath,
  commandBinary,
  effortsFor,
  loadProviders,
  isClaudeCode,
  modelChoiceError,
  printCommand,
  providersFile,
  providersWithHistory,
  resolveModelEffort,
  resumeCommand,
  selectableModels,
  startCommand,
  substituteArgs,
  supportsEffort,
  supportsModel,
  type ProviderEntry,
} from './providers.js';
import { CLAUDE_EFFORTS, LEGACY_EFFORTS, effortLabel, type ModelOption } from './provider-models.js';
import { overrideValue, overrideVariable } from './work/find-binary.js';

/**
 * Постоянные `-c` codex, которыми харнесс читает состояние сессии без хуков Codex (спека комнат,
 * 3.6): заголовок окна и уведомления OSC 9. Значения выписаны здесь руками, а не берутся из
 * `CODEX_PARLEY_FLAGS`: тест, ссылающийся на ту же константу, не заметил бы её порчи.
 */
const CODEX_TUI_ARGS = [
  '-c',
  'project_doc_fallback_filenames=["CLAUDE.md"]',
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

  it('GLM resumes through official Claude Code', () => {
    expect(resumeCommand(PROVIDERS.glm, { providerSessionId: 'что-угодно' })).toEqual({
      command: 'claude',
      args: ['--resume', 'что-угодно'],
    });
    expect(PROVIDERS.glm.hasHistory).toBe(true);
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
    ).toEqual(['claude', 'codex', 'glm']);
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
    const guidance = 'You are inside Parley: workspace w-0042, your session is s-02.';

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
    const guidance = 'You are inside Parley.';
    // У Codex нет подстановки системного промпта; GLM использует Claude Code.
    // молча, как `{settingsFile}`: своих механизмов системного промпта мы не трогаем.
    expect(startCommand(PROVIDERS.codex, { systemPrompt: guidance, prompt: 'бриф' }).args).toEqual([
      ...CODEX_STATIC_ARGS,
      'бриф',
    ]);
    expect(startCommand(PROVIDERS.glm, { systemPrompt: guidance }).args).toEqual([
      '--append-system-prompt',
      guidance,
    ]);
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

  it('GLM uses Claude MCP and has no development channel', () => {
    expect(PROVIDERS.glm.runner.mcpConfig).toBe('json-file');
    expect(PROVIDERS.glm.linkBy).toBe('session-id');
    expect(PROVIDERS.glm.runner.args).not.toContain('{channel}');
    expect(PROVIDERS.glm.runner.resumeArgs).not.toContain('{channel}');
    expect(startCommand(PROVIDERS.glm, { prompt: 'бриф' })).toEqual({
      command: 'claude',
      args: ['бриф'],
    });
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

  it('claude при возобновлении несёт модель и усилие из карты парами перед --agent; без выбора пар нет', () => {
    expect(
      resumeCommand(PROVIDERS.claude, {
        providerSessionId: 'bb2137cb',
        model: 'opus',
        effort: 'high',
        agent: 'ревьюер',
        prompt: 'New messages (1). Call check_inbox.',
      }).args,
    ).toEqual([
      '--resume',
      'bb2137cb',
      '--model',
      'opus',
      '--effort',
      'high',
      '--agent',
      'ревьюер',
      'New messages (1). Call check_inbox.',
    ]);
    // Одно усилие — одна пара; без выбора модель Claude Code при --resume восстанавливает сам.
    expect(resumeCommand(PROVIDERS.claude, { providerSessionId: 'bb2137cb', effort: 'xhigh' }).args).toEqual([
      '--resume',
      'bb2137cb',
      '--effort',
      'xhigh',
    ]);
    expect(resumeCommand(PROVIDERS.claude, { providerSessionId: 'bb2137cb' }).args).toEqual([
      '--resume',
      'bb2137cb',
    ]);
  });

  it('GLM при возобновлении несёт effort сразу за моделью; без effort пара выпадает', () => {
    expect(
      resumeCommand(PROVIDERS.glm, { providerSessionId: 'id-1', model: 'glm-5.3[1m]', effort: 'max' }).args,
    ).toEqual(['--resume', 'id-1', '--model', 'glm-5.3[1m]', '--effort', 'max']);
    expect(resumeCommand(PROVIDERS.glm, { providerSessionId: 'id-1', model: 'glm-5.3[1m]' }).args).toEqual([
      '--resume',
      'id-1',
      '--model',
      'glm-5.3[1m]',
    ]);
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

  it('codex при возобновлении модель и усилие не несёт: тред помнит их сам', () => {
    expect(
      resumeCommand(PROVIDERS.codex, {
        providerSessionId: 'uuid-1',
        mcpConfig: 'mcp_servers.parley={}',
        model: 'gpt-5.5',
        effort: 'low',
      }).args,
    ).toEqual(['resume', 'uuid-1', '-c', 'mcp_servers.parley={}', ...CODEX_TUI_ARGS]);
  });

  it('GLM accepts model and effort', () => {
    expect(startCommand(PROVIDERS.glm, { model: 'x', effort: 'high' })).toEqual({
      command: 'claude',
      args: ['--model', 'x', '--effort', 'high'],
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

  it('поддержка решается шаблоном запуска: встроенные провайдеры принимают модель и усилие', () => {
    for (const entry of [PROVIDERS.claude, PROVIDERS.codex, PROVIDERS.glm]) {
      expect(supportsModel(entry)).toBe(true);
      expect(supportsEffort(entry)).toBe(true);
    }
    expect(supportsModel(PROVIDERS.glm)).toBe(true);
    expect(supportsEffort(PROVIDERS.glm)).toBe(true);
  });

  describe('modelChoiceError: выбор модели против записи реестра', () => {
    it('каждое значение встроенных списков годится', () => {
      for (const entry of [PROVIDERS.claude, PROVIDERS.codex, PROVIDERS.glm]) {
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
      expect(modelChoiceError({ ...PROVIDERS.glm, models: null }, 'x'.repeat(200))).toBeNull();
    });

    it('провайдер без списка: любое слово годится, дальше решает шаблон запуска', () => {
      expect(modelChoiceError({ ...PROVIDERS.glm, models: null }, 'что-угодно')).toBeNull();
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

  describe('каталог моделей встроенных провайдеров (спека нормалайзера модели и effort, 5.1)', () => {
    // Литералы, а не импорт констант: тест держит таблицы источников. Порядок — как в источнике.
    /** Уровни Claude Code (code.claude.com/docs/en/model-config, 2026-10-06), без описаний. */
    const CLAUDE_LEVELS = [
      { id: 'low', label: 'Low' },
      { id: 'medium', label: 'Medium' },
      { id: 'high', label: 'High' },
      { id: 'xhigh', label: 'Extra high' },
      { id: 'max', label: 'Max' },
    ];
    const CLAUDE = [
      { id: 'best', label: 'Best', efforts: CLAUDE_LEVELS },
      { id: 'fable', label: 'Fable', efforts: CLAUDE_LEVELS },
      { id: 'sonnet', label: 'Sonnet', efforts: CLAUDE_LEVELS },
      { id: 'opus', label: 'Opus', efforts: CLAUDE_LEVELS },
      { id: 'haiku', label: 'Haiku', efforts: null },
      { id: 'sonnet[1m]', label: 'Sonnet (1M context)', efforts: CLAUDE_LEVELS },
      { id: 'opus[1m]', label: 'Opus (1M context)', efforts: CLAUDE_LEVELS },
      { id: 'opusplan', label: 'Opus Plan', efforts: CLAUDE_LEVELS },
      { id: 'opusplan[1m]', label: 'Opus Plan (1M context)', efforts: CLAUDE_LEVELS },
    ];
    /** Уровни Codex с описаниями — снимок `codex debug models` 2026-10-06 (спека, раздел 3, п. 11–12). */
    const CODEX_LEVELS = [
      { id: 'low', label: 'Low', description: 'Fast responses with lighter reasoning' },
      { id: 'medium', label: 'Medium', description: 'Balances speed and reasoning depth for everyday tasks' },
      { id: 'high', label: 'High', description: 'Greater reasoning depth for complex problems' },
      { id: 'xhigh', label: 'Extra high', description: 'Extra high reasoning depth for complex problems' },
      { id: 'max', label: 'Max', description: 'Maximum reasoning depth for the hardest problems' },
    ];
    const CODEX_ULTRA_LEVELS = [
      ...CODEX_LEVELS,
      { id: 'ultra', label: 'Ultra', description: 'Maximum reasoning with automatic task delegation' },
    ];
    /** Видимые модели каталога Codex в порядке `priority`, подписи — `display_name`; у двух Luna нет Ultra. */
    const CODEX = [
      { id: 'gpt-6.1-sol', label: 'GPT-6.1-Sol', efforts: CODEX_ULTRA_LEVELS },
      { id: 'gpt-6-astra', label: 'GPT-6-Astra', efforts: CODEX_ULTRA_LEVELS },
      { id: 'gpt-6-sol', label: 'GPT-6-Sol', efforts: CODEX_ULTRA_LEVELS },
      { id: 'gpt-6-luna', label: 'GPT-6-Luna', efforts: CODEX_LEVELS },
      { id: 'gpt-5.6-sol', label: 'GPT-5.6-Sol', efforts: CODEX_ULTRA_LEVELS },
      { id: 'gpt-5.6-terra', label: 'GPT-5.6-Terra', efforts: CODEX_ULTRA_LEVELS },
      { id: 'gpt-5.6-luna', label: 'GPT-5.6-Luna', efforts: CODEX_LEVELS },
    ];

    it('встроенные списки совпадают с таблицами источников: модели, подписи и уровни', () => {
      expect(selectableModels(PROVIDERS.claude)).toEqual(CLAUDE);
      expect(selectableModels(PROVIDERS.codex)).toEqual(CODEX);
      expect(selectableModels(PROVIDERS.glm)).toEqual([
        { id: 'glm-5.3[1m]', label: 'GLM-5.3 (1M context)', efforts: CLAUDE_LEVELS },
        { id: 'glm-5.3-flash[1m]', label: 'GLM-5.3 Flash (1M context)', efforts: CLAUDE_LEVELS },
      ]);
    });

    it('уровни Claude Code и прежние три уровня — общие константы каталога', () => {
      expect(CLAUDE_EFFORTS).toEqual(CLAUDE_LEVELS);
      expect(LEGACY_EFFORTS).toEqual(CLAUDE_LEVELS.slice(0, 3));
    });

    it('effortLabel: подписи по таблице спеки, незнакомый id — с заглавной буквы', () => {
      expect(['low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'minimal', 'none'].map(effortLabel)).toEqual([
        'Low',
        'Medium',
        'High',
        'Extra high',
        'Max',
        'Ultra',
        'Minimal',
        'None',
      ]);
      expect(effortLabel('turbo')).toBe('Turbo');
      expect(effortLabel('x_2')).toBe('X_2');
      // Имя свойства объекта — такой же незнакомый id, а не подпись из прототипа.
      expect(effortLabel('constructor')).toBe('Constructor');
    });

    /** Список провайдера; его отсутствие — провал теста, а не пустой обход, который прошёл бы впустую. */
    const listOf = (entry: ProviderEntry): NonNullable<ReturnType<typeof selectableModels>> => {
      const list = selectableModels(entry);
      if (list === null) throw new Error(`у ${entry.id} нет списка моделей`);
      return list;
    };

    it('«по умолчанию» — не запись списка, а отсутствие выбора: значения default там нет', () => {
      // `default` у Claude Code — «сбросить выбор», документация сама говорит, что это не модель.
      for (const entry of [PROVIDERS.claude, PROVIDERS.codex, PROVIDERS.glm]) {
        const ids = listOf(entry).map((model) => model.id);
        expect(ids).not.toContain('default');
        expect(ids).not.toContain('');
      }
    });

    it('id — одно слово без дефиса впереди (иначе CLI принял бы его за флаг), id и подписи не повторяются', () => {
      for (const entry of [PROVIDERS.claude, PROVIDERS.codex, PROVIDERS.glm]) {
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
      for (const entry of [PROVIDERS.claude, PROVIDERS.codex, PROVIDERS.glm]) {
        for (const model of listOf(entry)) {
          const { args } = startCommand(entry, { model: model.id, prompt: 'бриф' });
          expect(args[args.indexOf('--model') + 1]).toBe(model.id);
          expect(args.filter((arg) => arg === '--model')).toHaveLength(1);
        }
      }
    });

    it('окну отдаётся копия вместе с уровнями: правка ответа встроенный реестр не меняет', () => {
      const list = selectableModels(PROVIDERS.claude);
      const levels = list?.[0]?.efforts;
      if (list === null || list[0] === undefined || levels === undefined || levels === null || levels[0] === undefined) {
        throw new Error('у claude нет списка с уровнями');
      }
      list[0].label = 'испорчено';
      levels[0].label = 'испорчено';
      levels.pop();
      list.pop();

      expect(selectableModels(PROVIDERS.claude)).toEqual(CLAUDE);
      // Массив уровней у моделей каталога общий: правка копии не должна дойти и до него.
      expect(CLAUDE_EFFORTS).toEqual(CLAUDE_LEVELS);
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
      command: 'claude',
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

  it('allowed overrides retain trusted GLM metadata', async () => {
    await write({ glm: { badge: 'My GLM', command: '/opt/wrapper', args: ['{model}'] } });
    const entry = (await loadProviders())['glm']!;
    expect(isClaudeCode(entry)).toBe(true);
    expect(isClaudeCode('glm')).toBe(true);
    expect(isClaudeCode('unknown')).toBe(false);
    expect(entry.runner).toMatchObject({
      secret: 'zai',
      settingsModel: 'glm-5.3[1m]',
      minVersion: '2.1.287',
    });
    expect(entry.runner.env).toMatchObject({
      ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
    });
    expect(entry.runner.env).not.toHaveProperty('ANTHROPIC_AUTH_TOKEN');
  });

  it.each(['family', 'env', 'settingsModel', 'secret', 'minVersion', 'runner'])(
    'JSON cannot define trusted %s metadata',
    async (field) => {
      await write({ custom: { badge: 'Custom', command: 'custom', [field]: 'invented' } });
      await expect(loadProviders()).rejects.toThrow(/unexpected entry shape/);
    },
  );

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
      argsOverridden: true,
    });
    expect(startCommand(opencode, { prompt: 'бриф' })).toEqual({
      command: 'opencode',
      args: ['бриф'],
    });
  });

  it('argsOverridden — только у записи, чьи args пришли из providers.json', async () => {
    await write({
      codex: { args: ['{prompt}'] },
      claude: { command: '/opt/claude/bin/claude', resumeArgs: ['--resume', '{providerSessionId}'] },
    });
    const registry = await loadProviders();

    expect(registry['codex']?.argsOverridden).toBe(true);
    // Команда и resumeArgs — не args: выбор модели и effort по-прежнему решает встроенный шаблон.
    expect('argsOverridden' in (registry['claude'] ?? {})).toBe(false);
    expect('argsOverridden' in (registry['glm'] ?? {})).toBe(false);
    expect('argsOverridden' in PROVIDERS.codex).toBe(false);
    // Свой шаблон без {model} и {effort} выключает выбор — это окно и объясняет по argsOverridden.
    expect(supportsModel(registry['codex'] as ProviderEntry)).toBe(false);
    expect(supportsEffort(registry['codex'] as ProviderEntry)).toBe(false);
  });

  it('встроенный реестр не мутируется переопределениями', async () => {
    await write({ claude: { command: '/opt/claude/bin/claude' } });
    await loadProviders();
    expect(PROVIDERS.claude.runner.command).toBe('claude');
  });

  it('новому провайдеру нужны badge и command', async () => {
    await write({ мой: { args: ['{prompt}'] } });
    await expect(loadProviders()).rejects.toThrow(/мой.*a new provider needs badge and command/);
  });

  it('битый файл — ошибка, а не тихий откат к встроенному реестру', async () => {
    await writeFile(providersFile(), '{не json', 'utf8');
    await expect(loadProviders()).rejects.toThrow(/provider registry .* cannot be parsed/);
  });

  it('файл — не объект: ошибка той же формы', async () => {
    await writeFile(providersFile(), '[]', 'utf8');
    await expect(loadProviders()).rejects.toThrow(/provider registry .* cannot be parsed: unexpected shape/);
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
        'gpt-6.1-sol',
        'gpt-6-astra',
        'gpt-6-sol',
        'gpt-6-luna',
        'gpt-5.6-sol',
        'gpt-5.6-terra',
        'gpt-5.6-luna',
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
          /claude.*unexpected entry shape/,
        );
      }

      // Границы допустимого: скобки и точка внутри значения, дефис не впереди, ровно 200 знаков.
      const rightIds = ['sonnet[1m]', 'gpt-6.1-sol', 'a-b', 'x'.repeat(200)];
      await write({ claude: { models: rightIds.map((id) => ({ id, label: 'Х' })) } });
      const registry = await loadProviders();
      expect(registry['claude']?.models?.map((model) => model.id)).toEqual(rightIds);
    });

    it('efforts: уровни модели id-ами, подписи выводятся; null — effort у модели нет; без поля — прежнее правило', async () => {
      await write({
        codex: {
          models: [
            { id: 'my-sol', label: 'Моя Sol', efforts: ['low', 'xhigh', 'ultra', 'turbo'] },
            { id: 'my-mini', label: 'Моя мини', efforts: null },
            { id: 'my-old', label: 'Моя старая' },
          ],
        },
      });
      const codex = (await loadProviders())['codex'] as ProviderEntry;

      expect(selectableModels(codex)).toStrictEqual([
        {
          id: 'my-sol',
          label: 'Моя Sol',
          efforts: [
            { id: 'low', label: 'Low' },
            { id: 'xhigh', label: 'Extra high' },
            { id: 'ultra', label: 'Ultra' },
            { id: 'turbo', label: 'Turbo' },
          ],
        },
        { id: 'my-mini', label: 'Моя мини', efforts: null },
        { id: 'my-old', label: 'Моя старая' },
      ]);
      expect(effortsFor(codex, 'my-mini')).toBeNull();
      expect(effortsFor(codex, 'my-old')?.map((level) => level.id)).toEqual(['low', 'medium', 'high']);
      // «Default» — общее у моделей с уровнями: у my-sol и прежних трёх my-old общий только low.
      expect(effortsFor(codex, undefined)?.map((level) => level.id)).toEqual(['low']);
      expect(resolveModelEffort(codex, { model: 'my-sol', effort: 'turbo' })).toStrictEqual({
        choice: { model: 'my-sol', effort: 'turbo' },
      });
    });

    it('неверные efforts — loadProviders падает с причиной: провайдер, файл, модель и что не так', async () => {
      const wrong: unknown[] = [[], ['low', 'low'], ['hi gh'], ['High'], ['x"'], [''], ['a'.repeat(33)], 'low', [1], {}, [null]];
      for (const efforts of wrong) {
        await write({ codex: { models: [{ id: 'my-sol', label: 'Моя Sol', efforts }] } });
        await expect(loadProviders(), JSON.stringify(efforts)).rejects.toThrow(
          /^provider codex in .*providers\.json: model my-sol: efforts must be null or a non-empty list of unique levels/,
        );
      }
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
      await expect(loadProviders()).rejects.toThrow(/codex.*unexpected entry shape/);
    });
  });

  describe('каталог Codex из файла хоста (спека нормалайзера модели и effort, 5.2)', () => {
    /** Модели, как их пишет хост из `codex debug models`: подписи — `display_name`, описания уровней — каталога. */
    const LIVE = [
      {
        id: 'gpt-7-sol',
        label: 'GPT-7-Sol',
        efforts: [
          { id: 'low', label: 'Low', description: 'Fast responses with lighter reasoning' },
          { id: 'ultra', label: 'Ultra' },
        ],
      },
      { id: 'gpt-7-mini', label: 'GPT-7-Mini', efforts: null },
    ];
    const writeLive = (data: unknown): Promise<void> =>
      writeFile(codexModelsFile(), JSON.stringify(data), 'utf8');

    it('файл лежит в доме Parley; нет файла — запасной список', async () => {
      expect(codexModelsFile()).toBe(path.join(home, 'codex-models.json'));
      expect(selectableModels((await loadProviders())['codex'] as ProviderEntry)).toEqual(
        selectableModels(PROVIDERS.codex),
      );
    });

    it('модели из файла хоста заменяют запасной список Codex — тот же список видят окно и MCP; соседи не тронуты', async () => {
      await writeLive({ fetchedAt: '2026-10-06T10:00:00.000Z', models: LIVE });
      const registry = await loadProviders();
      const codex = registry['codex'] as ProviderEntry;

      expect(selectableModels(codex)).toStrictEqual(LIVE);
      expect(resolveModelEffort(codex, { model: 'gpt-7-sol', effort: 'ultra' })).toStrictEqual({
        choice: { model: 'gpt-7-sol', effort: 'ultra' },
      });
      expect(resolveModelEffort(codex, { model: 'gpt-6.1-sol' })).toMatchObject({ error: expect.stringContaining('gpt-7-sol') });
      expect(selectableModels(registry['claude'] as ProviderEntry)).toEqual(selectableModels(PROVIDERS.claude));
      expect(selectableModels(PROVIDERS.codex)?.[0]?.id).toBe('gpt-6.1-sol');
    });

    it('models из providers.json важнее файла хоста', async () => {
      await writeLive({ fetchedAt: '2026-10-06T10:00:00.000Z', models: LIVE });
      await write({ codex: { models: [{ id: 'mine', label: 'Моя' }] } });

      expect(selectableModels((await loadProviders())['codex'] as ProviderEntry)).toStrictEqual([
        { id: 'mine', label: 'Моя' },
      ]);
    });

    it('в запись ложатся только известные поля: лишнее из файла до окна не доходит', async () => {
      await writeLive({
        fetchedAt: '2026-10-06T10:00:00.000Z',
        models: [{ id: 'a', label: 'A', priority: 1, efforts: [{ id: 'low', label: 'Low', effort: 'low' }] }],
      });

      expect(selectableModels((await loadProviders())['codex'] as ProviderEntry)).toStrictEqual([
        { id: 'a', label: 'A', efforts: [{ id: 'low', label: 'Low' }] },
      ]);
    });

    it('подпись уровня строится по id (effortLabel), а не берётся из файла: ручная правка кэша не растягивает окно', async () => {
      await writeLive({
        fetchedAt: '2026-10-06T10:00:00.000Z',
        models: [
          {
            id: 'gpt-7-sol',
            label: 'GPT-7-Sol',
            efforts: [
              { id: 'xhigh', label: 'Очень длинная подпись, которую кто-то вписал в кэш руками, чтобы растянуть окно '.repeat(5) },
              { id: 'turbo', label: 'TURBO!!!' },
            ],
          },
        ],
      });

      expect(selectableModels((await loadProviders())['codex'] as ProviderEntry)).toStrictEqual([
        {
          id: 'gpt-7-sol',
          label: 'GPT-7-Sol',
          efforts: [
            { id: 'xhigh', label: effortLabel('xhigh') },
            { id: 'turbo', label: effortLabel('turbo') },
          ],
        },
      ]);
    });

    it('испорченный или пустой файл молча игнорируется: остаётся запасной список, loadProviders не падает', async () => {
      const broken = [
        '{не json',
        '[]',
        '{}',
        JSON.stringify({ models: [] }),
        JSON.stringify({ models: 'gpt-7-sol' }),
        JSON.stringify({ models: [{ id: '-x', label: 'X' }] }),
        JSON.stringify({ models: [{ id: 'a', label: 'A' }, { id: 'a', label: 'Б' }] }),
        JSON.stringify({ models: [{ id: 'a', label: 'A', efforts: [] }] }),
        JSON.stringify({ models: [{ id: 'a', label: 'A', efforts: [{ id: 'hi gh', label: 'X' }] }] }),
        JSON.stringify({ models: [{ id: 'a', label: 'A', efforts: [{ id: 'low' }] }] }),
        JSON.stringify({ models: [{ id: 'a', label: 'A', efforts: [{ id: 'low', label: 'L' }, { id: 'low', label: 'L' }] }] }),
        JSON.stringify({ models: [{ id: 'a', label: 'A', efforts: 'low' }] }),
      ];
      for (const raw of broken) {
        await writeFile(codexModelsFile(), raw, 'utf8');
        expect(selectableModels((await loadProviders())['codex'] as ProviderEntry), raw).toEqual(
          selectableModels(PROVIDERS.codex),
        );
      }
    });

    it('внешний ввод: подпись длиннее 100 и описание длиннее 300 знаков обрезаются; незнакомый уровень-токен идёт как есть', async () => {
      await writeLive({
        fetchedAt: '2026-10-06T10:00:00.000Z',
        models: [
          {
            id: 'gpt-7-sol',
            label: 'S'.repeat(150),
            efforts: [{ id: 'turbo', label: 'Turbo', description: 'd'.repeat(400) }],
          },
        ],
      });
      const codex = (await loadProviders())['codex'] as ProviderEntry;

      expect([MODEL_LABEL_MAX, EFFORT_DESCRIPTION_MAX]).toEqual([100, 300]);
      expect(selectableModels(codex)).toStrictEqual([
        {
          id: 'gpt-7-sol',
          label: 'S'.repeat(100),
          efforts: [{ id: 'turbo', label: 'Turbo', description: 'd'.repeat(300) }],
        },
      ]);
      // Уровень-токен, которого Parley не знает, не отвергается: и проверка, и подстановка — по EFFORT_TOKEN.
      expect(resolveModelEffort(codex, { model: 'gpt-7-sol', effort: 'turbo' })).toStrictEqual({
        choice: { model: 'gpt-7-sol', effort: 'turbo' },
      });
      expect(startCommand(codex, { model: 'gpt-7-sol', effort: 'turbo', prompt: 'p' }).args).toContain(
        'model_reasoning_effort="turbo"',
      );
    });

    it('id модели, который стал бы флагом или двумя аргументами `--model`, — файл не читается целиком', async () => {
      for (const id of ['-gpt', '--model', 'gpt 7', 'gpt\t7', 'x'.repeat(201)]) {
        await writeLive({
          fetchedAt: '2026-10-06T10:00:00.000Z',
          models: [{ id, label: 'X' }, { id: 'gpt-7-sol', label: 'GPT-7-Sol' }],
        });
        expect(selectableModels((await loadProviders())['codex'] as ProviderEntry), JSON.stringify(id)).toEqual(
          selectableModels(PROVIDERS.codex),
        );
      }
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
  /** Что launch кладёт в подстановки: MCP — готовое значение `-c`. */
  const subs = {
    mcpConfig: 'mcp_servers.parley={command="/usr/bin/node",args=["/h/mcp/server.js"],env={PARLEY_WORK_DIR="/p/.parley/works/w-0001",PARLEY_SESSION_ID="s-02"},startup_timeout_sec=30,tool_timeout_sec=1860}',
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
        'project_doc_fallback_filenames=["CLAUDE.md"]',
        '-c',
        'tui.terminal_title=["spinner","status","session-id"]',
        '-c',
        'tui.notifications=["approval-requested","agent-turn-complete"]',
        '-c',
        'tui.notification_method="osc9"',
        '-c',
        'tui.notification_condition="always"',
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
        prompt: 'New messages (1). Call check_inbox.',
      }),
    ).toEqual({
      command: 'codex',
      args: [
        'resume',
        '019ce3d5-584a-7be2-922e-b8185a8d7c19',
        '-c',
        subs.mcpConfig,
        '-c',
        'project_doc_fallback_filenames=["CLAUDE.md"]',
        '-c',
        'tui.terminal_title=["spinner","status","session-id"]',
        '-c',
        'tui.notifications=["approval-requested","agent-turn-complete"]',
        '-c',
        'tui.notification_method="osc9"',
        '-c',
        'tui.notification_condition="always"',
        'New messages (1). Call check_inbox.',
      ],
    });
  });

  it('ручной resume без указателя: промпта в конце нет, висячих флагов нет', () => {
    const args = resumeCommand(PROVIDERS.codex, {
      ...subs,
      providerSessionId: 'uuid-1',
      prompt: undefined,
    } as never).args;
    expect(args.at(-1)).toBe('tui.notification_condition="always"');
    expect(args).not.toContain('--model');
    expect(args).not.toContain('model_reasoning_effort="high"');
  });

  it('и запуск, и resume: модель и усилие — только у запуска', () => {
    const resumed = resumeCommand(PROVIDERS.codex, { ...subs, providerSessionId: 'uuid-1' }).args;
    expect(resumed.join(' ')).not.toMatch(/--model|model_reasoning_effort|gpt-6-sol/);
  });

  it('в запуске нет notify: ни `-c notify=`, ни неподставленного `{notify}`; висячего флага не остаётся', () => {
    for (const args of [startCommand(PROVIDERS.codex, subs).args, resumeCommand(PROVIDERS.codex, { ...subs, providerSessionId: 'u' }).args]) {
      expect(args.some((arg) => arg.startsWith('notify='))).toBe(false);
      expect(args).not.toContain('{notify}');
      // Каждый `-c` в конце пары имеет значение.
      args.forEach((arg, index) => {
        if (arg === '-c') expect(args[index + 1]).toBeDefined();
      });
    }
    expect(startCommand(PROVIDERS.codex, subs).args.at(-1)).toBe('# Работа w-0001');
  });

  it('старая запись реестра с `{notify}`: подстановки нет, пара `-c {notify}` выпадает', () => {
    expect(substituteArgs(['-c', 'a=1', '-c', '{notify}'], {})).toEqual(['-c', 'a=1']);
  });

  it('{skillCatalog}: без значения пара выпадает и аргументы прежние, со значением — отдельное -c для запуска и resume', () => {
    expect(PROVIDERS.codex.runner.args).toContain('{skillCatalog}');
    expect(PROVIDERS.codex.runner.resumeArgs).toContain('{skillCatalog}');
    expect(PROVIDERS.claude.runner.args).not.toContain('{skillCatalog}');
    const plain = startCommand(PROVIDERS.codex, subs).args;
    expect(plain.join(' ')).not.toContain('skills.include_instructions');
    const resume = { ...subs, providerSessionId: 'uuid-1' };
    expect(resumeCommand(PROVIDERS.codex, resume).args.join(' ')).not.toContain('skills.include_instructions');
    const off = { ...subs, skillCatalog: 'skills.include_instructions=false' };
    for (const [without, withFlag] of [
      [plain, startCommand(PROVIDERS.codex, off).args],
      [resumeCommand(PROVIDERS.codex, resume).args, resumeCommand(PROVIDERS.codex, { ...resume, ...off }).args],
    ] as const) {
      expect(withFlag).toHaveLength(without.length + 2);
      const at = withFlag.indexOf('skills.include_instructions=false');
      expect(withFlag[at - 1]).toBe('-c');
      expect(parseTomlAssignment(withFlag[at]!).value).toBe(false);
      expect(withFlag.filter((_, index) => index !== at && index !== at - 1)).toEqual(without);
    }
    expect(substituteArgs(['-c', '{skillCatalog}', 'x'], {})).toEqual(['x']);
  });

  it('{codexHooks}: массив разворачивается на месте и в запуске, и в resume; без значения элемент выпадает без соседнего -c', () => {
    expect(PROVIDERS.codex.runner.args).toContain('{codexHooks}');
    expect(PROVIDERS.codex.runner.resumeArgs).toContain('{codexHooks}');
    expect(PROVIDERS.claude.runner.args).not.toContain('{codexHooks}');
    const plain = startCommand(PROVIDERS.codex, subs).args;
    expect(plain.join(' ')).not.toContain('hooks.');
    const hooks = ['-c', 'hooks.Stop=[]', '-c', 'hooks.SessionStart=[]'];
    const withHooks = startCommand(PROVIDERS.codex, { ...subs, codexHooks: hooks }).args;
    expect(withHooks).toHaveLength(plain.length + hooks.length);
    expect(withHooks.slice(withHooks.indexOf('hooks.Stop=[]') - 1, withHooks.indexOf('hooks.Stop=[]') + 3)).toEqual(hooks);
    const resume = { ...subs, providerSessionId: 'uuid-1' };
    expect(resumeCommand(PROVIDERS.codex, { ...resume, codexHooks: hooks }).args).toContain('hooks.SessionStart=[]');
    expect(substituteArgs(['-c', 'a=1', '{codexHooks}'], {})).toEqual(['-c', 'a=1']);
    expect(substituteArgs(['-c', 'a=1', '{codexHooks}'], { codexHooks: ['-c', 'b=2'] })).toEqual(['-c', 'a=1', '-c', 'b=2']);
  });

  it('каждое -c — настоящий TOML: Codex не возьмёт его строкой', () => {
    for (const args of [
      startCommand(PROVIDERS.codex, subs).args,
      resumeCommand(PROVIDERS.codex, { ...subs, providerSessionId: 'uuid-1' }).args,
    ]) {
      const overrides = args.flatMap((arg, index) => (args[index - 1] === '-c' ? [arg] : []));
      // Запуск: MCP, заголовок, уведомления, способ, условие, усилие; resume — те же без усилия.
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
      expect(byKey['notify']).toBeUndefined();
    }
  });

  it('resume несёт только -c: ни --no-daemon, ни -a после `resume <id>` (не проверено на живом Codex)', () => {
    const args = resumeCommand(PROVIDERS.codex, {
      ...subs,
      providerSessionId: 'uuid-1',
      prompt: 'New messages (1). Call check_inbox.',
    }).args;
    expect(args.slice(0, 2)).toEqual(['resume', 'uuid-1']);
    expect(args.at(-1)).toBe('New messages (1). Call check_inbox.');
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
    ].join(' ').replaceAll('{codexHooks}', '');
    expect(template).not.toMatch(/never|dangerous|yolo|full-auto|danger-full|projects|hooks|trust/i);
  });

  it('реестр не содержит подстановки {notify}', () => {
    expect(PROVIDERS.codex.runner.args).not.toContain('{notify}');
    expect(PROVIDERS.codex.runner.resumeArgs).not.toContain('{notify}');
    expect(PROVIDERS.claude.runner.args).not.toContain('{notify}');
  });
});

describe('Codex developer layer channel', () => {
  it('the whole assignment is one argument on launch and resume and parses as TOML', () => {
    const text = 'quote " \\\nЖ🙂';
    const assignment = `developer_instructions=${JSON.stringify(text)}`;
    for (const args of [startCommand(PROVIDERS.codex, { developerInstructions: assignment }).args,
      resumeCommand(PROVIDERS.codex, { providerSessionId: 'id', developerInstructions: assignment }).args]) {
      const at = args.indexOf(assignment);
      expect(at).toBeGreaterThan(0);
      expect(args[at - 1]).toBe('-c');
      expect(parseTomlAssignment(assignment)).toEqual({ key: ['developer_instructions'], value: text });
      expect(args).toContain('project_doc_fallback_filenames=["CLAUDE.md"]');
    }
  });

  it('an absent developer assignment drops its introducing -c, never another supplied flag', () => {
    expect(substituteArgs(['-c', '{developerInstructions}', '-c', '{skillCatalog}'], { skillCatalog: 'skills.include_instructions=false' }))
      .toEqual(['-c', 'skills.include_instructions=false']);
  });
});

describe('токен effort (спека нормалайзера модели и effort, 5.3)', () => {
  it('EFFORT_TOKEN принимает уровни каталогов и отвергает всё, что разорвало бы argv или TOML', () => {
    for (const level of ['low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'minimal', 'none', 'a', 'x_y-1', `a${'b'.repeat(31)}`]) {
      expect(EFFORT_TOKEN.test(level), level).toBe(true);
    }
    for (const level of ['hi gh', '"x', 'x"', 'High', 'HIGH', '', `a${'b'.repeat(32)}`, '1low', '-low', '_low', 'low\n', 'lo\\w', "lo'w"]) {
      expect(EFFORT_TOKEN.test(level), JSON.stringify(level)).toBe(false);
    }
  });

  it('уровни встроенного каталога — токены: их можно подставить и в кавычки TOML', () => {
    for (const entry of [PROVIDERS.claude, PROVIDERS.codex, PROVIDERS.glm]) {
      for (const model of selectableModels(entry) ?? []) {
        for (const level of model.efforts ?? []) {
          expect(EFFORT_TOKEN.test(level.id), `${entry.id} ${model.id}: ${level.id}`).toBe(true);
        }
      }
    }
  });

  it('substituteArgs не пускает значение, не прошедшее токен: ни в строку -c, ни целым элементом', () => {
    for (const effort of ['hi gh', '"x', 'x"', 'high" -c x="y', 'HIGH', '', `a${'b'.repeat(32)}`]) {
      const name = JSON.stringify(effort);
      expect(() => substituteArgs(['-c', 'model_reasoning_effort="{effort}"'], { effort }), name).toThrow(/effort/);
      expect(() => startCommand(PROVIDERS.codex, { effort, prompt: 'p' }), name).toThrow(/effort/);
      expect(() => startCommand(PROVIDERS.claude, { effort, prompt: 'p' }), name).toThrow(/effort/);
    }
    // Шаблон без {effort} не спасает: проверка идёт до любой подстановки.
    expect(() => substituteArgs(['{prompt}'], { effort: 'x"', prompt: 'p' })).toThrow(/effort/);
  });

  it('уровень-токен подставляется как есть, и новые уровни тоже: xhigh у Claude Code, ultra у Codex', () => {
    const claude = startCommand(PROVIDERS.claude, { effort: 'xhigh', prompt: 'p' }).args;
    expect(claude[claude.indexOf('--effort') + 1]).toBe('xhigh');
    expect(startCommand(PROVIDERS.codex, { effort: 'ultra', prompt: 'p' }).args).toContain(
      'model_reasoning_effort="ultra"',
    );
  });
});

describe('effortsFor: уровни для выбора модели (спека нормалайзера модели и effort, 5.1 и 5.3)', () => {
  const ids = (levels: { id: string }[] | null): string[] | null =>
    levels === null ? null : levels.map((level) => level.id);
  const FIVE = ['low', 'medium', 'high', 'xhigh', 'max'];

  /** Свой провайдер с `{model}` и `{effort}` в шаблоне и данным списком моделей. */
  const custom = (models: readonly ModelOption[] | null): ProviderEntry => ({
    id: 'мой',
    label: 'Мой',
    mark: 'Мо',
    hasHistory: false,
    linkBy: 'cwd+time',
    runner: { command: 'мой', args: ['--m', '{model}', '--e', '{effort}', '{prompt}'] },
    models,
  });

  it('Claude: у моделей пять уровней low…max, у Haiku — null', () => {
    for (const model of ['best', 'fable', 'sonnet', 'opus', 'sonnet[1m]', 'opus[1m]', 'opusplan', 'opusplan[1m]']) {
      expect(ids(effortsFor(PROVIDERS.claude, model)), model).toEqual(FIVE);
    }
    expect(effortsFor(PROVIDERS.claude, 'haiku')).toBeNull();
  });

  it('Codex: у Sol и Astra есть Ultra, у Luna — нет; уровни несут описания каталога', () => {
    for (const model of ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-sol', 'gpt-5.6-sol', 'gpt-5.6-terra']) {
      expect(ids(effortsFor(PROVIDERS.codex, model)), model).toEqual([...FIVE, 'ultra']);
    }
    for (const model of ['gpt-6-luna', 'gpt-5.6-luna']) {
      expect(ids(effortsFor(PROVIDERS.codex, model)), model).toEqual(FIVE);
    }
    expect(effortsFor(PROVIDERS.codex, 'gpt-6.1-sol')?.at(-1)).toEqual({
      id: 'ultra',
      label: 'Ultra',
      description: 'Maximum reasoning with automatic task delegation',
    });
  });

  it('«Default» — общие уровни моделей провайдера в порядке первой: Claude и GLM — low…max, Codex — без Ultra', () => {
    expect(ids(effortsFor(PROVIDERS.claude, undefined))).toEqual(FIVE);
    expect(ids(effortsFor(PROVIDERS.glm, undefined))).toEqual(FIVE);
    expect(ids(effortsFor(PROVIDERS.codex, undefined))).toEqual(FIVE);
  });

  it('список только из моделей без уровней (одна Haiku) или с пустым списком уровней — null', () => {
    const haikuOnly = custom([{ id: 'haiku', label: 'Haiku', efforts: null }]);
    expect(effortsFor(haikuOnly, undefined)).toBeNull();
    expect(effortsFor(haikuOnly, 'haiku')).toBeNull();
    // Пустой список — как null: явного уровня у такой модели не выбрать, окно поле прячет (`effortChoices`).
    const bare = custom([{ id: 'bare', label: 'Bare', efforts: [] }]);
    expect(effortsFor(bare, 'bare')).toBeNull();
    expect(effortsFor(bare, undefined)).toBeNull();
  });

  it('модель без поля efforts (свой список) — прежние три уровня; в пересечении «Default» — тоже они', () => {
    const entry = custom([
      { id: 'a', label: 'А' },
      { id: 'b', label: 'Б', efforts: [{ id: 'high', label: 'High' }, { id: 'max', label: 'Max' }] },
    ]);
    expect(ids(effortsFor(entry, 'a'))).toEqual(['low', 'medium', 'high']);
    expect(ids(effortsFor(entry, undefined))).toEqual(['high']);
  });

  it('общих уровней нет — у «Default» null', () => {
    const entry = custom([
      { id: 'a', label: 'А', efforts: [{ id: 'low', label: 'Low' }] },
      { id: 'b', label: 'Б', efforts: [{ id: 'high', label: 'High' }] },
    ]);
    expect(effortsFor(entry, undefined)).toBeNull();
  });

  it('провайдер без списка моделей и модель вне списка — прежние low, medium, high', () => {
    expect(ids(effortsFor(custom(null), undefined))).toEqual(['low', 'medium', 'high']);
    expect(ids(effortsFor(custom(null), 'что-угодно'))).toEqual(['low', 'medium', 'high']);
    expect(ids(effortsFor(PROVIDERS.claude, 'claude-opus-5-5'))).toEqual(['low', 'medium', 'high']);
  });

  it('провайдер без {effort} в шаблоне — null при любой модели', () => {
    const modelOnly: ProviderEntry = {
      ...PROVIDERS.claude,
      runner: { command: 'claude', args: ['--model', '{model}', '{prompt}'] },
    };
    expect(effortsFor(modelOnly, 'opus')).toBeNull();
    expect(effortsFor(modelOnly, undefined)).toBeNull();
  });

  it('отдаётся копия: правка ответа каталог не меняет', () => {
    const opus = effortsFor(PROVIDERS.claude, 'opus');
    if (opus === null || opus[0] === undefined) throw new Error('у opus нет уровней');
    opus[0].label = 'испорчено';
    opus.pop();
    const legacy = effortsFor(custom(null), undefined);
    legacy?.pop();

    expect(effortsFor(PROVIDERS.claude, 'opus')?.[0]?.label).toBe('Low');
    expect(ids(effortsFor(PROVIDERS.claude, 'opus'))).toEqual(FIVE);
    expect(ids(effortsFor(custom(null), undefined))).toEqual(['low', 'medium', 'high']);
  });
});

describe('resolveModelEffort: пара модели и effort для окна и MCP (спека нормалайзера модели и effort, 5.3)', () => {
  it('пустые строки и отсутствие полей — «Default»: в ответе полей нет вовсе', () => {
    expect(resolveModelEffort(PROVIDERS.claude, {})).toStrictEqual({ choice: {} });
    expect(resolveModelEffort(PROVIDERS.claude, { model: '', effort: '' })).toStrictEqual({ choice: {} });
    expect(resolveModelEffort(PROVIDERS.codex, { model: 'gpt-6-luna', effort: '' })).toStrictEqual({
      choice: { model: 'gpt-6-luna' },
    });
  });

  it('пара из каталога проходит как есть; при «Default» модели — общий уровень', () => {
    expect(resolveModelEffort(PROVIDERS.claude, { model: 'opus', effort: 'max' })).toStrictEqual({
      choice: { model: 'opus', effort: 'max' },
    });
    expect(resolveModelEffort(PROVIDERS.codex, { model: 'gpt-6.1-sol', effort: 'ultra' })).toStrictEqual({
      choice: { model: 'gpt-6.1-sol', effort: 'ultra' },
    });
    expect(resolveModelEffort(PROVIDERS.glm, { effort: 'xhigh' })).toStrictEqual({ choice: { effort: 'xhigh' } });
    expect(resolveModelEffort(PROVIDERS.claude, { model: 'haiku' })).toStrictEqual({ choice: { model: 'haiku' } });
  });

  it('модель — по правилу modelChoiceError: та же причина со списком допустимых', () => {
    expect(resolveModelEffort(PROVIDERS.claude, { model: 'gpt-6-sol', effort: 'high' })).toEqual({
      error: modelChoiceError(PROVIDERS.claude, 'gpt-6-sol'),
    });
    expect(resolveModelEffort(PROVIDERS.claude, { model: '--effort' })).toEqual({
      error: modelChoiceError(PROVIDERS.claude, '--effort'),
    });
  });

  it('effort не токен — ошибка, с уровнями модели, если они есть; даже у провайдера без {effort}', () => {
    for (const effort of ['hi gh', '"x', 'x"', 'High', 'x'.repeat(33)]) {
      expect(resolveModelEffort(PROVIDERS.claude, { model: 'opus', effort }), effort).toEqual({
        error: `effort ${JSON.stringify(effort)} is not a level name; allowed: low, medium, high, xhigh, max`,
      });
    }
    const plain: ProviderEntry = { ...PROVIDERS.claude, runner: { command: 'claude', args: ['{prompt}'] } };
    expect(resolveModelEffort(plain, { effort: 'x"' })).toEqual({
      error: `effort ${JSON.stringify('x"')} is not a level name`,
    });
  });

  it('провайдер без {effort} в шаблоне отбрасывает уровень молча, без {model} — и модель', () => {
    const plain: ProviderEntry = { ...PROVIDERS.claude, runner: { command: 'claude', args: ['{prompt}'] } };
    expect(resolveModelEffort(plain, { model: 'anything', effort: 'high' })).toStrictEqual({ choice: {} });
    const modelOnly: ProviderEntry = {
      ...PROVIDERS.claude,
      runner: { command: 'claude', args: ['--model', '{model}', '{prompt}'] },
    };
    expect(resolveModelEffort(modelOnly, { model: 'opus', effort: 'ultra' })).toStrictEqual({
      choice: { model: 'opus' },
    });
  });

  it('у модели без уровней — «omit effort», и у «Default», когда уровней нет ни у одной модели', () => {
    expect(resolveModelEffort(PROVIDERS.claude, { model: 'haiku', effort: 'low' })).toEqual({
      error: 'haiku has no effort levels; omit effort',
    });
    const haikuOnly: ProviderEntry = { ...PROVIDERS.claude, models: [{ id: 'haiku', label: 'Haiku', efforts: null }] };
    expect(resolveModelEffort(haikuOnly, { effort: 'low' })).toEqual({
      error: 'the default model has no effort levels; omit effort',
    });
  });

  it('уровень не из списка модели — ошибка с её уровнями; у «Default» — с общими', () => {
    expect(resolveModelEffort(PROVIDERS.codex, { model: 'gpt-6-luna', effort: 'ultra' })).toEqual({
      error: 'ultra is not a level of gpt-6-luna; allowed: low, medium, high, xhigh, max',
    });
    expect(resolveModelEffort(PROVIDERS.codex, { effort: 'ultra' })).toEqual({
      error: 'ultra is not a level of the default model; allowed: low, medium, high, xhigh, max',
    });
    expect(resolveModelEffort(PROVIDERS.claude, { model: 'opus', effort: 'minimal' })).toEqual({
      error: 'minimal is not a level of opus; allowed: low, medium, high, xhigh, max',
    });
  });

  it('свой список без уровней — прежние low, medium, high', () => {
    const mine: ProviderEntry = { ...PROVIDERS.claude, models: [{ id: 'mine', label: 'Моя' }] };
    expect(resolveModelEffort(mine, { model: 'mine', effort: 'medium' })).toStrictEqual({
      choice: { model: 'mine', effort: 'medium' },
    });
    expect(resolveModelEffort(mine, { model: 'mine', effort: 'xhigh' })).toEqual({
      error: 'xhigh is not a level of mine; allowed: low, medium, high',
    });
  });
});
