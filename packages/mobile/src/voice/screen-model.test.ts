import { describe, expect, it } from 'vitest';
import type { PhoneJob } from '@parley/protocol/remote';
import {
  appStateEffects,
  chooseFallback,
  composerSpacing,
  TAB_BAR_HEIGHT,
  decideResult,
  formatRemaining,
  keyForText,
  needsReset,
  latestJob,
  progressLine,
  resultText,
  textJobKey,
  type FallbackInput,
} from './screen-model.js';
import { INITIAL_VOICE, type VoiceModel, type VoiceState } from './voice-model.js';

const voice = (state: VoiceState): VoiceModel => ({ ...INITIAL_VOICE, state });
const input = (patch: Partial<FallbackInput> = {}): FallbackInput => ({ voice: voice('idle'), reachable: true, canUseVoice: true, failure: null, remainingSeconds: null, ...patch });
const job = (patch: Partial<PhoneJob> = {}): PhoneJob => ({
  jobId: 'j1',
  origin: 'mobile',
  state: 'running',
  revision: 1,
  requestText: 'x',
  resultSummary: null,
  provider: 'claude',
  createdAt: 1,
  updatedAt: 1,
  deliveredInline: false,
  correlation: { mode: 'text' },
  ...patch,
});

describe('chooseFallback (R15)', () => {
  it('нормальное состояние: шаблона нет', () => {
    expect(chooseFallback(input())).toBeNull();
  });
  it('Mac недоступен', () => {
    expect(chooseFallback(input({ reachable: false }))?.reason).toBe('mac_unreachable');
    expect(chooseFallback(input({ voice: voice('offline') }))?.reason).toBe('mac_unreachable');
  });
  it('голос выключен на Mac (canUseVoice=false)', () => {
    expect(chooseFallback(input({ canUseVoice: false }))?.reason).toBe('voice_off');
  });
  it('нет ключа на Mac', () => {
    expect(chooseFallback(input({ failure: 'no_key', voice: voice('error') }))?.reason).toBe('no_key');
  });
  it('дневной лимит с остатком из voice.usage.get', () => {
    const view = chooseFallback(input({ voice: voice('limit_reached'), failure: 'limit_reached', remainingSeconds: 0 }));
    expect(view?.reason).toBe('limit_reached');
    expect(view?.body).toContain('0 min left today');
  });
  it('нет доступа к микрофону', () => {
    expect(chooseFallback(input({ failure: 'mic', voice: voice('error') }))?.reason).toBe('mic_denied');
  });
  it('busy и failed не R15: ошибка видна на сфере', () => {
    expect(chooseFallback(input({ failure: 'busy', voice: voice('error') }))).toBeNull();
    expect(chooseFallback(input({ failure: 'failed', voice: voice('error') }))).toBeNull();
  });
  it('внутри сессии шаблона нет, даже если Mac пропал', () => {
    expect(chooseFallback(input({ voice: voice('listening'), reachable: false }))).toBeNull();
  });
  it('каждый шаблон предлагает написать текстом', () => {
    for (const patch of [{ reachable: false }, { canUseVoice: false }, { failure: 'no_key' as const }, { failure: 'mic' as const }, { voice: voice('limit_reached') }]) {
      expect(chooseFallback(input(patch))?.body).toContain('Write your request below');
    }
  });
  it('formatRemaining', () => {
    expect(formatRemaining(0)).toBe('0 min');
    expect(formatRemaining(45)).toBe('45 s');
    expect(formatRemaining(725)).toBe('12 min');
  });
});

describe('progressLine', () => {
  it('состояния job', () => {
    expect(progressLine(null)).toBeNull();
    expect(progressLine('submitting')).toBe('Sending to the Mac…');
    expect(progressLine(job({ state: 'queued' }))).toBe('Queued on the Mac');
    expect(progressLine(job({ state: 'running' }))).toBe('Working on it…');
    expect(progressLine(job({ state: 'needs_confirmation' }))).toBe('Waiting for your confirmation');
    expect(progressLine(job({ state: 'completed' }))).toBe('Done');
    expect(progressLine(job({ state: 'failed' }))).toBe('Failed');
  });
  it('latestJob берёт самый новый по созданию', () => {
    expect(latestJob([null, job({ jobId: 'a', createdAt: 1 }), job({ jobId: 'b', createdAt: 5 })])?.jobId).toBe('b');
    expect(latestJob([null])).toBeNull();
  });
});

