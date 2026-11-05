import { describe, expect, it } from 'vitest';
import { createTranscriptBuffer, MAX_REQUEST_TEXT } from './transcript.js';

const frag = (text: string, startMs: number, endMs = startMs + 200) => ({ text, startMs, endMs });

describe('TranscriptBuffer', () => {
  it('склеивает фрагменты без добавления пробелов (границы не равны границам слов)', () => {
    const buffer = createTranscriptBuffer();
    for (const item of [frag('What is the status of Par', 0), frag('ley', 200), frag(' builds', 400)]) buffer.push(item);
    expect(buffer.collect(400, null).text).toBe('What is the status of Parley builds');
  });

  it('сортирует переставленные фрагменты и отбрасывает точный повтор', () => {
    const buffer = createTranscriptBuffer();
    buffer.push(frag('world', 200));
    buffer.push(frag('hello ', 0));
    buffer.push(frag('world', 200));
    expect(buffer.collect(200, null).text).toBe('hello world');
  });

  it('берёт фрагменты, начавшиеся не позже offset_ms, включая тот, что начался ровно на нём', () => {
    const buffer = createTranscriptBuffer();
    buffer.push(frag('check ', 0));
    buffer.push(frag('rooms', 200));
    buffer.push(frag(' later', 400));
    expect(buffer.collect(200, null).text).toBe('check rooms');
  });

  it('пауза человека реплику не делит: без ответа модели текст целый, с ответом — после него', () => {
    const buffer = createTranscriptBuffer();
    buffer.push(frag('How are you', 0, 1000));
    buffer.push(frag(' what is in the rooms', 3000, 4000));
    expect(buffer.collect(4000, null).text).toBe('How are you what is in the rooms');
    const reply = (fromMs: number, toMs: number) => fromMs <= 2000 && 2000 < toMs;
    expect(buffer.collect(4000, null, reply).text).toBe('what is in the rooms');
  });

  it('длинная реплика с паузами 1,5 и 1,4 с после ответа модели — весь текст от начала реплики', () => {
    const buffer = createTranscriptBuffer();
    buffer.push(frag('Old', 0, 500));
    buffer.push(frag('Да, давай, напиши тогда', 5000, 6000));
    buffer.push(frag(' ему, начинаем разработку', 7500, 8500));
    buffer.push(frag(', обязательно скажи', 9900, 10_900));
    const afterReply = (fromMs: number, toMs: number) => fromMs <= 1000 && 1000 < toMs;
    expect(buffer.collect(10_900, null, afterReply).text).toBe('Да, давай, напиши тогда ему, начинаем разработку, обязательно скажи');
  });

  it('пробел на паузе не короче TURN_GAP_MS; без паузы склейка как есть', () => {
    const buffer = createTranscriptBuffer();
    buffer.push(frag('. Тогда напиши', 0, 1000));
    buffer.push(frag('в улучшайзинг', 2500, 3500));
    expect(buffer.collect(3500, null).text).toBe('. Тогда напиши в улучшайзинг');
    const punct = createTranscriptBuffer();
    punct.push(frag('Всё, хорошо понял', 0, 1000));
    punct.push(frag('. Тогда напиши', 2500, 3500));
    expect(punct.collect(3500, null).text).toBe('Всё, хорошо понял. Тогда напиши');
    const joined = createTranscriptBuffer();
    joined.push(frag('Par', 0));
    joined.push(frag('ley', 200));
    expect(joined.collect(200, null).text).toBe('Parley');
  });

  it('textBetween склеивает фрагменты с fromMs ≤ startMs < toMs', () => {
    const buffer = createTranscriptBuffer();
    buffer.push(frag('a', 0));
    buffer.push(frag('b', 200));
    buffer.push(frag('c', 400));
    expect(buffer.textBetween(200, 400)).toBe('b');
    expect(buffer.textBetween(0, 1000)).toBe('abc');
  });

  it('начало реплики — offset_ms прежней делегации, даже без паузы', () => {
    const buffer = createTranscriptBuffer();
    buffer.push(frag('first part', 0, 1000));
    buffer.push(frag(' second part', 1000, 2000));
    expect(buffer.collect(2000, 0).text).toBe('second part');
    expect(buffer.collect(2000, null).text).toBe('first part second part');
  });

  it('afterMs ограничивает начало даже при splits, который ничего не делит', () => {
    const buffer = createTranscriptBuffer();
    buffer.push(frag('one', 0, 200));
    buffer.push(frag(' two', 300, 500));
    buffer.push(frag(' three', 600, 800));
    expect(buffer.collect(600, 300, () => false).text).toBe('three');
  });

  it('пусто, если фрагментов нет; highWater растёт', () => {
    const buffer = createTranscriptBuffer();
    expect(buffer.collect(1000, null)).toEqual({ text: '', lastEndMs: null, firstStartMs: null });
    expect(buffer.highWaterMs).toBeNull();
    buffer.push(frag('a', 0, 900));
    buffer.push(frag('b', 900, 400));
    expect(buffer.highWaterMs).toBe(900);
  });

  it('длинный текст усекается с начала, остаётся хвост', () => {
    const buffer = createTranscriptBuffer();
    buffer.push(frag('x'.repeat(MAX_REQUEST_TEXT + 500) + ' tail', 0, 100));
    const { text } = buffer.collect(0, null);
    expect(text.length).toBeLessThanOrEqual(MAX_REQUEST_TEXT);
    expect(text.endsWith('tail')).toBe(true);
  });

  it('turns() делит реплики по паузам', () => {
    const buffer = createTranscriptBuffer();
    buffer.push(frag('one', 0));
    buffer.push(frag(' two', 200));
    buffer.push(frag('three', 5000));
    expect(buffer.turns(10_000).map((turn) => turn.text)).toEqual(['one two', 'three']);
    expect(buffer.turns(1000).map((turn) => turn.text)).toEqual(['one two']);
  });
});
