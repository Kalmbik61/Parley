import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CapabilitySnapshot } from '@parley/protocol';
import { SkillSharePanel } from './SkillSharePanel.js';
import { useHostStore } from '../../store/host.js';
import { createFakeBridge } from '../../test-utils/fake-bridge.js';
import type { FakeBridge } from '../../test-utils/fake-bridge.js';
const yes = { allowed: true, reason: null } as const, no = { allowed: false, reason: 'unverified' } as const;
const METHODS = ['capabilities.skills.share', 'capabilities.skills.unshare'];
let bridge: FakeBridge;
const snapshot = (revision = 7, projectPath = '/project'): CapabilitySnapshot => ({ projectPath, revision,
 columns: { claude: { phase: 'ready', diagnostics: [] }, codex: { phase: 'ready', diagnostics: [] } },
 rows: [{ id: 'skill', kind: 'skill', name: 'Display skill', description: null, separateCopies: false,
  claude: [{ id: 'opaque-source', scope: 'project', source: '/project/.claude/skills/folder/SKILL.md', documentPath: '/project/.claude/skills/folder/SKILL.md', description: 'Ordinary manual skill', installed: true, enabled: null, status: 'unknown', summary: null, modelAvailable: false, unavailableReason: 'availability-unverified', skillActions: { share: yes, unshare: no } }], codex: [] }],
});
const renderPresence = () => <span>Native availability remains unverified</span>;
beforeEach(() => { bridge = createFakeBridge(); useHostStore.setState({ status: { state: 'connected', hostVersion: 'fixture', methods: METHODS }, connections: 1 }); bridge.setHandler('capabilities.skills.share', () => ({ outcome: 'ok', code: 'ok', scope: 'project' })); bridge.setHandler('capabilities.skills.unshare', () => ({ outcome: 'ok', code: 'ok', scope: 'project' })); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const mount = (value = snapshot()) => render(<SkillSharePanel snapshot={value} bridge={bridge} renderPresence={renderPresence} />);
it('inventory rendering makes no mutation; explicit Share sends only the native source opaque binding and shows project Git guidance', async () => {
 mount(); expect(bridge.calls).toHaveLength(0); expect(screen.getByText(/Review Git status/)).toBeTruthy(); expect(screen.getByText(/availability remains unverified/)).toBeTruthy();
 fireEvent.click(screen.getByRole('button', { name: 'Share with Codex' })); await screen.findByText('Done');
 expect(bridge.calls[0]).toEqual({ method: 'capabilities.skills.share', params: { projectPath: '/project', provider: 'claude', revision: 7, presenceId: 'opaque-source' } });
 expect(bridge.calls.some(call => call.method.startsWith('sessions.'))).toBe(false); expect(document.body.textContent).not.toContain('0 sessions');
});
it('Unshare permits host-proven owned cleanup of a disabled source and never sends original paths', async () => {
 const value = snapshot(), source = value.rows[0]!.claude[0]!; source.skillActions = { share: no, unshare: yes }; source.unavailableReason = 'disable-model-invocation';
 mount(value); expect(screen.getByRole('button', { name: 'Share with Codex' }).hasAttribute('disabled')).toBe(true);
 const unshare = screen.getByRole('button', { name: 'Unshare from Codex' }); expect(unshare.getAttribute('title')).toContain('original skill stays'); fireEvent.click(unshare); await screen.findByText('Done');
 expect(bridge.calls[0]).toEqual({ method: 'capabilities.skills.unshare', params: { projectPath: '/project', provider: 'claude', revision: 7, presenceId: 'opaque-source' } });
});
it('user native absolute-link scope is visible, while foreign scopes and separate copies cannot be called', () => {
 const value = snapshot(); value.rows[0]!.claude[0]!.scope = 'user'; const view = mount(value); expect(screen.getByText(/absolute symlink/)).toBeTruthy();
 for (const scope of ['builtin', 'plugin', 'extra', null] as const) { const next = snapshot(); next.rows[0]!.claude[0]!.scope = scope; view.rerender(<SkillSharePanel snapshot={next} bridge={bridge} renderPresence={renderPresence} />); expect(screen.getAllByRole('button').every(button => button.hasAttribute('disabled'))).toBe(true); }
 const copy = snapshot(); copy.rows[0]!.separateCopies = true; view.rerender(<SkillSharePanel snapshot={copy} bridge={bridge} renderPresence={renderPresence} />); expect(screen.getAllByRole('button').every(button => button.hasAttribute('disabled'))).toBe(true); expect(bridge.calls).toHaveLength(0);
});
it('old host and disconnected method gates prevent calls without claiming receiver availability', () => {
 useHostStore.setState({ status: { state: 'connected', hostVersion: 'old', methods: [] } }); mount(); expect(screen.getByText(/host does not support skill sharing/)).toBeTruthy(); expect(screen.getAllByRole('button').every(button => button.hasAttribute('disabled'))).toBe(true); expect(bridge.calls).toHaveLength(0);
});
it.each(['revision', 'project', 'connection', 'methods', 'bridge', 'unmount'] as const)('ignores a delayed mutation reply after %s changes', async kind => {
 let resolve!: (value: unknown) => void; bridge.setHandler('capabilities.skills.share', () => new Promise(done => { resolve = done; }) as never); const view = mount(); fireEvent.click(screen.getByRole('button', { name: 'Share with Codex' }));
 if (kind === 'connection') await act(async () => { useHostStore.setState({ connections: 2 }); });
 else if (kind === 'methods') await act(async () => { useHostStore.setState({ status: { state: 'connected', hostVersion: 'new', methods: [] } }); });
 else if (kind === 'unmount') view.unmount();
 else view.rerender(<SkillSharePanel snapshot={snapshot(kind === 'revision' ? 8 : 7, kind === 'project' ? '/other' : '/project')} bridge={kind === 'bridge' ? createFakeBridge() : bridge} renderPresence={renderPresence} />);
 await act(async () => { resolve({ outcome: 'ok', code: 'ok', scope: 'project' }); }); expect(screen.queryByText('Done')).toBeNull(); expect(bridge.calls).toHaveLength(1);
});
it('busy actions are disabled and raw failures or malformed responses become fixed messages without logs', async () => {
 let resolve!: (value: unknown) => void; bridge.setHandler('capabilities.skills.share', () => new Promise(done => { resolve = done; }) as never); const warn = vi.spyOn(console, 'warn').mockImplementation(() => {}); mount(); fireEvent.click(screen.getByRole('button', { name: 'Share with Codex' })); expect(screen.getAllByRole('button').every(button => button.hasAttribute('disabled'))).toBe(true);
 await act(async () => { resolve({ outcome: 'ok', code: 'ok', scope: 'project', raw: 'SECRET_NATIVE' }); }); await screen.findByText('The skill ownership or policy could not be verified');
 bridge.setHandler('capabilities.skills.share', () => { throw new Error('SECRET_FILESYSTEM'); }); fireEvent.click(screen.getByRole('button', { name: 'Share with Codex' })); await screen.findByText('The skill sharing action could not be completed'); expect(document.body.textContent).not.toContain('SECRET'); expect(warn).not.toHaveBeenCalled();
});
it('Refresh preserves the adoption notice and never repeats mutation or restarts a session', async () => {
 const view = mount(); fireEvent.click(screen.getByRole('button', { name: 'Share with Codex' })); await screen.findByText('Done'); view.rerender(<SkillSharePanel snapshot={snapshot(8)} bridge={bridge} renderPresence={renderPresence} />);
 expect(screen.getByText('Sharing changes apply to new sessions. Restart affected sessions to pick up changes.')).toBeTruthy(); expect(bridge.calls).toHaveLength(1); expect(bridge.calls.some(call => call.method.startsWith('sessions.'))).toBe(false);
});
