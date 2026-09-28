/**
 * Итоги внимания для строки статуса и бейджа Dock (спека 7.3) — поверх расчёта сайдбара
 * (`sidebar/use-sidebar-sections.ts`, 3.3): второго расчёта внимания нет, иначе счётчик
 * разошёлся бы с карточками.
 */

import { useShallow } from 'zustand/react/shallow';
import type { SidebarSection } from '../sidebar/sort.js';
import { useSidebarSectionsStore } from '../sidebar/use-sidebar-sections.js';
import { attentionOf, type WorkAttention } from './derive.js';

export interface AttentionTotals {
  needsYou: number;
  unseen: number;
  humanUnread: number;
}

/**
 * Суммы по работам секций сайдбара: свёрнутые проекты входят, скрытых done в секциях нет. Архивные
 * пропускаются по status: с 6.3 временный показ кладёт их в секции. Домен задают секции, а не ключи
 * byWork: useSidebarAttention() (3.3) посчитан по всем работам снимка.
 */
export function attentionTotals(sections: SidebarSection[], byWork: Record<string, WorkAttention>): AttentionTotals {
  const totals: AttentionTotals = { needsYou: 0, unseen: 0, humanUnread: 0 };
  for (const section of sections) {
    for (const entry of section.works) {
      if (entry.map.work.status === 'archived') continue;
      const attention = attentionOf(byWork, entry);
      totals.needsYou += attention.needsYou;
      totals.unseen += attention.unseen;
      totals.humanUnread += attention.humanUnread;
    }
  }
  return totals;
}

/**
 * attentionTotals по стору секций. Селектор с поверхностным сравнением (решение контролёра
 * куска 4.2): подписчик — `AppShell`, и перерисовываться он должен, только когда сменились
 * сами числа, а не на каждое `activity.changed` с новыми метриками.
 */
export function useAttentionTotals(): AttentionTotals {
  return useSidebarSectionsStore(useShallow((state) => attentionTotals(state.sections, state.attention)));
}

/** Бейдж Dock: сессии «ждут тебя» и письма человеку; unseen в него не входит (спека 7.3). */
export function badgeCount(totals: AttentionTotals): number {
  return totals.needsYou + totals.humanUnread;
}
