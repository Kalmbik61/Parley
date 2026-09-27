/**
 * Тело вкладки «Изменения» (кусок 2.4): нынешний `ChangesPanel` этапа 4 плана
 * worktree — до 8.3, когда его сменит панель, знающая про отдельный коммит
 * (`TabSpec` вида `diff` уже несёт `commit`, но открывать вкладку на конкретный
 * коммит пока неоткуда — `tabMeta` лишь готовит для него заголовок, спека 5.2).
 * Сессия без worktree — та же короткая заглушка, что раньше показывал
 * `panel-registry.tsx#ChangesPanelContent`: закрыть висящую вкладку решает
 * человек, а не эта заглушка сама.
 */

import type { WorkSession } from '@harnas/core';
import type { SessionRef } from '@harnas/protocol';
import type { HarnasBridge } from '../../../shared/bridge.js';
import { S } from '../../../shared/strings.js';
import { ChangesPanel } from '../../components/changes/ChangesPanel.js';

export interface DiffBodyProps {
  bridge: HarnasBridge;
  sessionRef: SessionRef;
  /** Сессия найдена в карте (иначе `GroupView` показал бы `MissingBody`) — worktree может всё ещё быть `null`. */
  session: WorkSession;
}

export function DiffBody({ bridge, sessionRef, session }: DiffBodyProps): JSX.Element {
  if (session.worktree === null) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        {S.errors.noWorktree}
      </div>
    );
  }
  return <ChangesPanel bridge={bridge} sessionRef={sessionRef} base={session.worktree.base} />;
}
