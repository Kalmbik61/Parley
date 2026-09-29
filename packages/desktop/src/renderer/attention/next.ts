/**
 * «Следующая, где нужен ты» (спека 7.6): клик по счётчику строки статуса и действие палитры
 * `attention.next` (6.3). Обход — по тем же работам, что считает строка статуса
 * (`attention/store.ts`): иначе «2 need you» показывало бы сессию, до которой клик не дойдёт.
 *
 * Кусок 5 плана «Organic» (спека окна 2026-09-29, 2.7): три яруса — сначала сессии `blocked`, потом комнаты с
 * ждущим решением, потом `unseen`; внутри яруса — порядок сайдбара. Ярусы склеены в один список, как в
 * `nextAttention()` прототипа handoff, а «следующая» — элемент после текущей вкладки (терминал сессии или вкладка
 * комнаты) по кругу: blocked → комната с решением → unseen → снова blocked. Ярус не выбирается по наличию целей:
 * иначе пока есть хоть одна `blocked`-сессия, до комнаты с решением клик по счётчику «2 need you» не доходил бы.
 * Порядок сайдбара — как в карточке: комната стоит на месте первого участника, за ней её участники
 * (`sidebar/sort.ts#cardRows`). Текущей вкладки в списке нет (не цель, не сессия и не комната) — первая после неё по
 * порядку сайдбара цель первого непустого яруса: при наличии blocked круг начинается с неё.
 */

import type { WorkEntry, WorkSession } from '@harnas/core';
import type { SessionRef } from '@harnas/protocol';
import { refKey } from '@harnas/protocol';
import type { FocusTarget } from '../../shared/bridge.js';
import type { TabSpec } from '../../shared/layout-types.js';
import { tabId } from '../layout/ids.js';
import { selectedSessionOf, useLayoutStore } from '../layout/store.js';
import { groups, openTab } from '../layout/tree.js';
import { workKey } from '../lib/tree-order.js';
import { cardRows, type SidebarSection } from '../sidebar/sort.js';
import { useSidebarSectionsStore } from '../sidebar/use-sidebar-sections.js';
import { useActivityStore, type ActivityEntry } from '../store/activity.js';
import { useWorksStore } from '../store/works.js';
import { attentionOf, roomAwaitsDecision, sessionAttention, type WorkAttention } from './derive.js';

/** Куда ведёт «следующая»: терминал сессии или вкладка комнаты. Форма — как у цели уведомления (`FocusTarget`). */
export type AttentionTarget = Extract<FocusTarget, { kind: 'session' | 'room' }>;

/** Одна и та же цель — строкой, для сравнения текущей вкладки с обходом. */
function targetKey(target: AttentionTarget): string {
  return target.kind === 'session'
    ? `session ${refKey(target.ref)}`
    : `room ${workKey(target.projectPath, target.workId)}/${target.roomId}`;
}

/** Первая после `from` по кругу; `from === -1` — первая вообще. */
function nextAfter(candidates: Array<{ index: number; target: AttentionTarget }>, from: number): AttentionTarget | null {
  if (candidates.length === 0) return null;
  return (candidates.find((candidate) => candidate.index > from) ?? candidates[0])?.target ?? null;
}

/**
 * Следующая после current по кругу цель единого списка — сессии needs-you, комнаты с решением, сессии unseen, внутри
 * яруса в порядке сайдбара: sections из useSidebarSections() (3.3). Работы свёрнутых проектов входят, как в счётчиках
 * (attention/store.ts); архивные пропускаются по status и при их временном показе (6.3). current — вкладка, на которой
 * стоит человек (`null` — не сессия и не комната). Если она сама цель — берётся элемент списка после неё (единственная
 * цель — она же). Если нет — ближайшая после неё по порядку сайдбара цель первого непустого яруса, по кругу внутри него.
 */
