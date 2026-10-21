/**
 * Свой сигнал «нужно действие» (спека застрявших 7.2): два коротких тона, WebAudio, без файла. Играет само окно,
 * поэтому звук не зависит от настройки «Play sound for notifications» у Parley в macOS, а баннер macOS при этом
 * идёт беззвучным (`silent: true`) — звук не двойной. Пачка событий — один сигнал: не чаще раза в `CHIME_MIN_GAP_MS`.
 */

/** Не чаще одного сигнала за это время, мс. */
export const CHIME_MIN_GAP_MS = 2_000;

/** Тоны сигнала, Гц: квинта вверх. */
const TONES_HZ = [880, 1320] as const;
/** Начало каждого тона от начала сигнала, с: второй входит, когда первый уже затихает. */
const TONE_STARTS_S = [0, 0.2] as const;
const TONE_LENGTH_S = 0.12;
const ATTACK_S = 0.02;
const VOLUME = 0.2;

/** Один `AudioContext` на окно: браузер ограничивает их число, а создание дорогое. */
let audio: AudioContext | null = null;

/** Предупреждение уже было: звук, который не заводится, не должен засорять консоль на каждом сигнале. */
let warned = false;
function warnOnce(error: unknown): void {
  if (warned) return;
  warned = true;
  console.warn('[parley] chime failed', error);
}

/**
 * Проигрывает сигнал: два синуса по `TONE_LENGTH_S`, атака `ATTACK_S`, дальше спад до тишины. Контекст, который
 * браузер усыпил (`suspended`, пока человек не касался окна), будится `resume()`. Любая ошибка WebAudio, и отказ
 * `resume()` тоже, — одно предупреждение в консоль на окно: уведомление важнее звука, и падать из-за него нельзя.
 */
export function playChimeTone(): void {
  try {
    audio ??= new AudioContext();
    const context = audio;
    if (context.state === 'suspended') void context.resume().catch(warnOnce);
    const base = context.currentTime;
    TONES_HZ.forEach((frequency, index) => {
      const start = base + (TONE_STARTS_S[index] ?? 0);
      const oscillator = context.createOscillator();
      const envelope = context.createGain();
      oscillator.type = 'sine';
      oscillator.frequency.value = frequency;
      envelope.gain.setValueAtTime(0, start);
      envelope.gain.linearRampToValueAtTime(VOLUME, start + ATTACK_S);
      envelope.gain.linearRampToValueAtTime(0, start + TONE_LENGTH_S);
      oscillator.connect(envelope);
      envelope.connect(context.destination);
      oscillator.start(start);
      oscillator.stop(start + TONE_LENGTH_S);
    });
  } catch (error: unknown) {
    warnOnce(error);
  }
}

/**
 * Звонок с паузой: `ring()` играет не чаще раза в `CHIME_MIN_GAP_MS`. Каждый вызов, и проглоченный паузой тоже,
 * прибавляет единицу к `globalThis.__parleyChimes` — по счётчику E2E видит, что окно звонить попросили.
 */
export function createChime(deps: { now(): number; play(): void }): { ring(): void } {
  let last: number | null = null;
  return {
    ring() {
      const target = globalThis as { __parleyChimes?: number };
      target.__parleyChimes = (target.__parleyChimes ?? 0) + 1;
      const now = deps.now();
      if (last !== null && now - last < CHIME_MIN_GAP_MS) return;
      last = now;
      deps.play();
    },
  };
}

/** Звонок окна: общая пауза на все уведомления, пока живёт окно (`notify.ts` берёт его). */
export const windowChime = createChime({ now: () => Date.now(), play: playChimeTone });
