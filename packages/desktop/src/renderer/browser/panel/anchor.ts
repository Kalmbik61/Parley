/**
 * CSS-якоря панели браузера (спека браузера 4.11). Страницы панели живут в слое поверхностей работы (`PanelSurface`),
 * а место под них резервирует вид хозяина (`PanelHost`): пустой «участок панели» с именем якоря, на который слой и встаёт.
 * - `area` — сам участок: рядом с видом (широкий вид) или поверх него (узкий). На него встаёт панель.
 * - `reserve` — только ширина, которую панель отбирает у вида: у участка рядом с видом он есть, у участка поверх вида
 *   нет. По нему терминал сессии уступает панели место (`TerminalSurface`, `reserveAnchor`).
 * Имя несёт и работу: id сессий и комнат (`s-01`) повторяются от работы к работе, а контейнеры трёх последних работ
 * смонтированы разом.
 */

import type { BrowserOwner } from '../../../shared/layout-types.js';
import { ownerKey } from '../../layout/ids.js';

export type PanelAnchorRole = 'area' | 'reserve';

/** Короткий хэш ключа работы: путь проекта в имени якоря не нужен и содержит символы, которых в нём быть не может. */
function hashOf(text: string): string {
  let hash = 5381;
  for (let i = 0; i < text.length; i += 1) hash = (Math.imul(hash, 33) + text.charCodeAt(i)) | 0;
  return (hash >>> 0).toString(36);
}

export function panelAnchor(workKey: string, owner: BrowserOwner, role: PanelAnchorRole): string {
  const prefix = role === 'area' ? 'bp' : 'bpr';
  return `--${prefix}-${hashOf(workKey)}-${ownerKey(owner).replace(/[^A-Za-z0-9_-]/g, '_')}`;
}
