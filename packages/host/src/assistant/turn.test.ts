import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseClaudeLine, type AssistantStreamEvent } from '@parley/core';
import { runTurn, type TurnSpec } from './turn.js';

const STUB = fileURLToPath(new URL('../../test/stub-assistant.mjs', import.meta.url));
function spec(env: Record<string, string>, timeoutMs = 5000): TurnSpec {
  return { command: process.execPath, args: [STUB], env: { ...process.env, ...env }, cwd: process.cwd(), parse: parseClaudeLine, timeoutMs };
}
const INIT = { type: 'system', subtype: 'init', session_id: 'sid-1' };
const DELTA = (text: string) => ({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } });
const RESULT = { type: 'result', subtype: 'success', is_error: false, result: 'x' };

describe('runTurn', () => {
  it('события по порядку и успешный конец', async () => {
    const seen: AssistantStreamEvent[] = [];
    const handle = runTurn(spec({ STUB_LINES: JSON.stringify([INIT, DELTA('[[calm]] '), DELTA('Тихо.'), RESULT]) }), (event) => seen.push(event));
    await expect(handle.done).resolves.toEqual({ ok: true });
    expect(seen.map((event) => event.type)).toEqual(['session', 'text', 'text', 'done']);
  });
  it('конец без result — ошибка по stderr', async () => {
    const handle = runTurn(spec({ STUB_LINES: '[]', STUB_STDERR: 'Error: thread/resume: no rollout found', STUB_EXIT: '1' }), () => {});
    await expect(handle.done).resolves.toMatchObject({ ok: false, kind: 'resume' });
  });
  it('зависший CLI — timeout', async () => {
    const handle = runTurn(spec({ STUB_LINES: JSON.stringify([INIT]), STUB_HANG: '1' }, 300), () => {});
    await expect(handle.done).resolves.toMatchObject({ ok: false, kind: 'timeout' });
  });
  it('отмена — cancelled, события после неё не приходят', async () => {
    const seen: AssistantStreamEvent[] = [];
    const handle = runTurn(spec({ STUB_LINES: JSON.stringify([INIT, DELTA('a'), DELTA('b'), RESULT]), STUB_DELAY_MS: '200' }), (event) => seen.push(event));
    await new Promise((resolve) => setTimeout(resolve, 50));
    handle.cancel();
    await expect(handle.done).resolves.toMatchObject({ ok: false, kind: 'cancelled' });
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(seen.length).toBeLessThanOrEqual(1);
  });
  it('бинаря нет — start', async () => {
    const handle = runTurn({ ...spec({}), command: '/nonexistent/claude' }, () => {});
    await expect(handle.done).resolves.toMatchObject({ ok: false, kind: 'start' });
  });
});
