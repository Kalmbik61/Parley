import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadProviders, selectableModels } from '@parley/core';
import type { ProviderEntry } from '@parley/core';
import type { Log } from '../log.js';
import {
  CODEX_CATALOG_MAX_AGE_MS,
  parseCodexCatalog,
  probeCodexCatalog,
  startCodexCatalog,
} from './codex-catalog.js';

/**
 * Настоящий codex здесь не запускается никогда, даже с `debug models`: проба зовётся либо с подменой
 * (`probe`), либо на выдуманную команду, чья переменная-оверрайд (`PARLEY_<ИМЯ>_BIN`) указывает на
 * скрипт-заглушку во временном каталоге.
 */
const COMMAND = 'parley-fake-codex';
const OVERRIDE = 'PARLEY_PARLEY_FAKE_CODEX_BIN';

/** Уровни моделей каталога — как их печатает Codex 0.160 (2026-10-06). */
const LEVELS = [
  { effort: 'low', description: 'Fast responses with lighter reasoning' },
  { effort: 'medium', description: 'Balances speed and reasoning depth for everyday tasks' },
  { effort: 'high', description: 'Greater reasoning depth for complex problems' },
  { effort: 'xhigh', description: 'Extra high reasoning depth for complex problems' },
  { effort: 'max', description: 'Maximum reasoning depth for the hardest problems' },
  { effort: 'ultra', description: 'Maximum reasoning with automatic task delegation' },
];
const WITHOUT_ULTRA = LEVELS.slice(0, 5);

/**
 * Модели урезанного настоящего вывода `codex debug models` (целиком — около 600 КБ, десять моделей): три
 * видимые, одна из них без `ultra`, и одна скрытая. Лишние поля оставлены: разбор их не читает.
 */
const ASTRA = {
  slug: 'gpt-6-astra',
  display_name: 'GPT-6-Astra',
  description: 'Frontier intelligence for the most demanding work.',
  default_reasoning_level: 'medium',
  supported_reasoning_levels: LEVELS,
  shell_type: 'unified_exec',
  visibility: 'list',
  supported_in_api: true,
  priority: 2,
  context_window: 272000,
  input_modalities: ['text', 'image'],
  truncation_policy: { mode: 'tokens', limit: 10000 },
  supports_reasoning_effort_updates: true,
};
const RESERVE = {
  slug: 'gpt-reserve',
  display_name: 'GPT-Reserve',
  description: 'Fast and affordable agentic coding model.',
  default_reasoning_level: 'medium',
  supported_reasoning_levels: WITHOUT_ULTRA,
  visibility: 'hide',
  priority: 4,
  supports_reasoning_effort_updates: false,
};
const LUNA = {
  slug: 'gpt-6-luna',
  display_name: 'GPT-6-Luna',
  description: 'Fast and affordable model for easier tasks.',
  default_reasoning_level: 'medium',
  supported_reasoning_levels: WITHOUT_ULTRA,
  visibility: 'list',
  priority: 4,
  context_window: 272000,
};
const SOL = {
  slug: 'gpt-6.1-sol',
  display_name: 'GPT-6.1-Sol',
  description: 'Latest workhorse model for coding and everyday work.',
  default_reasoning_level: 'medium',
  supported_reasoning_levels: LEVELS,
  shell_type: 'unified_exec',
  visibility: 'list',
  priority: 0,
  base_instructions: 'You are Codex, a coding agent.',
};
/** Вывод целиком: модели не по порядку `priority`, скрытая — между видимыми. */
const CATALOG = JSON.stringify({ models: [ASTRA, RESERVE, LUNA, SOL] });

/** Подписи уровней по п. 5.1 спеки. */
const LABELS: Record<string, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
  ultra: 'Ultra',
};
/** Уровни, как их получит окно: id, подпись и описание из каталога. */
const efforts = (levels: ReadonlyArray<{ effort: string; description: string }>): unknown[] =>
  levels.map(({ effort, description }) => ({ id: effort, label: LABELS[effort], description }));

let dir = '';
let home = '';

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'parley-codex-catalog-'));
  home = await mkdtemp(path.join(tmpdir(), 'parley-codex-catalog-home-'));
  process.env['PARLEY_HOME'] = home;
});

afterEach(async () => {
  delete process.env[OVERRIDE];
  delete process.env['PARLEY_HOME'];
  await Promise.all([dir, home].map((item) => rm(item, { recursive: true, force: true })));
});

const silentLog = (): Log & { warnings: Array<{ message: string; data: object | undefined }> } => {
  const warnings: Array<{ message: string; data: object | undefined }> = [];
  return {
    info: () => {},
    warn: (message: string, data?: object) => void warnings.push({ message, data }),
    error: () => {},
    warnings,
  };
};

