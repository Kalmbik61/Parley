import { describe, expect, it } from 'vitest';
import { createRpcRing, RPC_RING_CAPACITY, type RpcRecord } from './rpc-ring.js';

function record(n: number): RpcRecord {
  return { t: `2026-10-16T10:00:${String(n).padStart(2, '0')}.000Z`, method: `m${n}`, ms: n, ok: true };
}

describe('createRpcRing', () => {
  it('ёмкость по умолчанию — 1000 записей', () => {
    expect(RPC_RING_CAPACITY).toBe(1000);
    const ring = createRpcRing();
    for (let i = 0; i < RPC_RING_CAPACITY + 5; i += 1) ring.push(record(i));
    expect(ring.entries()).toHaveLength(RPC_RING_CAPACITY);
  });

  it('пока кольцо не заполнено, записи идут по порядку добавления', () => {
    const ring = createRpcRing(3);
    expect(ring.entries()).toEqual([]);
    ring.push(record(1));
    ring.push(record(2));
    expect(ring.entries()).toEqual([record(1), record(2)]);
  });

  it('хранит последние N: старые вытесняются, порядок — от старой к новой', () => {
    const ring = createRpcRing(3);
    for (let i = 1; i <= 5; i += 1) ring.push(record(i));
    expect(ring.entries()).toEqual([record(3), record(4), record(5)]);
    ring.push(record(6));
    expect(ring.entries()).toEqual([record(4), record(5), record(6)]);
  });

  it('entries отдаёт копию: правка результата кольцо не меняет', () => {
    const ring = createRpcRing(2);
    ring.push(record(1));
    ring.entries().pop();
    expect(ring.entries()).toEqual([record(1)]);
  });
});
