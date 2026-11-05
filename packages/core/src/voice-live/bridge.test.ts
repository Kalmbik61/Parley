import { describe, expect, it } from 'vitest';
import { createDelegationBridge, COVERAGE_GAP_MS, TRANSCRIPT_WAIT_MS, type BridgeSubmitInput, type BridgeSubmitResult } from './bridge.js';

function setup(options: { failFirst?: number } = {}) {
  let now = 0;
  const timers: Array<{ at: number; cb: () => void; live: boolean }> = [];
  const submits: BridgeSubmitInput[] = [];
  const opened: string[] = [];
  const failed: string[] = [];
  let failures = options.failFirst ?? 0;
  const bridge = createDelegationBridge(
    {
      conversationId: 'conv',
      voiceSessionId: 'vs-1',
      now: () => now,
      setTimer: (cb, ms) => {
        const timer = { at: now + ms, cb, live: true };
        timers.push(timer);
        return () => void (timer.live = false);
      },
      submit: async (input): Promise<BridgeSubmitResult> => {
        if (failures > 0) {
          failures -= 1;
          throw new Error('offline');
        }
        submits.push(input);
        return { requestId: `req-${submits.length}`, jobId: `job-${submits.length}`, created: true };
      },
      openRequests: () => [{ requestId: 'req-0', text: 'older question', state: 'running' }],
    },
    { delegationOpened: (info) => opened.push(info.delegationId), submitFailed: (info) => failed.push(info.delegationId) },
  );
  const advance = async (ms: number): Promise<void> => {
    const target = now + ms;
    for (;;) {
      const next = timers.filter((timer) => timer.live && timer.at <= target).sort((a, b) => a.at - b.at)[0];
      if (next === undefined) break;
      now = Math.max(now, next.at);
      next.live = false;
      next.cb();
      await Promise.resolve();
    }
    now = target;
    await Promise.resolve();
    await Promise.resolve();
  };
  const human = (text: string, startMs: number, endMs = startMs + 200) => bridge.handle({ type: 'inputTranscript', text, startMs, endMs });
  return { bridge, submits, opened, failed, advance, human, clock: () => now };
}

