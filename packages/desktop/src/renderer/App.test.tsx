/**
 * Раунд исправлений 1 куска 1.3, находка B№3 (линза B, живой рендер): фон
 * старой палитры темы окна на корневом `<div>` заменили на `bg-background`,
 * пару `text-foreground` рядом — забыли (спека 4.9: старая палитра уходит
 * целиком). С куска 1.4 старой палитры в кодовой базе больше нет вовсе (её
 * файлы удалены) — тест переживает это как общую проверку: на корневом
 * `<div>` нет произвольного `var(...)`, только именованные токены.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import type { WorkEntry, WorkSession } from '@harnas/core';
import { App } from './App.js';
import type { NewSessionDialogProps } from './components/dialogs/NewSessionDialog.js';
import { createFakeBridge, type FakeBridge } from './test-utils/fake-bridge.js';
import { EMPTY_HISTORY } from './layout/history.js';
import { tabId } from './layout/ids.js';
import { useLayoutStore } from './layout/store.js';
import { emptyLayout, openTab } from './layout/tree.js';
import { useActivityStore } from './store/activity.js';
import { useNoticesStore } from './store/notices.js';
import { useUiStore } from './store/ui.js';
import { useWorksStore } from './store/works.js';

// Тест 6 куска 2.7 читает пропсы диалога новой сессии, а не его разметку:
// что именно диалог делает с `projectPath`/`workId`, проверяет его собственный тест.
const dialogProps = vi.hoisted(() => ({ last: null as NewSessionDialogProps | null }));
vi.mock('./components/dialogs/NewSessionDialog.js', () => ({
  NewSessionDialog: (props: NewSessionDialogProps) => {
    dialogProps.last = props;
    return null;
  },
}));

// Тест 6 открывает вкладку-терминал; настоящий xterm в jsdom падает на
// `matchMedia` — поверхности тут не нужны, раскладка и диалог от них не зависят.
vi.mock('./layout/SurfaceLayer.js', () => ({ SurfaceLayer: () => null }));

// jsdom не знает ResizeObserver — группы раскладки и поверхности терминала
// заводят его при монтировании.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

let bridge: FakeBridge;

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
  useWorksStore.setState({ entries: [], branches: {}, loading: false, error: null });
  useActivityStore.setState({ byRef: {} });
  useNoticesStore.setState({ notices: [] });
  useUiStore.setState({
    windowFocused: true,
    wakePaused: null,
    dialogs: { newWork: false, newSession: { open: false, parentSessionId: null }, settings: false, createRoom: null },
    visibleSessionRefs: {},
  });
  useLayoutStore.setState({
    activeWorkKey: null,
    layouts: {},
    hydrated: {},
    pending: {},
    history: EMPTY_HISTORY,
    mru: {},
    navigating: false,
  });
  dialogProps.last = null;
  // `getHostClient()` читает `window.harnas` лениво — подставляем вручную,
  // как и задумано (комментарий в `host-client.ts`).
  bridge = createFakeBridge();
  window.harnas = bridge;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('App — корневая обёртка окна (раунд исправлений 1, находка B№3)', () => {
  it('text-foreground рядом с bg-background, без произвольного var(--…) старой палитры', () => {
    const { container } = render(<App />);
    const root = container.querySelector('.bg-background');
    expect(root).not.toBeNull();
    expect(root?.className).toContain('text-foreground');
    expect(root?.className ?? '').not.toMatch(/var\(--/);
  });
});

// Раунд исправлений 1 куска E.1 (ревью линза A, Critical): тело настоящего
// macOS-уведомления trust-wait раньше было сырым notice.text хоста
// (по-русски); теперь — noticeText(notice, label) (`shared/strings.ts`).
describe('App — уведомление trust-wait (раунд исправлений 1 куска E.1)', () => {
  it('тело уведомления — английский noticeText, не русский notice.text хоста', () => {
    render(<App />);

    act(() => {
      bridge.emit('host.notice', {
        kind: 'trust-wait',
        ref: null,
        text: 'русский текст хоста, который никто не должен увидеть',
        at: '2026-01-01T00:00:00.000Z',
      });
    });

    expect(bridge.appNotified).toEqual([
      { title: 'Waiting for folder trust', body: 'Not responding since launch — may be waiting for folder trust.' },
    ]);
  });

  it('находит ярлык сессии в снимке работ и подставляет его в тело', () => {
    useWorksStore.setState({
      entries: [
        {
          projectPath: '/tmp/w-01',
          map: {
            schemaVersion: 2,
            rooms: [],
            work: { id: 'w-01', title: 'Первая', goal: '', status: 'active', createdAt: '2026-01-01', updatedAt: '2026-01-01' },
            sessions: [
              {
                id: 's-03',
                provider: 'claude',
                label: 'бэкенд',
                task: '',
                parent: null,
                contextFrom: [],
                lifecycle: 'active',
                result: null,
                resultAt: null,
                closedAt: null,
                history: [],
                startedAt: null,
                endedAt: null,
                pid: null,
                startedAtProcess: null,
                launchedBy: 'host',
                providerSessionId: null,
                metrics: null,
                summary: null,
                summarySource: null,
                artifacts: [],
                agent: null,
              },
            ],
            messages: [],
          },
        },
      ],
      branches: {},
      loading: false,
      error: null,
    });

    render(<App />);

    act(() => {
      bridge.emit('host.notice', {
        kind: 'trust-wait',
        ref: { projectPath: '/tmp/w-01', workId: 'w-01', sessionId: 's-03' },
        text: 'русский',
        at: '2026-01-01T00:00:00.000Z',
      });
    });

    expect(bridge.appNotified).toEqual([
      {
        title: 'Waiting for folder trust',
        body: 'S03 бэкенд: not responding since launch — may be waiting for folder trust.',
      },
    ]);
  });
});

function session(id: string, label: string): WorkSession {
  return {
    id,
    provider: 'claude',
    label,
    task: '',
    parent: null,
    contextFrom: [],
    lifecycle: 'active',
    result: null,
    resultAt: null,
    closedAt: null,
    history: [],
    startedAt: null,
    endedAt: null,
    pid: null,
    startedAtProcess: null,
    launchedBy: 'host',
    providerSessionId: null,
    metrics: null,
    summary: null,
    summarySource: null,
    artifacts: [],
    agent: null,
  };
}

function work(id: string, createdAt: string, sessions: WorkSession[]): WorkEntry {
  return {
    projectPath: `/tmp/${id}`,
    map: {
      schemaVersion: 2,
      rooms: [],
      work: { id, title: id, goal: '', status: 'active', createdAt, updatedAt: createdAt },
      sessions,
      messages: [],
    },
  };
}

// Кусок 2.7: выбор сессии больше не хранится в `store/ui.ts` — ⌘T берёт
// работу из `activeWorkKey`, родителя — из активной вкладки-терминала её
// активной группы (`selectedSessionOf`).
describe('App — меню new-session (тест 6 куска 2.7)', () => {
  it('диалог получает projectPath и workId активной работы и родителя из selectedSessionOf', async () => {
    const w1 = work('w-01', '2026-01-01', [session('s-01', 'план')]);
    const w2 = work('w-02', '2026-01-02', [session('s-01', 'бэк'), session('s-02', 'фронт')]);
    useWorksStore.setState({ entries: [w1, w2], branches: {}, loading: false, error: null });
    const key2 = '/tmp/w-02 w-02';
    const layout = openTab(openTab(emptyLayout(), { kind: 'terminal', id: tabId.terminal('s-01'), sessionId: 's-01' }), {
      kind: 'terminal',
      id: tabId.terminal('s-02'),
      sessionId: 's-02',
    });
    useLayoutStore.setState({ activeWorkKey: key2, layouts: { [key2]: layout }, hydrated: { [key2]: true } });

    render(<App />);
    await act(async () => {
      await Promise.resolve();
    });

    act(() => bridge.emitMenu('new-session'));

    expect(dialogProps.last).toMatchObject({
      open: true,
      projectPath: '/tmp/w-02',
      workId: 'w-02',
      selectedSessionId: 's-02',
    });
  });
});
