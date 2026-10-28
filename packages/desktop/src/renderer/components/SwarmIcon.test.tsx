/** Живая иконка роя (спека роя v1, 7.5): облик по статусу, предел живых иконок, статичные случаи, реакции. */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { swarmIconQueueLength } from '../lib/swarm-icon-slots.js';
import { SwarmIcon } from './SwarmIcon.js';

afterEach(() => {
  cleanup();
  expect(swarmIconQueueLength()).toBe(0);
});

const icons = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('[data-swarm-icon]')];
const live = (): number => icons().filter((icon) => icon.hasAttribute('data-live')).length;

describe('SwarmIcon — облик', () => {
  it('холст движка острова; форма по статусу', () => {
    const { rerender } = render(<SwarmIcon status="running" size={16} />);
    const shape = (): string | null | undefined => document.querySelector('canvas')?.getAttribute('data-shape');
    expect(shape()).toBe('dot');
    rerender(<SwarmIcon status="collecting" size={16} />);
    expect(shape()).toBe('sphere');
    rerender(<SwarmIcon status="done" size={16} />);
    expect(shape()).toBe('sphere');
    rerender(<SwarmIcon status="failed" size={16} />);
    expect(shape()).toBe('dot');
    expect(icons()[0]?.getAttribute('data-swarm-icon')).toBe('failed');
  });

  it('холст нужного размера, значок скрыт от скринридера', () => {
    render(<SwarmIcon status="running" size={14} />);
    const canvas = document.querySelector<HTMLCanvasElement>('canvas');
    expect(canvas?.style.width).toBe('14px');
    expect(canvas?.style.height).toBe('14px');
    expect(icons()[0]?.getAttribute('aria-hidden')).toBe('true');
  });
});

describe('SwarmIcon — живые и статичные', () => {
  it('идущий рой живой; законченный, still и Reduce motion — статичные', () => {
    render(
      <>
        <SwarmIcon status="running" size={16} />
        <SwarmIcon status="collecting" size={16} />
        <SwarmIcon status="done" size={16} />
        <SwarmIcon status="failed" size={16} />
        <SwarmIcon status="cancelled" size={16} />
        <SwarmIcon status="running" size={14} still />
        <SwarmIcon status="running" size={14} reducedMotion />
      </>,
    );
    expect(icons().map((icon) => icon.hasAttribute('data-live'))).toEqual([true, true, false, false, false, false, false]);
  });

  it('не больше трёх живых: первые по порядку монтирования, остальные получают слот, когда он освободится', () => {
    const many = (count: number): JSX.Element => (
      <>
        {Array.from({ length: count }, (_, index) => (
          <SwarmIcon key={index} status="running" size={16} />
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
        <SwarmIcon key={1} status="running" size={16} />
        <SwarmIcon key={2} status="running" size={16} />
        <SwarmIcon key={3} status="running" size={16} />
        <SwarmIcon key={4} status="running" size={16} />
      </>,
    );
    expect(icons().map((icon) => icon.hasAttribute('data-live'))).toEqual([true, true, true, false]);
    rerender(
      <>
        <SwarmIcon key={2} status="running" size={16} />
        <SwarmIcon key={3} status="running" size={16} />
        <SwarmIcon key={4} status="running" size={16} />
      </>,
    );
    expect(live()).toBe(3);
  });

  it('рой дошёл до done — слот освобождается и иконка встаёт', () => {
    const view = (status: 'running' | 'done'): JSX.Element => (
      <>
        <SwarmIcon key="a" status={status} size={16} />
        <SwarmIcon key="b" status="running" size={16} />
        <SwarmIcon key="c" status="running" size={16} />
        <SwarmIcon key="d" status="running" size={16} />
      </>
    );
    const { rerender } = render(view('running'));
    expect(icons().map((icon) => icon.hasAttribute('data-live'))).toEqual([true, true, true, false]);
    rerender(view('done'));
    expect(icons().map((icon) => icon.hasAttribute('data-live'))).toEqual([false, true, true, true]);
  });
});

describe('SwarmIcon — реакции', () => {
  it('переход в done и новый сдавший не ломают отрисовку (jsdom без 2d-контекста), первый показ реакций не даёт', () => {
    const now = vi.spyOn(performance, 'now').mockReturnValue(1000);
    const { rerender } = render(<SwarmIcon status="running" size={16} handed={0} />);
    act(() => {
      rerender(<SwarmIcon status="running" size={16} handed={1} />);
    });
    act(() => {
      rerender(<SwarmIcon status="done" size={16} handed={1} />);
    });
    expect(document.querySelector('canvas')?.getAttribute('data-shape')).toBe('sphere');
    now.mockRestore();
  });
});
