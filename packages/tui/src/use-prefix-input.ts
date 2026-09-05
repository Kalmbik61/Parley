import { useStdin } from 'ink';
import { useEffect, useRef } from 'react';
import type { MouseTracking } from './pty/terminal-buffer.js';

/**
 * Весь ввод принадлежит гостю (дизайн TUI v2, раздел 3.1). Харнесс перехватывает
 * только префикс с одной клавишей действия после него и, если `mouseCapture`
 * включён, события мыши; всё остальное уходит в PTY сырыми байтами, потому что
 * разобранные события Ink потеряли бы исходные последовательности.
 */

/** Ctrl+<буква> в байт: Ctrl+A = 1, Ctrl+Q = 17. */
export function ctrlByte(letter: string): number | undefined {
  const code = letter.trim().toLowerCase().charCodeAt(0);
  if (Number.isNaN(code) || code < 97 || code > 122) return undefined;
  return code - 96;
}

/** Клик или колесо в SGR-кодировании; `x`/`y` — колонка и строка от единицы. */
export interface MouseEvent {
  x: number;
  y: number;
  /** Код кнопки SGR: 0 левая, 64/65 колесо, к нему добавляются модификаторы. */
  button: number;
  kind: 'press' | 'release';
}

export interface PrefixInputOptions {
  /** Байт префикса: `ctrlByte(config.prefix)`. */
  prefixByte: number;
  /** Клавиша, нажатая после префикса. Неизвестную колбэк просто игнорирует. */
  onAction: (key: string) => void;
  /**
   * Автомат ждёт вторую клавишу или дождался: по этому строка статуса
   * показывает `ctrl+q …` со списком действий (макеты §3).
   */
  onAwait?: (awaiting: boolean) => void;
  /** Байты, принадлежащие гостю. */
  toGuest: (data: string) => void;
  /** Открыт оверлей или сайдбар в режиме навигации: ввод идёт им, не гостю. */
  capture?: boolean;
  /**
   * Захват, который всё же слышит префикс: режим навигации по сайдбару. Оверлей
   * глух и к префиксу, а из сайдбара `prefix c` заводит работу прямо на строке
   * `new`, не выходя из режима (дизайн 3.1–3.2, 5.1).
   */
  keepPrefix?: boolean;
  onCapture?: (data: string) => void;
  /** Ловит ли харнесс мышь сам (`config.mouseCapture`, раздел 3.3). */
  mouseCapture?: boolean;
  /** Колонок слева от панели: клик не правее — сайдбару. */
  panelLeft?: number;
  /** Что просит гость: `none` — колесо листает наш скроллбэк. */
  mouseTracking?: MouseTracking;
  onMouse?: (event: MouseEvent) => void;
  /** Прокрутка скроллбэка: меньше нуля — вверх, больше — вниз. */
  onScroll?: (lines: number) => void;
}

/** Ждём ли вторую клавишу префикса. Живёт между чанками: префикс мог их разделить. */
export interface PrefixState {
  awaiting: boolean;
}

export const createPrefixState = (): PrefixState => ({ awaiting: false });

/** Сколько строк скроллбэка проматывает один щелчок колеса. */
export const WHEEL_LINES = 3;

