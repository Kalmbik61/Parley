import { METHODS } from '@parley/protocol';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { TtsChunk, TtsState } from '../main/assistant/tts.js';
import type { SpeakerChunk } from '../renderer/island/assistant/speaker.js';
import { ISLAND_EVENTS, ISLAND_MARK_SEEN_LIMIT, ISLAND_METHODS, markSeenBatches, ttsAvailable, type IslandTtsChunk, type TtsEngineState } from './island.js';

describe('остров: белый список методов хоста', () => {
  it('добавляет только progress чтение без подписок или новых событий', () => {
    expect(ISLAND_METHODS.has('feed.progress')).toBe(true);
    for (const method of ['feed.subscribe', 'feed.unsubscribe', 'pty.attach', 'pty.input', 'rooms.resolve', 'plans.submit']) expect(ISLAND_METHODS.has(method)).toBe(false);
    expect([...ISLAND_EVENTS]).toEqual(['works.changed', 'rooms.mail', 'activity.changed', 'assistant.changed', 'consents.changed', 'providers.changed', 'voice.session.closed', 'assistant.job.changed']);
  });

  it('пропускает providers.list: без строк провайдеров значки своих провайдеров на острове — значок Parley', () => {
    expect(ISLAND_METHODS.has('providers.list')).toBe(true);
    // Установка, обновление и проверка версий CLI запускают процессы и ходят в сеть: острову не открыты (спека Qwen, §4.2 п. 9).
    for (const method of ['providers.install', 'providers.update', 'providers.checkUpdates']) expect(ISLAND_METHODS.has(method)).toBe(false);
    expect(ISLAND_EVENTS.has('providers.changed')).toBe(true);
  });

  it('Live-голос: остров вызывает prepare/close/usage и получает закрытие сессии', () => {
    for (const method of ['voice.session.prepare', 'voice.session.close', 'voice.usage.get']) expect(ISLAND_METHODS.has(method)).toBe(true);
    for (const method of ['requests.submit', 'requests.list', 'requests.ack', 'jobs.ackInline', 'voice.telemetry.record']) expect(ISLAND_METHODS.has(method)).toBe(true);
    expect(ISLAND_METHODS.has('voice.telemetry.list')).toBe(false);
    expect(ISLAND_EVENTS.has('voice.session.closed')).toBe(true);
  });

  it('каждое имя из ISLAND_METHODS — метод протокола (опечатка не оставит остров без данных молча)', () => {
    const known = new Set<string>(Object.keys(METHODS));
    for (const method of ISLAND_METHODS) expect(known.has(method), method).toBe(true);
  });

  it('согласия на папку: остров вызывает consents.list / consents.decide и получает consents.changed', () => {
    expect(ISLAND_METHODS.has('consents.list')).toBe(true);
    expect(ISLAND_METHODS.has('consents.decide')).toBe(true);
    expect(ISLAND_EVENTS.has('consents.changed')).toBe(true);
  });
});

describe('остров: письма работ', () => {
  it('context.messages разрешён: разрыв версии остров чинит страницами, как главное окно', () => {
    expect(ISLAND_METHODS.has('context.messages')).toBe(true);
  });

  it('rooms.mail в белом списке: без него числа острова застыли бы до следующего структурного снимка (спека rooms.mail, Review Focus 4)', () => {
    expect(ISLAND_EVENTS.has('rooms.mail')).toBe(true);
    expect(ISLAND_EVENTS.has('works.changed')).toBe(true);
  });
});

describe('markSeenBatches: длинный Clear уходит порциями (2026-10-15)', () => {
  const refs = (count: number) => Array.from({ length: count }, (_, at) => ({ projectPath: '/p', workId: 'w-1', sessionId: `s-${at}` }));

  it('пусто — ни одной порции', () => {
    expect(markSeenBatches([])).toEqual([]);
  });

  it('до предела — одна порция, больше — по ISLAND_MARK_SEEN_LIMIT, ничего не теряется', () => {
    expect(markSeenBatches(refs(ISLAND_MARK_SEEN_LIMIT))).toHaveLength(1);
    const batches = markSeenBatches(refs(ISLAND_MARK_SEEN_LIMIT * 2 + 1));
    expect(batches.map((batch) => batch.length)).toEqual([ISLAND_MARK_SEEN_LIMIT, ISLAND_MARK_SEEN_LIMIT, 1]);
    expect(batches.flat()).toEqual(refs(ISLAND_MARK_SEEN_LIMIT * 2 + 1));
  });
});

describe('нейроголос острова (план 3b, B15)', () => {
  it('голос доступен, пока движок готов или говорит; без ключа и при отказе — нет (G3, E6)', () => {
    expect(ttsAvailable({ state: 'ready' })).toBe(true);
    expect(ttsAvailable({ state: 'speaking' })).toBe(true);
    expect(ttsAvailable({ state: 'no-key' })).toBe(false);
    expect(ttsAvailable({ state: 'unavailable', reason: 'the voice engine needs Apple Silicon' })).toBe(false);
  });

  it('типы: кусок и состояние TtsService (B10) — это общие типы, общий кусок годится проигрывателю B14', () => {
    expectTypeOf<TtsChunk>().toEqualTypeOf<IslandTtsChunk>();
    expectTypeOf<TtsState>().toEqualTypeOf<TtsEngineState>();
    expectTypeOf<IslandTtsChunk>().toMatchTypeOf<SpeakerChunk>();
  });
});
