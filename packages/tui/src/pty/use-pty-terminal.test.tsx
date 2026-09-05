import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Text } from 'ink';
import { render } from 'ink-testing-library';
import type { ReactNode } from 'react';
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
  const { snapshot } = usePtyTerminal(session, { cols, rows, frameMs: 5 });
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
