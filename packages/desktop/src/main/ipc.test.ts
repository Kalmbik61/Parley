import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IpcMain } from 'electron';
import type { WorksSnapshot } from '@harnas/protocol';
import { decodeIpcError } from '../shared/ipc-error.js';
import { workKey } from '../shared/work-keys.js';
import { DEFAULT_UI } from '../shared/ui-types.js';
import { HostError, type HostConnection } from './host-connection.js';
import { LayoutTooLargeError, type LayoutStore } from './layout-store.js';
import type { UiStore } from './ui-store.js';
import { registerIpc, withIpcError } from './ipc.js';
import { createRootsRegistry, FilesDeniedError, type RootsRegistry } from './roots.js';

/** Подставной `ipcMain`: сохраняет обработчики и умеет их дёргать, как настоящий `invoke`. */
class FakeIpcMain {
  private readonly handlers = new Map<string, (...args: unknown[]) => unknown>();

  handle(channel: string, fn: (...args: unknown[]) => unknown): void {
    this.handlers.set(channel, fn);
  }

  on(channel: string, fn: (...args: unknown[]) => unknown): void {
    this.handlers.set(channel, fn);
  }

  invoke(channel: string, ...args: unknown[]): unknown {
    const handler = this.handlers.get(channel);
    if (!handler) throw new Error(`нет обработчика для ${channel}`);
    return handler({}, ...args);
  }

  /** Как `invoke`, но со своим событием — для каналов, которые читают `event.sender`. */
  invokeWithEvent(channel: string, event: unknown, ...args: unknown[]): unknown {
    const handler = this.handlers.get(channel);
    if (!handler) throw new Error(`нет обработчика для ${channel}`);
    return handler(event, ...args);
  }
}

function setup(overrides: { uiStore?: UiStore; layoutStore?: LayoutStore; roots?: RootsRegistry } = {}): {
  ipcMain: FakeIpcMain;
  connection: HostConnection;
  layoutStore: LayoutStore;
  uiStore: UiStore;
  setAppearance: ReturnType<typeof vi.fn>;
  titlebarDoubleClick: ReturnType<typeof vi.fn>;
  showItemInFolder: ReturnType<typeof vi.fn>;
  showNotification: ReturnType<typeof vi.fn>;
  takeFocusTarget: ReturnType<typeof vi.fn>;
  openPath: ReturnType<typeof vi.fn>;
} {
  const ipcMain = new FakeIpcMain();
  const connection = {
    call: vi.fn().mockResolvedValue({ ok: true }),
    notify: vi.fn(),
    restartHost: vi.fn(),
    onEvent: vi.fn(),
    onStatus: vi.fn(),
    activitySnapshot: vi.fn().mockReturnValue([{ ref: { sessionId: 's-1' } }]),
  } as unknown as HostConnection;
  const layoutStore: LayoutStore =
    overrides.layoutStore ??
    ({
      load: vi.fn().mockResolvedValue(null),
      save: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
      retain: vi.fn().mockResolvedValue(undefined),
    } satisfies LayoutStore);
  const uiStore: UiStore =
    overrides.uiStore ??
    ({
      load: vi.fn().mockResolvedValue(DEFAULT_UI),
      save: vi.fn().mockResolvedValue(DEFAULT_UI),
    } satisfies UiStore);
  const setAppearance = vi.fn();
  const titlebarDoubleClick = vi.fn();
  const showItemInFolder = vi.fn();
  const showNotification = vi.fn();
  const takeFocusTarget = vi.fn().mockReturnValue(null);
  // Настоящие shell.openPath/showItemInFolder тесты не зовут никогда: открыли бы приложения
  // и Finder на экране человека (решение контролёра 5.2).
  const openPath = vi.fn().mockResolvedValue('');
  const roots: RootsRegistry =
    overrides.roots ??
    ({
      resolve: vi.fn().mockRejectedValue(new FilesDeniedError('no roots')),
      locate: vi.fn().mockResolvedValue(null),
      insideAnyRoot: vi.fn().mockResolvedValue(null),
      roots: vi.fn().mockReturnValue([]),
      expandHome: vi.fn((p: string) => p),
    } satisfies RootsRegistry);

  registerIpc({
    ipcMain: ipcMain as unknown as IpcMain,
    connection,
    layoutStore,
    uiStore,
    setAppearance,
    titlebarDoubleClick,
    openExternal: vi.fn().mockResolvedValue(undefined),
    chooseFolder: vi.fn(),
    showNotification,
    takeFocusTarget,
    setBadge: vi.fn(),
    showItemInFolder,
    roots,
    openPath,
  });

  return {
    ipcMain,
    connection,
    layoutStore,
    uiStore,
    setAppearance,
    titlebarDoubleClick,
    showItemInFolder,
    showNotification,
    takeFocusTarget,
    openPath,
  };
}

