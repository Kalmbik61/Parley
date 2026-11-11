import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLI_UPDATE_OUTPUT_BYTES, createCliUpdateRunner } from './update-run.js';

/**
 * Настоящих `codex update` и `claude update` здесь нет и быть не может: бинарь — скрипт-заглушка во временной
 * папке, на неё указывает `PARLEY_CODEX_BIN` или `PARLEY_CLAUDE_BIN`. Папка названа с пробелом и `;`, чтобы запуск
 * через shell сломался и это увидел тест.
 */
let root = '';
let dir = '';
let bin = '';
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

/** `body` — тело ветки `update`; `--version` отвечает кодом из файла `smoke-exit` (по умолчанию 0). */
async function script(body: string): Promise<string> {
  const file = path.join(dir, 'fake-cli');
  await writeFile(
    file,
    `#!/bin/sh
case "$1" in
  update)
${body}
    ;;
  *)
    echo "$@" > "${dir}/smoke-args"
    exit "$(cat "${dir}/smoke-exit" 2>/dev/null || echo 0)"
    ;;
esac
`,
    { mode: 0o755 },
  );
  await chmod(file, 0o755);
  // Свежий исполняемый файл на macOS проверяется при первом запуске долго: греем его заранее.
  execFileSync(file, ['--warm'], { stdio: 'ignore' });
  await rm(path.join(dir, 'smoke-args'), { force: true });
  return file;
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'parley-update-run-'));
  dir = path.join(root, 'dir with space; touch SHOULD_NOT_EXIST');
  await mkdir(dir, { recursive: true });
  log.info.mockClear();
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

interface Versions {
  now: string | null;
  after: string | null;
}

function runner(options: { versions: Versions; latest?: string | null; env?: NodeJS.ProcessEnv; timeoutMs?: number; sessions?: number; command?: 'codex' | 'claude'; fresh?: (command: string, options?: { force?: boolean }) => Promise<string | null> }) {
  const command = options.command ?? 'codex';
  const key = command === 'codex' ? 'PARLEY_CODEX_BIN' : 'PARLEY_CLAUDE_BIN';
  return createCliUpdateRunner({
    log,
    versions: {
      get: () => options.versions.now,
      fresh: options.fresh ?? (async () => options.versions.after),
    },
    updates: { latest: async () => options.latest ?? null },
    runningSessions: async () => options.sessions ?? 0,
    env: { [key]: bin, PATH: '/usr/bin:/bin', ...options.env },
    timeoutMs: options.timeoutMs ?? 20_000,
    smokeTimeoutMs: 20_000,
  });
}

