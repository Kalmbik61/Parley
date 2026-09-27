import { describe, expect, it } from 'vitest';
import { DraftTracker, stripEscapes } from './draft.js';

/** Таблица правил черновика — план, кусок 1.6. */
const CASES: Array<{ input: string; hasDraft: boolean | 'unchanged' }> = [
  { input: 'привет', hasDraft: true },
  { input: 'привет\r', hasDraft: false },
  { input: 'ab\x7f\x7f', hasDraft: false },
  { input: 'ab\x7f', hasDraft: true },
  { input: '\x1b[A', hasDraft: 'unchanged' },
  { input: '\x1b[200~текст\x1b[201~', hasDraft: true },
  { input: '😀\x7f', hasDraft: false },
  { input: 'abc\x15', hasDraft: false },
];

describe('DraftTracker', () => {
  for (const testCase of CASES) {
    it(`${JSON.stringify(testCase.input)} → ${testCase.hasDraft}`, () => {
      const tracker = new DraftTracker();
      if (testCase.hasDraft === 'unchanged') {
        // Курсорные и прочие CSI не должны сдвигать счётчик ни в одну сторону:
        // проверяем это с обеих сторон — при пустом и непустом черновике.
        tracker.input(testCase.input);
        expect(tracker.hasDraft).toBe(false);

        tracker.input('x');
        expect(tracker.hasDraft).toBe(true);
        tracker.input(testCase.input);
        expect(tracker.hasDraft).toBe(true);
        return;
      }
      tracker.input(testCase.input);
      expect(tracker.hasDraft).toBe(testCase.hasDraft);
    });
  }

  it('reset() обнуляет счётчик', () => {
    const tracker = new DraftTracker();
    tracker.input('текст');
    expect(tracker.hasDraft).toBe(true);
    tracker.reset();
    expect(tracker.hasDraft).toBe(false);
  });

  it('backspace не уводит счётчик ниже нуля', () => {
    const tracker = new DraftTracker();
    tracker.input('\x7f\x7f\x7f');
    expect(tracker.hasDraft).toBe(false);
  });
});

describe('DraftTracker: черновик хоста (кусок 5.1)', () => {
  it('markHost ставит черновик хоста, hasDraft остаётся черновиком человека', () => {
    const tracker = new DraftTracker();
    tracker.markHost();
    expect(tracker.hasHostDraft).toBe(true);
    expect(tracker.hasDraft).toBe(false);
    tracker.clearHost();
    expect(tracker.hasHostDraft).toBe(false);
  });

  it('печатный ввод человека черновик хоста не снимает', () => {
    const tracker = new DraftTracker();
    tracker.markHost();
    tracker.input('x');
    expect(tracker.hasHostDraft).toBe(true);
    expect(tracker.hasDraft).toBe(true);
  });

  for (const key of ['\r', '\x03', '\x15']) {
    it(`${JSON.stringify(key)} человека снимает черновик хоста`, () => {
      const tracker = new DraftTracker();
      tracker.markHost();
      tracker.input(key);
      expect(tracker.hasHostDraft).toBe(false);
    });
  }

  it('\\r внутри вставки человека (маркеры разными кусками) — не Enter; \\r после конца вставки снимает оба', () => {
    const tracker = new DraftTracker();
    tracker.markHost();
    tracker.input('\x1b[200~a\rb\r');
    expect(tracker.hasDraft).toBe(true);
    expect(tracker.hasHostDraft).toBe(true);
    tracker.input('\x1b[201~');
    expect(tracker.hasDraft).toBe(true);
    expect(tracker.hasHostDraft).toBe(true);
    tracker.input('\r');
    expect(tracker.hasDraft).toBe(false);
    expect(tracker.hasHostDraft).toBe(false);
  });

  it('\\n внутри вставки — тоже печатный символ', () => {
    const tracker = new DraftTracker();
    tracker.input('\x1b[200~\n\x1b[201~');
    expect(tracker.hasDraft).toBe(true);
  });

  // Содержимое вставки человека — текст, а не клавиши (ревью 5.1-B). Поддельные байты
  // маркеров внутри содержимого отсюда не отличить — их вырезает окно до xterm
  // (TerminalSurface, раунд исправлений 2); хост разбирает маркеры по порядку.
  for (const [name, chunk] of [
    ['⌃C внутри вставки', '\x1b[200~before\x03after\x1b[201~'],
    ['⌃U внутри вставки', '\x1b[200~before\x15after\x1b[201~'],
    ['\\r внутри вставки', '\x1b[200~a\rb\x1b[201~'],
    ['обычная вставка с \\n в конце', '\x1b[200~text\n\x1b[201~'],
  ]) {
    it(`${name} черновики не снимает; настоящий Enter после вставки снимает`, () => {
      const tracker = new DraftTracker();
      tracker.markHost();
      tracker.input(chunk as string);
      expect(tracker.hasHostDraft).toBe(true);
      expect(tracker.hasDraft).toBe(true);
      tracker.input('\r');
      expect(tracker.hasHostDraft).toBe(false);
      expect(tracker.hasDraft).toBe(false);
    });
  }

  it('две вставки в одном куске с настоящим \\r между ними — черновики сняты', () => {
    const tracker = new DraftTracker();
    tracker.markHost();
    tracker.input('\x1b[200~a\x1b[201~\r\x1b[200~b\x1b[201~');
    expect(tracker.hasHostDraft).toBe(false);
    // Вторая вставка — новый черновик человека после Enter.
    expect(tracker.hasDraft).toBe(true);
  });

  it('вставка из двух кусков с \\n и ⌃C внутри не снимает черновик до настоящего Enter после конца', () => {
    const tracker = new DraftTracker();
    tracker.markHost();
    tracker.input('\x1b[200~AAAA');
    tracker.input('BB\x03BB\nCCCC\x1b[201~');
    expect(tracker.hasHostDraft).toBe(true);
    expect(tracker.hasDraft).toBe(true);
    tracker.input('x');
    expect(tracker.hasHostDraft).toBe(true);
    tracker.input('\n');
    expect(tracker.hasHostDraft).toBe(false);
    expect(tracker.hasDraft).toBe(false);
  });

  it('⌃C после конца вставки в том же куске — отмена', () => {
    const tracker = new DraftTracker();
    tracker.markHost();
    tracker.input('\x1b[200~a\x1b[201~\x03');
    expect(tracker.hasHostDraft).toBe(false);
    expect(tracker.hasDraft).toBe(false);
  });

  it('ввод до вставки и после неё в одном куске считается как обычный', () => {
    const tracker = new DraftTracker();
    tracker.markHost();
    tracker.input('x\x1b[200~a\r\x1b[201~\r');
    expect(tracker.hasHostDraft).toBe(false);
    expect(tracker.hasDraft).toBe(false);
  });
});

describe('stripEscapes', () => {
  it('экспортирован и вырезает ESC[31m', () => {
    expect(stripEscapes('\x1b[31mred\x1b[0m')).toBe('red');
  });

  it('OSC вырезается целиком — до BEL или до ST, тело мусором не остаётся', () => {
    expect(stripEscapes('\x1b]52;c;aGVsbG8=\x07rest')).toBe('rest');
    expect(stripEscapes('a\x1b]0;title\x1b\\b')).toBe('ab');
    expect(stripEscapes('a\x1b]8;;http://x\x1b\\link\x1b]8;;\x07b')).toBe('alinkb');
  });
});
