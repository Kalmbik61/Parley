/**
 * Одна вкладка строки (кусок 2.4, спека 5.3, 14.2): значок вида, заголовок,
 * крестик закрытия, меню по правой кнопке. `TabStrip.tsx` уже посчитал
 * `TabMeta` и (для терминала) точку состояния — сам компонент только рисует
 * их и переводит клики/меню в вызовы `layout/store.ts` и стора палитры.
 *
 * Облик Organic (спека окна 2026-09-29, 1.1): вкладка — пилюля 28px с зазором 7 и текстом 12px, отступ
 * слева 11, справа 11 (у активной 5 — под крестик). Активная — фон `neutral-100`, `shadow-sm`, вес
 * 600 и крестик 18×18 со значком 10; у неактивных крестика нет — закрытие средней кнопкой
 * (`onAuxClick`) и ⌘W. Подкраска (`meta.tint`) бьёт и фон активной: `blocked` и комната с ждущим
 * решением, почта с непрочитанным — `accent-200`, `unseen` — `accent-2-200`. У вкладки терминала —
 * только значок состояния 12px, значка провайдера, как на снимках handoff, нет. Ширину — до 200,
 * не уже 72 — держит обёртка в `TabStrip.tsx` (`SortableTab`), пилюля занимает её целиком.
 *
 * «Разделить вправо/вниз» сначала фокусирует ГРУППУ ЭТОЙ вкладки (`focusGroup`),
 * а не активную группу работы — иначе палитра в режиме разделения (кусок 6.2)
 * по выбору резала бы чужую, реально активную группу (спека 5.3, тест 14).
 *
 * Раунд исправлений 1 (ревью A, Important №2): паттерн ARIA tab — `aria-selected`
 * (состояние для скринридера, `data-active` его не заменяет) и roving tabindex
 * (`tabIndex` 0 только у активной вкладки, -1 у остальных — Tab переходит в
 * строку один раз, а не по каждой вкладке подряд); стрелки ←/→ между вкладками
 * строки — в `TabStrip.tsx` (там виден весь список), тут — только Enter/Space,
 * которые активируют САМУ эту вкладку, как и клик.
 */

import { toast } from 'sonner';
import { FileCode, FileImage, FileSpreadsheet, FileText, FileType, GitCompare, Globe, Hash, Mail as MailIcon, X } from 'lucide-react';
import type { SessionLifecycle } from '@harnas/core';
import type { GroupNode, TabSpec } from '../../shared/layout-types.js';
import { S } from '../../shared/strings.js';
import { useBrowserStore } from '../browser/store.js';
import { AgentStateDot } from '../components/AgentStateDot.js';
import type { DotState } from '../lib/dot-state.js';
import { cn } from '../lib/cn.js';
import { fileKind, type FileKind } from '../files/file-kind.js';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '../ui/context-menu.js';
import { usePaletteStore } from '../palette/store.js';
import { useLayoutStore } from './store.js';
import { focusGroup, focusTab } from './tree.js';
import { fileTabHint, type TabMeta, type TabTint } from './tab-meta.js';

export interface TabProps {
  workKey: string;
  group: GroupNode;
  tab: TabSpec;
  meta: TabMeta;
  /** Точка состояния терминала — уже посчитана `TabStrip.tsx` (нужен `SessionRef` из `entry`, которого у `Tab` самого нет). */
  dot: { state: DotState; lifecycle: SessionLifecycle } | null;
  isActive: boolean;
}

/** Значок вкладки файла по виду (спека 5.3): вид — по расширению, `files/file-kind.ts`. */
const FILE_ICONS: Record<FileKind, typeof FileCode> = {
  text: FileCode,
  markdown: FileText,
  csv: FileSpreadsheet,
  tsv: FileSpreadsheet,
  image: FileImage,
  pdf: FileType,
};

/** Цвет значков вкладок не терминального вида — `neutral-800`, как кнопки заголовка (1.1). */
const ICON = 'size-3 shrink-0 text-neutral-800';

/** Подкраска бьёт фон вкладки и её hover: тот же цвет, что видел человек до наведения. */
const TINT: Record<TabTint, string> = {
  accent: 'bg-accent-200 hover:bg-accent-200',
  'accent-2': 'bg-accent-2-200 hover:bg-accent-2-200',
};

