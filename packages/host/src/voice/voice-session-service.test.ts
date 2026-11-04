import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openMemoryDb } from '@parley/core';
import { LiveError, type LiveClient, type LiveClosed, type Sideband } from './live-client.js';
import { VOICE_PROMPT, liveSessionConfig } from './voice-prompt.js';
import { INIT_BILLED_SECONDS, MAX_SESSION_MS, WARNING_BEFORE_MS, createVoiceSessionService } from './voice-session-service.js';

class FakeSideband implements Sideband {
  usage: Array<(s: number) => void> = [];
  closedL: Array<(c: LiveClosed) => void> = [];
  discL: Array<() => void> = [];
  closeRequests = 0;
  disposed = 0;
  onUsage(l: (s: number) => void): void {
    this.usage.push(l);
  }
  onClosed(l: (c: LiveClosed) => void): void {
    this.closedL.push(l);
  }
  onDisconnected(l: () => void): void {
    this.discL.push(l);
  }
  disconnect(): void {
    for (const l of this.discL) l();
  }
  requestClose(): void {
    this.closeRequests += 1;
  }
  dispose(): void {
    this.disposed += 1;
  }
  pushUsage(s: number): void {
    for (const l of this.usage) l(s);
  }
  pushClosed(c: LiveClosed): void {
    for (const l of this.closedL) l(c);
  }
}

const setup = (opts: { createError?: Error; attachError?: Error; attachFailures?: number; failInsert?: boolean; attachAfterFirst?: 'fail'; dailyMinutes?: number; clock?: { date: Date }; attachGate?: Promise<void> } = {}) => {
  const realDb = openMemoryDb();
  const db = opts.failInsert
    ? ({ prepare: (sql: string) => (sql.startsWith('INSERT') ? { run: () => { throw new Error('disk full'); } } : realDb.prepare(sql)) } as unknown as typeof realDb)
    : realDb;
  let failures = opts.attachFailures ?? 0;
  const sidebands: FakeSideband[] = [];
  const createCalls: Array<{ offer: string; session: Record<string, unknown> | undefined }> = [];
  let n = 0;
  const live: LiveClient = {
    async createSession(offer, session) {
      createCalls.push({ offer, session });
      if (opts.createError) throw opts.createError;
      n += 1;
      return { sessionId: `sess_${n}`, sdpAnswer: 'answer' };
    },
    async attach() {
      if (opts.attachGate) await opts.attachGate;
      if (opts.attachAfterFirst === 'fail' && sidebands.length >= 1) throw new LiveError('sideband', 'gone');
      if (opts.attachError) throw opts.attachError;
      if (failures > 0) {
        failures -= 1;
        throw new LiveError('sideband', 'flaky');
      }
      const sb = new FakeSideband();
      sidebands.push(sb);
      return sb;
    },
  };
  const warnings: string[] = [];
  const closed: Array<[string, string]> = [];
  const service = createVoiceSessionService({
    db,
    live,
    now: () => (opts.clock ? opts.clock.date : new Date(2026, 10, 4, 12, 0, 0)),
    dailyMinutes: () => opts.dailyMinutes ?? 600,
    onWarning: (id) => warnings.push(id),
    onClosed: (id, reason) => closed.push([id, reason]),
    attachDelaysMs: [0, 0],
    reconnectDelaysMs: [0, 0],
  });
  const addUsage = (id: string, day: string, estimate: number, final: number | null) =>
    realDb.prepare("INSERT INTO voice_usage (voice_session_id, day, state, seconds_estimate, seconds_final) VALUES (?, ?, 'closed', ?, ?)").run(id, day, estimate, final);
  const row = (id = 'sess_1') => realDb.prepare('SELECT * FROM voice_usage WHERE voice_session_id = ?').get(id) as Record<string, unknown> | undefined;
  return { db, service, sidebands, createCalls, warnings, closed, row, addUsage };
};

