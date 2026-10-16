/** Сколько последних RPC-вызовов окна к хосту хранит кольцо (попадает только в архив диагностики). */
export const RPC_RING_CAPACITY = 1000;

/**
 * Запись об одном вызове окна к хосту. Только метод, время и идентификатор сессии:
 * ни параметров, ни результата, ни текстов (приватность архива, спека A7).
 */
export interface RpcRecord {
  /** Момент записи вызова в сокет, ISO. */
  t: string;
  method: string;
  /** От записи в сокет до ответа или отказа, мс. */
  ms: number;
  ok: boolean;
  /** Код `HostError` или начало сообщения ошибки — только при `ok: false`. */
  error?: string;
  /** `sessionId` из `params.ref`, если он есть. */
  ref?: string;
}

/** Кольцо фиксированной ёмкости: новая запись вытесняет самую старую. */
export function createRpcRing(capacity = RPC_RING_CAPACITY): {
  push(record: RpcRecord): void;
  entries(): RpcRecord[];
} {
  const buffer: RpcRecord[] = [];
  /** Куда пишется следующая запись; у заполненного кольца это же самая старая. */
  let next = 0;
  return {
    push(record) {
      if (buffer.length < capacity) buffer.push(record);
      else buffer[next] = record;
      next = (next + 1) % capacity;
    },
    entries() {
      if (buffer.length < capacity) return buffer.slice();
      return [...buffer.slice(next), ...buffer.slice(0, next)];
    },
  };
}
