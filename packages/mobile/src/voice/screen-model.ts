/**
 * Чистая логика голосового экрана телефона (план голосового экрана, T3): выбор шаблона R15, строка «хода работы»,
 * решение «показать итог и подтвердить» и реакция на смену AppState. Ни React, ни сети.
 */
import type { PhoneJob } from '@parley/protocol/remote';
import type { LiveFailure } from './live-controller.js';
import type { VoiceModel } from './voice-model.js';

export type FallbackReasonR15 = 'mic_denied' | 'limit_reached' | 'no_key' | 'voice_off' | 'mac_unreachable';

export interface FallbackView {
  reason: FallbackReasonR15;
  title: string;
  body: string;
  /** Показывать «Try again»: причина проходит сама только после действия человека (ключ, микрофон, полночь). */
  retry: boolean;
}

export interface FallbackInput {
  voice: VoiceModel;
  /** Соединение с Mac в состоянии ready. */
  reachable: boolean;
  /** `voice.session.prepare` есть в hello.methods (включён remoteVoice). */
  canUseVoice: boolean;
  /** Код последнего отказа `start()`; `null` — отказа нет. */
  failure: LiveFailure | null;
  /** Остаток дневного лимита по `voice.usage.get`, секунды; `null` — не известен. */
  remainingSeconds: number | null;
}

/** «12 min», «45 s», «0 min»: остаток лимита для текста шаблона. */
export function formatRemaining(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return s >= 60 ? `${Math.floor(s / 60)} min` : s === 0 ? '0 min' : `${s} s`;
}

const WRITE = 'Write your request below instead.';

/**
 * Шаблон R15 («голос недоступен: причина + поле текста»). Порядок причин: Mac недоступен, голос выключен на Mac,
 * нет ключа, дневной лимит, нет доступа к микрофону. Внутри открытой сессии шаблона нет: Mac пропал посреди сессии —
 * это подпись под сферой (`orbStateOf`), а не замена экрана.
 */
export function chooseFallback(input: FallbackInput): FallbackView | null {
  const { voice, reachable, canUseVoice, failure, remainingSeconds } = input;
  if (voice.state === 'listening' || voice.state === 'speaking' || voice.state === 'delegating' || voice.state === 'paused') return null;
  if (!reachable || voice.state === 'offline') {
    return { reason: 'mac_unreachable', title: 'Mac not reachable', body: `Voice needs your Mac. ${WRITE}`, retry: false };
  }
  if (!canUseVoice) {
    return { reason: 'voice_off', title: 'Voice is switched off on the Mac', body: `Turn on phone voice in Parley on the Mac. ${WRITE}`, retry: false };
  }
  if (failure === 'no_key') {
    return { reason: 'no_key', title: 'No OpenAI key on the Mac', body: `Add the key in Parley on the Mac. ${WRITE}`, retry: true };
  }
  // Остаток снова положителен (полночь Mac): шаблон снимается, Start доступен.
  if ((voice.state === 'limit_reached' || failure === 'limit_reached') && !(remainingSeconds !== null && remainingSeconds > 0)) {
    const left = remainingSeconds === null ? '' : ` ${formatRemaining(remainingSeconds)} left today.`;
    return { reason: 'limit_reached', title: 'Daily voice limit reached', body: `${left.trim()} ${WRITE}`.trim(), retry: true };
  }
  if (failure === 'mic') {
    return { reason: 'mic_denied', title: 'Microphone access is off', body: `Allow the microphone for Parley in Settings. ${WRITE}`, retry: true };
  }
  return null;
}

/** Строка «ход работы»: состояние последнего job экрана. `submitting` — запрос ушёл, ответа ещё нет. */
export function progressLine(job: PhoneJob | 'submitting' | null): string | null {
  if (job === null) return null;
  if (job === 'submitting') return 'Sending to the Mac…';
  switch (job.state) {
    case 'queued':
      return 'Queued on the Mac';
    case 'running':
      return 'Working on it…';
    case 'needs_confirmation':
      return 'Waiting for your confirmation';
    case 'completed':
      return 'Done';
    case 'failed':
      return 'Failed';
    case 'cancelled':
      return 'Cancelled';
  }
}

export const isTerminalJob = (job: PhoneJob): boolean => job.state === 'completed' || job.state === 'failed' || job.state === 'cancelled';

/** Последний job экрана по времени создания; пустые варианты пропускаются. */
export function latestJob(jobs: ReadonlyArray<PhoneJob | null>): PhoneJob | null {
  let best: PhoneJob | null = null;
  for (const job of jobs) if (job !== null && (best === null || job.createdAt >= best.createdAt)) best = job;
  return best;
}

