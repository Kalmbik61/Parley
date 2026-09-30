/**
 * Разбор терминала Codex (спека комнат Organic, 3.6): заголовок OSC 0 и уведомления OSC 9 с буфером
 * на границах чанков. Настоящий Codex не запускается: фикстура — поток байтов, каким его описывает
 * исследование (спиннер, `Ready`, `[ ! ] Action Required`, `Approval requested: …`), с обычным шумом
 * терминала вокруг — цветами, перемещениями курсора, чужими OSC.
 */

import { describe, expect, it } from 'vitest';
import {
  MAX_OSC_LENGTH,
  classifyNotification,
  classifyTitle,
  createCodexTerminalParser,
  type CodexSignal,
} from './codex-terminal.js';

const THREAD = '019ce3d5-584a-7be2-922e-b8185a8d7c19';
const osc = (body: string, terminator = '\x07'): string => `\x1b]${body}${terminator}`;
const title = (text: string, terminator?: string): string => osc(`0;${text}`, terminator);

const WORKING: CodexSignal = { kind: 'working' };
const READY: CodexSignal = { kind: 'ready' };
const ACTION: CodexSignal = { kind: 'needs-you', reason: 'action-required' };
const APPROVAL: CodexSignal = { kind: 'needs-you', reason: 'approval-requested' };

/** Ход целиком, как он выглядит в потоке: старт TUI, приглашение, работа, одобрение, конец. */
const SESSION_STREAM = [
  '\x1b[?1049h\x1b[?2004h\x1b[?25l\x1b[2J\x1b[H',
  title(`Ready | ${THREAD}`),
  '\x1b[38;5;208m› \x1b[0mсделай тесты зелёными\r\n',
  // Кадры спиннера — заголовок перерисовывается на каждом кадре.
  title(`⠋ Working | ${THREAD}`),
  '\x1b[12;1H\x1b[2K• Running cargo test',
  title(`⠙ Working | ${THREAD}`),
  title(`⠹ Working | ${THREAD}`),
  osc('9;Approval requested: cargo test --workspace'),
  title(`[ ! ] Action Required | ${THREAD}`),
  title(`[ . ] Action Required | ${THREAD}`),
  // Свои OSC терминала, не заголовок и не уведомление: гиперссылка, метка приглашения, буфер обмена.
  osc('8;;https://example.test/docs'),
  osc('133;A'),
  osc('52;c;aGVsbG8='),
  title(`⠸ Working | ${THREAD}`),
  // Терминатор ST (`ESC \`) вместо BEL.
  title(`Ready | ${THREAD}`, '\x1b\\'),
  osc('9;Agent turn complete'),
].join('');

const SESSION_SIGNALS: CodexSignal[] = [
  READY,
  WORKING,
  WORKING,
  WORKING,
  APPROVAL,
  ACTION,
  ACTION,
  WORKING,
  READY,
  { kind: 'turn-complete' },
];

/** Все сигналы потока, поданного по кускам заданной длины. */
function run(stream: string, chunks: (data: string) => string[]): CodexSignal[] {
  const parser = createCodexTerminalParser();
  return chunks(stream).flatMap((chunk) => parser.feed(chunk));
}

/** Куски по одному знаку — самое злое разрезание. */
const perChar = (data: string): string[] => [...data];

