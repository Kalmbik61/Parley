/**
 * Раннеры провайдеров в PTY-менеджере. Проверяется сам хук: в TUI v2 панель
 * открывает только сессии работ, а команда и аргументы приходят готовыми из
 * реестра (`work-launch.ts`), поэтому здесь цели задаются напрямую.
 *
 * Настоящий бинарь провайдера не запускается никогда (specs/pty.md).
 */

import type { SessionIndex } from '@harnas/core';
import { Text } from 'ink';
import { render } from 'ink-testing-library';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useAgentPty, type AgentTarget } from './use-agent-pty.js';

const STUB = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'test',
  'stub-agent.mjs',
);

function session(over: Partial<SessionIndex> = {}): SessionIndex {
  return {
    id: 'сессия-1',
    project: '-proj',
    projectPath: '/work',
    cwd: '/work',
    gitBranch: 'main',
    version: '2.1.247',
    file: '/root/s1.jsonl',
    title: 'моя сессия',
    titleSource: 'custom',
    startedAt: '2026-09-01T10:00:00.000Z',
    endedAt: '2026-09-01T10:10:00.000Z',
    lastUserRecordAt: null,
    durationMs: 600_000,
    records: 5,
    malformedLines: 0,
    models: {},
    tools: {},
    roles: {},
    recordTypes: {},
    primaryModel: 'claude-opus-5',
    subsessionCount: 0,
    provider: 'claude',
    tokens: null,
    ...over,
  };
}

/** Ink переносит длинные строки: для поиска фразы кадр склеивается обратно. */
const flat = (frame: string | undefined): string =>
  (frame ?? '').replaceAll('\n', ' ').replace(/\s+/g, ' ');

const waitFor = async (check: () => boolean, timeoutMs = 8000): Promise<void> => {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('не дождались');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

/** Открывает цель и печатает всё, что сказал процесс, плюс ошибку запуска. */
function Probe({
  target,
  opens = 1,
  focus = true,
}: {
  target: AgentTarget;
  opens?: number;
  focus?: boolean;
}): ReactNode {
  const [out, setOut] = useState('');
  const agent = useAgentPty();
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    // Повторное открытие той же цели не должно плодить второй процесс.
    for (let at = 0; at < opens; at++) agent.open(target, { cols: 80, rows: 10 }, { focus });
  }, [agent, target, opens, focus]);

  const live = agent.active?.session;
  useEffect(
    () => live?.onData((chunk) => setOut((prev) => prev + chunk.replaceAll('\r', ''))),
    [live],
  );

  return (
    <Text>{`${agent.error ?? ''}|${out}|live=${agent.live.length}|active=${agent.active === undefined ? 'none' : 'yes'}`}</Text>
  );
}

let root = '';
const original = {
  claude: process.env['HARNAS_CLAUDE_BIN'],
  codex: process.env['HARNAS_CODEX_BIN'],
};

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'harnas-runner-'));
  process.env['HARNAS_CLAUDE_BIN'] = STUB;
  process.env['HARNAS_CODEX_BIN'] = STUB;
});

