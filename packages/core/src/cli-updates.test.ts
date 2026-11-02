import { describe, expect, it } from 'vitest';
import { fetchLatestVersion, installMethod, isNewer } from './cli-updates.js';

const HOME = '/Users/ivan';

function fakeFetch(status: number, body: unknown, seen: string[] = []): typeof fetch {
  return (async (url: string | URL | Request) => {
    seen.push(String(url));
    return {
      status,
      json: async () => {
        if (body instanceof Error) throw body;
        return body;
      },
    } as Response;
  }) as typeof fetch;
}

describe('installMethod', () => {
  it('codex: автономная установка, npm и brew по пути настоящего файла', () => {
    expect(installMethod('codex', `${HOME}/.codex/packages/standalone/releases/0.162.0-aarch64-apple-darwin/bin/codex`, HOME)).toBe('standalone');
    expect(installMethod('codex', `${HOME}/.nvm/versions/node/v22.23.3/lib/node_modules/@openai/codex/bin/codex.js`, HOME)).toBe('npm');
    expect(installMethod('codex', '/opt/homebrew/Caskroom/codex/0.162.0/codex', HOME)).toBe('brew');
    expect(installMethod('codex', '/usr/local/Caskroom/codex/0.162.0/codex', HOME)).toBe('brew');
    expect(installMethod('codex', '/opt/homebrew/bin/codex', HOME)).toBe('brew');
    expect(installMethod('codex', '/usr/bin/codex', HOME)).toBe('unknown');
  });

  it('codex: standalone чужого домашнего каталога — не наш', () => {
    expect(installMethod('codex', '/Users/other/.codex/packages/standalone/releases/x/bin/codex', HOME)).toBe('unknown');
  });

  it('claude: родная установка и npm', () => {
    expect(installMethod('claude', `${HOME}/.local/share/claude/versions/2.1.316`, HOME)).toBe('native');
    expect(installMethod('claude', `${HOME}/.nvm/versions/node/v22/lib/node_modules/@anthropic-ai/claude-code/cli.js`, HOME)).toBe('npm');
    expect(installMethod('claude', '/usr/bin/claude', HOME)).toBe('unknown');
  });

  it('путь Codex не принимается за путь Claude и наоборот', () => {
    expect(installMethod('claude', `${HOME}/.codex/packages/standalone/releases/x/bin/codex`, HOME)).toBe('unknown');
    expect(installMethod('codex', `${HOME}/.local/share/claude/versions/2.1.316`, HOME)).toBe('unknown');
  });
});

describe('fetchLatestVersion', () => {
  it('codex-github: tag_name rust-vX.Y.Z', async () => {
    const seen: string[] = [];
    const version = await fetchLatestVersion({ kind: 'codex-github' }, fakeFetch(200, { tag_name: 'rust-v0.166.0', prerelease: false }, seen));
    expect(version).toBe('0.166.0');
    expect(seen).toEqual(['https://api.github.com/repos/openai/codex/releases/latest']);
  });

  it('codex-github: пре-релиз, чужой тег и чужая форма — null', async () => {
    expect(await fetchLatestVersion({ kind: 'codex-github' }, fakeFetch(200, { tag_name: 'rust-v0.167.0', prerelease: true }))).toBeNull();
    expect(await fetchLatestVersion({ kind: 'codex-github' }, fakeFetch(200, { tag_name: 'rust-v0.167.0-alpha.1' }))).toBeNull();
    expect(await fetchLatestVersion({ kind: 'codex-github' }, fakeFetch(200, { tag_name: 5 }))).toBeNull();
    expect(await fetchLatestVersion({ kind: 'codex-github' }, fakeFetch(200, ['x']))).toBeNull();
    expect(await fetchLatestVersion({ kind: 'codex-github' }, fakeFetch(200, null))).toBeNull();
  });

  it('codex-brew: поле version', async () => {
    const seen: string[] = [];
    expect(await fetchLatestVersion({ kind: 'codex-brew' }, fakeFetch(200, { version: '0.166.0' }, seen))).toBe('0.166.0');
    expect(seen).toEqual(['https://formulae.brew.sh/api/cask/codex.json']);
    expect(await fetchLatestVersion({ kind: 'codex-brew' }, fakeFetch(200, { token: 'codex' }))).toBeNull();
  });

  it('claude-npm: канал latest по умолчанию и заданный канал', async () => {
    const seen: string[] = [];
    const tags = { latest: '2.1.317', stable: '2.1.300' };
    expect(await fetchLatestVersion({ kind: 'claude-npm' }, fakeFetch(200, tags, seen))).toBe('2.1.317');
    expect(await fetchLatestVersion({ kind: 'claude-npm', channel: 'stable' }, fakeFetch(200, tags))).toBe('2.1.300');
    expect(await fetchLatestVersion({ kind: 'claude-npm', channel: 'next' }, fakeFetch(200, tags))).toBeNull();
    expect(seen).toEqual(['https://registry.npmjs.org/-/package/@anthropic-ai/claude-code/dist-tags']);
  });

  it('403 и любой не-200 — null', async () => {
    expect(await fetchLatestVersion({ kind: 'codex-github' }, fakeFetch(403, { tag_name: 'rust-v0.166.0' }))).toBeNull();
    expect(await fetchLatestVersion({ kind: 'claude-npm' }, fakeFetch(500, { latest: '2.1.317' }))).toBeNull();
  });

  it('битый JSON и сетевая ошибка — null без исключения', async () => {
    expect(await fetchLatestVersion({ kind: 'codex-brew' }, fakeFetch(200, new SyntaxError('bad json')))).toBeNull();
    const broken = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    expect(await fetchLatestVersion({ kind: 'claude-npm' }, broken)).toBeNull();
  });

  it('таймаут: запрос получает AbortSignal и обрывается через timeoutMs', async () => {
    let signal: AbortSignal | undefined;
    const hanging = ((_url: string, init: RequestInit) => {
      signal = init.signal ?? undefined;
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      });
    }) as unknown as typeof fetch;
    expect(await fetchLatestVersion({ kind: 'codex-github' }, hanging, 20)).toBeNull();
    expect(signal?.aborted).toBe(true);
  });
});

describe('isNewer', () => {
  it('сравнивает x.y.z по числам', () => {
    expect(isNewer('0.162.0', '0.166.0')).toBe(true);
    expect(isNewer('0.9.0', '0.10.0')).toBe(true);
    expect(isNewer('2.1.316', '2.1.316')).toBe(false);
    expect(isNewer('0.166.0', '0.162.0')).toBe(false);
  });

  it('пре-релизы и чужая форма — false', () => {
    expect(isNewer('0.162.0', '0.167.0-alpha.1')).toBe(false);
    expect(isNewer('0.162.0-beta.1', '0.166.0')).toBe(false);
    expect(isNewer('0.162', '0.166.0')).toBe(false);
    expect(isNewer('', '0.166.0')).toBe(false);
  });
});
