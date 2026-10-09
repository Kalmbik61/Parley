/**
 * Заголовок группы проекта (кусок 3.3, спека 6.1; облик Organic — спека окна 2026-09-29, 1.2): круг цвета
 * проекта 16px, имя Caprasimo 15px, число работ 11px, шеврон 13 (свёрнут — −90°), «+» 24px справа.
 * Клик по заголовку сворачивает группу, «+» её не сворачивает.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { S } from '../../shared/strings.js';
import { projectColor } from '../lib/project-color.js';
import { useUiStore } from '../store/ui.js';
import { makeWork } from '../test-utils/work-fixtures.js';
import { ProjectArchivedLink, ProjectGroup } from './ProjectGroup.js';
import type { SidebarSection } from './sort.js';

afterEach(cleanup);

const project: SidebarSection = {
  kind: 'project',
  key: '/Users/me/VoiceStudio',
  title: 'VoiceStudio',
  projectPath: '/Users/me/VoiceStudio',
  works: [makeWork('w-1'), makeWork('w-2'), makeWork('w-3')],
  collapsed: false,
};

const header = (): HTMLElement => document.querySelector<HTMLElement>('[data-section-key]') as HTMLElement;

describe('ProjectGroup', () => {
  it('круг — цвет проекта, число работ, полный путь в title', () => {
    render(<ProjectGroup section={project} onToggleCollapsed={() => {}} onNewWork={() => {}} />);
    const chip = header().querySelector<HTMLElement>('[data-project-chip]');
    const probe = document.createElement('span');
    probe.style.backgroundColor = projectColor('/Users/me/VoiceStudio');
    expect(chip?.style.backgroundColor).toBe(probe.style.backgroundColor);
    expect(chip?.className).toMatch(/\bsize-4\b/);
    expect(chip?.className).toMatch(/\brounded-full\b/);
    expect(header().textContent).toContain('3');
    expect(header().getAttribute('title')).toBe('/Users/me/VoiceStudio');
    expect(header().getAttribute('aria-expanded')).toBe('true');
  });

  it('заголовок — пилюля 30px: имя Caprasimo 15px, число работ 11px, hover text 6%', () => {
    render(<ProjectGroup section={project} onToggleCollapsed={() => {}} onNewWork={() => {}} />);
    expect(header().className).toMatch(/\bh-\[30px\]/);
    expect(header().className).toMatch(/\brounded-full\b/);
    expect(header().className).toMatch(/\bgap-2\b/);
    expect(header().className).toContain('hover:bg-foreground/6');
    // Наследство куска 1: вторичный текст на hover-заливке — основной цвет, а не `neutral-700` (4.4:1).
    expect(header().className).toContain('hover:[--work-sidebar-muted-foreground:var(--work-sidebar-foreground)]');
    const name = screen.getByText('VoiceStudio');
    expect(name.className).toContain('font-heading');
    expect(name.className).toContain('text-[15px]');
    expect(name.className).toContain('leading-none');
    expect(name.className).toContain('truncate');
    const count = screen.getByText('3');
    expect(count.className).toContain('text-[11px]');
  });

  it('шеврон 13px: развёрнутая — прямой, свёрнутая — −90°', () => {
    const { rerender } = render(<ProjectGroup section={project} onToggleCollapsed={() => {}} onNewWork={() => {}} />);
    const chevron = (): Element | null => header().querySelector('[data-chevron]');
    expect(chevron()?.classList.contains('size-[13px]')).toBe(true);
    expect(chevron()?.classList.contains('-rotate-90')).toBe(false);
    rerender(<ProjectGroup section={{ ...project, collapsed: true }} onToggleCollapsed={() => {}} onNewWork={() => {}} />);
    expect(chevron()?.classList.contains('-rotate-90')).toBe(true);
    expect(chevron()?.classList.contains('transition-transform')).toBe(true);
  });

  it('клик по заголовку — onToggleCollapsed; «+» — onNewWork(projectPath) без сворачивания, тултип называет проект', () => {
    const onToggleCollapsed = vi.fn();
    const onNewWork = vi.fn();
    render(<ProjectGroup section={project} onToggleCollapsed={onToggleCollapsed} onNewWork={onNewWork} />);
    const plus = screen.getByRole('button', { name: S.sidebar.newWorkspaceInProject('VoiceStudio') });
    expect(plus.getAttribute('title')).toBe('New workspace in VoiceStudio');
    expect(plus.className).toMatch(/\bsize-6\b/);
    expect(plus.className).toMatch(/\brounded-full\b/);
    fireEvent.click(plus);
    // Кусок 3.5: «+» передаёт свой проект — форма откроется с ним.
    expect(onNewWork).toHaveBeenCalledTimes(1);
    expect(onNewWork).toHaveBeenCalledWith('/Users/me/VoiceStudio');
    expect(onToggleCollapsed).not.toHaveBeenCalled();
    fireEvent.click(header());
    expect(onToggleCollapsed).toHaveBeenCalledTimes(1);
  });

  it('длинное имя проекта не выталкивает «+» за край: имя сжимается многоточием, «+» и число не сжимаются', () => {
    const long = 'p'.repeat(120);
    render(<ProjectGroup section={{ ...project, title: long }} onToggleCollapsed={() => {}} onNewWork={() => {}} />);
    expect(screen.getByText(long).className).toContain('min-w-0');
    expect(screen.getByText(long).className).toContain('truncate');
    expect(screen.getByRole('button', { name: S.sidebar.newWorkspaceInProject(long) }).className).toContain('shrink-0');
    expect(screen.getByText('3').className).toContain('shrink-0');
  });

  it('меню «⋯» — не по умолчанию на виду: проявляется при наведении на заголовок, фокусе и открытом меню', () => {
    render(<ProjectGroup section={project} onToggleCollapsed={() => {}} onNewWork={() => {}} />);
    const menu = screen.getByRole('button', { name: S.sidebar.sectionMenu });
    expect(menu.className).toContain('opacity-0');
    expect(menu.className).toContain('group-hover:opacity-100');
    expect(menu.className).toContain('focus-visible:opacity-100');
    expect(menu.className).toContain('data-[state=open]:opacity-100');
  });

  it('«Закреплённые» — подпись без круга, «+» и сворачивания', () => {
    render(
      <ProjectGroup
        section={{ ...project, kind: 'pinned', key: 'pinned', title: S.sidebar.pinned, projectPath: null }}
        onToggleCollapsed={() => {}}
        onNewWork={() => {}}
      />,
    );
    expect(screen.getByText('Pinned')).toBeTruthy();
    expect(header().querySelector('[data-project-chip]')).toBeNull();
    // С куска 3.4 у каждого заголовка секции — только меню «⋯» (спека 6.1).
    expect(screen.getAllByRole('button').map((button) => button.getAttribute('aria-label'))).toEqual([S.sidebar.sectionMenu]);
  });
});

// Спека архива комнат и проектов, 6.1: ссылка «N archived» внизу группы — архивные работы проекта спрятаны под ней.
describe('ProjectGroup — ссылка «N archived» (спека архива, 6.1)', () => {
  beforeEach(() => useUiStore.setState({ archivedShownProjects: [] }));

  const withArchived = (count: number, shown = false): SidebarSection => ({ ...project, archived: { count, shown } });
  const link = (): HTMLElement | null => document.querySelector<HTMLElement>('[data-archived-works]');

  it('ссылка стоит под карточками, считает архивные работы и не берёт число из шапки', () => {
    render(
      <ProjectGroup section={withArchived(5)} onToggleCollapsed={() => {}} onNewWork={() => {}}>
        <div data-card />
      </ProjectGroup>,
    );
    const group = document.querySelector<HTMLElement>('[data-section]') as HTMLElement;
    expect(link()?.textContent).toBe('5 archived');
    expect(group.lastElementChild).toBe(link());
    // Число в шапке — по показанным работам секции.
    expect(header().textContent).toContain('3');
    expect(header().textContent).not.toContain('5');
  });

  it('клик раскрывает архивные этого проекта в памяти окна; повторный — «Hide archived» прячет', () => {
    const { rerender } = render(<ProjectGroup section={withArchived(2)} onToggleCollapsed={() => {}} onNewWork={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: '2 archived' }));
    expect(useUiStore.getState().archivedShownProjects).toEqual(['/Users/me/VoiceStudio']);

    rerender(<ProjectGroup section={withArchived(2, true)} onToggleCollapsed={() => {}} onNewWork={() => {}} />);
    expect(link()?.textContent).toBe(S.sidebar.hideArchivedWorks);
    expect(link()?.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Hide archived' }));
    expect(useUiStore.getState().archivedShownProjects).toEqual([]);
  });

  it('раскрытие одного проекта не трогает другие', () => {
    useUiStore.setState({ archivedShownProjects: ['/p/other'] });
    render(<ProjectGroup section={withArchived(1)} onToggleCollapsed={() => {}} onNewWork={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: '1 archived' }));
    expect(useUiStore.getState().archivedShownProjects).toEqual(['/p/other', '/Users/me/VoiceStudio']);
  });

  it('ссылка достижима с клавиатуры, как «N more closed»: нативная кнопка вне roving tabindex, клик группу не сворачивает', () => {
    const onToggleCollapsed = vi.fn();
    render(<ProjectGroup section={withArchived(1)} onToggleCollapsed={onToggleCollapsed} onNewWork={() => {}} />);
    const button = screen.getByRole('button', { name: '1 archived' });
    expect(button.tagName).toBe('BUTTON');
    expect(button.getAttribute('type')).toBe('button');
    expect(button.tabIndex).toBe(0);
    fireEvent.click(button);
    expect(onToggleCollapsed).not.toHaveBeenCalled();
  });

  it('без архивных работ, у свёрнутой группы, у Pinned и у заголовка виртуального списка ссылки нет', () => {
    const { rerender } = render(<ProjectGroup section={project} onToggleCollapsed={() => {}} onNewWork={() => {}} />);
    expect(link()).toBeNull();
    rerender(<ProjectGroup section={{ ...withArchived(2), collapsed: true }} onToggleCollapsed={() => {}} onNewWork={() => {}} />);
    expect(link()).toBeNull();
    rerender(
      <ProjectGroup
        section={{ ...withArchived(2), kind: 'pinned', key: 'pinned', title: S.sidebar.pinned, projectPath: null }}
        onToggleCollapsed={() => {}}
        onNewWork={() => {}}
      />,
    );
    expect(link()).toBeNull();
    rerender(<ProjectGroup section={withArchived(2)} onToggleCollapsed={() => {}} onNewWork={() => {}} headerOnly />);
    expect(link()).toBeNull();
  });

  it('отдельная строка виртуального списка рисует ту же ссылку', () => {
    render(<ProjectArchivedLink section={withArchived(4)} />);
    expect(screen.getByRole('button', { name: '4 archived' })).toBeTruthy();
  });

  it('ссылка занимает ширину строки и обрезает текст, а не выталкивает соседей', () => {
    render(<ProjectArchivedLink section={withArchived(1234567)} />);
    const button = link() as HTMLElement;
    expect(button.className).toContain('w-full');
    expect(button.className).toContain('min-w-0');
    expect(button.firstElementChild?.className).toContain('truncate');
  });
});