describe('registerIpc', () => {
  it('host:activity-snapshot отдаёт снимок активности из HostConnection (раунд исправлений 1 куска 3.1)', async () => {
    const { ipcMain } = setup();
    expect(await ipcMain.invoke('host:activity-snapshot')).toEqual([{ ref: { sessionId: 's-1' } }]);
  });

  it('неизвестный метод отвергается', async () => {
    const { ipcMain } = setup();
    await expect(ipcMain.invoke('host:call', 'no.such.method', {})).rejects.toThrow();
  });

  it('известный метод уходит в HostConnection.call', async () => {
    const { ipcMain, connection } = setup();
    await ipcMain.invoke('host:call', 'works.list', {});
    expect(connection.call).toHaveBeenCalledWith('works.list', {});
  });

  // Кусок E.1: HostError, дошедший от хоста через HostConnection.call, обязан
  // нести свой код протокола через encodeIpcError — рендерер читает его
  // decodeIpcError и показывает errorText(code), а не русский текст хоста
  // (тот — только console.warn у вызывающей стороны).
  it('HostError от HostConnection.call доходит до рендерера с кодом (тест 4 куска E.1)', async () => {
    const { ipcMain, connection } = setup();
    vi.mocked(connection.call).mockRejectedValueOnce(new HostError('conflict', 'у работы есть живая сессия'));

    await expect(ipcMain.invoke('host:call', 'works.delete', {})).rejects.toSatisfy((error: unknown) => {
      expect(decodeIpcError(error)).toEqual({ code: 'conflict', message: 'у работы есть живая сессия' });
      return true;
    });
  });

  it('прочая (не HostError) ошибка host:call доходит до рендерера с кодом failed', async () => {
    const { ipcMain, connection } = setup();
    vi.mocked(connection.call).mockRejectedValueOnce(new Error('socket разорван'));

    await expect(ipcMain.invoke('host:call', 'works.list', {})).rejects.toSatisfy((error: unknown) => {
      expect(decodeIpcError(error)).toEqual({ code: 'failed', message: 'socket разорван' });
      return true;
    });
  });

  it('openExternal(file:///etc/passwd) и javascript: отвергаются', async () => {
    const { ipcMain } = setup();
    await expect(ipcMain.invoke('app:open-external', 'file:///etc/passwd')).rejects.toThrow();
    await expect(ipcMain.invoke('app:open-external', 'javascript:alert(1)')).rejects.toThrow();
  });

  it('openExternal с http/https проходит', async () => {
    const { ipcMain } = setup();
    await expect(
      ipcMain.invoke('app:open-external', 'https://example.com'),
    ).resolves.toBeUndefined();
  });

  it('app:load-layout и app:save-layout уходят в LayoutStore (кусок 2.2)', async () => {
    const { ipcMain, layoutStore } = setup();
    await ipcMain.invoke('app:load-layout', 'window');
    expect(layoutStore.load).toHaveBeenCalledWith('window');

    await ipcMain.invoke('app:save-layout', 'window', { a: 1 });
    expect(layoutStore.save).toHaveBeenCalledWith('window', { a: 1 });
  });

  it('app:remove-layout и app:retain-layouts уходят в LayoutStore (кусок 2.2)', async () => {
    const { ipcMain, layoutStore } = setup();
    await ipcMain.invoke('app:remove-layout', 'w-01');
    expect(layoutStore.remove).toHaveBeenCalledWith('w-01');

    await ipcMain.invoke('app:retain-layouts', ['w-01', 'w-02']);
    expect(layoutStore.retain).toHaveBeenCalledWith(['w-01', 'w-02']);
  });

  it('app:retain-layouts с не-строкой в списке отвергается', async () => {
    const { ipcMain, layoutStore } = setup();
    await expect(ipcMain.invoke('app:retain-layouts', ['w-01', 1])).rejects.toThrow();
    expect(layoutStore.retain).not.toHaveBeenCalled();
  });

  // Раунд исправлений 1, Important B: "__proto__"/"constructor"/"prototype" —
  // валидные строки по `typeof`, но ломают `filterWorks`/плоские объекты
  // ниже по цепочке (main/layout-store.ts) — канал обязан отвергать их сам,
  // как единственный слой с «проверкой аргументов» из сквозных правил.
  it('app:load-layout/app:save-layout/app:remove-layout отвергают "__proto__"/"constructor"/"prototype", пустую строку и слишком длинный ключ', async () => {
    const { ipcMain, layoutStore } = setup();
    const bad = ['__proto__', 'constructor', 'prototype', '', 'x'.repeat(4097)];

    for (const workKey of bad) {
      await expect(ipcMain.invoke('app:load-layout', workKey)).rejects.toThrow();
      await expect(ipcMain.invoke('app:save-layout', workKey, {})).rejects.toThrow();
      await expect(ipcMain.invoke('app:remove-layout', workKey)).rejects.toThrow();
    }
    expect(layoutStore.load).not.toHaveBeenCalled();
    expect(layoutStore.save).not.toHaveBeenCalled();
    expect(layoutStore.remove).not.toHaveBeenCalled();
  });

  it('app:retain-layouts отвергает массив с "__proto__"/"constructor"/"prototype"', async () => {
    const { ipcMain, layoutStore } = setup();
    await expect(ipcMain.invoke('app:retain-layouts', ['ok', '__proto__'])).rejects.toThrow();
    await expect(ipcMain.invoke('app:retain-layouts', ['constructor'])).rejects.toThrow();
    expect(layoutStore.retain).not.toHaveBeenCalled();
  });

  it('app:load-layout принимает обычный workKey и ключ ровно в 4096 символов', async () => {
    const { ipcMain, layoutStore } = setup();
    const maxLenKey = 'x'.repeat(4096);

    await ipcMain.invoke('app:load-layout', 'window');
    await ipcMain.invoke('app:load-layout', maxLenKey);

    expect(layoutStore.load).toHaveBeenCalledWith('window');
    expect(layoutStore.load).toHaveBeenCalledWith(maxLenKey);
  });

  // Тест 14 куска 2.2: раскладка больше лимита не должна доходить до рендерера
  // отказом — план требует тихого предупреждения в консоль main и успешного ответа.
  it('app:save-layout при LayoutTooLargeError пишет console.warn и отвечает успехом (тест 14)', async () => {
    const tooLarge = new LayoutTooLargeError('/tmp/layouts.json', 2_000_000, 1_000_000);
    const layoutStore: LayoutStore = {
      load: vi.fn().mockResolvedValue(null),
      save: vi.fn().mockRejectedValue(tooLarge),
      remove: vi.fn().mockResolvedValue(undefined),
      retain: vi.fn().mockResolvedValue(undefined),
    };
    const { ipcMain } = setup({ layoutStore });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(ipcMain.invoke('app:save-layout', 'w-01', { huge: true })).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(tooLarge.message));

    warnSpy.mockRestore();
  });

  it('app:save-layout пробрасывает прочие ошибки LayoutStore (не глотает их вслепую)', async () => {
    const layoutStore: LayoutStore = {
      load: vi.fn().mockResolvedValue(null),
      save: vi.fn().mockRejectedValue(new Error('диск сломался')),
      remove: vi.fn().mockResolvedValue(undefined),
      retain: vi.fn().mockResolvedValue(undefined),
    };
    const { ipcMain } = setup({ layoutStore });

    await expect(ipcMain.invoke('app:save-layout', 'w-01', { a: 1 })).rejects.toThrow('диск сломался');
  });

  it('app:load-ui и app:save-ui уходят в UiStore (кусок 1.1)', async () => {
    const { ipcMain, uiStore } = setup();
    await ipcMain.invoke('app:load-ui');
    expect(uiStore.load).toHaveBeenCalled();

    await ipcMain.invoke('app:save-ui', { appearance: 'dark' });
    expect(uiStore.save).toHaveBeenCalledWith({ appearance: 'dark' });
  });

  // Тест 14 раунда исправлений (находка I3): `typeof [] === 'object'` — старая
  // проверка `typeof patch !== 'object' || patch === null` пропускала массивы.
  it('app:save-ui отвергает массив, null и не-объект (тест 14)', async () => {
    const { ipcMain } = setup();
    await expect(ipcMain.invoke('app:save-ui', [1, 2, 3])).rejects.toThrow();
    await expect(ipcMain.invoke('app:save-ui', null)).rejects.toThrow();
    await expect(ipcMain.invoke('app:save-ui', 'oops')).rejects.toThrow();
  });

  it('app:set-appearance меняет тему и пишет ui.json (спека 4.7)', async () => {
    const { ipcMain, uiStore, setAppearance } = setup();
    await ipcMain.invoke('app:set-appearance', 'dark');

    expect(setAppearance).toHaveBeenCalledWith('dark');
    expect(uiStore.save).toHaveBeenCalledWith({ appearance: 'dark' });
  });

  it('app:titlebar-double-click зовёт обработчик (кусок 2.3)', () => {
    const { ipcMain, titlebarDoubleClick } = setup();
    ipcMain.invoke('app:titlebar-double-click');
    expect(titlebarDoubleClick).toHaveBeenCalled();
  });

  it('тест 14 куска 5.3: app:paste зовёт paste() у event.sender', () => {
    const { ipcMain } = setup();
    const paste = vi.fn();
    ipcMain.invokeWithEvent('app:paste', { sender: { paste } });
    expect(paste).toHaveBeenCalledTimes(1);
  });

  it('app:set-appearance с неверным режимом отвергается', async () => {
    const { ipcMain, setAppearance } = setup();
    await expect(ipcMain.invoke('app:set-appearance', 'blue')).rejects.toThrow();
    expect(setAppearance).not.toHaveBeenCalled();
  });

  // Тест 14 раунда исправлений (находка I4): запись на диск должна случиться
  // ДО смены nativeTheme.themeSource — иначе при отказе записи окно уже
  // сменило тему в памяти, а ui.json остался со старой, и на следующем
  // перезапуске тема «откатится» без действия пользователя.
  it('app:set-appearance: падение uiStore.save отклоняет промис и не трогает тему (тест 14)', async () => {
    const failingUiStore: UiStore = {
      load: vi.fn().mockResolvedValue(DEFAULT_UI),
      save: vi.fn().mockRejectedValue(new Error('диск сломался')),
    };
    const { ipcMain, setAppearance } = setup({ uiStore: failingUiStore });

    await expect(ipcMain.invoke('app:set-appearance', 'dark')).rejects.toThrow('диск сломался');
    expect(setAppearance).not.toHaveBeenCalled();
  });

  // Тест 17 куска 3.4: «Reveal in Finder» — main сам сверяет работу со снимком хоста,
  // рендерер не может открыть в Finder произвольный путь.
  it('app:reveal-work существующей работы зовёт showItemInFolder(projectPath), чужой — not_found без вызова (тест 17 куска 3.4)', async () => {
    const { ipcMain, connection, showItemInFolder } = setup();
    const entry = { projectPath: '/tmp/proj', map: { work: { id: 'w-0001' } } };
    vi.mocked(connection.call).mockResolvedValue({ entries: [entry], branches: {} });

    await ipcMain.invoke('app:reveal-work', '/tmp/proj', 'w-0001');
    expect(connection.call).toHaveBeenCalledWith('works.list', {});
    expect(showItemInFolder).toHaveBeenCalledWith('/tmp/proj');

    showItemInFolder.mockClear();
    for (const args of [['/etc', 'w-0001'], ['/tmp/proj', 'w-9999'], [42, 'w-0001'], ['/tmp/proj', null]]) {
      await expect(ipcMain.invoke('app:reveal-work', ...args)).rejects.toSatisfy((error: unknown) => {
        expect(decodeIpcError(error).code).toBe('not_found');
        return true;
      });
    }
    expect(showItemInFolder).not.toHaveBeenCalled();
  });
});

