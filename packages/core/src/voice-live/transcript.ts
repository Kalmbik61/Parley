/**
 * Буфер транскрипта Live (T4, чистый TS): фрагменты с таймкодами и сборка текста поручения по `offset_ms` делегации.
 * Формы и допущения сверены с записками T0 (`docs/research/2026-11-04-gpt-live-transport-spike.md` §2d, §2e):
 * - фрагменты по ~200 мс, границы фрагмента не равны границам слов, склеивать без добавления пробелов;
 * - внутри одного говорящего не перекрываются; «переставленные» всё равно сортируются по `startMs`;
 * - канал данных и sideband могут дать один фрагмент дважды: точный повтор отбрасывается.
 * Реплику поручения паузой человека буфер не делит (b-027): границу задаёт вызывающий через `splits` (ответ модели),
 * паузы по `TURN_GAP_MS` остались только у `turns()` для контекста.
 * Модуль без Node и DOM: его берут остров и телефон.
 */

export interface TranscriptFragment {
  text: string;
  startMs: number;
  endMs: number;
}

/** Пауза между фрагментами не короче этой границы реплик в `turns()` (контекст); текст поручения по ней не делится. */
export const TURN_GAP_MS = 1200;
/** Сколько фрагментов хранить: сессия живёт до 30 минут, поручению нужны последние. */
export const MAX_FRAGMENTS = 800;
/** Запрос `requests.submit` принимает до 4000 знаков; при превышении остаётся хвост, ближайший к делегации. */
export const MAX_REQUEST_TEXT = 4000;

export interface TranscriptTurn {
  text: string;
  startMs: number;
  endMs: number;
}

export interface Collected {
  /** Склеенный текст без добавления пробелов; пусто, если фрагментов нет. */
  text: string;
  /** Конец последнего собранного фрагмента; `null`, если пусто. */
  lastEndMs: number | null;
  /** Начало первого собранного фрагмента; `null`, если пусто. */
  firstStartMs: number | null;
}

export interface TranscriptBuffer {
  push(fragment: TranscriptFragment): void;
  /** Наибольший `endMs` из полученного; `null`, пока фрагментов нет. */
  readonly highWaterMs: number | null;
  /**
   * Текст реплики, к которой относится делегация с `offsetMs`: фрагменты, начавшиеся не позже `offsetMs` и позже
   * `afterMs` (`offset_ms` прежней делегации). Сборка идёт назад от последнего фрагмента и останавливается там, где
   * `splits(fromMs, toMs)` для промежутка `[endMs предыдущего, startMs следующего)` говорит «делит» (между фрагментами
   * был ответ модели). Без `splits` не делит ничто: пауза в речи человека реплику не делит, но на паузе не короче `TURN_GAP_MS`
   * между фрагментами ставится пробел (после паузы фрагмент приходит без ведущего).
   * «Закончившиеся до offset_ms» из спеки понимается как «начавшиеся не позже»: в живых данных `offset_ms` у 11 из 19
   * делегаций равен `start_ms` последнего фрагмента, и строгое сравнение по `endMs` теряло бы конец фразы.
   */
  collect(offsetMs: number, afterMs: number | null, splits?: (fromMs: number, toMs: number) => boolean): Collected;
  /** Склеенный текст фрагментов с `fromMs ≤ startMs < toMs` (как в `collect`, без добавления пробелов). */
  textBetween(fromMs: number, toMs: number): string;
  /** Реплики (фрагменты, склеенные по паузам) в порядке времени, не позже `beforeMs`. */
  turns(beforeMs: number): TranscriptTurn[];
}

export function createTranscriptBuffer(turnGapMs = TURN_GAP_MS): TranscriptBuffer {
  let fragments: TranscriptFragment[] = [];
  let highWater: number | null = null;

  const glue = (items: readonly TranscriptFragment[]): string => items.map((item) => item.text).join('').replace(/\s+/g, ' ').trim();

  return {
    push(fragment) {
      if (fragment.text === '' || !Number.isFinite(fragment.startMs) || !Number.isFinite(fragment.endMs)) return;
      let at = fragments.length;
      while (at > 0) {
        const previous = fragments[at - 1] as TranscriptFragment;
        if (previous.startMs < fragment.startMs || (previous.startMs === fragment.startMs && previous.endMs <= fragment.endMs)) break;
        at -= 1;
      }
      for (let i = at - 1; i >= 0 && fragments[i]?.startMs === fragment.startMs; i -= 1) {
        const same = fragments[i] as TranscriptFragment;
        if (same.endMs === fragment.endMs && same.text === fragment.text) return;
      }
      fragments.splice(at, 0, { text: fragment.text, startMs: fragment.startMs, endMs: fragment.endMs });
      if (fragments.length > MAX_FRAGMENTS) fragments = fragments.slice(fragments.length - MAX_FRAGMENTS);
      highWater = highWater === null ? fragment.endMs : Math.max(highWater, fragment.endMs);
    },

    get highWaterMs() {
      return highWater;
    },

    collect(offsetMs, afterMs, splits) {
      const candidates = fragments.filter((item) => item.startMs <= offsetMs && (afterMs === null || item.startMs > afterMs));
      if (candidates.length === 0) return { text: '', lastEndMs: null, firstStartMs: null };
      let from = candidates.length - 1;
      while (from > 0) {
        const previous = candidates[from - 1] as TranscriptFragment;
        const current = candidates[from] as TranscriptFragment;
        if (splits?.(previous.endMs, current.startMs) === true) break;
        from -= 1;
      }
      const picked = candidates.slice(from);
      // После паузы фрагмент приходит без ведущего пробела: на паузе не короче turnGapMs ставим пробел (glue схлопнет двойные).
      let text = glue(picked.flatMap((item, i) => (i > 0 && item.startMs - (picked[i - 1] as TranscriptFragment).endMs >= turnGapMs ? [{ ...item, text: ` ${item.text}` }] : [item])));
      if (text.length > MAX_REQUEST_TEXT) text = text.slice(text.length - MAX_REQUEST_TEXT).trimStart();
      return { text, lastEndMs: (picked[picked.length - 1] as TranscriptFragment).endMs, firstStartMs: (picked[0] as TranscriptFragment).startMs };
    },

    textBetween(fromMs, toMs) {
      return glue(fragments.filter((item) => item.startMs >= fromMs && item.startMs < toMs));
    },

    turns(beforeMs) {
      const out: TranscriptTurn[] = [];
      let current: TranscriptFragment[] = [];
      const close = (): void => {
        if (current.length === 0) return;
        const text = glue(current);
        if (text !== '') out.push({ text, startMs: (current[0] as TranscriptFragment).startMs, endMs: (current[current.length - 1] as TranscriptFragment).endMs });
        current = [];
      };
      for (const item of fragments) {
        if (item.startMs > beforeMs) break;
        const last = current[current.length - 1];
        if (last !== undefined && item.startMs - last.endMs >= turnGapMs) close();
        current.push(item);
      }
      close();
      return out;
    },
  };
}
