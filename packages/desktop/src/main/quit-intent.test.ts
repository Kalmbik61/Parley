import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { createQuitIntent } from './quit-intent.js';
import { guardAppQuit } from './quit-guard.js';
import type { QuitGuardDeps } from './quit-guard.js';
import { guardWindowClose } from './window.js';

// `window.ts` берёт `BrowserWindow` из `electron`; настоящий модуль под vitest не нужен.
vi.mock('electron', () => ({ BrowserWindow: class {} }));

/**
 * Подставной `app`, как Electron (`Browser::Quit`): `quit()` во время идущего выхода возвращается сразу и
 * `before-quit` не порождает; отмена `before-quit` (`preventDefault`) выход не начинает. Идущий выход кончается
 * в `finishExit()` (окна закрыты, `will-quit`: отмена — выход не состоялся, иначе событие `quit`) или в
 * `abandon()` (выход брошен: страница отменила выгрузку).
 */
class ElectronApp extends EventEmitter {
  quitting = false;
  /** Сколько раз позвали `quit()`, считая слитые с идущим выходом. */
  calls = 0;
  /** Сколько раз пришёл `before-quit`. */
  beforeQuits = 0;
  quits = 0;

  quit(): void {
    this.calls += 1;
    if (this.quitting) return;
    this.beforeQuits += 1;
    let prevented = false;
    this.emit('before-quit', { preventDefault: () => (prevented = true) });
    if (!prevented) this.quitting = true;
  }

  /** Окна закрыты, `will-quit`. Возвращает, отменён ли выход. */
  finishExit(): boolean {
    let prevented = false;
    this.emit('will-quit', { preventDefault: () => (prevented = true) });
    this.quitting = false;
    if (!prevented) {
      this.quits += 1;
      this.emit('quit');
    }
    return prevented;
  }

  /** Выход брошен на полпути: страница отменила выгрузку. */
  abandon(): void {
    this.quitting = false;
  }
}

/** Подставное окно: `close` и события страницы; настоящий `BrowserWindow` под vitest не поднять. */
function fakeWindow() {
  const closeListeners: Array<(event: { preventDefault(): void }) => void> = [];
  const contents = new Map<string, Array<(event: { preventDefault(): void }) => void>>();
  const sent: string[] = [];
  let destroyed = 0;
  const window = {
    on: (_event: 'close', listener: (event: { preventDefault(): void }) => void) => {
      closeListeners.push(listener);
    },
    close: () => {
      for (const listener of closeListeners) listener({ preventDefault: () => undefined });
    },
    isDestroyed: () => false,
    destroy: () => {
      destroyed += 1;
    },
    webContents: {
      send: (channel: string) => sent.push(channel),
      on: (event: string, listener: (event: { preventDefault(): void }) => void) => {
        contents.set(event, [...(contents.get(event) ?? []), listener]);
      },
      reload: () => undefined,
    },
  };
  return {
    window,
    sent,
    destroyed: () => destroyed,
    /** Окно закрывает человек (крестик): `close` с отменой, если сторож держит. */
    closeByHuman: (): boolean => {
      let prevented = false;
      for (const listener of closeListeners) listener({ preventDefault: () => (prevented = true) });
      return prevented;
    },
    contents: (event: string): void => {
      for (const listener of contents.get(event) ?? []) listener({ preventDefault: () => undefined });
    },
  };
}

/** Клик «Restart now»: запомнить намерение и вызвать выход «своим» вызовом. */
function click(app: ElectronApp, intent: ReturnType<typeof createQuitIntent<string>>): void {
  intent.arm('update');
  intent.ownQuit(() => app.quit());
}

function rig() {
  const app = new ElectronApp();
  const intent = createQuitIntent<string>();
  app.on('before-quit', () => intent.onBeforeQuit());
  const ownQuit = vi.fn((quit: () => void) => intent.ownQuit(quit));
  return { app, intent, ownQuit };
}

function hostGuard(app: ElectronApp, over: Partial<QuitGuardDeps> = {}) {
  return guardAppQuit(app, {
    liveSessions: async () => 3,
    ask: async () => 'stop',
    stopHost: async () => undefined,
    onCancel: () => undefined,
    keepHost: false,
    log: () => undefined,
    ...over,
  });
}

