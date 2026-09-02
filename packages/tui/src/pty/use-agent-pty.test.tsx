import type { SessionIndex } from '@harnas/core';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { render } from 'ink-testing-library';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from '../app.js';

const STUB = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'test',
  'stub-agent.mjs',
);

const ENTER = '\r';

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

const waitFor = async (check: () => boolean, timeoutMs = 8000): Promise<void> => {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('не дождались');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

/**
 * Ink подписывается на stdin в эффекте после монтирования, а stdin в тестах —
 * обычный EventEmitter: запись до подписки теряется молча. Ждём подписку перед
 * первым нажатием.
 */
const mounted = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 120));

/**
 * Домашняя папка харнесса и проект — во временных каталогах: App читает работы,
 * и настоящие ~/.harnas и <cwd>/.harnas тесты не касаются.
 */
let home = '';
let project = '';

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'harnas-home-'));
  project = await mkdtemp(path.join(tmpdir(), 'harnas-project-'));
  process.env['HARNAS_HOME'] = home;
});

afterEach(async () => {
  delete process.env['HARNAS_HOME'];
  await Promise.all([home, project].map((dir) => rm(dir, { recursive: true, force: true })));
});

/** Заголовок правой панели: он рисуется в той же строке кадра, что и SESSIONS. */
const rightHeader = (frame: string, offset = 0): string => {
  const lines = frame.split('\n');
  const at = lines.findIndex((item) => item.includes('SESSIONS'));
  return (
    (lines[at + offset] ?? '')
      .split('│')
      .filter((cell) => cell.trim() !== '')
      .at(-1) ?? ''
  );
};

describe('Enter открывает сессию в правой панели', () => {
  let root: string;
  let workdir: string;
  const originalBin = process.env['HARNAS_CLAUDE_BIN'];

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'harnas-open-'));
    workdir = await mkdtemp(path.join(tmpdir(), 'harnas-work-'));
    // Настоящий claude в тестах не запускается никогда (specs/pty.md).
    process.env['HARNAS_CLAUDE_BIN'] = STUB;
  });

  afterEach(async () => {
    if (originalBin === undefined) delete process.env['HARNAS_CLAUDE_BIN'];
    else process.env['HARNAS_CLAUDE_BIN'] = originalBin;
    await rm(root, { recursive: true, force: true });
    await rm(workdir, { recursive: true, force: true });
  });

  it('передаёт --resume с id сессии и её cwd', async () => {
    const { stdin, lastFrame, unmount } = render(
      <App sessions={[session({ cwd: workdir })]} root={root} projectPath={project} />,
    );
    try {
      await waitFor(() => (lastFrame() ?? '').includes('Enter на сессии'));
      await mounted();
      stdin.write(ENTER);

      await waitFor(() => (lastFrame() ?? '').includes('stub готов'));
      const frame = lastFrame() ?? '';
      expect(frame).toContain('--resume');
      expect(frame).toContain('сессия-1');
      expect(frame).toContain(path.basename(workdir));
    } finally {
      unmount();
    }
  }, 25_000);

  it('заголовок панели — имя сессии, под ним провайдер и модель (дизайн 2.1)', async () => {
    const { stdin, lastFrame, unmount } = render(
      <App sessions={[session()]} root={root} projectPath={project} />,
    );
    try {
      await waitFor(() => (lastFrame() ?? '').includes('Enter на сессии'));
      await mounted();
      stdin.write(ENTER);
      await waitFor(() => rightHeader(lastFrame() ?? '').includes('моя сессия'));
      // Прежнего «TERMINAL — …» больше нет: пара строк, как в списке и в ДЕТАЛЯХ.
      expect(lastFrame()).not.toContain('TERMINAL —');
      expect(rightHeader(lastFrame() ?? '', 1)).toContain('Claude Opus');
    } finally {
      unmount();
    }
  }, 25_000);

  it('без сессий Enter ничего не запускает', async () => {
    const { stdin, lastFrame, unmount } = render(
      <App sessions={[]} root={root} projectPath={project} />,
    );
    try {
      await waitFor(() => (lastFrame() ?? '').includes('Enter на сессии'));
      await mounted();
      stdin.write(ENTER);
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(lastFrame()).toContain('Enter на сессии');
    } finally {
      unmount();
    }
  }, 25_000);

  it('без бинаря панель объясняет проблему вместо падения', async () => {
    process.env['HARNAS_CLAUDE_BIN'] = path.join(root, 'нет-такого-бинаря');
    const { stdin, lastFrame, unmount } = render(
      <App sessions={[session()]} root={root} projectPath={project} />,
    );
    try {
      await waitFor(() => (lastFrame() ?? '').includes('Enter на сессии'));
      await mounted();
      stdin.write(ENTER);

      // Бинарь ищется при попытке открыть: ошибка привязана к провайдеру сессии.
      await waitFor(() => (lastFrame() ?? '').includes('не найден в PATH'));
      expect(lastFrame()).toContain('немодифицированный');
    } finally {
      unmount();
    }
  }, 25_000);

  it('cwd не задан — процесс всё равно запускается', async () => {
    await mkdir(path.join(root, '-proj'), { recursive: true });
    await writeFile(path.join(root, '-proj', 'x.jsonl'), '');

    const { stdin, lastFrame, unmount } = render(
      <App sessions={[session({ cwd: null })]} root={root} projectPath={project} />,
    );
    try {
      await waitFor(() => (lastFrame() ?? '').includes('Enter на сессии'));
      await mounted();
      stdin.write(ENTER);
      await waitFor(() => (lastFrame() ?? '').includes('stub готов'));
    } finally {
      unmount();
    }
  }, 25_000);
});

