/**
 * Экран PTY на стороне хоста: `@xterm/headless` разбирает поток гостя (тот же
 * VT-движок, что в `packages/tui/src/pty/terminal-buffer.ts`), а
 * `@xterm/addon-serialize` отдаёт снимок для `pty.attach` — переподключённый
 * клиент видит экран таким же, каким его оставил предыдущий (план, 1.6;
 * спека 4.1).
 *
 * Хосту не нужен разбор по ячейкам (`IBufferCell`, цвета, курсор) — окно само
 * дорисовывает снимок своим терминалом (xterm.js), хосту достаточно строки с
 * управляющими последовательностями.
 */

import xterm from '@xterm/headless';
import type { Terminal } from '@xterm/headless';
import { SerializeAddon } from '@xterm/addon-serialize';

export interface Screen {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  snapshot(): string;
  /** Агент включил bracketed paste (`ESC[?2004h`): многострочный pty.send идёт вставкой (спека 8.6). */
  bracketedPaste(): boolean;
  /**
   * Последние `rows` строк видимой области активного экрана чистым текстом (без цветов и управляющих
   * последовательностей, концевые пробелы срезаны); без `rows` — вся видимая область. Хост по ним
   * читает подвал агента (план 2026-10-01, решение 4).
   */
  text(rows?: number): string[];
  dispose(): void;
}

/**
 * Прокрутка экрана хоста — 1 000 строк. Экран каждой сессии живёт в хосте в памяти, а снимок при
 * `pty.attach` сериализует весь scrollback: при 15–30 сессиях по 5 000 строк это заметные память и
 * время снимка. Живой вывод после attach окно держит у себя, так что глубокая история хосту не
 * нужна (ориентир — Orca держит 1 000 строк в демоне). Прокрутка xterm в окне — отдельная.
 */
const DEFAULT_SCROLLBACK = 1000;

export function createScreen(cols: number, rows: number, scrollback = DEFAULT_SCROLLBACK): Screen {
  const terminal: Terminal = new xterm.Terminal({ cols, rows, scrollback, allowProposedApi: true });
  const serializer = new SerializeAddon();
  // `loadAddon` типизирован под `@xterm/headless`, а `SerializeAddon` — под
  // `@xterm/xterm`: оба пакета описывают один и тот же рантайм xterm.js, но
  // раздельными `.d.ts`, отсюда приведение типа ниже (структурно это тот же
  // объект).
  terminal.loadAddon(serializer as unknown as import('@xterm/headless').ITerminalAddon);

  return {
    write(data) {
      terminal.write(data);
    },

    resize(nextCols, nextRows) {
      terminal.resize(nextCols, nextRows);
    },

    snapshot() {
      // Явный `scrollback` в опциях: без него сериализуется только видимая
      // область, а переподключённый клиент должен получить всю прокрутку,
      // ограниченную буфером терминала (тест на потоке в десятки мегабайт).
      return serializer.serialize({ scrollback });
    },

    bracketedPaste() {
      return terminal.modes.bracketedPasteMode;
    },

    text(rows) {
      const buffer = terminal.buffer.active;
      const total = terminal.rows;
      const count = rows === undefined ? total : Math.max(0, Math.min(rows, total));
      const lines: string[] = [];
      for (let i = total - count; i < total; i += 1) {
        // Видимая область начинается с `baseY`: выше неё — прокрутка.
        const line = buffer.getLine(buffer.baseY + i);
        // `translateToString(true)` срезает только пустые ячейки; напечатанные пробелы в конце строки
        // остаются — их срезаем сами.
        lines.push(line === undefined ? '' : line.translateToString(true).trimEnd());
      }
      return lines;
    },

    dispose() {
      terminal.dispose();
    },
  };
}
