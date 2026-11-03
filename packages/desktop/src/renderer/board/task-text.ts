/** Разбор текста новой задачи: первая непустая строка заголовка — заголовок, остальное уходит в детали. */
const MAX_TITLE = 4096;

export function splitTaskText(title: string, details: string): { title: string; details: string } {
  const lines = title.split(/\r?\n/);
  const first = lines.findIndex(line => line.trim() !== '');
  if (first === -1) return { title: '', details: details.trim() };
  let head = (lines[first] ?? '').trim();
  let rest = lines.slice(first + 1).join('\n').trim();
  if (head.length > MAX_TITLE) {
    const tail = head.slice(MAX_TITLE).trim();
    head = head.slice(0, MAX_TITLE).trim();
    rest = rest === '' ? tail : `${tail}\n${rest}`;
  }
  return { title: head, details: [rest, details.trim()].filter(part => part !== '').join('\n\n') };
}
