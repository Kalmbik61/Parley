/**
 * Адрес страницы в ответе агенту (аудит 4.1, S6): страница сама задаёт свой адрес, поэтому в ответ он идёт после маски
 * и не длиннее `URL_LIMIT` знаков — мегабайтный адрес не съедает бюджет ответа и не прячет в нём текст.
 */
import { cutCodePoints } from '../../shared/code-points.js';
import { redactUrl } from '../../shared/redact.js';

const URL_LIMIT = 512;

/** Не длиннее 512 знаков, считая «…»; кодовая пара не рвётся. Маска (`redactUrl`) — до обрезки, чтобы секрет не мог встать на границу. */
export function clipUrl(url: string): string {
  const head = cutCodePoints(url, URL_LIMIT);
  if (!head.cut) return url;
  return `${cutCodePoints(head.text, URL_LIMIT - 1).text}…`;
}

/** Адрес для ответа: маска, затем обрезка. */
export const urlForAgent = (url: string): string => clipUrl(redactUrl(url));
