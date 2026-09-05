import { describe, expect, it } from 'vitest';
import {
  createPrefixState,
  ctrlByte,
  routeInput,
  WHEEL_LINES,
  withoutMouse,
  type MouseEvent,
  type PrefixInputOptions,
} from './use-prefix-input.js';

/** Байты пишем через коды: литеральный ESC в исходнике не виден глазом. */
const ESC = String.fromCharCode(0x1b);
const PREFIX = String.fromCharCode(0x11);

interface Recorder {
  guest: string[];
  actions: string[];
  captured: string[];
  mouse: MouseEvent[];
  scrolled: number[];
  options: PrefixInputOptions;
}

function recorder(over: Partial<PrefixInputOptions> = {}): Recorder {
  const guest: string[] = [];
  const actions: string[] = [];
  const captured: string[] = [];
  const mouse: MouseEvent[] = [];
  const scrolled: number[] = [];

  return {
    guest,
    actions,
    captured,
    mouse,
    scrolled,
    options: {
      prefixByte: ctrlByte('q') ?? 0,
      toGuest: (data) => guest.push(data),
      onAction: (key) => actions.push(key),
      onCapture: (data) => captured.push(data),
      onMouse: (event) => mouse.push(event),
      onScroll: (lines) => scrolled.push(lines),
      ...over,
    },
  };
}

/** Один чанк stdin. Состояние автомата возвращается наружу для проверок между чанками. */
const feed = (input: string, it: Recorder, state = createPrefixState()): typeof state => {
  routeInput(Buffer.from(input, 'utf8'), state, it.options);
  return state;
};

describe('ctrlByte', () => {
  it('переводит букву в управляющий байт', () => {
    expect(ctrlByte('q')).toBe(17);
    expect(ctrlByte('Q')).toBe(17);
    expect(ctrlByte('a')).toBe(1);
  });

  it('не-буквы отбрасываются', () => {
    expect(ctrlByte('1')).toBeUndefined();
    expect(ctrlByte('')).toBeUndefined();
    expect(ctrlByte('ц')).toBeUndefined();
  });
});

describe('префикс (чек-лист 16-19)', () => {
  it('16: ctrl+q c — действие, гостю ничего не уходит', () => {
    const it = recorder();
    feed(`${PREFIX}c`, it);

    expect(it.actions).toEqual(['c']);
    expect(it.guest).toEqual([]);
  });

  it('17: ctrl+q ctrl+q — байт префикса уходит гостю', () => {
    const it = recorder();
    feed(`${PREFIX}${PREFIX}`, it);

    expect(it.guest).toEqual([PREFIX]);
    expect(it.actions).toEqual([]);
  });

  it('18: неизвестная клавиша отменяет префикс и не доезжает до гостя', () => {
    const it = recorder();
    // Что клавиша неизвестна, решает колбэк действий: автомат отдаёт ему любую,
    // но гостю она не уходит ни в каком случае.
    feed(`${PREFIX}z`, it);

    expect(it.guest).toEqual([]);
    expect(it.actions).toEqual(['z']);
  });

  it('19: префикс в середине чанка — до него гостю, после действия снова гостю', () => {
    const it = recorder();
    feed(`до${PREFIX}wпосле`, it);

    expect(it.guest).toEqual(['до', 'после']);
    expect(it.actions).toEqual(['w']);
  });

  it('19: префикс на границе чанков не теряется', () => {
    const it = recorder();
    const state = feed(`echo${PREFIX}`, it);
    expect(state.awaiting).toBe(true);

    feed('i', it, state);
    expect(it.guest).toEqual(['echo']);
    expect(it.actions).toEqual(['i']);
  });

  it('обычный ввод целиком уходит гостю', () => {
    const it = recorder();
    feed('привет\r', it);

    expect(it.guest).toEqual(['привет\r']);
    expect(it.actions).toEqual([]);
  });
});

