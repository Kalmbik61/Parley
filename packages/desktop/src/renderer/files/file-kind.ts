/**
 * Вид файла по расширению (кусок 7.3a, спека 5.3 и 10.6): значок вкладки — здесь, тело и превью —
 * 7.3b и 7.5. Только по имени: байты для этого не читаются, двоичный текст решает `readText`.
 */

export type FileKind = 'text' | 'markdown' | 'csv' | 'tsv' | 'image' | 'pdf';

// `Map`, а не литерал объекта: `a.constructor` иначе нашёл бы свойство прототипа.
const BY_EXTENSION: ReadonlyMap<string, FileKind> = new Map<string, FileKind>([
  ['md', 'markdown'],
  ['markdown', 'markdown'],
  ['csv', 'csv'],
  ['tsv', 'tsv'],
  ['png', 'image'],
  ['jpg', 'image'],
  ['jpeg', 'image'],
  ['gif', 'image'],
  ['webp', 'image'],
  ['svg', 'image'],
  ['pdf', 'pdf'],
]);

/** По расширению без учёта регистра: md markdown; csv; tsv; png jpg jpeg gif webp svg; pdf; прочее — text. */
export function fileKind(path: string): FileKind {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  // `.gitignore` — имя, а не расширение.
  if (dot <= 0) return 'text';
  return BY_EXTENSION.get(name.slice(dot + 1).toLowerCase()) ?? 'text';
}
