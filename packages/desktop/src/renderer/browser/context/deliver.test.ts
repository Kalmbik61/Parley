import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toast } from 'sonner';
import { refKey } from '@parley/protocol';
import { workKey } from '../../../shared/work-keys.js';
import { contextImageOf, resetContextImagesForTests } from '../../chat/context-attachments.js';
import { resetChatUiStoreForTests, useChatUiStore } from '../../chat/ui-store.js';
import { EMPTY_HISTORY } from '../../layout/history.js';
import { useLayoutStore } from '../../layout/store.js';
import { emptyLayout, findTab } from '../../layout/tree.js';
import { roomKey } from '../../lib/room-view.js';
import { useUiStore } from '../../store/ui.js';
import { useWorksStore } from '../../store/works.js';
import { createFakeBridge, type FakeBridge } from '../../test-utils/fake-bridge.js';
import { makeRoom, makeSession, makeWork } from '../../test-utils/work-fixtures.js';
import {
  addContext,
  CONTEXT_TOAST_MS,
  deliverContext,
  openContextTarget,
  resetDeliveryForTests,
  type ContextItem,
  type DeliverDeps,
  type OpenTarget,
} from './deliver.js';

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }));

const ENTRY = makeWork('w-01', {
  projectPath: '/tmp/p',
  sessions: [makeSession('s-02', 'backend'), makeSession('s-03', 'codex', { provider: 'codex' })],
  rooms: [makeRoom('r-01', 'review room')],
});
const KEY = workKey('/tmp/p', 'w-01');
const REF = { projectPath: '/tmp/p', workId: 'w-01', sessionId: 's-02' };
const ITEM: ContextItem = {
  kind: 'element',
  label: 'button.save',
  mdPath: '/h/drops/context/element-button.save-0001.md',
  pngPath: '/h/drops/context/element-button.save-0001.png',
  count: 1,
};
const SECOND: ContextItem = { ...ITEM, label: 'button.cancel', mdPath: '/h/drops/context/element-button.cancel-0002.md', pngPath: null };

let bridge: FakeBridge;
let now = 1_000;
let opened: OpenTarget[] = [];

function deps(target: DeliverDeps['target'], chat = true): DeliverDeps {
  return {
    entry: ENTRY,
    target,
    sendDeps: { bridge, session: () => null, openSession: vi.fn() },
    chatAvailable: () => chat,
    open: (where) => opened.push(where),
    now: () => now,
  };
}

type ToastOptions = { id?: string; action?: { label: string; onClick: () => void }; cancel?: { label: string; onClick: () => void } };

function lastToast(): { text: unknown; options: ToastOptions } {
  const call = vi.mocked(toast).mock.calls.at(-1);
  return { text: call?.[0], options: (call?.[1] ?? {}) as ToastOptions };
}

const chatPaths = (): readonly string[] => useChatUiStore.getState().attachments[refKey(REF)] ?? [];
const roomPaths = (): readonly string[] => useUiStore.getState().composerAttachments[roomKey(KEY, 'r-01')] ?? [];

beforeEach(() => {
  bridge = createFakeBridge();
  now = 1_000;
  opened = [];
  vi.mocked(toast).mockClear();
  vi.mocked(toast.error).mockClear();
  resetDeliveryForTests();
  resetChatUiStoreForTests();
  resetContextImagesForTests();
  useUiStore.setState({ composerAttachments: {} });
});

