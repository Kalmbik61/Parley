import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { spawnPtySession, type PtyExit, type PtySession } from './pty-session.js';
import { createTerminalBuffer } from './terminal-buffer.js';

/**
 * Сценарный тест v1: spawn → write → resize → teardown на одном живом процессе.
 * Настоящий `claude` здесь не запускается никогда — только stub (specs/pty.md).
 */
const STUB = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'test',
  'stub-agent.mjs',
);

const ESC = '\u001B';

/** Жив ли процесс: сигнал 0 ничего не делает, только проверяет существование. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('интеграция PTY: полный цикл против stub-бинаря', () => {
  let session: PtySession | undefined;

  afterEach(() => {
    session?.kill('SIGKILL');
    session = undefined;
  });

  it('spawn → write → resize → teardown', async () => {
    const buffer = createTerminalBuffer(60, 12);
    let text = '';

    const waitFor = async (needle: string, timeoutMs = 8000): Promise<void> => {
      const started = Date.now();
      while (!text.includes(needle)) {
        if (Date.now() - started > timeoutMs) {
          throw new Error(`не дождались «${needle}»: ${JSON.stringify(text.slice(-160))}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    };

    // 1. spawn: процесс поднялся, аргументы доехали
    session = spawnPtySession({
      file: process.execPath,
      args: [STUB, '--resume', 'сессия-для-теста'],
      cols: 60,
      rows: 12,
    });
    session.onData((chunk) => {
      text += chunk;
      buffer.write(chunk);
    });

    await waitFor('stub готов');
    expect(text).toContain('"--resume","сессия-для-теста"');
    expect(session.state).toBe('running');
    const { pid } = session;
    expect(isAlive(pid)).toBe(true);

    // 2. write: ввод доходит до процесса, ответ виден
    session.write('echo первая-команда\r');
    await waitFor('первая-команда');

    // 3. resize: новый размер знают и процесс, и буфер
    session.resize(100, 30);
    buffer.resize(100, 30);
    await waitFor('resize 100x30');
    session.write('size\r');
    await waitFor('size 100x30');
    expect(buffer.snapshot().cols).toBe(100);

    // 4. alt-screen: полноэкранный режим и возврат из него
    session.write('alt\r');
    await waitFor('альтернативный экран');
    await new Promise<void>((resolve) => buffer.write('', resolve));
    expect(buffer.snapshot().altScreen).toBe(true);

    await new Promise<void>((resolve) => buffer.write(`${ESC}[?1049l`, resolve));
    expect(buffer.snapshot().altScreen).toBe(false);

    // 5. teardown: SIGHUP гасит процесс, событие выхода приходит
    const exit = await new Promise<PtyExit>((resolve) => {
      session?.onExit(resolve);
      session?.kill();
    });

    expect(session.state).toBe('exited');
    // stub перехватывает SIGHUP и выходит сам — код 129, как при обрыве терминала.
    expect(exit.exitCode === 129 || exit.signal !== 0).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(isAlive(pid)).toBe(false);

    // 6. после teardown обращения к сессии безопасны
    expect(() => {
      session?.write('echo призрак\r');
      session?.resize(80, 24);
      session?.kill();
    }).not.toThrow();

    buffer.dispose();
  }, 30_000);

  it('поток процесса доходит до снимка экрана в правильном виде', async () => {
    const buffer = createTerminalBuffer(60, 10);
    session = spawnPtySession({ file: process.execPath, args: [STUB], cols: 60, rows: 10 });

    const written: string[] = [];
    session.onData((chunk) => written.push(chunk));

    const flush = async (): Promise<void> => {
      const chunks = written.splice(0, written.length);
      for (const chunk of chunks) {
        await new Promise<void>((resolve) => buffer.write(chunk, resolve));
      }
    };

    const waitLine = async (needle: string, timeoutMs = 8000): Promise<void> => {
      const started = Date.now();
      for (;;) {
        await flush();
        const lines = buffer.snapshot().lines.map((s) => s.map((x) => x.text).join(''));
        if (lines.some((line) => line.includes(needle))) return;
        if (Date.now() - started > timeoutMs) throw new Error(`нет строки «${needle}»`);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    };

    await waitLine('stub готов');

    // Цвет из процесса доезжает до сегментов снимка.
    session.write('color\r');
    await waitLine('красный');

    const coloured = buffer
      .snapshot()
      .lines.flat()
      .find((segment) => segment.text.includes('красный'));
    expect(coloured?.color).toBe('red');

    buffer.dispose();
  }, 30_000);
});
