// packages/desktop/src/renderer/browser/annotate/AnnotationTray.test.tsx
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { TOAST_GAP, TOAST_INSET_VAR } from '../../ui/toast-inset.js';
import type { AnnotationItem } from './store.js';
import { AnnotationTray } from './AnnotationTray.js';

afterEach(() => cleanup());

const VIEWPORT = { width: 1280, height: 800, dpr: 2 };
const PAGE = 'http://localhost:5173/';
// Без пробела в конце: getByTitle сравнивает подпись после обрезки пробелов.
const LONG = 'very long comment '.repeat(20).trim();

const ITEMS: AnnotationItem[] = [
  {
    n: 1,
    key: 'a1',
    generation: 0,
    url: PAGE,
    comment: LONG,
    gone: false,
    rect: null,
    target: { kind: 'element', key: 'a1', selector: 'main > button.save', text: 'Save', html: '<button>', styles: {}, anchor: { fx: 0, fy: 0 }, viewport: VIEWPORT },
  },
  {
    n: 2,
    key: 'a2',
    generation: 0,
    url: PAGE,
    comment: '',
    gone: true,
    rect: null,
    target: { kind: 'region', key: 'a2', rect: { x: 0, y: 0, width: 308.4, height: 19.6 }, elements: [], anchor: { fx: 0, fy: 0 }, viewport: VIEWPORT },
  },
];

function handlers() {
  return { onToggle: vi.fn(), onEdit: vi.fn(), onDelete: vi.fn(), onClear: vi.fn(), onAddToChat: vi.fn() };
}