describe('deliverContext (спека браузера 4.5)', () => {
  it('сессия с Chat — путь во вложения её поля, агенту ничего не ушло; тост с Open и Undo', async () => {
    expect(await deliverContext(ITEM, deps({ kind: 'session', sessionId: 's-02' }))).toBe('chat');
    expect(chatPaths()).toEqual([ITEM.mdPath]);
    expect(bridge.calls.filter((call) => call.method === 'pty.send')).toEqual([]);
    const { text, options } = lastToast();
    expect(text).toBe('1 element added to S02');
    options.action?.onClick();
    expect(opened).toEqual([{ kind: 'session', ref: REF, chat: true }]);
    options.cancel?.onClick();
    expect(chatPaths()).toEqual([]);
  });

  it('комната — путь во вложения поля комнаты; Open ведёт в комнату', async () => {
    expect(await deliverContext(ITEM, deps({ kind: 'room', roomId: 'r-01' }))).toBe('room');
    expect(roomPaths()).toEqual([ITEM.mdPath]);
    const { text, options } = lastToast();
    expect(text).toBe('1 element added to review room');
    options.action?.onClick();
    expect(opened).toEqual([{ kind: 'room', projectPath: '/tmp/p', workId: 'w-01', roomId: 'r-01' }]);
  });

  it('сессия без Chat — одна строка в ввод CLI без Enter (submit: false); тост без Undo', async () => {
    bridge.setHandler('pty.send', () => ({ inserted: true, submitted: false, reason: null }));
    expect(await deliverContext(ITEM, deps({ kind: 'session', sessionId: 's-03' }, false))).toBe('terminal');
    expect(bridge.calls.filter((call) => call.method === 'pty.send')).toEqual([
      {
        method: 'pty.send',
        params: {
          ref: { ...REF, sessionId: 's-03' },
          text: `Page element button.save: ${ITEM.mdPath} (screenshot: ${ITEM.pngPath})`,
          submit: false,
        },
      },
    ]);
    const { text, options } = lastToast();
    expect(text).toBe('1 element added to S03');
    expect(options.cancel).toBeUndefined();
  });

  it('сессия без Chat ждёт ответа (blocked) — failed, тост отказа от sendWithToast, своего нет', async () => {
    bridge.setHandler('pty.send', () => ({ inserted: false, submitted: false, reason: 'blocked' }));
    expect(await deliverContext(ITEM, deps({ kind: 'session', sessionId: 's-03' }, false))).toBe('failed');
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(vi.mocked(toast).mock.calls.some(([text]) => String(text).includes('added to'))).toBe(false);
  });

  it('Фокус ревью 5: два элемента подряд в одну цель — один тост «2 elements», Undo убирает оба; другая цель и пауза — новый тост', async () => {
    await deliverContext(ITEM, deps({ kind: 'session', sessionId: 's-02' }));
    now += 1_000;
    await deliverContext(SECOND, deps({ kind: 'session', sessionId: 's-02' }));
    expect(chatPaths()).toEqual([ITEM.mdPath, SECOND.mdPath]);
    const firstId = (vi.mocked(toast).mock.calls[0]?.[1] as ToastOptions).id;
    const merged = lastToast();
    expect(merged.text).toBe('2 elements added to S02');
    expect(merged.options.id).toBe(firstId);
    merged.options.cancel?.onClick();
    expect(chatPaths()).toEqual([]);

    await deliverContext(ITEM, deps({ kind: 'room', roomId: 'r-01' }));
    const roomToast = lastToast().options.id;
    expect(roomToast).not.toBe(firstId);
    now += CONTEXT_TOAST_MS + 1;
    await deliverContext(SECOND, deps({ kind: 'room', roomId: 'r-01' }));
    expect(lastToast().options.id).not.toBe(roomToast);
    expect(lastToast().text).toBe('1 element added to review room');
  });

  it('разные виды в одной пачке — «items»; onUndo пункта зовётся по Undo', async () => {
    const onUndo = vi.fn();
    await deliverContext({ ...ITEM, kind: 'console', label: 'error-boom', pngPath: null, onUndo }, deps({ kind: 'room', roomId: 'r-01' }));
    await deliverContext(SECOND, deps({ kind: 'room', roomId: 'r-01' }));
    expect(lastToast().text).toBe('2 items added to review room');
    lastToast().options.cancel?.onClick();
    expect(onUndo).toHaveBeenCalledTimes(1);
    expect(roomPaths()).toEqual([]);
  });
});

describe('addContext', () => {
  it('saveContext, снимок запомнен для composePrompt, путь доставлен', async () => {
    const result = await addContext(
      { kind: 'element', label: 'button.save', markdown: '# x\n', imagePath: '/h/drops/a.png', count: 1 },
      { ...deps({ kind: 'session', sessionId: 's-02' }), bridge },
    );
    expect(result).toBe('chat');
    expect(chatPaths()).toEqual(['/fake/drops/context/element-button.save-0001.md']);
    expect(contextImageOf('/fake/drops/context/element-button.save-0001.md')).toBe('/fake/drops/context/element-button.save-0001.png');
  });

  it("отказ записи — тост «Couldn't add to chat: …», в поле ничего", async () => {
    bridge.setSaveContextResult({ code: 'failed', message: 'disk full' });
    const result = await addContext({ kind: 'console', label: 'x', markdown: '#', imagePath: null, count: 1 }, { ...deps({ kind: 'session', sessionId: 's-02' }), bridge });
    expect(result).toBe('failed');
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining("Couldn't add to chat"));
    expect(chatPaths()).toEqual([]);
  });
});

describe('openContextTarget', () => {
  afterEach(() => {
    vi.useRealTimers();
    useWorksStore.setState({ entries: [] });
  });

  it('сессия с Chat — её работа активна, вкладка сессии открыта в виде chat', () => {
    vi.useFakeTimers();
    useWorksStore.setState({ entries: [ENTRY] });
    useLayoutStore.setState({
      activeWorkKey: null,
      layouts: { [KEY]: emptyLayout() },
      hydrated: { [KEY]: true },
      pending: {},
      history: EMPTY_HISTORY,
      mru: {},
      navigating: false,
    });
    openContextTarget({ kind: 'session', ref: REF, chat: true });
    const state = useLayoutStore.getState();
    expect(state.activeWorkKey).toBe(KEY);
    const layout = state.layouts[KEY];
    const found = layout === undefined ? null : findTab(layout, 'terminal:s-02');
    expect(found?.group.tabs[found.index]).toEqual({ kind: 'terminal', id: 'terminal:s-02', sessionId: 's-02', view: 'chat' });
    // Ожидание показа вкладки (whenShown) — опрос с пределом 2 с: доигрываем его таймеры.
    vi.runAllTimers();
  });
});
