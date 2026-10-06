import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PROVIDERS, providerReadiness, probeCliVersion } from './providers.js';
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
