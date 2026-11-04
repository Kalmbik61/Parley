/**
 * Чистая модель голосовой сессии на телефоне (спека 2026-11-03, §4.1; B4). Ни React, ни сети: только состояния,
 * переходы и соответствие состоянию сферы handoff (docs/design/2026-11-03-jarvis-handoff/ORB_MOTION_SPEC.md).
 * Mac пропал вне сессии (idle, connecting) → `offline`: без Mac сессию не начать (SDP идёт через хост). Mac пропал
 * посреди сессии → Live продолжает говорить, состояние то же, `macReachable=false`: новые делегирования отклоняются,
 * под сферой подпись «Mac not reachable».
 */

export type VoiceState = 'idle' | 'connecting' | 'listening' | 'speaking' | 'delegating' | 'paused' | 'offline' | 'limit_reached' | 'error';

export interface VoiceModel {
  state: VoiceState;
  /** Live готовит ответ (сфера 03). Сбрасывается началом речи, паузой и любым выходом из сессии. */
  thinking: boolean;
  /** Сколько делегирований сейчас идёт; пока > 0, после речи/паузы возвращаемся в `delegating`. */
  delegations: number;
  /** Достижим ли Mac. Внутри сессии `false` не рвёт её, а лишь запрещает делегирование. */
  macReachable: boolean;
}

export type VoiceEvent =
  | { type: 'start' }
  | { type: 'connected' }
  | { type: 'thinking' }
  | { type: 'speechStart' }
  | { type: 'speechEnd' }
  | { type: 'delegateStart' }
  | { type: 'delegateEnd' }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'macLost' }
  | { type: 'macBack' }
  | { type: 'limitReached' }
  | { type: 'fail' }
  | { type: 'stop' };

export const INITIAL_VOICE: VoiceModel = { state: 'idle', thinking: false, delegations: 0, macReachable: true };

/** Подпись «connecting» интерфейс скрывает первые 150 мс, чтобы быстрое подключение не мигало. */
export const CONNECTING_CAPTION_DELAY_MS = 150;

const IN_SESSION: readonly VoiceState[] = ['listening', 'speaking', 'delegating', 'paused'];

const to = (m: VoiceModel, state: VoiceState, patch: Partial<VoiceModel> = {}): VoiceModel => ({ ...m, state, thinking: false, ...patch });
const afterWork = (m: VoiceModel): VoiceState => (m.delegations > 0 ? 'delegating' : 'listening');

/** Недопустимое событие в текущем состоянии игнорируется: возвращается тот же объект. */
export function reduceVoice(m: VoiceModel, e: VoiceEvent): VoiceModel {
  const s = m.state;
  switch (e.type) {
    case 'start':
      return (s === 'idle' || s === 'error') && m.macReachable ? to(m, 'connecting', { delegations: 0 }) : m;
    case 'connected':
      return s === 'connecting' ? to(m, 'listening') : m;
    case 'thinking':
      return s === 'listening' || s === 'delegating' ? { ...m, thinking: true } : m;
    case 'speechStart':
      return s === 'listening' || s === 'delegating' ? to(m, 'speaking') : m;
    case 'speechEnd':
      return s === 'speaking' ? to(m, afterWork(m)) : m;
    case 'delegateStart':
      if (!m.macReachable) return m;
      if (s === 'listening') return to(m, 'delegating', { delegations: m.delegations + 1 });
      if (s === 'delegating') return { ...m, delegations: m.delegations + 1 };
      return s === 'speaking' || s === 'paused' ? { ...m, delegations: m.delegations + 1 } : m;
    case 'delegateEnd': {
      if (!IN_SESSION.includes(s) || m.delegations === 0) return m;
      const next = { ...m, delegations: m.delegations - 1 };
      return s === 'delegating' && next.delegations === 0 ? to(next, 'listening') : next;
    }
    case 'pause':
      return s === 'listening' || s === 'speaking' || s === 'delegating' ? to(m, 'paused') : m;
    case 'resume':
      return s === 'paused' ? to(m, afterWork(m)) : m;
    case 'macLost':
      // Вне сессии (idle, connecting) сессию без Mac не начать (SDP идёт через хост) → offline. Внутри открытой Live
      // продолжает говорить: состояние и счётчик остаются, новые делегирования отклоняются (canDelegate, delegateStart).
      if (s === 'offline' || s === 'limit_reached' || s === 'error') return m;
      if (IN_SESSION.includes(s)) return m.macReachable ? { ...m, macReachable: false } : m;
      return to(m, 'offline', { delegations: 0, macReachable: false });
    case 'macBack':
      if (s === 'offline') return to(m, 'idle', { delegations: 0, macReachable: true });
      return m.macReachable ? m : { ...m, macReachable: true };
    case 'limitReached':
      return s === 'limit_reached' ? m : to(m, 'limit_reached', { delegations: 0 });
    case 'fail':
      return s === 'idle' || s === 'connecting' || IN_SESSION.includes(s) ? to(m, 'error', { delegations: 0 }) : m;
    case 'stop':
      return s === 'idle' ? m : to(m, 'idle', { delegations: 0 });
  }
}

