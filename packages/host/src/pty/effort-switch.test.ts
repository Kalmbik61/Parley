/**
 * Смена effort ползунком `/effort` и `s` со сверкой подвала (спека нормалайзера, 5.7): экран-подмена отвечает,
 * как Claude Code 2.1.289 на живой проверке, часы фальшивые — тишина, опрос и паузы между клавишами идут по ним.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionRef } from '@parley/protocol';
import { fakeEffortScreen, footerLine, SLIDER_LINES } from '../../test/fake-effort-screen.js';
import { effortFromFooter, sliderOnScreen, switchEffort } from './effort-switch.js';

const ref: SessionRef = { projectPath: '/p', workId: 'w-1', sessionId: 's-01' };
const LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];
const LEFT = '\x1b[D';
const RIGHT = '\x1b[C';
const times = (key: string, count: number): string[] => Array.from({ length: count }, () => key);

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('effortFromFooter', () => {
  it('уровень из подвала после s — при любом знаке перед ним и без знака', () => {
    expect(effortFromFooter(['  ○ low · /effort'])).toBe('low');
    expect(effortFromFooter(['  ◐ medium · /effort'])).toBe('medium');
    expect(effortFromFooter(['  ● high · /effort'])).toBe('high');
    expect(effortFromFooter(['  ◈ max · /effort'])).toBe('max');
    // Знак `xhigh` — «◉», но разбор от знака не зависит.
    expect(effortFromFooter(['  ◉ xhigh · /effort'])).toBe('xhigh');
    expect(effortFromFooter(['xhigh · /effort'])).toBe('xhigh');
  });

  it('строки ползунка и набранная команда — не подвал; нижний подвал главнее; ничего нет — null', () => {
    expect(effortFromFooter([...SLIDER_LINES, '> /effort'])).toBeNull();
    expect(effortFromFooter([footerLine('high'), 'мусор', footerLine('low'), ''])).toBe('low');
    expect(effortFromFooter([])).toBeNull();
  });
});

describe('sliderOnScreen', () => {
  const HINT = '←/→ to adjust · Enter to confirm · s for this session only · Esc to cancel';

  it('настоящий экран ползунка — ползунок', () => {
    expect(sliderOnScreen([...SLIDER_LINES, '', ''])).toBe(true);
  });

  it('подсказка, перенесённая на две соседние строки узким терминалом, — ползунок', () => {
    expect(sliderOnScreen(['Effort', '←/→ to adjust · Enter to confirm · s for this', 'session only · Esc to cancel', ''])).toBe(true);
    expect(sliderOnScreen(['Effort', '←/→ to adjust · Enter to confirm · s for this session only', '· Esc to cancel'])).toBe(true);
  });

  it('фраза в тексте ответа агента выше поля ввода — не ползунок', () => {
    // Агент цитирует свой же код: только часть подсказки у нижнего края либо вся, но выше последних восьми строк.
    const input = ['─────────────────────────────', '> ', '─────────────────────────────', '  ? for shortcuts', ''];
    expect(sliderOnScreen(['● Нашёл «s for this session only» в send.ts', '  Он нужен ползунку.', ...input])).toBe(false);
    expect(sliderOnScreen([`● ${HINT}`, 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', ...input])).toBe(false);
  });

  it('только одна из двух частей подсказки — не ползунок', () => {
    expect(sliderOnScreen(['s for this session only'])).toBe(false);
    expect(sliderOnScreen(['Esc to cancel'])).toBe(false);
    expect(sliderOnScreen([])).toBe(false);
  });
});

describe('switchEffort', () => {
  it('medium → xhigh: /effort и Enter, ← на одно больше уровней, → до цели, s; подвал подтвердил', async () => {
    const screen = fakeEffortScreen('medium');
    const result = switchEffort(ref, 'xhigh', LEVELS, screen.deps);
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(result).resolves.toEqual({ effort: 'xhigh', verified: true });
    expect(screen.writes).toEqual(['/effort', '\r', ...times(LEFT, 6), ...times(RIGHT, 3), 's']);
  });

  it('цель low — только упор влево, без →', async () => {
    const screen = fakeEffortScreen(null);
    const result = switchEffort(ref, 'low', LEVELS, screen.deps);
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(result).resolves.toEqual({ effort: 'low', verified: true });
    expect(screen.writes).toEqual(['/effort', '\r', ...times(LEFT, 6), 's']);
  });

  it('ползунок не открылся за 3 с — Esc и verified false с тем, что в подвале; ни стрелок, ни s', async () => {
    const screen = fakeEffortScreen('high');
    screen.opens = false;
    const result = switchEffort(ref, 'max', LEVELS, screen.deps);
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(result).resolves.toEqual({ effort: 'high', verified: false });
    expect(screen.writes).toEqual(['/effort', '\r', '\x1b']);
  });

  it('подвал показал другой уровень (предел CLI) — verified false с увиденным; ползунок уже закрыт, Esc нет', async () => {
    const screen = fakeEffortScreen('medium');
    screen.cap = 'high';
    const result = switchEffort(ref, 'max', LEVELS, screen.deps);
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(result).resolves.toEqual({ effort: 'high', verified: false });
    expect(screen.writes.at(-1)).toBe('s');
  });

  it('s потерялся — ползунок открыт: через 2 с Esc, ответ — то, что в подвале', async () => {
    const screen = fakeEffortScreen(null);
    screen.dropS = true;
    const result = switchEffort(ref, 'high', LEVELS, screen.deps);
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(result).resolves.toEqual({ effort: null, verified: false });
    expect(screen.writes.at(-1)).toBe('\x1b');
    expect(screen.sliderOpen).toBe(false);
  });

  it('подвал ещё показывает прежний уровень сессии — хост ждёт цель, а не первое увиденное', async () => {
    const screen = fakeEffortScreen('high');
    screen.footerDelayMs = 300;
    const result = switchEffort(ref, 'low', LEVELS, screen.deps);
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(result).resolves.toEqual({ effort: 'low', verified: true });
  });

  it('ползунок открыт до печати — conflict busy, хост не жмёт ничего: Enter в нём сохранил бы умолчание человека', async () => {
    const screen = fakeEffortScreen('medium');
    screen.sliderOpen = true;
    const refused = expect(switchEffort(ref, 'max', LEVELS, screen.deps)).rejects.toMatchObject({
      name: 'HostError',
      code: 'conflict',
      data: { reason: 'busy' },
    });
    await vi.advanceTimersByTimeAsync(5_000);
    await refused;
    expect(screen.writes).toEqual([]);
  });

  it('сессия без живого PTY — not_found', async () => {
    const screen = fakeEffortScreen(null);
    screen.live = false;
    await expect(switchEffort(ref, 'low', LEVELS, screen.deps)).rejects.toMatchObject({
      name: 'HostError',
      code: 'not_found',
    });
  });
});
