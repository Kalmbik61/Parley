import { describe, expect, it } from 'vitest';
import { addAttachments, attachmentMention, composePrompt, splitAttachments } from './attachments.js';

describe('attachmentMention', () => {
  it('путь в двойных кавычках после @, пробелы внутри не мешают', () => {
    expect(attachmentMention('/h/drops/a b.png')).toBe('@"/h/drops/a b.png"');
    expect(attachmentMention('C:\\pics\\a.png')).toBe('@"C:\\pics\\a.png"');
  });

  it('путь с ", # или переводом строки — запасной вариант: shell-кавычки терминала', () => {
    expect(attachmentMention('/h/say "hi".png')).toBe(`'/h/say "hi".png'`);
    expect(attachmentMention('/h/Shot #1.png')).toBe(`'/h/Shot #1.png'`);
    expect(attachmentMention('/h/a\nb.png')).toBe(`'/h/a\nb.png'`);
    expect(attachmentMention("/h/it's #1.png")).toBe(`'/h/it'\\''s #1.png'`);
  });
});

describe('composePrompt', () => {
  it('текст, упоминания через пробел и пробел в конце', () => {
    expect(composePrompt('что тут?', ['/a/b c.png', '/d.txt'])).toBe('что тут? @"/a/b c.png" @"/d.txt" ');
  });

  it('без текста — одни упоминания и пробел в конце', () => {
    expect(composePrompt('', ['/a/b c.png'])).toBe('@"/a/b c.png" ');
    expect(composePrompt('  \n', ['/a.png'])).toBe('@"/a.png" ');
  });

  it('пробелы и переводы строк в конце текста не копятся перед упоминаниями', () => {
    expect(composePrompt('line one\nline two  \n', ['/a.png'])).toBe('line one\nline two @"/a.png" ');
  });

  it('без вложений — текст как есть, в том числе с пробелом в конце', () => {
    expect(composePrompt('hello ', [])).toBe('hello ');
    expect(composePrompt('', [])).toBe('');
  });

  it('путь, который нельзя упомянуть, идёт в shell-кавычках', () => {
    expect(composePrompt('look', ['/h/a #1.png', '/h/b.png'])).toBe(`look '/h/a #1.png' @"/h/b.png" `);
  });
});

describe('splitAttachments', () => {
  it('одно упоминание в конце — вложение, текст без него', () => {
    expect(splitAttachments('что тут? @"/a/b c.png" ')).toEqual({ text: 'что тут?', attachments: ['/a/b c.png'] });
    expect(splitAttachments('look @"/a.png"')).toEqual({ text: 'look', attachments: ['/a.png'] });
  });

  it('хвост из нескольких упоминаний — порядок сохраняется', () => {
    expect(splitAttachments('compare @"/a.png" @"/b c.png"   @"/d.txt" ')).toEqual({
      text: 'compare',
      attachments: ['/a.png', '/b c.png', '/d.txt'],
    });
  });

  it('только упоминания — текста нет', () => {
    expect(splitAttachments('@"/a.png" ')).toEqual({ text: '', attachments: ['/a.png'] });
    expect(splitAttachments('@"/a.png" @"/b.png"')).toEqual({ text: '', attachments: ['/a.png', '/b.png'] });
  });

  it('упоминание посреди текста остаётся текстом; с хвостовым — снимается только хвостовое', () => {
    expect(splitAttachments('see @"/a.png" and more')).toEqual({ text: 'see @"/a.png" and more', attachments: [] });
    expect(splitAttachments('see @"/a.png" and @"/b.png" ')).toEqual({ text: 'see @"/a.png" and', attachments: ['/b.png'] });
  });

  it('относительные упоминания и упоминание без пробела перед @ остаются текстом', () => {
    expect(splitAttachments('look at @src/a.ts')).toEqual({ text: 'look at @src/a.ts', attachments: [] });
    expect(splitAttachments('look @"src/a b.ts"')).toEqual({ text: 'look @"src/a b.ts"', attachments: [] });
    expect(splitAttachments('mail@"/a.png"')).toEqual({ text: 'mail@"/a.png"', attachments: [] });
  });

  it('путь Windows (C:\\…) — вложение', () => {
    expect(splitAttachments('x @"C:\\pics\\a b.png" ')).toEqual({ text: 'x', attachments: ['C:\\pics\\a b.png'] });
  });

  it('упоминание в shell-кавычках (запасной вариант) остаётся текстом', () => {
    expect(splitAttachments(`look '/h/a #1.png' `)).toEqual({ text: `look '/h/a #1.png'`, attachments: [] });
  });

  it('без упоминаний — текст, обрезанный по краям', () => {
    expect(splitAttachments('\n\nhello world\n')).toEqual({ text: 'hello world', attachments: [] });
    expect(splitAttachments('')).toEqual({ text: '', attachments: [] });
  });

  it('текст из многих строк: упоминание в конце последней строки снимается', () => {
    expect(splitAttachments('one\ntwo @"/a.png" ')).toEqual({ text: 'one\ntwo', attachments: ['/a.png'] });
  });

  it('то, что собрал composePrompt, разбирается обратно', () => {
    const paths = ['/h/drops/20261002-101112-ab12.png', '/h/my notes.txt'];
    expect(splitAttachments(composePrompt('what is this?', paths))).toEqual({ text: 'what is this?', attachments: paths });
    expect(splitAttachments(composePrompt('', paths))).toEqual({ text: '', attachments: paths });
  });
});

describe('addAttachments', () => {
  it('новые пути — в конец, в порядке добавления, без повторов', () => {
    expect(addAttachments(['/a'], ['/b', '/a', '/c', '/b'])).toEqual(['/a', '/b', '/c']);
  });

  it('ничего нового — тот же массив (стор не трогается)', () => {
    const current = ['/a', '/b'];
    expect(addAttachments(current, ['/b'])).toBe(current);
    expect(addAttachments(current, [])).toBe(current);
  });
});
