/**
 * Ввод в TUI Codex (спека комнат Organic, 3.6, «Ввод»): вставка, пауза, клавиша отправки и очистка
 * текста от токенов, которые Codex читает как команды и меню.
 */

import { describe, expect, it } from 'vitest';
import {
  CODEX_SUBMIT_DELAY_MS,
  KEY_ENTER,
  KEY_TAB,
  PASTE_END,
  PASTE_START,
  codexPaste,
  codexSubmitKey,
  sanitizeForCodex,
} from './codex-input.js';

describe('sanitizeForCodex — начало текста', () => {
  it('«/», «!» и «$» в начале получают видимый префикс: команда, оболочка и скилл не сработают', () => {
    expect(sanitizeForCodex('/compact сейчас')).toBe('- /compact сейчас');
    expect(sanitizeForCodex('!rm -rf build')).toBe('- !rm -rf build');
    expect(sanitizeForCodex('$deploy prod')).toBe('- $deploy prod');
  });

  it('за пробелами и переводами строк — тоже: Codex мог обрезать их до разбора', () => {
    // Одно слово `/help` — заодно и токен на конце, его закрывает пробел (правило конца, ниже).
    expect(sanitizeForCodex('  /help')).toBe('- /help ');
    expect(sanitizeForCodex('\n\t!ls')).toBe('- !ls');
  });

  it('результат сам не начинается ни с одного из трёх знаков', () => {
    for (const text of ['/a', '!a', '$a', ' /a', '/', '!', '$', '//', '/ / /']) {
      expect(sanitizeForCodex(text), text).not.toMatch(/^\s*[/!$]/);
    }
  });

  it('знаки посередине и в конце слов не трогаются', () => {
    for (const text of ['см. /tmp/x.log в конце', 'a!b', 'стоит $5 ровно', 'x/y/z']) {
      expect(sanitizeForCodex(text), text).toBe(text);
    }
  });

  it('обычный текст не меняется вовсе', () => {
    for (const text of [
      'New messages (1). Call check_inbox.',
      'Привет!',
      'hello world',
      'a\nb\nc',
      '- уже с дефисом',
      '',
    ]) {
      expect(sanitizeForCodex(text), text).toBe(text);
    }
  });
});

describe('sanitizeForCodex — конец текста', () => {
  it('токен @…, $… и /… на конце закрывается пробелом: меню не заберёт Enter', () => {
    expect(sanitizeForCodex('посмотри @README.md')).toBe('посмотри @README.md ');
    expect(sanitizeForCodex('запусти $deploy')).toBe('запусти $deploy ');
    expect(sanitizeForCodex('файл лежит в /tmp/out')).toBe('файл лежит в /tmp/out ');
    expect(sanitizeForCodex('см. @')).toBe('см. @ ');
    expect(sanitizeForCodex('цена $')).toBe('цена $ ');
  });

  it('точка входит в токен: «@файл.» всё ещё токен, пробел нужен', () => {
    expect(sanitizeForCodex('посмотри @README.md.')).toBe('посмотри @README.md. ');
  });

  it('токен в середине и слова со знаками внутри пробела не требуют', () => {
    for (const text of [
      'см. @файл потом',
      'user@example.com',
      'a/b',
      'http://x.test/y',
      'цена=$5 и всё',
      'путь (/tmp)',
      '@файл, потом',
    ]) {
      expect(sanitizeForCodex(text), text).toBe(text);
    }
  });

  it('текст уже кончается пробелом или переводом строки — второй пробел не добавляется', () => {
    expect(sanitizeForCodex('см. @файл ')).toBe('см. @файл ');
    expect(sanitizeForCodex('см. @файл\n')).toBe('см. @файл\n');
    expect(sanitizeForCodex('см. @файл\t')).toBe('см. @файл\t');
  });

  it('оба правила разом: начало на «/» и токен «/…» на конце', () => {
    expect(sanitizeForCodex('/Users/me/a.png')).toBe('- /Users/me/a.png ');
  });

  it('результат сам не кончается токеном меню', () => {
    for (const text of ['@a', '$a', '/a', 'x @a', 'x $a', 'x /a', '@', '$', '/', 'x @a.b.']) {
      expect(sanitizeForCodex(text), text).not.toMatch(/(?:^|\s)[@$/]\S*$/);
    }
  });

  it('многострочный текст: правила смотрят на первую строку в начале и на последнюю в конце', () => {
    expect(sanitizeForCodex('/x\nвторая')).toBe('- /x\nвторая');
    expect(sanitizeForCodex('первая\nсм. @файл')).toBe('первая\nсм. @файл ');
  });
});

describe('codexPaste', () => {
  it('очищенный текст в маркерах bracketed paste', () => {
    expect(codexPaste('привет')).toBe(`${PASTE_START}привет${PASTE_END}`);
    expect(codexPaste('/help')).toBe(`${PASTE_START}- /help ${PASTE_END}`);
  });

  it('маркеры — стандартные ESC[200~ и ESC[201~', () => {
    expect(PASTE_START).toBe('\x1b[200~');
    expect(PASTE_END).toBe('\x1b[201~');
  });
});

describe('codexSubmitKey', () => {
  it('агент работает — Tab (очередь), не Enter (вмешательство в ход)', () => {
    expect(codexSubmitKey('working')).toBe(KEY_TAB);
    expect(KEY_TAB).toBe('\t');
  });

  it('у приглашения, после хода, без состояния — Enter', () => {
    for (const state of ['idle', 'unseen', undefined]) {
      expect(codexSubmitKey(state), String(state)).toBe(KEY_ENTER);
    }
    expect(KEY_ENTER).toBe('\r');
  });

  it('blocked отдельно не решается: сюда с ним не доходят (диалог отвечать нельзя)', () => {
    // Решение «печатать ли» принимают `pty.send` и будильник до клавиши; здесь лишь Enter по умолчанию.
    expect(codexSubmitKey('blocked')).toBe(KEY_ENTER);
  });
});

describe('пауза', () => {
  it('десятки миллисекунд, а не полсекунды будильника', () => {
    expect(CODEX_SUBMIT_DELAY_MS).toBeGreaterThanOrEqual(20);
    expect(CODEX_SUBMIT_DELAY_MS).toBeLessThan(200);
  });
});
