import { afterEach, describe, expect, it } from 'vitest';
import { rememberContextImage, resetContextImagesForTests } from '../../chat/context-attachments.js';
import { composeRoomMessage, splitRoomAttachments } from './attachments.js';

afterEach(() => resetContextImagesForTests());

describe('composeRoomMessage', () => {
  it('без вложений — текст как есть; пути — списком «Attachments:» кодом', () => {
    expect(composeRoomMessage('hi', [])).toBe('hi');
    expect(composeRoomMessage('hi', ['/a b.txt'])).toBe('hi\n\nAttachments:\n- `/a b.txt`');
  });

  it('файл-контекст со снимком — в списке и .md, и .png (спека браузера 4.5)', () => {
    const md = '/h/drops/context/annotations-settings-0001.md';
    const png = '/h/drops/context/annotations-settings-0001.png';
    rememberContextImage(md, png);
    expect(composeRoomMessage('', [md])).toBe(`Attachments:\n- \`${md}\`\n- \`${png}\``);
  });
});

describe('splitRoomAttachments', () => {
  it('обратное composeRoomMessage: текст и пути по порядку, в том числе путь с обратной кавычкой и сообщение из одних вложений', () => {
    const paths = ['/h/drops/a.png', '/h/Снимок экрана 2026-10-28 в 10.00.00.png', '/h/odd`name.png'];
    expect(splitRoomAttachments(composeRoomMessage('see **this**', paths))).toEqual({ text: 'see **this**', attachments: paths });
    expect(splitRoomAttachments(composeRoomMessage('', paths))).toEqual({ text: '', attachments: paths });
  });

  it('без хвоста «Attachments:» — всё текст; «Attachments:» посреди текста — не вложения', () => {
    expect(splitRoomAttachments('hi')).toEqual({ text: 'hi', attachments: [] });
    expect(splitRoomAttachments('Attachments:\n- `/a.png`\n\nmore text')).toEqual({
      text: 'Attachments:\n- `/a.png`\n\nmore text',
      attachments: [],
    });
  });
});
