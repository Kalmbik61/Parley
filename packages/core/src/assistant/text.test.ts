import { describe, expect, it } from 'vitest';
import { matchConfirm, normalizeSentText, splitMood } from './text.js';

describe('splitMood — метка эмоции в начале ответа', () => {
  it('срезает метку отдельной строкой', () => {
    expect(splitMood('[[joy]]\nКомната закончила.', false)).toEqual({ mood: 'joy', text: 'Комната закончила.' });
  });
  it('срезает метку в одной строке с ответом (GLM)', () => {
    expect(splitMood('[[calm]] Сейчас работают двое.', false)).toEqual({ mood: 'calm', text: 'Сейчас работают двое.' });
  });
  it('ждёт, пока метка не дописана', () => {
    expect(splitMood('', false)).toBeNull();
    expect(splitMood('[', false)).toBeNull();
    expect(splitMood('[[sur', false)).toBeNull();
  });
  it('без метки — calm и весь текст', () => {
    expect(splitMood('Сейчас тихо.', false)).toEqual({ mood: 'calm', text: 'Сейчас тихо.' });
    expect(splitMood('[1] пункт', false)).toEqual({ mood: 'calm', text: '[1] пункт' });
  });
  it('незнакомая метка и error от модели — calm', () => {
    expect(splitMood('[[happy]] Да.', false)).toEqual({ mood: 'calm', text: 'Да.' });
    expect(splitMood('[[error]] Нет.', false)).toEqual({ mood: 'calm', text: 'Нет.' });
  });
  it('незакрытая длинная метка — calm и текст как есть', () => {
    const text = '[[это не метка, а длинный текст';
    expect(splitMood(text, false)).toEqual({ mood: 'calm', text });
  });
  it('в конце хода решает и по неполному буферу', () => {
    expect(splitMood('[[jo', true)).toEqual({ mood: 'calm', text: '[[jo' });
    expect(splitMood('', true)).toEqual({ mood: 'calm', text: '' });
  });
});

describe('matchConfirm — слова подтверждения карточки', () => {
  it('«да» и «yes» — отправить', () => {
    for (const phrase of ['Да', 'да, отправляй!', 'Отправь.', 'yes', 'Send it', 'go ahead']) expect(matchConfirm(phrase)).toBe('send');
  });
  it('«нет» и «cancel» — отменить', () => {
    for (const phrase of ['Нет', 'не надо', 'Отмена', 'no', 'Cancel', "don't"]) expect(matchConfirm(phrase)).toBe('cancel');
  });
  it('длинная фраза — не подтверждение, а новый вопрос', () => {
    expect(matchConfirm('да, но поменяй текст на другой')).toBeNull();
    expect(matchConfirm('поменяй на «завтра»')).toBeNull();
    expect(matchConfirm('')).toBeNull();
  });
});

describe('normalizeSentText', () => {
  it('схлопывает пробелы и переводы строк', () => {
    expect(normalizeSentText('  Тесты\n\nна Safari   пропусти ')).toBe('Тесты на Safari пропусти');
  });
});
