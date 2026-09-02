import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildSchemaReport, observeRecord, type SchemaReport } from './schema-report.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'harnas-schema-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('observeRecord', () => {
  it('группирует поля по типу записи', () => {
    const report: SchemaReport = {};
    observeRecord(report, { type: 'user', uuid: 'u1', isSidechain: false });
    observeRecord(report, { type: 'user', uuid: 'u2' });
    observeRecord(report, { type: 'assistant', uuid: 'u3' });

    expect(report['user']?.count).toBe(2);
    expect(report['user']?.fields['uuid']?.seen).toBe(2);
    expect(report['user']?.fields['isSidechain']?.seen).toBe(1);
    expect(report['assistant']?.count).toBe(1);
  });

  it('считает типы значений и запоминает пример', () => {
    const report: SchemaReport = {};
    observeRecord(report, { type: 'x', value: 'строка' });
    observeRecord(report, { type: 'x', value: 42 });
    observeRecord(report, { type: 'x', value: null });

    const field = report['x']?.fields['value'];
    expect(field?.kinds).toEqual({ string: 1, number: 1, null: 1 });
    expect(field?.sample).toBe('строка');
  });

  it('спускается во вложенные объекты', () => {
    const report: SchemaReport = {};
    observeRecord(report, { type: 'assistant', message: { role: 'assistant', model: 'opus' } });

    expect(report['assistant']?.fields['message.model']?.sample).toBe('opus');
    expect(report['assistant']?.fields['message.role']?.seen).toBe(1);
  });

  it('мапы с путями в ключах схлопываются в <key>', () => {
    const report: SchemaReport = {};
    observeRecord(report, {
      type: 'file-history-snapshot',
      snapshot: {
        '/Users/кто-то/проект/a.ts': { size: 1 },
        '/Users/кто-то/проект/b.ts': { size: 2 },
      },
    });

    const fields = Object.keys(report['file-history-snapshot']?.fields ?? {});
    expect(fields).toContain('snapshot.<key>');
    // Ни одного пути в именах полей: иначе отчёт распухнет и утащит приватное.
    expect(fields.some((name) => name.includes('/'))).toBe(false);
  });

  it('длинный пример обрезается', () => {
    const report: SchemaReport = {};
    observeRecord(report, { type: 'x', text: 'я'.repeat(300) });

    const sample = report['x']?.fields['text']?.sample;
    expect(String(sample)).toHaveLength(121);
    expect(String(sample).endsWith('…')).toBe(true);
  });

  it('запись без type попадает в unknown, мусор игнорируется', () => {
    const report: SchemaReport = {};
    observeRecord(report, { поле: 1 });
    observeRecord(report, 'строка');
    observeRecord(report, null);

    expect(report['unknown']?.count).toBe(1);
    expect(Object.keys(report)).toEqual(['unknown']);
  });
});

describe('buildSchemaReport', () => {
  const line = (record: unknown) => `${JSON.stringify(record)}\n`;

  it('собирает отчёт по нескольким файлам', async () => {
    const a = path.join(dir, 'a.jsonl');
    const b = path.join(dir, 'b.jsonl');
    await writeFile(a, line({ type: 'user', uuid: 'u1' }) + line({ type: 'assistant' }));
    await writeFile(b, line({ type: 'user', uuid: 'u2' }));

    const result = await buildSchemaReport([a, b]);

    expect(result.files).toBe(2);
    expect(result.records).toBe(3);
    expect(result.malformed).toBe(0);
    expect(result.report['user']?.count).toBe(2);
  });

  it('битые строки считаются, но не роняют отчёт', async () => {
    const file = path.join(dir, 'c.jsonl');
    await writeFile(file, line({ type: 'user' }) + '{"обор');

    const result = await buildSchemaReport([file]);
    expect(result.records).toBe(1);
    expect(result.malformed).toBe(1);
  });

  it('пустой список файлов даёт пустой отчёт', async () => {
    expect(await buildSchemaReport([])).toEqual({
      report: {},
      files: 0,
      records: 0,
      malformed: 0,
    });
  });
});
