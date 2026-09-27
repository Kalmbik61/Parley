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
// OSC (заголовок окна, OSC 52 — буфер обмена и т.п.): тело до BEL или ST (ESC \\), без
// терминатора — до конца строки. Иначе OTHER_ESCAPE снял бы только ESC ']', а тело
// осталось бы печатным мусором в тексте pty.send.
const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\|$)/g;
// ECMA-48 CSI: ESC '[' параметры (0x30–0x3F) intermediate (0x20–0x2F) финальный байт (0x40–0x7E).
const CSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;
// SS3 (клавиши F1-F4 в некоторых терминалах): ESC 'O' + один байт.
const SS3 = /\x1bO./g;
// Всё прочее ESC + один байт (Alt+клавиша, сброс терминала и т.п.).
const OTHER_ESCAPE = /\x1b./g;
const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';
/* eslint-enable no-control-regex */

/** Правила вырезания ESC-последовательностей; ими же чистит текст pty.send (спека 8.6, шаг 2). */
export function stripEscapes(data: string): string {
  return data.replace(OSC, '').replace(CSI, '').replace(SS3, '').replace(OTHER_ESCAPE, '');
}

export class DraftTracker {
  private count = 0;
  /**
   * Черновик хоста (спека 8.6): текст, вставленный `pty.send` без Enter. Печать хоста
   * мимо трекера его не видна, поэтому флаг ставят и снимают явно; из ввода человека
   * его снимают только Enter, ⌃C и ⌃U — строка ушла или стёрта целиком.
   */
  private host = false;
  /**
   * Идёт вставка человека: между `ESC[200~` и `ESC[201~` (маркеры могут прийти разными
   * кусками). xterm переводит `\n` вставки в `\r`, и без этого многострочная вставка
   * сняла бы черновик хоста — будильник допечатал бы указатель поверх промпта.
   */
  private inPaste = false;

  /**
   * xterm шлёт вставку одним куском onData, поэтому в куске её границы — первый
   * ESC[200~ и ПОСЛЕДНИЙ ESC[201~: всё между ними — содержимое, даже если в нём самом
   * есть такие же байты (скопированный сырой лог терминала). Иначе содержимое могло бы
   * «закрыть» вставку раньше времени, и его \r или ⌃C сняли бы черновик хоста.
   * Нет закрывающего маркера — вставка открыта до ESC[201~ следующих кусков.
   */
  input(data: string): void {
    let rest = data;
    if (!this.inPaste) {
      const start = rest.indexOf(PASTE_START);
      if (start < 0) {
        this.inputPlain(rest);
        return;
      }
      this.inputPlain(rest.slice(0, start));
      rest = rest.slice(start + PASTE_START.length);
      this.inPaste = true;
    }
    const end = rest.lastIndexOf(PASTE_END);
    if (end < 0) {
      this.inputPasted(rest);
      return;
    }
    this.inputPasted(rest.slice(0, end));
    this.inPaste = false;
    // После конца вставки в том же куске может начаться новая — её ищет рекурсия.
    const tail = rest.slice(end + PASTE_END.length);
    if (tail.length > 0) this.input(tail);
  }

  /** Содержимое вставки — только текст: переводы строк и ⌃C/⌃U в нём не клавиши. */
  private inputPasted(data: string): void {
    for (const char of Array.from(stripEscapes(data))) {
      const code = char.codePointAt(0) ?? 0;
      if (char === '\r' || char === '\n' || code >= 0x20) this.count += 1;
    }
  }

  private inputPlain(data: string): void {
    for (const char of Array.from(stripEscapes(data))) {
      const code = char.codePointAt(0) ?? 0;

      if (char === '\r' || char === '\n' || code === 0x03 || code === 0x15) {
        // Enter, Ctrl+C, Ctrl+U — строка ушла или стёрта целиком.
        this.count = 0;
        this.host = false;
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

  /** Только черновик человека; черновик хоста — `hasHostDraft`. */
  get hasDraft(): boolean {
    return this.count > 0;
  }

  /** Вставка хоста без Enter осталась в поле ввода. */
  markHost(): void {
    this.host = true;
  }

  /** Enter самого pty.send. */
  clearHost(): void {
    this.host = false;
  }

  get hasHostDraft(): boolean {
    return this.host;
  }

  reset(): void {
    this.count = 0;
  }
}
