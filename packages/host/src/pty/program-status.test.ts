import { describe, expect, it } from 'vitest';
import { MAX_OSC_LENGTH, createOscReader } from './codex-terminal.js';
import { programStatusOf, programStatusApp } from './program-status.js';

const osc = (body: string, end = '\x07'): string => '\x1b]7501;' + body + end;
const decode = (body: string) => programStatusOf(body, 'qwen-code');
const reader = () => createOscReader(decode);

describe('OSC 7501 program status', () => {
  it('only enables families confirmed in their Parley launch mode', () => {
    expect(programStatusApp('qwen')).toBe('qwen-code');
    expect(programStatusApp('opencode')).toBe('opencode');
    expect(programStatusApp('codex')).toBe('codex');
    for (const provider of ['kimi', 'claude', 'glm', 'qwen-code', null]) {
      expect(programStatusApp(provider)).toBeNull();
    }
  });

  it.each(['idle', 'working', 'done', 'error'])('keeps only the root %s state', (state) => {
    expect(decode('7501;state=' + state + ':kind=permission:app=qwen-code:msg=YWJj:title=YWJj')?.status)
      .toEqual({ state });
  });

  it.each(['auth', 'permission', 'question'])('keeps the known blocked kind %s', (kind) => {
    expect(decode('7501;state=blocked:app=qwen-code:kind=' + kind)?.status).toEqual({ state: 'blocked', kind });
  });

  it('drops unknown blocked kinds', () => {
    expect(decode('7501;state=blocked:app=qwen-code:kind=unrecognized')?.status).toEqual({ state: 'blocked' });
  });

  it('clears only the current app root, even when app is omitted', () => {
    expect(decode('7501;state=clear')?.status).toBeNull();
    expect(decode('7501;state=clear:app=qwen-code')?.status).toBeNull();
    expect(decode('7501;state=clear:app=foreign')).toBeNull();
    expect(decode('7501;state=clear:app=')).toBeNull();
    expect(decode('7501;state=clear:id=child')).toBeNull();
    expect(decode('7501;state=idle:id=child:app=qwen-code')).toBeNull();
  });

  it.each([
    '0;Ready', '75011;state=idle:app=qwen-code', '7501;app=qwen-code',
    '7501;state=unknown:app=qwen-code', '7501;state=idle', '7501;state=idle:app=foreign',
    '7501;state=clear:app=qwen-code:app=foreign', '7501;state=working:state=idle:app=qwen-code',
    '7501;state=idle:app=qwen-code:garbage', '7501;state=clear:id=child:id=',
    '7501;state=clear:id=\n',
  ])('rejects invalid or unrelated frames (%j)', (body) => {
    expect(decode(body)).toBeNull();
  });

  it('reads BEL and split ST in order regardless of where the stream is cut', () => {
    const stream = osc('state=working:app=qwen-code', '\x1b\\') + osc('state=done:app=qwen-code');
    for (let cut = 0; cut <= stream.length; cut++) {
      const parser = reader();
      expect([...parser.feed(stream.slice(0, cut)), ...parser.feed(stream.slice(cut))].map((frame) => frame.status))
        .toEqual([{ state: 'working' }, { state: 'done' }]);
    }
  });

  it('recovers from an aborted or unterminated frame at the next OSC', () => {
    const frame = '\x1b]7501;state=idle:app=qwen-code';
    expect(reader().feed(frame + '\x18\x07' + frame + osc('state=done:app=qwen-code'))
      .map((report) => report.status)).toEqual([{ state: 'done' }]);
  });

  it('rejects oversized frames whether or not their terminator was in the same chunk', () => {
    const big = 'state=idle:app=qwen-code:msg=' + 'a'.repeat(MAX_OSC_LENGTH);
    const good = osc('state=done:app=qwen-code');
    expect(reader().feed(osc(big) + good).map((frame) => frame.status)).toEqual([{ state: 'done' }]);
    const parser = reader();
    expect(parser.feed('\x1b]7501;' + big)).toEqual([]);
    expect(parser.feed('\x07' + good).map((frame) => frame.status)).toEqual([{ state: 'done' }]);
  });

  it('accepts the exact limit even when ST is split', () => {
    const prefix = 'state=idle:app=qwen-code:msg=';
    const body = prefix.padEnd(MAX_OSC_LENGTH - '\x1b]7501;'.length, 'a');
    const frame = osc(body, '\x1b\\');
    const parser = reader();
    expect(parser.feed(frame.slice(0, -1))).toEqual([]);
    expect(parser.feed(frame.slice(-1)).map((report) => report.status)).toEqual([{ state: 'idle' }]);
  });
});
