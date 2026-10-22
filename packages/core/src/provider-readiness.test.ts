import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ACCOUNT_MIN_VERSION_CLAUDE, accountProviderEntry, customProviderEntry } from './custom-providers.js';
import { PROVIDERS, providerReadiness, providerReadinessError, probeCliVersion } from './providers.js';
import { clearSecret, writeSecret } from './secrets.js';

let home: string;
let binary: string;
beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'parley-ready-'));
  process.env.PARLEY_HOME = home;
  binary = path.join(home, 'claude');
  await writeFile(binary, '#!/bin/sh\necho "2.1.287 (Claude Code)"\n', { mode: 0o755 });
});
afterEach(async () => {
  delete process.env.PARLEY_HOME;
  await rm(home, { recursive: true, force: true });
});
const env = () => ({ PATH: '', PARLEY_CLAUDE_BIN: binary });

describe('providerReadiness', () => {
  it.each(['--bare', '--bare=true', '--safe-mode', '--safe-mode=true', '--setting-sources', '--setting-sources='])('refuses incompatible GLM template flag %s before probing', async (flag) => {
    const probeVersion = vi.fn();
    for (const template of ['args', 'resumeArgs'] as const) {
      const entry = { ...PROVIDERS.glm, runner: { ...PROVIDERS.glm.runner, [template]: [flag] } };
      expect(await providerReadiness(entry, { probeVersion, keyPresent: true })).toMatchObject({ error: expect.stringContaining('unsupported') });
    }
    expect(probeVersion).not.toHaveBeenCalled();
  });
  it('ordinary safe argument overrides preserve GLM readiness', async () => {
    const entry = { ...PROVIDERS.glm, runner: { ...PROVIDERS.glm.runner, args: ['--model', '{model}', '{prompt}'] } };
    expect(await providerReadiness(entry, { env: env(), version: '2.1.287', keyPresent: true })).toMatchObject({ needs: null, error: null });
  });
  it('requires the saved key after a successful actual version-only probe', async () => {
    // macOS can validate a newly written executable slowly on its first invocation.
    await promisify(execFile)(binary, ['--version'], { timeout: 30_000 });
    expect(await providerReadiness(PROVIDERS.glm, { env: env() })).toMatchObject({ needs: 'key', version: '2.1.287' });
    await writeSecret('zai', 'fake-zai-key');
    const ready = await providerReadiness(PROVIDERS.glm, { env: env() });
    expect(ready).toMatchObject({ needs: null, error: null });
    expect(JSON.stringify(ready)).not.toContain('fake-zai-key');
    await clearSecret('zai');
    expect(await providerReadiness(PROVIDERS.glm, { env: env() })).toMatchObject({ needs: 'key' });
  });
  it.each(['2.1.286', null, 'unknown'])('refuses unsupported version %s before key lookup', async (version) => {
    expect(await providerReadiness(PROVIDERS.glm, { env: env(), version })).toMatchObject({ needs: 'cli' });
  });
  it('accepts a later semantic version and an injected key snapshot', async () => {
    expect(await providerReadiness(PROVIDERS.glm, { env: env(), version: '3.0.0', keyPresent: true })).toMatchObject({ needs: null });
  });
  it('rejects a custom GLM command without probing it', async () => {
    const probeVersion = vi.fn();
    const entry = { ...PROVIDERS.glm, runner: { ...PROVIDERS.glm.runner, command: 'wrapper' } };
    expect(await providerReadiness(entry, { probeVersion, keyPresent: true })).toMatchObject({ needs: null, error: expect.stringContaining('claude') });
    expect(probeVersion).not.toHaveBeenCalled();
  });
  it('ordinary Claude needs only its executable', async () => {
    const probeVersion = vi.fn();
    expect(await providerReadiness(PROVIDERS.claude, { env: env(), probeVersion })).toMatchObject({ needs: null, error: null });
    expect(probeVersion).not.toHaveBeenCalled();
  });
  it('returns cli for an absent executable', async () => {
    expect(await providerReadiness(PROVIDERS.glm, { env: { PATH: '' } })).toMatchObject({ needs: 'cli' });
  });
});

it('probeCliVersion runs only --version in the supplied environment', async () => {
  await writeFile(binary, '#!/bin/sh\n[ "$1" = "--version" ] || exit 1\necho "2.1.287 (Claude Code)"\n', { mode: 0o755 });
  expect(await probeCliVersion('claude', 30_000, env())).toBe('2.1.287');
});

