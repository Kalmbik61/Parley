/**
 * Меню строки комнаты по правой кнопке. Открытая комната: «Rename», «Archive…», разделитель, «Delete…». Архивная
 * (спека архива комнат, 5.1): «Reopen», «Rename», разделитель, «Delete…». Пункты с методами, которых хост не знает,
 * спрятаны (`useHostSupports`); без единого пункта строка меню не заводит, и правая кнопка открывает меню карточки, как
 * раньше. Ошибка хоста — тост `errorText(код, действие)`, текст хоста — только в консоль (сквозное правило E.1).
 *
 * «Rename» открывает поле на месте названия в строке (`RoomInlineRename`). «Archive…» спрашивает подтверждение с
 * флажком «Also stop its N agents that are in no other room», включённым по умолчанию: архивируют, когда работа
 * закончена, а остановка обратима (сессия засыпает, её поднимает Resume или письмо). N — сессии, которых архивация
 * оставит без открытой комнаты (`CardRoomRow.archiveStops`, правило core); их нет — флажка нет. Живое решение и живой
 * план архивация закрывает, и описание об этом предупреждает. «Reopen» зовёт `rooms.reopen` без вопросов. «Delete…» спрашивает подтверждение с
 * флажком «Also delete its N sessions», снятым по умолчанию: комната уходит с лентой, а её сессии остаются обычными
 * сессиями работы — хост пишет живым из них, что комнаты больше нет. С флажком окно сначала удаляет сессии комнаты
 * тем же путём, что пункт «Delete» строки сессии (`SessionRowMenu`): вкладки файлов их worktree — с вопросом о правках
 * (кусок 7.3a), затем `sessions.delete` каждой (остановка, worktree, карта), и только потом `rooms.delete`. Порядок
 * держит окно, а не хост, по двум причинам: вопрос о несохранённых правках умеет задать только окно, а отказ
 * `sessions.delete` (грязный worktree — `conflict`) должен остановить удаление, пока комната ещё цела, — как
 * `CardMenu` останавливает «Delete…» работы на отказе `sessions.stop`. К `rooms.delete` удалённых сессий в карте уже
 * нет, и прощальных писем им хост не пишет. Сессии — те, что сайдбар поставил в эту комнату (`CardRoomRow.sessions`):
 * их же человек видит в строке и их же считает флажок.
 *
 * Вкладка удалённой комнаты закрывается сама: из снимка пропала комната — живая раскладка выбрасывает её вкладки
 * (`isTabAlive` в `layout/persistence.ts`), как вкладки удалённой сессии.
 */

