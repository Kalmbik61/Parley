import { expect, it } from 'vitest';
import { REF, fakeFeedDeps } from '../../test/feed-fakes.js';
import { projectKimiWire } from '../kimi/native-wire.js';
import { createFeedService } from './feed-service.js';

it.each([false, true])('preserves an in-turn Kimi steer and deduplicates its wire echo (historical=%s)', async (historical) => {
  const service = createFeedService(fakeFeedDeps([{ ref: REF, provider: 'kimi' }]).deps);
  const source = 'session_fixture';
  const time = 1790000000000;
  const emit = (row: Parameters<typeof projectKimiWire>[0]) => {
    const event = projectKimiWire({ agentId: 'main', ...row });
    if (event !== undefined) service.kimiNativeEvent(REF, source, event, historical);
  };
  const prompt = (id: string, text: string, delta: number) => ({
    type: 'context.append_message', time: time + delta,
    message: { role: 'user', id, origin: { kind: 'user' }, content: [{ type: 'text', text }] },
  });
  const steer = {
    type: 'prompt.steered', time: time + 1000, activePromptId: 'msg_initial',
    promptIds: ['msg_steer'], messageId: 'msg_steer', content: [{ type: 'text', text: 'change direction' }],
  };
  try {
    emit(prompt('msg_initial', 'initial', 0));
    emit(steer);
    emit(steer);
    emit(prompt('msg_steer', 'change direction', 2000));
    emit({ type: 'turn.ended', time: time + 3000, reason: 'completed' });
    expect((await service.snapshot(REF)).items).toEqual([
      expect.objectContaining({ kind: 'prompt', text: 'initial' }),
      expect.objectContaining({ kind: 'prompt', text: 'change direction', steered: true }),
      expect.objectContaining({ kind: 'turn', durationMs: 3000 }),
    ]);
  } finally {
    await service.stop();
  }
});

it('keeps the same prompt id when Kimi hands a steer off to the next turn', async () => {
  const service = createFeedService(fakeFeedDeps([{ ref: REF, provider: 'kimi' }]).deps);
  const source = 'session_fixture';
  const time = 1790000000000;
  try {
    service.kimiNativeEvent(REF, source, { kind: 'prompt', id: 'msg_initial', text: 'initial', at: time });
    service.kimiNativeEvent(REF, source, { kind: 'steer', id: 'msg_follow', text: 'follow', at: time + 1000 });
    const echo = (await service.snapshot(REF)).items.at(-1)!;
    expect(echo).toMatchObject({ kind: 'prompt', steered: true });
    service.kimiNativeEvent(REF, source, { kind: 'end', reason: 'completed', at: time + 2000 });
    service.kimiNativeEvent(REF, source, { kind: 'prompt', id: 'msg_follow', text: 'follow', at: time + 2500 });
    service.kimiNativeEvent(REF, source, { kind: 'end', reason: 'completed', at: time + 3500 });
    expect((await service.snapshot(REF)).items).toEqual([
      expect.objectContaining({ kind: 'prompt', text: 'initial' }),
      expect.objectContaining({ kind: 'turn', durationMs: 2000 }),
      { kind: 'prompt', id: echo.id, text: 'follow', images: 0, at: new Date(time + 2500).toISOString() },
      expect.objectContaining({ kind: 'turn', durationMs: 1000 }),
    ]);
  } finally {
    await service.stop();
  }
});
