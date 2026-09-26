import { describe, expect, it } from 'vitest';
import type { SessionRef } from '@harnas/protocol';
import { createFakeBridge } from './test-utils/fake-bridge.js';
import { createNotificationWatcher, wireNotifications } from './notifications.js';

const ref: SessionRef = { projectPath: '/tmp/proj', workId: 'w-01', sessionId: 's-03' };
const other: SessionRef = { projectPath: '/tmp/proj', workId: 'w-01', sessionId: 's-04' };

describe('createNotificationWatcher', () => {
  it('blocked у невидимой сессии — notify ровно один раз', () => {
    const notified: Array<{ title: string; body: string }> = [];
    const watcher = createNotificationWatcher({
      notify: (note) => notified.push(note),
      setBadge: () => {},
      isVisible: () => false,
      getSessionLabel: () => 'бэкенд',
    });

    watcher.handle(ref, 'blocked');
    watcher.handle(ref, 'blocked');
    watcher.handle(ref, 'blocked');

    expect(notified).toEqual([{ title: 'S03 ждёт ответа', body: 'бэкенд' }]);
  });

  it('у видимой — ни разу', () => {
    const notified: Array<{ title: string; body: string }> = [];
    const watcher = createNotificationWatcher({
      notify: (note) => notified.push(note),
      setBadge: () => {},
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
      setBadge: () => {},
      isVisible: () => false,
      getSessionLabel: () => 'ревью',
    });

    watcher.handle(ref, 'unseen');

    expect(notified).toEqual([{ title: 'S03 закончила ход', body: 'ревью' }]);
  });

  it('бейдж считает сессии в blocked и unseen', () => {
    const badges: number[] = [];
    const watcher = createNotificationWatcher({
      notify: () => {},
      setBadge: (count) => badges.push(count),
      isVisible: () => false,
      getSessionLabel: () => '',
    });

    watcher.handle(ref, 'blocked');
    watcher.handle(other, 'unseen');
    expect(badges.at(-1)).toBe(2);

    watcher.handle(ref, 'working');
    expect(badges.at(-1)).toBe(1);

    watcher.handle(other, 'idle');
    expect(badges.at(-1)).toBe(0);
  });

  it('новая тревога после ухода из неё уведомляет снова', () => {
    const notified: Array<{ title: string; body: string }> = [];
    const watcher = createNotificationWatcher({
      notify: (note) => notified.push(note),
      setBadge: () => {},
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

    expect(bridge.appNotified).toEqual([{ title: 'S03 ждёт ответа', body: 'план' }]);
    expect(bridge.badges.at(-1)).toBe(1);
    dispose();
  });
});
