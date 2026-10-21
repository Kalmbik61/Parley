/**
 * Очередь отправки окна (спека 2026-10-16, 4.1): одна попытка за раз, порядок постановки, остановка на отказе,
 * Retry и ×, повтор того же элемента, ключи независимы.
 */

import { describe, expect, it } from 'vitest';
import { createOutbox, type AttemptResult, type OutboxItem } from './outbox.js';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** Очередь, у которой каждая попытка ждёт ручного исхода: `started[i]` — i-я начатая попытка. */
function manual(): {
  outbox: ReturnType<typeof createOutbox<string>>;
  started: Array<{ id: string; text: string; done: Deferred<AttemptResult> }>;
} {
  const started: Array<{ id: string; text: string; done: Deferred<AttemptResult> }> = [];
  const outbox = createOutbox<string>((_key, item: OutboxItem<string>) => {
    const done = deferred<AttemptResult>();
    started.push({ id: item.id, text: item.payload, done });
    return done.promise;
  });
  return { outbox, started };
}

describe('outbox — очередь отправки', () => {
  it('попытка начинается синхронно в enqueue, если очередь свободна', () => {
    const { outbox, started } = manual();
    outbox.enqueue('k', 'a');
    expect(started.map((entry) => entry.text)).toEqual(['a']);
    expect(outbox.store.getState().flying.k).toBe(started[0]?.id);
  });

  it('одна попытка за раз и строго по порядку постановки — при любом числе элементов', async () => {
    for (let count = 1; count <= 12; count += 1) {
      const { outbox, started } = manual();
      const texts = Array.from({ length: count }, (_, index) => `m${index}`);
      for (const text of texts) outbox.enqueue('k', text);
      for (let index = 0; index < count; index += 1) {
        expect(started).toHaveLength(index + 1);
        started[index]?.done.resolve({ kind: 'sent' });
        await flush();
      }
      expect(started.map((entry) => entry.text)).toEqual(texts);
      expect(outbox.items('k')).toEqual([]);
      expect(outbox.store.getState().flying.k).toBeUndefined();
    }
  });

  it('failed останавливает очередь, новые встают за ним; Retry продолжает с него', async () => {
    const { outbox, started } = manual();
    const a = outbox.enqueue('k', 'a');
    started[0]?.done.resolve({ kind: 'failed' });
    await flush();
    expect(outbox.items('k').map((item) => item.status)).toEqual(['failed']);
    outbox.enqueue('k', 'b');
    await flush();
    expect(started).toHaveLength(1);
    expect(outbox.items('k').map((item) => [item.payload, item.status])).toEqual([
      ['a', 'failed'],
      ['b', 'pending'],
    ]);
    outbox.retry('k', a);
    expect(started.map((entry) => entry.text)).toEqual(['a', 'a']);
    started[1]?.done.resolve({ kind: 'sent' });
    await flush();
    expect(started.map((entry) => entry.text)).toEqual(['a', 'a', 'b']);
  });

  it('× убирает failed, и очередь идёт дальше; элемент в полёте × не убирает', async () => {
    const { outbox, started } = manual();
    const a = outbox.enqueue('k', 'a');
    outbox.enqueue('k', 'b');
    outbox.remove('k', a);
    expect(outbox.items('k')).toHaveLength(2);
    started[0]?.done.resolve({ kind: 'failed' });
    await flush();
    outbox.remove('k', a);
    expect(outbox.items('k').map((item) => item.payload)).toEqual(['b']);
    expect(started.map((entry) => entry.text)).toEqual(['a', 'b']);
  });

  it('Retry у не failed — ничего', async () => {
    const { outbox, started } = manual();
    const a = outbox.enqueue('k', 'a');
    outbox.retry('k', a);
    expect(started).toHaveLength(1);
  });

  it('retry с patch сливает его в payload failed-элемента; без patch payload прежний; у не failed patch игнорируется', async () => {
    interface Letter {
      text: string;
      at: number;
    }
    const started: Array<{ payload: Letter; done: Deferred<AttemptResult> }> = [];
    const outbox = createOutbox<Letter>((_key, item) => {
      const done = deferred<AttemptResult>();
      started.push({ payload: item.payload, done });
      return done.promise;
    });
    const id = outbox.enqueue('k', { text: 'a', at: 1 });
    started[0]?.done.resolve({ kind: 'failed' });
    await flush();

    outbox.retry('k', id);
    expect(started[1]?.payload).toEqual({ text: 'a', at: 1 });
    started[1]?.done.resolve({ kind: 'failed' });
    await flush();

    outbox.retry('k', id, { at: 5 });
    expect(started[2]?.payload).toEqual({ text: 'a', at: 5 });
    expect(outbox.items('k')[0]?.payload).toEqual({ text: 'a', at: 5 });

    // Элемент уже pending: patch не применяется.
    outbox.retry('k', id, { at: 9 });
    expect(started).toHaveLength(3);
    expect(outbox.items('k')[0]?.payload).toEqual({ text: 'a', at: 5 });
  });

  it('keepAs: элемент остаётся sent с sentAs и не держит очередь; remove убирает его', async () => {
    const { outbox, started } = manual();
    const a = outbox.enqueue('k', 'a');
    outbox.enqueue('k', 'b');
    started[0]?.done.resolve({ kind: 'sent', keepAs: 'm-1' });
    await flush();
    expect(outbox.items('k')[0]).toMatchObject({ id: a, status: 'sent', sentAs: 'm-1' });
    expect(started.map((entry) => entry.text)).toEqual(['a', 'b']);
    outbox.remove('k', a);
    expect(outbox.items('k').map((item) => item.payload)).toEqual(['b']);
  });

  it('retry: ждёт wait и пробует тот же элемент, следующий не начинается', async () => {
    const { outbox, started } = manual();
    outbox.enqueue('k', 'a');
    outbox.enqueue('k', 'b');
    const wait = deferred<void>();
    started[0]?.done.resolve({ kind: 'retry', wait: () => wait.promise });
    await flush();
    expect(started).toHaveLength(1);
    expect(outbox.store.getState().flying.k).toBe(outbox.items('k')[0]?.id);
    wait.resolve();
    await flush();
    expect(started.map((entry) => entry.text)).toEqual(['a', 'a']);
  });

  it('wait отклонился — повтор всё равно идёт', async () => {
    const { outbox, started } = manual();
    outbox.enqueue('k', 'a');
    started[0]?.done.resolve({ kind: 'retry', wait: () => Promise.reject(new Error('stop')) });
    await flush();
    await flush();
    expect(started.map((entry) => entry.text)).toEqual(['a', 'a']);
  });

  it('попытка бросила или отклонилась — failed', async () => {
    const throwing = createOutbox<string>(() => {
      throw new Error('boom');
    });
    throwing.enqueue('k', 'a');
    await flush();
    expect(throwing.items('k')[0]?.status).toBe('failed');
    const rejecting = createOutbox<string>(() => Promise.reject(new Error('nope')));
    rejecting.enqueue('k', 'a');
    await flush();
    expect(rejecting.items('k')[0]?.status).toBe('failed');
  });

  it('ключи независимы: отказ в одном не держит другой', async () => {
    const { outbox, started } = manual();
    outbox.enqueue('one', 'a');
    outbox.enqueue('two', 'b');
    expect(started.map((entry) => entry.text)).toEqual(['a', 'b']);
    started[0]?.done.resolve({ kind: 'failed' });
    await flush();
    outbox.enqueue('two', 'c');
    started[1]?.done.resolve({ kind: 'sent' });
    await flush();
    expect(started.map((entry) => entry.text)).toEqual(['a', 'b', 'c']);
  });

  it('resetForTests гасит исход попытки, начатой до сброса', async () => {
    const { outbox, started } = manual();
    outbox.enqueue('k', 'a');
    outbox.resetForTests();
    started[0]?.done.resolve({ kind: 'failed' });
    await flush();
    expect(outbox.items('k')).toEqual([]);
    expect(outbox.store.getState().flying).toEqual({});
  });

  it('ready=false держит голову: попытка не начинается; kick после открытия затвора отправляет', async () => {
    let open = false;
    const started: string[] = [];
    const outbox = createOutbox<string>(
      (_key, item) => {
        started.push(item.payload);
        return Promise.resolve({ kind: 'sent' });
      },
      { ready: () => open },
    );
    outbox.enqueue('k', 'a');
    outbox.enqueue('k', 'b');
    expect(started).toEqual([]);
    expect(outbox.store.getState().flying.k).toBeUndefined();
    outbox.kick('k');
    expect(started).toEqual([]);
    open = true;
    outbox.kick('k');
    await flush();
    expect(started).toEqual(['a', 'b']);
  });

  it('kick занятой или пустой очереди — ничего', () => {
    const { outbox, started } = manual();
    outbox.kick('k');
    outbox.enqueue('k', 'a');
    outbox.kick('k');
    expect(started).toHaveLength(1);
  });

  it('ждущий pending убирается, элемент в полёте — нет', async () => {
    const { outbox, started } = manual();
    const a = outbox.enqueue('k', 'a');
    const b = outbox.enqueue('k', 'b');
    outbox.remove('k', a);
    expect(outbox.items('k')).toHaveLength(2);
    outbox.remove('k', b);
    expect(outbox.items('k').map((item) => item.payload)).toEqual(['a']);
    started[0]?.done.resolve({ kind: 'sent' });
    await flush();
    expect(started).toHaveLength(1);
  });

  it('prioritize ставит ждущий элемент впереди ранних, сливает patch и пускает его, если очередь свободна', async () => {
    interface Letter {
      text: string;
      now?: boolean;
    }
    const started: Array<{ payload: Letter; done: Deferred<AttemptResult> }> = [];
    let open = false;
    const outbox = createOutbox<Letter>(
      (_key, item) => {
        const done = deferred<AttemptResult>();
        started.push({ payload: item.payload, done });
        return done.promise;
      },
      { ready: (_key, item) => open || item.payload.now === true },
    );
    outbox.enqueue('k', { text: 'a' });
    outbox.enqueue('k', { text: 'b' });
    const c = outbox.enqueue('k', { text: 'c' });
    expect(started).toHaveLength(0);
    outbox.prioritize('k', c, { now: true });
    expect(started.map((entry) => entry.payload)).toEqual([{ text: 'c', now: true }]);
    expect(outbox.items('k').map((item) => item.payload.text)).toEqual(['c', 'a', 'b']);
    // Элемент в полёте и неизвестный id не трогаются.
    outbox.prioritize('k', c, { text: 'x' });
    outbox.prioritize('k', 'nope');
    expect(outbox.items('k')[0]?.payload.text).toBe('c');
    open = true;
    started[0]?.done.resolve({ kind: 'sent' });
    await flush();
    expect(started.map((entry) => entry.payload.text)).toEqual(['c', 'a']);
  });

  it('prioritize при элементе в полёте ставит элемент сразу за ним', () => {
    const { outbox } = manual();
    outbox.enqueue('k', 'a');
    outbox.enqueue('k', 'b');
    const c = outbox.enqueue('k', 'c');
    outbox.prioritize('k', c);
    expect(outbox.items('k').map((item) => item.payload)).toEqual(['a', 'c', 'b']);
  });

  it('без ready поведение прежнее: попытка начинается в enqueue', () => {
    const { outbox, started } = manual();
    outbox.enqueue('k', 'a');
    expect(started).toHaveLength(1);
  });
});
