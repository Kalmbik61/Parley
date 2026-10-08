/**
 * Чип рецепта в шапке комнаты (спека рецептов, 6.5): название рядом с режимом, по клику — плейбук только для
 * чтения; без рецепта чипа нет; показывается снимок комнаты, а не файл рецепта.
 */

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REQUIRED_METHODS } from '../../lib/capabilities.js';
import { useHostStore } from '../../store/host.js';
import { useUiStore } from '../../store/ui.js';
import { createFakeBridge } from '../../test-utils/fake-bridge.js';
import { makeRoom, makeSession, makeWork } from '../../test-utils/work-fixtures.js';
import { RoomPanel } from './RoomPanel.js';
import { RoomRecipeChip } from './RoomRecipeChip.js';

const PLAYBOOK = '1. Ask the human for the goal.\n2. Draft a plan.';

beforeEach(() => {
  useUiStore.setState({ composerDrafts: {}, windowFocused: true, documentVisible: true });
  useHostStore.setState({ status: { state: 'connected', hostVersion: 'test', methods: [...REQUIRED_METHODS] } });
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => { cleanup(); Reflect.deleteProperty(Element.prototype, 'scrollIntoView'); });

function panel(recipe: { id: string; name: string; playbook: string } | null) {
  const entry = makeWork('w-01', {
    projectPath: '/tmp/proj', title: 'Payments',
    sessions: [makeSession('s-01', 'lead'), makeSession('s-02', 'dev')],
    rooms: [{ ...makeRoom('r-01', 'Room'), members: ['s-01', 's-02'], lead: 's-01', ...(recipe === null ? {} : { recipe }) }],
  });
  return render(<RoomPanel entry={entry} roomId="r-01" providers={[{ id: 'claude', label: 'Claude' }]} activity={{}} bridge={createFakeBridge()}
    active onOpenExternal={() => {}} onOpenSession={() => {}} />);
}

describe('RoomRecipeChip', () => {
  it('shows the recipe name; a click opens the playbook as read-only text', async () => {
    render(<RoomRecipeChip recipe={{ id: 'builtin:plan-build', name: 'Plan & build', playbook: PLAYBOOK }} />);
    const chip = screen.getByRole('button', { name: 'Plan & build' });
    expect(screen.queryByText(/Ask the human/)).toBeNull();
    await act(async () => { fireEvent.click(chip); });
    const group = screen.getByRole('group', { name: 'Lead playbook · Plan & build' });
    expect(within(group).getByText(/Ask the human for the goal/).textContent).toBe(PLAYBOOK);
    // Только чтение: ни полей ввода, ни кнопок правки.
    expect(group.querySelector('textarea, input, [contenteditable="true"]')).toBeNull();
  });

  it('an empty playbook says so', async () => {
    render(<RoomRecipeChip recipe={{ id: 'project:x', name: 'X', playbook: '  \n' }} />);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'X' })); });
    expect(screen.getByText('This recipe has no playbook.')).toBeTruthy();
  });

  it('long names are truncated and keep the full text in the tooltip', () => {
    const name = 'A very long recipe name '.repeat(8).trim();
    render(<RoomRecipeChip recipe={{ id: 'project:long', name, playbook: '' }} />);
    expect(screen.getByRole('button', { name }).getAttribute('title')).toBe(`Recipe: ${name}`);
  });
});

describe('RoomPanel header chip', () => {
  it('a room with a recipe shows the chip next to the mode control; a room without one has none', () => {
    const { container } = panel({ id: 'builtin:review', name: 'Review', playbook: PLAYBOOK });
    const header = container.querySelector('[data-room-header]') as HTMLElement;
    expect(within(header).getByRole('button', { name: 'Review' })).toBeTruthy();
    expect(header.querySelector('[data-room-mode]')?.parentElement).toBe(header.querySelector('[data-room-recipe]')?.parentElement);
    cleanup();
    const plain = panel(null).container;
    expect(plain.querySelector('[data-room-recipe]')).toBeNull();
    expect(plain.querySelector('[data-room-mode]')).not.toBeNull();
  });
});
