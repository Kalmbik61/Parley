import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { guardAppQuit, quitQuestion } from './quit-guard.js';
import type { QuitGuardDeps } from './quit-guard.js';

/**
 * Выход из приложения гасит хост (решение 2026-10-16): закрытое окно оставляет агентов работать, а выход
 * (Dock → «Завершить», ⌘Q, меню) спрашивает и останавливает хост со всеми сессиями. Вопрос — на `will-quit`,
 * когда вопрос о несохранённых буферах уже позади и окна закрыты.
 */

/** Приложение-заглушка: `will-quit` с отменой; `quit()` пишет шаг в общий журнал. */
class FakeApp extends EventEmitter {
  constructor(private readonly steps: string[]) {
    super();
  }
  quit(): void {
    this.steps.push('quit');
  }
  /** Шлёт `will-quit`; возвращает, отменён ли выход. */
  willQuit(): boolean {
    let prevented = false;
    this.emit('will-quit', {
      preventDefault: () => {
        prevented = true;
      },
    });
    return prevented;
  }
  /** Как Electron: `will-quit`, и только если выход не отменён, — `quit`. Возвращает, отменён ли выход. */
  exit(): boolean {
    const prevented = this.willQuit();
    if (!prevented) this.emit('quit');
    return prevented;
  }
}

function setup(over: Partial<QuitGuardDeps> = {}) {
  const steps: string[] = [];
  const app = new FakeApp(steps);
  const deps: QuitGuardDeps = {
    liveSessions: vi.fn(async () => 3),
    ask: vi.fn(async () => 'stop' as const),
    stopHost: vi.fn(async () => {
      steps.push('stop-host');
    }),
    onCancel: vi.fn(() => {
      steps.push('cancel');
    }),
    keepHost: false,
    log: vi.fn(),
    ...over,
  };
  const guard = guardAppQuit(app, deps);
  return { app, deps, steps, guard };
}