import { useRef, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import type { ParleyBridge } from '../../shared/bridge.js';
import { decodeIpcError } from '../../shared/ipc-error.js';
import { errorText, S } from '../../shared/strings.js';
import { roomAwaitsDecision } from '../attention/derive.js';
import { ConfirmDialog } from '../components/dialogs/ConfirmDialog.js';
import { fileTabIds } from '../files/close-guard.js';
import { useLayoutStore } from '../layout/store.js';
import { useHostSupports } from '../lib/capabilities.js';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from '../ui/context-menu.js';
import { DESTRUCTIVE_ITEM } from './CardMenu.js';
import type { CardRoomRow } from './sort.js';
import { useSidebarHold } from './use-sidebar-hold.js';
import { focusSidebarItem, returnCursorFocus } from './use-sidebar-keys.js';

export interface RoomRowMenuProps {
  workKey: string;
  projectPath: string;
  workId: string;
  row: CardRoomRow;
  bridge: ParleyBridge;
  /** «Rename» — поле на месте названия в строке комнаты. */
  onRename(): void;
  /** У комнаты идёт живой план (`active`, `completing`): подтверждение архивации предупреждает, что план отменится. */
  livePlan?: boolean;
  /** Строка — триггер ui/context-menu. */
  children: ReactNode;
}

export function RoomRowMenu({ workKey, projectPath, workId, row, bridge, onRename, livePlan = false, children }: RoomRowMenuProps): JSX.Element {
  const { room, sessions, archived, archiveStops } = row;
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);
  // «Rename» открывает поле на месте названия; закрытое меню вернуло бы фокус строке уже после того, как поле его
  // взяло, — поле потеряло бы фокус и закрылось (тот же приём, что у `CardMenu`).
  const renameChosen = useRef(false);
  useSidebarHold(`room-menu ${workKey} ${room.id}`, open || confirm || confirmArchive);
  const canRename = useHostSupports('rooms.rename');
  const canDelete = useHostSupports('rooms.delete');
  const canArchive = useHostSupports('rooms.archive');
  const canReopen = useHostSupports('rooms.reopen');
  // Открытой комнате — «Archive…», архивной — «Reopen»: одно из двух, и только если хост умеет.
  const canSwitch = archived ? canReopen : canArchive;
  if (!canRename && !canDelete && !canSwitch) return <>{children}</>;

  const title = room.title === '' ? S.rooms.fallbackTitle : room.title;

  const deleteRoom = async (withSessions: boolean): Promise<void> => {
    if (withSessions) {
      const ids = new Set(sessions.map((session) => session.id));
      const store = useLayoutStore.getState();
      const own = fileTabIds(store.layouts[workKey], (root) => root.kind === 'worktree' && ids.has(root.sessionId));
      // «Отмена» в вопросе о правках — ни одного вызова: ни сессии, ни комната не удаляются.
      if (own.length > 0 && !(await store.requestCloseTabs(workKey, own))) return;
      for (const session of sessions) {
        await bridge.call('sessions.delete', { ref: { projectPath, workId, sessionId: session.id } });
      }
    }
    await bridge.call('rooms.delete', { projectPath, workId, roomId: room.id });
  };

  const reopenRoom = (): void => {
    bridge.call('rooms.reopen', { projectPath, workId, roomId: room.id }).catch((error: unknown) => {
      console.warn('[parley] rooms.reopen', error);
      toast(errorText(decodeIpcError(error).code, S.errors.actions.reopenRoom));
    });
  };

  const archiveRoom = (stopSessions: boolean): void => {
    bridge.call('rooms.archive', { projectPath, workId, roomId: room.id, stopSessions }).catch((error: unknown) => {
      console.warn('[parley] rooms.archive', error);
      toast(errorText(decodeIpcError(error).code, S.errors.actions.archiveRoom));
    });
  };

  const decision = roomAwaitsDecision(room);
  const archiveDescription =
    S.sidebar.roomMenu.archiveConfirmDescription +
    (decision || livePlan ? S.sidebar.roomMenu.archiveConfirmOpenWork(decision, livePlan) : '');

  return (
    <>
      <ContextMenu onOpenChange={setOpen}>
        {/* `data-room-menu` ложится на узел строки: по нему Shift+F10 сайдбара знает, что у комнаты есть своё меню. */}
        <ContextMenuTrigger asChild data-room-menu="">
          {children}
        </ContextMenuTrigger>
        <ContextMenuContent
          onCloseAutoFocus={(event) => {
            if (!renameChosen.current) {
              returnCursorFocus(event);
              return;
            }
            renameChosen.current = false;
            event.preventDefault();
          }}
        >
          {archived && canReopen ? (
            <ContextMenuItem data-room-action="reopen" onSelect={reopenRoom}>
              {S.sidebar.roomMenu.reopen}
            </ContextMenuItem>
          ) : null}
          {canRename ? (
            <ContextMenuItem
              data-room-action="rename"
              onSelect={() => {
                renameChosen.current = true;
                onRename();
              }}
            >
              {S.sidebar.roomMenu.rename}
            </ContextMenuItem>
          ) : null}
          {!archived && canArchive ? (
            <ContextMenuItem data-room-action="archive" onSelect={() => setConfirmArchive(true)}>
              {S.sidebar.roomMenu.archiveEllipsis}
            </ContextMenuItem>
          ) : null}
          {(canRename || canSwitch) && canDelete ? <ContextMenuSeparator /> : null}
          {canDelete ? (
            <ContextMenuItem data-room-action="delete" className={DESTRUCTIVE_ITEM} onSelect={() => setConfirm(true)}>
              {S.sidebar.roomMenu.deleteEllipsis}
            </ContextMenuItem>
          ) : null}
        </ContextMenuContent>
      </ContextMenu>

      <ConfirmDialog
        open={confirmArchive}
        title={S.sidebar.roomMenu.archiveConfirmTitle(title)}
        description={archiveDescription}
        // Флажка нет, когда останавливать некого: «Also stop its 0 agents» ничего бы не значил. Включён по умолчанию.
        {...(archiveStops.length === 0
          ? {}
          : { checkbox: S.sidebar.roomMenu.archiveStopAgents(archiveStops.length), checkboxChecked: true })}
        // Архив обратим (Reopen), поэтому кнопка обычная, а не красная, как у «Delete».
        confirmVariant="default"
        confirmLabel={S.sidebar.roomMenu.archive}
        onConfirm={(stopSessions) => archiveRoom(archiveStops.length > 0 && stopSessions)}
        onOpenChange={setConfirmArchive}
        onCloseAutoFocus={(event) => focusSidebarItem(event, { workKey, sessionId: null, roomId: room.id })}
      />

      <ConfirmDialog
        open={confirm}
        title={S.sidebar.roomMenu.deleteConfirmTitle(title)}
        description={S.sidebar.roomMenu.deleteConfirmDescription}
        // Флажка нет, когда удалять нечего: «Also delete its 0 sessions» ничего бы не значил.
        {...(sessions.length === 0 ? {} : { checkbox: S.sidebar.roomMenu.deleteSessions(sessions.length) })}
        confirmLabel={S.common.delete}
        onConfirm={(withSessions) => {
          deleteRoom(withSessions).catch((error: unknown) => {
            console.warn('[parley] rooms.delete', error);
            toast(errorText(decodeIpcError(error).code, S.errors.actions.deleteRoom));
          });
        }}
        onOpenChange={setConfirm}
        // Подтверждение открыто пунктом меню, которого уже нет: фокус — строке комнаты, а её нет — карточке.
        onCloseAutoFocus={(event) => focusSidebarItem(event, { workKey, sessionId: null, roomId: room.id })}
      />
    </>
  );
}
