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

describe('withTemporary — снимок агента в чужом размере (Фокус ревью этапа C, п. 5)', () => {
  const human: ViewportSpec = { preset: 'laptop', rotated: false, dpr: 2 };
  const area = { width: 900, height: 600 };
  const temp: ViewportSpec = { preset: 'mobile-m', rotated: false, dpr: 1 };
  const own = { width: 375, height: 812 };
  const commandsOf = (spec: ViewportSpec | null, at: { width: number; height: number }) =>
    viewportCommands(spec, at).commands.map((command) => ({ method: command.method, params: command.params }));

  function setup() {
    const sent: Array<{ method: string; params: unknown }> = [];
    const send = vi.fn(async (_id: number, method: string, params?: Record<string, unknown>) => {
      sent.push({ method, params });
      return {};
    });
    return { emulation: createEmulation({ inspector: { send } }), sent };
  }

  it('deviceScaleFactor подменяет DPR команды (экран DPR 2), а current отдаёт прежний spec; без него — dpr из spec', async () => {
    const { emulation, sent } = setup();
    await emulation.withTemporary(7, temp, async () => {
      expect(emulation.current(7)).toBeNull();
    }, 2);
    expect(sent[0]?.params).toMatchObject({ width: 375, height: 812, deviceScaleFactor: 2 });
    sent.length = 0;
    await emulation.withTemporary(7, temp, async () => undefined);
    expect(sent[0]?.params).toMatchObject({ deviceScaleFactor: 1 });
  });

  it('на время снимка — размер агента в масштабе 1 (площадь = его размер), потом — размер и площадь человека', async () => {
    const { emulation, sent } = setup();
    await emulation.set(7, human, area);
    sent.length = 0;
    let during: ViewportSpec | null = null;
    expect(await emulation.withTemporary(7, temp, async () => { during = emulation.current(7); return 'shot'; })).toBe('shot');
    expect(during).toEqual(human);
    expect(emulation.current(7)).toEqual(human);
    expect(sent).toEqual([...commandsOf(temp, own), ...commandsOf(human, area)]);
  });

  it('у человека Fit — после снимка снова Fit', async () => {
    const { emulation, sent } = setup();
    await emulation.withTemporary(7, temp, async () => undefined);
    expect(emulation.current(7)).toBeNull();
    expect(sent.slice(-commandsOf(null, own).length)).toEqual(commandsOf(null, own));
  });

  it('снимок упал — размер человека вернулся, ошибка наружу; человек сменил размер во время снимка — его выбор не затирается', async () => {
    const { emulation } = setup();
    await emulation.set(7, human, area);
    await expect(emulation.withTemporary(7, temp, async () => Promise.reject(new Error('capture failed')))).rejects.toThrow('capture failed');
    expect(emulation.current(7)).toEqual(human);
  });

  it('временный размер не попадает в current', async () => {
    const { emulation } = setup();
    await emulation.set(7, human, area);
    let during: ViewportSpec | null = null;
    await emulation.withTemporary(7, temp, async () => { during = emulation.current(7); });
    expect(during).toEqual(human);
    const { emulation: fit } = setup();
    await fit.withTemporary(7, temp, async () => { during = fit.current(7); });
    expect(during).toBeNull();
  });

  it('set человека во время снимка применяется после возврата и остаётся', async () => {
    const { emulation, sent } = setup();
    await emulation.set(7, human, area);
    sent.length = 0;
    const tablet: ViewportSpec = { preset: 'tablet', rotated: false, dpr: 2 };
    let humanSet: Promise<unknown> = Promise.resolve();
    await emulation.withTemporary(7, temp, async () => {
      humanSet = emulation.set(7, tablet, area);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(emulation.current(7)).toEqual(human);
    });
    await humanSet;
    expect(sent).toEqual([...commandsOf(temp, own), ...commandsOf(human, area), ...commandsOf(tablet, area)]);
    expect(emulation.current(7)).toEqual(tablet);
  });

  it('смена поля во время снимка: после — размер человека с новым полем (scale из нового поля)', async () => {
    const { emulation, sent } = setup();
    await emulation.set(7, human, area);
    sent.length = 0;
    const wide = { width: 1600, height: 1000 };
    let humanSet: Promise<{ scale: number }> = Promise.resolve({ scale: 0 });
    await emulation.withTemporary(7, temp, async () => { humanSet = emulation.set(7, human, wide); });
    expect((await humanSet).scale).toBe(1);
    expect(sent.slice(-3)).toEqual(commandsOf(human, wide));
    expect(emulation.current(7)).toEqual(human);
  });

  it('отказ отладчика при Fit: current остаётся null, следующий снимок в конце снимает эмуляцию', async () => {
    const sent: string[] = [];
    let failing = true;
    const send = vi.fn(async (_id: number, method: string) => {
      sent.push(method);
      if (failing && method === 'Emulation.clearDeviceMetricsOverride') throw new Error('debugger detached');
      return {};
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const emulation = createEmulation({ inspector: { send } });
    await emulation.withTemporary(7, temp, async () => undefined);
    expect(emulation.current(7)).toBeNull();
    failing = false;
    sent.length = 0;
    await emulation.withTemporary(7, temp, async () => undefined);
    expect(sent.slice(-3)).toEqual(['Emulation.clearDeviceMetricsOverride', 'Emulation.setTouchEmulationEnabled', 'Emulation.setUserAgentOverride']);
    expect(emulation.current(7)).toBeNull();
    warn.mockRestore();
  });
});

describe('fitOf (ввод агента, этап D)', () => {
  it('Fit — null; пресет — scale вписывания и mobile пресета', async () => {
    const send = vi.fn(async () => ({}));
    const emulation = createEmulation({ inspector: { send } });
    expect(emulation.fitOf(7)).toBeNull();
    await emulation.set(7, { preset: 'mobile-m', rotated: false, dpr: 2 }, { width: 300, height: 1000 });
    expect(emulation.fitOf(7)).toEqual({ scale: 0.8, mobile: true });
    await emulation.set(7, null, { width: 300, height: 1000 });
    expect(emulation.fitOf(7)).toBeNull();
  });
});