// Тесты 8 и 12 куска 4.3: `app:notify` принимает только `AppNote` и режет тексты до 200
// кодовых точек; `app:take-focus-target` отдаёт отложенную цель main.
describe('registerIpc — app:notify и app:take-focus-target (кусок 4.3)', () => {
  const target = { kind: 'session', ref: { projectPath: '/tmp/p', workId: 'w-01', sessionId: 's-02' } };
  const note = { title: 'Redesign · S02 executor — needs you', body: 'task', tag: 'session:x', target, silent: false };

  it('верный AppNote доходит до showNotification как есть', () => {
    const { ipcMain, showNotification } = setup();
    ipcMain.invoke('app:notify', note);
    expect(showNotification).toHaveBeenCalledWith(note);
  });

  it('цели почты и комнаты — тоже верная форма', () => {
    const { ipcMain, showNotification } = setup();
    ipcMain.invoke('app:notify', { ...note, target: { kind: 'mail', projectPath: '/tmp/p', workId: 'w-01' } });
    ipcMain.invoke('app:notify', { ...note, target: { kind: 'room', projectPath: '/tmp/p', workId: 'w-01', roomId: 'r-1' } });
    expect(showNotification).toHaveBeenCalledTimes(2);
  });

  it('title из 201 эмодзи — показано ровно 200 кодовых точек, последняя «…», суррогаты целы', () => {
    const { ipcMain, showNotification } = setup();
    ipcMain.invoke('app:notify', { ...note, title: '😀'.repeat(201), body: '😀'.repeat(201) });
    const shown = showNotification.mock.calls[0]?.[0] as { title: string; body: string };
    for (const text of [shown.title, shown.body]) {
      const points = Array.from(text);
      expect(points).toHaveLength(200);
      expect(points[199]).toBe('…');
      expect(points.slice(0, 199).every((point) => point === '😀')).toBe(true);
    }
  });

  it.each([
    ['target чужой формы', { ...note, target: { kind: 'session', ref: { projectPath: '/tmp/p' } } }],
    ['target неизвестного вида', { ...note, target: { kind: 'browser', url: 'https://x' } }],
    ['комната без roomId', { ...note, target: { kind: 'room', projectPath: '/tmp/p', workId: 'w-01' } }],
    ["silent: 'yes'", { ...note, silent: 'yes' }],
    ['tag: 1', { ...note, tag: 1 }],
    ['title не строка', { ...note, title: null }],
    ['не объект', 'note'],
    ['null', null],
  ])('%s — отказ, showNotification не зван', (_name, bad) => {
    const { ipcMain, showNotification } = setup();
    ipcMain.invoke('app:notify', bad);
    expect(showNotification).not.toHaveBeenCalled();
  });

  it('app:take-focus-target отдаёт отложенную цель, повтор — null', async () => {
    const { ipcMain, takeFocusTarget } = setup();
    takeFocusTarget.mockReturnValueOnce(target).mockReturnValueOnce(null);
    await expect(ipcMain.invoke('app:take-focus-target')).resolves.toEqual(target);
    await expect(ipcMain.invoke('app:take-focus-target')).resolves.toBeNull();
  });
});

