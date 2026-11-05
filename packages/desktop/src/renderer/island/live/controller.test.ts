import { describe, expect, it, vi } from 'vitest';
import { LIVE_MESSAGES, createLiveController, type LiveControllerDeps, type LiveControllerEvent, type LiveDataChannel, type LivePeer } from './controller.js';

class FakeChannel implements LiveDataChannel {
  readyState = 'connecting';
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  sent: string[] = [];
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 'closed';
  }
  open(): void {
    this.readyState = 'open';
    this.onopen?.();
  }
  receive(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

class FakePeer implements LivePeer {
  connectionState = 'new';
  localDescription: { sdp?: string } | null = null;
  onconnectionstatechange: (() => void) | null = null;
  ontrack: ((event: { streams: readonly unknown[] }) => void) | null = null;
  channel = new FakeChannel();
  tracks: unknown[] = [];
  closed = false;
  remote: string | null = null;
  addTrack(track: unknown): void {
    this.tracks.push(track);
  }
  createDataChannel(): FakeChannel {
    return this.channel;
  }
  async createOffer(): Promise<unknown> {
    return { type: 'offer', sdp: 'offer-sdp' };
  }
  async setLocalDescription(): Promise<void> {
    this.localDescription = { sdp: 'offer-sdp' };
  }
  async setRemoteDescription(description: { type: 'answer'; sdp: string }): Promise<void> {
    this.remote = description.sdp;
    // ответ принят — через тик канал данных открывается
    queueMicrotask(() => this.channel.open());
  }
  close(): void {
    this.closed = true;
  }
}

const setup = (options: { prepare?: unknown; mic?: boolean; openMicError?: boolean } = {}) => {
  const peer = new FakePeer();
  const track = { stop: vi.fn() };
  const micLevel = { value: 0 };
  const remoteLevel = { value: 0 };
  const clock = { now: 0 };
  const ticks: Array<() => void> = [];
  const hostListeners: Array<(data: { voiceSessionId: string; reason: string }) => void> = [];
  const call = vi.fn(async (method: string) => {
    if (method === 'voice.session.prepare') return options.prepare ?? { ok: true, voiceSessionId: 'live_1', sdpAnswer: 'answer-sdp' };
    return { closed: true };
  });
  const sink = { attach: vi.fn(), stop: vi.fn() };
  const meters: Array<{ stopped: boolean }> = [];
  const deps = {
    call,
    onHostEvent: (event: string, listener: (data: { voiceSessionId: string; reason: string }) => void) => {
      if (event === 'voice.session.closed') hostListeners.push(listener);
      return () => {};
    },
    ensureMic: async () => options.mic !== false,
    openMic: async () => {
      if (options.openMicError === true) throw new Error('denied');
      return { getAudioTracks: () => [track] };
    },
    createPeer: () => peer,
    meter: (stream: unknown) => {
      const state = { stopped: false };
      meters.push(state);
      return {
        read: () => (stream === 'remote' ? remoteLevel.value : micLevel.value),
        ...(stream === 'remote' ? { frame: (time: Float32Array, freq: Float32Array) => (time.fill(0.5), freq.fill(-30), true) } : {}),
        stop: () => void (state.stopped = true),
      };
    },
    sink: () => sink,
    now: () => clock.now,
    setTick: (callback: () => void) => {
      ticks.push(callback);
      return () => {};
    },
    setTimer: () => () => {},
  } as unknown as LiveControllerDeps;
  const controller = createLiveController(deps);
  const events: LiveControllerEvent[] = [];
  controller.subscribe((event) => events.push(event));
  const tickAt = (ms: number): void => {
    clock.now = ms;
    for (const tick of ticks) tick();
  };
  return { controller, peer, track, call, sink, events, micLevel, remoteLevel, tickAt, hostListeners, meters };
};

describe('createLiveController: запуск', () => {
  it('создаёт сессию на хосте по SDP-офферу, ставит ответ и переходит в live; ключа в контроллере нет', async () => {
    const { controller, peer, call, events } = setup();
    const result = await controller.start();
    expect(result).toEqual({ ok: true, voiceSessionId: 'live_1' });
    expect(call).toHaveBeenCalledWith('voice.session.prepare', { sdp: 'offer-sdp' });
    expect(peer.remote).toBe('answer-sdp');
    expect(peer.tracks).toHaveLength(1);
    expect(controller.snapshot()).toMatchObject({ phase: 'live', voiceSessionId: 'live_1' });
    expect(events.filter((e) => e.type === 'phase').map((e) => (e as { phase: string }).phase)).toEqual(['connecting', 'live']);
  });

  it('VA-13: нет ключа и лимит исчерпан — понятный отказ, фаза возвращается в idle, микрофон освобождён', async () => {
    for (const code of ['no_key', 'limit_reached', 'busy'] as const) {
      const { controller, track, peer } = setup({ prepare: { ok: false, code, message: 'internal details' } });
      const result = await controller.start();
      expect(result).toEqual({ ok: false, code, message: LIVE_MESSAGES[code] });
      expect(controller.snapshot().phase).toBe('idle');
      expect(track.stop).toHaveBeenCalled();
      expect(peer.closed).toBe(true);
    }
  });

  it('прочий отказ хоста — общее сообщение, текст хоста наружу не идёт', async () => {
    const { controller } = setup({ prepare: { ok: false, code: 'failed', message: 'secret internals' } });
    const result = await controller.start();
    expect(result).toEqual({ ok: false, code: 'failed', message: LIVE_MESSAGES.failed });
  });

  it('нет доступа к микрофону — mic, к хосту не ходим', async () => {
    const denied = setup({ mic: false });
    expect(await denied.controller.start()).toMatchObject({ ok: false, code: 'mic' });
    expect(denied.call).not.toHaveBeenCalled();
    const broken = setup({ openMicError: true });
    expect(await broken.controller.start()).toMatchObject({ ok: false, code: 'mic' });
    expect(broken.controller.snapshot().phase).toBe('idle');
  });

  it('второй start во время сессии — busy', async () => {
    const { controller } = setup();
    await controller.start();
    expect(await controller.start()).toMatchObject({ ok: false, code: 'busy' });
    expect(controller.snapshot().phase).toBe('live');
  });
});

describe('createLiveController: события канала данных', () => {
  it('отдаёт delegationCreated, транскрипты; повтор event_id (два канала) отсекается', async () => {
    const { controller, peer, events } = setup();
    await controller.start();
    const created = { type: 'session.delegation.created', offset_ms: 5600, delegation: { id: 'item_1', type: 'delegation', target: 'client' }, event_id: 'e1' };
    peer.channel.receive(created);
    peer.channel.receive(created);
    peer.channel.receive({ type: 'session.input_transcript.delta', start_ms: 2800, end_ms: 3000, delta: ' Please', event_id: 'e2' });
    peer.channel.receive({ type: 'session.output_transcript.delta', start_ms: 6000, end_ms: 6200, delta: ' Okay,', event_id: 'e3' });
    expect(events.filter((e) => e.type === 'delegationCreated')).toEqual([{ type: 'delegationCreated', delegationId: 'item_1', offsetMs: 5600 }]);
    expect(events).toContainEqual({ type: 'inputTranscript', text: ' Please', startMs: 2800, endMs: 3000 });
    expect(events).toContainEqual({ type: 'outputTranscript', text: ' Okay,', startMs: 6000, endMs: 6200 });
    expect(controller.snapshot().phase).toBe('live');
  });

  it('session.closed по каналу закрывает сессию один раз; событие хоста о том же закрытии не дублирует', async () => {
    const { controller, peer, events, track, hostListeners } = setup();
    await controller.start();
    peer.channel.receive({ type: 'session.closed', reason: 'expired', event_id: 'c1' });
    hostListeners[0]?.({ voiceSessionId: 'live_1', reason: 'expired' });
    expect(events.filter((e) => e.type === 'sessionClosed')).toEqual([{ type: 'sessionClosed', reason: 'expired' }]);
    expect(controller.snapshot()).toMatchObject({ phase: 'idle', voiceSessionId: null });
    expect(peer.closed).toBe(true);
    expect(track.stop).toHaveBeenCalled();
  });

  it('закрытие хостом (лимит) закрывает сессию с причиной', async () => {
    const { controller, events, hostListeners } = setup();
    await controller.start();
    hostListeners[0]?.({ voiceSessionId: 'other', reason: 'time_limit' });
    expect(controller.snapshot().phase).toBe('live');
    hostListeners[0]?.({ voiceSessionId: 'live_1', reason: 'time_limit' });
    expect(events).toContainEqual({ type: 'sessionClosed', reason: 'time_limit' });
    expect(controller.snapshot().phase).toBe('idle');
  });

  it('обрыв соединения закрывает сессию на хосте и сообщает connection_lost', async () => {
    const { controller, peer, events, call } = setup();
    await controller.start();
    peer.connectionState = 'failed';
    peer.onconnectionstatechange?.();
    expect(events).toContainEqual({ type: 'sessionClosed', reason: 'connection_lost' });
    expect(call).toHaveBeenCalledWith('voice.session.close', { voiceSessionId: 'live_1' });
  });

  it('ошибка протокола уходит наружу как error', async () => {
    const { controller, peer, events } = setup();
    await controller.start();
    peer.channel.receive({ type: 'error', error: { code: 'bad', message: 'oops' }, event_id: 'x' });
    expect(events).toContainEqual({ type: 'error', code: 'bad', message: 'oops' });
  });
});

describe('createLiveController: сигналы речи', () => {
  it('humanSpeaking: микрофон выше порога включает, тишина 300 мс гасит', async () => {
    const { controller, events, micLevel, tickAt } = setup();
    await controller.start();
    micLevel.value = 0.05;
    tickAt(1000);
    tickAt(1040);
    expect(controller.snapshot().humanSpeaking).toBe(false);
    tickAt(1080);
    expect(controller.snapshot().humanSpeaking).toBe(true);
    micLevel.value = 0;
    tickAt(1200);
    expect(controller.snapshot().humanSpeaking).toBe(true);
    tickAt(1500);
    expect(controller.snapshot().humanSpeaking).toBe(false);
    expect(events.filter((e) => e.type === 'humanSpeaking')).toEqual([
      { type: 'humanSpeaking', value: true },
      { type: 'humanSpeaking', value: false },
    ]);
  });

  it('modelPlaying: берёт уровень удалённого трека, гасит не раньше 500 мс тишины', async () => {
    const { controller, peer, remoteLevel, tickAt, sink } = setup();
    await controller.start();
    peer.ontrack?.({ streams: ['remote'] });
    expect(sink.attach).toHaveBeenCalledWith('remote');
    remoteLevel.value = 0.05;
    tickAt(2000);
    expect(controller.snapshot().modelPlaying).toBe(true);
    remoteLevel.value = 0;
    tickAt(2100);
    tickAt(2599);
    expect(controller.snapshot().modelPlaying).toBe(true);
    tickAt(2600);
    expect(controller.snapshot().modelPlaying).toBe(false);
  });

  it('readVoice: отдаёт данные анализатора удалённого трека, пока трека нет или сессия закрыта — false', async () => {
    const { controller, peer } = setup();
    const time = new Float32Array(4);
    const freq = new Float32Array(2);
    expect(controller.readVoice(time, freq)).toBe(false);
    await controller.start();
    expect(controller.readVoice(time, freq)).toBe(false);
    peer.ontrack?.({ streams: ['remote'] });
    expect(controller.readVoice(time, freq)).toBe(true);
    expect([...time]).toEqual([0.5, 0.5, 0.5, 0.5]);
    expect([...freq]).toEqual([-30, -30]);
    peer.channel.receive({ type: 'session.closed', reason: 'close_requested' });
    expect(controller.readVoice(time, freq)).toBe(false);
  });

  it('сигналы гаснут при закрытии сессии', async () => {
    const { controller, peer, micLevel, tickAt } = setup();
    await controller.start();
    micLevel.value = 0.1;
    tickAt(0);
    tickAt(100);
    expect(controller.snapshot().humanSpeaking).toBe(true);
    peer.channel.receive({ type: 'session.closed', reason: 'close_requested' });
    expect(controller.snapshot()).toMatchObject({ humanSpeaking: false, modelPlaying: false });
  });
});

describe('createLiveController: отправка append и остановка', () => {
  it('thinking/commentary append уходят по каналу с delegation_id и растущим event_id', async () => {
    const { controller, peer } = setup();
    expect(controller.sendAppend({ kind: 'thinking', delegationId: 'item_1', content: 'x' })).toBe(false);
    await controller.start();
    expect(controller.sendAppend({ kind: 'thinking', delegationId: 'item_1', content: 'Progress' })).toBe(true);
    expect(controller.sendAppend({ kind: 'commentary', delegationId: null, content: '' })).toBe(true);
    const [first, second] = peer.channel.sent.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(first).toEqual({ type: 'session.thinking.append', event_id: 'island_1', delegation_id: 'item_1', content: 'Progress' });
    expect(second).toMatchObject({ type: 'session.commentary.append', event_id: 'island_2', delegation_id: null });
  });

  it('stop закрывает сессию на хосте и освобождает микрофон, трек и канал', async () => {
    const { controller, peer, call, track, events, sink } = setup();
    await controller.start();
    await controller.stop();
    expect(call).toHaveBeenCalledWith('voice.session.close', { voiceSessionId: 'live_1' });
    expect(peer.closed).toBe(true);
    expect(track.stop).toHaveBeenCalled();
    expect(sink.stop).toHaveBeenCalled();
    expect(events).toContainEqual({ type: 'sessionClosed', reason: 'close_requested' });
    expect(controller.snapshot().phase).toBe('idle');
    // после остановки можно начать заново
    expect((await controller.start()).ok).toBe(true);
  });

  it('stop(idle_timeout): причина закрытия по тишине сохраняется, даже если событие хоста пришло раньше с другой', async () => {
    const { controller, events, call, hostListeners } = setup();
    await controller.start();
    call.mockImplementationOnce(async () => {
      // Хост закрыл сессию и разослал событие, пока `voice.session.close` ещё не вернулся.
      for (const listener of hostListeners) listener({ voiceSessionId: 'live_1', reason: 'close_requested' });
      return { closed: true };
    });
    await controller.stop('idle_timeout');
    expect(events.filter((event) => event.type === 'sessionClosed')).toEqual([{ type: 'sessionClosed', reason: 'idle_timeout' }]);
    // Следующая сессия снова закрывается обычной причиной.
    await controller.start();
    await controller.stop();
    expect(events.filter((event) => event.type === 'sessionClosed').at(-1)).toEqual({ type: 'sessionClosed', reason: 'close_requested' });
  });

  it('stop при ошибке хоста всё равно закрывает локально', async () => {
    const { controller, call, peer } = setup();
    await controller.start();
    call.mockImplementationOnce(async () => {
      throw new Error('host down');
    });
    await controller.stop();
    expect(peer.closed).toBe(true);
    expect(controller.snapshot().phase).toBe('idle');
  });

  it('перебивание не блокируется: контроллер ничего не отправляет и не глушит при humanSpeaking', async () => {
    const { controller, peer, micLevel, remoteLevel, tickAt } = setup();
    await controller.start();
    peer.ontrack?.({ streams: ['remote'] });
    remoteLevel.value = 0.1;
    micLevel.value = 0.1;
    tickAt(0);
    tickAt(100);
    expect(controller.snapshot()).toMatchObject({ humanSpeaking: true, modelPlaying: true });
    expect(peer.channel.sent).toEqual([]);
  });
});
