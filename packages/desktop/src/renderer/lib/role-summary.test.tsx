import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { resetRolesStoreForTests } from '../store/roles.js';
import { createFakeBridge } from '../test-utils/fake-bridge.js';
import { RoleChip } from './role-summary.js';
afterEach(() => { cleanup(); resetRolesStoreForTests(); });
describe('current role presentation', () => {
  it('reads native metadata for the actual participant and never infers read-only from the name', async () => {
    const bridge = createFakeBridge();
    bridge.setHandler('roles.list', async params => {
      expect(params.ref).toEqual({ projectPath: '/project', workId: 'w-1', sessionId: 's-1' });
      return { roles: [{ id: 'claude:planner', name: 'planner', source: 'claude', provider: 'claude', description: 'Native tools', model: null, effort: null, readOnly: false }], diagnostics: [], partial: false };
    });
    render(<RoleChip bridge={bridge} role={{ source: 'claude', name: 'planner' }} sessionRef={{ projectPath: '/project', workId: 'w-1', sessionId: 's-1' }} cwd="/project" />);
    await waitFor(() => expect((screen.getByText('planner · Claude').closest('[data-role-chip]') as HTMLElement).title).toBe('planner · Claude\nNative tools'));
    expect(screen.queryByLabelText('Read only')).toBeNull();
  });
  it('shows a lock only from a current role response and drops it across participant scope changes', async () => {
    const bridge = createFakeBridge();
    bridge.setHandler('roles.list', async params => ({ roles: [{ id: 'codex:review', name: 'Review', source: 'codex', provider: 'codex', description: '', model: null, effort: 'xhigh', readOnly: params.ref?.sessionId === 's-1' }], diagnostics: [], partial: false }));
    const { rerender } = render(<RoleChip bridge={bridge} role={{ source: 'codex', name: 'review' }} sessionRef={{ projectPath: '/project', workId: 'w-1', sessionId: 's-1' }} cwd="/wt-1" />);
    await waitFor(() => expect(screen.getByLabelText('Read only')).toBeTruthy());
    rerender(<RoleChip bridge={bridge} role={{ source: 'codex', name: 'review' }} sessionRef={{ projectPath: '/project', workId: 'w-1', sessionId: 's-2' }} cwd="/wt-2" />);
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
    const { rerender } = render(<RoleChip bridge={bridge} role={role} sessionRef={sessionRef} cwd="/project" revision="pid:101:/worktree-old" />);
    await waitFor(() => expect(screen.getByLabelText('Read only')).toBeTruthy());
    readOnly = false;
    rerender(<RoleChip bridge={bridge} role={role} sessionRef={sessionRef} cwd="/project" revision="pid:202:/worktree-new" />);
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
    render(<RoleChip bridge={bridge} role={{ source: 'builtin', name: 'architect' }} sessionRef={{ projectPath: '/project', workId: 'w-1', sessionId: 's-1' }} cwd="/project" />);
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
    const { rerender } = render(<RoleChip bridge={bridge} role={{ source: 'builtin', name: 'architect' }} sessionRef={sessionRef} cwd="/wt-1" />);
    const chip = (): HTMLElement => document.querySelector('[data-role-chip]') as HTMLElement;
    await waitFor(() => expect(chip().title).toBe('Architect · Builtin\nDefine boundaries.'));
    rerender(<RoleChip bridge={bridge} role={{ source: 'builtin', name: 'architect' }} sessionRef={{ ...sessionRef, sessionId: 's-2' }} cwd="/wt-2" />);
    await waitFor(() => expect(bridge.calls.filter(call => call.method === 'roles.list')).toHaveLength(2));
    await waitFor(() => expect(chip().title).toBe('architect · Builtin\nRole unavailable'));
  });
});

