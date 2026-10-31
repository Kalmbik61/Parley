// Склейка двух WebSocket в трубу и общий пульс (ping/простой).
import { WebSocket } from 'ws';

export const MAX_BUFFERED = 4 * 1024 * 1024;
/** Получатель не успевает: чтение у отправителя ставится на паузу (ревью A4, m7)… */
export const PAUSE_BUFFERED = 256 * 1024;
/** …и снимается, когда очередь получателя опустилась ниже. */
export const RESUME_BUFFERED = 64 * 1024;

export interface Timing {
  /** Ожидание `accept` от моста после `incoming`. */
  acceptWaitMs: number;
  /** Первый кадр на новом сокете (hello/connect/accept). */
  firstFrameMs: number;
  /** Период WS ping. */
  pingMs: number;
  /** Сокет без кадров и без pong дольше этого срока закрывается. */
  idleMs: number;
  /** Предел жизни трубы. */
  pipeMaxMs: number;
}

export const DEFAULT_TIMING: Timing = {
  acceptWaitMs: 10_000,
  firstFrameMs: 5_000,
  pingMs: 25_000,
  idleMs: 60_000,
  pipeMaxMs: 2 * 3_600_000,
};

/** Один таймер на все сокеты: ping раз в `pingMs`, закрытие тех, кто молчит дольше `idleMs`. */
export class Heartbeat {
  private readonly last = new Map<WebSocket, number>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly t: Pick<Timing, 'pingMs' | 'idleMs'>,
    private readonly now: () => number = Date.now,
  ) {}

  size(): number {
    return this.last.size;
  }

  add(ws: WebSocket): void {
    this.last.set(ws, this.now());
    const seen = () => this.last.has(ws) && this.last.set(ws, this.now());
    ws.on('message', seen);
    ws.on('pong', seen);
    ws.on('close', () => this.last.delete(ws));
  }

  start(): void {
    this.timer = setInterval(() => this.tick(), this.t.pingMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private tick(): void {
    const t = this.now();
    for (const [ws, at] of this.last) {
      if (t - at > this.t.idleMs) ws.terminate();
      else if (ws.readyState === WebSocket.OPEN) ws.ping();
    }
  }
}

/** Закрывает сокет и, если собеседник молчит, обрывает его через 2 с. */
export function closeSoft(ws: WebSocket, code = 1000): void {
  if (ws.readyState === WebSocket.CLOSED) return;
  try {
    ws.close(code);
  } catch {
    ws.terminate();
    return;
  }
  const kill = setTimeout(() => ws.terminate(), 2000);
  kill.unref();
  ws.once('close', () => clearTimeout(kill));
}

/**
 * Склеивает сокеты: бинарные кадры идут в обе стороны без изменений; закрытие одной стороны закрывает другую.
 * Текстовый кадр в трубе — нарушение протокола, труба закрывается.
 */
export function splice(a: WebSocket, b: WebSocket, opts: { maxLifeMs: number; onClose: () => void }): void {
  let closed = false;
  const shutdown = (code = 1000): void => {
    if (closed) return;
    closed = true;
    clearTimeout(life);
    closeSoft(a, code);
    closeSoft(b, code);
    opts.onClose();
  };
  const life = setTimeout(() => shutdown(1000), opts.maxLifeMs);
  life.unref();
  const forward = (from: WebSocket, to: WebSocket): void => {
    let paused = false;
    from.on('message', (data, isBinary) => {
      if (!isBinary) return shutdown(1003);
      if (to.readyState !== WebSocket.OPEN) return;
      // Жёсткий потолок остаётся на случай кадров, пришедших уже после паузы.
      if (to.bufferedAmount > MAX_BUFFERED) return shutdown(1013);
      to.send(data, { binary: true }, () => {
        if (paused && !closed && to.bufferedAmount < RESUME_BUFFERED) {
          paused = false;
          from.resume();
        }
      });
      if (!paused && to.bufferedAmount > PAUSE_BUFFERED) {
        paused = true;
        from.pause();
      }
    });
    from.on('close', () => shutdown());
    from.on('error', () => shutdown());
  };
  forward(a, b);
  forward(b, a);
}
