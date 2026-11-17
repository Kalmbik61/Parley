import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { useRef } from 'react';
import { CARD_MOTION_MS, useCardMotion } from './use-card-motion.js';

interface Card { id: number; column: number }

function Board({ cards, version }: { cards: Card[]; version: number }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useCardMotion(ref, version);
  return (
    <div ref={ref}>
      {[0, 1].map((column) => (
        <section key={column}>
          {cards.filter((card) => card.column === column).map((card) => (
            <button key={card.id} data-board-item={card.id} data-column={column}>
              <span data-board-stripe="" style={{ background: 'rgb(10, 20, 30)' }} />
            </button>
          ))}
        </section>
      ))}
    </div>
  );
}

const animate = vi.fn();
const original = { animate: Element.prototype.animate, rect: Element.prototype.getBoundingClientRect };
const matchMedia = window.matchMedia;

beforeEach(() => {
  animate.mockReset();
  Element.prototype.animate = animate as never;
  // Место карточки — её колонка по горизонтали и её номер по вертикали.
  Element.prototype.getBoundingClientRect = function (this: Element) {
    const column = Number(this.getAttribute('data-column') ?? 0);
    const id = Number(this.getAttribute('data-board-item') ?? 0);
    return { left: column * 300, top: id * 100, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
  };
  window.matchMedia = ((query: string) => ({ matches: false, media: query })) as never;
});
afterEach(() => {
  cleanup();
  Element.prototype.animate = original.animate;
  Element.prototype.getBoundingClientRect = original.rect;
  window.matchMedia = matchMedia;
});

const start: Card[] = [{ id: 1, column: 0 }, { id: 2, column: 0 }];

it('первый показ — анимации нет', () => {
  render(<Board cards={start} version={0} />);
  expect(animate).not.toHaveBeenCalled();
});

it('карточка сменила место — анимация с длительностью 460 мс', () => {
  const view = render(<Board cards={start} version={0} />);
  // Карточка 1 уходит из списка: карточка 2 остаётся на месте (место считается по номеру), движения нет.
  view.rerender(<Board cards={[{ id: 2, column: 0 }]} version={1} />);
  expect(animate).not.toHaveBeenCalled();
  view.rerender(<Board cards={[{ id: 2, column: 1 }]} version={2} />);
  const moves = animate.mock.calls.filter((call) => (call[0] as { transform?: string }[])[0]!.transform !== undefined);
  expect(moves).toHaveLength(1);
  expect((moves[0]![1] as { duration: number }).duration).toBe(CARD_MOTION_MS);
  expect(CARD_MOTION_MS).toBe(460);
});

it('карточка переехала в другую колонку (новый элемент с тем же номером) — анимация есть', () => {
  const view = render(<Board cards={start} version={0} />);
  const first = view.container.querySelector('[data-board-item="2"]');
  view.rerender(<Board cards={[{ id: 1, column: 0 }, { id: 2, column: 1 }]} version={1} />);
  const second = view.container.querySelector('[data-board-item="2"]');
  expect(second).not.toBe(first);
  const target = animate.mock.contexts.filter((context) => context === second);
  expect(target.length).toBeGreaterThan(0);
  const keyframes = animate.mock.calls[0]![0] as { transform: string }[];
  expect(keyframes[0]!.transform).toBe('translate(-300px, 0px)');
});

it('вспышка берёт цвет полосы карточки (фон data-board-stripe)', () => {
  const view = render(<Board cards={start} version={0} />);
  view.rerender(<Board cards={[{ id: 1, column: 0 }, { id: 2, column: 1 }]} version={1} />);
  const flash = animate.mock.calls.map((call) => call[0] as { boxShadow?: string }[]).find((frames) => frames[0]!.boxShadow !== undefined);
  expect(flash![0]!.boxShadow).toContain('rgb(10, 20, 30)');
});

it('место то же — анимации нет', () => {
  const view = render(<Board cards={start} version={0} />);
  view.rerender(<Board cards={start} version={1} />);
  expect(animate).not.toHaveBeenCalled();
});

it('уменьшить движение — анимации нет', () => {
  window.matchMedia = ((query: string) => ({ matches: query.includes('reduce'), media: query })) as never;
  const view = render(<Board cards={start} version={0} />);
  view.rerender(<Board cards={[{ id: 1, column: 0 }, { id: 2, column: 1 }]} version={1} />);
  expect(animate).not.toHaveBeenCalled();
});

it('без element.animate хук не падает', () => {
  Element.prototype.animate = undefined as never;
  const view = render(<Board cards={start} version={0} />);
  expect(() => view.rerender(<Board cards={[{ id: 1, column: 0 }, { id: 2, column: 1 }]} version={1} />)).not.toThrow();
});
