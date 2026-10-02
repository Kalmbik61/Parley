import { describe, expect, it } from 'vitest';
import { createScreen } from './screen.js';

/**
 * `@xterm/headless` разбирает `write()` асинхронно (та же асинхронность, что и
 * в `packages/tui/src/pty/terminal-buffer.ts`, где ради этого есть колбэк
 * `done`) — у `Screen` его нет по интерфейсу плана, поэтому тесты ждут условие
 * вместо фиксированной паузы (тот же приём, что в `activity-service.test.ts`).
 */
async function waitFor(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('не дождались условия');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('createScreen', () => {
  it('снимок содержит записанный текст', async () => {
    const screen = createScreen(80, 24);
    screen.write('привет\r\n');
    await waitFor(() => screen.snapshot().includes('привет'));
    screen.dispose();
  });

  it('resize не бросает, новый текст остаётся в снимке', async () => {
    const screen = createScreen(80, 24);
    screen.resize(20, 5);
    screen.write('короткая строка\r\n');
    await waitFor(() => screen.snapshot().includes('короткая строка'));
    screen.dispose();
  });

  it('прокрутка ограничена scrollback: старые строки снимка не переживают лимит', async () => {
    const scrollback = 5000;
    const rows = 24;
    const screen = createScreen(80, rows, scrollback);
    const total = 6000;
    const last = `L${String(total - 1).padStart(5, '0')}`;

    let data = '';
    for (let i = 0; i < total; i++) data += `L${String(i).padStart(5, '0')}\r\n`;
    screen.write(data);

    await waitFor(() => screen.snapshot().includes(last));

    const snapshot = screen.snapshot();
    // Первая строка вытеснена лимитом прокрутки — доехать до снимка не могла.
    expect(snapshot).not.toContain('L00000');
    expect(snapshot).toContain(last);
    // Строк в снимке заметно меньше, чем было написано — держим не 6000, а
    // scrollback плюс видимая область (с небольшим запасом на округления).
    const matches = snapshot.match(/L\d{5}/g) ?? [];
    expect(matches.length).toBeLessThanOrEqual(scrollback + rows + 5);
    screen.dispose();
  });

  it('bracketedPaste(): ESC[?2004h включает режим вставки, ESC[?2004l выключает (кусок 5.1)', async () => {
    const screen = createScreen(80, 24);
    expect(screen.bracketedPaste()).toBe(false);
    screen.write('\x1b[?2004h');
    await waitFor(() => screen.bracketedPaste());
    screen.write('\x1b[?2004l');
    await waitFor(() => !screen.bracketedPaste());
    screen.dispose();
  });
});

describe('Screen.text', () => {
  it('цветовые последовательности в текст не попадают, концевые пробелы срезаны', async () => {
    const screen = createScreen(40, 5);
    screen.write('\x1b[31mкрасная\x1b[0m строка   \r\n\x1b[1;32mзелёная\x1b[0m');
    await waitFor(() => screen.text().some((line) => line.includes('зелёная')));
    expect(screen.text()).toEqual(['красная строка', 'зелёная', '', '', '']);
    screen.dispose();
  });

  it('rows — последние строки видимой области', async () => {
    const screen = createScreen(40, 5);
    screen.write('a\r\nb\r\nc\r\nd\r\ne');
    await waitFor(() => screen.text().includes('e'));
    expect(screen.text(2)).toEqual(['d', 'e']);
    expect(screen.text(0)).toEqual([]);
    expect(screen.text(99)).toHaveLength(5);
    screen.dispose();
  });

  it('прокрутка: берётся видимая область, а не начало буфера', async () => {
    const screen = createScreen(40, 3, 100);
    screen.write('1\r\n2\r\n3\r\n4\r\n5');
    await waitFor(() => screen.text().includes('5'));
    expect(screen.text()).toEqual(['3', '4', '5']);
    expect(screen.text(1)).toEqual(['5']);
    screen.dispose();
  });
});
