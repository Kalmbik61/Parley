/**
 * Заметка во вкладке диффа (кусок 8.4b, спека 11.4): карточка view zone под `endLine` своей стороны
 * (в одной колонке заметка к `original` — та же карточка в полосе над редактором секции).
 *
 * - Неотправленная: текст как есть, автор «You», время `en-US`, «Edit», «Delete», «Send ▾».
 * - Отправленная — свёрнута в строку «Sent to S02 · 2:05 PM»; удалить можно вручную.
 * - Устаревшая — приглушена с меткой «Outdated»; своей кнопкой её отправить можно, в пакет она не идёт.
 *
 * Карточка только сообщает о нажатиях: в агента уходит только «Send» (рамка 15.1).
 *
 * `useViewZones` — место под строкой (view zone) и карточка над ним (overlay widget), React рисует в
 * неё порталом. Высоту карточки Monaco не знает — её мерит `ResizeObserver` и отдаёт `layoutZone`.
 */

import { useLayoutEffect, useRef } from 'react';
import type { WorkEntry } from '@harnas/core';
import type { DiffNote } from '../../../shared/notes-types.js';
import { S } from '../../../shared/strings.js';
import { cn } from '../../lib/cn.js';
import { sessionTag } from '../../lib/participant.js';
import { Button } from '../../ui/button.js';
import { SendMenu } from './SendMenu.js';

export interface NoteZoneProps {
  note: DiffNote;
  entry: WorkEntry; // сессии работы — SendMenu
  defaultSessionId: string | null; // сессия диффа
  /** Подпись полосы одной колонки: `Original · line 7`. */
  caption?: string;
  onEdit(): void;
  onDelete(): void;
  onSend(sessionId: string): void;
}

/** Время `en-US` без даты: `2:05 PM`. */
export function noteTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

export function NoteZone({ note, entry, defaultSessionId, caption, onEdit, onDelete, onSend }: NoteZoneProps): JSX.Element {
  const captionNode =
    caption === undefined ? null : (
      <span className="shrink-0 font-mono text-[11px] text-muted-foreground" title={caption}>
        {caption}
      </span>
    );

  if (note.sentAt !== null) {
    const label = S.notes.sent(sessionTag(note.sentTo ?? ''), noteTime(note.sentAt));
    return (
      <div
        data-testid="note-zone"
        data-note-id={note.id}
        className="flex h-7 min-w-0 items-center gap-2 rounded-md border border-border bg-muted/40 px-2 text-xs text-muted-foreground"
      >
        {captionNode}
        <span className="shrink-0">{label}</span>
        <span data-testid="note-body" className="min-w-0 flex-1 truncate" title={note.body}>
          {note.body}
        </span>
        <Button type="button" variant="ghost" size="xs" onClick={onDelete}>
          {S.common.delete}
        </Button>
      </div>
    );
  }

  return (
    <div
      data-testid="note-zone"
      data-note-id={note.id}
      data-stale={note.stale ? 'true' : undefined}
      className={cn('flex min-w-0 flex-col gap-1.5 rounded-md border border-border bg-card p-2 text-xs text-card-foreground shadow-sm', note.stale && 'opacity-60')}
    >
      <div className="flex min-w-0 items-center gap-2 text-muted-foreground">
        {captionNode}
        <span className="shrink-0 font-medium text-foreground">{S.participants.human}</span>
        <span className="shrink-0 tabular-nums">{noteTime(note.createdAt)}</span>
        {note.stale ? <span className="shrink-0 rounded border border-border px-1 text-[10px] uppercase tracking-wide">{S.notes.stale}</span> : null}
      </div>
      <div
        data-testid="note-body"
        title={note.body}
        className="max-h-40 min-w-0 overflow-y-auto whitespace-pre-wrap break-words text-foreground"
      >
        {note.body}
      </div>
      <div className="flex min-w-0 items-center justify-end gap-1.5">
        <Button type="button" variant="ghost" size="xs" onClick={onEdit}>
          {S.notes.edit}
        </Button>
        <Button type="button" variant="ghost" size="xs" onClick={onDelete}>
          {S.common.delete}
        </Button>
        <SendMenu entry={entry} defaultSessionId={defaultSessionId} label={S.common.send} onSend={onSend} />
      </div>
    </div>
  );
}

/** Сторона diff-редактора — то, что нужно зонам от Monaco. */
export interface ZoneEditor {
  changeViewZones(callback: (accessor: ZoneAccessor) => void): void;
  addOverlayWidget(widget: OverlayWidget): void;
  removeOverlayWidget(widget: OverlayWidget): void;
  getLayoutInfo(): { contentLeft: number; contentWidth: number };
}

interface ZoneAccessor {
  addZone(zone: { afterLineNumber: number; heightInPx?: number; domNode: HTMLElement; onDomNodeTop?(top: number): void }): string;
  removeZone(id: string): void;
  layoutZone(id: string): void;
}

interface OverlayWidget {
  getId(): string;
  getDomNode(): HTMLElement;
  getPosition(): null;
}

export interface ZoneSpec {
  key: string;
  afterLineNumber: number;
}

/** Высота зоны до первого замера: карточка без переноса строк. */
const ESTIMATE_PX = 96;

interface Zone {
  id: string | null;
  afterLineNumber: number;
  height: number;
  /** Пустой узел view zone — только держит место под строкой; его высоту ставит Monaco. */
  node: HTMLElement;
  /** Карточка — overlay widget над местом зоны: в него рисует портал, его мерит `ResizeObserver`. */
  inner: HTMLElement;
  widget: OverlayWidget;
  observer: ResizeObserver | null;
}

let widgetSeq = 0;

