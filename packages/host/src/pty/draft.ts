/**
 * Флаг черновика: человек набрал текст в терминале, но не отправил его агенту.
 * Доставка писем (раздел 7.3 спеки) проверяет этот флаг, чтобы не прервать
 * набор письмом посреди строки — план, кусок 1.6, таблица «Правила черновика».
 *
 * Экранные последовательности (курсор, вставка мышью, ответы терминала на
 * запросы курсора и т.п.) вырезаются целиком и на счётчик не влияют — кроме
 * маркеров вставки `ESC[200~`/`ESC[201~`: сами маркеры вырезаются тем же
 * правилом (это обычный CSI), а текст внутри вставки остаётся и считается как
 * любой печатный ввод.
 */

// ESC (0x1b) в регулярках ниже — не опечатка и не забытый ввод: это ровно тот
// управляющий байт, который вырезают правила черновика.
/* eslint-disable no-control-regex */
// ECMA-48 CSI: ESC '[' параметры (0x30–0x3F) intermediate (0x20–0x2F) финальный байт (0x40–0x7E).
const CSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;
// SS3 (клавиши F1-F4 в некоторых терминалах): ESC 'O' + один байт.
const SS3 = /\x1bO./g;
// Всё прочее ESC + один байт (Alt+клавиша, сброс терминала и т.п.).
const OTHER_ESCAPE = /\x1b./g;
/* eslint-enable no-control-regex */

function stripEscapes(data: string): string {
  return data.replace(CSI, '').replace(SS3, '').replace(OTHER_ESCAPE, '');
}

export class DraftTracker {
  private count = 0;

  input(data: string): void {
    for (const char of Array.from(stripEscapes(data))) {
      const code = char.codePointAt(0) ?? 0;

      if (char === '\r' || char === '\n' || code === 0x03 || code === 0x15) {
        // Enter, Ctrl+C, Ctrl+U — строка ушла или стёрта целиком.
        this.count = 0;
      } else if (code === 0x7f || code === 0x08) {
        // Backspace — не ниже нуля: лишние удаления пустой строки не считаются долгом.
        this.count = Math.max(0, this.count - 1);
      } else if (code < 0x20) {
        // Прочие управляющие знаки (Tab и т.п.) — вне таблицы правил, игнорируются.
      } else {
        // Печатная кодовая точка — включая символы вставки и эмодзи (surrogate pair).
        this.count += 1;
      }
    }
  }

  get hasDraft(): boolean {
    return this.count > 0;
  }

  reset(): void {
    this.count = 0;
  }
}