/** Делегировать можно, пока Mac достижим и сессия не закончилась. */
export const canDelegate = (m: VoiceModel): boolean => m.macReachable && IN_SESSION.includes(m.state);

export type OrbId = '01' | '02' | '03' | '04' | '06' | '07' | '09' | '10';

export interface OrbView {
  /** Номер состояния сферы из handoff. 05 и 08 голосом V1 не используются. */
  orb: OrbId;
  /** Подпись под сферой; `null` — без подписи. */
  caption: string | null;
}

/** Работа помощника, видимая телефону: job или карточка ядра. */
export interface VoiceJobView {
  state: 'queued' | 'running' | 'needs_confirmation' | 'completed' | 'failed' | 'cancelled';
  /** Текущий шаг job (его текст, не речь модели). */
  step?: string | null;
}

/**
 * Состояние сферы. `needs_confirmation` перекрывает `delegating` сразу, а заодно и остальные состояния живой сессии
 * (кроме паузы: там подпись «microphone off» важнее); вне сессии (idle, connecting, offline, error, limit) сфера не меняется.
 */
export function orbStateOf(voice: VoiceModel, jobs: readonly VoiceJobView[]): OrbView {
  switch (voice.state) {
    case 'idle':
    case 'limit_reached':
      return { orb: '01', caption: null };
    case 'connecting':
      return { orb: '03', caption: 'connecting' };
    case 'paused':
      return { orb: '01', caption: 'microphone off' };
    case 'offline':
      return { orb: '10', caption: 'Mac not reachable' };
    case 'error':
      return { orb: '09', caption: null };
    default:
      break;
  }
  const view = liveOrb(voice, jobs);
  // Mac пропал посреди сессии: сфера прежняя, подпись «Mac not reachable», если нет более сильной (шаг job).
  return !voice.macReachable && view.caption === null ? { ...view, caption: 'Mac not reachable' } : view;
}

function liveOrb(voice: VoiceModel, jobs: readonly VoiceJobView[]): OrbView {
  if (jobs.some((j) => j.state === 'needs_confirmation')) return { orb: '07', caption: null };
  if (voice.state === 'speaking') return { orb: '06', caption: null };
  if (voice.state === 'delegating') {
    const running = jobs.find((j) => j.state === 'running') ?? jobs.find((j) => j.state === 'queued');
    return { orb: '04', caption: running?.step ?? null };
  }
  return voice.thinking ? { orb: '03', caption: null } : { orb: '02', caption: null };
}

export type FallbackReason = 'limit_reached' | 'no_key' | 'remote_voice_off';

export interface VoiceAvailability {
  /** На Mac нет ключа OpenAI. */
  noKey?: boolean;
  /** Настройка remoteVoice на Mac выключена («голос с телефона выключен»). */
  remoteVoiceOff?: boolean;
}

/**
 * Нужен ли экран R15 («голос недоступен: причина + Write as text») и почему. Один общий шаблон; причины в порядке
 * убывания: настройка выключена, нет ключа, дневной лимит.
 */
export function fallbackScreen(voice: VoiceModel, availability: VoiceAvailability = {}): { reason: FallbackReason } | null {
  if (availability.remoteVoiceOff === true) return { reason: 'remote_voice_off' };
  if (availability.noKey === true) return { reason: 'no_key' };
  if (voice.state === 'limit_reached') return { reason: 'limit_reached' };
  return null;
}