describe('перехват ввода оверлеем (чек-лист 20)', () => {
  it('20: пока capture включён, чанк уходит оверлею, а не гостю', () => {
    const it = recorder({ capture: true });
    feed(`j${PREFIX}c`, it);

    expect(it.captured).toEqual([`j${PREFIX}c`]);
    expect(it.guest).toEqual([]);
    expect(it.actions).toEqual([]);
  });
});

describe('мышь (чек-лист 21)', () => {
  const click = (button: number, x: number, y: number, kind: 'M' | 'm' = 'M'): string =>
    `${ESC}[<${button};${x};${y}${kind}`;

  it('21: клик по сайдбару уходит колбэку сайдбара', () => {
    const it = recorder({ mouseCapture: true, panelLeft: 26 });
    feed(click(0, 5, 3), it);

    expect(it.mouse).toEqual([{ button: 0, x: 5, y: 3, kind: 'press' }]);
    expect(it.guest).toEqual([]);
  });

  it('21: клик в панели при tracking гостя транслируется с пересчётом колонок', () => {
    const it = recorder({ mouseCapture: true, panelLeft: 26, mouseTracking: 'vt200' });
    feed(click(0, 30, 4), it);

    expect(it.guest).toEqual([click(0, 4, 4)]);
    expect(it.mouse).toEqual([]);
  });

  it('21: отпускание кнопки в панели доезжает гостю как m', () => {
    const it = recorder({ mouseCapture: true, panelLeft: 26, mouseTracking: 'drag' });
    feed(click(0, 30, 4, 'm'), it);

    expect(it.guest).toEqual([click(0, 4, 4, 'm')]);
  });

  it('21: без tracking гостя колесо листает наш скроллбэк', () => {
    const it = recorder({ mouseCapture: true, panelLeft: 26 });
    feed(click(64, 40, 6) + click(65, 40, 6), it);

    expect(it.scrolled).toEqual([-WHEEL_LINES, WHEEL_LINES]);
    expect(it.guest).toEqual([]);
  });

  it('21: без tracking гостя клик в панели никуда не уходит', () => {
    const it = recorder({ mouseCapture: true, panelLeft: 26 });
    feed(click(0, 40, 6), it);

    expect(it.guest).toEqual([]);
    expect(it.mouse).toEqual([]);
    expect(it.scrolled).toEqual([]);
  });

  it('21: при mouseCapture=false события не ловятся и уходят гостю как есть', () => {
    const it = recorder({ mouseCapture: false, panelLeft: 26 });
    feed(click(0, 5, 3), it);

    expect(it.guest).toEqual([click(0, 5, 3)]);
    expect(it.mouse).toEqual([]);
  });

  it('21: текст вокруг события мыши достаётся гостю', () => {
    const it = recorder({ mouseCapture: true, panelLeft: 26 });
    feed(`до${click(0, 5, 3)}после`, it);

    expect(it.guest).toEqual(['до', 'после']);
    expect(it.mouse).toHaveLength(1);
  });

  it('21: не-мышиная escape-последовательность уходит гостю целиком', () => {
    const it = recorder({ mouseCapture: true, panelLeft: 26 });
    // Стрелка вверх: ESC [ A — префикс мыши не подходит, разбирать нечего.
    feed(`${ESC}[A`, it);

    expect(it.guest).toEqual([`${ESC}[A`]);
    expect(it.mouse).toEqual([]);
  });
});

/**
 * Оверлеи слушают stdin через Ink, а не через `routeInput`: перехват на входе
 * харнесса их не защищает (дизайн 3.1).
 */
describe('withoutMouse: мышь в оверлее', () => {
  it('снимает событие, каким его отдаёт useInput — без ведущего ESC', () => {
    expect(withoutMouse('[<0;12;5M')).toBe('');
    expect(withoutMouse(`${ESC}[<0;12;5m`)).toBe('');
    // Один клик настоящего терминала — нажатие и отпускание подряд.
    expect(withoutMouse('Авт[<0;12;5M[<0;12;5m')).toBe('Авт');
  });

  it('обычный текст не трогает', () => {
    expect(withoutMouse('Авторизация')).toBe('Авторизация');
    expect(withoutMouse('[< это не событие')).toBe('[< это не событие');
  });
});