export function nextAttentionTarget(
  sections: SidebarSection[],
  byWork: Record<string, WorkAttention>,
  activity: Record<string, ActivityEntry>,
  current: AttentionTarget | null,
): AttentionTarget | null {
  const currentKey = current === null ? null : targetKey(current);
  // Ярусы: 0 — сессии needs-you, 1 — комнаты с ждущим решением, 2 — сессии unseen.
  const found: Array<Array<{ index: number; target: AttentionTarget }>> = [[], [], []];
  let index = 0;
  let currentIndex = -1;
  for (const section of sections) {
    for (const entry of section.works) {
      if (entry.map.work.status === 'archived') continue;
      // Работа, где по расчёту сайдбара звать некого, не обходится: счётчики и обход — один расчёт.
      const work = attentionOf(byWork, entry);
      const worth = work.needsYou > 0 || work.unseen > 0;
      const visit = (target: AttentionTarget, tier: 0 | 1 | 2 | null): void => {
        if (targetKey(target) === currentKey) currentIndex = index;
        if (worth && tier !== null) found[tier]?.push({ index, target });
        index += 1;
      };
      const visitSession = (session: WorkSession): void => {
        const ref: SessionRef = { projectPath: entry.projectPath, workId: entry.map.work.id, sessionId: session.id };
        const level = sessionAttention(session, activity[refKey(ref)]?.activity ?? null);
        visit({ kind: 'session', ref }, level === 'needs-you' ? 0 : level === 'unseen' ? 2 : null);
      };
      // Порядок строк карточки (`WorkCard`), закрытые тоже: текущей может быть вкладка закрытой сессии.
      for (const row of cardRows(entry.map, true)) {
        if (row.kind === 'session') {
          visitSession(row.session);
          continue;
        }
        visit(
          { kind: 'room', projectPath: entry.projectPath, workId: entry.map.work.id, roomId: row.room.id },
          roomAwaitsDecision(row.room) ? 1 : null,
        );
        for (const member of row.members) visitSession(member);
      }
    }
  }
  // Единый список: blocked, комнаты с решением, unseen — внутри яруса порядок сайдбара (обход шёл по нему).
  const glued = found.flat();
  const at = currentKey === null ? -1 : glued.findIndex((candidate) => targetKey(candidate.target) === currentKey);
  if (at !== -1) return glued[(at + 1) % glued.length]?.target ?? null;
  return nextAfter(found[0] ?? [], currentIndex) ?? nextAfter(found[1] ?? [], currentIndex) ?? nextAfter(found[2] ?? [], currentIndex);
}

/** Вкладка, на которой стоит человек: терминал сессии или комната активной группы активной работы; иначе null. */
function currentTarget(): AttentionTarget | null {
  const layout = useLayoutStore.getState();
  const entries = useWorksStore.getState().entries;
  const selected = selectedSessionOf(layout, entries);
  if (selected !== null) return { kind: 'session', ref: selected.ref };
  const key = layout.activeWorkKey;
  const workLayout = key === null ? undefined : layout.layouts[key];
  if (key === null || workLayout === undefined) return null;
  const group = groups(workLayout).find((candidate) => candidate.id === workLayout.activeGroupId);
  const tab = group?.tabs.find((candidate) => candidate.id === group.activeTabId);
  const entry = entries.find((candidate: WorkEntry) => workKey(candidate.projectPath, candidate.map.work.id) === key);
  if (tab?.kind !== 'room' || entry === undefined) return null;
  return { kind: 'room', projectPath: entry.projectPath, workId: entry.map.work.id, roomId: tab.roomId };
}

/**
 * «Следующая, где нужен ты» (спека 7.6): current — вкладка активной группы (`currentTarget`), затем setActiveWork и
 * apply(openTab(terminal сессии или вкладка комнаты)); null — идти некуда. Зовут строка статуса и действие
 * attention.next (6.3, ActionContext.attention.next). Сторы читаются в момент вызова: вызывающие на них не подписаны.
 */
export function openNextAttention(): AttentionTarget | null {
  const { sections, attention } = useSidebarSectionsStore.getState();
  const layout = useLayoutStore.getState();
  const target = nextAttentionTarget(sections, attention, useActivityStore.getState().byRef, currentTarget());
  if (target === null) return null;
  const projectPath = target.kind === 'session' ? target.ref.projectPath : target.projectPath;
  const workId = target.kind === 'session' ? target.ref.workId : target.workId;
  const key = workKey(projectPath, workId);
  const tab: TabSpec =
    target.kind === 'session'
      ? { kind: 'terminal', id: tabId.terminal(target.ref.sessionId), sessionId: target.ref.sessionId }
      : { kind: 'room', id: tabId.room(target.roomId), roomId: target.roomId };
  layout.setActiveWork(key);
  // Не гидрированная работа — операция ждёт в очереди `apply` до `hydrate`.
  useLayoutStore.getState().apply(key, (l) => openTab(l, tab));
  return target;
}
