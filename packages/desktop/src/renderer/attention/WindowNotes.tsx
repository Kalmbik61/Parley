/**
 * Уведомление в окне (спека окна 2026-09-29, 1.10; снимок handoff `dark-01`): справа снизу (right 16, bottom 40 —
 * над строкой статуса), 320px, радиус 16, фон `--popover` (`neutral-100`), `shadow-lg`, padding `12 14`. Значок
 * вопроса 14, заголовок 700, текст 12px вторичным цветом, кнопки `Open` и `Later`. Скрывается само через 8 с;
 * `Open` открывает цель — вкладку комнаты, тем же переходом, что клик по системному уведомлению (`App.tsx`).
 *
 * Карточек может стоять несколько — по одной на комнату (тег): новое уведомление той же комнаты заменяет прежнюю и
 * начинает отсчёт заново. Ниже диалогов и палитры (`z-40` против их `z-50`): пока человек занят ими, карточка не
 * перехватывает клики.
 */

import { useEffect, useRef } from 'react';
import { MessageCircleQuestion } from 'lucide-react';
import { toast } from 'sonner';
import { S } from '../../shared/strings.js';
import { Button } from '../ui/button.js';
import { applyFocusTarget, buildFocusTargetDeps } from './focus-target.js';
import { useWindowNotesStore, WINDOW_NOTE_MS, type ShownWindowNote } from './window-notes.js';

function WindowNoteCard({ note, onOpen }: { note: ShownWindowNote; onOpen: (note: ShownWindowNote) => void }): JSX.Element {
  const dismiss = useWindowNotesStore((state) => state.dismiss);

  // Скрытие через 8 с. Замена карточки — новый `seq`: эффект перезапускается, и отсчёт идёт заново; уход карточки
  // снимает таймер, чтобы он не тронул новую с тем же тегом.
  useEffect(() => {
    const timer = setTimeout(() => dismiss(note.tag, note.seq), WINDOW_NOTE_MS);
    return () => clearTimeout(timer);
  }, [dismiss, note.tag, note.seq]);

  return (
    <div
      data-window-note={note.tag}
      role="status"
      className="pointer-events-auto box-border flex items-start gap-2.5 rounded-md bg-popover px-3.5 py-3 text-popover-foreground shadow-lg"
    >
      <span className="inline-flex pt-0.5">
        <MessageCircleQuestion className="size-3.5 text-agent-question" aria-hidden="true" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="font-bold [overflow-wrap:anywhere]">{note.title}</span>
        <span className="text-xs text-muted-foreground [overflow-wrap:anywhere]">{note.body}</span>
        <div className="mt-2 flex gap-2">
          <Button type="button" onClick={() => onOpen(note)}>
            {S.notifications.open}
          </Button>
          <Button type="button" variant="outline" onClick={() => dismiss(note.tag, note.seq)}>
            {S.notifications.later}
          </Button>
        </div>
      </div>
    </div>
  );
}

export function WindowNotes(): JSX.Element | null {
  const notes = useWindowNotesStore((state) => state.notes);
  const dismiss = useWindowNotesStore((state) => state.dismiss);
  // Ожидание показа вкладки (`whenShown`) не переживает окно: опрос DOM после размонтирования — «document is not
  // defined» из таймера в jsdom, а в окне — работа вхолостую. Отмена общая, а не на карточку: карточка после `Open`
  // уходит сразу, и с ней ушло бы ожидание, ради которого вкладка вспыхивает. Контроллер заводится в эффекте, а не в
  // `useRef(new …)`: StrictMode прогоняет эффект дважды, и отменённый после первого прогона больше бы не ожил.
  const unmounted = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    unmounted.current = controller;
    return () => controller.abort();
  }, []);

  const open = (note: ShownWindowNote): void => {
    dismiss(note.tag, note.seq);
    // Цели уже нет (комнату закрыли, работу удалили) — тот же тост, что у клика по системному уведомлению.
    if (!applyFocusTarget(note.target, buildFocusTargetDeps(unmounted.current?.signal))) toast(S.notifications.targetGone);
  };

  if (notes.length === 0) return null;
  return (
    <div data-window-notes="" className="pointer-events-none fixed bottom-10 right-4 z-40 flex w-80 max-w-[calc(100%-32px)] flex-col gap-2">
      {notes.map((note) => (
        <WindowNoteCard key={note.tag} note={note} onOpen={open} />
      ))}
    </div>
  );
}
