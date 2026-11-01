import { describe, expect, it } from 'vitest';
import {
  AUTO_MACHINE_SHARE,
  HUMAN_OVERFLOW,
  QUEUE_ORDER,
  compareQueued,
  launchClassOf,
  machineAdmission,
  machineLimit,
  mergeQueued,
  queuedAhead,
  type Admission,
  type AdmissionInput,
} from './machine-capacity.js';
import { ENGINE, HUMAN, type QueuedLaunch } from './types.js';

const GIB = 2 ** 30;

/** Три момента постановки в очередь: ISO одной длины, строки сравниваются как время. */
const T1 = '2026-10-31T10:00:00.000Z';
const T2 = '2026-10-31T10:05:00.000Z';
const T3 = '2026-10-31T10:10:00.000Z';

/** Запись очереди с умолчаниями; тест портит только то, что проверяет. */
const queued = (patch: Partial<QueuedLaunch> = {}): QueuedLaunch => ({
  class: 'agent',
  mode: 'launch',
  by: 's-07',
  at: T2,
  reason: 'machine-limit',
  live: 18,
  limit: 18,
  ...patch,
});

describe('константы допуска', () => {
  it('сверх потолка человек может превысить его на 2 сессии, авто-потолок — три четверти памяти', () => {
    expect(HUMAN_OVERFLOW).toBe(2);
    expect(AUTO_MACHINE_SHARE).toBe(0.75);
  });

  it('порядок очереди: человек, письмо, агент', () => {
    expect(QUEUE_ORDER).toEqual({ human: 0, mail: 1, agent: 2 });
  });
});

describe('machineLimit', () => {
  it('off: потолка нет', () => {
    expect(machineLimit('off', 24 * GIB)).toBeNull();
  });

  it('auto: три четверти памяти в ГиБ — 24 ГиБ дают 18', () => {
    expect(machineLimit('auto', 24 * GIB)).toBe(18);
  });

  it('auto: округляет к ближайшему, половина вверх', () => {
    expect(machineLimit('auto', 16 * GIB)).toBe(12);
    // 10 ГиБ × 0.75 = 7.5
    expect(machineLimit('auto', 10 * GIB)).toBe(8);
  });

  it('auto: меньше одного не бывает', () => {
    expect(machineLimit('auto', GIB)).toBe(1);
    expect(machineLimit('auto', 0)).toBe(1);
  });

  it('число: как есть, память не смотрится', () => {
    expect(machineLimit(12, 0)).toBe(12);
    expect(machineLimit(128, 24 * GIB)).toBe(128);
  });
});

describe('launchClassOf', () => {
  it.each([
    [undefined, 'human'],
    [HUMAN, 'human'],
    ['wake', 'mail'],
    [ENGINE, 'engine'],
    ['s-07', 'agent'],
    ['auto', 'agent'],
  ] as const)('by %s — класс %s', (by, expected) => {
    expect(launchClassOf(by)).toBe(expected);
  });
});

