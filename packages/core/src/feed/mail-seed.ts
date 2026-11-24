/**
 * Сев писем «вместе с указателем» из журнала почты Parley (спека 2026-11-12, 3.2a). Журнал — строки `{at, text}`, которые
 * хост пишет перед ответом хуку; запись `attachment` журнала Claude лишь указывает место, а содержимое и время берутся
 * из журнала. Доставка без записи в журнале Claude (CLI её не записал) встаёт после последнего указателя-промпта.
 */
import { isPointerText } from '../work/delivery.js';
import { mailFromInline } from './mail.js';
import type { FeedItem, FeedMail } from './types.js';

/** Строка журнала почты: `text` — точный `additionalContext`, `at` — время ответа хоста. */
export interface MailJournalEntry {
  at: string;
  text: string;
}

/** Доставки журнала по id элемента; битые строки и повторы пропускаются (побеждает первая). */
export function mailJournalIndex(entries: readonly MailJournalEntry[] | undefined): Map<string, FeedMail> {
  const index = new Map<string, FeedMail>();
  for (const entry of entries ?? []) {
    const mail = mailFromInline(entry.text, entry.at);
    if (mail !== null && !index.has(mail.id)) index.set(mail.id, mail);
  }
  return index;
}

/**
 * Вставляет в `items` доставки журнала, которых там нет: после последнего указателя-промпта, не позже доставки
 * по времени (за ним уже стоящие `mail` остаются раньше). Указателя нет — по времени; если доставка старше всей ленты,
 * она осталась за краем прочитанного хвоста и пропускается.
 */
export function insertJournalMail(items: readonly FeedItem[], index: ReadonlyMap<string, FeedMail>): FeedItem[] {
  const out = [...items];
  const present = new Set(out.map((item) => item.id));
  const missing = [...index.values()].filter((mail) => !present.has(mail.id)).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  for (const mail of missing) {
    let prompt = -1;
    for (let i = out.length - 1; i >= 0; i -= 1) {
      const item = out[i] as FeedItem;
      if (item.kind === 'prompt' && isPointerText(item.text) && Date.parse(item.at) <= Date.parse(mail.at)) {
        prompt = i;
        break;
      }
    }
    if (prompt !== -1) {
      let position = prompt + 1;
      while (out[position]?.kind === 'mail') position += 1;
      out.splice(position, 0, mail);
      continue;
    }
    const first = out[0];
    if (first !== undefined && Date.parse(mail.at) < Date.parse(first.at)) continue;
    const later = out.findIndex((item) => Date.parse(item.at) > Date.parse(mail.at));
    out.splice(later === -1 ? out.length : later, 0, mail);
  }
  return out;
}