describe('AnnotationTray (спека браузера 4.7; каркас — по Orca)', () => {
  it('шапка — число; пункт — номер, цель, комментарий в одну строку, «element gone»; правка и удаление по номеру', () => {
    const h = handlers();
    render(<AnnotationTray items={ITEMS} collapsed={false} busy={false} {...h} />);
    const tray = screen.getByTestId('annotation-tray');
    expect(within(tray).getByRole('button', { name: /2 annotations/ })).toBeTruthy();
    const [first, second] = within(tray).getAllByRole('listitem') as [HTMLElement, HTMLElement];
    expect(first.textContent).toContain('button.save');
    const comment = within(first).getByTitle(LONG);
    expect(comment.className).toContain('truncate');
    expect(second.textContent).toContain('Region 308 × 20');
    expect(second.textContent).toContain('No comment');
    expect(second.textContent).toContain('element gone');
    fireEvent.click(within(tray).getByRole('button', { name: 'Edit annotation 1' }));
    fireEvent.click(within(tray).getByRole('button', { name: 'Delete annotation 2' }));
    expect(h.onEdit).toHaveBeenCalledWith(1);
    expect(h.onDelete).toHaveBeenCalledWith(2);
  });

  it('Фокус ревью 6: у Orca в лотке «Send» с отправкой и «Copy» в буфер — здесь их нет, ничего не уходит само', () => {
    render(<AnnotationTray items={ITEMS} collapsed={false} busy={false} {...handlers()} />);
    expect(screen.queryByRole('button', { name: /send|copy/i })).toBeNull();
  });

  it('свёрнут — только шапка «N annotations»; клик по ней — onToggle', () => {
    const h = handlers();
    render(<AnnotationTray items={ITEMS} collapsed busy={false} {...h} />);
    expect(screen.queryAllByRole('listitem')).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: /2 annotations/ }));
    expect(h.onToggle).toHaveBeenCalledTimes(1);
  });

  it('Clear и Add to chat; пока идёт добавление — неактивны', () => {
    const h = handlers();
    const view = render(<AnnotationTray items={ITEMS} collapsed={false} busy={false} {...h} />);
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add to chat' }));
    expect([h.onClear.mock.calls.length, h.onAddToChat.mock.calls.length]).toEqual([1, 1]);
    view.rerender(<AnnotationTray items={ITEMS} collapsed={false} busy {...h} />);
    expect((screen.getByRole('button', { name: 'Add to chat' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Clear' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('высота лотка: 45% поля, но не меньше места под шапку, одну строку и кнопки — в низком поле (800×500 с DevTools) список не схлопывается, а Clear и Add to chat не обрезаются', () => {
    render(<AnnotationTray items={ITEMS} collapsed={false} busy={false} {...handlers()} />);
    // Раскладки в jsdom нет — здесь только сам предел; коробки в 800×500 с панелью DevTools меряет E2E задачи 24.
    // Было `max-h-[45%]`: при поле в 204 px список получал 12 px (ни одной строки), ниже ~185 px кнопки уходили за край карточки.
    expect(screen.getByTestId('annotation-tray').classList.contains('max-h-[min(calc(100%-1.5rem),max(45%,8.5rem))]')).toBe(true);
  });

  it('пункты разных документов с одним ключом — две строки без предупреждения React о повторе ключа', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const [first] = ITEMS as [AnnotationItem, AnnotationItem];
    // Скрипт нового документа нумерует с a1 заново: ключ тот же, поколение другое.
    const again: AnnotationItem = { ...first, n: 2, generation: 1 };
    render(<AnnotationTray items={[first, again]} collapsed={false} busy={false} {...handlers()} />);
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });
});

/**
 * P1 итогового ревью этапа B: тост «N annotations added to …» стоял на кнопках лотка следующей пачки («Add to chat» закрыт на
 * 96%, пока тост на экране, а под курсором он не гаснет вовсе). Лоток стоит в углу поля вкладки, тост — в углу окна: лоток
 * заявляет, насколько тостам подняться (`ui/toast-inset.ts`), по своему живому положению и только пока вкладка видна.
 */
describe('AnnotationTray — место для тостов (--toast-inset-bottom)', () => {
  const inset = (): string => document.documentElement.style.getPropertyValue(TOAST_INSET_VAR);
  const WINDOW = { width: 1400, height: 900 };
  /** Положение лотка в окне, которое «видит» getBoundingClientRect: у лотка внизу справа поля. */
  let trayRect = { left: 1040, right: 1360, top: 700 };
  const observers: Array<{ callback: () => void; targets: Element[]; disconnected: boolean }> = [];
  const originalWidth = window.innerWidth;
  const originalHeight = window.innerHeight;

  beforeEach(() => {
    trayRect = { left: 1040, right: 1360, top: 700 };
    observers.length = 0;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: WINDOW.width });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: WINDOW.height });
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const own = this.dataset.testid === 'annotation-tray' ? trayRect : { left: 0, right: 0, top: 0 };
      return { ...own, bottom: own.top + 188, width: own.right - own.left, height: 188, x: own.left, y: own.top, toJSON: () => ({}) } as DOMRect;
    });
    class ResizeObserverStub {
      private readonly entry: { callback: () => void; targets: Element[]; disconnected: boolean };
      constructor(callback: () => void) {
        this.entry = { callback, targets: [], disconnected: false };
        observers.push(this.entry);
      }
      observe(target: Element): void {
        this.entry.targets.push(target);
      }
      unobserve(): void {}
      disconnect(): void {
        this.entry.disconnected = true;
      }
    }
    vi.stubGlobal('ResizeObserver', ResizeObserverStub);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalWidth });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: originalHeight });
    document.documentElement.style.removeProperty(TOAST_INSET_VAR);
  });

  // 2.5rem базы при rem 16 = 40 px: из расстояния «от низа окна до верха лотка» они уже учтены формулой Toaster.
  const expected = (top: number): string => `${WINDOW.height - top + TOAST_GAP - 40}px`;

  it('лоток виден и стоит под столбцом тостов — тосты поднимаются над его верхом: «Add to chat» не под тостом', () => {
    render(<AnnotationTray items={ITEMS} collapsed={false} busy={false} visible {...handlers()} />);
    expect(inset()).toBe(expected(700));
  });

  it('лоток по умолчанию считается видимым: прежние вызовы без `visible` ведут себя как раньше', () => {
    render(<AnnotationTray items={ITEMS} collapsed={false} busy={false} {...handlers()} />);
    expect(inset()).toBe(expected(700));
  });

  it('лоток слева от столбца тостов (браузер в левой группе) — тостам нечего обходить', () => {
    trayRect = { left: 100, right: 420, top: 700 };
    render(<AnnotationTray items={ITEMS} collapsed={false} busy={false} visible {...handlers()} />);
    expect(inset()).toBe('');
  });

  it('вкладка скрыта — лоток ничего не заявляет; показана — заявляет; снова скрыта — снимает', () => {
    const h = handlers();
    const view = render(<AnnotationTray items={ITEMS} collapsed={false} busy={false} visible={false} {...h} />);
    expect(inset()).toBe('');
    view.rerender(<AnnotationTray items={ITEMS} collapsed={false} busy={false} visible {...h} />);
    expect(inset()).toBe(expected(700));
    view.rerender(<AnnotationTray items={ITEMS} collapsed={false} busy={false} visible={false} {...h} />);
    expect(inset()).toBe('');
  });

  it('лоток ушёл («Add to chat», Clear): заявка снята, тосты опускаются на обычное место', () => {
    const view = render(<AnnotationTray items={ITEMS} collapsed={false} busy={false} visible {...handlers()} />);
    expect(inset()).toBe(expected(700));
    view.unmount();
    expect(inset()).toBe('');
  });

  it('лоток подвинули, не меняя его размера (панель DevTools подняла дно поля): пересчёт по наблюдателю поля и по окну', () => {
    render(<AnnotationTray items={ITEMS} collapsed={false} busy={false} visible {...handlers()} />);
    const tray = screen.getByTestId('annotation-tray');
    // Наблюдатель следит за лотком и за полем, в котором он лежит.
    expect(observers).toHaveLength(1);
    expect(observers[0]?.targets).toEqual([tray, tray.parentElement]);
    trayRect = { left: 1040, right: 1360, top: 520 };
    act(() => observers[0]?.callback());
    expect(inset()).toBe(expected(520));
    // Окно уменьшили: верх лотка и высота окна другие.
    trayRect = { left: 1040, right: 1360, top: 400 };
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 600 });
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    expect(inset()).toBe(`${600 - 400 + TOAST_GAP - 40}px`);
  });

  it('лоток свернули (шапка вместо списка): верх ниже, тосты опускаются следом', () => {
    render(<AnnotationTray items={ITEMS} collapsed={false} busy={false} visible {...handlers()} />);
    trayRect = { left: 1040, right: 1360, top: 850 };
    act(() => observers[0]?.callback());
    expect(inset()).toBe(expected(850));
  });

  it('уход лотка отключает наблюдатель и слушателя окна', () => {
    const removeListener = vi.spyOn(window, 'removeEventListener');
    const view = render(<AnnotationTray items={ITEMS} collapsed={false} busy={false} visible {...handlers()} />);
    view.unmount();
    expect(observers[0]?.disconnected).toBe(true);
    expect(removeListener).toHaveBeenCalledWith('resize', expect.any(Function));
  });
});