describe('compareQueued', () => {
  it('человек раньше письма, письмо раньше агента — при любом времени', () => {
    // Старший класс стоит раньше, даже если встал в очередь позже.
    expect(compareQueued({ class: 'human', at: T3 }, { class: 'mail', at: T1 })).toBeLessThan(0);
    expect(compareQueued({ class: 'mail', at: T3 }, { class: 'agent', at: T1 })).toBeLessThan(0);
    expect(compareQueued({ class: 'human', at: T3 }, { class: 'agent', at: T1 })).toBeLessThan(0);
    expect(compareQueued({ class: 'agent', at: T1 }, { class: 'mail', at: T3 })).toBeGreaterThan(0);
    expect(compareQueued({ class: 'mail', at: T1 }, { class: 'human', at: T3 })).toBeGreaterThan(0);
  });

  it('в одном классе раньше тот, у кого at меньше; одинаковые — равны', () => {
    expect(compareQueued({ class: 'agent', at: T1 }, { class: 'agent', at: T2 })).toBeLessThan(0);
    expect(compareQueued({ class: 'agent', at: T2 }, { class: 'agent', at: T1 })).toBeGreaterThan(0);
    expect(compareQueued({ class: 'agent', at: T2 }, { class: 'agent', at: T2 })).toBe(0);
  });

  it('сортирует очередь: классы по порядку, внутри класса по времени', () => {
    const entries = [
      { name: 'agent-1', class: 'agent', at: T1 },
      { name: 'human-2', class: 'human', at: T3 },
      { name: 'mail-1', class: 'mail', at: T2 },
      { name: 'human-1', class: 'human', at: T1 },
      { name: 'agent-2', class: 'agent', at: T2 },
    ] as const;
    expect([...entries].sort(compareQueued).map((entry) => entry.name)).toEqual([
      'human-1',
      'human-2',
      'mail-1',
      'agent-1',
      'agent-2',
    ]);
  });
});

describe('mergeQueued', () => {
  it('прежней записи нет: берётся новая', () => {
    const next = queued();
    expect(mergeQueued(null, next)).toEqual(next);
    expect(mergeQueued(undefined, next)).toEqual(next);
  });

  it('сохраняет более раннее at', () => {
    expect(mergeQueued(queued({ at: T1 }), queued({ at: T3 })).at).toBe(T1);
    // Часы разошлись: новая запись «старше» прежней — берётся она.
    expect(mergeQueued(queued({ at: T3 }), queued({ at: T1 })).at).toBe(T1);
  });

  it('запись человека поверх записи агента берёт class human, mode и by человека', () => {
    const previous = queued({ class: 'agent', mode: 'launch', by: 's-07', at: T1 });
    const next = queued({ class: 'human', mode: 'resume', by: HUMAN, at: T2 });
    expect(mergeQueued(previous, next)).toMatchObject({ class: 'human', mode: 'resume', by: HUMAN, at: T1 });
  });

  it('запись агента поверх записи человека класс не понижает: mode и by остаются человека', () => {
    const previous = queued({ class: 'human', mode: 'resume', by: HUMAN, at: T1 });
    const next = queued({ class: 'agent', mode: 'launch', by: 's-07', at: T2 });
    expect(mergeQueued(previous, next)).toMatchObject({ class: 'human', mode: 'resume', by: HUMAN, at: T1 });
  });

  it('письмо поверх записи агента — class mail; поверх человека — человек', () => {
    const mail = queued({ class: 'mail', mode: 'resume', by: 'wake', at: T2 });
    expect(mergeQueued(queued({ class: 'agent', at: T1 }), mail)).toMatchObject({ class: 'mail', by: 'wake' });
    expect(mergeQueued(queued({ class: 'human', by: HUMAN, at: T1 }), mail)).toMatchObject({
      class: 'human',
      by: HUMAN,
    });
  });

  it('равные классы: mode и by — новой записи', () => {
    const previous = queued({ class: 'agent', mode: 'launch', by: 's-07', at: T1 });
    const next = queued({ class: 'agent', mode: 'resume', by: 's-09', at: T2 });
    expect(mergeQueued(previous, next)).toMatchObject({ class: 'agent', mode: 'resume', by: 's-09', at: T1 });
  });

  it('reason, live и limit — всегда из новой записи', () => {
    const previous = queued({ class: 'human', by: HUMAN, reason: 'machine-limit', live: 18, limit: 18 });
    const next = queued({ class: 'agent', reason: 'memory-critical', live: 7, limit: null });
    expect(mergeQueued(previous, next)).toMatchObject({ reason: 'memory-critical', live: 7, limit: null });
  });

  it('не меняет переданные записи', () => {
    const previous = queued({ class: 'agent', at: T1 });
    const next = queued({ class: 'human', by: HUMAN, at: T2 });
    mergeQueued(previous, next);
    expect(previous).toEqual(queued({ class: 'agent', at: T1 }));
    expect(next).toEqual(queued({ class: 'human', by: HUMAN, at: T2 }));
  });
});

