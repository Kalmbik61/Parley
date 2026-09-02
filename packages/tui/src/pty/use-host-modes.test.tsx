import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Text } from 'ink';
import { render } from 'ink-testing-library';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { spawnPtySession, type PtySession } from './pty-session.js';
import { createTerminalBuffer } from './terminal-buffer.js';
import { useHostTerminalModes } from './use-host-modes.js';
import { usePtyTerminal } from './use-pty-terminal.js';

const ESC = '\u001B';
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

describe('снимок сообщает запрошенные гостем режимы', () => {
  it('по умолчанию мышь и вставка выключены', async () => {
    const buffer = createTerminalBuffer(20, 4);
    await new Promise<void>((resolve) => buffer.write('текст', resolve));

    const snapshot = buffer.snapshot();
    expect(snapshot.mouseTracking).toBe('none');
    expect(snapshot.bracketedPaste).toBe(false);
    buffer.dispose();
  });

  it('запрос отслеживания мыши виден в снимке', async () => {
    const buffer = createTerminalBuffer(20, 4);
    await new Promise<void>((resolve) => buffer.write(`${ESC}[?1000h`, resolve));
    expect(buffer.snapshot().mouseTracking).toBe('vt200');

    await new Promise<void>((resolve) => buffer.write(`${ESC}[?1002h`, resolve));
    expect(buffer.snapshot().mouseTracking).toBe('drag');

    await new Promise<void>((resolve) => buffer.write(`${ESC}[?1003h`, resolve));
    expect(buffer.snapshot().mouseTracking).toBe('any');

    await new Promise<void>((resolve) => buffer.write(`${ESC}[?1003l${ESC}[?1002l`, resolve));
    expect(buffer.snapshot().mouseTracking).toBe('none');
    buffer.dispose();
  });

  it('вставка в скобках отражается в снимке', async () => {
    const buffer = createTerminalBuffer(20, 4);
    await new Promise<void>((resolve) => buffer.write(`${ESC}[?2004h`, resolve));
    expect(buffer.snapshot().bracketedPaste).toBe(true);
    buffer.dispose();
  });
});

describe('useHostTerminalModes', () => {
  function Probe({
    active,
    mouse,
    paste,
  }: {
    active: boolean;
    mouse: 'none' | 'vt200' | 'drag' | 'any';
    paste: boolean;
  }): ReactNode {
    useHostTerminalModes(active, mouse, paste);
    return <Text>проба</Text>;
  }

  it('включает у себя то, что запросил гость', async () => {
    const app = render(<Probe active mouse="drag" paste />);
    await new Promise((resolve) => setTimeout(resolve, 50));

    const written = app.frames.join('');
    expect(written).toContain('[?1002h');
    expect(written).toContain('[?1006h');
    expect(written).toContain('[?2004h');
    app.unmount();
  });

  it('пока панель не в фокусе, ничего не включается', async () => {
    const app = render(<Probe active={false} mouse="any" paste />);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(app.frames.join('')).not.toContain('[?1003h');
    app.unmount();
  });

  it('при потере фокуса режимы гасятся', async () => {
    const app = render(<Probe active mouse="any" paste />);
    await new Promise((resolve) => setTimeout(resolve, 50));

    app.rerender(<Probe active={false} mouse="any" paste />);
    await new Promise((resolve) => setTimeout(resolve, 50));

    const written = app.frames.join('');
    expect(written).toContain('[?1003l');
    expect(written).toContain('[?2004l');
    app.unmount();
  });
});

describe('режимы гостя доезжают из живого PTY', () => {
  let session: PtySession | undefined;

  afterEach(() => {
    session?.kill('SIGKILL');
    session = undefined;
  });

  function Probe({ target }: { target: PtySession }): ReactNode {
    const snapshot = usePtyTerminal(target, { cols: 40, rows: 8, frameMs: 5 });
    return <Text>{`${snapshot?.mouseTracking ?? '—'}/${snapshot?.bracketedPaste ?? '—'}`}</Text>;
  }

  it('включение мыши в процессе меняет снимок', async () => {
    session = spawnPtySession({ file: process.execPath, args: [STUB], cols: 40, rows: 8 });
    const app = render(<Probe target={session} />);
    try {
      await waitFor(() => (app.lastFrame() ?? '').includes('none/false'));

      session.write('mouse on\r');
      await waitFor(() => (app.lastFrame() ?? '').includes('drag/true'));

      session.write('mouse off\r');
      await waitFor(() => (app.lastFrame() ?? '').includes('none/false'));
    } finally {
      app.unmount();
    }
  }, 25_000);
});