describe('decideResult (VO-05)', () => {
  const done = job({ state: 'completed', resultSummary: 'ok' });
  it('итог показывается один раз и подтверждается', () => {
    expect(decideResult(done, true, new Set())).toEqual({ show: true, ack: true });
    expect(decideResult(done, true, new Set(['j1']))).toEqual({ show: false, ack: false });
  });
  it('в фоне итог ждёт: не показан и не подтверждён', () => {
    expect(decideResult(done, false, new Set())).toEqual({ show: false, ack: false });
  });
  it('уже доставленный вслух итог показывается без подтверждения', () => {
    expect(decideResult(job({ state: 'completed', deliveredInline: true }), true, new Set())).toEqual({ show: true, ack: false });
  });
  it('job в работе итога не даёт', () => {
    expect(decideResult(job(), true, new Set())).toEqual({ show: false, ack: false });
    expect(decideResult(null, true, new Set())).toEqual({ show: false, ack: false });
  });
  it('resultText', () => {
    expect(resultText(done)).toBe('ok');
    expect(resultText(job({ state: 'failed' }))).toBe('The request failed.');
  });
});

describe('appStateEffects', () => {
  it('background закрывает сессию, active возвращает передний план, inactive не рвёт сессию', () => {
    expect(appStateEffects('background')).toEqual({ foreground: false, stop: true });
    expect(appStateEffects('active')).toEqual({ foreground: true, stop: false });
    expect(appStateEffects('inactive')).toEqual({ foreground: false, stop: false });
  });
});

describe('textJobKey', () => {
  it('ключ проходит REMOTE_ID_RE', () => {
    expect(textJobKey('123e4567-e89b-12d3-a456-426614174000')).toMatch(/^[\w.:-]{1,64}$/);
  });
});

describe('M5: повтор после отказа R15', () => {
  it('Try again у no_key, mic и лимита; у voice_off и недоступного Mac его нет', () => {
    expect(chooseFallback(input({ failure: 'no_key', voice: voice('error') }))?.retry).toBe(true);
    expect(chooseFallback(input({ failure: 'mic', voice: voice('error') }))?.retry).toBe(true);
    expect(chooseFallback(input({ voice: voice('limit_reached') }))?.retry).toBe(true);
    expect(chooseFallback(input({ canUseVoice: false }))?.retry).toBe(false);
    expect(chooseFallback(input({ reachable: false }))?.retry).toBe(false);
  });
  it('лимит снимается, когда voice.usage.get показывает остаток', () => {
    expect(chooseFallback(input({ voice: voice('limit_reached'), failure: 'limit_reached', remainingSeconds: 600 }))).toBeNull();
    expect(chooseFallback(input({ voice: voice('limit_reached'), remainingSeconds: 0 }))?.reason).toBe('limit_reached');
  });
  it('needsReset: error и limit_reached сбрасываются при возврате', () => {
    expect(needsReset(voice('error'))).toBe(true);
    expect(needsReset(voice('limit_reached'))).toBe(true);
    expect(needsReset(voice('idle'))).toBe(false);
    expect(needsReset(voice('listening'))).toBe(false);
  });
});

describe('m5: ключ текстового запроса', () => {
  it('тот же текст держит ключ, другой берёт новый', () => {
    let n = 0;
    const fresh = (): string => `k${++n}`;
    const first = keyForText(null, 'close S05', fresh);
    expect(keyForText(first, 'close S05', fresh)).toBe(first);
    expect(keyForText(first, 'other', fresh).key).toBe('k2');
  });
});

describe('composerSpacing: поле ввода над таб-баром и клавиатурой', () => {
  it('клавиатура закрыта, insets без бара: добавляет высоту бара', () => {
    expect(composerSpacing(34, 0)).toEqual({ pageBottom: 0, composerBottom: 34 + TAB_BAR_HEIGHT });
    expect(composerSpacing(0, 0).composerBottom).toBe(TAB_BAR_HEIGHT);
  });
  it('клавиатура закрыта, insets уже включает бар: бар не считается дважды', () => {
    expect(composerSpacing(90, 0)).toEqual({ pageBottom: 0, composerBottom: 90 });
  });
  it('клавиатура открыта: страница поднята на клавиатуру, без safe area и бара', () => {
    expect(composerSpacing(34, 336)).toEqual({ pageBottom: 336, composerBottom: 8 });
    expect(composerSpacing(90, 336)).toEqual({ pageBottom: 336, composerBottom: 8 });
  });
});
