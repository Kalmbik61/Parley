/**
 * Диалог «New room» из двух сессий (кусок 7 плана «Organic», спека окна 2026-09-29, 1.6, 2.5): человек бросил
 * сессию на другую сессию той же работы. Название (пустое — `Room {n}`) и ведущий — одна из двух сессий, по
 * умолчанию та, на которую бросили. «Create room» → `rooms.create` с двумя участниками, выбранным `lead`,
 * `origin: [перетащенная, цель]` — хост первой строкой ленты напишет `Room created from @s03 and @s02` — и
 * `quiet: true`: обе сессии уже работают, задачу человек напишет в комнату, приглашения не нужны.
 * Обе сессии уходят из прежних комнат работы: это правило «одна комната на сессию» хоста (решение 4).
 *
 * Открывается по состоянию `dialogs.mergeRoom` (бросок в `shell/AppShell.tsx`); сессии диалог берёт из снимка
 * работ, а не из состояния: пока он открыт, сессию могли удалить — тогда диалог закрывается сам. После создания
 * комната открывается вкладкой и разворачивается в сайдбаре, когда снимок её принёс (`lib/open-when-listed.ts`).
 *
 * Облик — 1.6 и снимок `dark-13`: ширина 420, выбранная пилюля ведущего — рамка `--ring` (в тёмной теме это `accent`,
 * как в спеке; в светлой `accent-600`, чистый `accent` даёт к фону диалога 2.69:1), фон `neutral-100`.
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { WorkSession } from '@harnas/core';
import type { HarnasBridge } from '../../../shared/bridge.js';
import { decodeIpcError } from '../../../shared/ipc-error.js';
import { errorText, S } from '../../../shared/strings.js';
import { cn } from '../../lib/cn.js';
import { openWhenListed } from '../../lib/open-when-listed.js';
import { sessionRowLabel } from '../../lib/participant.js';
import { useWorksStore } from '../../store/works.js';
import { Button } from '../../ui/button.js';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogTitle } from '../../ui/dialog.js';
import { Input } from '../../ui/input.js';
import { AgentIcon } from '../AgentIcon.js';
import { radioGroupKeyDown } from './radio-keys.js';

export interface MergeRoomDialogProps {
  open: boolean;
  bridge: HarnasBridge;
  projectPath: string;
  workId: string;
  /** Сессия, которую бросили. */
  dragged: string;
  /** Сессия, на которую бросили: ведущая по умолчанию. */
  target: string;
  onOpenChange: (open: boolean) => void;
}

export function MergeRoomDialog({ open, bridge, projectPath, workId, dragged, target, onOpenChange }: MergeRoomDialogProps): JSX.Element {
  const entry = useWorksStore((state) =>
    state.entries.find((item) => item.projectPath === projectPath && item.map.work.id === workId),
  );
  const targetSession = entry?.map.sessions.find((session) => session.id === target);
  const draggedSession = entry?.map.sessions.find((session) => session.id === dragged);
  /** Порядок пилюль и подзаголовка — как в макете: та, на которую бросили, первой. */
  const pair: readonly [WorkSession, WorkSession] | null =
    targetSession === undefined || draggedSession === undefined ? null : [targetSession, draggedSession];
  const ready = entry !== undefined && pair !== null;

  const [title, setTitle] = useState('');
  const [lead, setLead] = useState(target);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Снятия ожиданий снимка (`openWhenListed`) — все гасятся при размонтировании. */
  const pendingRef = useRef(new Set<() => void>());

  useEffect(() => {
    const pending = pendingRef.current;
    return () => {
      for (const cancel of [...pending]) cancel();
    };
  }, []);

  // Каждый бросок — с чистой формой; ведущий — та, на которую бросили. Сброс — до отрисовки (`useLayoutEffect`): в `useEffect`
  // он шёл после неё, и поле успевало показаться со значениями прошлого броска (E2E rooms-dialogs, перетаскивание: набранное
  // сразу после открытия название пропало).
  useLayoutEffect(() => {
    if (!open) return;
    setTitle('');
    setLead(target);
    setError(null);
    setBusy(false);
  }, [open, projectPath, workId, dragged, target]);

  // Работу или одну из сессий успели удалить, пока диалог был открыт, — комнаты из них не собрать.
  useEffect(() => {
    if (open && !ready) onOpenChange(false);
  }, [open, ready, onOpenChange]);

  const submit = async (): Promise<void> => {
    // Второй клик приходит уже на выключенную кнопку: `busy` включается до него.
    if (busy || entry === undefined) return;
    setBusy(true);
    setError(null);
    try {
      const trimmed = title.trim();
      const { roomId } = await bridge.call('rooms.create', {
        projectPath,
        workId,
        title: trimmed === '' ? S.dialogs.defaultRoomTitle(entry.map.rooms.length + 1) : trimmed,
        members: [target, dragged],
        lead,
        origin: [dragged, target],
        quiet: true,
      });
      openWhenListed(projectPath, workId, { kind: 'room', roomId }, pendingRef.current);
      onOpenChange(false);
    } catch (err) {
      console.warn('[harnas] rooms.create', err);
      setError(errorText(decodeIpcError(err).code, S.errors.actions.createRoom));
    } finally {
      setBusy(false);
    }
  };

  const text = S.dialogs.mergeRoom;

  return (
    <Dialog open={open && ready} onOpenChange={onOpenChange}>
      <DialogContent className="w-[420px] max-w-[calc(100vw-2rem)]">
        <div className="flex shrink-0 flex-col gap-0.5">
          <DialogTitle>{text.title}</DialogTitle>
          <DialogDescription className="text-xs text-neutral-700">
            {pair === null ? '' : text.movingInto(sessionRowLabel(pair[0].id, pair[0].label), sessionRowLabel(pair[1].id, pair[1].label))}
          </DialogDescription>
        </div>
        <div className="flex min-w-0 flex-col gap-3 text-sm">
          <label className="flex min-w-0 flex-col gap-1">
            {text.nameField}
            <Input value={title} placeholder={text.namePlaceholder} onChange={(event) => setTitle(event.target.value)} />
          </label>
          <div className="flex min-w-0 flex-col gap-1">
            <span id="merge-room-lead">{text.leadField}</span>
            <div role="radiogroup" aria-labelledby="merge-room-lead" onKeyDown={radioGroupKeyDown} className="flex min-w-0 flex-col gap-1.5">
              {(pair ?? []).map((session) => {
                const on = session.id === lead;
                return (
                  <button
                    key={session.id}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    tabIndex={on ? 0 : -1}
                    onClick={() => setLead(session.id)}
                    className={cn(
                      'flex h-[38px] min-w-0 items-center gap-2 rounded-full border px-3.5 text-left text-[13px] transition-colors',
                      on ? 'border-ring bg-neutral-100' : 'border-border hover:border-foreground/45',
                    )}
                  >
                    <span aria-hidden="true" className="inline-flex">
                      <AgentIcon provider={session.provider} size={14} />
                    </span>
                    <span className="max-w-[70%] shrink-0 truncate font-semibold">{sessionRowLabel(session.id, session.label)}</span>
                    <span className="min-w-0 flex-1 truncate text-neutral-700">{session.task}</span>
                  </button>
                );
              })}
            </div>
          </div>
          {error !== null ? <p className="text-destructive">{error}</p> : null}
        </div>
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline">
              {S.common.cancel}
            </Button>
          </DialogClose>
          <Button type="button" disabled={busy || !ready} onClick={() => void submit()}>
            {text.submit}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
