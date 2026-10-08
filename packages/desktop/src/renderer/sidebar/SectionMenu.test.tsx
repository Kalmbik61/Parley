import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { S } from '../../shared/strings.js';
import { useUiStore } from '../store/ui.js';
import { createFakeBridge } from '../test-utils/fake-bridge.js';
import { SectionMenu } from './SectionMenu.js';
let bridge: ReturnType<typeof createFakeBridge>;
beforeEach(() => { bridge = createFakeBridge(); vi.stubGlobal('parley', bridge); window.parley = bridge;
 useUiStore.getState().closeProjectPanel(); useUiStore.setState({ sidebarHolds: {} }); });
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
