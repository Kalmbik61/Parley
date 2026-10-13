import { afterEach, describe, expect, it } from 'vitest';
import { rememberContextImage, resetContextImagesForTests } from '../../chat/context-attachments.js';
import { composeRoomMessage } from './attachments.js';

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
