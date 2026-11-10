import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { UNCAUGHT_LIMIT, UNCAUGHT_WINDOW_MS, installCrashGuards } from './crash-guards.js';
import type { Log } from './log.js';

function setup(overrides: { log?: Log } = {}) {
  const target = new EventEmitter();
  let time = 1_000_000;
  const errors: Array<{ msg: string; data?: object }> = [];
  const log: Log = overrides.log ?? {
    info: () => {},
    warn: () => {},
    error: (msg, data) => {
      errors.push({ msg, ...(data === undefined ? {} : { data }) });
    },
  };
  const shutdown = vi.fn(() => Promise.resolve());
  const uninstall = installCrashGuards({ log, shutdown, target, now: () => time });
  return {
    target,
    errors,
    shutdown,
    uninstall,
    advance(ms: number) {
      time += ms;
    },
  };
}

describe('installCrashGuards', () => {
  it('необработанный отказ пишется в лог со стеком и не вызывает остановку', () => {
    const { target, errors, shutdown } = setup();
    const error = new Error('отказ');
    target.emit('unhandledRejection', error);

    expect(errors).toHaveLength(1);
    expect(errors[0]?.msg).toBe('unhandled rejection');
    expect(errors[0]?.data).toMatchObject({ error: 'отказ', stack: error.stack });
    expect(shutdown).not.toHaveBeenCalled();
  });

  it('необработанное исключение пишется в лог и не вызывает остановку, пока их не больше предела', () => {
    const { target, errors, shutdown } = setup();
    for (let i = 0; i < UNCAUGHT_LIMIT; i += 1) target.emit('uncaughtException', new Error(`сбой ${i}`));

    expect(errors).toHaveLength(UNCAUGHT_LIMIT);
    expect(errors[0]?.msg).toBe('uncaught exception');
    expect(shutdown).not.toHaveBeenCalled();
  });

  it('больше UNCAUGHT_LIMIT исключений в окне запускают остановку ровно один раз', () => {
    for (const count of [UNCAUGHT_LIMIT + 1, 30]) {
      const { target, shutdown } = setup();
      for (let i = 0; i < count; i += 1) target.emit('uncaughtException', new Error('сбой'));
      expect(shutdown).toHaveBeenCalledTimes(1);
      expect(shutdown).toHaveBeenCalledWith('too-many-uncaught-exceptions');
    }
  });

  it('исключения реже окна не накапливаются', () => {
    const { target, shutdown, advance } = setup();
    for (let i = 0; i < 20; i += 1) {
      target.emit('uncaughtException', new Error('сбой'));
      advance(UNCAUGHT_WINDOW_MS / 5 + 1);
    }
    expect(shutdown).not.toHaveBeenCalled();
  });

  it('отвергнутые промисы в счётчик исключений не входят', () => {
    const { target, shutdown } = setup();
    for (let i = 0; i < 30; i += 1) target.emit('unhandledRejection', new Error('отказ'));
    expect(shutdown).not.toHaveBeenCalled();
  });

  it('сбой записи лога внутри обработчика не рождает нового исключения', () => {
    const throwing = (): never => {
      throw new Error('диск полон');
    };
    const { target } = setup({ log: { info: throwing, warn: throwing, error: throwing } });

    expect(() => target.emit('uncaughtException', new Error('сбой'))).not.toThrow();
    expect(() => target.emit('unhandledRejection', new Error('отказ'))).not.toThrow();
  });

  it('возвращённая функция снимает обработчики', () => {
    const { target, uninstall } = setup();
    expect(target.listenerCount('uncaughtException')).toBe(1);
    expect(target.listenerCount('unhandledRejection')).toBe(1);

    uninstall();
    expect(target.listenerCount('uncaughtException')).toBe(0);
    expect(target.listenerCount('unhandledRejection')).toBe(0);
  });
});
