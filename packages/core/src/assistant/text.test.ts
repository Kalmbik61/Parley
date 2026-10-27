import { describe, expect, it } from 'vitest';
import { createMoodStripper, matchConfirm, normalizeSentText, speakable, splitMood } from './text.js';

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

describe('speakable — текст ответа для озвучки', () => {
  it('срезает метку и разметку Markdown', () => {
    expect(speakable('[[joy]] The room **Redesign** is working.')).toBe('The room Redesign is working.');
    expect(speakable('# Итог\n- первый _готов_\n2. второй `ждёт`')).toBe('Итог первый готов второй ждёт');
  });
  it('срезает любые метки, не только первую (L3)', () => {
    expect(speakable('[[joy]] Готово. [[sad]] Но тесты упали? [[happy]] Ещё.')).toBe('Готово. Но тесты упали? Ещё.');
  });
  it('убирает блок кода целиком', () => {
    expect(speakable('Вот так:\n```ts\nconst a = 1;\n```\nи всё.')).toBe('Вот так: и всё.');
  });
  it('убирает URL, абсолютные пути и id в скобках', () => {
    expect(speakable('See /Users/x/a.ts and [session:ab12:w-0003:s-01]')).toBe('See and');
    expect(speakable('Открой https://example.com/a?b=1 и ~/work/notes.md сейчас.')).toBe('Открой и сейчас.');
    expect(speakable('Агент (s-01) и комната room:r-09 ждут.')).toBe('Агент и комната ждут.');
  });
  it('не трогает обычные слова: S01, and/or, snake_case', () => {
    expect(speakable('S01 needs you, and/or snake_case.')).toBe('S01 needs you, and/or snake_case.');
  });
  it('срезает знакомую метку с одной закрывающей скобкой, незнакомую — нет', () => {
    expect(speakable('[[calm] He is done. [[joy] Yes.')).toBe('He is done. Yes.');
    expect(speakable('[[foo] bar')).toBe('[[foo] bar');
  });
  it('пустая строка, если ничего не осталось', () => {
    expect(speakable('[[calm]]')).toBe('');
    expect(speakable('  ')).toBe('');
  });
});

describe('createMoodStripper — метки по предложениям в потоке (L3)', () => {
  /** Прогоняет дельты и склеивает весь результат, как хост. */
  function run(deltas: string[]): { text: string; marks: { at: number; mood: string }[] } {
    const stripper = createMoodStripper();
    let text = '';
    const marks: { at: number; mood: string }[] = [];
    for (const out of [...deltas.map((delta) => stripper.push(delta)), stripper.end()]) {
      text += out.text;
      marks.push(...out.marks);
    }
    return { text, marks };
  }

  it('[[joy]] … [[sad]] … ? — две отметки на позициях предложений', () => {
    const result = run(['[[joy]] Комната закончила. [[sad]] Но тесты упали?']);
    expect(result.text).toBe('Комната закончила. Но тесты упали?');
    expect(result.marks).toEqual([
      { at: 0, mood: 'joy' },
      { at: 'Комната закончила. '.length, mood: 'sad' },
    ]);
  });
  it('метка, разрезанная между дельтами, ждёт в буфере и срезается', () => {
    const whole = run(['[[joy]]\nГотово. [[sad]] Но тесты упали?']);
    for (const deltas of [
      ['[', '[jo', 'y]]\nГотово. [', '[s', 'ad]', '] Но тесты упали?'],
      ['[[joy]]', '\n', 'Готово. [[sad]]', ' ', 'Но тесты упали?'],
    ]) {
      expect(run(deltas)).toEqual(whole);
    }
    expect(whole.text).toBe('Готово. Но тесты упали?');
  });
  it('дельта отдаёт только готовый текст, недописанная метка не просачивается', () => {
    const stripper = createMoodStripper();
    expect(stripper.push('Готово. [[s')).toEqual({ text: 'Готово. ', marks: [] });
    expect(stripper.push('ad]] Но')).toEqual({ text: 'Но', marks: [{ at: 8, mood: 'sad' }] });
  });
  it('незнакомая метка и error срезаются, но не дают отметки', () => {
    expect(run(['[[happy]] Да. [[error]] Нет. [[calm]] Ладно.'])).toEqual({
      text: 'Да. Нет. Ладно.',
      marks: [{ at: 'Да. Нет. '.length, mood: 'calm' }],
    });
  });
  it('длинная скобка — не метка, а текст', () => {
    const text = 'Список [[это не метка, а длинный текст]] и [1] пункт.';
    expect(run([text])).toEqual({ text, marks: [] });
    expect(run(['Список [[это не метка, ', 'а длинный текст]] конец.']).text).toBe('Список [[это не метка, а длинный текст]] конец.');
  });
  it('метка с одной закрывающей скобкой (GLM) — отметка, даже разрезанная на `]`', () => {
    const whole = run(['[[calm] Он закончил. [[joy] Ура.']);
    expect(whole).toEqual({
      text: 'Он закончил. Ура.',
      marks: [
        { at: 0, mood: 'calm' },
        { at: 'Он закончил. '.length, mood: 'joy' },
      ],
    });
    expect(run(['[[calm]', ' Он закончил. [[joy]', ' Ура.'])).toEqual(whole);
    expect(run(['Ответ. [[sad]'])).toEqual({ text: 'Ответ. ', marks: [{ at: 'Ответ. '.length, mood: 'sad' }] });
  });
  it('незнакомое слово в `[[foo] ` не проглатывается, и следующая метка цела', () => {
    expect(run(['[[foo] bar [[joy]] Да.'])).toEqual({
      text: '[[foo] bar Да.',
      marks: [{ at: '[[foo] bar '.length, mood: 'joy' }],
    });
    expect(run(['[[foo]', ' bar'])).toEqual({ text: '[[foo] bar', marks: [] });
  });
  it('в конце хода недописанная метка уходит текстом', () => {
    expect(run(['Ответ [[jo'])).toEqual({ text: 'Ответ [[jo', marks: [] });
    expect(run(['Ответ ['])).toEqual({ text: 'Ответ [', marks: [] });
  });
});
