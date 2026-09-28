/**
 * Retry границы ошибки редактора (раунд fix-7.3, п. 6): чанк редактора не догрузился — `React.lazy`
 * держит отклонённый промис, и повтор того же ленивого компонента отказывает мгновенно. Новая
 * попытка — новый ленивый компонент с новым `import()`.
 */

import { Suspense } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ErrorBoundary } from '../../shell/ErrorBoundary.js';
import { lazyWithRetry } from './retry-lazy.js';

function Editor(): JSX.Element {
  return <p>editor loaded</p>;
}

afterEach(cleanup);

describe('lazyWithRetry', () => {
  it('загрузка упала один раз — Retry грузит заново и показывает компонент', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    let calls = 0;
    const load = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error('chunk failed');
      return Editor;
    });
    const editorAt = lazyWithRetry(load);

    function Body(): JSX.Element {
      const { component: Lazy, retry } = editorAt.use();
      return (
        <ErrorBoundary title="Editor didn't load" onRetry={retry}>
          <Suspense fallback={null}>
            <Lazy />
          </Suspense>
        </ErrorBoundary>
      );
    }

    render(<Body />);
    expect(await screen.findByText('chunk failed')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('editor loaded')).toBeTruthy();
    expect(load).toHaveBeenCalledTimes(2);
    errorSpy.mockRestore();
  });

  it('удачная загрузка общая: второе тело не грузит заново', async () => {
    const load = vi.fn(async () => Editor);
    const editorAt = lazyWithRetry(load);
    function Body(): JSX.Element {
      const { component: Lazy } = editorAt.use();
      return (
        <Suspense fallback={null}>
          <Lazy />
        </Suspense>
      );
    }
    render(
      <>
        <Body />
        <Body />
      </>,
    );
    expect(await screen.findAllByText('editor loaded')).toHaveLength(2);
    expect(load).toHaveBeenCalledTimes(1);
  });
});