const writeProviders = (data: unknown): Promise<void> =>
  writeFile(path.join(home, 'providers.json'), JSON.stringify(data), 'utf8');

/** Модели `codex` так, как их видят окно, хост и MCP: реестр `loadProviders` вместе с файлом каталога. */
async function codexModels(): Promise<unknown> {
  return selectableModels((await loadProviders())['codex'] as ProviderEntry);
}

/** Файл каталога в доме теста — `codexModelsFile()` при `PARLEY_HOME = home`. */
const catalogFile = (): string => path.join(home, 'codex-models.json');

/**
 * Заглушка вместо codex, как в `versions.test.ts`: свежий исполняемый файл macOS проверяет при первом запуске
 * дольше таймаута пробы, поэтому заглушка сперва запускается впрок (`--warm`).
 */
async function stub(body: string): Promise<void> {
  const file = path.join(dir, 'fake-codex');
  await writeFile(file, `#!/bin/sh\n[ "$1" = "--warm" ] && exit 0\n${body}\n`, 'utf8');
  await chmod(file, 0o755);
  await promisify(execFile)(file, ['--warm'], { timeout: 30_000 });
  process.env[OVERRIDE] = file;
}

/** Ход цикла событий: после вызова пробы фоновая работа каталога — одни микрозадачи. */
const settled = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('parseCodexCatalog: каталог из вывода `codex debug models`', () => {
  it('видимые модели в порядке priority; id, подпись и уровни с описаниями; прочие поля не читаются', () => {
    expect(parseCodexCatalog(CATALOG)).toEqual([
      { id: 'gpt-6.1-sol', label: 'GPT-6.1-Sol', efforts: efforts(LEVELS) },
      { id: 'gpt-6-astra', label: 'GPT-6-Astra', efforts: efforts(LEVELS) },
      { id: 'gpt-6-luna', label: 'GPT-6-Luna', efforts: efforts(WITHOUT_ULTRA) },
    ]);
  });

  it('не JSON, не та форма, пустой список и одни скрытые модели — null', () => {
    const outputs = [
      'Error: not logged in',
      '',
      '[]',
      JSON.stringify({ models: 'x' }),
      JSON.stringify({ models: [] }),
      JSON.stringify({ models: [RESERVE] }),
    ];
    for (const stdout of outputs) expect(parseCodexCatalog(stdout), stdout).toBeNull();
  });

  it('модель с уровнем не по токену выбрасывается с предупреждением, соседние остаются', () => {
    const log = silentLog();
    const spaced = {
      ...SOL,
      slug: 'gpt-spaced',
      supported_reasoning_levels: [{ effort: 'low', description: 'x' }, { effort: 'Extra High', description: 'x' }],
    };
    const quoted = { ...SOL, slug: 'gpt-quoted', supported_reasoning_levels: [{ effort: 'max"', description: 'x' }] };

    const parsed = parseCodexCatalog(JSON.stringify({ models: [spaced, quoted, LUNA] }), log);

    expect(parsed?.map((model) => model.id)).toEqual(['gpt-6-luna']);
    expect(log.warnings.map((warning) => warning.data)).toEqual([{ slug: 'gpt-spaced' }, { slug: 'gpt-quoted' }]);
  });

  it('id модели — правило `--model` core: с дефиса, с пробелом, пустой и длиннее 200 — модель выбрасывается; повтор slug — тоже', () => {
    const kept = (slug: string): boolean => parseCodexCatalog(JSON.stringify({ models: [{ ...LUNA, slug }] })) !== null;
    for (const slug of ['gpt-6.1-sol', 'a-b', 'sonnet[1m]', 'x'.repeat(200)]) expect(kept(slug), slug).toBe(true);
    // С дефиса CLI принял бы модель за флаг, с пробелом она ушла бы двумя аргументами `--model`.
    for (const slug of ['-gpt', '--model', 'gpt 6', 'gpt\t6', ' gpt', '', 'x'.repeat(201)]) {
      expect(kept(slug), JSON.stringify(slug)).toBe(false);
    }
    // Повтор slug: core не примет файл с двумя одинаковыми id, поэтому вторая запись выбрасывается здесь.
    const log = silentLog();
    const twice = parseCodexCatalog(JSON.stringify({ models: [SOL, { ...LUNA, slug: 'gpt-6.1-sol' }] }), log);
    expect(twice?.map((model) => [model.id, model.label])).toEqual([['gpt-6.1-sol', 'GPT-6.1-Sol']]);
    expect(log.warnings.map((warning) => warning.data)).toEqual([{ slug: 'gpt-6.1-sol' }]);
  });

  it('внешний ввод: display_name длиннее 100 и описание длиннее 300 знаков обрезаются; незнакомый уровень turbo — «Turbo», id как есть', () => {
    const long = {
      ...LUNA,
      display_name: 'L'.repeat(150),
      supported_reasoning_levels: [{ effort: 'turbo', description: 'd'.repeat(400) }],
    };

    expect(parseCodexCatalog(JSON.stringify({ models: [long] }))).toEqual([
      {
        id: 'gpt-6-luna',
        label: 'L'.repeat(100),
        efforts: [{ id: 'turbo', label: 'Turbo', description: 'd'.repeat(300) }],
      },
    ]);
  });

  it('модель без уровней — effort у неё нет (null), как у Haiku', () => {
    expect(parseCodexCatalog(JSON.stringify({ models: [{ ...LUNA, supported_reasoning_levels: [] }] }))).toEqual([
      { id: 'gpt-6-luna', label: 'GPT-6-Luna', efforts: null },
    ]);
  });
});