describe('createQuitIntent', () => {
  it('take отдаёт намерение один раз, без arm — null', () => {
    const intent = createQuitIntent<number>();
    expect(intent.take()).toBeNull();
    intent.arm(7);
    expect(intent.take()).toBe(7);
    expect(intent.take()).toBeNull();
  });

  it('новый arm заменяет прежнее намерение; clear сбрасывает', () => {
    const intent = createQuitIntent<string>();
    intent.arm('a');
    intent.arm('b');
    expect(intent.take()).toBe('b');
    intent.arm('c');
    intent.clear();
    expect(intent.take()).toBeNull();
  });

  it('отметка стоит только на время вызова и снимается при исключении', () => {
    const intent = createQuitIntent<string>();
    intent.arm('a');
    expect(() =>
      intent.ownQuit(() => {
        throw new Error('quit failed');
      }),
    ).toThrow('quit failed');
    // Отметка снята: чужой before-quit после неудачного вызова сбрасывает намерение.
    intent.onBeforeQuit();
    expect(intent.take()).toBeNull();
  });

  it('вложенный свой вызов не снимает отметку внешнего раньше времени', () => {
    const intent = createQuitIntent<string>();
    intent.arm('a');
    intent.ownQuit(() => {
      intent.ownQuit(() => undefined);
      intent.onBeforeQuit();
    });
    expect(intent.take()).toBe('a');
  });

  it('SU-10: arm → before-quit своего вызова → выход → take отдаёт намерение один раз', () => {
    const { app, intent } = rig();
    const seen: Array<string | null> = [];
    app.on('quit', () => seen.push(intent.take(), intent.take()));
    click(app, intent);
    expect(app.beforeQuits).toBe(1);
    expect(app.finishExit()).toBe(false);
    expect(seen).toEqual(['update', null]);
  });

  it('before-quit без отметки сбрасывает намерение, до отметки и после неё', () => {
    const { app, intent } = rig();
    intent.arm('update');
    app.quit();
    expect(intent.take()).toBeNull();
  });
});

