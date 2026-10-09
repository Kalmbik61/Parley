/**
 * Заголовок секции сайдбара (кусок 3.3, спека 6.1): группа проекта — пилюля 30px, круг цвета проекта,
 * имя папки, число работ, шеврон и «+»; «Закреплённые» — подпись без круга и «+». Клик по
 * заголовку проекта сворачивает и разворачивает группу (`ui.json.collapsedProjects`).
 *
 * Облик Organic (спека окна 2026-09-29, 1.2): круг 16px цвета проекта (`lib/project-color.ts`), имя —
 * Caprasimo 15px/1, число работ 11px `neutral-700`, шеврон 13 (свёрнут — −90°, `transition .15s`), справа
 * «+» 24px с тултипом `New workspace in {project}`. Hover — `text 6%`, а вторичный текст на нём —
 * основной цвет (наследство куска 1: `neutral-700` на заливке hover 4.4:1, ниже порога; переменную
 * вторичного цвета на hover подменяет один класс). Имя длиннее строки сжимается многоточием — круг,
 * число, шеврон и «+» остаются на месте.
 *
 * Кусок 3.4: у каждого заголовка — меню «⋯» (`SectionMenu`, спека 6.1) с «Show done»; в handoff его нет,
 * поэтому оно проявляется под курсором и на фокусе, а не занимает место на виду.
 *
 * Карточки передаются детьми: при виртуализации (`WorkSidebar`) заголовок и карточки —
 * отдельные строки виртуального списка, и тогда детей нет.
 *
 * Внизу группы — ссылка «N archived» (`ProjectArchivedLink`, спека архива комнат и проектов, 6.1): архивные работы
 * проекта спрятаны под ней, клик раскрывает их в конце группы, подпись становится «Hide archived». Нативная кнопка, как
 * «N more closed» карточки: достижима по Tab, Enter и пробел нажимают её сами. При виртуализации это отдельная строка
 * списка, а заголовок рисуется с `headerOnly`.
 */

import type { ReactNode } from 'react';
import { ChevronDown, Plus } from 'lucide-react';
import { S } from '../../shared/strings.js';
import { cn } from '../lib/cn.js';
import { projectColor } from '../lib/project-color.js';
import { useUiStore } from '../store/ui.js';
import { SectionMenu } from './SectionMenu.js';
import type { SidebarSection } from './sort.js';

export interface ProjectGroupProps {
  section: SidebarSection;
  onToggleCollapsed(): void;
  /** «+» заголовка — форма новой работы с проектом этой группы (кусок 3.5). */
  onNewWork(projectPath: string): void;
  /** Только заголовок виртуального списка: ссылку «N archived» тогда рисует своя строка списка, а не группа. */
  headerOnly?: boolean;
  children?: ReactNode;
}

/** Ссылка «N archived» / «Hide archived» внизу группы проекта; секции без архивных работ (нет `archived`) она не рисуется. */
export function ProjectArchivedLink({ section }: { section: SidebarSection }): JSX.Element | null {
  const { archived, projectPath } = section;
  if (archived === undefined || projectPath === null || section.collapsed) return null;
  return (
    <button
      type="button"
      data-archived-works=""
      aria-expanded={archived.shown}
      onClick={() => useUiStore.getState().setProjectArchivedShown(projectPath, !archived.shown)}
      className={cn(
        // Как «N more closed» карточки: основной цвет на hover — явно, в приглушённом поддереве он равен вторичному.
        'mt-1.5 flex h-6 w-full min-w-0 items-center rounded-full pl-2.5 pr-2 text-left text-[11px]',
        'text-work-sidebar-muted-foreground hover:bg-foreground/6 hover:text-(--color-text)',
      )}
    >
      <span className="min-w-0 truncate">{archived.shown ? S.sidebar.hideArchivedWorks : S.sidebar.archivedWorks(archived.count)}</span>
    </button>
  );
}

export function ProjectGroup({ section, onToggleCollapsed, onNewWork, headerOnly = false, children }: ProjectGroupProps): JSX.Element {
  return (
    <div data-section={section.key}>
      {section.kind === 'pinned' ? (
        <div
          data-section-key={section.key}
          className="group flex h-7 items-center gap-2 pl-3 pr-[3px] text-[11px] font-semibold uppercase tracking-[.06em] text-work-sidebar-muted-foreground"
        >
          <span className="min-w-0 flex-1 truncate">{section.title}</span>
          <SectionMenu sectionKey={section.key} />
        </div>
      ) : (
        <div
          role="button"
          tabIndex={0}
          aria-expanded={!section.collapsed}
          data-section-key={section.key}
          title={section.projectPath ?? undefined}
          onClick={(event) => {
            // Пункты меню «⋯» — в портале, но их клик всплывает сюда по дереву React (кусок 3.4).
            if (event.currentTarget.contains(event.target as Node)) onToggleCollapsed();
          }}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            if (!event.currentTarget.contains(event.target as Node)) return;
            event.preventDefault();
            onToggleCollapsed();
          }}
          className="group flex h-[30px] cursor-default select-none items-center gap-2 rounded-full pl-2 pr-[3px] text-work-sidebar-foreground hover:bg-foreground/6 hover:[--work-sidebar-muted-foreground:var(--work-sidebar-foreground)]"
        >
          <span
            aria-hidden="true"
            data-project-chip
            className="size-4 shrink-0 rounded-full"
            style={{ backgroundColor: projectColor(section.projectPath ?? section.key) }}
          />
          <span className="min-w-0 truncate font-heading text-[15px] leading-none">{section.title}</span>
          <span className="shrink-0 text-[11px] text-work-sidebar-muted-foreground">{section.works.length}</span>
          <ChevronDown
            aria-hidden="true"
            data-chevron
            className={cn(
              'size-[13px] shrink-0 text-work-sidebar-muted-foreground transition-transform duration-150',
              section.collapsed && '-rotate-90',
            )}
          />
          <span className="min-w-0 flex-1" />
          <SectionMenu sectionKey={section.key} />
          <button
            type="button"
            aria-label={S.sidebar.newWorkspaceInProject(section.title)}
            title={S.sidebar.newWorkspaceInProject(section.title)}
            onClick={(event) => {
              // «+» — не клик по заголовку: группа не должна свернуться.
              event.stopPropagation();
              if (section.projectPath !== null) onNewWork(section.projectPath);
            }}
            className="inline-flex size-6 shrink-0 items-center justify-center rounded-full text-neutral-800 transition-colors hover:bg-foreground/10"
          >
            <Plus className="size-[13px]" aria-hidden="true" />
          </button>
        </div>
      )}
      {children}
      {headerOnly ? null : <ProjectArchivedLink section={section} />}
    </div>
  );
}