describe('probeCodexCatalog: одна проба `<команда> debug models`', () => {
  it('отдаёт вывод как есть; зовётся ровно с двумя аргументами debug models', async () => {
    const catalogFile = path.join(dir, 'catalog.json');
    const argvFile = path.join(dir, 'argv.txt');
    await writeFile(catalogFile, CATALOG, 'utf8');
    await stub(`echo "$#:$1:$2" > "${argvFile}"; cat "${catalogFile}"`);

    expect(await probeCodexCatalog(COMMAND)).toBe(CATALOG);
    expect((await readFile(argvFile, 'utf8')).trim()).toBe('2:debug:models');
  });

  it('ненулевой выход и нет бинаря — null', async () => {
    await stub(`echo '{"models":[]}'; exit 1`);
    expect(await probeCodexCatalog(COMMAND)).toBeNull();
    process.env[OVERRIDE] = path.join(dir, 'нет-такого');
    expect(await probeCodexCatalog(COMMAND)).toBeNull();
  });

  it('зависший бинарь обрывается по таймауту — null', async () => {
    await stub('exec sleep 30');
    const started = Date.now();
    // Таймаут с запасом: под нагрузкой оболочка стартует не сразу.
    expect(await probeCodexCatalog(COMMAND, 1500)).toBeNull();
    expect(Date.now() - started).toBeLessThan(6000);
  });

  it('вывод больше 4 МБ — null: такой каталог не разбирается', async () => {
    await stub('yes x | head -c 5000000');
    expect(await probeCodexCatalog(COMMAND)).toBeNull();
  });
});

