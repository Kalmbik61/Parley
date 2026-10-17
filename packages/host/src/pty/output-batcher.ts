/**
 * Склейка вывода PTY в пачки: агент может печатать по одному байту на кадр
 * рендера, и без склейки хост слал бы клиенту сотни крошечных сообщений в
 * секунду вместо одного (спека 4.3, план, кусок 1.6, число — сквозные
 * ограничения плана: 16 мс).
 *
 * У пачки есть потолок: залп вывода (cat большого файла, дамп лога) без него
 * превратился бы в одну гигантскую строку — одно тяжёлое JSON.stringify на
 * весь залп и риск упереться в предел кадра протокола (8 МиБ). Поэтому как
 * только накопилось maxChars символов, хост сбрасывает их сразу, не дожидаясь
 * таймера, а остаток меньше потолка ждёт обычного такта.
 */
export const OUTPUT_BATCH_MAX_CHARS = 256 * 1024;

export class OutputBatcher {
  private buffer = '';
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly flush: (data: string) => void,
    private readonly intervalMs = 16,
    private readonly maxChars = OUTPUT_BATCH_MAX_CHARS,
  ) {}

  push(data: string): void {
    this.buffer += data;
    while (this.buffer.length >= this.maxChars) {
      const chunk = this.buffer.slice(0, this.maxChars);
      this.buffer = this.buffer.slice(this.maxChars);
      this.flush(chunk);
    }
    // Остатка нет — ждать нечего, таймер не нужен (уже стоящий сбросит пустое).
    if (this.buffer.length === 0) return;
    // Таймер уже тикает — новый кусок просто дождётся его же отправки.
    if (this.timer !== undefined) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      const pending = this.buffer;
      this.buffer = '';
      if (pending.length > 0) this.flush(pending);
    }, this.intervalMs);
  }

  dispose(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.buffer = '';
  }
}
