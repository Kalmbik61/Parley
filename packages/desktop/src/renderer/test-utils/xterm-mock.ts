/**
 * Общий мок `@xterm/xterm` для тестов рендерера (кусок 5.3): настоящий xterm рисует в
 * канву, которой в jsdom нет. Раньше каждый из семи тестов держал свой литерал
 * `Terminal`, и новый метод в `use-terminal.ts` ронял их все; теперь метод
 * дописывается сюда один раз.
 *
 * Подключение в тесте (фабрика `vi.mock` поднимается выше импортов, поэтому модуль
 * берётся динамическим импортом — тот же экземпляр, что и в статическом импорте теста):
 *
 *   vi.mock('@xterm/xterm', async () => (await import('../test-utils/xterm-mock.js')).xtermModule);
 *
 * `Terminal` — обычный класс, а не `vi.fn`: `vi.restoreAllMocks()` в тестах не сотрёт его
 * реализацию.
 */

import type { IBufferCell, IBufferLine, ILinkProvider } from '@xterm/xterm';

export interface XtermCall {
  /** Номер терминала в `xtermMock.terminals`. */
  term: number;
  method: string;
  args: unknown[];
}

type KeyHandler = (event: KeyboardEvent) => boolean;

/** Ячейка фейкового буфера: символы и ширина (2 — широкий, следом ячейка ширины 0). */
export type FakeCell = [chars: string, width: number];

export interface FakeLineSpec {
  cells: FakeCell[];
  isWrapped?: boolean;
}

/** Ширина кодовой точки для фейкового буфера: CJK и эмодзи — две ячейки. */
function cellWidth(codePoint: number): number {
  if (codePoint >= 0x1f300 && codePoint <= 0x1faff) return 2;
  if (codePoint >= 0x2e80 && codePoint <= 0x9fff) return 2;
  if (codePoint >= 0xac00 && codePoint <= 0xd7a3) return 2;
  if (codePoint >= 0xff00 && codePoint <= 0xff60) return 2;
  return 1;
}

/** Строка буфера из текста: широкие символы занимают две ячейки, как у xterm. */
export function lineFromText(text: string, isWrapped = false): FakeLineSpec {
  const cells: FakeCell[] = [];
  for (const char of text) {
    const width = cellWidth(char.codePointAt(0) ?? 0);
    cells.push([char, width]);
    if (width === 2) cells.push(['', 0]);
  }
  return { cells, isWrapped };
}

function toBufferLine(spec: FakeLineSpec, cols: number): IBufferLine {
  const cellAt = (x: number): IBufferCell | undefined => {
    if (x >= cols) return undefined;
    const [chars, width] = spec.cells[x] ?? ['', 1];
    return { getChars: () => chars, getWidth: () => width, getCode: () => chars.codePointAt(0) ?? 0 } as unknown as IBufferCell;
  };
  return {
    isWrapped: spec.isWrapped ?? false,
    length: cols,
    getCell: cellAt,
    translateToString: () => spec.cells.map(([chars]) => chars).join(''),
  } as IBufferLine;
}

export class FakeTerminal {
  readonly index: number;
  readonly initialOptions: Record<string, unknown>;
  /** Тот же объект, что `term.options`: смена темы на лету видна тесту. */
  readonly options: Record<string, unknown>;
  cols = 80;
  rows = 24;
  writes: string[] = [];
  resets = 0;
  disposed = false;
  selection = '';
  element: HTMLElement | null = null;
  onDataHandler: ((data: string) => void) | null = null;
  keyHandler: KeyHandler | null = null;
  linkProviders: ILinkProvider[] = [];
  private lines: FakeLineSpec[] = [];

  constructor(initialOptions: Record<string, unknown> = {}) {
    xtermMock.constructed += 1;
    if (xtermMock.constructed === xtermMock.throwOnCall) throw new Error('xterm упал');
    this.index = xtermMock.terminals.length;
    this.initialOptions = initialOptions;
    this.options = { ...initialOptions };
    xtermMock.terminals.push(this);
  }

  private log(method: string, args: unknown[]): void {
    xtermMock.calls.push({ term: this.index, method, args });
    xtermMock.onCall?.(this, method);
  }

  /** Строки буфера для провайдера ссылок: `buffer.active.getLine(y)`. */
  setLines(lines: FakeLineSpec[]): void {
    this.lines = lines;
  }

