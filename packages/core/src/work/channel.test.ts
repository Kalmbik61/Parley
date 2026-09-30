import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CHANNEL_MIN_VERSION,
  channelSupported,
  parseVersion,
  probeChannelSupport,
} from './channel.js';

let binDir = '';
const previous = process.env['HARNAS_CLAUDE_BIN'];

/** Заглушка вместо `claude`: настоящий бинарь в тестах не запускается никогда. */
async function stub(body: string): Promise<string> {
  const file = path.join(binDir, 'claude-stub');
  await writeFile(file, body, { mode: 0o755 });
  process.env['HARNAS_CLAUDE_BIN'] = file;
  return file;
}

beforeEach(async () => {
  binDir = await mkdtemp(path.join(tmpdir(), 'parley-bin-'));
});

afterEach(async () => {
  if (previous === undefined) delete process.env['HARNAS_CLAUDE_BIN'];
  else process.env['HARNAS_CLAUDE_BIN'] = previous;
  await rm(binDir, { recursive: true, force: true });
});

describe('parseVersion', () => {
  it('берёт тройку из строки `claude --version`', () => {
    expect(parseVersion('2.1.263 (Claude Code)')).toEqual([2, 1, 263]);
    expect(parseVersion('2.1.276')).toEqual([2, 1, 276]);
  });

  it('строка без версии — null: гадать не о чем', () => {
    expect(parseVersion('command not found')).toBeNull();
    expect(parseVersion('')).toBeNull();
  });
});

describe('channelSupported', () => {
  it('версия не ниже минимума принимает флаг канала', () => {
    expect(channelSupported('2.1.263')).toBe(true);
    expect(channelSupported(CHANNEL_MIN_VERSION)).toBe(true);
    expect(channelSupported('3.0.0')).toBe(true);
  });

  it('версия ниже минимума флага не принимает — запуск упал бы на unknown option', () => {
    expect(channelSupported('2.0.9')).toBe(false);
    expect(channelSupported('2.1.210')).toBe(false);
    expect(channelSupported('1.9.999')).toBe(false);
  });

  it('непонятую версию старой не считаем: push остаётся включённым (4.4)', () => {
    expect(channelSupported('какая-то сборка')).toBe(true);
  });
});

describe('probeChannelSupport', () => {
  it('свежий бинарь: версия прочитана, push включён', async () => {
    await stub('#!/bin/sh\necho "2.1.276 (Claude Code)"\n');
    expect(await probeChannelSupport()).toEqual({
      supported: true,
      version: '2.1.276 (Claude Code)',
    });
  });

  it('старый бинарь: push выключается сам, версия уезжает в предупреждение', async () => {
    await stub('#!/bin/sh\necho "2.0.9 (Claude Code)"\n');
    expect(await probeChannelSupport()).toEqual({
      supported: false,
      version: '2.0.9 (Claude Code)',
    });
  });

  it('проба не удалась — push остаётся включённым, поведение как сегодня (4.4)', async () => {
    process.env['HARNAS_CLAUDE_BIN'] = path.join(binDir, 'нет-такого');
    expect(await probeChannelSupport()).toEqual({ supported: true, version: null });
  });
});
