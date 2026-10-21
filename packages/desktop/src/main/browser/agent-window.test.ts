import { describe, expect, it, vi } from 'vitest';
import { createAgentWindow } from './agent-window.js';

const OWNER = { pageKey: '/p w-1\nbp-aaaaaa', webContentsId: 7, workKey: '/p w-1', sessionId: 's-02', agentId: 't1' };

function timers() {
  const pending: Array<{ fn: () => void; at: number; off: boolean }> = [];
  let now = 0;
  return {
    setTimer: (fn: () => void, ms: number) => { const entry = { fn, at: now + ms, off: false }; pending.push(entry); return () => { entry.off = true; }; },
    advance(ms: number) { now += ms; for (const entry of pending.filter((e) => !e.off && e.at <= now)) { entry.off = true; entry.fn(); } },
  };
}

describe('окно операции агента (спека 5.2: операция и 2 с после)', () => {
  it('активно во время операции и ещё guardTailMs после конца; потом onIdle', () => {
    const clock = timers();
    const window = createAgentWindow({ tailMs: 2_000, setTimer: clock.setTimer });
    const idle = vi.fn();
    window.onIdle(idle);
    const end = window.begin(OWNER);
    expect(window.activeFor(7)).toEqual(OWNER);
    expect(window.activeFor(8)).toBeNull();
    end();
    clock.advance(1_999);
    expect(window.activeFor(7)).toEqual(OWNER);
    clock.advance(1);
    expect(window.activeFor(7)).toBeNull();
    expect(idle).toHaveBeenCalledWith(7);
  });

  it('новая операция в хвосте продлевает окно; idle — один раз, после последней', () => {
    const clock = timers();
    const window = createAgentWindow({ tailMs: 2_000, setTimer: clock.setTimer });
    const idle = vi.fn();
    window.onIdle(idle);
    window.begin(OWNER)();
    clock.advance(1_000);
    const end = window.begin({ ...OWNER, sessionId: 's-03' });
    expect(window.activeFor(7)?.sessionId).toBe('s-03');
    clock.advance(5_000);
    expect(idle).not.toHaveBeenCalled();
    end();
    clock.advance(2_000);
    expect(idle).toHaveBeenCalledTimes(1);
  });

  it('заметки копятся с последнего begin и забираются один раз; вне окна — не копятся', () => {
    const clock = timers();
    const window = createAgentWindow({ tailMs: 2_000, setTimer: clock.setTimer });
    window.note(7, 'early');
    const end = window.begin(OWNER);
    window.note(7, 'The page started a download: a.csv.');
    window.note(8, 'other guest');
    expect(window.take(OWNER.pageKey)).toEqual(['The page started a download: a.csv.']);
    expect(window.take(OWNER.pageKey)).toEqual([]);
    end();
    clock.advance(2_000);
    window.note(7, 'late');
    expect(window.take(OWNER.pageKey)).toEqual([]);
  });
});
