// packages/desktop/src/main/browser/emulation.test.ts
import { describe, expect, it, vi } from 'vitest';
import { MOBILE_USER_AGENT, type ViewportSpec } from '../../shared/browser-devtools.js';
import { createEmulation, viewportCommands } from './emulation.js';

const MOBILE_M: ViewportSpec = { preset: 'mobile-m', rotated: false, dpr: 2 };
const AREA = { width: 800, height: 600 };

describe('viewportCommands (спека 4.2, спайк 0.3 — механизм cdp)', () => {
  it('Fit — эмуляция, касания и подмена UA сняты; scale 1', () => {
    expect(viewportCommands(null, AREA)).toEqual({
      commands: [
        { method: 'Emulation.clearDeviceMetricsOverride', params: {} },
        { method: 'Emulation.setTouchEmulationEnabled', params: { enabled: false } },
        { method: 'Emulation.setUserAgentOverride', params: { userAgent: '' } },
      ],
      scale: 1,
    });
  });

  it('Mobile M 2x в поле 800×600 — 375×812 со scale по высоте, касания, мобильный UA', () => {
    const scale = 600 / 812;
    expect(viewportCommands(MOBILE_M, AREA)).toEqual({
      commands: [
        { method: 'Emulation.setDeviceMetricsOverride', params: { width: 375, height: 812, deviceScaleFactor: 2, mobile: true, scale } },
        { method: 'Emulation.setTouchEmulationEnabled', params: { enabled: true, maxTouchPoints: 5 } },
        { method: 'Emulation.setUserAgentOverride', params: { userAgent: MOBILE_USER_AGENT } },
      ],
      scale,
    });
  });

  it('Laptop в большом поле — scale 1, без касаний и мобильного UA', () => {
    expect(viewportCommands({ preset: 'laptop', rotated: false, dpr: 1 }, { width: 1600, height: 1000 })).toEqual({
      commands: [
        { method: 'Emulation.setDeviceMetricsOverride', params: { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false, scale: 1 } },
        { method: 'Emulation.setTouchEmulationEnabled', params: { enabled: false } },
        { method: 'Emulation.setUserAgentOverride', params: { userAgent: '' } },
      ],
      scale: 1,
    });
  });

  it('повёрнутый пресет и свой размер — их ширина и высота', () => {
    expect(viewportCommands({ preset: 'mobile-m', rotated: true, dpr: 3 }, { width: 2000, height: 2000 }).commands[0]?.params).toMatchObject({
      width: 812,
      height: 375,
      deviceScaleFactor: 3,
    });
    expect(viewportCommands({ width: 1024, height: 700, mobile: false, dpr: 2 }, { width: 512, height: 700 }).scale).toBe(0.5);
  });

  it('поле нулевое — scale 1, а не 0', () => {
    expect(viewportCommands(MOBILE_M, { width: 0, height: 0 }).scale).toBe(1);
  });

  it('лишние поля размера в команды не попадают', () => {
    const dirty = { preset: 'mobile-m', rotated: false, dpr: 2, userAgent: 'evil', width: 1 } as unknown as ViewportSpec;
    const [metrics] = viewportCommands(dirty, AREA).commands;
    expect(Object.keys(metrics?.params ?? {}).sort()).toEqual(['deviceScaleFactor', 'height', 'mobile', 'scale', 'width']);
  });
});

describe('createEmulation', () => {
  it('set — команды по порядку через инспектор; current — размер вкладки; null — снят', async () => {
    const send = vi.fn<(id: number, method: string, params?: Record<string, unknown>) => Promise<unknown>>(async () => ({}));
    const emulation = createEmulation({ inspector: { send } });
    await expect(emulation.set(7, MOBILE_M, AREA)).resolves.toEqual({ scale: 600 / 812 });
    expect(send.mock.calls.map(([id, method]) => [id, method])).toEqual([
      [7, 'Emulation.setDeviceMetricsOverride'],
      [7, 'Emulation.setTouchEmulationEnabled'],
      [7, 'Emulation.setUserAgentOverride'],
    ]);
    expect(emulation.current(7)).toEqual(MOBILE_M);
    await emulation.set(7, null, AREA);
    expect(emulation.current(7)).toBeNull();
  });

  it('отказ инспектора — отказ set; прежний размер остаётся', async () => {
    const send = vi.fn<(id: number, method: string, params?: Record<string, unknown>) => Promise<unknown>>(async () => ({}));
    const emulation = createEmulation({ inspector: { send } });
    await emulation.set(7, MOBILE_M, AREA);
    send.mockRejectedValueOnce(new Error('capture unavailable: 7'));
    await expect(emulation.set(7, null, AREA)).rejects.toThrow('capture unavailable: 7');
    expect(emulation.current(7)).toEqual(MOBILE_M);
  });

  it('forget: гость уничтожен — размер вкладки забыт, current даёт null; чужие вкладки целы', async () => {
    const send = vi.fn<(id: number, method: string, params?: Record<string, unknown>) => Promise<unknown>>(async () => ({}));
    const emulation = createEmulation({ inspector: { send } });
    await emulation.set(7, MOBILE_M, AREA);
    await emulation.set(8, MOBILE_M, AREA);
    emulation.forget(7);
    expect(emulation.current(7)).toBeNull();
    expect(emulation.current(8)).toEqual(MOBILE_M);
    // Забыть неизвестный id — не ошибка.
    expect(() => emulation.forget(99)).not.toThrow();
  });

  it('current — копия без лишних полей: чужой объект не меняет состояние вкладки', async () => {
    const send = vi.fn<(id: number, method: string, params?: Record<string, unknown>) => Promise<unknown>>(async () => ({}));
    const emulation = createEmulation({ inspector: { send } });
    const incoming = { preset: 'mobile-m', rotated: false, dpr: 2, extra: 'x' } as unknown as ViewportSpec;
    await emulation.set(7, incoming, AREA);
    (incoming as { dpr: number }).dpr = 3;
    expect(emulation.current(7)).toEqual(MOBILE_M);
    expect(emulation.current(7)).not.toBe(incoming);
  });
});
