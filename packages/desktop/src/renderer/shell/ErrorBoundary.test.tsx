/**
 * Тест 5 куска 2.3: ребёнок бросает → видны заголовок и текст ошибки;
 * «Повторить» перемонтирует детей.
 */

import { useEffect } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ErrorBoundary } from './ErrorBoundary.js';

afterEach(cleanup);

/**
 * Считает монтирования через `useEffect`, а не в теле рендера: React в dev-режиме
 * зовёт бросающую функцию рендера дважды ради вежливого стека ошибки
 * (`invokeGuardedCallback`), и счётчик в теле рендера считал бы такие
 * отброшенные попытки настоящими монтированиями. Эффект коммитится только у
 * реально смонтированного дерева.
 */
function Bomb({ crash, onMount }: { crash: boolean; onMount: () => void }): JSX.Element {
  useEffect(onMount, [onMount]);
  if (crash) throw new Error('бум');
  return <div>ок</div>;
}

describe('ErrorBoundary (тест 5)', () => {
  it('ребёнок бросает — видны заголовок и текст ошибки; «Повторить» монтирует ребёнка заново', () => {
    let mounts = 0;
    const onMount = (): void => {
      mounts += 1;
    };

    // React логирует пойманную ошибку в консоль — тестовому выводу это не нужно.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { rerender } = render(
      <ErrorBoundary title="Не удалось показать раскладку">
        <Bomb crash={false} onMount={onMount} />
      </ErrorBoundary>,
    );
    expect(mounts).toBe(1);
    expect(screen.getByText('ок')).toBeTruthy();

    // Ошибка приходит на обновлении уже смонтированного ребёнка — так же, как
    // в реальности падает уже открытая вкладка, а не сама попытка её открыть.
    rerender(
      <ErrorBoundary title="Не удалось показать раскладку">
        <Bomb crash={true} onMount={onMount} />
      </ErrorBoundary>,
    );
    expect(screen.getByText('Не удалось показать раскладку')).toBeTruthy();
    expect(screen.getByText('бум')).toBeTruthy();
    expect(mounts).toBe(1);

    // Дерево за `ErrorBoundary` обновилось на «починенное» — как если бы
    // причина сбоя уже устранена, прежде чем человек нажал «Повторить».
    rerender(
      <ErrorBoundary title="Не удалось показать раскладку">
        <Bomb crash={false} onMount={onMount} />
      </ErrorBoundary>,
    );
    fireEvent.click(screen.getByText('Retry'));

    expect(mounts).toBe(2);
    expect(screen.getByText('ок')).toBeTruthy();
    expect(screen.queryByText('бум')).toBeNull();

    errorSpy.mockRestore();
  });

  it('«Закрыть» показывается только когда есть onClose, и зовёт его', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { rerender } = render(
      <ErrorBoundary title="Ошибка">
        <Bomb crash={true} onMount={() => {}} />
      </ErrorBoundary>,
    );
    expect(screen.queryByText('Close')).toBeNull();

    const onClose = vi.fn();
    rerender(
      <ErrorBoundary title="Ошибка" onClose={onClose}>
        <Bomb crash={true} onMount={() => {}} />
      </ErrorBoundary>,
    );
    fireEvent.click(screen.getByText('Close'));
    expect(onClose).toHaveBeenCalledTimes(1);

    errorSpy.mockRestore();
  });
});
