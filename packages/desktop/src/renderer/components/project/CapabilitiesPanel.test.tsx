import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { CapabilityPresence, CapabilitySnapshot } from '@parley/protocol';
import { CapabilitiesPanel } from './CapabilitiesPanel.js';

afterEach(cleanup);
const presence = (id: string, description: string): CapabilityPresence => ({ id, scope: 'admin', source: '/native/source',
  documentPath: `/native/${id}/SKILL.md`, description, installed: true, enabled: null, status: 'unknown',
  summary: null, modelAvailable: false, unavailableReason: 'availability-unverified' });
const snapshot = (): CapabilitySnapshot => ({ projectPath: '/project', revision: 1,
  columns: { claude: { phase: 'loading', diagnostics: [] }, codex: { phase: 'partial', diagnostics: [{ code: 'resolver-partial' }] } },
  rows: [{ id: 'skill-review', kind: 'skill', name: 'review', description: 'Review', separateCopies: true,
    claude: [], codex: [presence('first', 'First copy'), { ...presence('second', 'Second copy'), scope: 'extra', enabled: false,
      unavailableReason: 'implicit-invocation-disabled' }] }],
});

describe('safe capabilities inventory view', () => {
  it('shows hidden same-name copies independently while the other provider is loading', () => {
    render(<CapabilitiesPanel snapshot={snapshot()} />);
    expect(screen.getByText('First copy')).toBeTruthy(); expect(screen.getByText('Second copy')).toBeTruthy();
    expect(screen.getByText('Admin')).toBeTruthy(); expect(screen.getByText('Extra')).toBeTruthy();
    expect(screen.getByText('Native availability is not verified')).toBeTruthy();
    expect(screen.getByText('Implicit invocation is disabled')).toBeTruthy();
    expect(screen.getByText('Separate copies')).toBeTruthy(); expect(screen.getByText('Policy unknown')).toBeTruthy();
    expect(within(screen.getByRole('region', { name: 'Claude' })).getByRole('status').textContent).toBe('Loading…');
    expect(screen.queryByText('Not found')).toBeNull();
  });
  it('preserves builtin lock/shared evidence and never renders raw extras or action controls', () => {
    const value = snapshot(); value.rows[0]!.codex[0]!.sharedFrom = 'claude';
    value.rows.push({ id: 'builtin', kind: 'mcp', name: 'parley', description: null, separateCopies: false, claude: [],
      codex: [{ ...presence('builtin', 'Provided at launch'), scope: 'builtin', source: 'Parley launch', documentPath: null,
        modelAvailable: null, unavailableReason: null }] });
    Object.assign(value.rows[0]!.codex[0]!, { config: { API_KEY: 'FIXTURE_SECRET' }, stdout: 'FIXTURE_SECRET' });
    render(<CapabilitiesPanel snapshot={value} />);
    expect(screen.getByLabelText('Built-in · managed by Parley')).toBeTruthy();
    expect(screen.getByText('Shared from Claude')).toBeTruthy(); expect(document.body.textContent).not.toContain('FIXTURE_SECRET');
    expect(screen.queryByRole('button')).toBeNull();
  });
  it('does not claim absence for partial/error columns; a complete empty snapshot is explicit', () => {
    const value = snapshot(); value.columns.claude.phase = 'error';
    const { rerender } = render(<CapabilitiesPanel snapshot={value} />);
    expect(screen.getByText('Not confirmed')).toBeTruthy(); expect(screen.queryByText('No capabilities found.')).toBeNull();
    value.rows = []; value.columns.claude.phase = 'ready'; value.columns.codex.phase = 'ready';
    rerender(<CapabilitiesPanel snapshot={value} />); expect(screen.getByText('No capabilities found.')).toBeTruthy();
  });
});


import { fireEvent, within } from '@testing-library/react';
import { vi } from 'vitest';

it('requires explicit Remove confirmation for an owned presence and gates builtin/unknown/Check', () => {
 const value: CapabilitySnapshot = { projectPath: '/project', revision: 7, columns: { claude: { phase: 'ready', diagnostics: [] }, codex: { phase: 'ready', diagnostics: [] } }, rows: [{ id: 'mcp', kind: 'mcp', name: 'example', description: null, separateCopies: false, claude: [{ id: 'opaque', scope: 'user', source: null, documentPath: null, description: null, installed: true, enabled: null, status: 'unknown', summary: null, modelAvailable: null, unavailableReason: null,
  mcpActions: { remove: { allowed: true, reason: null }, check: { allowed: false, reason: 'unverified' } } }], codex: [{ id: 'builtin', scope: 'builtin', source: null, documentPath: null, description: null, installed: true, enabled: null, status: 'unknown', summary: null, modelAvailable: null, unavailableReason: null, mcpActions: { remove: { allowed: false, reason: 'builtin' }, check: { allowed: false, reason: 'native-only' } } }] }] };
 const remove = vi.fn(); const check = vi.fn(); const actions = { supports: { remove: true, check: true }, busy: false, remove, check };
 const view = render(<CapabilitiesPanel snapshot={value} actions={actions} />);
 expect(screen.getAllByRole('button', { name: 'Check' }).every(button => button.hasAttribute('disabled'))).toBe(true);
 const buttons = screen.getAllByRole('button', { name: 'Remove…' }); expect(buttons[1]?.hasAttribute('disabled')).toBe(true); fireEvent.click(buttons[0]!); expect(remove).not.toHaveBeenCalled();
 fireEvent.click(within(screen.getByRole('group')).getByRole('button', { name: 'Cancel' })); expect(remove).not.toHaveBeenCalled();
 fireEvent.click(buttons[0]!); fireEvent.click(screen.getByRole('button', { name: 'Remove server' })); expect(remove).toHaveBeenCalledWith('claude', value.rows[0]?.claude[0], 7);
 fireEvent.click(buttons[0]!); view.rerender(<CapabilitiesPanel snapshot={{ ...value, revision: 8 }} actions={actions} />); expect(screen.getByRole('button', { name: 'Remove server' }).hasAttribute('disabled')).toBe(true);
 expect(screen.getByText('Use /mcp in a native Codex session to check the connection or authenticate.')).toBeTruthy(); expect(check).not.toHaveBeenCalled();
});
