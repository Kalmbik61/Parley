import { describe, expect, it } from 'vitest';
import type { SwitchOptions } from '@parley/remote-client';
import { commandToast, confirmOf, menuItems, type MenuFacts } from './session-menu';
import { canContinue, carryChoices, defaultTarget, keepsLines, newRequestId, switchParams, switchToast, targetNote } from './switch-model';

const ALL = ['feed.interrupt', 'sessions.stop', 'sessions.close', 'sessions.switchOptions', 'sessions.switchAgent', 'sessions.resume', 'pty.send'];
const base: MenuFacts = { methods: ALL, lifecycle: 'active', working: false, teamAgents: 0, inRoom: false };
const ids = (f: Partial<MenuFacts>): string[] => menuItems({ ...base, ...f }).map((i) => i.id);

describe('menuItems', () => {
  it('working session: Stop, Put to sleep, Continue, Copy, Close — in D1 order, with Team and Open room first', () => {
    expect(ids({ working: true, teamAgents: 3, inRoom: true })).toEqual(['team', 'room', 'stop', 'sleep', 'switch', 'copy', 'close']);
  });
  it('idle session has no Stop; sleeping has Resume and no Stop / Put to sleep', () => {
    expect(ids({})).toEqual(['sleep', 'switch', 'copy', 'close']);
    expect(ids({ lifecycle: 'sleeping' })).toEqual(['resume', 'switch', 'copy', 'close']);
  });
  it('closed session: only Copy; "Open work" is gone', () => {
    expect(ids({ lifecycle: 'closed', teamAgents: 2 })).toEqual(['team', 'copy']);
    expect(menuItems(base).some((i) => i.title === 'Open work')).toBe(false);
  });
  it('an item appears only when its method is in the hello', () => {
    expect(ids({ methods: [], working: true })).toEqual(['copy']);
    expect(ids({ methods: null })).toEqual(['copy']);
    expect(ids({ methods: ['sessions.switchOptions'], working: true })).toEqual(['copy']);
    expect(ids({ methods: ['feed.interrupt', 'sessions.close'], working: true })).toEqual(['stop', 'copy', 'close']);
    expect(menuItems(base).find((i) => i.id === 'close')?.destructive).toBe(true);
  });
});

describe('confirms and toasts', () => {
  it('Put to sleep and Close ask in the D1 words', () => {
    expect(confirmOf('sleep', 'Greta')).toEqual({ title: 'Put "Greta" to sleep?', message: 'The agent stops. Resume wakes it with its conversation.', button: 'Put to sleep' });
    expect(confirmOf('close', 'Greta')).toEqual({ title: 'Close "Greta"?', message: 'It will no longer receive mail.', button: 'Close session' });
  });
  it('done word, host text, or "couldn\'t confirm"', () => {
    expect(commandToast('stop', { outcome: 'ok' })).toBe('Stopped');
    expect(commandToast('sleep', { outcome: 'rejected', code: 'conflict', message: 'session is not running' })).toBe('session is not running');
    expect(commandToast('close', { outcome: 'rejected', code: 'conflict', message: ' ' })).toBe('conflict');
    expect(commandToast('close', { outcome: 'lost' })).toBe("We couldn't confirm it — check your Mac");
  });
});

const opts = (over: Partial<SwitchOptions> = {}): SwitchOptions => ({
  current: { provider: 'claude', available: true, reason: null },
  targets: [
    { id: 'claude', label: 'Claude', family: null, available: false, needs: 'Usage limit until 14:30', limits: null, transcript: false },
    { id: 'codex', label: 'Codex', family: null, available: true, needs: null, limits: null, transcript: true },
  ],
  suggested: 'claude',
  keeps: { rooms: 1, leads: ['Greta'], owns: [], children: 2, unread: 0, worktree: null },
  blockers: [],
  ...over,
});

describe('switch sheet rules', () => {
  it('default target is the suggestion if available, else the first available', () => {
    expect(defaultTarget(opts())).toBe('codex');
    expect(defaultTarget(opts({ suggested: 'codex' }))).toBe('codex');
    expect(defaultTarget(opts({ targets: [], suggested: null }))).toBeNull();
  });
  it('blockers or an unavailable target: no button', () => {
    const o = opts();
    expect(canContinue(o, o.targets[1])).toBe(true);
    expect(canContinue(o, o.targets[0])).toBe(false);
    expect(canContinue({ ...o, blockers: ['The agent is mid-turn'] }, o.targets[1])).toBe(false);
  });
  it('transcript only where the target has it; params carry a new requestId and never force', () => {
    const o = opts();
    expect(carryChoices(o.targets[0])).toEqual(['handover']);
    expect(carryChoices(o.targets[1])).toEqual(['handover', 'transcript']);
    const ref = { projectPath: '/p', workId: 'w', sessionId: 's' };
    const id = newRequestId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(switchParams(ref, id, o.targets[1]!, 'transcript')).toEqual({ ref, requestId: id, provider: 'codex', carry: 'transcript' });
    expect(switchParams(ref, id, o.targets[0]!, 'transcript').carry).toBe('handover');
    expect(Object.keys(switchParams(ref, id, o.targets[1]!, 'handover'))).not.toContain('force');
  });
  it('keeps and target notes show only what exists', () => {
    expect(keepsLines(opts().keeps)).toEqual(['1 room', 'Leads Greta', '2 child sessions']);
    expect(targetNote(opts().targets[0]!)).toBe('Usage limit until 14:30');
    expect(targetNote({ ...opts().targets[1]!, limits: { fiveHour: { usedPercent: 40 }, week: { usedPercent: 12 } } as never })).toBe('5 h 40% · week 12%');
  });
  it('held and queued read like a launch; refusals show the host text', () => {
    const t = opts().targets[1]!;
    expect(switchToast({ outcome: 'started', carried: 'handover' }, t)).toBe('Continuing on Codex');
    expect(switchToast({ outcome: 'held', carried: 'handover' }, t)).toBe('Waiting for your answer — see the request on this session');
    expect(switchToast({ outcome: 'queued', carried: 'handover' }, t)).toBe('Queued — starts when a slot frees on your Mac');
    expect(switchToast({ outcome: 'rejected', code: 'conflict', message: 'Stop the agent first' }, t)).toBe('Stop the agent first');
  });
});
