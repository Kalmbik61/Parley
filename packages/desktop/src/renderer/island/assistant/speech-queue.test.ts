/**
 * Очередь предложений (план 3, Task 6; план 3b B16; #9 §6.7 L3): ответ режется на предложения по мере прихода,
 * смена хода и укорочение ответа сбрасывают очередь (Review Focus 1), у каждого предложения — эмоция из `moods`
 * с ограниченным откатом (F3).
 */

import { createMoodStripper, type MoodMark } from '@parley/core/assistant';
import { describe, expect, it } from 'vitest';

import { createSentenceFeed, type FeedSentence } from './speech-queue.js';

/** Текст с метками → `answer` и `moods`, как их публикует хост (B11 срезает метки тем же срезателем). */
function host(raw: string): { answer: string; moods: MoodMark[] } {
  const stripper = createMoodStripper();
  const head = stripper.push(raw);
  const tail = stripper.end();
  return { answer: head.text + tail.text, moods: [...head.marks, ...tail.marks] };
}

const texts = (sentences: FeedSentence[]): string[] => sentences.map((sentence) => sentence.text);
const emos = (sentences: FeedSentence[]): string[] => sentences.map((sentence) => sentence.emo);

describe('createSentenceFeed: предложения', () => {
  it('предложение готово, когда за ним есть текст или ответ закончен', () => {
    const feed = createSentenceFeed('en');
    expect(feed.push(1, 'The room is working.', false)).toEqual([]);
    expect(texts(feed.push(1, 'The room is working. Two agents', false))).toEqual(['The room is working.']);
    expect(texts(feed.push(1, 'The room is working. Two agents', true))).toEqual(['Two agents']);
    expect(feed.push(1, 'The room is working. Two agents', true)).toEqual([]);
    expect(feed.wasReset()).toBe(false);
  });

  it('блок кода, открывшийся позже, не звучит и не съедает фразу после себя — по кускам и целиком одинаково (B26 F-B26-5)', () => {
    const full = 'Run this command. ```bash\nrm -rf build. npm test.\n``` Then check the logs. All good.';
    const streamed = createSentenceFeed('en');
    const out: FeedSentence[] = [];
    for (let at = 1; at <= full.length; at += 1) out.push(...streamed.push(1, full.slice(0, at), false));
    // Первое предложение готово, как только начался код: дальше идёт не его текст.
    expect(texts(out.slice(0, 1))).toEqual(['Run this command.']);
    out.push(...streamed.push(1, full, true));
    expect(texts(out)).toEqual(['Run this command.', 'Then check the logs.', 'All good.']);
    expect(texts(createSentenceFeed('en').push(1, full, true))).toEqual(['Run this command.', 'Then check the logs.', 'All good.']);
    // Незакрытый блок до конца ответа тоже молчит.
    expect(texts(createSentenceFeed('en').push(1, 'Here it is. ```ts\nconst a = 1. const b = 2.', true))).toEqual(['Here it is.']);
  });

  it('метка эмоции сразу за концом предложения делает его готовым без следующего слова (B26 F-B26-5, E1)', () => {
    const feed = createSentenceFeed('en');
    const marks = [{ at: 0, mood: 'calm' as const }];
    expect(feed.push(1, 'The room is working. ', false, marks)).toEqual([]);
    // Пришла метка следующего предложения: первое готово сразу.
    expect(texts(feed.push(1, 'The room is working. ', false, [...marks, { at: 21, mood: 'joy' as const }]))).toEqual(['The room is working.']);
    expect(feed.push(1, 'The room is working. Two', false, [...marks, { at: 21, mood: 'joy' as const }])).toEqual([]);
    expect(texts(feed.push(1, 'The room is working. Two agents are busy.', true, [...marks, { at: 21, mood: 'joy' as const }]))).toEqual(['Two agents are busy.']);
    // Метка посреди фразы, без завершающего знака, предложение не режет.
    const mid = createSentenceFeed('en');
    expect(mid.push(1, 'The tests ', false, [...marks, { at: 10, mood: 'sad' as const }])).toEqual([]);
    expect(texts(mid.push(1, 'The tests failed.', true, [...marks, { at: 10, mood: 'sad' as const }]))).toEqual(['The tests failed.']);
  });

  it('новый ход сбрасывает очередь: [] и флаг, флаг снимается чтением', () => {
    const feed = createSentenceFeed('en');
    expect(texts(feed.push(1, 'First answer. More', false))).toEqual(['First answer.']);
    expect(feed.push(2, 'Second answer. More', false)).toEqual([]);
    expect(feed.wasReset()).toBe(true);
    expect(feed.wasReset()).toBe(false);
    expect(texts(feed.push(2, 'Second answer. More', false))).toEqual(['Second answer.']);
  });

  it('Review Focus 1: ответ короче отданного префикса (инструмент посередине) — сброс, старое не склеивается с новым', () => {
    const feed = createSentenceFeed('en');
    expect(texts(feed.push(1, 'Let me check the rooms. Wait', false))).toEqual(['Let me check the rooms.']);
    expect(feed.push(1, '', false)).toEqual([]);
    expect(feed.wasReset()).toBe(true);
    expect(texts(feed.push(1, 'Both rooms are fine. Done', false))).toEqual(['Both rooms are fine.']);
    expect(texts(feed.push(1, 'Both rooms are fine. Done', true))).toEqual(['Done']);
  });

  it('отданный префикс переписан тем же ходом — тоже сброс', () => {
    const feed = createSentenceFeed('en');
    expect(texts(feed.push(1, 'Let me check the rooms. Wait', false))).toEqual(['Let me check the rooms.']);
    expect(feed.push(1, 'Both rooms are fine now. Done', false)).toEqual([]);
    expect(feed.wasReset()).toBe(true);
  });

  it('reset() забывает отданное и снимает флаг', () => {
    const feed = createSentenceFeed('en');
    feed.push(1, 'First answer. More', false);
    feed.push(2, '', false);
    feed.reset();
    expect(feed.wasReset()).toBe(false);
    expect(texts(feed.push(2, 'First answer. More', false))).toEqual(['First answer.']);
    expect(feed.wasReset()).toBe(false);
  });

  it('русский текст с «т. е.» не режется внутри сокращения', () => {
    const feed = createSentenceFeed('ru');
    expect(texts(feed.push(1, 'Проверила комнаты, т. е. обе. Всё хорошо.', true))).toEqual([
      'Проверила комнаты, т. е. обе.',
      'Всё хорошо.',
    ]);
  });

  it('предложение проходит speakable, короче 2 знаков — отброшено', () => {
    const feed = createSentenceFeed('en');
    expect(texts(feed.push(1, 'Open **Auth** room.\n\n**!**\n\nDone now.', true))).toEqual(['Open Auth room.', 'Done now.']);
  });
});

