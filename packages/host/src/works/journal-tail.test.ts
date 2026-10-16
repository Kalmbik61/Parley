import { appendFile, mkdtemp, rename, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createJournalTail } from './journal-tail.js';

let dir = '';
let file = '';

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'parley-tail-'));
  file = path.join(dir, 'messages.jsonl');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const line = (seq: number, text = 'т'): string =>
  `${JSON.stringify({ seq, id: `m-r01-${seq}`, roomId: 'r-01', from: 's-01', to: [], text, kind: 'note', at: `2026-10-16T10:00:${String(seq).padStart(2, '0')}.000Z` })}\n`;
const ids = (read: { letters: { id: string }[] }): string[] => read.letters.map((letter) => letter.id);

describe('хвост журнала писем', () => {
  it('первое чтение отдаёт весь небольшой журнал, дальше — только дописанное; байты — прочитанные с диска', async () => {
    await writeFile(file, line(1) + line(2));
    const tail = createJournalTail(file);
    const first = await tail.read();
    expect(ids(first)).toEqual(['m-r01-1', 'm-r01-2']);
    expect(first).toMatchObject({ reset: false, partial: false, bytes: Buffer.byteLength(line(1) + line(2)) });

    expect(await tail.read()).toMatchObject({ letters: [], bytes: 0, reset: false });

    await appendFile(file, line(3, 'я'.repeat(100)));
    const next = await tail.read();
    expect(ids(next)).toEqual(['m-r01-3']);
    expect(next.bytes).toBe(Buffer.byteLength(line(3, 'я'.repeat(100))));
  });

  it('оборванная последняя строка не отдаётся и не теряется: дописали — пришла целой, ровно один раз', async () => {
    await writeFile(file, line(1));
    const tail = createJournalTail(file);
    await tail.read();
    const whole = line(2, 'длинное письмо');
    await appendFile(file, whole.slice(0, 30));
    expect((await tail.read()).letters).toEqual([]);
    await appendFile(file, whole.slice(30));
    expect(ids(await tail.read())).toEqual(['m-r01-2']);
    expect((await tail.read()).letters).toEqual([]);
  });

  it('усечённый журнал — reset, и следующее чтение идёт с начала нового содержимого', async () => {
    await writeFile(file, line(1) + line(2) + line(3));
    const tail = createJournalTail(file);
    await tail.read();
    await truncate(file, 0);
    expect(await tail.read()).toMatchObject({ letters: [], reset: true });
    await appendFile(file, line(1, 'новое'));
    expect(ids(await tail.read())).toEqual(['m-r01-1']);
  });

  it('журнал, заменённый другим файлом (даже длиннее прежнего), — reset', async () => {
    await writeFile(file, line(1));
    const tail = createJournalTail(file);
    await tail.read();
    const other = path.join(dir, 'other.jsonl');
    await writeFile(other, line(1, 'другой') + line(2) + line(3));
    await rename(other, file);
    expect(await tail.read()).toMatchObject({ letters: [], reset: true });
    expect(ids(await tail.read())).toEqual(['m-r01-1', 'm-r01-2', 'm-r01-3']);
  });

  it('журнала нет: пока не читали — тихо пусто, после чтения — reset (журнал удалён вместе с комнатой)', async () => {
    const tail = createJournalTail(file);
    expect(await tail.read()).toMatchObject({ letters: [], reset: false });
    await writeFile(file, line(1));
    await tail.read();
    await rm(file);
    expect(await tail.read()).toMatchObject({ letters: [], reset: true });
  });

  it('большой журнал при первом чтении берётся хвостом окна: первая обрезанная строка отброшена, partial', async () => {
    let body = '';
    for (let seq = 1; seq <= 200; seq += 1) body += line(seq, 'я'.repeat(60));
    await writeFile(file, body);
    const tail = createJournalTail(file, { windowBytes: 2000 });
    const first = await tail.read();
    expect(first.partial).toBe(true);
    expect(first.bytes).toBeLessThanOrEqual(2001);
    expect(first.letters.at(-1)?.id).toBe('m-r01-200');
    expect(first.letters.length).toBeGreaterThan(5);
    expect(first.letters.length).toBeLessThan(40);
    // Оконное чтение целое: ни одной разорванной строки.
    expect(first.letters.every((letter) => letter.id.startsWith('m-r01-'))).toBe(true);
  });

  it('битая целая строка пропускается с предупреждением, соседние письма целы', async () => {
    const warnings: string[] = [];
    await writeFile(file, line(1) + 'не json\n' + line(2));
    const tail = createJournalTail(file, { warn: (message) => warnings.push(message) });
    expect(ids(await tail.read())).toEqual(['m-r01-1', 'm-r01-2']);
    expect(warnings).toHaveLength(1);
  });

  it('forget возвращает хвост в «не читали»: следующее чтение снова берёт журнал с начала окна', async () => {
    await writeFile(file, line(1) + line(2));
    const tail = createJournalTail(file);
    await tail.read();
    tail.forget();
    expect(ids(await tail.read())).toEqual(['m-r01-1', 'm-r01-2']);
  });

  it('changed: файл тот же и не вырос — false без чтения; дописали, заменили или ещё не читали — true; файла нет и не читали — false', async () => {
    const tail = createJournalTail(file);
    expect(await tail.changed()).toBe(false);
    await writeFile(file, line(1));
    expect(await tail.changed()).toBe(true);
    await tail.read();
    expect(await tail.changed()).toBe(false);
    await appendFile(file, line(2));
    expect(await tail.changed()).toBe(true);
    await tail.read();
    // Оборванная строка: хвост её не отдал, но и перечитывать её при каждом проходе не надо, пока файл не вырос.
    await appendFile(file, line(3).slice(0, 20));
    expect(await tail.changed()).toBe(true);
    await tail.read();
    expect(await tail.changed()).toBe(false);
    const other = path.join(dir, 'other.jsonl');
    await writeFile(other, line(1));
    await rename(other, file);
    expect(await tail.changed()).toBe(true);
    await tail.read();
    // Замену хвост заметил (reset), следующее чтение берёт новый файл заново.
    expect(await tail.changed()).toBe(true);
    await tail.read();
    expect(await tail.changed()).toBe(false);
    await rm(file);
    expect(await tail.changed()).toBe(true);
  });
});
