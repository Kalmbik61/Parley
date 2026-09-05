import { describe, expect, it } from 'vitest';
import { createTerminalBuffer, type TerminalBuffer } from './terminal-buffer.js';

const ESC = '\u001B';

/** xterm парсит асинхронно — ждём подтверждения записи. */
const write = (buffer: TerminalBuffer, chunk: string): Promise<void> =>
  new Promise((resolve) => buffer.write(chunk, resolve));

const plain = (buffer: TerminalBuffer): string[] =>
  buffer.snapshot().lines.map((segments) => segments.map((s) => s.text).join(''));

describe('createTerminalBuffer', () => {
  it('раскладывает текст по строкам экрана', async () => {
    const buffer = createTerminalBuffer(20, 4);
    await write(buffer, 'первая\r\nвторая\r\n');

    const lines = plain(buffer);
    expect(lines[0]).toBe('первая');
    expect(lines[1]).toBe('вторая');
    expect(lines).toHaveLength(4);
    buffer.dispose();
  });

  it('разбирает цвет и жирность в сегменты', async () => {
    const buffer = createTerminalBuffer(40, 3);
    await write(buffer, `${ESC}[31mкрасный${ESC}[0m обычный\r\n`);

    const [line] = buffer.snapshot().lines;
    expect(line?.[0]).toMatchObject({ text: 'красный', color: 'red' });
    expect(line?.[1]?.text).toBe(' обычный');
    expect(line?.[1]?.color).toBeUndefined();
    buffer.dispose();
  });

  it('понимает 256-цветную палитру и truecolor', async () => {
    const buffer = createTerminalBuffer(40, 3);
    await write(buffer, `${ESC}[38;5;196mпалитра${ESC}[0m\r\n`);
    await write(buffer, `${ESC}[38;2;18;52;86mtruecolor${ESC}[0m\r\n`);

    const lines = buffer.snapshot().lines;
    expect(lines[0]?.[0]?.color).toBe('#ff0000');
    expect(lines[1]?.[0]?.color).toBe('#123456');
    buffer.dispose();
  });

  it('атрибуты текста попадают в сегмент', async () => {
    const buffer = createTerminalBuffer(40, 4);
    await write(buffer, `${ESC}[1mжирный${ESC}[0m\r\n`);
    await write(buffer, `${ESC}[4mподчёркнутый${ESC}[0m\r\n`);
    await write(buffer, `${ESC}[7mинверсия${ESC}[0m\r\n`);

    const lines = buffer.snapshot().lines;
    expect(lines[0]?.[0]?.bold).toBe(true);
    expect(lines[1]?.[0]?.underline).toBe(true);
    expect(lines[2]?.[0]?.inverse).toBe(true);
    buffer.dispose();
  });

  it('альтернативный экран отражается в снимке', async () => {
    const buffer = createTerminalBuffer(20, 4);
    await write(buffer, 'обычный экран\r\n');
    expect(buffer.snapshot().altScreen).toBe(false);

    await write(buffer, `${ESC}[?1049h${ESC}[H${ESC}[2Jполный экран`);
    const snapshot = buffer.snapshot();
    expect(snapshot.altScreen).toBe(true);
    expect(snapshot.lines[0]?.[0]?.text).toBe('полный экран');

    // Возврат из alt-screen восстанавливает прежнее содержимое.
    await write(buffer, `${ESC}[?1049l`);
    const back = buffer.snapshot();
    expect(back.altScreen).toBe(false);
    expect(back.lines[0]?.map((s) => s.text).join('')).toBe('обычный экран');
    buffer.dispose();
  });

  it('очистка экрана и позиционирование курсора работают', async () => {
    const buffer = createTerminalBuffer(20, 4);
    await write(buffer, 'мусор\r\nещё мусор\r\n');
    await write(buffer, `${ESC}[2J${ESC}[Hчисто`);

    expect(plain(buffer)[0]).toBe('чисто');
    buffer.dispose();
  });

  it('resize меняет размер снимка', async () => {
    const buffer = createTerminalBuffer(20, 4);
    await write(buffer, 'текст\r\n');

    buffer.resize(60, 10);
    const snapshot = buffer.snapshot();
    expect(snapshot.cols).toBe(60);
    expect(snapshot.rows).toBe(10);
    expect(snapshot.lines).toHaveLength(10);
    buffer.dispose();
  });

  it('слишком мелкие размеры подтягиваются до минимума', () => {
    const buffer = createTerminalBuffer(0, 0);
    const snapshot = buffer.snapshot();
    expect(snapshot.cols).toBe(2);
    expect(snapshot.rows).toBe(2);
    buffer.dispose();
  });

  it('хвостовые пробелы не попадают в сегменты', async () => {
    const buffer = createTerminalBuffer(40, 3);
    await write(buffer, 'коротко\r\n');

    const [line] = buffer.snapshot().lines;
    expect(line?.map((s) => s.text).join('')).toBe('коротко');
    buffer.dispose();
  });

  it('широкие символы не дублируются', async () => {
    const buffer = createTerminalBuffer(20, 3);
    await write(buffer, '漢字テスト\r\n');

    expect(plain(buffer)[0]).toBe('漢字テスト');
    buffer.dispose();
  });

  it('длинная строка переносится по ширине экрана', async () => {
    const buffer = createTerminalBuffer(10, 4);
    await write(buffer, 'abcdefghijklmno\r\n');

    const lines = plain(buffer);
    expect(lines[0]).toBe('abcdefghij');
    expect(lines[1]).toBe('klmno');
    buffer.dispose();
  });
});

describe('курсор в снимке', () => {
  it('позиция курсора идёт за текстом и за CUP', async () => {
    const buffer = createTerminalBuffer(20, 4);
    await write(buffer, 'abc');
    expect(buffer.snapshot().cursor).toEqual({ x: 3, y: 0, visible: true });

    await write(buffer, `${ESC}[2;4H`);
    expect(buffer.snapshot().cursor).toEqual({ x: 3, y: 1, visible: true });
    buffer.dispose();
  });

  it('DECTCEM прячет и показывает курсор', async () => {
    const buffer = createTerminalBuffer(20, 4);
    await write(buffer, `${ESC}[?25l`);
    expect(buffer.snapshot().cursor.visible).toBe(false);
    await write(buffer, `${ESC}[?25h`);
    expect(buffer.snapshot().cursor.visible).toBe(true);
    buffer.dispose();
  });

  it('после прокрутки экрана курсор остаётся в видимой области', async () => {
    const buffer = createTerminalBuffer(20, 3);
    for (let i = 0; i < 6; i++) await write(buffer, `строка ${i}\r\n`);
    // Три строки видно, курсор в нижней — y относительно экрана, не буфера.
    expect(buffer.snapshot().cursor).toEqual({ x: 0, y: 2, visible: true });
    buffer.dispose();
  });
  it('scroll листает скроллбэк и возвращается вниз', async () => {
    const buffer = createTerminalBuffer(20, 3);
    for (let i = 0; i < 8; i++) await write(buffer, `строка ${i}\r\n`);
    expect(plain(buffer)[0]).toBe('строка 6');

    buffer.scroll(-3);
    expect(plain(buffer)[0]).toBe('строка 3');

    buffer.scroll(3);
    expect(plain(buffer)[0]).toBe('строка 6');
    buffer.dispose();
  });
});
