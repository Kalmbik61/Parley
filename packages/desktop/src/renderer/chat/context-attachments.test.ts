import { afterEach, describe, expect, it } from 'vitest';
import {
  contextAttachment,
  contextImageOf,
  pairContextAttachments,
  rememberContextImage,
  resetContextImagesForTests,
  withContextImages,
} from './context-attachments.js';

const MD = '/h/.parley/desktop/drops/context/element-button.save-a1f3.md';
const PNG = '/h/.parley/desktop/drops/context/element-button.save-a1f3.png';

afterEach(() => resetContextImagesForTests());

describe('contextAttachment (спека браузера 4.5)', () => {
  it('md в drops/context: вид, метка и соседний png у element и annotations', () => {
    expect(contextAttachment(MD)).toEqual({ kind: 'element', label: 'button.save', imagePath: PNG });
    expect(contextAttachment('/h/drops/context/annotations-settings-00ff.md')).toEqual({
      kind: 'annotations',
      label: 'settings',
      imagePath: '/h/drops/context/annotations-settings-00ff.png',
    });
    expect(contextAttachment('/h/drops/context/request-post-api-settings-500-0001.md')).toEqual({ kind: 'request', label: 'post-api-settings-500', imagePath: null });
  });

  it('не файл-контекст — null: другой каталог, png, чужой вид, без hex', () => {
    for (const path of ['/h/notes/element-x-0001.md', PNG, '/h/drops/context/cookie-x-0001.md', '/h/drops/context/element-x.md']) {
      expect(contextAttachment(path), path).toBeNull();
    }
  });
});

describe('снимки файлов-контекстов', () => {
  it('withContextImages ставит известный png сразу за md, без повторов; неизвестный — нет', () => {
    expect(withContextImages([MD, '/a.txt'])).toEqual([MD, '/a.txt']);
    rememberContextImage(MD, PNG);
    expect(contextImageOf(MD)).toBe(PNG);
    expect(withContextImages([MD, '/a.txt'])).toEqual([MD, PNG, '/a.txt']);
    expect(withContextImages([MD, PNG])).toEqual([MD, PNG]);
  });

  it('pairContextAttachments прячет png, если в списке есть md с тем же именем', () => {
    expect(pairContextAttachments([MD, PNG, '/h/drops/a.png'])).toEqual([MD, '/h/drops/a.png']);
    expect(pairContextAttachments([PNG])).toEqual([PNG]);
  });
});
