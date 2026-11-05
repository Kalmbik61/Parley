import { readFileSync } from 'node:fs';
import { dirname, resolve as pathResolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  BUSY_DELAY_MS,
  BUSY_HOLD_MS,
  PAL,
  SCENARIOS,
  STATES,
  nameOf,
  needsFrameLoop,
  resolve,
  simulate,
  type OrbParams,
} from './orb-spec';

// Эталон — orb-states.json handoff, сгенерированный из того же orb-spec.js.
interface Json {
  palettes: Record<string, unknown>;
  states: Record<string, { variants: Record<string, OrbParams> }>;
  scenarios: {
    id: string;
    end: number;
    events: { t: number; to: string; cap: string }[];
    shown: unknown[];
    rules: unknown[];
  }[];
}
const json = JSON.parse(
  readFileSync(
    pathResolve(
      dirname(fileURLToPath(import.meta.url)),
      '../../../../../docs/design/2026-11-03-jarvis-handoff/orb-states.json',
    ),
    'utf8',
  ),
) as Json;

describe('orb-spec: параметры', () => {
  it('в спецификации 10 состояний, номера ведут к именам', () => {
    expect(STATES).toHaveLength(10);
    expect(Object.keys(json.states).sort()).toEqual(STATES.map((s) => s.id).sort());
    expect(nameOf('06')).toBe('speaking');
    expect(nameOf('10')).toBe('offline');
  });

  it('палитры совпадают с orb-states.json', () => {
    expect(PAL).toEqual(json.palettes);
  });

  for (const s of STATES) {
    it(`${s.n} ${s.id}: параметры для 168, 32 и reduced motion совпадают с эталоном`, () => {
      const v = json.states[s.id]!.variants;
      expect(resolve(s.id, {})).toEqual(v['168 px']);
      expect(resolve(s.id, { mini: true })).toEqual(v['32 px']);
      // В эталоне reduced-вариант «формирует» снят с карточкой (точки статичны).
      expect(resolve(s.id, { reduced: true, card: s.id === 'forming' })).toEqual(
        v['Reduced motion · 168 px'],
      );
      expect(resolve(s.id, { mini: true, reduced: true })).toEqual(v['Reduced motion · 32 px']);
    });

    it(`${s.n} ${s.id}: reduced motion без бесконечных циклов`, () => {
      for (const mini of [false, true]) {
        const c = resolve(s.id, { mini, reduced: true, voice: true, card: true });
        expect([c.fB, c.aB, c.fD, c.aD, c.fR, c.aP, c.aL]).toEqual([0, 0, 0, 0, 0, 0, 0]);
        expect(c.level).toBeNull();
        expect(c.ramp).toBe(0);
        expect(c.xf).toBeLessThanOrEqual(100);
        expect(c.ring === null || c.ring.mode === 'static').toBe(true);
        expect(c.arc === null || 'still' in c.arc).toBe(true);
        expect(c.sector === null || 'still' in c.sector).toBe(true);
        expect(c.dots === null || 'still' in c.dots).toBe(true);
      }
    });
  }

  it('«формирует» с карточкой совпадает с эталоном «собираю карточку»', () => {
    expect(resolve('forming', { card: true })).toEqual(
      json.states.forming!.variants['168 px · «собираю карточку»'],
    );
  });
});

describe('orb-spec: simulate()', () => {
  it('задержки 150 и 400 мс', () => {
    expect([BUSY_DELAY_MS, BUSY_HOLD_MS]).toEqual([150, 400]);
  });

  for (const sc of SCENARIOS) {
    it(`сценарий ${sc.id} совпадает с эталоном (полосы и правила)`, () => {
      const ref = json.scenarios.find((x) => x.id === sc.id)!;
      expect(sc.events).toEqual(ref.events.map(({ t, to, cap }) => ({ t, to, cap })));
      const r = simulate(sc);
      expect(
        r.bands.map((b) => ({ state: b.state, caption: b.caption, from: b.from, to: b.to })),
      ).toEqual(ref.shown);
      expect(r.notes).toEqual(ref.rules);
    });
  }

  it('занятое состояние появляется через 150 мс, быстрый ответ не мелькает', () => {
    const r = simulate({
      id: 'x',
      end: 2000,
      events: [
        { t: 0, to: 'idle', cap: '' },
        { t: 500, to: 'thinking', cap: '' },
        { t: 600, to: 'idle', cap: '' },
      ],
    });
    expect(r.bands.some((b) => b.state === 'thinking')).toBe(false);
  });

  it('правдивые события показываются сразу', () => {
    const r = simulate({
      id: 'x',
      end: 3000,
      events: [
        { t: 0, to: 'working', cap: '' },
        { t: 100, to: 'awaiting', cap: '' },
      ],
    });
    expect(r.bands.map((b) => [b.state, b.from])).toEqual([
      ['working', 0],
      ['awaiting', 100],
    ]);
  });
});

describe('orb-spec: needsFrameLoop()', () => {
  it('reduced motion: цикл не нужен ни в одном состоянии', () => {
    for (const s of STATES) {
      for (const mini of [false, true]) {
        expect(
          needsFrameLoop(resolve(s.id, { mini, reduced: true, voice: true, card: true }), true),
        ).toBe(false);
      }
    }
  });

  it('покой 168 px крутит цикл, покой 32 px и состояния без движения на 32 px нет', () => {
    expect(needsFrameLoop(resolve('idle'), false)).toBe(true);
    for (const id of ['idle', 'awaiting', 'error', 'offline', 'speaking', 'recording'] as const) {
      expect(needsFrameLoop(resolve(id, { mini: true }), false)).toBe(false);
    }
  });

  it('громкость включает цикл только когда она подана', () => {
    expect(needsFrameLoop(resolve('speaking', { mini: true }), false)).toBe(false);
    expect(needsFrameLoop(resolve('speaking', { mini: true }), true)).toBe(true);
  });

  it('на 32 px циклы остаются там, где их задаёт спецификация (вращение, кольцо, дуга, сектор)', () => {
    for (const id of ['thinking', 'listening', 'working', 'forming'] as const) {
      expect(needsFrameLoop(resolve(id, { mini: true }), false)).toBe(true);
    }
  });
});
