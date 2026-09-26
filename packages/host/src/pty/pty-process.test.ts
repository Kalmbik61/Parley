import { describe, expect, it } from 'vitest';
import { spawnPty } from './pty-process.js';
import type { ExitInfo } from './pty-process.js';

async function waitFor(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('не дождались условия');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('spawnPty', () => {
  it('пробрасывает вывод и код завершения дочернего процесса', async () => {
    const proc = spawnPty(
      {
        command: process.execPath,
        args: ['-e', "process.stdout.write('привет\\r\\n'); process.exit(7);"],
        cwd: process.cwd(),
        env: process.env,
      },
      { cols: 80, rows: 24 },
    );

    let out = '';
    proc.onData((data) => {
      out += data;
    });
    const exit = await new Promise<ExitInfo>((resolve) => proc.onExit(resolve));

    expect(out).toContain('привет');
    expect(exit.exitCode).toBe(7);
  });

  it('UTF-8, разрезанный по байтам между записями вывода, доходит целым', async () => {
    // «ёжик» в UTF-8 — 8 байт, каждая буква занимает 2 байта. mid=3 режет ровно
    // посередине второй буквы: без корректной пересборки на границе кусков
    // хост увидел бы U+FFFD вместо «ж».
    const word = 'ёжик';
    const bytes = Array.from(Buffer.from(word, 'utf8'));
    const mid = 3;
    const script = [
      `const bytes = Buffer.from(${JSON.stringify(bytes)});`,
      `process.stdout.write(bytes.subarray(0, ${mid}));`,
      `setTimeout(() => process.stdout.write(bytes.subarray(${mid})), 30);`,
    ].join('\n');

    const proc = spawnPty(
      { command: process.execPath, args: ['-e', script], cwd: process.cwd(), env: process.env },
      { cols: 80, rows: 24 },
    );

    let out = '';
    proc.onData((data) => {
      out += data;
    });

    await waitFor(() => out.includes(word));
    expect(out).toContain(word);
    expect(out).not.toContain('�');

    proc.kill();
  });
});
