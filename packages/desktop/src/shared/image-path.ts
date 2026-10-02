/**
 * Что считается картинкой-вложением «Chat»: расширения, которые понимает сам Claude Code. Список нужен и
 * окну (чип с миниатюрой вместо значка файла), и main (`main/image-thumbnail.ts` читает только такие
 * файлы), поэтому лежит в общем каталоге.
 */

const IMAGE_EXTENSION = /\.(?:png|jpe?g|gif|webp)$/i;

export function isImagePath(path: string): boolean {
  return IMAGE_EXTENSION.test(path);
}
