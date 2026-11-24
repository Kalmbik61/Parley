import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { cliEnv, createCliRun, installerEnv } from './cli-run.js';

describe('общий раннер CLI', () => {
  it('флаг занятости: вторая работа с тем же CLI получает busy, пока идёт первая; потом снова можно', async () => {
    const cli = createCliRun();
    let release!: () => void;
    const first = cli.exclusive('qwen', () => new Promise<string>((resolve) => (release = () => resolve('first'))));
    expect(await cli.exclusive('qwen', async () => 'second')).toEqual({ state: 'busy' });
    release();
    expect(await first).toBe('first');
    expect(await cli.exclusive('qwen', async () => 'third')).toBe('third');
  });

  it('opencode has its own busy flag: a second install or update of it is busy, other CLIs are free', async () => {
    const cli = createCliRun();
    let release!: () => void;
    const first = cli.exclusive('opencode', () => new Promise<void>((resolve) => (release = resolve)));
    expect(await cli.exclusive('opencode', async () => 'second')).toEqual({ state: 'busy' });
    expect(await cli.exclusive('qwen', async () => 'qwen')).toBe('qwen');
    release();
    await first;
    expect(await cli.exclusive('opencode', async () => 'again')).toBe('again');
  });

  it('разные CLI друг друга не блокируют', async () => {
    const cli = createCliRun();
    let release!: () => void;
    const codex = cli.exclusive('codex', () => new Promise<void>((resolve) => (release = resolve)));
    expect(await cli.exclusive('qwen', async () => 'qwen')).toBe('qwen');
    expect(await cli.exclusive('claude', async () => 'claude')).toBe('claude');
    release();
    await codex;
  });

  it('исключение работы снимает флаг', async () => {
    const cli = createCliRun();
    await expect(cli.exclusive('claude', async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(await cli.exclusive('claude', async () => 'ok')).toBe('ok');
  });

  it('после stop() новые процессы не запускаются', async () => {
    const cli = createCliRun();
    cli.stop();
    const marker = path.join(tmpdir(), `parley-cli-run-stopped-${process.pid}-${Date.now()}`);
    const result = await cli.exec('/bin/sh', ['-c', `touch "${marker}"`], { PATH: '/usr/bin:/bin' }, 5000);
    expect(result).toMatchObject({ code: null, timedOut: false });
    expect(existsSync(marker)).toBe(false);
  });

  it('окружение установщика: без переменных внедрения и меток родителя; прокси и CA остаются', () => {
    const env = installerEnv({
      BASH_ENV: '/x',
      ENV: '/y',
      PROMPT_COMMAND: 'z',
      NODE_OPTIONS: '--require /evil.js',
      NODE_PATH: '/n',
      npm_config_registry: 'https://evil.example/',
      NPM_CONFIG_USERCONFIG: '/u',
      npm_package_name: 'p',
      CODEX_MANAGED_BY_NPM: '1',
      CLAUDE_CODE_SESSION_ID: 'parent',
      HTTPS_PROXY: 'http://proxy:3128',
      HTTP_PROXY: 'http://proxy:3128',
      NO_PROXY: 'localhost',
      NODE_EXTRA_CA_CERTS: '/ca.pem',
      SSL_CERT_FILE: '/cert.pem',
      PATH: '/usr/bin',
    });
    expect(env).toEqual({
      HTTPS_PROXY: 'http://proxy:3128',
      HTTP_PROXY: 'http://proxy:3128',
      NO_PROXY: 'localhost',
      NODE_EXTRA_CA_CERTS: '/ca.pem',
      SSL_CERT_FILE: '/cert.pem',
      PATH: '/usr/bin',
    });
  });

  it('окружение обновления через run — как прежде: только метки Codex и родителя', () => {
    expect(cliEnv({ CODEX_MANAGED_PACKAGE_ROOT: '/r', CLAUDE_CODE_SESSION_ID: 's', NODE_OPTIONS: '--x', KEEP: '1' })).toEqual({ NODE_OPTIONS: '--x', KEEP: '1' });
  });
});
