import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ACCOUNT_MIN_VERSION_CLAUDE,
  CUSTOM_MIN_VERSION,
  CUSTOM_PROVIDER_PREFIX,
  accountLabel,
  accountProviderEntry,
  baseUrlError,
  customProviderDir,
  customProviderEntry,
  customProviderSecret,
  customProvidersFile,
  defaultAccountLabel,
  isAccountRecord,
  isCustomProviderId,
  isLoopbackUrl,
  isManagedProviderId,
  isValidCustomProviderId,
  readCustomProviders,
  slugProviderId,
  writeCustomProviders,
  type CustomAccountRecord,
  type CustomEndpointRecord,
} from './custom-providers.js';
import { PROVIDERS, claudeConfigDirFor, isClaudeCode, loadProviders } from './providers.js';

const kimi: CustomEndpointRecord = {
  kind: 'endpoint',
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
      /the custom- and codex- prefixes are reserved/,
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

describe('запись аккаунта (спека подписок 5.1)', () => {
  const account: CustomAccountRecord = { kind: 'claude-account', id: 'custom-claude-2', label: '', link: true };
  const none = (name: string): string => path.join(home, name);

  it('asRecord: запись без kind — endpoint; claude-account без адреса и ключа', async () => {
    const file = path.join(home, 'custom-providers.json');
    const legacy: Record<string, unknown> = { ...kimi };
    delete legacy['kind'];
    await writeFile(file, JSON.stringify({ version: 1, providers: [legacy, account] }));
    const read = await readCustomProviders(file);
    expect(read).toEqual([kimi, account]);
    expect(isAccountRecord(read[0]!)).toBe(false);
    expect(isAccountRecord(read[1]!)).toBe(true);
    expect(Object.keys(read[1]!).sort()).toEqual(['id', 'kind', 'label', 'link']);
  });
  it('asRecord: аккаунт хранит только свои поля, адрес и чужие поля отбрасывает', async () => {
    const file = path.join(home, 'custom-providers.json');
    const noisy = { ...account, baseUrl: 'https://x.example', models: kimi.models, secret: 'k' };
    await writeFile(file, JSON.stringify({ version: 1, providers: [noisy] }));
    expect(await readCustomProviders(file)).toEqual([account]);
  });
  it('asRecord: kind и префикс id должны сходиться; плохая метка и link — запись пропускается', async () => {
    const file = path.join(home, 'custom-providers.json');
    const bad: unknown[] = [
      { ...account, id: 'codex-claude-2' },
      { kind: 'codex-account', id: 'custom-codex-2', label: '', link: true },
      { ...kimi, id: 'codex-kimi' },
      { ...account, id: 'custom-a', kind: 'unknown-account' },
      { ...account, id: 'custom-b', label: '   ' },
      { ...account, id: 'custom-c', label: 'x'.repeat(41) },
      { ...account, id: 'custom-d', link: 'yes' },
      { ...account, id: 'custom-/../e' },
    ];
    await writeFile(file, JSON.stringify({ version: 1, providers: bad }));
    expect(await readCustomProviders(file)).toEqual([]);
    const good = { kind: 'codex-account', id: 'codex-two', label: 'Work', link: false };
    await writeFile(file, JSON.stringify({ version: 1, providers: [good] }));
    expect(await readCustomProviders(file)).toEqual([good]);
  });
  it('isValidCustomProviderId принимает codex-two, isCustomProviderId — нет (К8)', () => {
    expect(isValidCustomProviderId('codex-two')).toBe(true);
    expect(isValidCustomProviderId('custom-two')).toBe(true);
    expect(isCustomProviderId('codex-two')).toBe(false);
    expect(isManagedProviderId('codex-two')).toBe(true);
    expect(isManagedProviderId('custom-two')).toBe(true);
    expect(isManagedProviderId('glm')).toBe(false);
    for (const id of ['codex-', 'codex-Two', 'codex-a b', 'codex-a--b', 'codex', 'other-a', `codex-${'a'.repeat(40)}`]) {
      expect(isValidCustomProviderId(id), id).toBe(false);
    }
    expect(customProviderDir('codex-two', home)).toBe(path.join(home, 'providers', 'codex-two'));
  });
  it('defaultAccountLabel: второй аккаунт — 2, третий — 3; endpoint и другой CLI не считаются (К1)', () => {
    const codex: CustomAccountRecord = { kind: 'codex-account', id: 'codex-2', label: '', link: true };
    expect(defaultAccountLabel('claude-account', [])).toBe('Claude Code 2');
    expect(defaultAccountLabel('claude-account', [kimi, codex])).toBe('Claude Code 2');
    expect(defaultAccountLabel('claude-account', [kimi, account])).toBe('Claude Code 3');
    expect(defaultAccountLabel('claude-account', [account, { ...account, id: 'custom-claude-3' }])).toBe('Claude Code 4');
    expect(defaultAccountLabel('codex-account', [account, codex])).toBe('Codex 3');
  });
  it('accountLabel: своё имя главнее; стандартное считает аккаунты до этого, а не его самого', () => {
    const second: CustomAccountRecord = { ...account, id: 'custom-claude-3' };
    expect(accountLabel({ ...account, label: 'Work' }, [account])).toBe('Work');
    expect(accountLabel(account, [account, second])).toBe('Claude Code 2');
    expect(accountLabel(second, [account, second])).toBe('Claude Code 3');
    // записи ещё нет в списке (новая) — считаются все
    expect(accountLabel(second, [account])).toBe('Claude Code 3');
    expect(accountLabel(account, [kimi])).toBe('Claude Code 2');
  });

  it('accountProviderEntry: копия раннера claude из реестра после providers.json, своя папка, без секрета и env (спека 5.2, К11, К12)', async () => {
    const providersJson = path.join(home, 'providers.json');
    await writeFile(providersJson, JSON.stringify({
      claude: { command: '/opt/claude/bin/claude', args: ['--session-id', '{sessionUuid}', '{prompt}'], printArgs: ['-p', '{prompt}'] },
    }));
    const registry = await loadProviders(providersJson, none('codex.json'), none('custom.json'));
    const entry = accountProviderEntry(account, registry, home);
    const claude = registry['claude']!;
    expect(entry.runner.command).toBe('/opt/claude/bin/claude');
    expect(entry.runner.args).toEqual(['--session-id', '{sessionUuid}', '{prompt}']);
    expect(entry.runner.args).not.toBe(claude.runner.args);
    expect(entry.runner.resumeArgs).toEqual(claude.runner.resumeArgs);
    expect(entry.runner.resumeArgs).not.toBe(claude.runner.resumeArgs);
    expect(entry.runner.printArgs).toEqual(['-p', '{prompt}']);
    expect(entry.runner.assistantArgs).toEqual(claude.runner.assistantArgs);
    expect(entry.runner.assistantResumeArgs).toEqual(claude.runner.assistantResumeArgs);
    expect(entry.runner.mcpConfig).toBe(claude.runner.mcpConfig);
    expect(entry.runner.configDir).toBe(path.join(home, 'providers', 'custom-claude-2'));
    expect(entry.runner.minVersion).toBe(ACCOUNT_MIN_VERSION_CLAUDE);
    for (const field of ['secret', 'auth', 'env', 'keyOptional'] as const) expect(entry.runner[field], field).toBeUndefined();
    expect(entry.id).toBe('custom-claude-2');
    expect(entry.label).toBe('Claude Code 2');
    expect(entry.mark).toBe('Cl');
    expect(entry.family).toBe('claude');
    expect(entry.hasHistory).toBe(true);
    expect(entry.linkBy).toBe('session-id');
    expect(entry.models).toBe(claude.models);
    expect(entry.account).toEqual(account);
    expect(entry.custom).toBeUndefined();
    expect(claude.runner.configDir).toBeUndefined();
    expect(isClaudeCode(entry)).toBe(true);
    expect(claudeConfigDirFor(entry, { CLAUDE_CONFIG_DIR: '/x' })).toBe(path.join(home, 'providers', 'custom-claude-2'));
  });
  it('accountProviderEntry: имя из записи; метка из эмодзи не режет пару; версия — 2.1.304', () => {
    const registry = { claude: PROVIDERS.claude };
    expect(accountProviderEntry({ ...account, label: '😀😀x' }, registry, home).mark).toBe('😀😀');
    expect(accountProviderEntry({ ...account, label: 'Work' }, registry, home).label).toBe('Work');
    expect(ACCOUNT_MIN_VERSION_CLAUDE).toBe('2.1.304');
  });
  it('accountProviderEntry: codex-аккаунт до этапа 3 бросает', () => {
    const codex: CustomAccountRecord = { kind: 'codex-account', id: 'codex-2', label: '', link: true };
    expect(() => accountProviderEntry(codex, { claude: PROVIDERS.claude }, home)).toThrow('codex accounts arrive in stage 3');
  });

  it('loadProviders: аккаунты после providers.json в порядке файла, стандартные имена идут по порядку; endpoint рядом как раньше', async () => {
    const file = none('custom.json');
    const second: CustomAccountRecord = { ...account, id: 'custom-claude-3' };
    const named: CustomAccountRecord = { ...account, id: 'custom-work', label: 'Work' };
    await writeCustomProviders([account, kimi, second, named], file);
    const registry = await loadProviders(none('p.json'), none('c.json'), file);
    expect(registry['custom-claude-2']?.label).toBe('Claude Code 2');
    expect(registry['custom-claude-3']?.label).toBe('Claude Code 3');
    expect(registry['custom-work']?.label).toBe('Work');
    expect(registry['custom-claude-2']?.account).toEqual(account);
    expect(path.basename(registry['custom-claude-2']!.runner.configDir!)).toBe('custom-claude-2');
    expect(registry['custom-kimi']?.custom).toEqual(kimi);
    expect(registry['custom-kimi']?.account).toBeUndefined();
  });
  it('loadProviders: чужой codex-account молча пропускается до этапа 3, остальные живут', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const file = none('custom.json');
      await writeCustomProviders([{ kind: 'codex-account', id: 'codex-2', label: '', link: true }, account], file);
      const registry = await loadProviders(none('p.json'), none('c.json'), file);
      expect(registry['codex-2']).toBeUndefined();
      expect(Object.keys(registry).sort()).toEqual(['claude', 'codex', 'custom-claude-2', 'glm']);
      // этап 3: запись читается (хост считает по ней номера), но в реестр не попадает
      expect((await readCustomProviders(file)).map((record) => record.id)).toEqual(['codex-2', 'custom-claude-2']);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
  it('loadProviders: аккаунт не перекрывает занятый id; без аккаунтов реестр прежний', async () => {
    const file = none('custom.json');
    await writeCustomProviders([kimi, { ...account, id: 'custom-kimi' }], file);
    const registry = await loadProviders(none('p.json'), none('c.json'), file);
    expect(registry['custom-kimi']?.custom).toEqual(kimi);
    expect(registry['custom-kimi']?.account).toBeUndefined();
    await writeCustomProviders([kimi], file);
    expect(Object.keys(await loadProviders(none('p.json'), none('c.json'), file)).sort()).toEqual(['claude', 'codex', 'custom-kimi', 'glm']);
  });
});
