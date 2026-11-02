import { describe, expect, it, vi } from 'vitest';
import { createPhoneActionNotifier, phoneActionBody, type PhoneNotificationLike } from './phone-actions.js';

function setup(confirm = true) {
  let t = 1000;
  const shown: Array<{ title: string; body: string; actions: unknown; fire: (e: 'action' | 'close') => void; shownCalls: number }> = [];
  const focusWindow = vi.fn();
  const revoke = vi.fn(async () => undefined);
  const confirmRevoke = vi.fn(async () => confirm);
  const notifier = createPhoneActionNotifier({
    create: (o) => {
      const l: Record<string, () => void> = {};
      const rec = { ...o, shownCalls: 0, fire: (e: 'action' | 'close') => l[e]?.() };
      shown.push(rec);
      const n: PhoneNotificationLike = { show: () => void rec.shownCalls++, close: () => undefined, on: (e, cb) => void (l[e] = cb) };
      return n;
    },
    workTitle: async (r) => (r.workId === 'w-1' ? 'Auth rework' : null),
    deviceName: async (id) => (id === 'AAAAAAAAAAAAAAAAAAAAAA' ? 'Anna iPhone' : null),
    focusWindow,
    confirmRevoke,
    revoke,
    now: () => t,
  });
  return { notifier, shown, focusWindow, revoke, confirmRevoke, advance: (ms: number) => void (t += ms) };
}
const ID = 'AAAAAAAAAAAAAAAAAAAAAA';
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('phone action notifications', () => {
  it('builds the text per kind without agent texts', () => {
    expect(phoneActionBody({ kind: 'trust-folder' }, '/Users/a/proj/')).toBe('Trusted folder proj');
    expect(phoneActionBody({ kind: 'allow-always' }, 'Bash(git *)')).toBe('Allowed always: Bash(git *)');
    expect(phoneActionBody({ kind: 'plan-auto-accept' }, 'secret plan text')).toBe('Approved a plan with auto-accept');
    expect(phoneActionBody({ kind: 'provider-switch' }, 'codex')).toBe('Approved a switch to codex');
    expect(phoneActionBody({ kind: 'session-create' }, 'Work A')).toBe('Started a session in Work A');
  });

  it('shows a notification titled with the device name and a Revoke button', async () => {
    const t = setup();
    t.notifier.handle({ deviceId: 'AAAAAAAAAAAAAAAAAAAAAA', kind: 'plan-auto-accept', target: 'ref' });
    await flush();
    expect(t.shown).toHaveLength(1);
    expect(t.shown[0]).toMatchObject({ title: 'Parley — Anna iPhone', body: 'Approved a plan with auto-accept', shownCalls: 1 });
    expect(t.shown[0]?.actions).toEqual([{ type: 'button', text: 'Revoke this phone' }]);
  });

  it('ignores malformed events', async () => {
    const t = setup();
    t.notifier.handle({ deviceId: 'AAAAAAAAAAAAAAAAAAAAAA', kind: 'nope', target: '' });
    t.notifier.handle(null);
    await flush();
    expect(t.shown).toHaveLength(0);
  });

  it('Revoke action: focuses, confirms, then revokes', async () => {
    const t = setup(true);
    t.notifier.handle({ deviceId: 'AAAAAAAAAAAAAAAAAAAAAA', kind: 'trust-folder', target: '/x/y' });
    await flush();
    t.shown[0]?.fire('action');
    await flush();
    expect(t.focusWindow).toHaveBeenCalled();
    expect(t.confirmRevoke).toHaveBeenCalledWith('Anna iPhone');
    expect(t.revoke).toHaveBeenCalledWith('AAAAAAAAAAAAAAAAAAAAAA');
  });

  it('does not revoke when the confirmation is declined', async () => {
    const t = setup(false);
    t.notifier.handle({ deviceId: 'AAAAAAAAAAAAAAAAAAAAAA', kind: 'trust-folder', target: '/x/y' });
    await flush();
    t.shown[0]?.fire('action');
    await flush();
    expect(t.revoke).not.toHaveBeenCalled();
  });

  it('coalesces a burst per device and kind for 10 s', async () => {
    const t = setup();
    const ev = { deviceId: 'AAAAAAAAAAAAAAAAAAAAAA', kind: 'allow-always', target: 'a' };
    t.notifier.handle(ev);
    t.notifier.handle(ev);
    t.notifier.handle({ ...ev, kind: 'trust-folder' });
    t.notifier.handle({ ...ev, deviceId: 'AAAAAAAAAAAAAAAAAAAAAQ' });
    await flush();
    expect(t.shown).toHaveLength(3);
    t.advance(10_000);
    t.notifier.handle(ev);
    await flush();
    expect(t.shown).toHaveLength(4);
  });

  it('names a session by its work title, and by the folder name only for an unknown work', async () => {
    const t = setup();
    const ref = (workId: string) => ({ projectPath: '/Users/a/proj', workId, sessionId: 's-1' });
    t.notifier.handle({ deviceId: ID, kind: 'session-create', target: ref('w-1') });
    t.notifier.handle({ deviceId: ID, kind: 'allow-always', target: ref('w-2') });
    await flush();
    expect(t.shown.map((n) => n.body)).toEqual(['Started a session in Auth rework', 'Allowed always: proj']);
  });

  it('N4: two folders trusted within 10 s both notify; the same folder twice does not', async () => {
    const t = setup();
    t.notifier.handle({ deviceId: ID, kind: 'trust-folder', target: '/a/one' });
    t.notifier.handle({ deviceId: ID, kind: 'trust-folder', target: '/a/two' });
    t.notifier.handle({ deviceId: ID, kind: 'trust-folder', target: '/a/one' });
    await flush();
    expect(t.shown.map((n) => n.body)).toEqual(['Trusted folder one', 'Trusted folder two']);
  });
});
