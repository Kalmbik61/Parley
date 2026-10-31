import { describe, expect, it } from 'vitest';
import { memoryStore } from './memory-store';
import { LocalSettings, displayName } from './local-settings';

describe('LocalSettings', () => {
  it('requires Face ID by default and keeps the switch', async () => {
    const s = new LocalSettings(memoryStore());
    expect(await s.requireBiometric()).toBe(true);
    await s.setRequireBiometric(false);
    expect(await s.requireBiometric()).toBe(false);
  });

  it('renames a Mac only for this phone and forgets it on removal', async () => {
    const s = new LocalSettings(memoryStore());
    await s.setHostName('h1', '  Studio  ');
    const names = await s.hostNames();
    expect(displayName({ hostId: 'h1', hostName: 'Evgeniy’s Mac' }, names)).toBe('Studio');
    await s.setHostName('h1', '');
    expect(displayName({ hostId: 'h1', hostName: 'Evgeniy’s Mac' }, await s.hostNames())).toBe('Evgeniy’s Mac');
    await s.setHostName('h1', 'X');
    await s.setCurrentHostId('h1');
    await s.forgetHost('h1');
    expect(await s.hostNames()).toEqual({});
    expect(await s.currentHostId()).toBeNull();
  });

  it('survives a corrupt blob and parallel writes', async () => {
    const store = memoryStore();
    store.data.set('parley.settings', '{nope');
    const s = new LocalSettings(store);
    expect(await s.requireBiometric()).toBe(true);
    await Promise.all([s.setHostName('a', 'A'), s.setHostName('b', 'B'), s.setNotificationsEnabled(false)]);
    expect(await s.hostNames()).toEqual({ a: 'A', b: 'B' });
    expect(await s.notificationsEnabled()).toBe(false);
  });
});
