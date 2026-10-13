/**
 * Граница ошибок острова: упавший ребёнок — пустое окно и один вызов `failed()` (main прячет окно и возвращает системные
 * уведомления); здоровый ребёнок проходит без вызова.
 */

import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { IslandErrorBoundary } from './IslandErrorBoundary.js';

function Bomb({ crash }: { crash: boolean }): JSX.Element {
  if (crash) throw new Error('boom');
  return <p>остров</p>;
}

describe('IslandErrorBoundary', () => {
  // React логирует пойманную ошибку в консоль — тестовому выводу это не нужно.
  let errorSpy: MockInstance;
  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    cleanup();
    errorSpy.mockRestore();
  });

  it('ребёнок бросил — ничего не рисуется, failed() зовётся ровно один раз', () => {
    const failed = vi.fn();
    const { container } = render(
      <IslandErrorBoundary api={{ failed }}>
        <Bomb crash />
      </IslandErrorBoundary>,
    );
    expect(container.innerHTML).toBe('');
    expect(failed).toHaveBeenCalledTimes(1);
  });

  it('ребёнок цел — виден, failed() не зовётся', () => {
    const failed = vi.fn();
    const { container } = render(
      <IslandErrorBoundary api={{ failed }}>
        <Bomb crash={false} />
      </IslandErrorBoundary>,
    );
    expect(container.querySelector('p')?.textContent).toBe('остров');
    expect(failed).not.toHaveBeenCalled();
  });
});
