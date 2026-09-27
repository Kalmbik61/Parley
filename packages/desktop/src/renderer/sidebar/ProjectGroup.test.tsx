/** Заголовок группы проекта (кусок 3.3, спека 6.1): чип цвета, «+» не сворачивает группу. */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { S } from '../../shared/strings.js';
import { projectColor } from '../lib/project-color.js';
import { makeWork } from '../test-utils/work-fixtures.js';
import { ProjectGroup } from './ProjectGroup.js';
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

describe('ProjectGroup', () => {
  it('чип — цвет проекта, число работ, полный путь в title', () => {
    render(<ProjectGroup section={project} onToggleCollapsed={() => {}} onNewWork={() => {}} />);
    const header = document.querySelector<HTMLElement>('[data-section-key]');
    const chip = header?.querySelector<HTMLElement>('[aria-hidden="true"]');
    const probe = document.createElement('span');
    probe.style.backgroundColor = projectColor('/Users/me/VoiceStudio');
    expect(chip?.style.backgroundColor).toBe(probe.style.backgroundColor);
    expect(header?.textContent).toContain('3');
    expect(header?.getAttribute('title')).toBe('/Users/me/VoiceStudio');
    expect(header?.getAttribute('aria-expanded')).toBe('true');
  });

  it('клик по заголовку — onToggleCollapsed; «+» — onNewWork(projectPath) без сворачивания', () => {
    const onToggleCollapsed = vi.fn();
    const onNewWork = vi.fn();
    render(<ProjectGroup section={project} onToggleCollapsed={onToggleCollapsed} onNewWork={onNewWork} />);
    fireEvent.click(screen.getByRole('button', { name: S.sidebar.newWorkspaceInProject }));
    // Кусок 3.5: «+» передаёт свой проект — форма откроется с ним.
    expect(onNewWork).toHaveBeenCalledTimes(1);
    expect(onNewWork).toHaveBeenCalledWith('/Users/me/VoiceStudio');
    expect(onToggleCollapsed).not.toHaveBeenCalled();
    fireEvent.click(document.querySelector('[data-section-key]') as HTMLElement);
    expect(onToggleCollapsed).toHaveBeenCalledTimes(1);
  });

  it('«Закреплённые» — подпись без чипа, «+» и сворачивания', () => {
    render(
      <ProjectGroup
        section={{ ...project, kind: 'pinned', key: 'pinned', title: S.sidebar.pinned, projectPath: null }}
        onToggleCollapsed={() => {}}
        onNewWork={() => {}}
      />,
    );
    expect(screen.getByText('Pinned')).toBeTruthy();
    // С куска 3.4 у каждого заголовка секции — только меню «⋯» (спека 6.1).
    expect(screen.getAllByRole('button').map((button) => button.getAttribute('aria-label'))).toEqual([S.sidebar.sectionMenu]);
  });
});
