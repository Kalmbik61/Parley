import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendSent, readSent } from './sent-log.js';

const ref = { projectPath: '/p', workId: 'w', sessionId: 's' };
let home = '';
beforeEach(async () => { home = await mkdtemp(path.join(tmpdir(), 'parley-sent-')); });
afterEach(async () => { await rm(home, { recursive: true, force: true }); });

describe('sent.jsonl', () => {
  it('пишет и читает по сессии', async () => {
    await appendSent(home, ref, 'Тесты можно пропустить', '2026-10-15T10:00:00.000Z');
    await appendSent(home, { ...ref, sessionId: 'other' }, 'чужое', '2026-10-15T10:01:00.000Z');
    expect(await readSent(home, ref)).toEqual([{ text: 'Тесты можно пропустить', at: '2026-10-15T10:00:00.000Z' }]);
  });
  it('нет файла — пусто', async () => {
    expect(await readSent(home, ref)).toEqual([]);
  });
  it('держит не больше 500 записей', async () => {
    for (let index = 0; index < 620; index += 1) await appendSent(home, ref, `m${index}`, '2026-10-15T10:00:00.000Z');
    const lines = (await readFile(path.join(home, 'assistant', 'sent.jsonl'), 'utf8')).trim().split('\n');
    expect(lines.length).toBeLessThanOrEqual(600);
  });
});
