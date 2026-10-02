/**
 * Смена режима Shift+Tab со сверкой подвала (план 2026-10-01, решение 4, кусок 4a): фальшивый PTY
 * показывает подвал, который меняется от Shift+Tab, часы фальшивые — тишина и опрос идут по ним.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionRef } from '@parley/protocol';
import { modeFromFooter, switchMode } from './mode-switch.js';
import type { ModeSwitchDeps } from './mode-switch.js';

const ref: SessionRef = { projectPath: '/p', workId: 'w-1', sessionId: 's-01' };

const FOOTER = {
  default: '  ⏸ manual mode on · ← for agents',
  acceptEdits: '  ⏵⏵ accept edits on (shift+tab to cycle) · ← for agents',
  plan: '  ⏸ plan mode on (shift+tab to cycle) · ← for agents',
  /** Режим обхода разрешений: его подпись хост не распознаёт (его имя — YOLO-флаг для стража рамки). */
  bypass: '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
  auto: '  ⏵⏵ auto mode on (shift+tab to cycle)',
} as const;
const CYCLE = ['default', 'acceptEdits', 'plan'] as const;

interface FakeScreen {
  deps: ModeSwitchDeps;
  writes: string[];
  /** Подвал, который сейчас показывает экран; `null` — подвала нет. */
  footer: string | null;
  live: boolean;
  /** Сколько нажатий Shift+Tab экран «теряет» (первые N). */
  drop: number;
  /** Режим, в который экран перейдёт вместо следующего по циклу (сбой сверки). */
  jumpTo: string | null;
  emitOutput(): void;
}