describe('classifyTitle', () => {
  const cases: Array<[string, CodexSignal]> = [
    [`Ready | ${THREAD}`, READY],
    [`⠋ Working | ${THREAD}`, WORKING],
    ['⠙ Working', WORKING],
    // Слово `Working` без спиннера — тоже ход.
    [`Working | ${THREAD}`, WORKING],
    // Спиннер без слова (заголовок из одного `spinner`) — ход.
    [`⠹ ${THREAD}`, WORKING],
    ['⠿', WORKING],
    ['[ ! ] Action Required | project', ACTION],
    [`[ . ] Action Required | ${THREAD}`, ACTION],
    ['Action Required', ACTION],
    ['action required', ACTION],
    // Action Required сильнее спиннера и слов: вопрос человеку главнее.
    ['⠋ Action Required', ACTION],
    ['Working — Action Required', ACTION],
  ];
  for (const [input, expected] of cases) {
    it(`«${input}» → ${expected.kind}`, () => {
      expect(classifyTitle(input)).toEqual(expected);
    });
  }

  it('незнакомые заголовки — «неизвестно», а не «работает» и не «готов»', () => {
    for (const unknown of [
      '',
      'codex',
      `Starting | ${THREAD}`,
      `Waiting | ${THREAD}`,
      `Thinking | ${THREAD}`,
      THREAD,
      'my-project',
      '[ ? ] что-то новое',
    ]) {
      expect(classifyTitle(unknown), unknown).toEqual({ kind: 'unknown', source: 'title' });
    }
  });

  it('слова внутри других слов не считаются: Unready, Reworking, Readymade', () => {
    for (const text of ['Unready', 'Reworking', 'Readymade', 'Networking']) {
      expect(classifyTitle(text), text).toEqual({ kind: 'unknown', source: 'title' });
    }
  });

  it('знаки Брайля в середине заголовка спиннером не считаются', () => {
    expect(classifyTitle('проект ⠋ без слов')).toEqual({ kind: 'unknown', source: 'title' });
  });
});

describe('classifyNotification', () => {
  it('одобрение: Approval requested и Codex wants to edit', () => {
    expect(classifyNotification('Approval requested: cargo test')).toEqual(APPROVAL);
    expect(classifyNotification('  Approval requested: rm -rf build')).toEqual(APPROVAL);
    expect(classifyNotification('Codex wants to edit src/main.rs')).toEqual(APPROVAL);
  });

  it('конец хода — только фраза без ответа', () => {
    expect(classifyNotification('Agent turn complete')).toEqual({ kind: 'turn-complete' });
  });

  it('ответ агента вместо фразы — «неизвестно»: по началу текста конец хода не узнать', () => {
    expect(classifyNotification('Готово: сборка починена, тесты зелёные.')).toEqual({
      kind: 'unknown',
      source: 'notification',
    });
  });

  it('фраза посередине текста и без двоеточия одобрением не считается', () => {
    for (const text of [
      'Мне нужен Approval requested: вот так',
      'Approval requested',
      'approval requested: x',
      'Codex wants to editors',
      '',
    ]) {
      expect(classifyNotification(text), text).toEqual({ kind: 'unknown', source: 'notification' });
    }
  });
});