/** Код ошибки канала, как его прочтёт рендерер; `resolved` — канал ответил успехом. */
async function codeOf(promise: unknown): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return decodeIpcError(error).code;
  }
  return 'resolved';
}

describe('withIpcError (кусок 5.2, тест 15)', () => {
  it('FilesDeniedError → files:denied, HostError — свой код, прочее — failed', async () => {
    expect(await codeOf(withIpcError(() => Promise.reject(new FilesDeniedError('outside')))({}))).toBe('files:denied');
    expect(await codeOf(withIpcError(() => Promise.reject(new HostError('not_found', 'x')))({}))).toBe('not_found');
    expect(await codeOf(withIpcError(() => Promise.reject(new Error('boom')))({}))).toBe('failed');
    expect(await codeOf(withIpcError(() => {
      throw new FilesDeniedError('sync');
    })({}))).toBe('files:denied');
  });
});

describe('app:open-path и app:show-in-finder (кусок 5.2, тест 13)', () => {
  let dir = '';
  let project = '';
  let other = '';
  let roots: RootsRegistry;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'harnas-openpath-'));
    project = path.join(dir, 'home', 'proj');
    other = path.join(dir, 'other');
    await mkdir(project, { recursive: true });
    await mkdir(other);
    const snapshot = {
      branches: {},
      entries: [
        { projectPath: project, map: { work: { id: 'w-1' }, sessions: [] } },
        { projectPath: other, map: { work: { id: 'w-2' }, sessions: [] } },
      ],
    } as unknown as WorksSnapshot;
    roots = createRootsRegistry(
      {
        list: async () => snapshot,
        onChange: () => () => {},
        onConnected: (listener) => {
          listener();
          return () => {};
        },
      },
      { home: path.join(dir, 'home') },
    );
    await vi.waitFor(() => expect(roots.roots(workKey(other, 'w-2'))).toHaveLength(1));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('.command в корне — showItemInFolder, openPath не вызван, ответ revealed', async () => {
    const script = path.join(project, 'run.command');
    await writeFile(script, 'echo hi');
    const { ipcMain, openPath, showItemInFolder } = setup({ roots });
    expect(await ipcMain.invoke('app:open-path', script)).toBe('revealed');
    expect(showItemInFolder).toHaveBeenCalledWith(script);
    expect(openPath).not.toHaveBeenCalled();
  });

  it('симлинк link.txt → a.txt (0644) — openPath: права по ссылке (stat), а не у самой ссылки', async () => {
    await writeFile(path.join(project, 'a.txt'), 'a');
    await chmod(path.join(project, 'a.txt'), 0o644);
    await symlink('a.txt', path.join(project, 'link.txt'));
    const { ipcMain, openPath, showItemInFolder } = setup({ roots });
    expect(await ipcMain.invoke('app:open-path', path.join(project, 'link.txt'))).toBe('opened');
    expect(openPath).toHaveBeenCalledWith(path.join(await realpath(project), 'a.txt'));
    expect(showItemInFolder).not.toHaveBeenCalled();
  });

  it('~/… внутри корня раскрыт по подставному дому и открыт; путь в корне другой работы — открыт', async () => {
    await writeFile(path.join(project, 'report.pdf'), '%PDF');
    await writeFile(path.join(other, 'notes.md'), '#');
    const { ipcMain, openPath } = setup({ roots });
    expect(await ipcMain.invoke('app:open-path', '~/proj/report.pdf')).toBe('opened');
    expect(openPath).toHaveBeenLastCalledWith(path.join(await realpath(project), 'report.pdf'));
    expect(await ipcMain.invoke('app:open-path', path.join(other, 'notes.md'))).toBe('opened');
    expect(openPath).toHaveBeenLastCalledWith(path.join(await realpath(other), 'notes.md'));
  });

  it('непустой ответ shell.openPath — ошибка failed', async () => {
    await writeFile(path.join(project, 'a.txt'), 'a');
    const { ipcMain, openPath } = setup({ roots });
    openPath.mockResolvedValueOnce('No application knows how to open');
    expect(await codeOf(ipcMain.invoke('app:open-path', path.join(project, 'a.txt')))).toBe('failed');
  });

  it('путь вне корней — files:denied; showInFinder — то же, а внутри корня зовёт showItemInFolder с раскрытым путём', async () => {
    await writeFile(path.join(dir, 'outside.txt'), '');
    await writeFile(path.join(project, 'a.txt'), '');
    const { ipcMain, openPath, showItemInFolder } = setup({ roots });
    expect(await codeOf(ipcMain.invoke('app:open-path', path.join(dir, 'outside.txt')))).toBe('files:denied');
    expect(await codeOf(ipcMain.invoke('app:open-path', '/etc/hosts'))).toBe('files:denied');
    expect(await codeOf(ipcMain.invoke('app:show-in-finder', '/etc/hosts'))).toBe('files:denied');
    expect(openPath).not.toHaveBeenCalled();
    expect(showItemInFolder).not.toHaveBeenCalled();

    expect(await ipcMain.invoke('app:show-in-finder', '~/proj/a.txt')).toBeUndefined();
    expect(showItemInFolder).toHaveBeenCalledWith(path.join(project, 'a.txt'));
  });

  it('не-строка и NUL — отказ до диска (тест 14)', async () => {
    const { ipcMain, openPath, showItemInFolder } = setup({ roots });
    for (const value of [42, null, ['/a'], { path: '/a' }, '/a\0b']) {
      expect(await codeOf(ipcMain.invoke('app:open-path', value))).toBe('bad_request');
      expect(await codeOf(ipcMain.invoke('app:show-in-finder', value))).toBe('bad_request');
    }
    expect(openPath).not.toHaveBeenCalled();
    expect(showItemInFolder).not.toHaveBeenCalled();
  });
});