describe('DelegationBridge', () => {
  it('собирает текст до offset_ms и отправляет сразу, без ожидания', async () => {
    const h = setup();
    h.human('What is the status of Par', 0);
    h.human('ley builds?', 200, 1000);
    h.bridge.handle({ type: 'delegationCreated', delegationId: 'd1', offsetMs: 1000 });
    await h.advance(0);
    expect(h.submits).toHaveLength(1);
    expect(h.submits[0]).toMatchObject({ conversationId: 'conv', voiceSessionId: 'vs-1', delegationId: 'd1', text: 'What is the status of Parley builds?', transcriptPartial: false });
    expect(h.submits[0]?.context).toMatchObject({ openRequests: [{ requestId: 'req-0' }] });
  });

  it('VA-14: фрагменты опаздывают — ждёт до 1,5 с, собирает целиком, не partial', async () => {
    const h = setup();
    h.human('Check the', 0, 800);
    h.bridge.handle({ type: 'delegationCreated', delegationId: 'd1', offsetMs: 2400 });
    await h.advance(0);
    expect(h.submits).toHaveLength(0);
    await h.advance(600);
    h.human(' billing rooms', 800, 2400);
    await h.advance(0);
    expect(h.submits).toHaveLength(1);
    expect(h.submits[0]).toMatchObject({ text: 'Check the billing rooms', transcriptPartial: false });
  });

  it('VA-14/VA-05: фрагментов не дождались — через 1,5 с partial с тем, что есть', async () => {
    const h = setup();
    h.human('Check the', 0, 800);
    h.bridge.handle({ type: 'delegationCreated', delegationId: 'd1', offsetMs: 4000 });
    await h.advance(TRANSCRIPT_WAIT_MS - 1);
    expect(h.submits).toHaveLength(0);
    await h.advance(1);
    expect(h.submits).toHaveLength(1);
    expect(h.submits[0]).toMatchObject({ text: 'Check the', transcriptPartial: true });
  });

  it('совсем без фрагментов: partial с заменителем текста', async () => {
    const h = setup();
    h.bridge.handle({ type: 'delegationCreated', delegationId: 'd1', offsetMs: 1000 });
    await h.advance(TRANSCRIPT_WAIT_MS);
    expect(h.submits[0]?.transcriptPartial).toBe(true);
    expect(h.submits[0]?.text).not.toBe('');
  });

  it('VA-14: делегация посреди реплики — фраза после offset_ms не попадает в текст, второй Request берёт свою', async () => {
    const h = setup();
    h.human('Check the rooms', 0, 1500);
    h.bridge.handle({ type: 'delegationCreated', delegationId: 'd1', offsetMs: 1500 });
    await h.advance(0);
    h.human('and the weather', 2800, 3800);
    h.human(' in Tokyo', 3800, 4600);
    h.bridge.handle({ type: 'delegationCreated', delegationId: 'd2', offsetMs: 4600 });
    await h.advance(0);
    expect(h.submits.map((submit) => submit.text)).toEqual(['Check the rooms', 'and the weather in Tokyo']);
  });

  it('вторая делегация не обгоняет первую, пока та ждёт фрагментов', async () => {
    const h = setup();
    h.bridge.handle({ type: 'delegationCreated', delegationId: 'd1', offsetMs: 1000 });
    await h.advance(500);
    h.human('Second question', 2000, 3000);
    h.bridge.handle({ type: 'delegationCreated', delegationId: 'd2', offsetMs: 3000 });
    await h.advance(0);
    expect(h.submits).toHaveLength(0);
    await h.advance(TRANSCRIPT_WAIT_MS);
    expect(h.submits.map((submit) => submit.delegationId)).toEqual(['d1', 'd2']);
  });

  it('транскрипт, отставший не больше COVERAGE_GAP_MS от offset_ms, считается дошедшим', async () => {
    const h = setup();
    h.human('Quick one', 0, 1000);
    h.bridge.handle({ type: 'delegationCreated', delegationId: 'd1', offsetMs: 1000 + COVERAGE_GAP_MS });
    await h.advance(0);
    expect(h.submits[0]?.transcriptPartial).toBe(false);
  });

  it('повтор события делегации не создаёт второй Request', async () => {
    const h = setup();
    h.human('Hello there', 0, 800);
    h.bridge.handle({ type: 'delegationCreated', delegationId: 'd1', offsetMs: 800 });
    h.bridge.handle({ type: 'delegationCreated', delegationId: 'd1', offsetMs: 800 });
    await h.advance(0);
    expect(h.submits).toHaveLength(1);
    expect(h.opened).toEqual(['d1']);
  });

  it('потерянный submit повторяется с теми же id (хост идемпотентен по originKey)', async () => {
    const h = setup({ failFirst: 2 });
    h.human('Hello there', 0, 800);
    h.bridge.handle({ type: 'delegationCreated', delegationId: 'd1', offsetMs: 800 });
    await h.advance(0);
    expect(h.submits).toHaveLength(0);
    await h.advance(500);
    await h.advance(2000);
    expect(h.submits).toHaveLength(1);
    expect(h.submits[0]).toMatchObject({ voiceSessionId: 'vs-1', delegationId: 'd1' });
  });

  it('после исчерпания повторов сообщает об ошибке и не падает', async () => {
    const h = setup({ failFirst: 10 });
    h.human('Hello there', 0, 800);
    h.bridge.handle({ type: 'delegationCreated', delegationId: 'd1', offsetMs: 800 });
    await h.advance(0);
    await h.advance(500);
    await h.advance(2000);
    expect(h.failed).toEqual(['d1']);
  });

  it('контекст: последние реплики человека и модели, [hum] режется по собранному тексту', async () => {
    const h = setup();
    h.human('Old chat', 0, 600);
    h.bridge.handle({ type: 'outputTranscript', text: 'Sure [h', startMs: 700, endMs: 900 });
    h.bridge.handle({ type: 'outputTranscript', text: 'um] thing.', startMs: 900, endMs: 1100 });
    h.human('Now the rooms', 5000, 6000);
    h.bridge.handle({ type: 'delegationCreated', delegationId: 'd1', offsetMs: 6000 });
    await h.advance(0);
    expect(h.submits[0]?.text).toBe('Now the rooms');
    expect(h.submits[0]?.context['recentTurns']).toEqual([
      { role: 'human', text: 'Old chat' },
      { role: 'assistant', text: 'Sure thing.' },
    ]);
  });

  it('dispose отменяет ожидание', async () => {
    const h = setup();
    h.bridge.handle({ type: 'delegationCreated', delegationId: 'd1', offsetMs: 1000 });
    h.bridge.dispose();
    await h.advance(TRANSCRIPT_WAIT_MS * 2);
    expect(h.submits).toHaveLength(0);
  });
});
