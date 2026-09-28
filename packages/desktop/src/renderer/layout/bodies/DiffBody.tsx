/**
 * Тело вкладки диффа (кусок 2.4; с 8.3 — `review/DiffTab.tsx` на Monaco, спека 11.3). Заглушки
 * «нет worktree» больше нет: у сессии без worktree вкладка показывает изменения папки проекта.
 *
 * `DiffTab` грузится лениво, как редактор вкладки файла (7.3b): он тянет Monaco, а окно без
 * открытого диффа его не грузит. Сбой загрузки чанка — своя граница с «Retry», который грузит
 * чанк заново (`lazyWithRetry`); граница `GroupView` — запасная.
 */

import { Suspense } from 'react';
import type { WorkEntry } from '@harnas/core';
import type { HarnasBridge } from '../../../shared/bridge.js';
import type { TabSpec } from '../../../shared/layout-types.js';
import { S } from '../../../shared/strings.js';
import { lazyWithRetry } from '../../files/editor/retry-lazy.js';
import { ErrorBoundary } from '../../shell/ErrorBoundary.js';
import type { SendWithToastDeps } from '../../terminal/send.js';

const lazyDiffTab = lazyWithRetry(async () => (await import('../../review/DiffTab.js')).DiffTab);

export interface DiffBodyProps {
  bridge: HarnasBridge;
  workKey: string;
  /** Сессия вкладки есть в карте — иначе `GroupView` показал бы `MissingBody`. */
  entry: WorkEntry;
  tab: Extract<TabSpec, { kind: 'diff' }>;
  font?: { family: string; size: number };
  /** Отправка агенту окна (7.2) — заметкам диффа (8.4b). */
  sendDeps: SendWithToastDeps;
}

export function DiffBody({ bridge, workKey, entry, tab, font, sendDeps }: DiffBodyProps): JSX.Element {
  const { component: DiffTab, retry } = lazyDiffTab.use();
  return (
    <ErrorBoundary title={S.files.editorFailed} onRetry={retry}>
      <Suspense fallback={<div className="flex h-full items-center justify-center text-sm text-muted-foreground">{S.changes.loading}</div>}>
        <DiffTab bridge={bridge} workKey={workKey} entry={entry} tab={tab} sendDeps={sendDeps} {...(font === undefined ? {} : { font })} />
      </Suspense>
    </ErrorBoundary>
  );
}