describe('VoiceSessionService', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('prepare: пишет open-строку с локальным днём и стартовым биллингом', async () => {
    const { service, row } = setup();
    expect(await service.prepare('offer')).toEqual({ ok: true, voiceSessionId: 'sess_1', sdpAnswer: 'answer' });
    expect(row()).toMatchObject({ day: '2026-11-04', state: 'open', seconds_estimate: INIT_BILLED_SECONDS, seconds_final: null });
    expect(service.activeSessionId()).toBe('sess_1');
  });

  it('prepare: конфиг сессии передаётся как есть; без него — прежний конфиг клиента (телефон)', async () => {
    const { service, createCalls } = setup();
    await service.prepare('offer', liveSessionConfig());
    expect(createCalls[0]?.offer).toBe('offer');
    const session = createCalls[0]?.session ?? {};
    expect(session).toEqual({ model: 'gpt-live-1', instructions: VOICE_PROMPT, delegation: { type: 'client' } });
    expect(JSON.stringify(session)).not.toContain('acknowledgement_delay_ms');
    const legacy = setup();
    await legacy.service.prepare('offer-2');
    expect(legacy.createCalls[0]?.session).toBeUndefined();
  });

  it('второй prepare (в том числе одновременный) — busy', async () => {
    const { service } = setup();
    const [a, b] = await Promise.all([service.prepare('o'), service.prepare('o')]);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    const second = await service.prepare('o');
    expect(second).toMatchObject({ ok: false, code: 'busy' });
  });

  it('ошибка createSession освобождает слот и не пишет строку', async () => {
    const { service, row } = setup({ createError: new LiveError('no_key', 'no key') });
    expect(await service.prepare('o')).toMatchObject({ ok: false, code: 'no_key' });
    expect(service.activeSessionId()).toBeNull();
    expect(row()).toBeUndefined();
  });

  it('attach с повтором: два сбоя и успех — сессия живёт', async () => {
    const { service, sidebands } = setup({ attachFailures: 2 });
    expect((await service.prepare('o')).ok).toBe(true);
    expect(sidebands).toHaveLength(1);
    expect(service.activeSessionId()).toBe('sess_1');
  });

  it('attach не удался во всех попытках: запись брошена с причиной, ошибка называет сессию, слот свободен', async () => {
    const { service, row, closed } = setup({ attachError: new LiveError('sideband', 'x') });
    const result = await service.prepare('o');
    expect(result).toMatchObject({ ok: false, code: 'failed' });
    expect(result.ok === false && result.message).toContain('sess_1');
    expect(row()).toMatchObject({ state: 'closed', close_reason: 'unclosed_orphan' });
    expect(closed).toEqual([['sess_1', 'unclosed_orphan']]);
    expect(service.activeSessionId()).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('сбой записи voice_usage после создания: sideband подключается, шлёт session.close и закрывается', async () => {
    const { service, sidebands, row } = setup({ failInsert: true });
    const pending = service.prepare('o');
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await pending).toMatchObject({ ok: false, code: 'failed' });
    expect(sidebands[0]!.closeRequests).toBe(1);
    expect(sidebands[0]!.disposed).toBe(1);
    expect(row()).toBeUndefined();
    expect(service.activeSessionId()).toBeNull();
  });

  it('сбой записи и все попытки attach неудачны: unclosed_orphan, ошибка называет сессию, слот свободен', async () => {
    const { service, closed } = setup({ failInsert: true, attachError: new LiveError('sideband', 'x') });
    const result = await service.prepare('o');
    expect(result).toMatchObject({ ok: false, code: 'failed' });
    expect(result.ok === false && result.message).toContain('sess_1');
    expect(closed).toEqual([['sess_1', 'unclosed_orphan']]);
    expect(service.activeSessionId()).toBeNull();
  });

  it('sideband оборвался: слот и таймеры держатся, переподключение, закрытие на 30-й минуте уходит', async () => {
    const { service, sidebands, row, closed } = setup();
    await service.prepare('o');
    sidebands[0]!.disconnect();
    await vi.advanceTimersByTimeAsync(0);
    expect(sidebands).toHaveLength(2);
    expect(closed).toEqual([]);
    expect(row()).toMatchObject({ state: 'open' });
    expect((await service.prepare('o')).ok).toBe(false);
    await vi.advanceTimersByTimeAsync(MAX_SESSION_MS);
    expect(sidebands[1]!.closeRequests).toBe(1);
    sidebands[1]!.pushClosed({ seconds: 1800, reason: 'close_requested' });
    expect(row()).toMatchObject({ state: 'closed', seconds_final: 1800 });
  });

  it('sideband оборвался и не вернулся: sideband_lost, финал неполный', async () => {
    const { service, sidebands, row, closed } = setup({ attachAfterFirst: 'fail' });
    await service.prepare('o');
    sidebands[0]!.pushUsage(40);
    sidebands[0]!.disconnect();
    await vi.advanceTimersByTimeAsync(0);
    expect(closed).toEqual([['sess_1', 'sideband_lost']]);
    expect(row()).toMatchObject({ state: 'closed', close_reason: 'sideband_lost', seconds_final: null, seconds_estimate: 40 });
    expect(service.activeSessionId()).toBeNull();
  });

  it('usage заменяет оценку, а не складывает', async () => {
    const { service, sidebands, row } = setup();
    await service.prepare('o');
    sidebands[0]!.pushUsage(40);
    sidebands[0]!.pushUsage(55);
    expect(row()).toMatchObject({ seconds_estimate: 55 });
  });

  it('session.closed: terminal, seconds_final, причина, слот свободен, сокет закрыт', async () => {
    const { service, sidebands, row, closed } = setup();
    await service.prepare('o');
    sidebands[0]!.pushClosed({ seconds: 70, reason: 'remote_hangup' });
    expect(row()).toMatchObject({ state: 'closed', seconds_final: 70, close_reason: 'remote_hangup' });
    expect(closed).toEqual([['sess_1', 'remote_hangup']]);
    expect(sidebands[0]!.disposed).toBe(1);
    expect(service.activeSessionId()).toBeNull();
    expect((await service.prepare('o')).ok).toBe(true);
  });

  it('connection_lost без секунд берёт последнюю оценку', async () => {
    const { service, sidebands, row } = setup();
    await service.prepare('o');
    sidebands[0]!.pushUsage(33);
    sidebands[0]!.pushClosed({ seconds: null, reason: 'connection_lost' });
    expect(row()).toMatchObject({ seconds_final: 33, close_reason: 'connection_lost' });
  });

  it('close: просит закрыть через sideband и ждёт session.closed', async () => {
    const { service, sidebands, row } = setup();
    await service.prepare('o');
    const pending = service.close('sess_1');
    expect(sidebands[0]!.closeRequests).toBe(1);
    sidebands[0]!.pushClosed({ seconds: 20, reason: 'close_requested' });
    expect(await pending).toBe(true);
    expect(row()).toMatchObject({ state: 'closed', seconds_final: 20 });
    expect(await service.close('sess_1')).toBe(false);
  });

  it('close без ответа OpenAI завершается по таймауту и всё равно пишет terminal', async () => {
    const { service, sidebands, row } = setup();
    await service.prepare('o');
    const pending = service.close('sess_1');
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await pending).toBe(true);
    expect(row()).toMatchObject({ state: 'closed', close_reason: 'close_timeout', seconds_final: null, seconds_estimate: INIT_BILLED_SECONDS });
    expect(sidebands[0]!.disposed).toBe(1);
  });

  it('stop: готовую сессию закрывает через sideband и ждёт session.closed', async () => {
    const { service, sidebands, row } = setup();
    await service.prepare('o');
    const pending = service.stop();
    expect(sidebands[0]!.closeRequests).toBe(1);
    sidebands[0]!.pushClosed({ seconds: 20, reason: 'close_requested' });
    await pending;
    expect(row()).toMatchObject({ state: 'closed', seconds_final: 20 });
    expect(service.activeSessionId()).toBeNull();
  });

  it('stop во время prepare: сессия закрывается, как только подключился sideband, prepare возвращает отказ', async () => {
    let open!: () => void;
    const attachGate = new Promise<void>((resolve) => (open = resolve));
    const { service, sidebands, row } = setup({ attachGate });
    const preparing = service.prepare('o');
    await Promise.resolve();
    const stopping = service.stop();
    open();
    expect(await preparing).toMatchObject({ ok: false, code: 'failed' });
    expect(sidebands[0]!.closeRequests).toBe(1);
    sidebands[0]!.pushClosed({ seconds: 15, reason: 'close_requested' });
    await stopping;
    expect(row()).toMatchObject({ state: 'closed', seconds_final: 15 });
    expect(service.activeSessionId()).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stop без активной сессии сразу выполнен', async () => {
    const { service } = setup();
    await expect(service.stop()).resolves.toBeUndefined();
  });

  it('close чужого id — false', async () => {
    const { service } = setup();
    await service.prepare('o');
    expect(await service.close('other')).toBe(false);
  });

  it('предупреждение за 2 минуты и закрытие через 30', async () => {
    const { service, sidebands, warnings, row } = setup();
    await service.prepare('o');
    await vi.advanceTimersByTimeAsync(MAX_SESSION_MS - WARNING_BEFORE_MS - 1);
    expect(warnings).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(warnings).toEqual(['sess_1']);
    expect(sidebands[0]!.closeRequests).toBe(0);
    await vi.advanceTimersByTimeAsync(WARNING_BEFORE_MS);
    expect(sidebands[0]!.closeRequests).toBe(1);
    sidebands[0]!.pushClosed({ seconds: 1800, reason: 'close_requested' });
    expect(row()).toMatchObject({ state: 'closed', seconds_final: 1800 });
  });

  it('после закрытия таймеры сняты', async () => {
    const { service, sidebands, warnings } = setup();
    await service.prepare('o');
    sidebands[0]!.pushClosed({ seconds: 5, reason: 'content' });
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(MAX_SESSION_MS * 2);
    expect(warnings).toEqual([]);
    expect(sidebands[0]!.closeRequests).toBe(0);
  });
  describe('дневной лимит (B4)', () => {
    it('ровно на лимите prepare отказывает limit_reached и не зовёт OpenAI', async () => {
      const { service, addUsage, sidebands } = setup({ dailyMinutes: 10 });
      addUsage('old', '2026-11-04', 0, 600);
      expect(await service.prepare('o')).toMatchObject({ ok: false, code: 'limit_reached' });
      expect(sidebands).toHaveLength(0);
      expect(service.activeSessionId()).toBeNull();
    });

    it('на секунду меньше лимита сессия открывается', async () => {
      const { service, addUsage } = setup({ dailyMinutes: 10 });
      addUsage('old', '2026-11-04', 0, 599);
      expect((await service.prepare('o')).ok).toBe(true);
    });

    it('строка без seconds_final считается по оценке', async () => {
      const { service, addUsage } = setup({ dailyMinutes: 10 });
      addUsage('lost', '2026-11-04', 600, null);
      expect(await service.prepare('o')).toMatchObject({ ok: false, code: 'limit_reached' });
    });

    it('предупреждение за 2 минуты до конца остатка и закрытие по исчерпании', async () => {
      const { service, addUsage, sidebands, warnings, row } = setup({ dailyMinutes: 10 });
      addUsage('old', '2026-11-04', 0, 300);
      await service.prepare('o');
      // остаток: 600 - 300 - 15 (стартовая оценка) = 285 с
      const budgetMs = 285_000;
      await vi.advanceTimersByTimeAsync(budgetMs - WARNING_BEFORE_MS - 1);
      expect(warnings).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(warnings).toEqual(['sess_1']);
      expect(sidebands[0]!.closeRequests).toBe(0);
      await vi.advanceTimersByTimeAsync(WARNING_BEFORE_MS);
      expect(sidebands[0]!.closeRequests).toBe(1);
      sidebands[0]!.pushClosed({ seconds: 285, reason: 'close_requested' });
      expect(row()).toMatchObject({ state: 'closed' });
    });

    it('после смены локальных суток вчерашний расход не считается', async () => {
      const clock = { date: new Date(2026, 10, 4, 23, 59, 0) };
      const { service, addUsage } = setup({ dailyMinutes: 10, clock });
      addUsage('old', '2026-11-04', 0, 600);
      expect(await service.prepare('o')).toMatchObject({ ok: false, code: 'limit_reached' });
      clock.date = new Date(2026, 10, 5, 0, 1, 0);
      expect((await service.prepare('o')).ok).toBe(true);
    });
  });
});
