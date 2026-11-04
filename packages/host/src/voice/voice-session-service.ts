/**
 * Хостовый сервис голосовых сессий GPT-Live (спека 2026-11-03, B2): одна сессия на хост, лимит 30 минут с
 * предупреждением за 2, учёт секунд в `voice_usage`. Ключ API сюда не попадает: с OpenAI говорит только live-client.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { LiveClient, Sideband } from './live-client.js';
import { LiveError } from './live-client.js';
import { DEFAULT_DAILY_MINUTES, dailyBudget, localDay } from './budget.js';

export const MAX_SESSION_MS = 30 * 60_000;
export const WARNING_BEFORE_MS = 2 * 60_000;
/** Ждём `session.closed` долго: очередь ответов сливается, финальный usage приходит только в нём. */
export const CLOSE_WAIT_MS = 20_000;
/**
 * OpenAI тарифицирует 15 секунд голоса при инициализации WebRTC-сессии (документация OpenAI, live-conversations / pricing,
 * сверено 2026-11-04), поэтому оценка стартует с 15, а не с 0, и даже мгновенно закрытая сессия не выглядит бесплатной.
 */
export const INIT_BILLED_SECONDS = 15;
/** Сколько раз пробуем подключить sideband, прежде чем признать сессию неуправляемой. */
export const ATTACH_ATTEMPTS = 3;
/** Паузы перед 2-й и 3-й попыткой первого подключения sideband. */
export const ATTACH_DELAYS_MS = [250, 1_000];
/** Паузы перед попытками переподключения оборвавшегося sideband; когда они кончились, сессия считается потерянной. */
export const RECONNECT_DELAYS_MS = [500, 2_000, 5_000, 10_000];

export type PrepareResult =
  | { ok: true; voiceSessionId: string; sdpAnswer: string }
  | { ok: false; code: 'busy' | 'no_key' | 'failed' | 'limit_reached'; message: string };

export interface VoiceSessionEvents {
  /** За две минуты до лимита. */
  onWarning?(voiceSessionId: string): void;
  /** Сессия закрыта (любая причина). */
  onClosed?(voiceSessionId: string, reason: string): void;
}

export interface VoiceSessionServiceDeps extends VoiceSessionEvents {
  db: DatabaseSync;
  live: LiveClient;
  now?: () => Date;
  /** Дневной лимит в минутах (конфиг voiceDailyMinutes); читается при каждом prepare. */
  dailyMinutes?: () => number;
  closeWaitMs?: number;
  attachDelaysMs?: number[];
  reconnectDelaysMs?: number[];
}

export interface VoiceSessionService {
  prepare(sdpOffer: string): Promise<PrepareResult>;
  /** Закрывает сессию; false, если такой активной нет. */
  close(voiceSessionId: string): Promise<boolean>;
  activeSessionId(): string | null;
}

interface Active {
  voiceSessionId: string;
  sideband: Sideband | null;
  estimate: number;
  timers: Array<ReturnType<typeof setTimeout>>;
  finished: boolean;
  /** Выдаём id наружу только после того, как prepare закончил. */
  ready: boolean;
  /** Закрытие запрошено, пока sideband был оборван: отправим сразу после переподключения. */
  closeWanted: string | null;
  closedWaiters: Array<() => void>;
}

