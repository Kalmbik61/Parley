import { describe, expect, it } from 'vitest';
import { CLI_TOOLS } from './cli-tools.js';
import { fetchLatestVersion, installMethod } from './cli-updates.js';

const HOME = '/Users/ivan';
const none = () => false;

function fakeFetch(body: unknown, seen: string[] = []): typeof fetch {
  return (async (url: string | URL | Request) => {
    seen.push(String(url));
    return { status: 200, json: async () => body } as Response;
  }) as typeof fetch;
}

describe('qwen: способ установки', () => {
  it('npm по пути внутри node_modules/@qwen-code/qwen-code', () => {
    expect(installMethod('qwen', `${HOME}/.nvm/versions/node/v22/lib/node_modules/@qwen-code/qwen-code/cli.js`, HOME, none)).toBe('npm');
  });

  it('standalone: папка библиотеки и обёртка с папкой библиотеки', () => {
    expect(installMethod('qwen', `${HOME}/.local/lib/qwen-code/bin/qwen`, HOME, none)).toBe('standalone');
    const exists = (p: string) => p === `${HOME}/.local/lib/qwen-code`;
    expect(installMethod('qwen', `${HOME}/.local/bin/qwen`, HOME, exists)).toBe('standalone');
    expect(installMethod('qwen', `${HOME}/.local/bin/qwen`, HOME, none)).toBe('unknown');
  });

  it('brew и неизвестный путь', () => {
    expect(installMethod('qwen', '/opt/homebrew/Cellar/qwen-code/0.27.2/bin/qwen', HOME, none)).toBe('brew');
    expect(installMethod('qwen', '/usr/bin/qwen', HOME, none)).toBe('unknown');
    expect(installMethod('qwen', '/Users/other/.local/lib/qwen-code/bin/qwen', HOME, none)).toBe('unknown');
  });
});

describe('qwen: последняя версия', () => {
  it('берёт latest и игнорирует экспериментальные теги', async () => {
    const seen: string[] = [];
    const tags = { latest: '0.28.0', nightly: '0.29.0-nightly.1', preview: '0.30.0' };
    expect(await fetchLatestVersion({ kind: 'qwen-npm' }, fakeFetch(tags, seen))).toBe('0.28.0');
    expect(seen).toEqual(['https://registry.npmjs.org/-/package/@qwen-code/qwen-code/dist-tags']);
    expect(await fetchLatestVersion({ kind: 'qwen-npm' }, fakeFetch({ nightly: '0.29.0' }))).toBeNull();
    expect(await fetchLatestVersion({ kind: 'qwen-npm' }, fakeFetch({ latest: '0.29.0-nightly.1' }))).toBeNull();
  });
});

describe('план обновления', () => {
  it('qwen по способу установки', () => {
    const qwen = CLI_TOOLS.qwen;
    expect(qwen.updatePlan('standalone')).toEqual({ kind: 'run', args: ['update'] });
    expect(qwen.updatePlan('npm')).toEqual({
      kind: 'npm-bound',
      packageSpec: '@qwen-code/qwen-code@latest',
      manualCommand: 'npm install -g @qwen-code/qwen-code@latest',
    });
    expect(qwen.updatePlan('brew')).toEqual({ kind: 'manual', manualCommand: 'brew upgrade qwen-code' });
    expect(qwen.updatePlan('unknown')).toEqual({ kind: 'manual', manualCommand: 'npm install -g @qwen-code/qwen-code@latest' });
  });

  it('claude и codex как раньше: run update при любом способе', () => {
    for (const tool of ['claude', 'codex'] as const) {
      for (const method of ['npm', 'native', 'standalone', 'brew', 'unknown'] as const) {
        expect(CLI_TOOLS[tool].updatePlan(method)).toEqual({ kind: 'run', args: ['update'] });
      }
    }
  });
});

describe('таблица установки', () => {
  it('планы установки, хосты редиректа, бинари и пробы — константа', () => {
    const snapshot = Object.fromEntries(
      Object.entries(CLI_TOOLS).map(([tool, d]) => [
        tool,
        { install: d.install, expectedBinary: d.expectedBinary, smokeArgs: d.smokeArgs, latest: d.latest },
      ]),
    );
    expect(snapshot).toEqual({
      claude: {
        install: { url: 'https://claude.ai/install.sh', interpreter: ['/bin/bash', '--noprofile', '--norc'], args: [], redirectHosts: ['downloads.claude.ai'] },
        expectedBinary: '.local/bin/claude',
        smokeArgs: ['--version'],
        latest: { kind: 'claude-npm' },
      },
      codex: {
        install: { url: 'https://chatgpt.com/codex/install.sh', interpreter: ['/bin/sh'], args: [], redirectHosts: ['releases.openai.com'] },
        expectedBinary: '.local/bin/codex',
        smokeArgs: ['-c', 'check_for_update_on_startup=false', '--version'],
        latest: { kind: 'codex-github' },
      },
      qwen: {
        install: {
          url: 'https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/installation/install-qwen-standalone.sh',
          interpreter: ['/bin/bash', '--noprofile', '--norc'],
          args: ['--method', 'standalone'],
          redirectHosts: [],
        },
        expectedBinary: '.local/bin/qwen',
        smokeArgs: ['--version'],
        latest: { kind: 'qwen-npm' },
      },
    });
  });
});
