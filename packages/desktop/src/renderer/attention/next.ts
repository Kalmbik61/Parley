/**
 * «Следующая, где нужен ты» (спека 7.6): клик по счётчику строки статуса и действие палитры
 * `attention.next` (6.3). Обход — по тем же работам, что считает строка статуса
 * (`attention/store.ts`): иначе «2 need you» показывало бы сессию, до которой клик не дойдёт.
 */

import type { SessionRef } from '@harnas/protocol';
import { refKey } from '@harnas/protocol';
import { tabId } from '../layout/ids.js';
import { selectedSessionOf, useLayoutStore } from '../layout/store.js';
import { openTab } from '../layout/tree.js';
import { treeOrder, workKey } from '../lib/tree-order.js';
import type { SidebarSection } from '../sidebar/sort.js';
import { useSidebarSectionsStore } from '../sidebar/use-sidebar-sections.js';
import { useActivityStore, type ActivityEntry } from '../store/activity.js';
import { useWorksStore } from '../store/works.js';
import { attentionOf, sessionAttention, type Attention, type WorkAttention } from './derive.js';

/** Первая после `from` по кругу; `from === -1` — первая вообще. */
function nextAfter(candidates: Array<{ index: number; ref: SessionRef }>, from: number): SessionRef | null {
  if (candidates.length === 0) return null;
  return (candidates.find((candidate) => candidate.index > from) ?? candidates[0])?.ref ?? null;
}

/**
 * Следующая после current по кругу сессия уровня needs-you, затем unseen, в порядке сайдбара — sections
 * из useSidebarSections() (3.3). Работы свёрнутых проектов входят, как в счётчиках (attention/store.ts);
 * архивные пропускаются по status и при их временном показе (6.3).
 */
export function nextAttentionTarget(
  sections: SidebarSection[],
  byWork: Record<string, WorkAttention>,
  activity: Record<string, ActivityEntry>,
  current: SessionRef | null,
): SessionRef | null {
  const currentKey = current === null ? null : refKey(current);
  const found: Record<'needs-you' | 'unseen', Array<{ index: number; ref: SessionRef }>> = { 'needs-you': [], unseen: [] };
  let index = 0;
  let currentIndex = -1;
  for (const section of sections) {
    for (const entry of section.works) {
      if (entry.map.work.status === 'archived') continue;
      // Работа, где по расчёту сайдбара звать некого, не обходится: счётчики и обход —
      // один расчёт.
      const work = attentionOf(byWork, entry);
      const worth = work.needsYou > 0 || work.unseen > 0;
      // Порядок строк карточки — дерево сессий (`WorkCard`).
      for (const { session } of treeOrder(entry.map.sessions)) {
        const ref: SessionRef = { projectPath: entry.projectPath, workId: entry.map.work.id, sessionId: session.id };
        const key = refKey(ref);
        if (key === currentKey) currentIndex = index;
        if (worth) {
          const level: Attention = sessionAttention(session, activity[key]?.activity ?? null);
          if (level === 'needs-you' || level === 'unseen') found[level].push({ index, ref });
        }
        index += 1;
      }
    }
  }
  return nextAfter(found['needs-you'], currentIndex) ?? nextAfter(found.unseen, currentIndex);
}

/**
 * «Следующая, где нужен ты» (спека 7.6): current — selectedSessionOf(…)?.ref, затем setActiveWork и
 * apply(openTab(terminal)); null — идти некуда. Зовут строка статуса и действие attention.next (6.3,
 * ActionContext.attention.next). Сторы читаются в момент вызова: вызывающие на них не подписаны.
 */
export function openNextAttention(): SessionRef | null {
  const { sections, attention } = useSidebarSectionsStore.getState();
  const layout = useLayoutStore.getState();
  const current = selectedSessionOf(layout, useWorksStore.getState().entries)?.ref ?? null;
  const target = nextAttentionTarget(sections, attention, useActivityStore.getState().byRef, current);
  if (target === null) return null;
  const key = workKey(target.projectPath, target.workId);
  layout.setActiveWork(key);
  // Не гидрированная работа — операция ждёт в очереди `apply` до `hydrate`.
  useLayoutStore
    .getState()
    .apply(key, (l) => openTab(l, { kind: 'terminal', id: tabId.terminal(target.sessionId), sessionId: target.sessionId }));
  return target;
}