describe('намерение выхода и сторожа', () => {
  it('SU-11: клик → выход брошен → обычный выход → намерения нет', () => {
    const { app, intent } = rig();
    click(app, intent);
    app.abandon();
    // Намерение осталось в памяти, но следующий выход не повтор — первый же before-quit его сбрасывает.
    app.quit();
    expect(app.beforeQuits).toBe(2);
    const seen: Array<string | null> = [];
    app.on('quit', () => seen.push(intent.take()));
    app.finishExit();
    expect(seen).toEqual([null]);
  });

  it('SU-11: выход, отменённый сторожем окна, потом ⌘Q после «Cancel» — без сценария', () => {
    const { app, intent, ownQuit } = rig();
    const w = fakeWindow();
    const guard = guardWindowClose(w.window, app, { retryQuit: ownQuit });
    guard.setDirtyCount(1);
    click(app, intent);
    expect(w.sent).toEqual(['app:confirm-close']);
    guard.answer('cancel');
    // Ответ «Cancel»: выход не начат, приложение работает дальше; потом ⌘Q с чистыми буферами.
    guard.setDirtyCount(0);
    app.quit();
    const seen: Array<string | null> = [];
    app.on('quit', () => seen.push(intent.take()));
    app.finishExit();
    expect(seen).toEqual([null]);
    expect(ownQuit).not.toHaveBeenCalled();
  });

  it('SU-12: повтор в quit-guard после вопроса и остановки хоста сохраняет намерение', async () => {
    const { app, intent, ownQuit } = rig();
    hostGuard(app, { retryQuit: ownQuit });
    click(app, intent);
    // will-quit держит выход, пока идёт вопрос и остановка хоста, потом повторяет его.
    expect(app.finishExit()).toBe(true);
    await vi.waitFor(() => expect(app.beforeQuits).toBe(2));
    expect(ownQuit).toHaveBeenCalledTimes(1);
    const seen: Array<string | null> = [];
    app.on('quit', () => seen.push(intent.take()));
    expect(app.finishExit()).toBe(false);
    expect(seen).toEqual(['update']);
  });

  it('SU-12 (контроль): тот же повтор без retryQuit намерение сбрасывает', async () => {
    const { app, intent } = rig();
    hostGuard(app);
    click(app, intent);
    expect(app.finishExit()).toBe(true);
    await vi.waitFor(() => expect(app.beforeQuits).toBe(2));
    expect(intent.take()).toBeNull();
  });

  it('SU-12: ответ «закрыть» на вопрос о файлах сохраняет намерение', () => {
    const { app, intent, ownQuit } = rig();
    const w = fakeWindow();
    const guard = guardWindowClose(w.window, app, { retryQuit: ownQuit });
    guard.setDirtyCount(2);
    click(app, intent);
    // Вопрос задан, выход не начат.
    expect(app.quitting).toBe(false);
    expect(w.sent).toEqual(['app:confirm-close']);
    guard.answer('close');
    expect(ownQuit).toHaveBeenCalledTimes(1);
    expect(app.quitting).toBe(true);
    const seen: Array<string | null> = [];
    app.on('quit', () => seen.push(intent.take()));
    app.finishExit();
    expect(seen).toEqual(['update']);
  });

  it('SU-12 (контроль): ответ «закрыть» без retryQuit намерение сбрасывает', () => {
    const { app, intent } = rig();
    const w = fakeWindow();
    const guard = guardWindowClose(w.window, app);
    guard.setDirtyCount(2);
    click(app, intent);
    guard.answer('close');
    expect(intent.take()).toBeNull();
  });

  it('SU-12: «Quit anyway» зависшей страницы при вопросе из-за выхода сохраняет намерение', async () => {
    const { app, intent, ownQuit } = rig();
    const w = fakeWindow();
    const guard = guardWindowClose(w.window, app, { retryQuit: ownQuit, askUnresponsive: async () => 'quit' });
    guard.setDirtyCount(1);
    click(app, intent);
    expect(w.sent).toEqual(['app:confirm-close']);
    w.contents('unresponsive');
    await vi.waitFor(() => expect(w.destroyed()).toBe(1));
    expect(ownQuit).toHaveBeenCalledTimes(1);
    expect(app.quitting).toBe(true);
    const seen: Array<string | null> = [];
    app.on('quit', () => seen.push(intent.take()));
    app.finishExit();
    expect(seen).toEqual(['update']);
  });

  it('SU-12: «Quit anyway» при вопросе из-за крестика окна — прямой выход, намерение сброшено', async () => {
    const { app, intent, ownQuit } = rig();
    const w = fakeWindow();
    const guard = guardWindowClose(w.window, app, { retryQuit: ownQuit, askUnresponsive: async () => 'quit' });
    // Намерение осталось от брошенного «Restart now» (буферы были чистые); потом человек закрыл окно
    // крестиком с грязными буферами, страница зависла.
    click(app, intent);
    app.abandon();
    guard.setDirtyCount(1);
    expect(w.closeByHuman()).toBe(true);
    w.contents('unresponsive');
    await vi.waitFor(() => expect(w.destroyed()).toBe(1));
    expect(ownQuit).not.toHaveBeenCalled();
    expect(app.quitting).toBe(true);
    expect(intent.take()).toBeNull();
  });

  it('SU-13а: клик → вопрос о файлах стоит → ⌘Q → выход без сценария', () => {
    const { app, intent, ownQuit } = rig();
    const w = fakeWindow();
    const guard = guardWindowClose(w.window, app, { retryQuit: ownQuit });
    guard.setDirtyCount(1);
    click(app, intent);
    expect(w.sent).toEqual(['app:confirm-close']);
    // ⌘Q, пока вопрос стоит: чужой before-quit (выход не начат, значит, вызов не слился с идущим).
    app.quit();
    expect(app.beforeQuits).toBe(2);
    expect(w.sent).toEqual(['app:confirm-close']);
    guard.answer('close');
    const seen: Array<string | null> = [];
    app.on('quit', () => seen.push(intent.take()));
    app.finishExit();
    expect(app.quits).toBe(1);
    expect(seen).toEqual([null]);
  });

  it('SU-13а: клик → вопрос о сессиях стоит → ⌘Q → выход без сценария', async () => {
    const { app, intent, ownQuit } = rig();
    let answer!: (value: 'stop' | 'cancel') => void;
    hostGuard(app, {
      retryQuit: ownQuit,
      ask: () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    });
    click(app, intent);
    expect(app.finishExit()).toBe(true);
    await vi.waitFor(() => expect(answer).toBeDefined());
    // Выход держит will-quit, вопрос стоит; человек жмёт ⌘Q.
    app.quit();
    expect(app.beforeQuits).toBe(2);
    expect(app.finishExit()).toBe(true);
    answer('stop');
    await vi.waitFor(() => expect(app.beforeQuits).toBe(3));
    const seen: Array<string | null> = [];
    app.on('quit', () => seen.push(intent.take()));
    expect(app.finishExit()).toBe(false);
    expect(seen).toEqual([null]);
  });

  it('SU-13б: клик → выход идёт → выключение системы сбрасывает намерение явно → выход без сценария', () => {
    const { app, intent } = rig();
    click(app, intent);
    expect(app.quitting).toBe(true);
    // Обработчик выключения: сбросить намерение до своего app.quit(); тот сольётся с идущим выходом.
    intent.clear();
    app.quit();
    expect(app.calls).toBe(2);
    expect(app.beforeQuits).toBe(1);
    const seen: Array<string | null> = [];
    app.on('quit', () => seen.push(intent.take()));
    app.finishExit();
    expect(seen).toEqual([null]);
  });

  it('SU-13б (контроль): слитый с идущим выходом quit() before-quit не порождает — без clear намерение пережило бы выключение', () => {
    const { app, intent } = rig();
    click(app, intent);
    app.quit();
    expect(app.beforeQuits).toBe(1);
    expect(intent.take()).toBe('update');
  });

  it('⌘Q посреди выхода «Restart now» ничего не меняет: это тот же выход', () => {
    const { app, intent } = rig();
    click(app, intent);
    app.quit();
    const seen: Array<string | null> = [];
    app.on('quit', () => seen.push(intent.take()));
    app.finishExit();
    expect(seen).toEqual(['update']);
  });
});