export interface ResultDecision {
  /** Итог показывается сейчас. */
  show: boolean;
  /** `jobs.ackInline` уходит сейчас: итог показан при приложении на экране. */
  ack: boolean;
}

/**
 * VO-05: итог показывается один раз и только при приложении на переднем плане (в фоне ждёт возвращения); подтверждение
 * уходит вместе с показом, если хост ещё не считает итог доставленным.
 */
export function decideResult(job: PhoneJob | null, foreground: boolean, shown: ReadonlySet<string>): ResultDecision {
  if (job === null || !isTerminalJob(job) || !foreground || shown.has(job.jobId)) return { show: false, ack: false };
  return { show: true, ack: !job.deliveredInline };
}

/** Текст итога под полем: итог job или короткая причина. */
export function resultText(job: PhoneJob): string {
  if (job.state === 'completed') return job.resultSummary !== null && job.resultSummary !== '' ? job.resultSummary : 'Done.';
  if (job.state === 'cancelled') return 'Cancelled.';
  return job.resultSummary !== null && job.resultSummary !== '' ? job.resultSummary : 'The request failed.';
}

export interface AppStateEffects {
  /** Отдать `setForeground`. */
  foreground: boolean;
  /** Закрыть голосовую сессию (микрофон выключен, jobs остаются). */
  stop: boolean;
}

/**
 * `inactive` (шторка, переключатель приложений) сессию не рвёт, но и подтверждений не принимает; закрывает сессию только
 * `background`.
 */
export function appStateEffects(state: string): AppStateEffects {
  return { foreground: state === 'active', stop: state === 'background' };
}

const TEXT_KEY_RE = /^[\w.:-]{1,64}$/;

/** Ключ идемпотентности текстового запроса из свежего UUID; проходит `REMOTE_ID_RE`. */
export function textJobKey(uuid: string): string {
  const key = `txt_${uuid}`;
  return TEXT_KEY_RE.test(key) ? key : `txt_${uuid.replace(/[^\w.:-]/g, '').slice(0, 36)}`;
}

/** После возврата на передний план и `macBack` прошлый отказ стирается; модель выходит из `error` и `limit_reached`. */
export const needsReset = (voice: VoiceModel): boolean => voice.state === 'error' || voice.state === 'limit_reached';

/** m5: тот же текст после сбоя отправляется с прежним ключом (хост не создаст второй job); другой текст — с новым. */
export function keyForText(previous: { text: string; key: string } | null, text: string, fresh: () => string): { text: string; key: string } {
  return previous !== null && previous.text === text ? previous : { text, key: fresh() };
}

/**
 * Сколько экрана занимает клавиатура: от её верхнего края (`screenY`) до низа окна, не меньше 0. Так учтены и
 * аппаратная клавиатура (видна лишь полоска подсказок), и рамка, ушедшая за экран при скрытии.
 */
export function keyboardOverlap(windowHeight: number, screenY: number): number {
  return Math.max(0, windowHeight - screenY);
}

/** Высота нативного таб-бара iOS; ниже неё `insets.bottom` — только индикатор «домой», бар в него не входит. */
export const TAB_BAR_HEIGHT = 56;
const COMPOSER_GAP = 12;
const COMPOSER_GAP_OVER_KEYBOARD = 8;

export interface ComposerSpacing {
  /** Нижний отступ всей страницы: высота клавиатуры, когда она открыта, иначе 0. */
  pageBottom: number;
  /** Нижний отступ внутри панели с полем ввода. */
  composerBottom: number;
}

/**
 * Куда поставить поле ввода. Таб-бар плавает над контентом, поэтому при закрытой клавиатуре низ панели лежит выше бара
 * и нижней safe area. Если `insets.bottom` уже включает бар (UIKit добавляет его в safe area вкладки), второй раз бар
 * не прибавляется. При открытой клавиатуре бар скрыт под ней: страница поднимается на высоту клавиатуры, а safe area
 * и бар не считаются, иначе между полем и клавиатурой возникнет двойной зазор.
 */
export function composerSpacing(insetsBottom: number, keyboardHeight: number): ComposerSpacing {
  if (keyboardHeight > 0) return { pageBottom: keyboardHeight, composerBottom: COMPOSER_GAP_OVER_KEYBOARD };
  const clearOfBar = insetsBottom >= TAB_BAR_HEIGHT ? insetsBottom : insetsBottom + TAB_BAR_HEIGHT;
  return { pageBottom: 0, composerBottom: Math.max(clearOfBar, COMPOSER_GAP) };
}
