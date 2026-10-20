import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createVoiceTranscriber, whisperArgs, type VoiceDeps } from './voice.js';

const engine = { bin: '/w/bin/whisper-cli', vadModel: '/w/vad.bin' };

/** Фейковый процесс: stdout/stderr — PassThrough, после данных закрывается с кодом. */
const fakeSpawn = (code: number, stdout: string, calls: string[][]): VoiceDeps['spawn'] =>
  ((_bin: string, args: string[]) => {
    calls.push(args);
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true });
    setImmediate(() => {
      child.stdout.write(stdout);
      child.stdout.end();
      child.stderr.end();
      setImmediate(() => child.emit('close', code));
    });
    return child;
  }) as unknown as VoiceDeps['spawn'];

const setup = (overrides: Partial<VoiceDeps> = {}) => {
  const tmpDir = path.join(mkdtempSync(path.join(tmpdir(), 'voice-test-')), 'voice');
  const call = vi.fn(async () => ({ file_path: 'voice/file.oga' }));
  const download = vi.fn(async (_p: string, dest: string) => {
    writeFileSync(dest, 'oga');
    return 3;
  });
  const spawnCalls: string[][] = [];
  const deps: VoiceDeps = {
    api: { call: call as unknown as VoiceDeps['api']['call'], download },
    tmpDir,
    engine,
    language: () => 'ru',
    model: () => '/m/model.bin',
    decode: async () => ({ channelData: [new Float32Array(480)], sampleRate: 48_000 }),
    spawn: fakeSpawn(0, ' привет \n', spawnCalls),
    log: vi.fn(),
    ...overrides,
  };
  return { deps, call, download, spawnCalls, tmpDir };
};

describe('whisperArgs', () => {
  it('собирает аргументы как окно', () => {
    expect(whisperArgs(engine, { model: '/m', wav: '/a.wav', language: 'ru' })).toEqual(['-m', '/m', '-f', '/a.wav', '-l', 'ru', '-nt', '-np', '-sns', '--vad', '-vm', '/w/vad.bin']);
  });
});

describe('createVoiceTranscriber', () => {
  it('без движка или модели — off и ни одного вызова API', async () => {
    const a = setup({ engine: null });
    expect(await createVoiceTranscriber(a.deps).transcribe('f', 5)).toEqual({ error: 'off' });
    const b = setup({ model: () => null });
    expect(await createVoiceTranscriber(b.deps).transcribe('f', 5)).toEqual({ error: 'off' });
    expect(a.call).not.toHaveBeenCalled();
    expect(b.call).not.toHaveBeenCalled();
  });

  it('длиннее 120 секунд — too-long без обращения к API', async () => {
    const s = setup();
    expect(await createVoiceTranscriber(s.deps).transcribe('f', 121)).toEqual({ error: 'too-long' });
    expect(s.call).not.toHaveBeenCalled();
  });

  it('успех: текст из stdout, аргументы whisper-cli, файлы удалены', async () => {
    const s = setup();
    expect(await createVoiceTranscriber(s.deps).transcribe('f', 5)).toEqual({ text: 'привет' });
    const args = s.spawnCalls[0] ?? [];
    expect(args).toEqual(expect.arrayContaining(['-l', 'ru', '--vad', '/w/vad.bin']));
    expect(readdirSync(s.tmpDir)).toEqual([]);
  });

  it('код 1 — failed, файлы удалены', async () => {
    const s = setup({ spawn: fakeSpawn(1, '', []) });
    expect(await createVoiceTranscriber(s.deps).transcribe('f', 5)).toEqual({ error: 'failed' });
    expect(s.deps.log).toHaveBeenCalled();
    expect(existsSync(s.tmpDir) ? readdirSync(s.tmpDir) : []).toEqual([]);
  });

  it('пустой stdout — no-speech', async () => {
    const s = setup({ spawn: fakeSpawn(0, '  \n', []) });
    expect(await createVoiceTranscriber(s.deps).transcribe('f', 5)).toEqual({ error: 'no-speech' });
  });
});
