import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CUSTOM_MIN_VERSION,
  CUSTOM_PROVIDER_PREFIX,
  baseUrlError,
  customProviderDir,
  customProviderEntry,
  customProviderSecret,
  customProvidersFile,
  isCustomProviderId,
  isLoopbackUrl,
  readCustomProviders,
  slugProviderId,
  writeCustomProviders,
  type CustomProviderRecord,
} from './custom-providers.js';
import { PROVIDERS, claudeConfigDirFor, isClaudeCode, loadProviders } from './providers.js';

const kimi: CustomProviderRecord = {
  id: 'custom-kimi',
  label: 'Kimi',
  preset: 'kimi',
  baseUrl: 'https://api.moonshot.ai/anthropic',
  auth: 'bearer',
  models: { opus: 'kimi-k3[1m]', sonnet: 'kimi-k3[1m]', haiku: 'kimi-k2.7-code', subagent: 'kimi-k3[1m]' },
  contextWindow: 1_000_000,
  linkClaude: true,
};

let home: string;
beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'parley-custom-'));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('customProviderEntry', () => {
  it('строится по раннеру GLM, со своей папкой и картой слотов (спека 5.1, 5.2)', () => {
    const entry = customProviderEntry(kimi, home);
    expect(entry.family).toBe('claude');
    expect(entry.runner.args).toEqual(PROVIDERS.glm.runner.args);
    expect(entry.runner.configDir).toBe(path.join(home, 'providers', 'custom-kimi'));
    expect(entry.runner.secret).toBe('custom:custom-kimi');
    expect(entry.runner.auth).toBe('bearer');
    expect(entry.runner.minVersion).toBe('2.1.302');
    expect(entry.runner.settingsModel).toBe('kimi-k3[1m]');
    expect(entry.runner.env).toMatchObject({
      CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: '1',
      ANTHROPIC_BASE_URL: 'https://api.moonshot.ai/anthropic',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'kimi-k3[1m]',
      ANTHROPIC_DEFAULT_FABLE_MODEL: 'kimi-k3[1m]',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'kimi-k3[1m]',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'kimi-k2.7-code',
      CLAUDE_CODE_SUBAGENT_MODEL: 'kimi-k3[1m]',
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: '1000000',
    });
    expect(Object.keys(entry.runner.env!).some((name) => /KEY|TOKEN/.test(name))).toBe(false);
    expect(entry.models?.map((m) => m.id)).toEqual(['kimi-k3[1m]', 'kimi-k2.7-code']);
    expect(entry.custom).toEqual(kimi);
  });
  it('без размера контекста окна сжатия нет; у loopback ключ не обязателен', () => {
    const entry = customProviderEntry(
      { ...kimi, contextWindow: null, baseUrl: 'http://localhost:4000' },
      home,
    );
    expect(entry.runner.env).not.toHaveProperty('CLAUDE_CODE_AUTO_COMPACT_WINDOW');
    expect(entry.runner.keyOptional).toBe(true);
    expect(customProviderEntry(kimi, home).runner.keyOptional).toBeUndefined();
  });
});

describe('loadProviders со своими провайдерами', () => {
  it('добавляет свои записи; запись без префикса custom- отбрасывается при чтении', async () => {
    const file = path.join(home, 'custom-providers.json');
    await writeCustomProviders([kimi, { ...kimi, id: 'glm' }], file);
    const registry = await loadProviders(path.join(home, 'none.json'), path.join(home, 'none2.json'), file);
    expect(registry['custom-kimi']?.custom?.label).toBe('Kimi');
    expect(registry['glm']).toEqual((await loadProviders(path.join(home, 'none.json'), path.join(home, 'none2.json'), path.join(home, 'absent.json')))['glm']);
    // providers.json существует, файл своих провайдеров всё равно читается
    const pj = path.join(home, 'providers.json');
    await writeFile(pj, JSON.stringify({ codex: { badge: 'Cx' } }));
    expect((await loadProviders(pj, path.join(home, 'none2.json'), file))['custom-kimi']).toBeDefined();
  });
  it('id с префиксом custom- в providers.json — ошибка', async () => {
    const pj = path.join(home, 'providers.json');
    await writeFile(pj, JSON.stringify({ 'custom-x': { badge: 'X', command: 'x' } }));
    await expect(loadProviders(pj, path.join(home, 'n.json'), path.join(home, 'c.json'))).rejects.toThrow(
      /custom- prefix is reserved/,
    );
  });
  it('без файла своих провайдеров — реестр побайтно прежний', async () => {
    const pj = path.join(home, 'providers.json');
    const cx = path.join(home, 'cx.json');
    const missing = path.join(home, 'missing.json');
    const emptyFile = path.join(home, 'empty.json');
    await writeCustomProviders([], emptyFile);
    const before = await loadProviders(pj, cx, missing);
    expect(before).toEqual(await loadProviders(pj, cx, emptyFile));
    expect(Object.keys(before).sort()).toEqual(Object.keys(PROVIDERS).sort());
    expect(JSON.stringify(before)).toBe(JSON.stringify(await loadProviders(pj, cx, emptyFile)));
  });
});

describe('семейство и папка настроек', () => {
  it('isClaudeCode по строке узнаёт custom-*, в том числе удалённый (Review Focus 4)', async () => {
    expect(isClaudeCode('custom-kimi')).toBe(true);
    const registry = await loadProviders(path.join(home, 'a.json'), path.join(home, 'b.json'), path.join(home, 'c.json'));
    expect(registry['custom-kimi']).toBeUndefined();
    expect(isClaudeCode('custom-kimi')).toBe(true);
    expect(isClaudeCode('codex')).toBe(false);
  });
  it('claudeConfigDirFor: своя папка у custom, undefined у GLM, env у claude', () => {
    const env = { CLAUDE_CONFIG_DIR: '/x' };
    expect(claudeConfigDirFor(customProviderEntry(kimi, home), env)).toBe(path.join(home, 'providers', 'custom-kimi'));
    expect(claudeConfigDirFor(PROVIDERS.glm, env)).toBeUndefined();
    expect(claudeConfigDirFor(PROVIDERS.claude, env)).toBe('/x');
  });
});

