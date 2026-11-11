import { describe, expect, it } from 'vitest';
import { createQwenTerminalParser, qwenStatusOf } from './qwen-terminal.js';

const b64 = (text: string): string => Buffer.from(text, 'utf8').toString('base64');
const osc = (body: string, end = '\x1b\\'): string => `\x1b]${body}${end}`;

describe('qwenStatusOf', () => {
  it('reads state, kind and the base64 message', () => {
    expect(qwenStatusOf('7501;state=idle:app=qwen-code')).toEqual({ state: 'idle', kind: null, msg: null });
    expect(qwenStatusOf(`7501;state=blocked:kind=auth:app=qwen-code:msg=${b64('Authentication required')}`))
      .toEqual({ state: 'blocked', kind: 'auth', msg: 'Authentication required' });
    expect(qwenStatusOf(`7501;state=blocked:kind=permission:app=qwen-code:msg=${b64('Permission needed: Shell')}`))
      .toMatchObject({ kind: 'permission', msg: 'Permission needed: Shell' });
    expect(qwenStatusOf('7501;state=working:app=qwen-code')).toEqual({ state: 'working', kind: null, msg: null });
    expect(qwenStatusOf('7501;state=clear')).toEqual({ state: 'clear', kind: null, msg: null });
  });

  it('ignores other OSC, other apps and reports without a state', () => {
    expect(qwenStatusOf('0;Qwen - proj')).toBeNull();
    expect(qwenStatusOf('7501;state=idle:app=other')).toBeNull();
    expect(qwenStatusOf('7501;app=qwen-code')).toBeNull();
    expect(qwenStatusOf('75011;state=idle:app=qwen-code')).toBeNull();
  });
});

describe('createQwenTerminalParser', () => {
  it('finds reports in a stream with titles and text, split anywhere', () => {
    const stream = `hello ${osc('0;Qwen - proj', '\x07')}${osc('7501;state=blocked:kind=auth:app=qwen-code')} text ${osc('7501;state=idle:app=qwen-code')}`;
    for (let cut = 0; cut <= stream.length; cut += 1) {
      const parser = createQwenTerminalParser();
      const found = [...parser.feed(stream.slice(0, cut)), ...parser.feed(stream.slice(cut))];
      expect(found.map((status) => status.state)).toEqual(['blocked', 'idle']);
    }
  });
});