describe('guardAppQuit', () => {
  it('тестовый режим (keepHost) — выход как раньше: хост живёт, вопроса нет', async () => {
    const { app, deps, steps } = setup({ keepHost: true });
    expect(app.willQuit()).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(deps.liveSessions).not.toHaveBeenCalled();
    expect(deps.ask).not.toHaveBeenCalled();
    expect(deps.stopHost).not.toHaveBeenCalled();
    expect(steps).toEqual([]);
  });

  it('живых сессий нет — без вопроса: хост гасится, затем выход; повторный will-quit уже не держится', async () => {
    const { app, deps, steps } = setup({ liveSessions: vi.fn(async () => 0) });
    expect(app.willQuit()).toBe(true);
    await vi.waitFor(() => expect(steps).toEqual(['stop-host', 'quit']));
    expect(deps.ask).not.toHaveBeenCalled();
    expect(app.willQuit()).toBe(false);
  });

  it('живые сессии — вопрос с их числом; «stop» — хост гасится, затем выход', async () => {
    const { app, deps, steps } = setup({ liveSessions: vi.fn(async () => 18) });
    expect(app.willQuit()).toBe(true);
    await vi.waitFor(() => expect(steps).toEqual(['stop-host', 'quit']));
    expect(deps.ask).toHaveBeenCalledTimes(1);
    expect(deps.ask).toHaveBeenCalledWith(18);
    expect(app.willQuit()).toBe(false);
  });

  it('«cancel» — хост и выход не трогаются, окно возвращается; следующий выход спрашивает снова', async () => {
    const ask = vi.fn(async (): Promise<'stop' | 'cancel'> => 'cancel');
    const { app, deps, steps } = setup({ ask });
    expect(app.willQuit()).toBe(true);
    await vi.waitFor(() => expect(steps).toEqual(['cancel']));
    expect(deps.stopHost).not.toHaveBeenCalled();
    expect(deps.onCancel).toHaveBeenCalledTimes(1);

    ask.mockResolvedValueOnce('stop');
    expect(app.willQuit()).toBe(true);
    await vi.waitFor(() => expect(steps).toEqual(['cancel', 'stop-host', 'quit']));
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it('хост не ответил (число неизвестно) — вопрос всё равно задаётся', async () => {
    const { app, deps, steps } = setup({ liveSessions: vi.fn(async () => null) });
    expect(app.willQuit()).toBe(true);
    await vi.waitFor(() => expect(steps).toEqual(['stop-host', 'quit']));
    expect(deps.ask).toHaveBeenCalledWith(null);
  });

  it('выключение или перезагрузка системы — без вопроса даже при живых сессиях', async () => {
    const { app, deps, steps, guard } = setup({ liveSessions: vi.fn(async () => 18) });
    guard.systemShutdown();
    expect(app.willQuit()).toBe(true);
    await vi.waitFor(() => expect(steps).toEqual(['stop-host', 'quit']));
    expect(deps.ask).not.toHaveBeenCalled();
  });

  it('повторный will-quit, пока вопрос открыт, — тоже отменён, второго вопроса нет', async () => {
    let answer!: (value: 'stop' | 'cancel') => void;
    const ask = vi.fn(
      () =>
        new Promise<'stop' | 'cancel'>((resolve) => {
          answer = resolve;
        }),
    );
    const { app, steps } = setup({ ask });
    expect(app.willQuit()).toBe(true);
    await vi.waitFor(() => expect(ask).toHaveBeenCalledTimes(1));
    expect(app.willQuit()).toBe(true);
    expect(ask).toHaveBeenCalledTimes(1);

    answer('stop');
    await vi.waitFor(() => expect(steps).toEqual(['stop-host', 'quit']));
  });

  it('остановка хоста упала — выход всё равно идёт, причина в журнал', async () => {
    const stopHost = vi.fn(async () => {
      throw new Error('нет связи');
    });
    const { app, deps, steps } = setup({ stopHost });
    expect(app.willQuit()).toBe(true);
    await vi.waitFor(() => expect(steps).toEqual(['quit']));
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('нет связи'));
    expect(app.willQuit()).toBe(false);
  });

  it('dispose снимает обработчик: выход больше не держится', () => {
    const { app, guard } = setup();
    guard.dispose();
    expect(app.willQuit()).toBe(false);
  });
});

/**
 * Отмена вопроса о выходе (⌘Q → Cancel) оставляет приложение и хост работать, поэтому всё, что рвёт связь окна с хостом,
 * не может случиться, пока вопрос открыт: разбор идёт на `quit`, который Electron шлёт, только если ни один слушатель
 * `will-quit` не отменил выход. Раньше разбор висел на `will-quit` — после «Cancel» окно оказывалось на закрытом
 * соединении, а `liveSessions()` в самом вопросе получал null вместо числа сессий.
 */
describe('разбор соединения при выходе', () => {
  function wire(over: Partial<QuitGuardDeps> = {}) {
    const steps: string[] = [];
    const app = new FakeApp(steps);
    let closed = false;
    // Как HostConnection: после close() сокета нет, и число сессий неизвестно.
    const connection = {
      close: vi.fn(() => {
        closed = true;
      }),
    };
    const worksBinding = { dispose: vi.fn() };
    const liveSessions = vi.fn(async () => (closed ? null : 3));
    const ask = vi.fn(async (): Promise<'stop' | 'cancel'> => 'stop');
    const onCancel = vi.fn(() => {
      steps.push('cancel');
    });
    guardAppQuit(app, {
      liveSessions,
      ask,
      stopHost: async () => {
        steps.push('stop-host');
      },
      onCancel,
      keepHost: false,
      log: vi.fn(),
      ...over,
    });
    // Как в main/index.ts.
    app.on('quit', () => {
      worksBinding.dispose();
      connection.close();
    });
    return { app, steps, connection, worksBinding, liveSessions, ask, onCancel };
  }

  it('«cancel» — связь с хостом и привязка works целы, вопрос получил число сессий', async () => {
    const ask = vi.fn(async (): Promise<'stop' | 'cancel'> => 'cancel');
    const { app, steps, connection, worksBinding, onCancel } = wire({ ask });
    expect(app.exit()).toBe(true);
    await vi.waitFor(() => expect(steps).toEqual(['cancel']));
    expect(ask).toHaveBeenCalledWith(3);
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(connection.close).not.toHaveBeenCalled();
    expect(worksBinding.dispose).not.toHaveBeenCalled();
  });

  it('«stop» — хост гасится, выход проходит, и только тогда разбираются привязка и соединение', async () => {
    const { app, steps, connection, worksBinding, liveSessions, ask } = wire();
    expect(app.exit()).toBe(true);
    await vi.waitFor(() => expect(steps).toEqual(['stop-host', 'quit']));
    // Вопрос задан по живому соединению, а выход ещё не состоялся.
    expect(await liveSessions.mock.results[0]?.value).toBe(3);
    expect(ask).toHaveBeenCalledWith(3);
    expect(connection.close).not.toHaveBeenCalled();
    expect(worksBinding.dispose).not.toHaveBeenCalled();

    expect(app.exit()).toBe(false);
    expect(worksBinding.dispose).toHaveBeenCalledTimes(1);
    expect(connection.close).toHaveBeenCalledTimes(1);
  });

  it('отмена, потом ещё выход: второй вопрос тоже получает число сессий', async () => {
    const ask = vi.fn(async (): Promise<'stop' | 'cancel'> => 'cancel');
    const { app, steps, connection, worksBinding } = wire({ ask });
    expect(app.exit()).toBe(true);
    await vi.waitFor(() => expect(steps).toEqual(['cancel']));

    ask.mockResolvedValueOnce('stop');
    expect(app.exit()).toBe(true);
    await vi.waitFor(() => expect(steps).toEqual(['cancel', 'stop-host', 'quit']));
    expect(ask.mock.calls).toEqual([[3], [3]]);
    expect(connection.close).not.toHaveBeenCalled();
    expect(worksBinding.dispose).not.toHaveBeenCalled();
  });

  it('тестовый режим (keepHost): вопроса нет, выход проходит и разбирает привязку и соединение', () => {
    const { app, connection, worksBinding } = wire({ keepHost: true });
    expect(app.exit()).toBe(false);
    expect(worksBinding.dispose).toHaveBeenCalledTimes(1);
    expect(connection.close).toHaveBeenCalledTimes(1);
  });
});

/** Проводка в `main/index.ts`: сторож — единственный, кто держит выход; остальное гасится на `quit`. */
describe('main/index.ts: что делается до ответа на вопрос о выходе', () => {
  const index = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.ts'), 'utf8');

  it('на will-quit и before-quit ничего не вешается: выход может быть отменён, вопрос ещё открыт', () => {
    expect(index).not.toMatch(/app\.on\('(will-quit|before-quit)'/);
  });

  it('привязка works и соединение с хостом разбираются на quit', () => {
    expect(index).toMatch(/app\.on\('quit', \(\) => \{[^}]*worksBinding\?\.dispose\(\)[^}]*connection\.close\(\)/);
  });
});

describe('quitQuestion', () => {
  it('число сессий в тексте и на кнопке', () => {
    const question = quitQuestion(18);
    expect(question.message).toBe('Quit Parley?');
    expect(question.detail).toBe(
      "The host will stop and 18 running sessions will be terminated. They won't restart on their own — the next launch lists them so you can bring them back.",
    );
    expect(question.buttons).toEqual(['Stop 18 sessions and Quit', 'Cancel']);
  });

  it('одна сессия — единственное число', () => {
    const question = quitQuestion(1);
    expect(question.detail).toContain('1 running session will be terminated');
    expect(question.buttons[0]).toBe('Stop 1 session and Quit');
  });

  it('хост не отвечает — без числа', () => {
    const question = quitQuestion(null);
    expect(question.detail).toBe(
      "The host isn't responding. It will be stopped together with all its sessions. They won't restart on their own — the next launch lists them so you can bring them back.",
    );
    expect(question.buttons).toEqual(['Stop host and Quit', 'Cancel']);
  });
});