describe('providerReadiness своих провайдеров (спека 5.1)', () => {
  const record = {
    id: 'custom-kimi', label: 'Kimi', preset: null, baseUrl: 'https://api.moonshot.ai/anthropic', auth: 'bearer' as const,
    models: { opus: 'm', sonnet: 'm', haiku: 'm', subagent: 'm' }, contextWindow: null, linkClaude: true,
  };
  it('нет ключа → needs key; у loopback-адреса ключ не нужен', async () => {
    const remote = customProviderEntry(record, home);
    const readiness = await providerReadiness(remote, { env: env(), version: '2.1.302', keyPresent: false });
    expect(readiness.needs).toBe('key');
    expect(providerReadinessError(remote, readiness)).toBe('Kimi requires a saved key in Settings → Providers');
    const local = customProviderEntry({ ...record, baseUrl: 'http://localhost:4000' }, home);
    expect(await providerReadiness(local, { env: env(), version: '2.1.302', keyPresent: false })).toMatchObject({ needs: null });
  });
  it('claude 2.1.301 → needs cli; текст называет имя провайдера, а не GLM', async () => {
    const entry = customProviderEntry(record, home);
    const readiness = await providerReadiness(entry, { env: env(), version: '2.1.301', keyPresent: true });
    expect(readiness.needs).toBe('cli');
    expect(providerReadinessError(entry, readiness)).toBe('Kimi requires Claude Code 2.1.302 or newer; install or update the CLI and check again');
  });
});

describe('providerReadiness аккаунта (спека подписок 5.5)', () => {
  const accountEntry = () =>
    accountProviderEntry({ kind: 'claude-account', id: 'custom-claude-2', label: '', link: true }, { claude: PROVIDERS.claude }, home);

  it.each([null, false, undefined])('вход не подтверждён (%s) → needs sign-in, после проверок CLI и версии', async (signedIn) => {
    const entry = accountEntry();
    const readiness = await providerReadiness(entry, {
      env: env(), version: ACCOUNT_MIN_VERSION_CLAUDE, ...(signedIn === undefined ? {} : { signedIn }),
    });
    expect(readiness).toEqual({ needs: 'sign-in', error: null, version: ACCOUNT_MIN_VERSION_CLAUDE });
    expect(providerReadinessError(entry, readiness)).toBe('Claude Code 2 is not signed in: open Settings → Providers and press Sign in');
  });
  it('вход подтверждён → готов; ключ не спрашивается', async () => {
    const readiness = await providerReadiness(accountEntry(), { env: env(), version: '2.1.400', signedIn: true });
    expect(readiness).toEqual({ needs: null, error: null, version: '2.1.400' });
    expect(providerReadinessError(accountEntry(), readiness)).toBeNull();
  });
  it('старый CLI главнее входа; текст называет имя аккаунта и версию', async () => {
    const entry = accountEntry();
    for (const signedIn of [true, null] as const) {
      const readiness = await providerReadiness(entry, { env: env(), version: '2.1.303', signedIn });
      expect(readiness.needs).toBe('cli');
      expect(providerReadinessError(entry, readiness)).toBe(
        'Claude Code 2 requires Claude Code 2.1.304 or newer; install or update the CLI and check again',
      );
    }
  });
  it('нет claude в PATH → needs cli, даже если вход подтверждён', async () => {
    expect(await providerReadiness(accountEntry(), { env: { PATH: '' }, signedIn: true })).toMatchObject({ needs: 'cli' });
  });
  it('своё имя аккаунта попадает в тексты отказа', async () => {
    const entry = accountProviderEntry({ kind: 'claude-account', id: 'custom-work', label: 'Work', link: true }, { claude: PROVIDERS.claude }, home);
    const readiness = await providerReadiness(entry, { env: env(), version: ACCOUNT_MIN_VERSION_CLAUDE, signedIn: null });
    expect(providerReadinessError(entry, readiness)).toBe('Work is not signed in: open Settings → Providers and press Sign in');
  });
  it('endpoint, glm и обычный claude от signedIn не зависят', async () => {
    const endpoint = customProviderEntry({
      id: 'custom-kimi', label: 'Kimi', preset: null, baseUrl: 'https://api.moonshot.ai/anthropic', auth: 'bearer' as const,
      models: { opus: 'm', sonnet: 'm', haiku: 'm', subagent: 'm' }, contextWindow: null, linkClaude: true,
    }, home);
    for (const signedIn of [null, false, true] as const) {
      expect(await providerReadiness(endpoint, { env: env(), version: '2.1.302', keyPresent: true, signedIn })).toMatchObject({ needs: null });
      expect(await providerReadiness(endpoint, { env: env(), version: '2.1.302', keyPresent: false, signedIn })).toMatchObject({ needs: 'key' });
      expect(await providerReadiness(PROVIDERS.glm, { env: env(), version: '2.1.287', keyPresent: true, signedIn })).toMatchObject({ needs: null });
      expect(await providerReadiness(PROVIDERS.claude, { env: env(), signedIn })).toMatchObject({ needs: null });
    }
  });
});