describe('обновление CLI из Parley', () => {
  it('успех: версия выросла, проба Codex с флагами Parley, сессии посчитаны, но не тронуты', async () => {
    bin = await script('    echo "updating"; echo "done" >&2; exit 0');
    const result = await runner({ versions: { now: '0.162.0', after: '0.166.0' }, latest: '0.166.0', sessions: 2 }).run('codex', 'window (c-1)');
    expect(result).toEqual({
      state: 'done',
      ok: true,
      from: '0.162.0',
      to: '0.166.0',
      output: expect.stringContaining('updating'),
      runningSessions: 2,
      smoke: { ok: true, output: '' },
    });
    expect((result as { output: string }).output).toContain('done');
    expect(result).not.toHaveProperty('manualCommand');
    expect((await readFile(path.join(dir, 'smoke-args'), 'utf8')).trim()).toBe('-c check_for_update_on_startup=false --version');
    // Путь с пробелом и «;» отработал: shell не участвует.
    expect(existsSync(path.join(root, 'SHOULD_NOT_EXIST'))).toBe(false);
    expect(existsSync(path.join(dir, 'SHOULD_NOT_EXIST'))).toBe(false);
  });

  it('после update версия пробуется принудительно, мимо кэша проб', async () => {
    bin = await script('    exit 0');
    const fresh = vi.fn(async () => '0.166.0');
    await runner({ versions: { now: '0.162.0', after: '0.166.0' }, latest: '0.166.0', fresh }).run('codex', 'w');
    expect(fresh).toHaveBeenCalledWith('codex', { force: true });
  });

  it('журнал хоста: кто, откуда и куда, итог', async () => {
    bin = await script('    exit 0');
    await runner({ versions: { now: '0.162.0', after: '0.166.0' }, latest: '0.166.0' }).run('codex', 'window (c-1)');
    expect(log.info).toHaveBeenCalledWith('provider CLI update', expect.objectContaining({ who: 'window (c-1)', command: 'codex', from: '0.162.0', to: '0.166.0', ok: true, exitCode: 0 }));
  });

  it('ненулевой выход: ok false, текст ошибки и команда для ручного запуска', async () => {
    bin = await script('    echo "EACCES: permission denied, mkdir /usr/local/lib" >&2; exit 3');
    const result = await runner({ versions: { now: '0.162.0', after: '0.162.0' }, latest: '0.166.0' }).run('codex', 'w');
    expect(result).toMatchObject({ state: 'done', ok: false, from: '0.162.0', to: '0.162.0', manualCommand: `${bin} update` });
    expect((result as { output: string }).output).toContain('permission denied');
  });

  it('выход 0, но версия не выросла и не равна найденной — ok false', async () => {
    bin = await script('    exit 0');
    const result = await runner({ versions: { now: '0.162.0', after: '0.162.0' }, latest: '0.166.0' }).run('codex', 'w');
    expect(result).toMatchObject({ ok: false, manualCommand: `${bin} update` });
  });

  it('уже последняя версия (равна найденной) — ok true', async () => {
    bin = await script('    echo "already up to date"; exit 0');
    const result = await runner({ versions: { now: '0.166.0', after: '0.166.0' }, latest: '0.166.0' }).run('codex', 'w');
    expect(result).toMatchObject({ ok: true, from: '0.166.0', to: '0.166.0' });
  });

  it('версию после обновления узнать не удалось — ok false', async () => {
    bin = await script('    exit 0');
    const result = await runner({ versions: { now: '0.162.0', after: null }, latest: '0.166.0' }).run('codex', 'w');
    expect(result).toMatchObject({ ok: false, to: null });
  });

  it('отказ пробы Codex виден в ответе, обновление при этом удалось', async () => {
    bin = await script('    exit 0');
    await writeFile(path.join(dir, 'smoke-exit'), '2');
    const result = await runner({ versions: { now: '0.162.0', after: '0.166.0' }, latest: '0.166.0' }).run('codex', 'w');
    expect(result).toMatchObject({ ok: true, smoke: { ok: false } });
  });

  it('Claude: та же команда update; проба из таблицы — безобидное `--version` (спека 2026-11-11, §4.1)', async () => {
    bin = await script('    echo claude-updated; exit 0');
    const result = await runner({ command: 'claude', versions: { now: '2.1.300', after: '2.1.320' }, latest: '2.1.320' }).run('claude', 'w');
    expect(result).toMatchObject({ ok: true, to: '2.1.320', smoke: { ok: true } });
    expect((await readFile(path.join(dir, 'smoke-args'), 'utf8')).trim()).toBe('--version');
  });

  it('таймаут: процесс убивается, ответ — ok false с пометкой', async () => {
    bin = await script(`    echo $$ > "${dir}/pid"; exec sleep 30`);
    const result = await runner({ versions: { now: '0.162.0', after: '0.162.0' }, latest: '0.166.0', timeoutMs: 300 }).run('codex', 'w');
    expect(result).toMatchObject({ ok: false });
    expect((result as { output: string }).output).toContain('timed out');
    const pid = Number((await readFile(path.join(dir, 'pid'), 'utf8')).trim());
    await vi.waitFor(() => {
      expect(() => process.kill(pid, 0)).toThrow();
    });
  });

  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  it('таймаут убивает всю группу: фоновый потомок установщика не остаётся, вызов возвращается быстро', async () => {
    bin = await script(`    sleep 30 &\n    echo $! > "${dir}/bg-pid"\n    wait`);
    const started = Date.now();
    const result = await runner({ versions: { now: '0.162.0', after: '0.162.0' }, latest: '0.166.0', timeoutMs: 1000 }).run('codex', 'w');
    expect(Date.now() - started).toBeLessThan(3000);
    expect(result).toMatchObject({ state: 'done', ok: false });
    expect((result as { output: string }).output).toContain('timed out');
    const pid = Number((await readFile(path.join(dir, 'bg-pid'), 'utf8')).trim());
    await vi.waitFor(() => expect(alive(pid)).toBe(false));
  });

  it('обычный выход добивает оставшихся в группе потомков установщика', async () => {
    bin = await script(`    sleep 30 &\n    echo $! > "${dir}/bg-pid"\n    exit 0`);
    const started = Date.now();
    await runner({ versions: { now: '0.162.0', after: '0.166.0' }, latest: '0.166.0' }).run('codex', 'w');
    expect(Date.now() - started).toBeLessThan(5000);
    const pid = Number((await readFile(path.join(dir, 'bg-pid'), 'utf8')).trim());
    await vi.waitFor(() => expect(alive(pid)).toBe(false));
  });

  it('stop() (остановка хоста) убивает идущий установщик со всей группой, вызов завершается', async () => {
    bin = await script(`    sleep 30 &\n    echo $! > "${dir}/bg-pid"\n    wait`);
    const update = runner({ versions: { now: '0.162.0', after: '0.162.0' }, latest: '0.166.0' });
    const pending = update.run('codex', 'w');
    await vi.waitFor(async () => expect(existsSync(path.join(dir, 'bg-pid'))).toBe(true));
    update.stop();
    const result = await pending;
    expect(result).toMatchObject({ state: 'done', ok: false });
    const pid = Number((await readFile(path.join(dir, 'bg-pid'), 'utf8')).trim());
    await vi.waitFor(() => expect(alive(pid)).toBe(false));
  });

  it('EPERM при убийстве группы (macOS: группы уже нет или одни зомби) — не ошибка: ни в exit, ни в stop()', async () => {
    bin = await script(`    exit 0`);
    const real = process.kill.bind(process);
    const spy = vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: string | number) => {
      if (pid < 0) throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' });
      return real(pid, signal);
    }) as typeof process.kill);
    try {
      const update = runner({ versions: { now: '0.162.0', after: '0.166.0' }, latest: '0.166.0' });
      await expect(update.run('codex', 'w')).resolves.toMatchObject({ state: 'done', ok: true });
      expect(spy.mock.calls.some(([pid]) => pid < 0)).toBe(true);
      expect(() => update.stop()).not.toThrow();
    } finally {
      spy.mockRestore();
    }
  });

  it('занятость: пока идёт одно обновление, второе получает busy; потом снова можно', async () => {
    bin = await script('    sleep 1; exit 0');
    const update = runner({ versions: { now: '0.162.0', after: '0.166.0' }, latest: '0.166.0' });
    const first = update.run('codex', 'a');
    await Promise.resolve();
    expect(await update.run('codex', 'b')).toEqual({ state: 'busy' });
    expect(await first).toMatchObject({ state: 'done', ok: true });
    expect(await update.run('codex', 'c')).toMatchObject({ state: 'done' });
  });

  it('окружение: метки способа установки Codex и родительской сессии не передаются, остальное да', async () => {
    bin = await script(`    env > "${dir}/env"; exit 0`);
    await runner({
      versions: { now: '0.162.0', after: '0.166.0' },
      latest: '0.166.0',
      env: { CODEX_MANAGED_BY_NPM: '1', CODEX_MANAGED_BY_BREW: '1', CODEX_MANAGED_PACKAGE_ROOT: '/old/npm', CLAUDE_CODE_SESSION_ID: 'parent', CLAUDE_CODE_CHILD_SESSION: '1', KEEP_ME: 'yes' },
    }).run('codex', 'w');
    const env = await readFile(path.join(dir, 'env'), 'utf8');
    expect(env).not.toContain('CODEX_MANAGED_BY_NPM');
    expect(env).not.toContain('CODEX_MANAGED_BY_BREW');
    expect(env).not.toContain('CODEX_MANAGED_PACKAGE_ROOT');
    expect(env).not.toContain('CLAUDE_CODE_SESSION_ID');
    expect(env).not.toContain('CLAUDE_CODE_CHILD_SESSION');
    expect(env).toContain('KEEP_ME=yes');
  });

  it('stdin закрыт: команда, читающая ввод, получает конец файла, а не зависает', async () => {
    bin = await script('    cat > /dev/null; echo eof-seen; exit 0');
    const result = await runner({ versions: { now: '0.162.0', after: '0.166.0' }, latest: '0.166.0', timeoutMs: 5000 }).run('codex', 'w');
    expect((result as { output: string }).output).toContain('eof-seen');
  });

  it('вывод: только последние 4 КБ', async () => {
    bin = await script('    head -c 20000 /dev/zero | tr "\\0" x; echo THE-END; exit 0');
    const result = (await runner({ versions: { now: '0.162.0', after: '0.166.0' }, latest: '0.166.0' }).run('codex', 'w')) as { output: string };
    expect(result.output.length).toBeLessThanOrEqual(CLI_UPDATE_OUTPUT_BYTES);
    expect(result.output.trimEnd().endsWith('THE-END')).toBe(true);
  });

  it('бинаря нет — ошибка, блокировка снимается', async () => {
    bin = await script('    exit 0');
    const missing = createCliUpdateRunner({
      log,
      versions: { get: () => null, fresh: async () => null },
      updates: { latest: async () => null },
      runningSessions: async () => 0,
      env: { PARLEY_CODEX_BIN: path.join(root, 'нет-такого'), PATH: '' },
    });
    await expect(missing.run('codex', 'w')).rejects.toThrow();
    await expect(missing.run('codex', 'w')).rejects.toThrow();
  });
});
