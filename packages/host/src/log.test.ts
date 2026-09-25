import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLog } from './log.js';

let dir = '';

beforeEach(async () => {
  dir = await mkdtemp('/tmp/hh-log-');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('createLog', () => {
  it('пишет JSON-строки со временем', async () => {
    const file = path.join(dir, 'host.log');
    const log = createLog(file);
    log.info('старт', { pid: 1 });

    const content = await readFile(file, 'utf8');
    const line = JSON.parse(content.trim()) as { level: string; msg: string; time: string; pid: number };
    expect(line).toMatchObject({ level: 'info', msg: 'старт', pid: 1 });
    expect(typeof line.time).toBe('string');
  });

  it('не роняется на предупреждениях и ошибках', async () => {
    const file = path.join(dir, 'host.log');
    const log = createLog(file);
    log.warn('осторожно');
    log.error('упало', { code: 'internal' });

    const lines = (await readFile(file, 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] ?? '')).toMatchObject({ level: 'warn' });
    expect(JSON.parse(lines[1] ?? '')).toMatchObject({ level: 'error', code: 'internal' });
  });

  it('ротирует файл в .1 при превышении maxBytes', () => {
    const file = path.join(dir, 'host.log');
    const log = createLog(file, { maxBytes: 1024 });
    for (let i = 0; i < 200; i += 1) {
      log.info('строка-заполнитель', { i, filler: 'x'.repeat(20) });
    }
    expect(existsSync(`${file}.1`)).toBe(true);
  });
});
