/**
 * Журнал «сессия готова» (план диагностики хоста, задача 5): первый хук после старта PTY или сигнал
 * `ready` терминала Codex пишет `op: 'session.ready'` один раз; повтор молчит до следующего старта.
 * PTY здесь — ручной fake с `emit`: подписки `start`/`exit`/`signal` тест шлёт сам.
 */
import { refKey } from '@parley/protocol';
import type { SessionRef } from '@parley/protocol';
import { describe, expect, it, vi } from 'vitest';
import type { PtyManager } from '../pty/pty-manager.js';
import type { CodexSignal } from '../pty/codex-terminal.js';
import { createReadyJournal } from './ready-journal.js';

const REF: SessionRef = { projectPath: '/p', workId: 'w1', sessionId: 's1' };

type Event = 'start' | 'exit' | 'signal';

function setup(provider: string | null = 'claude') {
  const listeners: Record<Event, Set<(...args: never[]) => void>> = {
    start: new Set(),
    exit: new Set(),
    signal: new Set(),
  };
  const live = new Map<string, number>();
  const pty = {
    get: (ref: SessionRef) => {
      const startedAt = live.get(refKey(ref));
      return startedAt === undefined ? undefined : { ref, startedAt, provider };
    },
    on: (event: Event, listener: (...args: never[]) => void) => {
      listeners[event].add(listener);
      return () => listeners[event].delete(listener);
    },
  } as unknown as Pick<PtyManager, 'on' | 'get'>;
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  let now = 10_000;
  const journal = createReadyJournal({ log, pty, now: () => now });
  return {
    journal,
    log,
    listeners,
    setNow: (value: number) => {
      now = value;
    },
    start(ref: SessionRef, startedAt: number) {
      live.set(refKey(ref), startedAt);
      for (const listener of listeners.start) (listener as (r: SessionRef) => void)(ref);
    },
    exit(ref: SessionRef) {
      live.delete(refKey(ref));
      for (const listener of listeners.exit) (listener as (r: SessionRef) => void)(ref);
    },
    signal(ref: SessionRef, signal: CodexSignal) {
      for (const listener of listeners.signal) {
        (listener as (r: SessionRef, s: CodexSignal) => void)(ref, signal);
      }
    },
  };
}

describe('createReadyJournal', () => {
  it('первый хук после старта пишет session.ready с readyMs от startedAt', () => {
    const t = setup();
    t.start(REF, 6_500);
    t.journal.onHook(REF);
    expect(t.log.info).toHaveBeenCalledTimes(1);
    expect(t.log.info).toHaveBeenCalledWith('сессия готова', {
      op: 'session.ready',
      ref: REF,
      provider: 'claude',
      readyMs: 3_500,
    });
  });

  it('второй хук молчит, после exit и нового start пишет снова', () => {
    const t = setup();
    t.start(REF, 6_500);
    t.journal.onHook(REF);
    t.journal.onHook(REF);
    expect(t.log.info).toHaveBeenCalledTimes(1);

    t.exit(REF);
    t.start(REF, 9_000);
    t.setNow(12_000);
    t.journal.onHook(REF);
    expect(t.log.info).toHaveBeenCalledTimes(2);
    expect(t.log.info).toHaveBeenLastCalledWith(
      'сессия готова',
      expect.objectContaining({ op: 'session.ready', readyMs: 3_000 }),
    );
  });

  it('новый start без exit (перезапуск) снова ждёт готовности', () => {
    const t = setup();
    t.start(REF, 6_500);
    t.journal.onHook(REF);
    t.start(REF, 9_000);
    t.journal.onHook(REF);
    expect(t.log.info).toHaveBeenCalledTimes(2);
  });

  it('сигнал ready у Codex считается готовностью, и повторный хук после него молчит', () => {
    const t = setup('codex');
    t.start(REF, 8_000);
    t.signal(REF, { kind: 'working' });
    expect(t.log.info).not.toHaveBeenCalled();

    t.signal(REF, { kind: 'ready' });
    expect(t.log.info).toHaveBeenCalledTimes(1);
    expect(t.log.info).toHaveBeenCalledWith('сессия готова', {
      op: 'session.ready',
      ref: REF,
      provider: 'codex',
      readyMs: 2_000,
    });

    t.journal.onHook(REF);
    t.signal(REF, { kind: 'ready' });
    expect(t.log.info).toHaveBeenCalledTimes(1);
  });

  it('хук без живого PTY ничего не пишет', () => {
    const t = setup();
    t.journal.onHook(REF);
    expect(t.log.info).not.toHaveBeenCalled();

    t.start(REF, 6_500);
    t.exit(REF);
    t.journal.onHook(REF);
    expect(t.log.info).not.toHaveBeenCalled();
  });

  it('сессии не мешают друг другу', () => {
    const t = setup();
    const other: SessionRef = { projectPath: '/p', workId: 'w1', sessionId: 's2' };
    t.start(REF, 6_500);
    t.start(other, 7_000);
    t.journal.onHook(other);
    expect(t.log.info).toHaveBeenCalledTimes(1);
    expect(t.log.info).toHaveBeenCalledWith('сессия готова', expect.objectContaining({ ref: other, readyMs: 3_000 }));
    t.journal.onHook(REF);
    expect(t.log.info).toHaveBeenCalledTimes(2);
  });

  it('stop снимает подписки на PTY', () => {
    const t = setup();
    expect(t.listeners.start.size).toBe(1);
    expect(t.listeners.exit.size).toBe(1);
    expect(t.listeners.signal.size).toBe(1);
    t.journal.stop();
    expect(t.listeners.start.size).toBe(0);
    expect(t.listeners.exit.size).toBe(0);
    expect(t.listeners.signal.size).toBe(0);
  });
});
