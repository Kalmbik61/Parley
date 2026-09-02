import { mkdtemp, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BinaryNotFoundError, findBinary, findClaudeBinary } from './find-binary.js';
import { spawnPtySession, type PtySession } from './pty-session.js';

const STUB = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'test',
  'stub-agent.mjs',
);

/** Собирает поток PTY и позволяет дождаться нужного куска. */
function collect(session: PtySession): {
  text: () => string;
  waitFor: (s: string) => Promise<void>;
} {
  let text = '';
  session.onData((chunk) => {
    text += chunk;
  });

  return {
    text: () => text,
    waitFor: async (needle: string, timeoutMs = 5000) => {
      const started = Date.now();
      while (!text.includes(needle)) {
        if (Date.now() - started > timeoutMs) {
          throw new Error(
            `не дождались «${needle}», получено: ${JSON.stringify(text.slice(-200))}`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    },
  };
}

describe('findBinary', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'harnas-bin-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('находит исполняемый файл в PATH', async () => {
    const file = path.join(dir, 'выдуманный-агент');
    await writeFile(file, '#!/bin/sh\nexit 0\n');
    await chmod(file, 0o755);

    expect(await findBinary('выдуманный-агент', { PATH: dir })).toBe(file);
  });

  it('неисполняемый файл не считается бинарём', async () => {
    const file = path.join(dir, 'агент');
    await writeFile(file, 'просто текст');
    await chmod(file, 0o644);

    await expect(findBinary('агент', { PATH: dir })).rejects.toBeInstanceOf(BinaryNotFoundError);
  });

  it('ошибка объясняет, что запускается только официальный бинарь', async () => {
    const error = await findBinary('claude', { PATH: dir }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BinaryNotFoundError);
    expect((error as Error).message).toContain('не найден в PATH');
    expect((error as Error).message).toContain('немодифицированный');
  });

  it('пустой PATH не роняет поиск', async () => {
    await expect(findBinary('claude', {})).rejects.toBeInstanceOf(BinaryNotFoundError);
  });

  it('HARNAS_CLAUDE_BIN подменяет путь к бинарю', async () => {
    const file = path.join(dir, 'свой-claude');
    await writeFile(file, '#!/bin/sh\nexit 0\n');
    await chmod(file, 0o755);

    expect(await findClaudeBinary({ HARNAS_CLAUDE_BIN: file, PATH: '' })).toBe(file);
  });
});

describe('spawnPtySession против stub-бинаря', () => {
  let session: PtySession | undefined;

  afterEach(() => {
    session?.kill('SIGKILL');
    session = undefined;
  });

  const startStub = (args: string[] = [], cwd?: string): PtySession =>
    spawnPtySession({
      file: process.execPath,
      args: [STUB, ...args],
      cols: 80,
      rows: 24,
      ...(cwd === undefined ? {} : { cwd }),
    });

  it('запускает процесс и отдаёт его вывод', async () => {
    session = startStub();
    const out = collect(session);

    await out.waitFor('stub готов');
    expect(session.pid).toBeGreaterThan(0);
    expect(session.state).toBe('running');
  });

  it('аргументы доезжают до процесса', async () => {
    session = startStub(['--resume', 'сессия-1']);
    const out = collect(session);

    await out.waitFor('stub готов');
    expect(out.text()).toContain('"--resume","сессия-1"');
  });

  it('cwd задаёт рабочий каталог процесса', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'harnas-cwd-'));
    try {
      session = startStub([], dir);
      const out = collect(session);
      await out.waitFor('cwd=');
      // macOS отдаёт /private/var вместо /var — сравниваем по хвосту.
      expect(out.text()).toContain(path.basename(dir));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('write доставляет ввод в процесс', async () => {
    session = startStub();
    const out = collect(session);
    await out.waitFor('stub готов');

    session.write('echo привет-из-теста\r');
    await out.waitFor('привет-из-теста');
  });

  it('resize доезжает до процесса', async () => {
    session = startStub();
    const out = collect(session);
    await out.waitFor('stub готов');

    session.resize(120, 40);
    session.write('size\r');
    await out.waitFor('size 120x40');
  });

  it('размеры меньше двух подтягиваются до минимума', async () => {
    session = startStub();
    const out = collect(session);
    await out.waitFor('stub готов');

    session.resize(0, 0);
    session.write('size\r');
    await out.waitFor('size 2x2');
  });

  it('завершение процесса приходит в onExit с кодом', async () => {
    session = startStub();
    const out = collect(session);
    await out.waitFor('stub готов');

    const exited = new Promise<number>((resolve) => {
      session?.onExit(({ exitCode }) => resolve(exitCode));
    });
    session.write('exit 7\r');

    expect(await exited).toBe(7);
    expect(session.state).toBe('exited');
    expect(session.exit?.exitCode).toBe(7);
  });

  it('подписка после завершения всё равно получает событие', async () => {
    session = startStub();
    const out = collect(session);
    await out.waitFor('stub готов');

    await new Promise<void>((resolve) => {
      session?.onExit(() => resolve());
      session?.write('exit 0\r');
    });

    const late = await new Promise<number>((resolve) => {
      session?.onExit(({ exitCode }) => resolve(exitCode));
    });
    expect(late).toBe(0);
  });

  it('write и resize после смерти процесса безопасны', async () => {
    session = startStub();
    const out = collect(session);
    await out.waitFor('stub готов');

    await new Promise<void>((resolve) => {
      session?.onExit(() => resolve());
      session?.write('exit 0\r');
    });

    expect(() => {
      session?.write('echo призрак\r');
      session?.resize(100, 30);
      session?.kill();
    }).not.toThrow();
  });

  it('kill завершает живой процесс', async () => {
    session = startStub();
    const out = collect(session);
    await out.waitFor('stub готов');

    const exited = new Promise<void>((resolve) => {
      session?.onExit(() => resolve());
    });
    session.kill();
    await exited;
    expect(session.state).toBe('exited');
  });

  it('отписка прекращает доставку данных', async () => {
    session = startStub();
    let chunks = 0;
    const unsubscribe = session.onData(() => {
      chunks++;
    });

    const out = collect(session);
    await out.waitFor('stub готов');

    const seen = chunks;
    unsubscribe();
    session.write('echo ещё\r');
    await out.waitFor('ещё');
    expect(chunks).toBe(seen);
  });
});