describe('queuedAhead', () => {
  const entries = [
    { key: 's-01', queued: { class: 'human', at: T3 } },
    { key: 's-02', queued: { class: 'mail', at: T2 } },
    { key: 's-03', queued: { class: 'agent', at: T1 } },
    { key: 's-04', queued: { class: 'agent', at: T2 } },
    { key: 's-05', queued: { class: 'agent', at: T3 } },
  ] as const;

  it('считает записи впереди: старший класс и более ранние того же класса', () => {
    // Перед s-04: человек s-01, письмо s-02 и агент s-03, вставший раньше. Позади только s-05.
    expect(queuedAhead(entries, { key: 's-04', class: 'agent', at: T2 })).toBe(3);
  });

  it('не считает себя и записи позади себя', () => {
    expect(queuedAhead(entries, { key: 's-01', class: 'human', at: T3 })).toBe(0);
    expect(queuedAhead(entries, { key: 's-05', class: 'agent', at: T3 })).toBe(4);
  });

  it('запись того же класса и времени, но с другим ключом, впереди не стоит', () => {
    expect(queuedAhead([{ key: 's-02', queued: { class: 'agent', at: T2 } }], { key: 's-09', class: 'agent', at: T2 })).toBe(0);
  });

  it('новый запуск, которого в очереди ещё нет: считаются все, кто стоит перед ним', () => {
    // Агент, вставший позже всех, встаёт за всеми агентами и старшими; человек — впереди всех.
    expect(queuedAhead(entries, { key: 's-09', class: 'agent', at: '2026-10-31T11:00:00.000Z' })).toBe(5);
    expect(queuedAhead(entries, { key: 's-09', class: 'human', at: '2026-10-31T11:00:00.000Z' })).toBe(1);
    expect(queuedAhead(entries, { key: 's-09', class: 'human', at: T1 })).toBe(0);
  });

  it('пустая очередь: впереди никого', () => {
    expect(queuedAhead([], { key: 's-01', class: 'agent', at: T1 })).toBe(0);
  });
});

