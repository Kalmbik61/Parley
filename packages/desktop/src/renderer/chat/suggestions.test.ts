/** Контекст подсказок и вставка выбранного (живая проверка 2026-10-02). */

import { describe, expect, it } from 'vitest';
import { applySuggestion, suggestionContext } from './suggestions.js';

describe('suggestionContext', () => {
  it('«/» и «/cl» — команда; текст до каретки целиком', () => {
    expect(suggestionContext('/', 1)).toEqual({ kind: 'command', query: '', start: 0 });
    expect(suggestionContext('/cl', 3)).toEqual({ kind: 'command', query: 'cl', start: 0 });
    expect(suggestionContext('/plugin:skill-x', 15)).toEqual({ kind: 'command', query: 'plugin:skill-x', start: 0 });
  });

  it('слеш не в начале текста или после слова с пробелом — не команда', () => {
    expect(suggestionContext('fix /cl', 7)).toBeNull();
    expect(suggestionContext('/clear now', 10)).toBeNull();
    expect(suggestionContext('/cl', 2)).toEqual({ kind: 'command', query: 'c', start: 0 });
  });

  it('«/model » и «/model son» — выбор модели', () => {
    expect(suggestionContext('/model ', 7)).toEqual({ kind: 'model', query: '', start: 0 });
    expect(suggestionContext('/model son', 10)).toEqual({ kind: 'model', query: 'son', start: 0 });
    expect(suggestionContext('/model a b', 10)).toBeNull();
  });

  it('@ в начале слова — упоминание, query без @; start — позиция @', () => {
    expect(suggestionContext('@', 1)).toEqual({ kind: 'mention', query: '', start: 0 });
    expect(suggestionContext('look at @src/co', 15)).toEqual({ kind: 'mention', query: 'src/co', start: 8 });
    expect(suggestionContext('a\n@x', 4)).toEqual({ kind: 'mention', query: 'x', start: 2 });
  });

  it('@ внутри слова (почта) и каретка до @ — не упоминание', () => {
    expect(suggestionContext('me@host', 7)).toBeNull();
    expect(suggestionContext('@abc', 0)).toBeNull();
    expect(suggestionContext('plain text', 10)).toBeNull();
  });
});

describe('applySuggestion', () => {
  it('команда: «/cl» → «/clear », каретка после пробела', () => {
    const context = suggestionContext('/cl', 3)!;
    expect(applySuggestion('/cl', 3, context, '/clear ')).toEqual({ text: '/clear ', caret: 7 });
  });

  it('модель: без пробела — человек жмёт Enter сам', () => {
    const context = suggestionContext('/model ', 7)!;
    expect(applySuggestion('/model ', 7, context, '/model opus')).toEqual({ text: '/model opus', caret: 11 });
  });

  it('упоминание в середине текста: токен заменён, остальное сохранено', () => {
    const text = 'see @no please';
    const context = suggestionContext(text, 7)!;
    expect(applySuggestion(text, 7, context, '@notes.txt ')).toEqual({ text: 'see @notes.txt please', caret: 15 });
  });

  it('каталог — «@src/» без пробела, подсказки продолжаются', () => {
    const context = suggestionContext('@sr', 3)!;
    const next = applySuggestion('@sr', 3, context, '@src/');
    expect(next).toEqual({ text: '@src/', caret: 5 });
    expect(suggestionContext(next.text, next.caret)).toEqual({ kind: 'mention', query: 'src/', start: 0 });
  });
});
