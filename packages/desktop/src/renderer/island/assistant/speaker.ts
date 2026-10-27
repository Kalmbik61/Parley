/**
 * Проигрыватель речи помощника на острове (план 3b B14; план 3 Task 5 — изменён; #9 §6.3). Куски f32 из
 * `island:tts-chunk` становятся `AudioBuffer` с частотой куска, без `decodeAudioData`, и встают встык по `currentTime`
 * на шину голоса общего графа острова (B07). Рот и слои лица читают анализатор этой шины: сигналы идут мимо него (V1).
 */

import { islandSound, type IslandAudioGraph } from '../sound/graph.js';

/** Что проигрывателю нужно от куска `island:tts-chunk` (#9 §6.3): моно f32 с родной частотой движка. */
export interface SpeakerChunk {
  utteranceId: string;
  seq: number;
  sampleRate: number;
  pcm: Float32Array;
}

export interface SpeakerDeps {
  /** Граф окна острова; `null` — Web Audio не завёлся, куски молча пропускаются. */
  graph(): IslandAudioGraph | null;
  /** Миллисекунды: часы спада рта. */
  now(): number;
}

export interface Speaker {
  /** Ставит кусок в хвост: встык к последнему, а если очередь пуста — сразу. */
  enqueue(chunk: SpeakerChunk): void;
  /**
   * Остров попросил озвучить предложение (`island:tts-speak`). Его куски могут быть ещё в пути, когда звучит
   * прошлое: `stop()` глушит и такие предложения.
   */
  expect(utteranceId: string): void;
  /**
   * Глушит всё в тот же такт; опоздавшие куски заглушённых предложений больше не играют (E3) — в том числе
   * предложений из `expect`, чьи куски ещё не дошли.
   */
  stop(): void;
  /** Сорвавшаяся попытка: куски `utteranceId` с `seq ≥ fromSeq` глушатся, повтор встаёт за последним оставленным. */
  discard(utteranceId: string, fromSeq: number): void;
  /** 0…1 по анализатору: атака мгновенная, спад 0,08 с; 0, когда голос молчит. */
  mouth(): number;
  speaking(): boolean;
  /** Очередь опустела и последний источник доиграл. `stop()` и `discard()` его не зовут. */
  onIdle(cb: () => void): () => void;
  /** Предложение начало звучать: один раз на `utteranceId`, когда звучит его первый кусок (Р10). */
  onStart(cb: (utteranceId: string) => void): () => void;
  /** Время и спектр анализатора голоса (fftSize 2048) для лица; `false` и массивы не тронуты, когда голос молчит. */
  read(time: Float32Array<ArrayBuffer>, freq: Float32Array<ArrayBuffer>): boolean;
}

/** Рот по последним 512 отсчётам анализатора: `clamp((rms − 0,02) / 0,25)` (план 3, «Решения»). */
const MOUTH_SAMPLES = 512;
const MOUTH_FLOOR = 0.02;
const MOUTH_RANGE = 0.25;
const MOUTH_RELEASE_MS = 80;

interface Scheduled {
  utteranceId: string;
  seq: number;
  source: AudioBufferSourceNode;
  end: number;
}

const DEFAULT_DEPS: SpeakerDeps = { graph: () => islandSound.graph(), now: () => performance.now() };

export function createSpeaker(deps: SpeakerDeps = DEFAULT_DEPS): Speaker {
  let queue: Scheduled[] = [];
  /** Предложения идут по очереди, поэтому для «один раз на utteranceId» хватает последнего начавшегося. */
  let lastStarted: string | null = null;
  const silenced = new Set<string>();
  /** Запрошенные, но ещё не начавшие звучать предложения. */
  const expected = new Set<string>();
  const idleListeners = new Set<() => void>();
  const startListeners = new Set<(utteranceId: string) => void>();
  let level = 0;
  let levelAt = 0;
  let samples: Float32Array<ArrayBuffer> | null = null;

  function announce(): void {
    const head = queue[0];
    if (!head || head.utteranceId === lastStarted) return;
    lastStarted = head.utteranceId;
    expected.delete(head.utteranceId);
    for (const cb of [...startListeners]) cb(head.utteranceId);
  }

  function finished(item: Scheduled): void {
    queue = queue.filter((other) => other !== item);
    if (queue.length > 0) {
      announce();
      return;
    }
    for (const cb of [...idleListeners]) cb();
  }

  function silence(item: Scheduled): void {
    item.source.onended = null;
    try {
      item.source.stop();
    } catch {
      // Уже остановлен — тишина и так.
    }
  }

  function voiceGraph(): IslandAudioGraph | null {
    return queue.length > 0 ? deps.graph() : null;
  }

  return {
    expect(utteranceId) {
      if (!silenced.has(utteranceId)) expected.add(utteranceId);
    },
    enqueue(chunk) {
      if (chunk.pcm.length === 0 || silenced.has(chunk.utteranceId)) return;
      const graph = deps.graph();
      if (!graph) return;
      const { context } = graph;
      let item: Scheduled;
      try {
        const buffer = context.createBuffer(1, chunk.pcm.length, chunk.sampleRate);
        buffer.getChannelData(0).set(chunk.pcm);
        const source = context.createBufferSource();
        source.buffer = buffer;
        source.connect(graph.voice);
        const last = queue[queue.length - 1];
        const start = Math.max(context.currentTime, last?.end ?? 0);
        source.start(start);
        item = { utteranceId: chunk.utteranceId, seq: chunk.seq, source, end: start + buffer.duration };
      } catch {
        // Кусок, который Web Audio не принял (например, частота вне диапазона), пропускается: следующий играет.
        return;
      }
      item.source.onended = () => finished(item);
      queue.push(item);
      if (queue.length === 1) announce();
    },
    stop() {
      for (const item of queue) {
        silenced.add(item.utteranceId);
        silence(item);
      }
      if (lastStarted !== null) silenced.add(lastStarted);
      for (const utteranceId of expected) silenced.add(utteranceId);
      expected.clear();
      queue = [];
      level = 0;
    },
    discard(utteranceId, fromSeq) {
      const dropped = queue.filter((item) => item.utteranceId === utteranceId && item.seq >= fromSeq);
      for (const item of dropped) silence(item);
      queue = queue.filter((item) => !dropped.includes(item));
    },
    mouth() {
      const analyser = voiceGraph()?.analyser;
      if (!analyser) {
        level = 0;
        return 0;
      }
      if (samples?.length !== analyser.fftSize) samples = new Float32Array(analyser.fftSize);
      analyser.getFloatTimeDomainData(samples);
      const from = Math.max(0, samples.length - MOUTH_SAMPLES);
      let energy = 0;
      for (let index = from; index < samples.length; index += 1) energy += (samples[index] ?? 0) ** 2;
      const rms = Math.sqrt(energy / (samples.length - from));
      const target = Math.min(1, Math.max(0, (rms - MOUTH_FLOOR) / MOUTH_RANGE));
      const now = deps.now();
      level = Math.max(target, level - (now - levelAt) / MOUTH_RELEASE_MS);
      levelAt = now;
      return level;
    },
    speaking() {
      return queue.length > 0;
    },
    onIdle(cb) {
      idleListeners.add(cb);
      return () => idleListeners.delete(cb);
    },
    onStart(cb) {
      startListeners.add(cb);
      return () => startListeners.delete(cb);
    },
    read(time, freq) {
      const analyser = voiceGraph()?.analyser;
      if (!analyser) return false;
      analyser.getFloatTimeDomainData(time);
      analyser.getFloatFrequencyData(freq);
      return true;
    },
  };
}
