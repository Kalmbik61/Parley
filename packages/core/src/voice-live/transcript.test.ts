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

  it('начало реплики — пауза не короче границы', () => {
    const buffer = createTranscriptBuffer();
    buffer.push(frag('How are you', 0, 1000));
    buffer.push(frag('what is in the rooms', 3000, 4000));
    expect(buffer.collect(4000, null).text).toBe('what is in the rooms');
  });

  it('начало реплики — offset_ms прежней делегации, даже без паузы', () => {
    const buffer = createTranscriptBuffer();
    buffer.push(frag('first part', 0, 1000));
    buffer.push(frag(' second part', 1000, 2000));
    expect(buffer.collect(2000, 0).text).toBe('second part');
    expect(buffer.collect(2000, null).text).toBe('first part second part');
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
