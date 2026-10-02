import { describe, expect, it } from 'vitest';
import { isImagePath } from './image-path.js';

describe('isImagePath', () => {
  it('png, jpg, jpeg, gif, webp — без учёта регистра', () => {
    for (const name of ['a.png', 'a.jpg', 'a.jpeg', 'a.gif', 'a.webp', '/h/Shot 1.PNG', 'C:\\pics\\a.JpEg']) {
      expect(isImagePath(name), name).toBe(true);
    }
  });

  it('прочее — нет: другие форматы, расширение посередине, без расширения', () => {
    for (const name of ['a.txt', 'a.svg', 'a.pdf', 'a.png.txt', 'png', '/h/dir.png/file', '']) {
      expect(isImagePath(name), name).toBe(false);
    }
  });
});