describe('раннеры разных провайдеров', () => {
  let root: string;
  const originalClaude = process.env['HARNAS_CLAUDE_BIN'];
  const originalCodex = process.env['HARNAS_CODEX_BIN'];

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'harnas-runner-'));
    process.env['HARNAS_CODEX_BIN'] = STUB;
  });

  afterEach(async () => {
    if (originalClaude === undefined) delete process.env['HARNAS_CLAUDE_BIN'];
    else process.env['HARNAS_CLAUDE_BIN'] = originalClaude;
    if (originalCodex === undefined) delete process.env['HARNAS_CODEX_BIN'];
    else process.env['HARNAS_CODEX_BIN'] = originalCodex;
    await rm(root, { recursive: true, force: true });
  });

  it('сессия Codex открывается командой `resume <id>`, а не флагом Claude', async () => {
    const codexSession = session({
      id: 'uuid-codex',
      provider: 'codex',
      title: 'сессия codex',
      cwd: null,
    });
    const { stdin, lastFrame, unmount } = render(
      <App sessions={[codexSession]} root={root} projectPath={project} />,
    );
    try {
      await waitFor(() => (lastFrame() ?? '').includes('Enter на сессии'));
      await mounted();
      stdin.write(ENTER);

      await waitFor(() => (lastFrame() ?? '').includes('stub готов'));
      const frame = lastFrame() ?? '';
      expect(frame).toContain('"resume","uuid-codex"');
      expect(frame).not.toContain('--resume');
    } finally {
      unmount();
    }
  }, 25_000);
});

describe('новая сессия без истории', () => {
  let root: string;
  const original = {
    claude: process.env['HARNAS_CLAUDE_BIN'],
    codex: process.env['HARNAS_CODEX_BIN'],
    glm: process.env['HARNAS_GLM_BIN'],
  };

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'harnas-new-'));
    process.env['HARNAS_CLAUDE_BIN'] = STUB;
    process.env['HARNAS_CODEX_BIN'] = STUB;
    process.env['HARNAS_GLM_BIN'] = STUB;
  });

  afterEach(async () => {
    for (const [key, value] of Object.entries(original)) {
      const name = `HARNAS_${key.toUpperCase()}_BIN`;
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(root, { recursive: true, force: true });
  });

  it('n запускает агента без --resume', async () => {
    const { stdin, lastFrame, unmount } = render(
      <App sessions={[session({ cwd: null })]} root={root} projectPath={project} />,
    );
    try {
      await waitFor(() => (lastFrame() ?? '').includes('Enter на сессии'));
      await mounted();
      stdin.write('n');

      await waitFor(() => (lastFrame() ?? '').includes('stub готов'));
      const frame = lastFrame() ?? '';
      // Новый запуск идёт без аргументов: возобновлять нечего.
      expect(frame).toContain('args=[]');
      expect(frame).toContain('новая сессия');
    } finally {
      unmount();
    }
  }, 25_000);

  it('провайдер новой сессии берётся из активного фильтра', async () => {
    // Codex попадает в выбор, только когда его сессии есть в списке.
    const sessions = [
      session({ id: 'c', cwd: null }),
      session({ id: 'x', cwd: null, provider: 'codex', title: 'кодекс' }),
    ];
    const { stdin, lastFrame, unmount } = render(
      <App sessions={sessions} root={root} projectPath={project} />,
    );
    try {
      await waitFor(() => (lastFrame() ?? '').includes('Enter на сессии'));
      await mounted();

      // Фильтр: все → Claude → Codex.
      stdin.write('p');
      await new Promise((resolve) => setTimeout(resolve, 150));
      stdin.write('p');
      await waitFor(() => (lastFrame() ?? '').includes('· Codex'));

      stdin.write('n');
      await waitFor(() => (lastFrame() ?? '').includes('новая сессия Codex'));
    } finally {
      unmount();
    }
  }, 25_000);

  it('до раннера без истории можно дотянуться через фильтр', async () => {
    const { stdin, lastFrame, unmount } = render(
      <App sessions={[]} root={root} projectPath={project} />,
    );
    try {
      await waitFor(() => (lastFrame() ?? '').includes('Enter на сессии'));
      await mounted();

      // Сессий нет вовсе — в выборе остаётся только GLM.
      stdin.write('p');
      await waitFor(() => (lastFrame() ?? '').includes('· GLM'));

      stdin.write('n');
      await waitFor(() => (lastFrame() ?? '').includes('новая сессия GLM'));
    } finally {
      unmount();
    }
  }, 25_000);
});