function TabIcon({ tab, meta, dot }: Pick<TabProps, 'tab' | 'meta' | 'dot'>): JSX.Element | null {
  switch (meta.icon) {
    case 'terminal':
      // «Нужен ты» важнее точки: при `result` точка показала бы done/failed (спека 7.3).
      if (meta.needsYou) return <AgentStateDot state="blocked" />;
      return dot === null ? null : <AgentStateDot state={dot.state} lifecycle={dot.lifecycle} />;
    case 'mail':
      return <MailIcon className={ICON} aria-hidden="true" />;
    case 'room':
      return <Hash className={ICON} aria-hidden="true" />;
    case 'diff':
      return <GitCompare className={ICON} aria-hidden="true" />;
    case 'file': {
      const kind = tab.kind === 'file' ? fileKind(tab.path) : 'text';
      const Icon = FILE_ICONS[kind];
      return <Icon data-file-kind={kind} className={ICON} aria-hidden="true" />;
    }
    case 'browser':
      // Favicon — data: из main (9.2a): CSP окна внешних картинок не пускает.
      return meta.favicon === null ? (
        <Globe className={ICON} aria-hidden="true" />
      ) : (
        <img src={meta.favicon} alt="" className="size-3 shrink-0 object-contain" draggable={false} />
      );
  }
}

/**
 * Полный текст подсказки: путь файла с меткой корня (раунд fix-live, D5); у браузера — заголовок
 * страницы и адрес целиком (9.2a).
 */
function fullTitle(tab: TabSpec, pageTitle: string | null): string | null {
  if (tab.kind === 'file') return fileTabHint(tab);
  if (tab.kind !== 'browser') return null;
  const text = [pageTitle ?? '', tab.url].filter((part) => part !== '').join('\n');
  return text === '' ? null : text;
}

export function Tab({ workKey, group, tab, meta, dot, isActive }: TabProps): JSX.Element {
  const pageTitle = useBrowserStore((state) => (tab.kind === 'browser' ? (state.tabs[tab.id]?.title ?? null) : null));
  const hint = fullTitle(tab, pageTitle);
  const closeIds = (ids: readonly string[]): void => {
    if (ids.length === 0) return;
    void useLayoutStore
      .getState()
      .requestCloseTabs(workKey, [...ids])
      .then((closed) => {
        if (closed) toast(S.tabs.closedToast);
      });
  };

  const closeThis = (): void => closeIds([tab.id]);
  const closeOthers = (): void => closeIds(group.tabs.filter((candidate) => candidate.id !== tab.id).map((candidate) => candidate.id));
  const closeToRight = (): void => {
    const index = group.tabs.findIndex((candidate) => candidate.id === tab.id);
    closeIds(group.tabs.slice(index + 1).map((candidate) => candidate.id));
  };

  const beginSplit = (mode: 'splitRight' | 'splitDown'): void => {
    useLayoutStore.getState().apply(workKey, (layout) => focusGroup(layout, group.id));
    usePaletteStore.getState().openWith(mode);
  };

  const activateThis = (): void => {
    useLayoutStore.getState().apply(workKey, (layout) => focusTab(layout, tab.id));
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          role="tab"
          data-work-key={workKey}
          data-tab-id={tab.id}
          data-active={isActive}
          data-unread={meta.unread}
          aria-selected={isActive}
          tabIndex={isActive ? 0 : -1}
          onClick={activateThis}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            activateThis();
          }}
          onAuxClick={(event) => {
            if (event.button === 1) closeThis();
          }}
          className={cn(
            'flex h-7 w-full min-w-0 cursor-default select-none items-center gap-[7px] rounded-full pl-[11px] text-xs text-foreground',
            isActive ? 'bg-neutral-100 pr-[5px] font-semibold shadow-sm' : 'pr-[11px] hover:bg-foreground/7',
            meta.tint !== null && TINT[meta.tint],
          )}
        >
          <TabIcon tab={tab} meta={meta} dot={dot} />
          {/* Полный путь файла, заголовок страницы и адрес — в title: строка вкладок их обрезает (спека 5.3). */}
          <span className="min-w-0 flex-1 truncate" {...(hint === null ? {} : { title: hint })}>
            {meta.title}
          </span>
          {meta.dirty ? (
            <span
              data-dirty-dot
              role="img"
              aria-label={S.tabs.unsaved}
              className="size-2 shrink-0 rounded-full bg-foreground/70"
            />
          ) : null}
          {isActive ? (
            <button
              type="button"
              aria-label={S.common.close}
              onClick={(event) => {
                event.stopPropagation();
                closeThis();
              }}
              className="flex size-[18px] shrink-0 items-center justify-center rounded-full text-neutral-800 transition-colors hover:bg-foreground/12"
            >
              <X className="size-2.5" aria-hidden="true" />
            </button>
          ) : null}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={closeThis}>{S.common.close}</ContextMenuItem>
        <ContextMenuItem onSelect={closeOthers}>{S.tabs.closeOthers}</ContextMenuItem>
        <ContextMenuItem onSelect={closeToRight}>{S.tabs.closeToRight}</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => beginSplit('splitRight')}>{S.actions.splitRight}</ContextMenuItem>
        <ContextMenuItem onSelect={() => beginSplit('splitDown')}>{S.actions.splitDown}</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