describe('вспомогательное', () => {
  it('пути, секрет, префикс', () => {
    expect(CUSTOM_PROVIDER_PREFIX).toBe('custom-');
    expect(CUSTOM_MIN_VERSION).toBe('2.1.302');
    expect(isCustomProviderId('custom-a')).toBe(true);
    expect(isCustomProviderId('glm')).toBe(false);
    expect(customProvidersFile(home)).toBe(path.join(home, 'custom-providers.json'));
    expect(customProviderDir('custom-a', home)).toBe(path.join(home, 'providers', 'custom-a'));
    expect(customProviderSecret('custom-a')).toBe('custom:custom-a');
  });
  it('baseUrlError: http на удалённый адрес, логин в URL, ? и # — ошибка; http://localhost:4000 — можно', () => {
    expect(baseUrlError('https://api.kimi.com/coding/')).toBeNull();
    expect(baseUrlError('http://localhost:4000')).toBeNull();
    expect(baseUrlError('http://127.0.0.1:4000')).toBeNull();
    expect(baseUrlError('http://[::1]:4000')).toBeNull();
    expect(baseUrlError('http://example.com')).not.toBeNull();
    expect(baseUrlError('https://user:pw@example.com')).not.toBeNull();
    expect(baseUrlError('https://example.com/a?x=1')).not.toBeNull();
    expect(baseUrlError('https://example.com/a#h')).not.toBeNull();
    expect(baseUrlError('ftp://example.com')).not.toBeNull();
    expect(baseUrlError('not a url')).not.toBeNull();
    expect(isLoopbackUrl('http://localhost:1')).toBe(true);
    expect(isLoopbackUrl('https://example.com')).toBe(false);
  });
  it('slugProviderId: «Corp LLM» → custom-corp-llm; занято → -2; «Кими» → custom-provider', () => {
    expect(slugProviderId('Corp LLM', new Set())).toBe('custom-corp-llm');
    expect(slugProviderId('Corp LLM', new Set(['custom-corp-llm']))).toBe('custom-corp-llm-2');
    expect(slugProviderId('Corp LLM', new Set(['custom-corp-llm', 'custom-corp-llm-2']))).toBe('custom-corp-llm-3');
    expect(slugProviderId('Кими', new Set())).toBe('custom-provider');
    expect(slugProviderId('x'.repeat(60), new Set())).toBe(`custom-${'x'.repeat(24)}`);
  });
});

describe('файл своих провайдеров', () => {
  it('нет файла или битый JSON → []; неверная запись пропускается; запись атомарна', async () => {
    const file = path.join(home, 'custom-providers.json');
    expect(await readCustomProviders(file)).toEqual([]);
    await writeFile(file, '{oops');
    expect(await readCustomProviders(file)).toEqual([]);
    await writeFile(file, JSON.stringify({ version: 1, providers: [kimi, { id: 'custom-bad' }, { ...kimi, id: 'glm' }] }));
    expect((await readCustomProviders(file)).map((r) => r.id)).toEqual(['custom-kimi']);
    await writeCustomProviders([kimi], file);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ version: 1, providers: [kimi] });
    expect(await readCustomProviders(file)).toEqual([kimi]);
  });
});

describe('строгая проверка записей (замечания рецензии)', () => {
  it('baseUrlError: краевые пробелы и пробел в пути — ошибка', () => {
    expect(baseUrlError('https://a.com ')).not.toBeNull();
    expect(baseUrlError(' https://a.com')).not.toBeNull();
    expect(baseUrlError('https://a.com/a b')).not.toBeNull();
  });
  it('customProviderDir бросает на id с выходом из папки', () => {
    expect(() => customProviderDir('custom-/../../../.claude', home)).toThrow(/Invalid custom provider id/);
    expect(customProviderDir('custom-kimi', home)).toBe(path.join(home, 'providers', 'custom-kimi'));
  });
  it('чтение пропускает опасные и слабые записи, дубль id — побеждает первая', async () => {
    const file = path.join(home, 'strict.json');
    const bad: unknown[] = [
      { ...kimi, id: 'custom-/../../../.claude' },
      { ...kimi, id: 'custom-a', baseUrl: 'http://evil.example.com' },
      { ...kimi, id: 'custom-b', baseUrl: 'https://u:p@a.com' },
      { ...kimi, id: 'custom-c', models: { ...kimi.models, opus: '--flag' } },
      { ...kimi, id: 'custom-d', models: { ...kimi.models, opus: 'a b' } },
      { ...kimi, id: 'custom-e', contextWindow: -5 },
      { ...kimi, id: 'custom-f', contextWindow: 1.5 },
      { ...kimi, id: 'custom-g', label: '   ' },
      { ...kimi, label: 'Second' },
    ];
    await writeFile(file, JSON.stringify({ version: 1, providers: [kimi, ...bad] }));
    const read = await readCustomProviders(file);
    expect(read.map((r) => r.id)).toEqual(['custom-kimi', 'custom-kimi']);
    const registry = await loadProviders(path.join(home, 'n1.json'), path.join(home, 'n2.json'), file);
    expect(registry['custom-kimi']?.custom?.label).toBe('Kimi');
  });
  it('метка из эмодзи не режет суррогатную пару', () => {
    expect(customProviderEntry({ ...kimi, label: '😀😀x' }, home).mark).toBe('😀😀');
  });
});