describe('machineAdmission', () => {
  /** Строка таблицы: поля, которых в ней нет, — давление normal, превышения нет, впереди никого. */
  const input = (patch: Pick<AdmissionInput, 'launchClass' | 'occupied' | 'limit'> & Partial<AdmissionInput>): AdmissionInput => ({
    pressure: 'normal',
    overflowLive: 0,
    ahead: 0,
    ...patch,
  });

  const table: Array<[string, AdmissionInput, Admission]> = [
    ['агент, слот свободен (1/2)', input({ launchClass: 'agent', occupied: 1, limit: 2 }), { kind: 'start' }],
    ['агент, потолок полон (2/2)', input({ launchClass: 'agent', occupied: 2, limit: 2 }), { kind: 'queue', reason: 'machine-limit' }],
    [
      'агент, слотов много, но давление critical',
      input({ launchClass: 'agent', occupied: 0, limit: 18, pressure: 'critical' }),
      { kind: 'queue', reason: 'memory-critical' },
    ],
    ['человек, потолок полон (2/2): сверх потолка', input({ launchClass: 'human', occupied: 2, limit: 2 }), { kind: 'overflow', reason: 'machine-limit' }],
    [
      'человек, потолок полон, сверх потолка уже двое',
      input({ launchClass: 'human', occupied: 2, limit: 2, overflowLive: 2 }),
      { kind: 'queue', reason: 'machine-limit' },
    ],
    [
      'человек, давление critical, сверх потолка один',
      input({ launchClass: 'human', occupied: 0, limit: 18, pressure: 'critical', overflowLive: 1 }),
      { kind: 'overflow', reason: 'memory-critical' },
    ],
    ['движок, потолок давно перейдён и давление critical', input({ launchClass: 'engine', occupied: 99, limit: 2, pressure: 'critical' }), { kind: 'start' }],
    ['агент, потолок выключен (limit null) и давление critical', input({ launchClass: 'agent', occupied: 50, limit: null, pressure: 'critical' }), { kind: 'start' }],
    ['агент, слот свободен, но впереди в очереди один', input({ launchClass: 'agent', occupied: 1, limit: 2, ahead: 1 }), { kind: 'queue', reason: 'machine-limit' }],
    ['человек, слот свободен (1/2)', input({ launchClass: 'human', occupied: 1, limit: 2 }), { kind: 'start' }],
    [
      'человек, слот свободен, но впереди в очереди один: не обгоняет, а встаёт следом',
      input({ launchClass: 'human', occupied: 1, limit: 2, ahead: 1 }),
      { kind: 'queue', reason: 'machine-limit' },
    ],
    [
      'человек, слота нет (2/2) и впереди один: сверх потолка всё равно можно',
      input({ launchClass: 'human', occupied: 2, limit: 2, ahead: 1 }),
      { kind: 'overflow', reason: 'machine-limit' },
    ],
    [
      'человек, давление critical и впереди один: слота нет, сверх потолка можно',
      input({ launchClass: 'human', occupied: 0, limit: 18, pressure: 'critical', ahead: 1 }),
      { kind: 'overflow', reason: 'memory-critical' },
    ],
  ];

  it.each(table)('%s', (_title, given, expected) => {
    expect(machineAdmission(given)).toEqual(expected);
  });

  it('давление warn и unknown не блокируют: пока есть слот, старт', () => {
    expect(machineAdmission(input({ launchClass: 'agent', occupied: 0, limit: 18, pressure: 'warn' }))).toEqual({ kind: 'start' });
    expect(machineAdmission(input({ launchClass: 'agent', occupied: 0, limit: 18, pressure: 'unknown' }))).toEqual({ kind: 'start' });
  });

  it('при полном потолке причина — machine-limit и при warn, и при unknown', () => {
    expect(machineAdmission(input({ launchClass: 'agent', occupied: 2, limit: 2, pressure: 'warn' }))).toEqual({
      kind: 'queue',
      reason: 'machine-limit',
    });
    expect(machineAdmission(input({ launchClass: 'agent', occupied: 2, limit: 2, pressure: 'unknown' }))).toEqual({
      kind: 'queue',
      reason: 'machine-limit',
    });
  });

  it('письмо сверх потолка не уходит: потолок полон — очередь, critical — очередь', () => {
    expect(machineAdmission(input({ launchClass: 'mail', occupied: 2, limit: 2 }))).toEqual({ kind: 'queue', reason: 'machine-limit' });
    expect(machineAdmission(input({ launchClass: 'mail', occupied: 0, limit: 18, pressure: 'critical' }))).toEqual({
      kind: 'queue',
      reason: 'memory-critical',
    });
    expect(machineAdmission(input({ launchClass: 'mail', occupied: 1, limit: 2 }))).toEqual({ kind: 'start' });
  });

  it('человек: сверх потолка, пока таких меньше двух, — граница включительно снизу', () => {
    expect(machineAdmission(input({ launchClass: 'human', occupied: 2, limit: 2, overflowLive: HUMAN_OVERFLOW - 1 }))).toEqual({
      kind: 'overflow',
      reason: 'machine-limit',
    });
    expect(machineAdmission(input({ launchClass: 'human', occupied: 2, limit: 2, overflowLive: HUMAN_OVERFLOW }))).toEqual({
      kind: 'queue',
      reason: 'machine-limit',
    });
  });

  it('занято больше потолка (сверх него уже запускали): агент ждёт', () => {
    expect(machineAdmission(input({ launchClass: 'agent', occupied: 4, limit: 2 }))).toEqual({ kind: 'queue', reason: 'machine-limit' });
  });
});
