/**
 * `MarkdownBoundary` — граница ошибок вокруг отрисовки Markdown от агента (Parley 0.3.0): упавшая отрисовка
 * показывает сырой текст, а не роняет вкладку; смена текста — новая попытка. Сами тексты, которые роняют разбор
 * (тысячи вложенных `>`), проверяют `rooms/RoomMarkdown.test.tsx`, `mail/Letter.test.tsx` и `rooms/RoomPanel.test.tsx`.
 */

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { MarkdownBoundary } from './MarkdownBoundary.js';

afterEach(cleanup);

/** Ребёнок, который бросает, пока ему велят, и считает свои попытки отрисоваться. */
function Bomb({ crash, onRender }: { crash: boolean; onRender: () => void }): JSX.Element {
  onRender();
  if (crash) throw new RangeError('Maximum call stack size exceeded');
  return <p>отрисовано</p>;
}

describe('MarkdownBoundary', () => {
  // React логирует пойманную ошибку в консоль — тестовому выводу это не нужно.
  let errorSpy: MockInstance;
  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('цитаты глубже предела (101 «>») — сразу сырой текст: ребёнка даже не пробуют отрисовать', () => {
    const onRender = vi.fn();
    const text = `${'>'.repeat(101)} глубоко`;
    const { container } = render(
      <MarkdownBoundary text={text}>
        <Bomb crash={false} onRender={onRender} />
      </MarkdownBoundary>,
    );
    expect(onRender).not.toHaveBeenCalled();
    expect(container.querySelector('[data-markdown-fallback]')?.textContent).toBe(text);
  });

  it('ребёнок не бросает — граница прозрачна: виден он, а не сырой текст', () => {
    const { container } = render(
      <MarkdownBoundary text="**сырой**">
        <Bomb crash={false} onRender={() => {}} />
      </MarkdownBoundary>,
    );
    expect(container.querySelector('p')?.textContent).toBe('отрисовано');
    expect(container.querySelector('[data-markdown-fallback]')).toBeNull();
  });

  it('ребёнок бросает — вместо него сырой текст как есть: whitespace-pre-wrap, строчный элемент, без разметки', () => {
    const text = '**сырой**\n\n- текст\n  с переносами\n> цитата';
    const { container } = render(
      <MarkdownBoundary text={text}>
        <Bomb crash onRender={() => {}} />
      </MarkdownBoundary>,
    );
    const fallback = container.querySelector('[data-markdown-fallback]') as HTMLElement;
    expect(fallback.tagName).toBe('SPAN');
    expect(fallback.className).toContain('whitespace-pre-wrap');
    expect(fallback.textContent).toBe(text);
    expect(container.querySelector('p, strong, li, blockquote')).toBeNull();
  });

  it('текст прежний — новой попытки нет: упавший ребёнок не отрисовывается заново на каждую перерисовку', () => {
    let attempts = 0;
    const onRender = (): void => {
      attempts += 1;
    };
    const { container, rerender } = render(
      <MarkdownBoundary text="тот же">
        <Bomb crash onRender={onRender} />
      </MarkdownBoundary>,
    );
    const afterFirst = attempts;
    expect(container.querySelector('[data-markdown-fallback]')).not.toBeNull();
    rerender(
      <MarkdownBoundary text="тот же">
        <Bomb crash onRender={onRender} />
      </MarkdownBoundary>,
    );
    expect(attempts).toBe(afterFirst);
    expect(container.querySelector('[data-markdown-fallback]')?.textContent).toBe('тот же');
  });

  it('текст сменился — граница сбрасывается: ребёнок пробует снова, а упавший текст снова показывается сырым', () => {
    const { container, rerender } = render(
      <MarkdownBoundary text="плохой">
        <Bomb crash onRender={() => {}} />
      </MarkdownBoundary>,
    );
    expect(container.querySelector('[data-markdown-fallback]')?.textContent).toBe('плохой');

    rerender(
      <MarkdownBoundary text="хороший">
        <Bomb crash={false} onRender={() => {}} />
      </MarkdownBoundary>,
    );
    expect(container.querySelector('[data-markdown-fallback]')).toBeNull();
    expect(container.querySelector('p')?.textContent).toBe('отрисовано');

    rerender(
      <MarkdownBoundary text="снова плохой">
        <Bomb crash onRender={() => {}} />
      </MarkdownBoundary>,
    );
    expect(container.querySelector('[data-markdown-fallback]')?.textContent).toBe('снова плохой');
  });

  it('упал один — соседний под своей границей живёт', () => {
    const { container } = render(
      <>
        <MarkdownBoundary text="упавший">
          <Bomb crash onRender={() => {}} />
        </MarkdownBoundary>
        <MarkdownBoundary text="целый">
          <Bomb crash={false} onRender={() => {}} />
        </MarkdownBoundary>
      </>,
    );
    expect(container.querySelectorAll('[data-markdown-fallback]')).toHaveLength(1);
    expect(container.querySelector('p')?.textContent).toBe('отрисовано');
  });
});
