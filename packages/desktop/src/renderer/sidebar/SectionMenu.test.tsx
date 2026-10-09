import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { S } from '../../shared/strings.js';
import { DEFAULT_UI } from '../../shared/ui-types.js';
import { useUiStore } from '../store/ui.js';
import { useWorksStore } from '../store/works.js';
import { createFakeBridge } from '../test-utils/fake-bridge.js';
import { makeWork } from '../test-utils/work-fixtures.js';
import { SectionMenu } from './SectionMenu.js';
let bridge: ReturnType<typeof createFakeBridge>;
beforeEach(() => { bridge = createFakeBridge(); vi.stubGlobal('parley', bridge); window.parley = bridge;
 useUiStore.getState().closeProjectPanel(); useUiStore.setState({ sidebarHolds: {}, ui: DEFAULT_UI });
 useWorksStore.setState({ entries: [], branches: {}, loading: false, error: null }); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); useUiStore.getState().closeProjectPanel(); });
it('project menu opens its own capabilities panel and retains read-only PARLEY status lookup', async () => {
 const status = vi.spyOn(bridge.app, 'parleyMd'); render(<SectionMenu sectionKey="/tmp/other-project" />);
 fireEvent.keyDown(screen.getByRole('button', { name: S.sidebar.sectionMenu }), { key: 'Enter' });
 const item = await screen.findByRole('menuitem', { name: S.actions.capabilities });
 expect(await screen.findByRole('menuitem', { name: S.sidebar.openParleyMd })).toBeTruthy();
 fireEvent.click(item); expect(useUiStore.getState().projectPanel).toBe('/tmp/other-project');
 await waitFor(() => expect(status).toHaveBeenCalledWith('/tmp/other-project', false));
 expect(status.mock.calls.every(([, create]) => !create)).toBe(true);
});
it('pinned menu has no project capabilities or PARLEY actions', () => {
 render(<SectionMenu sectionKey="pinned" />); fireEvent.keyDown(screen.getByRole('button', { name: S.sidebar.sectionMenu }), { key: 'Enter' });
 expect(screen.queryByRole('menuitem', { name: S.actions.capabilities })).toBeNull();
 expect(screen.queryByRole('menuitem', { name: S.sidebar.openParleyMd })).toBeNull();
 expect(screen.getByRole('menuitemcheckbox', { name: S.sidebar.showDone })).toBeTruthy();
});

// Спека архива комнат и проектов, 6.3: «Remove from list…» убирает проект из сайдбара и ничего не удаляет.
const PROJECT = '/tmp/shop';
const openMenu = (): void => { fireEvent.keyDown(screen.getByRole('button', { name: S.sidebar.sectionMenu }), { key: 'Enter' }); };
const setWorks = (...statuses: Array<'active' | 'done' | 'archived'>): void => {
 useWorksStore.setState({
  entries: statuses.map((status, index) => makeWork(`w-0${index + 1}`, { projectPath: PROJECT, status })),
  branches: {}, loading: false, error: null,
 });
};

it('Remove from list is disabled with a hint while the project has a non-archived workspace, done included', async () => {
 for (const live of ['active', 'done'] as const) {
  setWorks('archived', live);
  render(<SectionMenu sectionKey={PROJECT} />); openMenu();
  const item = await screen.findByRole('menuitem', { name: S.sidebar.removeFromList });
  expect(item.getAttribute('aria-disabled')).toBe('true');
  expect(item.getAttribute('title')).toBe('Archive its workspaces first');
  fireEvent.click(item);
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(useUiStore.getState().ui.hiddenProjects).toEqual([]);
  cleanup();
 }
});

it('Remove from list is enabled when every workspace is archived: confirmation, then the path goes to hiddenProjects', async () => {
 setWorks('archived', 'archived');
 render(<SectionMenu sectionKey={PROJECT} />); openMenu();
 const item = await screen.findByRole('menuitem', { name: S.sidebar.removeFromList });
 expect(item.getAttribute('aria-disabled')).toBeNull();
 expect(item.getAttribute('title')).toBeNull();
 fireEvent.click(item);
 expect(await screen.findByText('Remove "shop" from the list?')).toBeTruthy();
 expect(screen.getByText(S.sidebar.removeProjectDescription)).toBeTruthy();
 // Подтверждение держит порядок сайдбара, пока открыто.
 expect(Object.keys(useUiStore.getState().sidebarHolds)).toContain(`section-menu ${PROJECT}`);
 expect(useUiStore.getState().ui.hiddenProjects).toEqual([]);
 fireEvent.click(screen.getByRole('button', { name: S.sidebar.removeProjectConfirm }));
 expect(useUiStore.getState().ui.hiddenProjects).toEqual([PROJECT]);
});

it('Remove from list is enabled for a project without any workspace; the path is added once, other hidden projects stay', async () => {
 useUiStore.setState({ ui: { ...DEFAULT_UI, hiddenProjects: ['/tmp/other', PROJECT] } });
 render(<SectionMenu sectionKey={PROJECT} />); openMenu();
 fireEvent.click(await screen.findByRole('menuitem', { name: S.sidebar.removeFromList }));
 fireEvent.click(await screen.findByRole('button', { name: S.sidebar.removeProjectConfirm }));
 expect(useUiStore.getState().ui.hiddenProjects).toEqual(['/tmp/other', PROJECT]);
});

it('cancelling the confirmation leaves hiddenProjects as it was', async () => {
 setWorks('archived');
 render(<SectionMenu sectionKey={PROJECT} />); openMenu();
 fireEvent.click(await screen.findByRole('menuitem', { name: S.sidebar.removeFromList }));
 fireEvent.click(await screen.findByRole('button', { name: S.common.cancel }));
 expect(useUiStore.getState().ui.hiddenProjects).toEqual([]);
});

it('a long folder name goes into the confirmation title whole (the dialog wraps it)', async () => {
 const long = 'p'.repeat(120);
 useWorksStore.setState({ entries: [makeWork('w-01', { projectPath: `/tmp/${long}`, status: 'archived' })], branches: {}, loading: false, error: null });
 render(<SectionMenu sectionKey={`/tmp/${long}`} />); openMenu();
 fireEvent.click(await screen.findByRole('menuitem', { name: S.sidebar.removeFromList }));
 const title = await screen.findByText(`Remove "${long}" from the list?`);
 expect(title.className).toContain('break-words');
});

it('the pinned menu has no Remove from list', async () => {
 render(<SectionMenu sectionKey="pinned" />); openMenu();
 await screen.findByRole('menuitemcheckbox', { name: S.sidebar.showDone });
 expect(screen.queryByRole('menuitem', { name: S.sidebar.removeFromList })).toBeNull();
});
