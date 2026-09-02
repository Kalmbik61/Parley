import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { Text } from 'ink';
import { render } from 'ink-testing-library';
import type { ReactNode } from 'react';
import { createTerminalBuffer } from './terminal-buffer.js';
import { spawnPtySession, type PtySession } from './pty-session.js';
import { usePtyResize } from './use-pty-resize.js';

const STUB = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'test',
  'stub-agent.mjs',
);

const waitFor = async (check: () => boolean, timeoutMs = 8000): Promise<void> => {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('не дождались');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

describe('ресайз доезжает до процесса', () => {
  let pty: PtySession | undefined;

  afterEach(() => {
    pty?.kill('SIGKILL');
    pty = undefined;
  });

  it('процесс получает новый размер окна', async () => {
    pty = spawnPtySession({ file: process.execPath, args: [STUB], cols: 80, rows: 24 });
    let text = '';
    pty.onData((chunk) => {
      text += chunk;
    });

    await waitFor(() => text.includes('stub готов'));
    pty.resize(100, 30);
    await waitFor(() => text.includes('resize 100x30'));

    // И сам процесс видит новый размер, а не только событие.
    pty.write('size\r');
    await waitFor(() => text.includes('size 100x30'));
  }, 20_000);

  it('буфер xterm перестраивается под новый размер', async () => {
    const buffer = createTerminalBuffer(20, 5);
    await new Promise<void>((resolve) => buffer.write('строка\r\n', resolve));

    buffer.resize(60, 12);
    const snapshot = buffer.snapshot();
    expect(snapshot.cols).toBe(60);
    expect(snapshot.rows).toBe(12);
    buffer.dispose();
  });
});

describe('ресайз панели пробрасывается в процесс', () => {
  let pty: PtySession | undefined;

  afterEach(() => {
    pty?.kill('SIGKILL');
    pty = undefined;
  });

  function Probe({
    session: target,
    cols,
    rows,
  }: {
    session: PtySession;
    cols: number;
    rows: number;
  }): ReactNode {
    usePtyResize(target, cols, rows);
    return <Text>{`${cols}x${rows}`}</Text>;
  }

  it('новый размер панели доезжает до процесса', async () => {
    pty = spawnPtySession({ file: process.execPath, args: [STUB], cols: 80, rows: 24 });
    let text = '';
    pty.onData((chunk) => {
      text += chunk;
    });
    await waitFor(() => text.includes('stub готов'));

    const { rerender, unmount } = render(<Probe session={pty} cols={80} rows={24} />);
    try {
      rerender(<Probe session={pty} cols={132} rows={43} />);
      await waitFor(() => text.includes('resize 132x43'));

      pty.write('size\r');
      await waitFor(() => text.includes('size 132x43'));
    } finally {
      unmount();
    }
  }, 25_000);
});
