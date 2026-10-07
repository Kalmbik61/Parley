import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { createFakeBridge } from '../test-utils/fake-bridge.js';
import { RoleChip } from './role-summary.js';
afterEach(cleanup);
describe('current role presentation', () => {
  it('reads native metadata for the actual participant and never infers read-only from the name', async () => {
    const bridge = createFakeBridge();
    bridge.setHandler('roles.list', async params => {
      expect(params.ref).toEqual({ projectPath: '/project', workId: 'w-1', sessionId: 's-1' });
      return { roles: [{ id: 'claude:planner', name: 'planner', source: 'claude', provider: 'claude', description: 'Native tools', model: null, effort: null, readOnly: false }], diagnostics: [], partial: false };
    });
    render(<RoleChip bridge={bridge} role={{ source: 'claude', name: 'planner' }} sessionRef={{ projectPath: '/project', workId: 'w-1', sessionId: 's-1' }} />);
    await waitFor(() => expect((screen.getByText('planner · Claude').closest('[data-role-chip]') as HTMLElement).title).toBe('planner · Claude\nNative tools'));
    expect(screen.queryByLabelText('Read only')).toBeNull();
  });
  it('shows a lock only from a current role response and drops it across participant scope changes', async () => {
    const bridge = createFakeBridge();
    bridge.setHandler('roles.list', async params => ({ roles: [{ id: 'codex:review', name: 'Review', source: 'codex', provider: 'codex', description: '', model: null, effort: 'xhigh', readOnly: params.ref?.sessionId === 's-1' }], diagnostics: [], partial: false }));
    const { rerender } = render(<RoleChip bridge={bridge} role={{ source: 'codex', name: 'review' }} sessionRef={{ projectPath: '/project', workId: 'w-1', sessionId: 's-1' }} />);
    await waitFor(() => expect(screen.getByLabelText('Read only')).toBeTruthy());
    rerender(<RoleChip bridge={bridge} role={{ source: 'codex', name: 'review' }} sessionRef={{ projectPath: '/project', workId: 'w-1', sessionId: 's-2' }} />);
    await waitFor(() => expect(screen.queryByLabelText('Read only')).toBeNull());
    expect(bridge.calls.filter(call => call.method === 'roles.list')).toHaveLength(2);
  });
});


describe('role metadata refresh on resume', () => {
  it('rereads the same role after launch/cwd revision and drops removed read-only metadata', async () => {
    const bridge = createFakeBridge();
    let readOnly = true;
    bridge.setHandler('roles.list', async () => ({ roles: [{ id: 'codex:review', name: 'Review', source: 'codex', provider: 'codex', description: 'Current native role', model: null, effort: 'xhigh', readOnly }], diagnostics: [], partial: false }));
    const role = { source: 'codex' as const, name: 'review' };
    const sessionRef = { projectPath: '/project', workId: 'w-1', sessionId: 's-1' };
    const { rerender } = render(<RoleChip bridge={bridge} role={role} sessionRef={sessionRef} revision="pid:101:/worktree-old" />);
    await waitFor(() => expect(screen.getByLabelText('Read only')).toBeTruthy());
    readOnly = false;
    rerender(<RoleChip bridge={bridge} role={role} sessionRef={sessionRef} revision="pid:202:/worktree-new" />);
    expect(screen.queryByLabelText('Read only')).toBeNull();
    await waitFor(() => expect(bridge.calls.filter(call => call.method === 'roles.list')).toHaveLength(2));
    expect(screen.queryByLabelText('Read only')).toBeNull();
  });
});

// Жалоба 2026-10-07: в карточке участника комнаты чип не сжимался (`shrink-0`), имя схлопывалось в ноль, а многоточия у
// голого текста внутри inline-flex не бывает. Раскладку меряет E2E `room-participants-layout.spec.ts`; здесь — устройство чипа.
describe('чип роли в тесной строке', () => {
  const architect = { id: 'builtin:architect', name: 'Architect', source: 'builtin' as const, provider: 'claude', description: 'Define boundaries.', model: null, effort: null, readOnly: true };

  it('чип сжимается сам: текст роли — свой элемент с многоточием, 🔒 — вне него и не сжимается', async () => {
    const bridge = createFakeBridge();
    bridge.setHandler('roles.list', async () => ({ roles: [architect], diagnostics: [], partial: false }));
    render(<RoleChip bridge={bridge} role={{ source: 'builtin', name: 'architect' }} sessionRef={{ projectPath: '/project', workId: 'w-1', sessionId: 's-1' }} />);
    const lock = await screen.findByLabelText('Read only');
    const text = screen.getByText('Architect · Builtin');
    const chip = text.closest('[data-role-chip]') as HTMLElement;
    // Ни `shrink-0`, ни `min-w-0`: чип сжимается, но не уже полей и 🔒 (сетка `auto minmax(0, max-content)`).
    expect(chip.className).not.toMatch(/\bshrink-0\b/);
    expect(chip.className).not.toMatch(/\bmin-w-0\b/);
    expect(chip.className).toContain('grid-cols-[auto_minmax(0,max-content)]');
    expect(text.className).toMatch(/\btruncate\b/);
    expect(text.className).toContain('col-start-2');
    expect(text.contains(lock)).toBe(false);
    expect(lock.parentElement).toBe(chip);
  });

  it('полная роль — первой строкой тултипа чипа, описание — второй; роли нет в ответе хоста — «Role unavailable»', async () => {
    const bridge = createFakeBridge();
    bridge.setHandler('roles.list', async params => ({ roles: params.ref?.sessionId === 's-1' ? [architect] : [], diagnostics: [], partial: false }));
    const sessionRef = { projectPath: '/project', workId: 'w-1', sessionId: 's-1' };
    const { rerender } = render(<RoleChip bridge={bridge} role={{ source: 'builtin', name: 'architect' }} sessionRef={sessionRef} />);
    const chip = (): HTMLElement => document.querySelector('[data-role-chip]') as HTMLElement;
    await waitFor(() => expect(chip().title).toBe('Architect · Builtin\nDefine boundaries.'));
    rerender(<RoleChip bridge={bridge} role={{ source: 'builtin', name: 'architect' }} sessionRef={{ ...sessionRef, sessionId: 's-2' }} />);
    await waitFor(() => expect(bridge.calls.filter(call => call.method === 'roles.list')).toHaveLength(2));
    await waitFor(() => expect(chip().title).toBe('architect · Builtin\nRole unavailable'));
  });
});
