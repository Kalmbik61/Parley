import { speakable, type AssistantLanguage, type AssistantMood, type MoodMark } from '@parley/core/assistant';

/**
 * Очередь предложений речи помощника (план 3, Task 6; план 3b B16; #9 §6.7 L3). Режет растущий ответ хоста на
 * предложения (`Intl.Segmenter`) и отдаёт готовые на синтез; играет их стор сразу, пока ответ ещё идёт (B26 F-B26-5).
 * Предложение готово, когда за ним уже есть текст, ответ закончен (`settled`) или сразу за его концом (`.`, `!`, `?`,
 * `…`) пришла метка эмоции: промпт ставит её в начало каждого предложения, и ждать следующего слова не нужно; оно проходит
 * `speakable` и отбрасывается, если короче 2 знаков.
 *
 * Эмоция предложения — последняя отметка `moods` не дальше его начала, из тех, что ещё не достались прошлым
 * предложениям. Ограниченный откат: нет отметки — эмоция прошлого предложения, у первого — `calm`; одна эмоция на
 * предложение (из нескольких отметок — последняя); предложение короче 1,2 с эмоцию не меняет, и его отметка дальше
 * не переходит.
 */

/** Предложение на синтез: текст для озвучки и эмоция лица, пока оно звучит. */
export interface FeedSentence {
  text: string;
  emo: AssistantMood;
}

export interface SentenceFeed {
  /**
   * Новые готовые предложения хода. Смена `turn` или ответ, который больше не начинается с отданного префикса
   * (хост сбросил `answer` на `tool`), — сброс: `[]` и флаг для `wasReset()`; следующий `push` режет ответ с начала.
   */
  push(turn: number, answer: string, settled: boolean, moods?: readonly MoodMark[]): FeedSentence[];
  /** Забыть отданное, ход и флаг сброса. */
  reset(): void;
  /** Был ли сброс с прошлого чтения; чтение снимает флаг. */
  wasReset(): boolean;
}

const MIN_SENTENCE_LENGTH = 2;

/**
 * Блоки кода (` ``` ` … ` ``` `, незакрытый — до конца ответа) заменяются переводами строк той же длины: сегментатор
 * режет по ним, а не по точкам внутри кода, и озвучивать в них нечего. Длина та же — индексы отметок эмоций не едут.
 */
/** Конец предложения: завершающий знак, за ним кавычки или скобки и пробелы. */
const TERMINAL = /[.!?…]["'»”)\]]*\s*$/u;

const maskCode = (answer: string): string => answer.replace(/```[\s\S]*?(?:```|$)/g, (block) => '\n'.repeat(block.length));
/** Оценка длительности речи по тексту — та же, что у стража длины синтеза (план 3b, B05): 0,1 с на знак. */
const CHARS_PER_SECOND = 10;
/** Предложение короче этого эмоцию не меняет (#9 §6.7 L3). */
const MIN_MOOD_SECONDS = 1.2;

export function createSentenceFeed(language: AssistantLanguage): SentenceFeed {
  const segmenter = new Intl.Segmenter(language, { granularity: 'sentence' });
  let turn: number | null = null;
  /** Отданный префикс ответа: дальше режется только хвост после него. */
  let given = '';
  let emo: AssistantMood = 'calm';
  /** Начало прошлого озвученного предложения: отметки не дальше него уже разобраны. */
  let moodBound = -1;
  let resetFlag = false;

  function forget(): void {
    turn = null;
    given = '';
    emo = 'calm';
    moodBound = -1;
  }

  function moodFor(start: number, text: string, moods: readonly MoodMark[]): AssistantMood {
    let mark: MoodMark | null = null;
    for (const candidate of moods) {
      if (candidate.at > moodBound && candidate.at <= start && (mark === null || candidate.at >= mark.at)) mark = candidate;
    }
    moodBound = start;
    if (mark === null || mark.mood === emo) return emo;
    if (text.length / CHARS_PER_SECOND < MIN_MOOD_SECONDS) return emo;
    return mark.mood;
  }

  return {
    push(nextTurn, answer, settled, moods = []) {
      if ((turn !== null && nextTurn !== turn) || !answer.startsWith(given)) {
        forget();
        resetFlag = true;
        return [];
      }
      turn = nextTurn;
      const segments = [...segmenter.segment(maskCode(answer).slice(given.length))];
      const last = segments[segments.length - 1];
      // Метка эмоции сразу за законченным предложением — оно готово, не дожидаясь следующего слова (E1).
      const closed = settled || (last !== undefined && moods.some((mark) => mark.at >= answer.length) && TERMINAL.test(last.segment));
      const ready: FeedSentence[] = [];
      segments.forEach((segment, index) => {
        if (index === segments.length - 1 && !closed) return;
        const start = given.length + segment.index + (segment.segment.length - segment.segment.trimStart().length);
        const text = speakable(segment.segment);
        if (text.length < MIN_SENTENCE_LENGTH) return;
        emo = moodFor(start, text, moods);
        ready.push({ text, emo });
      });
      if (last !== undefined) given = closed ? answer : answer.slice(0, given.length + last.index);
      return ready;
    },
    reset() {
      forget();
      resetFlag = false;
    },
    wasReset() {
      const value = resetFlag;
      resetFlag = false;
      return value;
    },
  };
}