describe('startCodexCatalog: проба на старте, перепроба по возрасту', () => {
  it('без пробы (тесты, PARLEY_SKIP_VERSION_PROBE) каталога нет и ничего не запускается', async () => {
    let changes = 0;
    const catalog = startCodexCatalog(undefined, silentLog(), () => {
      changes += 1;
    });
    await catalog.ready;
    catalog.refreshIfStale();
    expect(catalog.current()).toBeNull();
    expect(changes).toBe(0);
  });

  it('первая проба — сразу, по команде записи codex; каталог разобран, onChange один раз', async () => {
    const calls: string[] = [];
    let changes = 0;
    const catalog = startCodexCatalog(
      async (command) => {
        calls.push(command);
        return CATALOG;
      },
      silentLog(),
      () => {
        changes += 1;
      },
    );
    await catalog.ready;

    expect(calls).toEqual(['codex']);
    expect(changes).toBe(1);
    expect(catalog.current()).toEqual(parseCodexCatalog(CATALOG));
  });

  it('свой command у codex в providers.json — проба зовёт его', async () => {
    await writeProviders({ codex: { command: 'my-codex' } });
    const calls: string[] = [];
    const catalog = startCodexCatalog(
      async (command) => {
        calls.push(command);
        return CATALOG;
      },
      silentLog(),
      () => {},
    );
    await catalog.ready;
    expect(calls).toEqual(['my-codex']);
  });

  it('проба не ответила, упала, вывод не JSON или без видимых моделей — каталога нет, предупреждение, onChange нет', async () => {
    const outcomes: Array<() => Promise<string | null>> = [
      async () => null,
      async () => {
        throw new Error('нет бинаря');
      },
      async () => 'Error: not logged in',
      async () => JSON.stringify({ models: [] }),
      async () => JSON.stringify({ models: [RESERVE] }),
    ];
    for (const outcome of outcomes) {
      const log = silentLog();
      let changes = 0;
      const catalog = startCodexCatalog(outcome, log, () => {
        changes += 1;
      });
      await catalog.ready;
      expect(catalog.current()).toBeNull();
      expect(changes).toBe(0);
      expect(log.warnings).toHaveLength(1);
    }
  });

  it('перепроба по возрасту: раньше 6 часов не идёт, после — одна на два вызова; onChange — только если каталог другой', async () => {
    let clock = 1_000;
    let stdout: string | null = CATALOG;
    const calls: string[] = [];
    let changes = 0;
    const log = silentLog();
    const catalog = startCodexCatalog(
      async (command) => {
        calls.push(command);
        return stdout;
      },
      log,
      () => {
        changes += 1;
      },
      { now: () => clock },
    );
    await catalog.ready;
    expect(changes).toBe(1);

    // Каталог свежий: проба не повторяется.
    clock += CODEX_CATALOG_MAX_AGE_MS - 1;
    catalog.refreshIfStale();
    expect(calls).toHaveLength(1);

    // Устарел: два вызова подряд — одна проба; ответ тот же — onChange нет.
    clock += 1;
    catalog.refreshIfStale();
    catalog.refreshIfStale();
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    await settled();
    expect(changes).toBe(1);

    // Снова устарел, а проба не ответила: прежний каталог остаётся, в журнале предупреждение.
    stdout = null;
    clock += CODEX_CATALOG_MAX_AGE_MS;
    catalog.refreshIfStale();
    await vi.waitFor(() => expect(calls).toHaveLength(3));
    await settled();
    expect(catalog.current()?.map((model) => model.id)).toEqual(['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-luna']);
    expect(await codexModels()).toEqual(parseCodexCatalog(CATALOG));
    expect(changes).toBe(1);
    expect(log.warnings).toHaveLength(1);

    // Каталог другой — onChange и новый список.
    stdout = JSON.stringify({ models: [LUNA] });
    clock += CODEX_CATALOG_MAX_AGE_MS;
    catalog.refreshIfStale();
    await vi.waitFor(() => expect(changes).toBe(2));
    expect(catalog.current()?.map((model) => model.id)).toEqual(['gpt-6-luna']);
    expect(await codexModels()).toEqual(parseCodexCatalog(JSON.stringify({ models: [LUNA] })));
  });
});

describe('файл каталога: один список для окна, хоста и MCP (спека 5.2)', () => {
  it('удачная проба пишет { fetchedAt, models } атомарно, и loadProviders отдаёт эти модели у codex', async () => {
    const catalog = startCodexCatalog(async () => CATALOG, silentLog(), () => {}, {
      now: () => Date.parse('2026-10-06T10:00:00.000Z'),
    });
    await catalog.ready;

    expect(JSON.parse(await readFile(catalogFile(), 'utf8'))).toEqual({
      fetchedAt: '2026-10-06T10:00:00.000Z',
      models: parseCodexCatalog(CATALOG),
    });
    // Временный файл записи не остаётся.
    expect((await readdir(home)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    expect(await codexModels()).toEqual(parseCodexCatalog(CATALOG));
  });

  it('тот же список, что в файле, — файл не переписывается, onChange нет', async () => {
    await writeFile(catalogFile(), JSON.stringify({ fetchedAt: 'прежний', models: parseCodexCatalog(CATALOG) }), 'utf8');
    let changes = 0;
    const catalog = startCodexCatalog(async () => CATALOG, silentLog(), () => {
      changes += 1;
    });
    await catalog.ready;

    expect(changes).toBe(0);
    expect((JSON.parse(await readFile(catalogFile(), 'utf8')) as { fetchedAt: string }).fetchedAt).toBe('прежний');
  });

  it('сбой пробы файл не трогает: прежний каталог остаётся у всех', async () => {
    const before = JSON.stringify({ fetchedAt: 'прежний', models: [{ id: 'gpt-7-nova', label: 'GPT-7-Nova', efforts: null }] });
    await writeFile(catalogFile(), before, 'utf8');
    const catalog = startCodexCatalog(async () => null, silentLog(), () => {});
    await catalog.ready;

    expect(await readFile(catalogFile(), 'utf8')).toBe(before);
    expect(await codexModels()).toEqual([{ id: 'gpt-7-nova', label: 'GPT-7-Nova', efforts: null }]);
  });

  it('свой список codex из providers.json важнее файла каталога', async () => {
    await writeProviders({ codex: { models: [{ id: 'my-codex', label: 'Мой' }] } });
    const catalog = startCodexCatalog(async () => CATALOG, silentLog(), () => {});
    await catalog.ready;

    expect(await codexModels()).toEqual([{ id: 'my-codex', label: 'Мой' }]);
  });
});
