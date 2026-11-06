/**
 * Громкость из `RTCPeerConnection.getStats()` (react-native-webrtc 155: `Map` id → отчёт, поля libwebrtc как есть).
 * Голос модели — `inbound-rtp` (audio), микрофон — `media-source` (audio); если у источника уровня нет, берутся
 * `outbound-rtp` и устаревший `track`. Любое отсутствующее или некорректное поле — 0. Чистый TS, без нативных модулей.
 */
export interface AudioLevels {
  /** Голос модели, 0..1. */
  model: number;
  /** Микрофон, 0..1. */
  mic: number;
}

export const NO_LEVELS: AudioLevels = { model: 0, mic: 0 };

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

function levelOf(report: Record<string, unknown>): number | undefined {
  const raw = report['audioLevel'];
  const value = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : Number.NaN;
  return Number.isFinite(value) ? clamp01(value) : undefined;
}

const isAudio = (report: Record<string, unknown>): boolean => (report['kind'] ?? report['mediaType']) === 'audio';

export function parseAudioLevels(stats: unknown): AudioLevels {
  if (!(stats instanceof Map)) return NO_LEVELS;
  let model = 0;
  const mic: Record<'source' | 'outbound' | 'track', number | undefined> = { source: undefined, outbound: undefined, track: undefined };
  const best = (current: number | undefined, level: number | undefined): number | undefined =>
    level === undefined ? current : Math.max(current ?? 0, level);
  for (const report of stats.values() as IterableIterator<unknown>) {
    if (typeof report !== 'object' || report === null) continue;
    const r = report as Record<string, unknown>;
    if (r['type'] === 'inbound-rtp' && isAudio(r)) model = Math.max(model, levelOf(r) ?? 0);
    else if (r['type'] === 'media-source' && isAudio(r)) mic.source = best(mic.source, levelOf(r));
    else if (r['type'] === 'outbound-rtp' && isAudio(r)) mic.outbound = best(mic.outbound, levelOf(r));
    else if (r['type'] === 'track' && isAudio(r) && r['remoteSource'] !== true) mic.track = best(mic.track, levelOf(r));
  }
  return { model, mic: mic.source ?? mic.outbound ?? mic.track ?? 0 };
}

/** Читает уровни; сбой `getStats` даёт тишину, а не ошибку. */
export async function readAudioLevels(peer: { getStats(): Promise<unknown> }): Promise<AudioLevels> {
  try {
    return parseAudioLevels(await peer.getStats());
  } catch {
    return NO_LEVELS;
  }
}
