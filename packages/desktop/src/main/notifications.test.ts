/**
 * Тесты 1 и 8 куска 4.3: уведомитель main держит одно уведомление на тег, клик поднимает
 * окно и отдаёт цель; отложенная цель отдаётся один раз. Настоящий `Notification` Electron
 * здесь не создаётся — только подставной.
 */

import { describe, expect, it, vi } from 'vitest';
import type { AppNote, FocusTarget } from '../shared/bridge.js';
import { createLoggedNotification, createNotifier, createPendingFocusTarget, type NotificationLike } from './notifications.js';

interface FakeNotification extends NotificationLike {
  options: { title: string; body: string; silent: boolean };
  show: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  fire(event: 'click' | 'close'): void;
}

function setup(): {
  created: FakeNotification[];
  calls: string[];
  focusWindow: ReturnType<typeof vi.fn>;
  sendFocusTarget: ReturnType<typeof vi.fn>;
  notify(note: AppNote): void;
} {
  const created: FakeNotification[] = [];
  const calls: string[] = [];
  const focusWindow = vi.fn(() => calls.push('focusWindow'));
  const sendFocusTarget = vi.fn(() => calls.push('sendFocusTarget'));
  const notifier = createNotifier({
    create: (options) => {
      const listeners = new Map<string, Array<() => void>>();
      const notification: FakeNotification = {
        options,
        show: vi.fn(),
        close: vi.fn(),
        on: (event, cb) => {
          listeners.set(event, [...(listeners.get(event) ?? []), cb]);
        },
        fire: (event) => {
          for (const cb of listeners.get(event) ?? []) cb();
        },
      };
      created.push(notification);
      return notification;
    },
    focusWindow,
    sendFocusTarget,
  });
  return { created, calls, focusWindow, sendFocusTarget, notify: notifier.notify };
}

const target: FocusTarget = { kind: 'session', ref: { projectPath: '/tmp/p', workId: 'w-01', sessionId: 's-02' } };

function note(tag: string, title = 'Redesign · S02 executor — needs you'): AppNote {
  return { title, body: 'task', tag, target, silent: false };
}

describe('createNotifier (тест 1 куска 4.3)', () => {
  it('два уведомления с одним тегом: у первого close, у второго show', () => {
    const { created, notify } = setup();
    notify(note('session:a'));
    notify(note('session:a'));
    expect(created).toHaveLength(2);
    expect(created[0]?.close).toHaveBeenCalledTimes(1);
    expect(created[1]?.show).toHaveBeenCalledTimes(1);
    expect(created[1]?.close).not.toHaveBeenCalled();
  });

  it('разные теги друг друга не закрывают; silent и тексты доходят до create', () => {
    const { created, notify } = setup();
    notify(note('session:a'));
    notify({ ...note('mail:w'), silent: true });
    expect(created[0]?.close).not.toHaveBeenCalled();
    expect(created[1]?.options).toEqual({ title: 'Redesign · S02 executor — needs you', body: 'task', silent: true });
  });

  it('клик — focusWindow, затем sendFocusTarget с целью', () => {
    const { created, calls, sendFocusTarget, notify } = setup();
    notify(note('session:a'));
    created[0]?.fire('click');
    expect(calls).toEqual(['focusWindow', 'sendFocusTarget']);
    expect(sendFocusTarget).toHaveBeenCalledWith(target);
  });

  it('после click запись уходит из Map: следующее с тем же тегом прежнее не закрывает', () => {
    const { created, notify } = setup();
    notify(note('session:a'));
    created[0]?.fire('click');
    notify(note('session:a'));
    expect(created[0]?.close).not.toHaveBeenCalled();
  });

  it('после close запись уходит из Map: следующее с тем же тегом прежнее не закрывает', () => {
    const { created, notify } = setup();
    notify(note('session:a'));
    created[0]?.fire('close');
    notify(note('session:a'));
    expect(created[0]?.close).not.toHaveBeenCalled();
  });

  it('close прежнего, пришедший после показа нового, новое из Map не выкидывает', () => {
    const { created, notify } = setup();
    notify(note('session:a'));
    notify(note('session:a'));
    // Electron шлёт close закрытого уведомления позже — новое при этом остаётся в Map.
    created[0]?.fire('close');
    notify(note('session:a'));
    expect(created[1]?.close).toHaveBeenCalledTimes(1);
  });
});

/** Решение ведущего в комнате (кусок 8 «Organic»): тег `proposal:<workKey>:<roomId>`, цель — комната. */
function decision(roomId: string, body: string): AppNote {
  return {
    title: 'Decision waiting for you',
    body,
    tag: `proposal:/tmp/p w-01:${roomId}`,
    target: { kind: 'room', projectPath: '/tmp/p', workId: 'w-01', roomId },
    silent: false,
  };
}

describe('createNotifier — решение в комнате (кусок 8)', () => {
  it('переделанное решение той же комнаты заменяет прежнее уведомление; решение другой комнаты — нет', () => {
    const { created, notify } = setup();
    notify(decision('r-01', 'Возвраты · S01 collected positions'));
    notify(decision('r-02', 'Отчёты · S01 collected positions'));
    notify(decision('r-01', 'Возвраты · S01 revised the decision'));
    expect(created).toHaveLength(3);
    expect(created[0]?.close).toHaveBeenCalledTimes(1);
    expect(created[1]?.close).not.toHaveBeenCalled();
    expect(created[2]?.show).toHaveBeenCalledTimes(1);
    expect(created[2]?.options).toEqual({ title: 'Decision waiting for you', body: 'Возвраты · S01 revised the decision', silent: false });
  });

  it('клик по уведомлению о решении поднимает окно и отдаёт ему цель — комнату', () => {
    const { created, calls, sendFocusTarget, notify } = setup();
    notify(decision('r-01', 'Возвраты · S01 collected positions'));
    created[0]?.fire('click');
    expect(calls).toEqual(['focusWindow', 'sendFocusTarget']);
    expect(sendFocusTarget).toHaveBeenCalledWith({ kind: 'room', projectPath: '/tmp/p', workId: 'w-01', roomId: 'r-01' });
  });
});

describe('createPendingFocusTarget (тест 8 куска 4.3)', () => {
  it('take отдаёт положенную цель один раз, затем null', () => {
    const pending = createPendingFocusTarget();
    expect(pending.take()).toBeNull();
    pending.put(target);
    expect(pending.take()).toEqual(target);
    expect(pending.take()).toBeNull();
  });

  it('новая put заменяет прежнюю', () => {
    const pending = createPendingFocusTarget();
    const mail: FocusTarget = { kind: 'mail', projectPath: '/tmp/p', workId: 'w-01' };
    pending.put(target);
    pending.put(mail);
    expect(pending.take()).toEqual(mail);
    expect(pending.take()).toBeNull();
  });
});

describe('createLoggedNotification — журнал вместо системного уведомления (E2E)', () => {
  it('show пишет запись в журнал; click записи зовёт обработчик клика', () => {
    const log: Array<{ title: string; body: string; silent: boolean; shown: boolean; closed: boolean; click(): void }> = [];
    const notification = createLoggedNotification(log, { title: 't', body: 'b', silent: true });
    const onClick = vi.fn();
    notification.on('click', onClick);
    expect(log).toHaveLength(0);
    notification.show();
    expect(log).toMatchObject([{ title: 't', body: 'b', silent: true, shown: true, closed: false }]);
    log[0]?.click();
    expect(onClick).toHaveBeenCalledTimes(1);
    notification.close();
    expect(log[0]?.closed).toBe(true);
  });
});
