/**
 * Заголовок секции сайдбара (кусок 3.3, спека 6.1): группа проекта — 28px, цветной чип,
 * имя папки, число работ и «+»; «Закреплённые» — подпись без чипа и «+». Клик по
 * заголовку проекта сворачивает и разворачивает группу (`ui.json.collapsedProjects`).
 *
 * Кусок 3.4: у каждого заголовка — меню «⋯» (`SectionMenu`, спека 6.1) с «Show done».
 *
 * Карточки передаются детьми: при виртуализации (`WorkSidebar`) заголовок и карточки —
 * отдельные строки виртуального списка, и тогда детей нет.
 */

import type { ReactNode } from 'react';
import { Plus } from 'lucide-react';
import { S } from '../../shared/strings.js';
import { cn } from '../lib/cn.js';
import { projectColor } from '../lib/project-color.js';
import { SectionMenu } from './SectionMenu.js';
import type { SidebarSection } from './sort.js';

export interface ProjectGroupProps {
  section: SidebarSection;
  onToggleCollapsed(): void;
  /** «+» заголовка — форма новой работы в этом проекте (до 3.5 — прежний диалог без проекта). */
  onNewWork(): void;
  children?: ReactNode;
}

export function ProjectGroup({ section, onToggleCollapsed, onNewWork, children }: ProjectGroupProps): JSX.Element {
  return (
    <div data-section={section.key}>
      {section.kind === 'pinned' ? (
        <div
          data-section-key={section.key}
          className="flex h-7 items-center gap-2 px-2 text-[11px] font-semibold uppercase tracking-[.05em] text-work-sidebar-muted-foreground"
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
          className="group flex h-7 cursor-default items-center gap-2 rounded-md px-2 text-[13px] font-semibold text-work-sidebar-foreground hover:bg-work-sidebar-accent/60"
        >
          <span
            aria-hidden="true"
            className="size-4 shrink-0 rounded"
            style={{ backgroundColor: projectColor(section.projectPath ?? section.key) }}
          />
          <span className="min-w-0 flex-1 truncate">{section.title}</span>
          <span className="shrink-0 text-[11px] font-normal tabular-nums text-work-sidebar-muted-foreground">{section.works.length}</span>
          <SectionMenu sectionKey={section.key} />
          <button
            type="button"
            aria-label={S.sidebar.newWorkspaceInProject}
            title={S.sidebar.newWorkspaceInProject}
            onClick={(event) => {
              // «+» — не клик по заголовку: группа не должна свернуться.
              event.stopPropagation();
              onNewWork();
            }}
            className={cn(
              'inline-flex size-5 shrink-0 items-center justify-center rounded text-work-sidebar-muted-foreground',
              'hover:bg-work-sidebar-accent hover:text-work-sidebar-foreground',
            )}
          >
            <Plus className="size-3.5" aria-hidden="true" />
          </button>
        </div>
      )}
      {children}
    </div>
  );
}