const ESC = 0x1b;
/** `ESC [ < кнопка ; колонка ; строка M|m` — единственное поддерживаемое кодирование. */
const SGR_MOUSE = /^\[<(\d+);(\d+);(\d+)([Mm])/;
/** Длиннее SGR-события не бывает: три числа и буква. */
const SGR_MAX = 24;

function parseMouse(data: Buffer, at: number): { event: MouseEvent; length: number } | undefined {
  if (data[at] !== ESC) return undefined;
  const match = SGR_MOUSE.exec(data.subarray(at + 1, at + SGR_MAX).toString('latin1'));
  if (match === null) return undefined;
  return {
    // ESC разобран отдельно, поэтому длина совпадения на байт короче события.
    length: match[0].length + 1,
    event: {
      button: Number(match[1]),
      x: Number(match[2]),
      y: Number(match[3]),
      kind: match[4] === 'M' ? 'press' : 'release',
    },
  };
}

const sgrSequence = ({ button, x, y, kind }: MouseEvent): string =>
  `\u001B[<${button};${x};${y}${kind === 'press' ? 'M' : 'm'}`;

/**
 * То же событие, каким его отдаёт `useInput`: ведущий ESC Ink срезает сам.
 * Собирается из кода: литеральный ESC в регулярном выражении не виден глазом.
 */
const SGR_MOUSE_TEXT = new RegExp(`${String.fromCharCode(ESC)}?\\[<\\d+;\\d+;\\d+[Mm]`, 'g');

/**
 * Снимает события мыши с текста, пришедшего в `useInput` (дизайн 3.1).
 *
 * Глушить мышь на входе харнесса мало: Ink подписан на тот же stdin параллельно
 * и разбирает чанк сам, а неизвестную последовательность отдаёт обработчику
 * текстом без ведущего ESC (`[<0;12;5M`). Без этой чистки клик при открытом
 * оверлее печатался бы в поле ввода вместо того, чтобы ничего не делать.
 */
export const withoutMouse = (input: string): string => input.replace(SGR_MOUSE_TEXT, '');

/** Колесо приходит кнопками 64 (вверх) и 65 (вниз); 0 — это не колесо. */
function wheelLines({ button, kind }: MouseEvent): number {
  if (kind !== 'press' || (button & 64) === 0) return 0;
  return (button & 1) === 0 ? -WHEEL_LINES : WHEEL_LINES;
}

function routeMouse(event: MouseEvent, options: PrefixInputOptions): void {
  const { panelLeft = 0, mouseTracking = 'none', onMouse, onScroll, toGuest } = options;

  if (event.x <= panelLeft) {
    onMouse?.(event);
    return;
  }
  // Гость считает колонки от своего левого края, а не от края терминала.
  if (mouseTracking !== 'none') {
    toGuest(sgrSequence({ ...event, x: event.x - panelLeft }));
    return;
  }
  const lines = wheelLines(event);
  if (lines !== 0) onScroll?.(lines);
}

/**
 * Разбирает чанк stdin и раздаёт его гостю, действиям и мыши. Чистая: состояние
 * автомата снаружи, поэтому тесты идут прямо на байтах.
 */
export function routeInput(data: Buffer, state: PrefixState, options: PrefixInputOptions): void {
  const {
    prefixByte,
    onAction,
    onAwait,
    capture = false,
    keepPrefix = false,
    onCapture,
    mouseCapture = false,
  } = options;

  if (capture) {
    onCapture?.(data.toString('utf8'));
    if (!keepPrefix) return;
  }

  // Под захватом гостю не уходит ничего, но автомат префикса продолжает читать
  // байты: `prefix c` работает и в режиме навигации.
  const toGuest = capture ? (): void => undefined : options.toGuest;

  let pending = 0;
  let at = 0;
  const flush = (end: number): void => {
    if (end > pending) toGuest(data.subarray(pending, end).toString('utf8'));
  };

  while (at < data.length) {
    if (state.awaiting) {
      state.awaiting = false;
      onAwait?.(false);
      const key = data[at] as number;
      at += 1;
      pending = at;
      // Второй префикс подряд — способ отправить его самому гостю.
      if (key === prefixByte) toGuest(String.fromCharCode(prefixByte));
      else onAction(String.fromCharCode(key));
      continue;
    }

    if (data[at] === prefixByte) {
      flush(at);
      at += 1;
      pending = at;
      state.awaiting = true;
      onAwait?.(true);
      continue;
    }

    // Под захватом мышь по-прежнему пропадает целиком: слышен только префикс.
    const mouse = mouseCapture && !capture ? parseMouse(data, at) : undefined;
    if (mouse !== undefined) {
      flush(at);
      at += mouse.length;
      pending = at;
      routeMouse(mouse.event, options);
      continue;
    }

    at += 1;
  }

  flush(at);
}

/**
 * Подписка на сырой stdin, пока панель принимает ввод. Настройки читаются из
 * ссылки: обработчик переживает перерисовки, а переподписка на каждый новый
 * колбэк теряла бы байты, пришедшие между отпиской и подпиской.
 */
export function usePrefixInput(active: boolean, options: PrefixInputOptions): void {
  const { stdin, setRawMode } = useStdin();
  const latest = useRef(options);
  const state = useRef<PrefixState>(createPrefixState());

  useEffect(() => {
    latest.current = options;
  });

  useEffect(() => {
    if (!active || stdin === undefined) return;

    setRawMode?.(true);

    const onData = (chunk: Buffer | string): void => {
      const data = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
      routeInput(data, state.current, latest.current);
    };

    stdin.on('data', onData);
    return () => {
      stdin.off('data', onData);
      setRawMode?.(false);
      // Незакрытый префикс не должен съесть первую клавишу следующего подключения.
      state.current.awaiting = false;
    };
  }, [active, stdin, setRawMode]);
}
