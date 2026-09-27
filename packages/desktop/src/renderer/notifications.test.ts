import { describe, expect, it } from 'vitest';
import type { SessionRef } from '@harnas/protocol';
import { createFakeBridge } from './test-utils/fake-bridge.js';
import { createNotificationWatcher, wireNotifications } from './notifications.js';

const ref: SessionRef = { projectPath: '/tmp/proj', workId: 'w-01', sessionId: 's-03' };

describe('createNotificationWatcher', () => {
  it('blocked у невидимой сессии — notify ровно один раз', () => {
    const notified: Array<{ title: string; body: string }> = [];
    const watcher = createNotificationWatcher({
      notify: (note) => notified.push(note),
      isVisible: () => false,
      getSessionLabel: () => 'бэкенд',
    });

    watcher.handle(ref, 'blocked');
    watcher.handle(ref, 'blocked');
    watcher.handle(ref, 'blocked');

    expect(notified).toEqual([{ title: 'S03 needs a reply', body: 'бэкенд' }]);
  });

  it('у видимой — ни разу', () => {
    const notified: Array<{ title: string; body: string }> = [];
    const watcher = createNotificationWatcher({
      notify: (note) => notified.push(note),
      isVisible: () => true,
      getSessionLabel: () => 'бэкенд',
    });

    watcher.handle(ref, 'blocked');
    watcher.handle(ref, 'unseen');

    expect(notified).toEqual([]);
  });

  it('unseen — заголовок «закончила ход»', () => {
    const notified: Array<{ title: string; body: string }> = [];
    const watcher = createNotificationWatcher({
      notify: (note) => notified.push(note),
      isVisible: () => false,
      getSessionLabel: () => 'ревью',
    });

    watcher.handle(ref, 'unseen');

    expect(notified).toEqual([{ title: 'S03 is done', body: 'ревью' }]);
  });

  it('новая тревога после ухода из неё уведомляет снова', () => {
    const notified: Array<{ title: string; body: string }> = [];
    const watcher = createNotificationWatcher({
      notify: (note) => notified.push(note),
      isVisible: () => false,
      getSessionLabel: () => '',
    });

    watcher.handle(ref, 'blocked');
    watcher.handle(ref, 'working');
    watcher.handle(ref, 'blocked');

    expect(notified).toHaveLength(2);
  });
});

describe('wireNotifications', () => {
  it('подключается к activity.changed фейкового бриджа', () => {
    const bridge = createFakeBridge();
    const dispose = wireNotifications(bridge, { isVisible: () => false, getSessionLabel: () => 'план' });

    bridge.emit('activity.changed', {
      ref,
      activity: { activity: 'blocked', subagents: 0, turnEndedAt: null, lastEventAt: null, source: 'hooks', exited: false, hooksMissing: false },
      metrics: null,
    });

    expect(bridge.appNotified).toEqual([{ title: 'S03 needs a reply', body: 'план' }]);
    // Тест 8 куска 4.2: бейдж шлёт App по badgeCount, наблюдатель уведомлений его не ставит.
    expect(bridge.badges).toEqual([]);
    dispose();
  });
});
