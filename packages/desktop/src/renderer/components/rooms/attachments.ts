/**
 * Вложения сообщения комнаты (скрепка поля ввода и файлы, брошенные на вкладку комнаты). Агенты получают письмо комнаты
 * текстом (`check_inbox`), а не промптом CLI, поэтому вложение — абсолютный путь в конце сообщения: агент откроет файл
 * сам. Текст — для агентов, поэтому по-английски. Лента делает обратное (`splitRoomAttachments`): у сообщения человека
 * список путей — чипами, картинка — миниатюрой, как в пузыре промпта «Chat».
 */

import { withContextImages } from '../../chat/context-attachments.js';

/** Путь кодом; путь с обратной кавычкой кодом не выразить — он идёт как есть. */
const codeSpan = (path: string): string => (path.includes('`') ? path : `\`${path}\``);

/** Текст отправки: текст, затем «Attachments:» и пути списком. Без вложений — текст как есть. */
export function composeRoomMessage(text: string, paths: readonly string[]): string {
  if (paths.length === 0) return text;
  const list = withContextImages(paths).map((path) => `- ${codeSpan(path)}`).join('\n');
  return `${text === '' ? '' : `${text}\n\n`}Attachments:\n${list}`;
}

/** Хвост «Attachments:» с пунктами списка `composeRoomMessage`. */
const TAIL = /(?:^|\n\n)Attachments:\n((?:- [^\n]+(?:\n|$))+)$/;
/** Пункт: путь кодом или, с обратной кавычкой внутри, как есть. */
const ITEM = /^- (?:`([^`]+)`|(.+))$/;

/** Обратное `composeRoomMessage`: текст до «Attachments:» и пути по порядку. Хвоста нет — всё текст, вложений нет. */
export function splitRoomAttachments(text: string): { text: string; attachments: string[] } {
  const tail = TAIL.exec(text);
  if (tail === null) return { text, attachments: [] };
  const attachments = (tail[1] ?? '')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => {
      const item = ITEM.exec(line);
      return item?.[1] ?? item?.[2] ?? '';
    });
  return { text: text.slice(0, tail.index), attachments };
}
