import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readJsonlTail, type TailHandler, type TimelineReader } from './jsonl-tail.js';

afterEach(() => {
  vi.restoreAllMocks();
});

function readerOf(chunks: Buffer[]): TimelineReader {
  const size = chunks.reduce((total, chunk) => total + chunk.length, 0);
  return { stat: async () => ({ size, ino: 1 }), open: () => Readable.from(chunks) };
}

function collect(): { handler: TailHandler; records: unknown[] } {
  const records: unknown[] = [];
  return { records, handler: { reset: () => undefined, record: (record) => void records.push(record) } };
}

describe('readJsonlTail: поиск перевода строки', () => {
  it('строка в 64 КиБ кусками по 1 КиБ: каждый байт просмотрен один раз', async () => {
    const line = Buffer.from(JSON.stringify({ text: 'x'.repeat(64 * 1024 - 20) }));
    const chunks: Buffer[] = [];
    for (let at = 0; at < line.length; at += 1024) chunks.push(line.subarray(at, at + 1024));
    chunks.push(Buffer.from('\n'));
    let scanned = 0;
    const original = Buffer.prototype.indexOf;
    const spy = vi.spyOn(Buffer.prototype, 'indexOf') as unknown as {
      mockImplementation(fn: (this: Buffer, ...args: unknown[]) => number): void;
    };
    spy.mockImplementation(function (this: Buffer, ...args: unknown[]) {
      if (args[0] === 0x0a) scanned += this.length - ((args[1] as number | undefined) ?? 0);
      return (original as (...a: unknown[]) => number).apply(this, args);
    });
    const { handler, records } = collect();
    const result = await readJsonlTail(null, '/f.jsonl', readerOf(chunks), handler);
    expect(result.parsed).toBe(1);
    expect(records).toHaveLength(1);
    expect(scanned).toBeLessThanOrEqual(66 * 1024);
  });

  it('строка без перевода, затем CR отдельным куском и перевод с записью: две записи, пустой строки нет', async () => {
    const chunks = [Buffer.from('{"a":1}'), Buffer.from('\r'), Buffer.from('\n{"b":2}\n')];
    const { handler, records } = collect();
    const result = await readJsonlTail(null, '/f.jsonl', readerOf(chunks), handler);
    expect(records).toEqual([{ a: 1 }, { b: 2 }]);
    expect(result.cursor.lineNo).toBe(2);
  });

  it('любая нарезка, в том числе внутри многобайтного символа, даёт те же записи и курсор', async () => {
    const text = Buffer.from(`{"t":"привет"}\n\n{"t":"мир"}\r\n{"t":"конец"}\n{"t":"хвост без перевода"}`);
    const whole = collect();
    const wholeResult = await readJsonlTail(null, '/f.jsonl', readerOf([text]), whole.handler);
    const cut = text.indexOf(Buffer.from('привет')) + 1;
    for (const sizes of [[cut, text.length - cut], Array(text.length).fill(1), [7, 3, 11, 5]]) {
      const chunks: Buffer[] = [];
      let at = 0;
      for (const size of sizes) {
        if (at >= text.length) break;
        chunks.push(text.subarray(at, at + size));
        at += size;
      }
      if (at < text.length) chunks.push(text.subarray(at));
      const piecewise = collect();
      const result = await readJsonlTail(null, '/f.jsonl', readerOf(chunks), piecewise.handler);
      expect(piecewise.records).toEqual(whole.records);
      expect(result.cursor).toEqual(wholeResult.cursor);
    }
  });
});
