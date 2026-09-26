/**
 * Склейка вывода PTY в пачки: агент может печатать по одному байту на кадр
 * рендера, и без склейки хост слал бы клиенту сотни крошечных сообщений в
 * секунду вместо одного (спека 4.3, план, кусок 1.6, число — сквозные
 * ограничения плана: 16 мс).
 */
export class OutputBatcher {
  private buffer = '';
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly flush: (data: string) => void,
    private readonly intervalMs = 16,
  ) {}

  push(data: string): void {
    this.buffer += data;
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
