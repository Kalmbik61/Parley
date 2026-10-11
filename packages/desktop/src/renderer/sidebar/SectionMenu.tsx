/**
 * Меню «⋯» заголовка секции сайдбара (кусок 3.4, спека 6.1): переключатель «Show done» —
 * `ui.json.showDoneWorks`. Открытое меню держит порядок сайдбара. В handoff (Organic) у заголовка проекта
 * его нет, поэтому кнопка не занимает место на виду: она проявляется под курсором на заголовке (`group`
 * заголовка), на фокусе с клавиатуры и пока меню открыто.
 *
 * «Remove from list…» (спека архива комнат и проектов, 6.3) у проекта убирает его из сайдбара и ничего не удаляет:
 * путь ложится в `ui.json.hiddenProjects`, а вернётся проект сам, когда в нём появится неархивная работа
 * (`use-sidebar-sections.ts`). Пункт доступен, только когда у проекта нет неархивных работ: скрыть проект с
 * работающими агентами значит потерять их внимание. Иначе он выключен с подсказкой «Archive its workspaces first».
 */

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { decodeIpcError } from '../../shared/ipc-error.js';
import { getHostClient } from '../host-client.js';
import { openFile } from '../files/Tree.js';
import { useLayoutStore } from '../layout/store.js';
import { workKey } from '../lib/tree-order.js';
import { useWorksStore } from '../store/works.js';
import { MoreHorizontal } from 'lucide-react';
import { errorText, S } from '../../shared/strings.js';
import { cn } from '../lib/cn.js';
import { useUiStore } from '../store/ui.js';
import { ConfirmDialog } from '../components/dialogs/ConfirmDialog.js';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu.js';
import { folderName } from './sort.js';
import { useSidebarHold } from './use-sidebar-hold.js';

export interface SectionMenuProps {
  /** Ключ секции — `pinned` или `projectPath`: у каждого меню свой держатель порядка. */
  sectionKey: string;
}

/** Use the existing project editor and its root authorization, including for notice actions. */
export function openParleyEditor(projectPath: string, workId?: string): void {
  const layout = useLayoutStore.getState();
  const entries = useWorksStore.getState().entries.filter((entry) => entry.projectPath === projectPath);
  const entry = entries.find((item) => workId === undefined
    ? workKey(projectPath, item.map.work.id) === layout.activeWorkKey : item.map.work.id === workId) ?? entries[0];
  if (entry === undefined) { toast(S.notifications.targetGone); return; }
  const key = workKey(projectPath, entry.map.work.id);
  layout.setActiveWork(key);
  openFile({ workKey: key, spec: { kind: 'project' } }, 'PARLEY.md', false);
}

export function SectionMenu({ sectionKey }: SectionMenuProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  useSidebarHold(`section-menu ${sectionKey}`, open || confirmRemove);
  const [exists, setExists] = useState<boolean | null>(null);
  useEffect(() => {
    if (!open || sectionKey === 'pinned') return;
    let disposed = false;
    setExists(null);
    void getHostClient().app.parleyMd(sectionKey, false).then((result) => {
      if (!disposed) setExists(result.exists);
    }).catch((error: unknown) => {
      if (disposed) return;
      console.warn('[parley] PARLEY.md status', error);
      toast(errorText(decodeIpcError(error).code, S.errors.actions.openFile));
    });
    return () => { disposed = true; };
  }, [open, sectionKey]);
  const openParley = async (): Promise<void> => {
    try {
      const result = await getHostClient().app.parleyMd(sectionKey, exists === false);
      if (!result.exists) { toast(errorText('not_found', S.errors.actions.openFile)); return; }
      openParleyEditor(sectionKey);
    } catch (error) {
      console.warn('[parley] PARLEY.md open/create', error);
      toast(errorText(decodeIpcError(error).code, exists === false ? S.errors.actions.createParleyMd : S.errors.actions.openFile));
    }
  };
  const showDone = useUiStore((state) => state.ui.showDoneWorks);
  // Неархивная работа проекта (done тоже): пока она есть, проект из списка не убрать.
  const hasLiveWork = useWorksStore((state) =>
    state.entries.some((entry) => entry.projectPath === sectionKey && entry.map.work.status !== 'archived'),
  );
  const removeProject = (): void => {
    const { ui, patchUi } = useUiStore.getState();
    patchUi({ hiddenProjects: [...ui.hiddenProjects.filter((path) => path !== sectionKey), sectionKey] });
  };
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={S.sidebar.sectionMenu}
          title={S.sidebar.sectionMenu}
          // Клик по «⋯» — не клик по заголовку: группа не должна свернуться.
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
          className={cn(
            'inline-flex size-6 shrink-0 items-center justify-center rounded-full text-work-sidebar-muted-foreground transition-opacity',
            'opacity-0 focus-visible:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100',
            'hover:bg-foreground/10 hover:text-work-sidebar-foreground',
          )}
        >
          <MoreHorizontal className="size-3.5" aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {sectionKey !== 'pinned' && <DropdownMenuItem onSelect={() => useUiStore.getState().openProjectPanel(sectionKey)}
          data-section-action="capabilities">{S.actions.capabilities}</DropdownMenuItem>}
        {sectionKey !== 'pinned' && <DropdownMenuItem disabled={exists === null}
          onSelect={() => { void openParley(); }} data-section-action="parley-md">
          {exists === false ? S.sidebar.createParleyMd : S.sidebar.openParleyMd}
        </DropdownMenuItem>}
        <DropdownMenuCheckboxItem
          checked={showDone}
          onCheckedChange={(checked) => useUiStore.getState().patchUi({ showDoneWorks: checked })}
        >
          {S.sidebar.showDone}
        </DropdownMenuCheckboxItem>
        {sectionKey !== 'pinned' && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              disabled={hasLiveWork}
              data-section-action="remove-from-list"
              // Выключенный пункт гасит указатель, а тултипу он нужен: подсказка видна и на выключенном.
              className="data-[disabled]:pointer-events-auto"
              {...(hasLiveWork ? { title: S.sidebar.removeFromListBlocked } : null)}
              onSelect={() => setConfirmRemove(true)}
            >
              {S.sidebar.removeFromList}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
      {sectionKey !== 'pinned' && (
        <ConfirmDialog
          open={confirmRemove}
          title={S.sidebar.removeProjectTitle(folderName(sectionKey))}
          description={S.sidebar.removeProjectDescription}
          // Ничего не удаляется и возврат сам, поэтому кнопка обычная, а не красная.
          confirmVariant="default"
          confirmLabel={S.sidebar.removeProjectConfirm}
          onConfirm={removeProject}
          onOpenChange={setConfirmRemove}
        />
      )}
    </DropdownMenu>
  );
}