function change(editor: ZoneEditor, callback: (accessor: ZoneAccessor) => void): void {
  try {
    editor.changeViewZones(callback);
  } catch {
    // Редактор уже отпущен (секция уходит вместе с ним) — убирать и мерить нечего. В консоль не
    // пишем: уход секции — обычное дело, а E2E окна считают предупреждения сбоем.
  }
}

function quietly(action: () => void): void {
  try {
    action();
  } catch {
    // То же: отпущенный редактор.
  }
}

/**
 * Зоны под строками одной стороны — как `ZoneWidget` VS Code: view zone держит место под строкой, а
 * карточка — overlay widget, который зона ставит на свою высоту (`onDomNodeTop`). Содержимое прямо в
 * view zone не годится: слой зон Monaco — `aria-hidden` и лежит под `.view-lines`, кнопки карточки
 * не получали бы ни нажатий, ни места в дереве доступности (замер E2E review.spec).
 *
 * Узел на ключ живёт, пока ключ в `specs`, — портал React в него не пересоздаётся. Смена строки — та
 * же карточка у зоны на новом месте (Monaco зону не двигает: убрать и добавить). Возвращает узлы по
 * ключам — в них рисует вызывающий, ещё до вставки зоны: поле заметки берёт фокус в своём эффекте.
 */
export function useViewZones(editor: ZoneEditor | null, specs: ZoneSpec[], maxWidth: number): Map<string, HTMLElement> {
  const zones = useRef(new Map<string, Zone>());
  const editorRef = useRef(editor);

  // Узлы — по ключам текущих specs; лишние уйдут в эффекте.
  for (const spec of specs) {
    if (!zones.current.has(spec.key)) {
      const node = document.createElement('div');
      node.setAttribute('data-note-zone', spec.key);
      const inner = document.createElement('div');
      inner.setAttribute('data-note-overlay', spec.key);
      // Отступы — карточка не липнет к строкам и краю редактора. До первой позиции — вне экрана.
      inner.style.padding = '4px 12px 4px 4px';
      inner.style.boxSizing = 'border-box';
      inner.style.top = '-1000000px';
      widgetSeq += 1;
      const id = `harnas.diff.note.${widgetSeq}`;
      const widget: OverlayWidget = { getId: () => id, getDomNode: () => inner, getPosition: () => null };
      zones.current.set(spec.key, { id: null, afterLineNumber: spec.afterLineNumber, height: ESTIMATE_PX, node, inner, widget, observer: null });
    }
  }

  const signature = specs.map((spec) => `${spec.key}@${spec.afterLineNumber}`).join('|');
  useLayoutEffect(() => {
    if (editor === null) return;
    editorRef.current = editor;
    const wanted = new Map(specs.map((spec) => [spec.key, spec.afterLineNumber]));
    const added: Zone[] = [];
    change(editor, (accessor) => {
      for (const [key, zone] of zones.current) {
        const line = wanted.get(key);
        if (line === undefined || line !== zone.afterLineNumber) {
          if (zone.id !== null) accessor.removeZone(zone.id);
          zone.id = null;
          if (line === undefined) {
            zone.observer?.disconnect();
            quietly(() => editor.removeOverlayWidget(zone.widget));
            zones.current.delete(key);
            continue;
          }
          zone.afterLineNumber = line;
        }
        if (zone.id !== null) continue;
        const spec = {
          afterLineNumber: zone.afterLineNumber,
          heightInPx: zone.height,
          domNode: zone.node,
          // Monaco зовёт на каждом кадре с видимой зоной; скрытая получает −1000000 — карточка вне экрана.
          // top — стилем, как у `ZoneWidget`: позицию overlay widget без предпочтения Monaco не трогает.
          onDomNodeTop: (top: number) => {
            zone.inner.style.top = `${top}px`;
          },
        };
        zone.id = accessor.addZone(spec);
        if (zone.observer === null) added.push(zone);
        if (zone.observer === null && typeof ResizeObserver !== 'undefined') {
          // Высота карточки — высота зоны: Monaco держит место ровно по `heightInPx`.
          zone.observer = new ResizeObserver(() => {
            const height = Math.ceil(zone.inner.getBoundingClientRect().height);
            if (height <= 0 || height === zone.height || zone.id === null) return;
            zone.height = height;
            spec.heightInPx = height;
            const id = zone.id;
            const target = editorRef.current;
            if (target !== null) change(target, (inner) => inner.layoutZone(id));
          });
          zone.observer.observe(zone.inner);
        }
      }
    });
    for (const zone of added) quietly(() => editor.addOverlayWidget(zone.widget));
    // specs сравниваются подписью: новый массив с теми же зонами эффект не перезапускает.
  }, [editor, signature]);

  useLayoutEffect(
    () => () => {
      const target = editorRef.current;
      const all = [...zones.current.values()];
      zones.current.clear();
      for (const zone of all) zone.observer?.disconnect();
      if (target === null) return;
      change(target, (accessor) => {
        for (const zone of all) if (zone.id !== null) accessor.removeZone(zone.id);
      });
      for (const zone of all) quietly(() => target.removeOverlayWidget(zone.widget));
    },
    [],
  );

  const left = editor === null ? 0 : editor.getLayoutInfo().contentLeft;
  const nodes = new Map<string, HTMLElement>();
  for (const spec of specs) {
    const zone = zones.current.get(spec.key);
    if (zone === undefined) continue;
    // Над текстом стороны, не шире его видимой части: иначе кнопки уехали бы за край.
    zone.inner.style.left = `${left}px`;
    zone.inner.style.width = `${Math.max(160, Math.min(720, maxWidth - 16))}px`;
    nodes.set(spec.key, zone.inner);
  }
  return nodes;
}