function fakeScreen(initial: string | null): FakeScreen {
  const listeners = new Set<(ref: SessionRef, data: string) => void>();
  const state: FakeScreen = {
    writes: [],
    footer: initial,
    live: true,
    drop: 0,
    jumpTo: null,
    deps: undefined as unknown as ModeSwitchDeps,
    emitOutput() {
      for (const listener of listeners) listener(ref, 'x');
    },
  };
  const modeOfFooter = (): string | null => modeFromFooter(state.footer === null ? [] : [state.footer]);
  state.deps = {
    pty: {
      get: () => (state.live ? ({ ref } as never) : undefined),
      write: (_ref: SessionRef, data: string) => {
        state.writes.push(data);
        if (state.drop > 0) {
          state.drop -= 1;
          return;
        }
        if (state.jumpTo !== null) {
          state.footer = FOOTER[state.jumpTo as keyof typeof FOOTER];
          return;
        }
        const index = CYCLE.indexOf(modeOfFooter() as (typeof CYCLE)[number]);
        state.footer = FOOTER[CYCLE[(index + 1) % CYCLE.length] as (typeof CYCLE)[number]];
      },
      screenText: () => (state.live ? ['', 'мусор', ...(state.footer === null ? [] : [state.footer])] : undefined),
      on: (_event: string, listener: (ref: SessionRef, data: string) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    } as unknown as ModeSwitchDeps['pty'],
  };
  return state;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('modeFromFooter', () => {
  it('узнаёт подписи подвала и отличает «auto mode unavailable» от режима', () => {
    expect(modeFromFooter([FOOTER.default])).toBe('default');
    expect(modeFromFooter([FOOTER.acceptEdits])).toBe('acceptEdits');
    expect(modeFromFooter([FOOTER.plan])).toBe('plan');
    expect(modeFromFooter([FOOTER.bypass])).toBeNull();
    expect(modeFromFooter([FOOTER.auto])).toBe('auto');
    expect(modeFromFooter(['auto mode unavailable for this model'])).toBeNull();
    expect(modeFromFooter([])).toBeNull();
  });
});

describe('switchMode', () => {
  it('manual → plan: два нажатия, verified true', async () => {
    const screen = fakeScreen(FOOTER.default);
    const result = switchMode(screen.deps, ref, 'plan');
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(result).resolves.toEqual({ mode: 'plan', verified: true });
    expect(screen.writes).toEqual(['\x1b[Z', '\x1b[Z']);
  });

  it('plan → manual: одно нажатие по кругу', async () => {
    const screen = fakeScreen(FOOTER.plan);
    const result = switchMode(screen.deps, ref, 'default');
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(result).resolves.toEqual({ mode: 'default', verified: true });
    expect(screen.writes).toEqual(['\x1b[Z']);
  });

  it('текущий равен цели — без нажатий', async () => {
    const screen = fakeScreen(FOOTER.acceptEdits);
    const result = switchMode(screen.deps, ref, 'acceptEdits');
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(result).resolves.toEqual({ mode: 'acceptEdits', verified: true });
    expect(screen.writes).toEqual([]);
  });

  it('подвал не сошёлся после первого нажатия — verified false, фактический режим, дальше не жмём', async () => {
    const screen = fakeScreen(FOOTER.default);
    screen.jumpTo = 'auto';
    const result = switchMode(screen.deps, ref, 'plan');
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(result).resolves.toEqual({ mode: 'auto', verified: false });
    expect(screen.writes).toEqual(['\x1b[Z']);
  });

  it('нажатие потеряно: ждём не дольше 1,5 с и отвечаем тем, что показывает подвал', async () => {
    const screen = fakeScreen(FOOTER.default);
    screen.drop = 1;
    const result = switchMode(screen.deps, ref, 'acceptEdits');
    await vi.advanceTimersByTimeAsync(200);
    expect(screen.writes).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_499);
    let settled = false;
    void result.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toEqual({ mode: 'default', verified: false });
  });

  it('подвала нет — null и false, в PTY ничего не записано', async () => {
    const screen = fakeScreen(null);
    const result = switchMode(screen.deps, ref, 'plan');
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(result).resolves.toEqual({ mode: null, verified: false });
    expect(screen.writes).toEqual([]);
  });

  it('auto — вне цикла: verified false без нажатий; подпись обхода разрешений — как неизвестный подвал', async () => {
    const auto = fakeScreen(FOOTER.auto);
    const fromAuto = switchMode(auto.deps, ref, 'plan');
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(fromAuto).resolves.toEqual({ mode: 'auto', verified: false });
    expect(auto.writes).toEqual([]);

    const bypass = fakeScreen(FOOTER.bypass);
    const fromBypass = switchMode(bypass.deps, ref, 'plan');
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(fromBypass).resolves.toEqual({ mode: null, verified: false });
    expect(bypass.writes).toEqual([]);
  });

  it('нажатие не раньше, чем через 200 мс без вывода', async () => {
    const screen = fakeScreen(FOOTER.default);
    const result = switchMode(screen.deps, ref, 'acceptEdits');
    await vi.advanceTimersByTimeAsync(150);
    screen.emitOutput();
    await vi.advanceTimersByTimeAsync(150);
    screen.emitOutput();
    await vi.advanceTimersByTimeAsync(199);
    expect(screen.writes).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(screen.writes).toEqual(['\x1b[Z']);
    await vi.advanceTimersByTimeAsync(100);
    await expect(result).resolves.toEqual({ mode: 'acceptEdits', verified: true });
  });

  it('шумный экран: через 2 с ждать перестаём и жмём', async () => {
    const screen = fakeScreen(FOOTER.default);
    const result = switchMode(screen.deps, ref, 'acceptEdits');
    for (let i = 0; i < 25; i += 1) {
      await vi.advanceTimersByTimeAsync(100);
      screen.emitOutput();
    }
    await expect(result).resolves.toEqual({ mode: 'acceptEdits', verified: true });
    expect(screen.writes).toEqual(['\x1b[Z']);
  });

  it('сессия без живого PTY — not_found', async () => {
    const screen = fakeScreen(FOOTER.default);
    screen.live = false;
    await expect(switchMode(screen.deps, ref, 'plan')).rejects.toMatchObject({
      name: 'HostError',
      code: 'not_found',
    });
  });
});
