import { describe, expect, it } from 'vitest';
import { createFakeBridge } from './fake-bridge.js';

describe('fake-bridge: files и openPath (кусок 5.2)', () => {
  it('files.locate — null на каждый путь по умолчанию, ответы по сеттеру, журнал locateCalls', async () => {
    const bridge = createFakeBridge();
    const root = { workKey: 'k', spec: { kind: 'project' as const } };
    expect(await bridge.files.locate('k', ['/a', '/b'])).toEqual([null, null]);
    bridge.setLocated('k', '/b', { root, relPath: 'b', stat: { kind: 'file', size: 1, mtimeMs: 0 } });
    expect((await bridge.files.locate('k', ['/a', '/b']))[1]?.relPath).toBe('b');
    expect(await bridge.files.locate('other', ['/b'])).toEqual([null]);
    expect(bridge.locateCalls).toHaveLength(3);
    expect(await bridge.files.stat(root, ['x'])).toEqual([null]);
  });

  it('app.openPath — opened по умолчанию, журналы openedPaths и revealedPaths', async () => {
    const bridge = createFakeBridge();
    expect(await bridge.app.openPath('/a.txt')).toBe('opened');
    bridge.setOpenPathResult('revealed');
    expect(await bridge.app.openPath('/b.command')).toBe('revealed');
    await bridge.app.showInFinder('/c');
    expect(bridge.openedPaths).toEqual(['/a.txt', '/b.command']);
    expect(bridge.revealedPaths).toEqual(['/c']);
  });
});