export function createVoiceSessionService(deps: VoiceSessionServiceDeps): VoiceSessionService {
  const { db, live } = deps;
  const now = deps.now ?? (() => new Date());
  const dailyMinutes = deps.dailyMinutes ?? (() => DEFAULT_DAILY_MINUTES);
  const closeWaitMs = deps.closeWaitMs ?? CLOSE_WAIT_MS;
  const attachDelaysMs = deps.attachDelaysMs ?? ATTACH_DELAYS_MS;
  const reconnectDelaysMs = deps.reconnectDelaysMs ?? RECONNECT_DELAYS_MS;
  let active: Active | null = null;

  const sleep = (ms: number): Promise<void> => (ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms)));

  /**
   * `incomplete`: финал не получен (обрыв, таймаут закрытия). Тогда `seconds_final` остаётся NULL, а оценка лежит в
   * `seconds_estimate`: считать её итогом нельзя.
   */
  const finish = (session: Active, reason: string, seconds: number | null, incomplete = false): void => {
    if (session.finished) return;
    session.finished = true;
    for (const timer of session.timers) clearTimeout(timer);
    session.timers = [];
    try {
      session.sideband?.dispose();
    } catch {
      // сокет уже закрыт
    }
    try {
      const final = incomplete ? null : (seconds ?? session.estimate);
      db.prepare("UPDATE voice_usage SET seconds_final = ?, close_reason = ?, state = 'closed' WHERE voice_session_id = ?").run(final, reason, session.voiceSessionId);
    } catch {
      // учёт недоступен: слот всё равно освобождаем, иначе хост навсегда «занят»
    } finally {
      if (active === session) active = null;
      for (const resolve of session.closedWaiters.splice(0)) resolve();
      deps.onClosed?.(session.voiceSessionId, reason);
    }
  };

  /** Запрашивает закрытие через sideband; ждёт `session.closed` ограниченное время, потом помечает финал неполным. */
  const requestClose = async (session: Active, reason: string): Promise<void> => {
    if (session.finished) return;
    const closed = new Promise<void>((resolve) => session.closedWaiters.push(resolve));
    if (session.sideband !== null) session.sideband.requestClose();
    else session.closeWanted = reason;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, closeWaitMs);
    });
    await Promise.race([closed, timeout]);
    clearTimeout(timer);
    finish(session, 'close_timeout', null, true);
  };

  const wire = (session: Active, sideband: Sideband): void => {
    session.sideband = sideband;
    sideband.onUsage((seconds) => {
      // Накопленное значение: заменяем, не складываем.
      session.estimate = seconds;
      try {
        db.prepare('UPDATE voice_usage SET seconds_estimate = ? WHERE voice_session_id = ?').run(seconds, session.voiceSessionId);
      } catch {
        // исключение из обработчика сокета стало бы необработанным
      }
    });
    sideband.onClosed((closed) => finish(session, closed.reason, closed.seconds));
    sideband.onDisconnected(() => {
      if (session.finished) return;
      session.sideband = null;
      void reconnect(session);
    });
  };

  /** Sideband оборвался, а сессия у OpenAI может жить: слот и таймеры держим, подключаемся заново. */
  const reconnect = async (session: Active): Promise<void> => {
    for (const delay of reconnectDelaysMs) {
      await sleep(delay);
      if (session.finished) return;
      try {
        const sideband = await live.attach(session.voiceSessionId);
        if (session.finished) {
          sideband.dispose();
          return;
        }
        wire(session, sideband);
        if (session.closeWanted !== null) sideband.requestClose();
        return;
      } catch {
        // следующая попытка
      }
    }
    finish(session, 'sideband_lost', null, true);
  };

  /**
   * Сессия у OpenAI создана, но запустить её нельзя (не записался учёт или не подключился sideband). Закрываем через
   * sideband, если он есть; иначе помечаем запись брошенной и громко сообщаем: сессия может тарифицироваться до истечения.
   */
  const abandon = async (session: Active, sideband: Sideband | null, insertFailed: boolean): Promise<PrepareResult> => {
    const id = session.voiceSessionId;
    let reason = 'unclosed_orphan';
    let message = `Voice session ${id} could not be closed on OpenAI; it may keep billing until it expires`;
    if (sideband !== null) {
      const closed = new Promise<void>((resolve) => sideband.onClosed(() => resolve()));
      sideband.requestClose();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, closeWaitMs);
      });
      await Promise.race([closed, timeout]);
      clearTimeout(timer);
      try {
        sideband.dispose();
      } catch {
        // сокет уже закрыт
      }
      reason = insertFailed ? 'usage_insert_failed' : 'start_failed';
      message = 'Voice session failed to start';
    }
    try {
      db.prepare("UPDATE voice_usage SET seconds_final = ?, close_reason = ?, state = 'closed' WHERE voice_session_id = ?").run(session.estimate, reason, id);
    } catch {
      // учёт недоступен: сообщение об ошибке ниже — единственный след
    }
    if (active === session) active = null;
    session.finished = true;
    deps.onClosed?.(id, reason);
    return { ok: false, code: 'failed', message };
  };

  return {
    async prepare(sdpOffer) {
      if (active !== null) return { ok: false, code: 'busy', message: 'A voice session is already active' };
      // Бюджет исчерпан: к OpenAI не ходим. Проверка синхронная, поэтому до занятия слота.
      try {
        if (dailyBudget(db, dailyMinutes(), now()).remainingSeconds <= 0) return { ok: false, code: 'limit_reached', message: 'Daily voice limit reached' };
      } catch {
        // учёт недоступен: лимит не знаем, не блокируем голос из-за этого
      }
      // Слот занимаем синхронно, до первого await: два одновременных prepare не пройдут оба.
      const session: Active = { voiceSessionId: '', sideband: null, estimate: INIT_BILLED_SECONDS, timers: [], finished: false, ready: false, closeWanted: null, closedWaiters: [] };
      active = session;
      let created: { sessionId: string; sdpAnswer: string };
      // Ответ создания без SDP, но с id: сессия у OpenAI есть, её нужно закрыть по id.
      let unusable = false;
      try {
        created = await live.createSession(sdpOffer);
      } catch (error) {
        if (error instanceof LiveError && error.sessionId !== undefined) {
          created = { sessionId: error.sessionId, sdpAnswer: '' };
          unusable = true;
        } else {
          active = null;
          if (error instanceof LiveError) return { ok: false, code: error.code === 'no_key' ? 'no_key' : 'failed', message: error.message };
          return { ok: false, code: 'failed', message: 'Voice session failed to start' };
        }
      }
      // С этого места сессия у OpenAI создана и тарифицируется: любой сбой обязан её закрыть или пометить брошенной.
      session.voiceSessionId = created.sessionId;
      let insertFailed = false;
      try {
        db.prepare("INSERT INTO voice_usage (voice_session_id, day, state, seconds_estimate) VALUES (?, ?, 'open', ?)").run(created.sessionId, localDay(now()), INIT_BILLED_SECONDS);
      } catch {
        insertFailed = true;
      }
      let sideband: Sideband | null = null;
      for (let attempt = 0; attempt < ATTACH_ATTEMPTS && sideband === null; attempt += 1) {
        if (attempt > 0) await sleep(attachDelaysMs[attempt - 1] ?? 1_000);
        try {
          sideband = await live.attach(created.sessionId);
        } catch {
          sideband = null;
        }
      }
      if (unusable || insertFailed || sideband === null) return abandon(session, sideband, insertFailed);
      wire(session, sideband);
      // Сессия живёт до меньшего из лимита сессии и остатка дневного бюджета (в остатке уже учтена стартовая оценка).
      let budgetMs = MAX_SESSION_MS;
      try {
        budgetMs = Math.min(MAX_SESSION_MS, dailyBudget(db, dailyMinutes(), now()).remainingSeconds * 1000);
      } catch {
        // остаётся лимит сессии
      }
      const reason = budgetMs < MAX_SESSION_MS ? 'daily_limit' : 'time_limit';
      session.timers.push(setTimeout(() => deps.onWarning?.(session.voiceSessionId), Math.max(0, budgetMs - WARNING_BEFORE_MS)));
      session.timers.push(setTimeout(() => void requestClose(session, reason).catch(() => {}), budgetMs));
      session.ready = true;
      return { ok: true, voiceSessionId: created.sessionId, sdpAnswer: created.sdpAnswer };
    },

    async close(voiceSessionId) {
      const session = active;
      if (session === null || !session.ready || session.voiceSessionId !== voiceSessionId) return false;
      await requestClose(session, 'close_requested');
      return true;
    },

    activeSessionId: () => (active !== null && active.ready ? active.voiceSessionId : null),
  };
}