  get buffer(): { active: { getLine(y: number): IBufferLine | undefined } } {
    return {
      active: {
        getLine: (y: number) => {
          const spec = this.lines[y];
          return spec === undefined ? undefined : toBufferLine(spec, this.cols);
        },
      },
    };
  }

  open(element: HTMLElement): void {
    this.log('open', [element]);
    this.element = element;
    xtermMock.onOpen?.(element, this);
  }
  loadAddon(addon: unknown): void {
    this.log('loadAddon', [addon]);
  }
  write(data: string): void {
    this.writes.push(data);
  }
  reset(): void {
    this.resets += 1;
    this.log('reset', []);
  }
  dispose(): void {
    this.disposed = true;
    xtermMock.disposed += 1;
    this.log('dispose', []);
  }
  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
    this.log('resize', [cols, rows]);
  }
  focus(): void {
    this.log('focus', []);
  }
  scrollToBottom(): void {
    this.log('scrollToBottom', []);
  }
  paste(text: string): void {
    this.log('paste', [text]);
  }
  clear(): void {
    this.log('clear', []);
  }
  selectAll(): void {
    this.log('selectAll', []);
  }
  onData(handler: (data: string) => void): { dispose: () => void } {
    this.onDataHandler = handler;
    return { dispose: () => {} };
  }
  attachCustomKeyEventHandler(handler: KeyHandler): void {
    this.keyHandler = handler;
  }
  registerLinkProvider(provider: ILinkProvider): { dispose: () => void } {
    this.linkProviders.push(provider);
    this.log('registerLinkProvider', [provider]);
    return { dispose: () => {} };
  }
  hasSelection(): boolean {
    return this.selection !== '';
  }
  getSelection(): string {
    return this.selection;
  }
}

export const xtermMock = {
  terminals: [] as FakeTerminal[],
  calls: [] as XtermCall[],
  constructed: 0,
  disposed: 0,
  /** Номер вызова конструктора (с 1), на котором он бросает; 0 — не бросать. */
  throwOnCall: 0,
  /** Зовётся из `open`: тест может положить в контейнер своё (например, textarea xterm). */
  onOpen: null as ((element: HTMLElement, term: FakeTerminal) => void) | null,
  /** Зовётся на каждый вызов метода терминала — снять состояние DOM в его момент (например, `inert`). */
  onCall: null as ((term: FakeTerminal, method: string) => void) | null,
  /** Вызовы метода `method` у всех терминалов или у одного. */
  callsOf(method: string, term?: number): XtermCall[] {
    return xtermMock.calls.filter((call) => call.method === method && (term === undefined || call.term === term));
  },
  reset(): void {
    xtermMock.terminals = [];
    xtermMock.calls = [];
    xtermMock.constructed = 0;
    xtermMock.disposed = 0;
    xtermMock.throwOnCall = 0;
    xtermMock.onOpen = null;
    xtermMock.onCall = null;
    searchMock.addons = [];
  },
};

/** То, что фабрика `vi.mock('@xterm/xterm', …)` отдаёт вместо модуля. */
export const xtermModule = { Terminal: FakeTerminal };

/**
 * Подставной `SearchAddon` (`SearchBar` подписывается на `onDidChangeResults`): вызовы — в
 * тот же журнал с `term: -1`, `emitResults` — счётчик, будто его прислал аддон.
 */
export class FakeSearchAddon {
  readonly options: unknown;
  private listeners = new Set<(event: { resultIndex: number; resultCount: number }) => void>();

  constructor(options?: unknown) {
    this.options = options;
    searchMock.addons.push(this);
  }
  private log(method: string, args: unknown[]): void {
    xtermMock.calls.push({ term: -1, method, args });
  }
  findNext(query: string, options?: unknown): boolean {
    this.log('findNext', [query, options]);
    return true;
  }
  findPrevious(query: string, options?: unknown): boolean {
    this.log('findPrevious', [query, options]);
    return true;
  }
  clearDecorations(): void {
    this.log('clearDecorations', []);
  }
  onDidChangeResults(listener: (event: { resultIndex: number; resultCount: number }) => void): { dispose: () => void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }
  emitResults(event: { resultIndex: number; resultCount: number }): void {
    for (const listener of this.listeners) listener(event);
  }
}

export const searchMock = { addons: [] as FakeSearchAddon[] };

/** Для `vi.mock('@xterm/addon-search', …)`. */
export const searchModule = { SearchAddon: FakeSearchAddon };
