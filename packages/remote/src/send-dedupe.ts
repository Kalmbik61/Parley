/**
 * Защита `pty.send` от дубля (спека 4.2): ответ хоста запоминается на устройство по `clientMsgId` на 10 минут.
 * Повтор с тем же ключом — после `lost`, с переподключением или без — получает прежний ответ, хост второй раз не
 * зовётся. Повтор, пришедший, пока первый вызов ещё идёт, ждёт тот же вызов.
 *
 * Запоминаются результат и неоднозначные ошибки (`AMBIGUOUS_CODES`): после `timeout`, обрыва связи с хостом во время
 * вызова или внутренней ошибки неизвестно, дошло ли сообщение, и второй вызов мог бы его задвоить. Точный отказ хоста
 * (`not_found`, `bad_request`…) значит «не доставлено»: ключ освобождается, повтор идёт к хосту (критик m2). Отказы
 * моста до вызова (правила, лимиты, хост не `online`) не запоминаются вовсе.
 *
 * Ключ связан с отпечатком сообщения (`ref`, текст, `submit`): тот же ключ с другим сообщением — не повтор (критик m1).
 *
 * Память ограничена: записи старше 10 минут вытесняются, на устройство не больше `maxPerDevice` (старые первыми),
 * кэш устройства переживает его переподключение и уходит целиком, когда последняя запись устаревает.
 */
export type SendOutcome = { result: unknown } | { error: { code: string; message: string; data?: unknown } };

/** Ошибки, после которых доставка неизвестна. */
export const AMBIGUOUS_CODES: ReadonlySet<string> = new Set(['timeout', 'host_offline', 'internal']);

export interface SendDedupe {
  /**
   * Прежний вызов для `(deviceId, clientMsgId)` или `null`, если ключа нет. Ждущий вызов возвращается как Promise:
   * повтор присоединяется к нему.
   */
  lookup(deviceId: string, clientMsgId: string): { fingerprint: string; outcome: Promise<SendOutcome> } | null;
  /** Запомнить вызов хоста; результат и неоднозначная ошибка хранятся `ttlMs` с момента завершения. */
  remember(deviceId: string, clientMsgId: string, fingerprint: string, outcome: Promise<SendOutcome>): void;
  /** Только тесты: записей у устройства. */
  size(deviceId: string): number;
}

interface Slot {
  fingerprint: string;
  outcome: Promise<SendOutcome>;
  /** Момент завершения вызова; `null` — ещё идёт. */
  doneAt: number | null;
}

export const SEND_DEDUPE_TTL_MS = 10 * 60_000;
/** 30 изменяющих вызовов в минуту × 10 минут = 300: при честном лимите вытеснение по размеру не наступает. */
export const SEND_DEDUPE_MAX_PER_DEVICE = 300;

export function createSendDedupe(options: { now?: () => number; ttlMs?: number; maxPerDevice?: number } = {}): SendDedupe {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? SEND_DEDUPE_TTL_MS;
  const maxPerDevice = options.maxPerDevice ?? SEND_DEDUPE_MAX_PER_DEVICE;
  /** Map сохраняет порядок вставки: первыми идут самые старые ключи. */
  const devices = new Map<string, Map<string, Slot>>();

  function prune(deviceId: string): Map<string, Slot> | undefined {
    const slots = devices.get(deviceId);
    if (!slots) return undefined;
    const t = now();
    for (const [key, slot] of slots) {
      if (slot.doneAt !== null && t - slot.doneAt >= ttlMs) slots.delete(key);
    }
    if (slots.size === 0) {
      devices.delete(deviceId);
      return undefined;
    }
    return slots;
  }

  return {
    lookup(deviceId, clientMsgId) {
      return prune(deviceId)?.get(clientMsgId) ?? null;
    },
    remember(deviceId, clientMsgId, fingerprint, outcome) {
      // Чужие устройства тоже чистятся: отключённое устройство не держит память дольше TTL.
      for (const id of [...devices.keys()]) prune(id);
      let slots = devices.get(deviceId);
      if (!slots) {
        slots = new Map();
        devices.set(deviceId, slots);
      }
      const slot: Slot = { fingerprint, outcome, doneAt: null };
      slots.delete(clientMsgId);
      slots.set(clientMsgId, slot);
      while (slots.size > maxPerDevice) {
        const oldest = slots.keys().next().value as string;
        slots.delete(oldest);
      }
      // `outcome` не отвергается: исход вызова — это и результат, и ошибка.
      const own = slots;
      void outcome.then((done) => {
        slot.doneAt = now();
        // Точный отказ: не доставлено — ключ свободен. Повторы, ждавшие этот вызов, уже получили тот же отказ.
        if ('error' in done && !AMBIGUOUS_CODES.has(done.error.code) && own.get(clientMsgId) === slot) {
          own.delete(clientMsgId);
          if (own.size === 0 && devices.get(deviceId) === own) devices.delete(deviceId);
        }
      });
    },
    size(deviceId) {
      return devices.get(deviceId)?.size ?? 0;
    },
  };
}
