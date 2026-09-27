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
import { App } from './App.js';
import { createFakeBridge, type FakeBridge } from './test-utils/fake-bridge.js';
import { useActivityStore } from './store/activity.js';
import { useNoticesStore } from './store/notices.js';
import { useUiStore } from './store/ui.js';
import { useWorksStore } from './store/works.js';

// jsdom не знает ResizeObserver — `Workspace.tsx` заводит его на dockview
// безусловно, даже без открытых панелей терминала (тот же стаб, что и в
// `Workspace.test.tsx`).
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
    selectedRef: null,
    selectedWorkKey: null,
    windowFocused: true,
    wakePaused: null,
    dialogs: { newWork: false, newSession: { open: false, parentSessionId: null }, settings: false, createRoom: null },
    lastSessionByWork: {},
    activePanelId: null,
    visibleSessionRefs: {},
    recentSessionRefs: [],
  });
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
