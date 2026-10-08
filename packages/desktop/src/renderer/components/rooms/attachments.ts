/**
 * Вложения сообщения комнаты (скрепка поля ввода и файлы, брошенные на вкладку комнаты). Агенты получают письмо комнаты
 * текстом (`check_inbox`), а не промптом CLI, поэтому вложение — абсолютный путь в конце сообщения: агент откроет файл
 * сам. В ленте это список путей кодом. Текст — для агентов, поэтому по-английски.
 */

/** Путь кодом; путь с обратной кавычкой кодом не выразить — он идёт как есть. */
const codeSpan = (path: string): string => (path.includes('`') ? path : `\`${path}\``);

/** Текст отправки: текст, затем «Attachments:» и пути списком. Без вложений — текст как есть. */
export function composeRoomMessage(text: string, paths: readonly string[]): string {
  if (paths.length === 0) return text;
  const list = paths.map((path) => `- ${codeSpan(path)}`).join('\n');
  return `${text === '' ? '' : `${text}\n\n`}Attachments:\n${list}`;
}