describe('общий стор ролей по каталогу', () => {
  const role = { source: 'codex' as const, name: 'review' };
  const sessionRef = (n: number) => ({ projectPath: '/project', workId: 'w-1', sessionId: `s-${n}` });
  const summary = (readOnly: boolean) => ({ id: 'codex:review', name: 'Review', source: 'codex' as const, provider: 'codex', description: 'Native', model: null, effort: null, readOnly });
  const calls = (bridge: ReturnType<typeof createFakeBridge>) => bridge.calls.filter(call => call.method === 'roles.list');

  it('12 чипов одного cwd дают один roles.list', async () => {
    const bridge = createFakeBridge();
    bridge.setHandler('roles.list', async () => ({ roles: [summary(false)], diagnostics: [], partial: false }));
    render(<>{Array.from({ length: 12 }, (_, n) => <RoleChip key={n} bridge={bridge} role={role} sessionRef={sessionRef(n)} cwd="/project" revision={`r${n}`} />)}</>);
    await waitFor(() => expect((document.querySelector('[data-role-chip]') as HTMLElement).title).toBe('Review · Codex\nNative'));
    expect(calls(bridge)).toHaveLength(1);
  });

  it('смена revision после монтирования даёт force и null до ответа; на монтирование force нет', async () => {
    const bridge = createFakeBridge();
    let readOnly = true, release: () => void = () => {};
    bridge.setHandler('roles.list', async () => {
      if (!readOnly) await new Promise<void>(resolve => { release = resolve; });
      return { roles: [summary(readOnly)], diagnostics: [], partial: false };
    });
    const { rerender } = render(<RoleChip bridge={bridge} role={role} sessionRef={sessionRef(1)} cwd="/project" revision="r1" />);
    await waitFor(() => expect(screen.getByLabelText('Read only')).toBeTruthy());
    expect(calls(bridge)).toHaveLength(1);
    readOnly = false;
    rerender(<RoleChip bridge={bridge} role={role} sessionRef={sessionRef(1)} cwd="/project" revision="r2" />);
    await waitFor(() => expect(calls(bridge)).toHaveLength(2));
    expect(screen.queryByLabelText('Read only')).toBeNull();
    expect((document.querySelector('[data-role-chip]') as HTMLElement).title).toContain('Role unavailable');
    release();
    await waitFor(() => expect((document.querySelector('[data-role-chip]') as HTMLElement).title).toBe('Review · Codex\nNative'));
  });

  it('смена revision и cwd перечитывает роли для нового cwd', async () => {
    const bridge = createFakeBridge();
    bridge.setHandler('roles.list', async params => ({ roles: [summary(params.ref?.sessionId === 's-1')], diagnostics: [], partial: false }));
    const { rerender } = render(<RoleChip bridge={bridge} role={role} sessionRef={sessionRef(1)} cwd="/old" revision="r1" />);
    await waitFor(() => expect(screen.getByLabelText('Read only')).toBeTruthy());
    rerender(<RoleChip bridge={bridge} role={role} sessionRef={sessionRef(2)} cwd="/new" revision="r2" />);
    await waitFor(() => expect(calls(bridge)).toHaveLength(2));
    expect(calls(bridge).map(call => (call.params as { ref?: { sessionId: string } }).ref?.sessionId)).toEqual(['s-1', 's-2']);
    await waitFor(() => expect(screen.queryByLabelText('Read only')).toBeNull());
  });

  it('обновление по TTL не прячет прежний замок', async () => {
    const bridge = createFakeBridge();
    let release: () => void = () => {}, hold = false;
    bridge.setHandler('roles.list', async () => {
      if (hold) await new Promise<void>(resolve => { release = resolve; });
      return { roles: [summary(true)], diagnostics: [], partial: false };
    });
    const { unmount } = render(<RoleChip bridge={bridge} role={role} sessionRef={sessionRef(1)} cwd="/project" />);
    await waitFor(() => expect(screen.getByLabelText('Read only')).toBeTruthy());
    unmount();
    // Запись устарела по TTL: новый чип запускает загрузку, а замок прежних ролей остаётся.
    const { useRolesStore } = await import('../store/roles.js');
    useRolesStore.setState(state => ({ byCwd: { ...state.byCwd, '/project': { ...state.byCwd['/project']!, at: 0 } } }));
    hold = true;
    render(<RoleChip bridge={bridge} role={role} sessionRef={sessionRef(2)} cwd="/project" />);
    await waitFor(() => expect(calls(bridge)).toHaveLength(2));
    expect(screen.getByLabelText('Read only')).toBeTruthy();
    release();
  });
});
