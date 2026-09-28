import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { refKey, type SessionRef } from '@harnas/protocol';
import { createSeenTracker, visibleSessions, type SeenTracker } from './seen.js';

const a: SessionRef = { projectPath: '/tmp/p', workId: 'w-01', sessionId: 's-01' };
const b: SessionRef = { projectPath: '/tmp/p', workId: 'w-01', sessionId: 's-02' };
const A = refKey(a);
const B = refKey(b);

describe('visibleSessions (тест 1)', () => {
  it('окно не в фокусе → пусто', () => {
    expect([...visibleSessions({ windowFocused: false, documentVisible: true, visibleSessionRefs: { [A]: true } })]).toEqual([]);
  });

  it('документ скрыт → пусто', () => {
    expect([...visibleSessions({ windowFocused: true, documentVisible: false, visibleSessionRefs: { [A]: true } })]).toEqual([]);
  });

  it('сессии нет в visibleSessionRefs → её нет', () => {
    expect(visibleSessions({ windowFocused: true, documentVisible: true, visibleSessionRefs: { [A]: true } }).has(B)).toBe(false);
  });

  it('фокус и видимый документ → ровно ключи visibleSessionRefs', () => {
    const visible = visibleSessions({ windowFocused: true, documentVisible: true, visibleSessionRefs: { [A]: true, [B]: true } });
    expect([...visible].sort()).toEqual([A, B].sort());
  });
});

describe('createSeenTracker (тест 2)', () => {
  let sent: SessionRef[];
  let tracker: SeenTracker;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    sent = [];
    tracker = createSeenTracker({
      send: (ref) => sent.push(ref),
      now: () => Date.now(),
      setTimer: setTimeout,
      clearTimer: clearTimeout,
    });
  });

  afterEach(() => {
    tracker.dispose();
    vi.useRealTimers();
  });

  const unseenA = new Map([[A, a]]);

  it('видимость 999 мс — send нет; 1000 мс — один send', () => {
    tracker.update(new Set([A]), unseenA);
    vi.advanceTimersByTime(999);
    expect(sent).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(sent).toEqual([a]);
  });

  it('потеря видимости на 500 мс сбрасывает отсчёт', () => {
    tracker.update(new Set([A]), unseenA);
    vi.advanceTimersByTime(600);
    tracker.update(new Set(), unseenA);
    vi.advanceTimersByTime(500);
    tracker.update(new Set([A]), unseenA);
    vi.advanceTimersByTime(999);
    expect(sent).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(sent).toEqual([a]);
  });

  it('повторное попадание в unseen через 1 с — ещё один send не раньше 2 с от прошлого', () => {
    tracker.update(new Set([A]), unseenA);
    vi.advanceTimersByTime(1000);
    expect(sent).toHaveLength(1);
    // Хост погасил unseen, затем сессия снова закончила ход.
    tracker.update(new Set([A]), new Map());
    vi.advanceTimersByTime(100);
    tracker.update(new Set([A]), unseenA);
    vi.advanceTimersByTime(1000);
    expect(sent).toHaveLength(1);
    vi.advanceTimersByTime(899);
    expect(sent).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(sent).toHaveLength(2);
    expect(Date.now()).toBe(3000);
  });

  it('сессия не в unseen — send нет', () => {
    tracker.update(new Set([A, B]), unseenA);
    vi.advanceTimersByTime(5000);
    expect(sent.every((ref) => refKey(ref) === A)).toBe(true);
    expect(sent.some((ref) => refKey(ref) === B)).toBe(false);
  });

  it('dispose гасит отсчёт', () => {
    tracker.update(new Set([A]), unseenA);
    tracker.dispose();
    vi.advanceTimersByTime(5000);
    expect(sent).toEqual([]);
  });
});

// Найдено вживую (дефект 4.2, чинится с куском 4.3): настоящий `setTimeout` Chromium, вызванный
// методом чужого объекта (`deps.setTimer(…)`), бросает «Illegal invocation» — таймеры jsdom и
// поддельные таймеры vitest этого не замечают. Здесь таймеры проверяют `this` так же строго.
describe('createSeenTracker — таймеры зовутся без this объекта deps', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('setTimer и clearTimer, требовательные к this, не бросают; send доходит', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const strict = (self: unknown): void => {
      if (self !== undefined && self !== globalThis) throw new TypeError('Illegal invocation');
    };
    const setTimer = function (this: unknown, handler: () => void, ms?: number) {
      strict(this);
      return setTimeout(handler, ms);
    } as unknown as typeof setTimeout;
    const clearTimer = function (this: unknown, id?: ReturnType<typeof setTimeout>) {
      strict(this);
      clearTimeout(id);
    } as unknown as typeof clearTimeout;
    const sent: SessionRef[] = [];
    const tracker = createSeenTracker({ send: (ref) => sent.push(ref), now: () => Date.now(), setTimer, clearTimer });

    expect(() => tracker.update(new Set([A]), new Map([[A, a]]))).not.toThrow();
    vi.advanceTimersByTime(1000);
    expect(sent).toEqual([a]);
    // Повтор уже запланирован — уход из видимости снимает его через clearTimer.
    expect(() => tracker.update(new Set(), new Map())).not.toThrow();
    expect(() => tracker.update(new Set([A]), new Map([[A, a]]))).not.toThrow();
    expect(() => tracker.dispose()).not.toThrow();
  });
});