describe('поток терминала Codex', () => {
  it('целый поток одним куском даёт сигналы в порядке появления', () => {
    expect(run(SESSION_STREAM, (data) => [data])).toEqual(SESSION_SIGNALS);
  });

  it('любое разрезание надвое даёт те же сигналы (граница чанка в каждой позиции)', () => {
    for (let cut = 0; cut <= SESSION_STREAM.length; cut += 1) {
      const signals = run(SESSION_STREAM, (data) => [data.slice(0, cut), data.slice(cut)]);
      expect(signals, `разрез на ${cut}`).toEqual(SESSION_SIGNALS);
    }
  });

  it('по одному знаку — те же сигналы', () => {
    expect(run(SESSION_STREAM, perChar)).toEqual(SESSION_SIGNALS);
  });

  it('разрез внутри терминатора ST (между ESC и обратным слешем) не теряет заголовок', () => {
    const stream = title(`Ready | ${THREAD}`, '\x1b\\');
    const cut = stream.length - 1;
    expect(run(stream, (data) => [data.slice(0, cut), data.slice(cut)])).toEqual([READY]);
  });

  it('разрез между ESC и «]» начала последовательности не теряет её', () => {
    const stream = `текст${title('⠋ Working')}`;
    const cut = stream.indexOf('\x1b') + 1;
    expect(run(stream, (data) => [data.slice(0, cut), data.slice(cut)])).toEqual([WORKING]);
  });

  it('три и больше чанков на одну последовательность склеиваются', () => {
    const stream = title(`[ ! ] Action Required | ${THREAD}`);
    const parts = [stream.slice(0, 3), stream.slice(3, 20), stream.slice(20, 40), stream.slice(40)];
    expect(run(stream, () => parts)).toEqual([ACTION]);
  });

  it('обычные ESC-последовательности (цвета, курсор, режимы) сигналов не дают', () => {
    const noise = '\x1b[?2004h\x1b[38;2;10;20;30mцвет\x1b[0m\x1b[5;10H\x1b[K\x1b(B\x1b=\x1b>';
    expect(run(noise, (data) => [data])).toEqual([]);
    expect(run(noise, perChar)).toEqual([]);
  });

  it('чужие OSC (гиперссылка, метка приглашения, буфер обмена, прогресс) сигналов не дают', () => {
    const stream = [osc('8;;https://x.test'), osc('133;A'), osc('52;c;aGk='), osc('9;4;3;50')].join(
      '',
    );
    // Последний — ConEmu-прогресс: он идёт тем же OSC 9 и текстом `4;3;50` — не одобрение, не конец хода.
    expect(run(stream, (data) => [data])).toEqual([{ kind: 'unknown', source: 'notification' }]);
  });

  it('заголовок OSC 2 читается так же, как OSC 0', () => {
    expect(run(osc(`2;Ready | ${THREAD}`), (data) => [data])).toEqual([READY]);
  });

  it('терминатор C1 (0x9c) закрывает последовательность', () => {
    expect(run(title('Ready', '\x9c'), (data) => [data])).toEqual([READY]);
  });

  it('OSC без терминатора не ест следующую: новый ESC обрывает прежнюю', () => {
    // Первая последовательность не закрыта, за ней сразу идёт другая, целая.
    const stream = `\x1b]0;⠋ Work${title('Ready')}`;
    expect(run(stream, (data) => [data])).toEqual([READY]);
    expect(run(stream, perChar)).toEqual([READY]);
  });

  it('CAN и SUB обрывают последовательность', () => {
    const stream = `\x1b]0;Ready\x18${title('⠋ Working')}\x1b]0;Ready\x1a`;
    expect(run(stream, (data) => [data])).toEqual([WORKING]);
  });

  it('незакрытая последовательность ждёт продолжения в следующем куске', () => {
    const parser = createCodexTerminalParser();
    expect(parser.feed('\x1b]0;Rea')).toEqual([]);
    expect(parser.feed('dy | id')).toEqual([]);
    expect(parser.feed('\x07')).toEqual([READY]);
  });

  it('хвост без терминатора не копится без предела: длиннее MAX_OSC_LENGTH отбрасывается', () => {
    const parser = createCodexTerminalParser();
    expect(parser.feed(`\x1b]0;${'а'.repeat(MAX_OSC_LENGTH)}`)).toEqual([]);
    // Хвост выброшен — конец «заголовка» уже не приклеивается к нему и сигнала не даёт.
    expect(parser.feed('\x07')).toEqual([]);
    // А парсер жив и разбирает следующее.
    expect(parser.feed(title('Ready'))).toEqual([READY]);
  });

  it('длинная, но закрытая последовательность разбирается: терминатор в том же куске', () => {
    const long = `Approval requested: ${'x'.repeat(MAX_OSC_LENGTH * 2)}`;
    expect(run(osc(`9;${long}`), (data) => [data])).toEqual([APPROVAL]);
  });

  it('многократные вызовы на пустых и обычных кусках ничего не портят', () => {
    const parser = createCodexTerminalParser();
    expect(parser.feed('')).toEqual([]);
    expect(parser.feed('просто текст\r\n')).toEqual([]);
    expect(parser.feed(title('⠋ Working'))).toEqual([WORKING]);
    expect(parser.feed('')).toEqual([]);
  });

  it('одинокий ESC на конце и «]» в начале следующего куска — последовательность', () => {
    const parser = createCodexTerminalParser();
    expect(parser.feed('...\x1b')).toEqual([]);
    expect(parser.feed(']0;⠋ Working\x07')).toEqual([WORKING]);
  });

  it('одинокий ESC, за которым не «]», ничего не ломает', () => {
    const parser = createCodexTerminalParser();
    expect(parser.feed('a\x1b')).toEqual([]);
    expect(parser.feed('[31mкрасный')).toEqual([]);
    expect(parser.feed(title('Ready'))).toEqual([READY]);
  });
});