afterEach(async () => {
  for (const [key, value] of Object.entries(original)) {
    const name = `HARNAS_${key.toUpperCase()}_BIN`;
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await rm(root, { recursive: true, force: true });
});

describe('раннеры провайдеров', () => {
  it('сессия Claude открывается с --resume и своим cwd', async () => {
    const app = render(<Probe target={{ kind: 'session', session: session({ cwd: root }) }} />);
    try {
      await waitFor(() => (app.lastFrame() ?? '').includes('stub готов'));
      // Баннер stub доезжает несколькими чанками PTY, и cwd печатается в нём
      // последним: без ожидания кадр иногда снимается между строками.
      await waitFor(() => (app.lastFrame() ?? '').includes(path.basename(root)));
      const frame = app.lastFrame() ?? '';
      expect(frame).toContain('--resume');
      expect(frame).toContain('сессия-1');
      expect(frame).toContain(path.basename(root));
    } finally {
      app.unmount();
    }
  }, 25_000);

  it('сессия Codex открывается командой `resume <id>`, а не флагом Claude', async () => {
    const codex = session({ id: 'uuid-codex', provider: 'codex', cwd: null });
    const app = render(<Probe target={{ kind: 'session', session: codex }} />);
    try {
      await waitFor(() => (app.lastFrame() ?? '').includes('stub готов'));
      const frame = app.lastFrame() ?? '';
      expect(frame).toContain('"resume","uuid-codex"');
      expect(frame).not.toContain('--resume');
    } finally {
      app.unmount();
    }
  }, 25_000);

  it('новый запуск идёт без аргументов: возобновлять нечего', async () => {
    const app = render(<Probe target={{ kind: 'new', provider: 'claude' }} />);
    try {
      await waitFor(() => (app.lastFrame() ?? '').includes('stub готов'));
      expect(app.lastFrame()).toContain('args=[]');
    } finally {
      app.unmount();
    }
  }, 25_000);

  it('повторное открытие той же цели не плодит второго агента', async () => {
    const app = render(<Probe target={{ kind: 'new', provider: 'claude' }} opens={2} />);
    try {
      await waitFor(() => (app.lastFrame() ?? '').includes('stub готов'));
      await new Promise((resolve) => setTimeout(resolve, 300));
      const frames = (app.lastFrame() ?? '').split('stub готов');
      expect(frames).toHaveLength(2);
    } finally {
      app.unmount();
    }
  }, 25_000);

  it('open с focus: false поднимает процесс, но панель не переключает', async () => {
    const app = render(<Probe target={{ kind: 'new', provider: 'claude' }} focus={false} />);
    try {
      await waitFor(() => flat(app.lastFrame()).includes('live=1'));
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(flat(app.lastFrame())).toContain('active=none');
    } finally {
      app.unmount();
    }
  }, 25_000);

  it('без бинаря хук объясняет проблему вместо падения', async () => {
    process.env['HARNAS_CLAUDE_BIN'] = path.join(root, 'нет-такого-бинаря');
    const app = render(<Probe target={{ kind: 'new', provider: 'claude' }} />);
    try {
      await waitFor(() => flat(app.lastFrame()).includes('не найден в PATH'));
      expect(flat(app.lastFrame())).toContain('немодифицированный');
    } finally {
      app.unmount();
    }
  }, 25_000);
});

/**
 * Claude Code ставит своим дочерним процессам метки родительской сессии, и TUI,
 * запущенный из его сессии, их наследует. Агент с такой меткой считает себя
 * вложенным и молча не пишет транскрипт, а по транскриптам харнесс строит индекс
 * сессий, метрики и страховку активности.
 */
describe('окружение агента', () => {
  const inherited: Record<string, string> = {
    CLAUDE_CODE_CHILD_SESSION: '1',
    CLAUDE_CODE_SESSION_ID: 'сессия-родителя',
    CLAUDE_CODE_BRIDGE_SESSION_ID: 'мост-родителя',
    // Соседняя настройка пользователя: её агент получает как есть.
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: '8000',
  };
  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    // Эти переменные stub печатает после баннера: `env <имя>=<значение>`.
    const report = [...Object.keys(inherited), 'HARNAS_SESSION_ID'].join(',');
    for (const [name, value] of Object.entries({ ...inherited, HARNAS_STUB_ENV: report })) {
      saved.set(name, process.env[name]);
      process.env[name] = value;
    }
  });

  afterEach(() => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    saved.clear();
  });

  /** Кадр stub, когда отчёт об окружении допечатан целиком. */
  async function reportedEnv(target: AgentTarget): Promise<string> {
    const app = render(<Probe target={target} />);
    try {
      await waitFor(() => flat(app.lastFrame()).includes('env HARNAS_SESSION_ID='));
      return flat(app.lastFrame());
    } finally {
      app.unmount();
    }
  }

  it('сессия работы: меток родителя у агента нет, остальное окружение на месте', async () => {
    const frame = await reportedEnv({
      kind: 'work',
      projectPath: root,
      workId: 'w-1',
      sessionId: 's-1',
      provider: 'claude',
      title: 'бэкенд',
      command: 'claude',
      args: [],
      cwd: root,
      env: { HARNAS_WORK_DIR: root, HARNAS_SESSION_ID: 's-1' },
      providerSessionId: null,
    });
    expect(frame).toContain('env CLAUDE_CODE_CHILD_SESSION=-');
    expect(frame).toContain('env CLAUDE_CODE_SESSION_ID=-');
    expect(frame).toContain('env CLAUDE_CODE_BRIDGE_SESSION_ID=-');
    expect(frame).toContain('env CLAUDE_CODE_MAX_OUTPUT_TOKENS=8000');
    expect(frame).toContain('env HARNAS_SESSION_ID=s-1');
  }, 25_000);

  it('новый запуск: метки срезаются и без окружения работы', async () => {
    const frame = await reportedEnv({ kind: 'new', provider: 'claude' });
    expect(frame).toContain('env CLAUDE_CODE_CHILD_SESSION=-');
    expect(frame).toContain('env CLAUDE_CODE_SESSION_ID=-');
    expect(frame).toContain('env CLAUDE_CODE_BRIDGE_SESSION_ID=-');
    expect(frame).toContain('env CLAUDE_CODE_MAX_OUTPUT_TOKENS=8000');
    // Срезается копия: окружение самого харнесса остаётся как было.
    expect(process.env['CLAUDE_CODE_CHILD_SESSION']).toBe('1');
  }, 25_000);
});
