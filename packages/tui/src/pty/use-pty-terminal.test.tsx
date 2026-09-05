import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Text, useInput } from 'ink';
import { render } from 'ink-testing-library';
import { useMemo, useState, type ReactNode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { TerminalView } from '../components/terminal-view.js';
import { spawnPtySession, type PtySession } from './pty-session.js';
import { usePtyTerminal } from './use-pty-terminal.js';

const STUB = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'test',
  'stub-agent.mjs',
);

function Probe({
  session,
  cols = 40,
  rows = 8,
}: {
  session: PtySession;
  cols?: number;
  rows?: number;
}): ReactNode {
  const sessions = useMemo(() => [session], [session]);
  const { snapshot } = usePtyTerminal(sessions, session, { cols, rows, frameMs: 5 });
  if (snapshot === undefined) return <Text>нет снимка</Text>;
  return <TerminalView snapshot={snapshot} height={rows} />;
}

/** Две живые сессии и переключение панели по `j` (дизайн TUI v2, 2.2). */
function Pair({
  sessions,
  rows = 24,
}: {
  sessions: readonly PtySession[];
  rows?: number;
}): ReactNode {
  const [at, setAt] = useState(0);
  const { snapshot } = usePtyTerminal(sessions, sessions[at], { cols: 60, rows, frameMs: 5 });
  useInput((input) => {
    if (input === 'j') setAt((now) => (now + 1) % sessions.length);
  });
  if (snapshot === undefined) return <Text>нет снимка</Text>;
  return <TerminalView snapshot={snapshot} height={rows} />;
}

const waitFor = async (check: () => boolean, timeoutMs = 8000): Promise<void> => {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('не дождались кадра');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

describe('usePtyTerminal против stub-бинаря', () => {
  let session: PtySession | undefined;

  afterEach(() => {
    session?.kill('SIGKILL');
    session = undefined;
  });

  const startStub = (): PtySession =>
    spawnPtySession({ file: process.execPath, args: [STUB], cols: 40, rows: 8 });

  it('вывод процесса доезжает до кадра', async () => {
    session = startStub();
    const { lastFrame, unmount } = render(<Probe session={session} />);
    try {
      await waitFor(() => (lastFrame() ?? '').includes('stub готов'));
      expect(lastFrame()).toContain('stub готов');
    } finally {
      unmount();
    }
  }, 20_000);

  it('ответ на ввод перерисовывает панель', async () => {
    session = startStub();
    const { lastFrame, unmount } = render(<Probe session={session} />);
    try {
      await waitFor(() => (lastFrame() ?? '').includes('stub готов'));
      session.write('echo строка-из-pty\r');
      await waitFor(() => (lastFrame() ?? '').includes('строка-из-pty'));
    } finally {
      unmount();
    }
  }, 20_000);

  it('полноэкранный режим показывает содержимое alt-screen', async () => {
    session = startStub();
    const { lastFrame, unmount } = render(<Probe session={session} />);
    try {
      await waitFor(() => (lastFrame() ?? '').includes('stub готов'));
      session.write('alt\r');
      await waitFor(() => (lastFrame() ?? '').includes('альтернативный экран'));
      // Прежний вывод скрыт: alt-screen — отдельный буфер.
      expect(lastFrame()).not.toContain('stub готов');
    } finally {
      unmount();
    }
  }, 20_000);
});

describe('переключение панели между живыми сессиями (2.2)', () => {
  const running: PtySession[] = [];

  afterEach(() => {
    for (const session of running) session.kill('SIGKILL');
    running.length = 0;
  });

  const startStub = (): PtySession => {
    const session = spawnPtySession({ file: process.execPath, args: [STUB], cols: 60, rows: 24 });
    running.push(session);
    return session;
  };

  it('экран каждой сессии переживает уход панели и возвращается с ней', async () => {
    const first = startStub();
    const second = startStub();
    const { stdin, lastFrame, unmount } = render(<Pair sessions={[first, second]} />);
    try {
      await waitFor(() => (lastFrame() ?? '').includes('stub готов'));
      first.write('echo первый-агент\r');
      await waitFor(() => (lastFrame() ?? '').includes('первый-агент'));

      // Панель уехала ко второй сессии: её экран свой, чужого вывода на нём нет.
      stdin.write('j');
      await waitFor(() => !(lastFrame() ?? '').includes('первый-агент'));
      second.write('echo второй-агент\r');
      await waitFor(() => (lastFrame() ?? '').includes('второй-агент'));

      // Первая сессия говорит, пока её не видно: вывод копится в её буфере.
      first.write('echo сказано-без-панели\r');
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(lastFrame()).not.toContain('сказано-без-панели');

      // Возвращаемся: прежний экран на месте, вместе со сказанным без панели.
      stdin.write('j');
      await waitFor(() => (lastFrame() ?? '').includes('первый-агент'));
      expect(lastFrame()).toContain('сказано-без-панели');
      expect(lastFrame()).not.toContain('второй-агент');
    } finally {
      unmount();
    }
  }, 30_000);
});
