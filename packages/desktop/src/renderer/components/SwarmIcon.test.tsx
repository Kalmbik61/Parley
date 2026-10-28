/** Живая иконка роя (спека роя v1, 7.5): свой холст, предел живых иконок, статичные случаи, данные в рендер сот. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { swarmIconQueueLength } from '../lib/swarm-icon-slots.js';
import type { CombState, CombTheme } from './swarm-comb.js';
import { SwarmIcon } from './SwarmIcon.js';

// Настоящий рендер сот, но с записью того, что в него передали: в jsdom холста нет и кадр ничего не рисует.
const created = vi.hoisted(() => ({ icons: [] as Array<{ size: number; theme: string }>, sets: [] as Array<CombState & { at: number }> }));
vi.mock('./swarm-comb.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./swarm-comb.js')>();
  return {
    ...original,
    createCombIcon: (options: { size: number; theme: CombTheme }) => {
      const icon = original.createCombIcon(options);
      created.icons.push(options);
      return {
        ...icon,
        set: (next: CombState, at: number) => {
          created.sets.push({ ...next, at });
          icon.set(next, at);
        },
      };
    },
  };
});

beforeEach(() => {
  created.icons.length = 0;
  created.sets.length = 0;
});
afterEach(() => {
  cleanup();
  expect(swarmIconQueueLength()).toBe(0);
});

const icons = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('[data-swarm-icon]')];
const live = (): number => icons().filter((icon) => icon.hasAttribute('data-live')).length;

describe('SwarmIcon — облик', () => {
  it('свой холст нужного размера, статус в атрибуте, значок скрыт от скринридера, подложки нет', () => {
    const { rerender } = render(<SwarmIcon status="running" size={14} total={3} theme="light" />);
    const canvas = document.querySelector<HTMLCanvasElement>('canvas');
    expect(canvas?.style.width).toBe('14px');
    expect(canvas?.style.height).toBe('14px');
    expect(canvas?.getAttribute('data-testid')).toBeNull();
    expect(icons()[0]?.getAttribute('aria-hidden')).toBe('true');
    expect(icons()[0]?.className).not.toContain('bg-');
    rerender(<SwarmIcon status="failed" size={14} total={3} theme="light" />);
    expect(icons()[0]?.getAttribute('data-swarm-icon')).toBe('failed');
  });

  it('один рендер сот на монтирование; тема и размер — в него; смена темы создаёт новый', () => {
    const { rerender } = render(<SwarmIcon status="running" size={16} total={3} theme="light" />);
    expect(created.icons).toEqual([{ size: 16, theme: 'light' }]);
    rerender(<SwarmIcon status="collecting" size={16} handed={1} total={3} theme="light" />);
    expect(created.icons).toHaveLength(1);
    rerender(<SwarmIcon status="collecting" size={16} handed={1} total={3} theme="dark" />);
    expect(created.icons).toEqual([
      { size: 16, theme: 'light' },
      { size: 16, theme: 'dark' },
    ]);
  });
});

describe('SwarmIcon — живые и статичные', () => {
  it('идущий рой живой; законченный, still и Reduce motion — статичные', () => {
    render(
      <>
        <SwarmIcon total={3} theme="dark" status="running" size={16} />
        <SwarmIcon total={3} theme="dark" status="collecting" size={16} />
        <SwarmIcon total={3} theme="dark" status="done" size={16} />
        <SwarmIcon total={3} theme="dark" status="failed" size={16} />
        <SwarmIcon total={3} theme="dark" status="cancelled" size={16} />
        <SwarmIcon total={3} theme="dark" status="running" size={14} still />
        <SwarmIcon total={3} theme="dark" status="running" size={14} reducedMotion />
      </>,
    );
    expect(icons().map((icon) => icon.hasAttribute('data-live'))).toEqual([true, true, false, false, false, false, false]);
  });

  it('не больше трёх живых: первые по порядку монтирования, остальные получают слот, когда он освободится', () => {
    const many = (count: number): JSX.Element => (
      <>
        {Array.from({ length: count }, (_, index) => (
          <SwarmIcon total={3} theme="dark" key={index} status="running" size={16} />
        ))}
      </>
    );
    const { rerender } = render(many(5));
    expect(live()).toBe(3);
    expect(icons().map((icon) => icon.hasAttribute('data-live'))).toEqual([true, true, true, false, false]);
    // Убрали последнюю: живых по-прежнему три. Убрали живую — слот переходит к ждущей.
    rerender(many(4));
    expect(live()).toBe(3);
    rerender(
      <>
        <SwarmIcon total={3} theme="dark" key={1} status="running" size={16} />
        <SwarmIcon total={3} theme="dark" key={2} status="running" size={16} />
        <SwarmIcon total={3} theme="dark" key={3} status="running" size={16} />
        <SwarmIcon total={3} theme="dark" key={4} status="running" size={16} />
      </>,
    );
    expect(icons().map((icon) => icon.hasAttribute('data-live'))).toEqual([true, true, true, false]);
    rerender(
      <>
        <SwarmIcon total={3} theme="dark" key={2} status="running" size={16} />
        <SwarmIcon total={3} theme="dark" key={3} status="running" size={16} />
        <SwarmIcon total={3} theme="dark" key={4} status="running" size={16} />
      </>,
    );
    expect(live()).toBe(3);
  });

  it('рой дошёл до done — слот освобождается и иконка встаёт', () => {
    const view = (status: 'running' | 'done'): JSX.Element => (
      <>
        <SwarmIcon total={3} theme="dark" key="a" status={status} size={16} />
        <SwarmIcon total={3} theme="dark" key="b" status="running" size={16} />
        <SwarmIcon total={3} theme="dark" key="c" status="running" size={16} />
        <SwarmIcon total={3} theme="dark" key="d" status="running" size={16} />
      </>
    );
    const { rerender } = render(view('running'));
    expect(icons().map((icon) => icon.hasAttribute('data-live'))).toEqual([true, true, true, false]);
    rerender(view('done'));
    expect(icons().map((icon) => icon.hasAttribute('data-live'))).toEqual([false, true, true, true]);
  });
});

describe('SwarmIcon — данные в рендер сот', () => {
  it('status, handed и total уходят в set на монтирование и на каждую смену', () => {
    vi.spyOn(performance, 'now').mockReturnValue(1000);
    const { rerender } = render(<SwarmIcon status="running" size={16} handed={0} total={3} theme="dark" />);
    expect(created.sets).toEqual([{ status: 'running', handed: 0, total: 3, at: 1000 }]);
    act(() => {
      rerender(<SwarmIcon status="running" size={16} handed={1} total={3} theme="dark" />);
    });
    act(() => {
      rerender(<SwarmIcon status="running" size={16} handed={1} total={5} theme="dark" />);
    });
    act(() => {
      rerender(<SwarmIcon status="done" size={16} handed={1} total={5} theme="dark" />);
    });
    expect(created.sets.map(({ status, handed, total }) => [status, handed, total])).toEqual([
      ['running', 0, 3],
      ['running', 1, 3],
      ['running', 1, 5],
      ['done', 1, 5],
    ]);
    vi.restoreAllMocks();
  });

  it('те же данные при перерисовке в set не уходят', () => {
    const { rerender } = render(<SwarmIcon status="running" size={16} handed={1} total={3} theme="dark" />);
    rerender(<SwarmIcon status="running" size={16} handed={1} total={3} theme="dark" still />);
    expect(created.sets).toHaveLength(1);
  });
});
