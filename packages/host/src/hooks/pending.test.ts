/**
 * Удержанные хуки: один ответ на хук, `{}` при снятии и по таймауту часа (фальшивые таймеры).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionRef } from '@parley/protocol';
import { createPendingHooks, PENDING_TIMEOUT_MS } from './pending.js';
import type { HeldHook } from './pending.js';

const REF: SessionRef = { projectPath: '/p', workId: 'w-1', sessionId: 's-01' };
const OTHER: SessionRef = { projectPath: '/p', workId: 'w-2', sessionId: 's-01' };

function held(
  cardId: string,
  ref: SessionRef = REF,
): HeldHook & { respond: ReturnType<typeof vi.fn> } {
  return {
    ref,
    cardId,
    hookEvent: 'PermissionRequest',
    rawToolInput: { command: 'ls' },
    kind: 'permission',
    respond: vi.fn(),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('createPendingHooks', () => {
  it('resolve отвечает телом решения один раз; второй resolve — false', () => {
    const pending = createPendingHooks();
    const hook = held('permission:t1');
    pending.hold(hook);

    expect(pending.get(REF, 'permission:t1')).toMatchObject({
      hookEvent: 'PermissionRequest',
      kind: 'permission',
    });
    expect(pending.resolve(REF, 'permission:t1', { ok: 1 })).toBe(true);
    expect(pending.resolve(REF, 'permission:t1', { ok: 2 })).toBe(false);
    expect(hook.respond).toHaveBeenCalledTimes(1);
    expect(hook.respond).toHaveBeenCalledWith({ ok: 1 });
    expect(pending.size()).toBe(0);
  });

  it('list отдаёт удержанные хуки только своей сессии, без respond', () => {
    const pending = createPendingHooks();
    pending.hold(held('a'));
    pending.hold(held('b'));
    pending.hold(held('c', OTHER));

    const own = pending.list(REF);
    expect(own.map((info) => info.cardId).sort()).toEqual(['a', 'b']);
    expect(own[0]).not.toHaveProperty('respond');
    expect(pending.list(OTHER)).toHaveLength(1);

    pending.settle(REF, ['a']);
    expect(pending.list(REF).map((info) => info.cardId)).toEqual(['b']);
  });

  it('settle снимает только свою сессию и перечисленные карточки — {}', () => {
    const pending = createPendingHooks();
    const a = held('a');
    const b = held('b');
    const c = held('a', OTHER);
    for (const hook of [a, b, c]) pending.hold(hook);

    expect(pending.settle(REF, ['a'])).toEqual(['a']);
    expect(a.respond).toHaveBeenCalledWith({});
    expect(b.respond).not.toHaveBeenCalled();
    expect(pending.settle(REF)).toEqual(['b']);
    expect(c.respond).not.toHaveBeenCalled();

    pending.settleAll();
    expect(c.respond).toHaveBeenCalledWith({});
    expect(pending.size()).toBe(0);
  });

  it('повтор хука той же карточки: прежнему — {}', () => {
    const pending = createPendingHooks();
    const first = held('a');
    const second = held('a');
    pending.hold(first);
    pending.hold(second);

    expect(first.respond).toHaveBeenCalledWith({});
    expect(second.respond).not.toHaveBeenCalled();
    expect(pending.size()).toBe(1);
  });

  it('таймаут часа: {} и колбэк stale; drop забывает без ответа', () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    const pending = createPendingHooks({ onTimeout });
    const hook = held('a');
    const dropped = held('b');
    pending.hold(hook);
    pending.hold(dropped);
    expect(pending.drop(REF, 'b')).toBe(true);

    vi.advanceTimersByTime(PENDING_TIMEOUT_MS - 1);
    expect(hook.respond).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);

    expect(hook.respond).toHaveBeenCalledWith({});
    expect(onTimeout).toHaveBeenCalledWith(REF, 'a');
    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(dropped.respond).not.toHaveBeenCalled();
    expect(pending.size()).toBe(0);
  });

  it('resolve, settle и drop снимают таймер: колбэк таймаута потом не зовётся', () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    const pending = createPendingHooks({ onTimeout });
    pending.hold(held('a'));
    pending.hold(held('b'));
    pending.hold(held('c'));

    pending.resolve(REF, 'a', { ok: 1 });
    pending.settle(REF, ['b']);
    pending.drop(REF, 'c');

    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(PENDING_TIMEOUT_MS);
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it('упавший ответ не мешает снять соседей', () => {
    const pending = createPendingHooks();
    const broken = held('a');
    broken.respond.mockImplementation(() => {
      throw new Error('closed');
    });
    const fine = held('b');
    pending.hold(broken);
    pending.hold(fine);

    expect(() => pending.settleAll()).not.toThrow();
    expect(fine.respond).toHaveBeenCalledWith({});
  });
});