describe('createSentenceFeed: эмоция предложения (F3)', () => {
  it('[[joy]] … [[sad]] … ? — эмоция меняется на границе предложений', () => {
    const feed = createSentenceFeed('en');
    const { answer, moods } = host('[[joy]] Great news, both rooms are done. [[sad]] Sadly the third one has failed again?');
    expect(feed.push(1, answer, true, moods)).toEqual([
      { text: 'Great news, both rooms are done.', emo: 'joy' },
      { text: 'Sadly the third one has failed again?', emo: 'sad' },
    ]);
  });

  it('без метки — эмоция прошлого предложения, у первого — calm', () => {
    const feed = createSentenceFeed('en');
    const { answer, moods } = host('Both rooms finished their work. [[sad]] The third one has failed again. It needs a restart.');
    expect(emos(feed.push(1, answer, true, moods))).toEqual(['calm', 'sad', 'sad']);
  });

  it('без moods (старый хост) — calm', () => {
    const feed = createSentenceFeed('en');
    expect(emos(feed.push(1, 'Both rooms finished their work. The review is waiting.', true))).toEqual(['calm', 'calm']);
  });

  it('предложение короче 1,2 с эмоцию не меняет, и его метка дальше не переходит', () => {
    const feed = createSentenceFeed('en');
    const { answer, moods } = host('[[joy]] Both rooms finished their work. [[sad]] Very sorry. The review is waiting for you.');
    expect(feed.push(1, answer, true, moods)).toEqual([
      { text: 'Both rooms finished their work.', emo: 'joy' },
      { text: 'Very sorry.', emo: 'joy' },
      { text: 'The review is waiting for you.', emo: 'joy' },
    ]);
  });

  it('предложение ровно на 1,2 с эмоцию меняет', () => {
    const feed = createSentenceFeed('en');
    const { answer, moods } = host('[[joy]] Both rooms finished their work. [[sad]] Sorry, Anna.');
    expect(emos(feed.push(1, answer, true, moods))).toEqual(['joy', 'sad']);
  });

  it('не больше одной смены на предложение: из нескольких отметок — последняя', () => {
    const feed = createSentenceFeed('en');
    const { answer, moods } = host('[[joy]] Both rooms finished their work. [[surprise]] [[sad]] The third one has failed again.');
    expect(moods).toHaveLength(3);
    expect(emos(feed.push(1, answer, true, moods))).toEqual(['joy', 'sad']);
  });

  it('по мере ответа: отметки растут вместе с текстом', () => {
    const feed = createSentenceFeed('en');
    const stripper = createMoodStripper();
    let answer = '';
    const moods: MoodMark[] = [];
    const delta = (raw: string, settled = false): FeedSentence[] => {
      const part = settled ? stripper.end() : stripper.push(raw);
      answer += part.text;
      moods.push(...part.marks);
      return feed.push(1, answer, settled, moods);
    };
    expect(delta('[[joy]] Great news, both rooms ')).toEqual([]);
    expect(delta('are done. [[sa')).toEqual([]);
    expect(delta('d]] Sadly the third one ')).toEqual([{ text: 'Great news, both rooms are done.', emo: 'joy' }]);
    expect(delta('has failed again?')).toEqual([]);
    expect(delta('', true)).toEqual([{ text: 'Sadly the third one has failed again?', emo: 'sad' }]);
  });

  it('сброс возвращает откат к calm', () => {
    const feed = createSentenceFeed('en');
    const first = host('[[sad]] The third room has failed again. More');
    expect(emos(feed.push(1, first.answer, false, first.moods))).toEqual(['sad']);
    expect(feed.push(2, 'Both rooms finished their work. More', false)).toEqual([]);
    expect(feed.wasReset()).toBe(true);
    expect(emos(feed.push(2, 'Both rooms finished their work. More', false))).toEqual(['calm']);
  });
});
