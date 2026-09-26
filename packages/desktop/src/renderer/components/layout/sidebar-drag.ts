/**
 * Полезная нагрузка перетаскивания строки сайдбара в сетку (кусок 2.1 плана
 * окна). Свой MIME-тип и JSON: чужой drag (файл из Finder, текст из другого
 * приложения, перетаскивание внутри самого dockview) не должен превращаться
 * в панель — `Workspace.tsx` слушает `onDidDrop` для ЛЮБОГО дропа над сеткой,
 * и обязан отличить «наш» drag от прочих.
 */

import type { PanelSpec } from '../../lib/panel-id.js';

export const DRAG_MIME = 'application/x-harnas-panel';

export function dragPayload(spec: PanelSpec): string {
  return JSON.stringify(spec);
}

const KNOWN_KINDS = new Set<PanelSpec['kind']>(['terminal', 'mail', 'room', 'changes']);

function isPanelSpec(value: unknown): value is PanelSpec {
  if (typeof value !== 'object' || value === null) return false;
  const spec = value as Partial<PanelSpec>;
  if (typeof spec.workKey !== 'string') return false;
  if (typeof spec.kind !== 'string' || !KNOWN_KINDS.has(spec.kind)) return false;
  return true;
}

/** `null` — не наш MIME на этом дропе или JSON внутри него битый/не той формы. */
export function readDragPayload(event: Pick<DragEvent, 'dataTransfer'>): PanelSpec | null {
  const raw = event.dataTransfer?.getData(DRAG_MIME);
  if (raw === undefined || raw === '') return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isPanelSpec(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
