import { open, stat } from 'node:fs/promises';
import { parseLetters, type JournalLetter } from '@parley/core';

/** Окно первого чтения большого журнала: хвост не длиннее этого, а не весь файл. */
const TAIL_WINDOW_BYTES = 256 * 1024;

export interface JournalTailRead {
  /** Новые целые строки с прошлого чтения, в порядке журнала. */
  letters: JournalLetter[];
  /** Сколько байт прочитано с диска этим чтением (недочитанная оборванная строка прочитается ещё раз). */
  bytes: number;
  /** Журнал убрали, усекли или заменили другим файлом: прежняя позиция недействительна, карту надо собрать заново. */
  reset: boolean;
  /** Чтение началось с середины файла (окно большого журнала): о непрерывности с уже известными письмами знает вызывающий. */
  partial: boolean;
}

export interface JournalTail {
  readonly file: string;
  read(): Promise<JournalTailRead>;
  /**
   * Дешёвая проверка «есть что читать»: один `stat` без чтения. `true` — файл вырос или заменён с прошлого чтения, журнал
   * убран, или файл есть, а читать его ещё не начинали. Хвост, у которого нечего читать, молчит.
   */
  changed(): Promise<boolean>;
  /** Забыть позицию: следующее чтение — снова «не читали». */
  forget(): void;
}

/**
 * Хвост журнала писем (карта-журнал, спека 2026-10-16, B3): помнит, где остановился, и читает только новые байты. Модель —
 * `createRolloutTail` из `feed/codex-source.ts`, но позиция не уходит за последний `\n`: оборванная строка (письмо пишется
 * одним `write`, но читатель может застать половину) остаётся на диске и прочитается целой в следующий раз.
 *
 * Первое чтение журнала в этом запуске берёт хвост окном `windowBytes` (первая обрезанная строка отбрасывается), а не весь
 * файл: карту работы хост уже собрал, ему нужны лишь письма после неё. Разбор строк — `parseLetters` из core.
 */
export function createJournalTail(file: string, options: { windowBytes?: number; warn?: (message: string) => void } = {}): JournalTail {
  const windowBytes = options.windowBytes ?? TAIL_WINDOW_BYTES;
  let offset = -1;
  let inode = -1;
  /** Размер файла на момент последнего чтения: оборванная строка держит `offset` позади, и сравнивать с ним нельзя. */
  let lastSize = -1;
  const none = (reset: boolean): JournalTailRead => ({ letters: [], bytes: 0, reset, partial: false });
  return {
    file,
    forget() {
      offset = -1;
    },
    async changed() {
      try {
        const info = await stat(file);
        return offset === -1 || info.ino !== inode || info.size !== lastSize;
      } catch {
        return offset !== -1;
      }
    },
    async read() {
      let handle;
      try {
        handle = await open(file, 'r');
      } catch {
        // Журнала нет: до первого чтения это обычное дело (комнату только создали), после — его убрали.
        const was = offset !== -1;
        offset = -1;
        return none(was);
      }
      try {
        const info = await handle.stat();
        // Сброс — замена файла (другой inode) или усечение. Журнал, переписанный НА МЕСТЕ до большего размера, не виден: хвост
        // продолжил бы с середины строки. Продукт так не пишет — миграция и сжатие журнала переименовывают новый файл поверх
        // старого, — а переписывание на месте потребовало бы перезапуска хоста.
        if (offset !== -1 && (info.ino !== inode || info.size < offset)) {
          offset = -1;
          return none(true);
        }
        inode = info.ino;
        lastSize = info.size;
        const seeded = offset !== -1;
        // Первое чтение: с байта перед окном, чтобы понять, начинается ли с него целая строка.
        const windowStart = Math.max(0, info.size - windowBytes);
        const from = seeded ? offset : Math.max(0, windowStart - 1);
        const partial = !seeded && windowStart > 0;
        if (info.size === from) return { ...none(false), partial };
        const chunk = Buffer.alloc(info.size - from);
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, from);
        let data = chunk.subarray(0, bytesRead);
        let start = from;
        if (partial) {
          const first = data.indexOf(0x0a);
          const skip = first === -1 ? data.length : first + 1;
          data = data.subarray(skip);
          start += skip;
        }
        const end = data.lastIndexOf(0x0a);
        offset = start + end + 1;
        if (end === -1) return { letters: [], bytes: bytesRead, reset: false, partial };
        const letters = parseLetters(data.subarray(0, end + 1).toString('utf8'), file, options.warn);
        return { letters, bytes: bytesRead, reset: false, partial };
      } finally {
        await handle.close();
      }
    },
  };
}
