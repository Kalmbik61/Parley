import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetIo } from '../../test/io-spy.js';
import { appendMessage, journalFile, readCursorFile } from './journal.js';
import { addSession } from './map.js';
import { capturePlanNotice, reservePlanEffects } from './plan-effects.js';
import { reconcileRoomPlans, setRoomMode } from './plans.js';
import { addRoom, archiveRoom, reopenRoom } from './rooms.js';
import { createWork, readMap, updateMap, workPaths } from './store.js';
import { HUMAN, PARLEY } from './types.js';

/**
 * Мутаторы `updateMap` на карте-журнале (v3) не читают журналы целиком, чтобы ответить на ограниченный вопрос: чтение
 * `map.messages` внутри мутатора собирает ВСЕ журналы синхронно, под `map.lock`. Шпион (`test/io-spy.ts`) считает
 * прочитанные байты через `node:fs/promises` и синхронный `node:fs`, поэтому «не читал» здесь — это число байт.
 */

const io = vi.hoisted(() => ({ opened: [] as string[], writes: [] as string[], bytes: {} as Record<string, number> }));
vi.mock('node:fs/promises', async (original) => (await import('../../test/io-spy.js')).spyFsPromises(await original<typeof import('node:fs/promises')>(), io));
vi.mock('node:fs', async (original) => (await import('../../test/io-spy.js')).spyFs(await original<typeof import('node:fs')>(), io));

let home = '';
let project = '';
let workId = '';
const sizes = new Map<string | null, number>();

const paths = () => workPaths(project, workId);
const file = (roomId: string | null): string => journalFile(paths(), roomId);
const read = (roomId: string | null): number => io.bytes[file(roomId)] ?? 0;
/** Журнал прочитан не целиком: меньше половины его размера (хвост приёмника — 16 КБ при журнале в сотни КБ). */
const notWhole = (roomId: string | null): void => expect(read(roomId), `журнал ${roomId ?? 'direct'}`).toBeLessThan(sizes.get(roomId)! / 2);

/** Журнал в `count` писем по ~230 байт; считается шпионом, поэтому тест обнуляет счётчики после. */
async function fill(roomId: string | null, count: number, from = 's-01'): Promise<void> {
  // Письма пятичасовой давности: окно бюджета (час) кончается раньше хвоста, и чтение с конца останавливается на нём.
  const base = Date.now() - 5 * 3600_000;
  for (let i = 1; i <= count; i += 1) await appendMessage(project, workId, roomId, { from, to: [], text: `${i} ${'я'.repeat(100)}`, at: new Date(base + i * 1000).toISOString() });
  sizes.set(roomId, (await stat(file(roomId))).size);
}

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'parley-home-'));
  project = await mkdtemp(path.join(tmpdir(), 'parley-project-'));
  process.env.PARLEY_HOME = home;
  workId = (await createWork(project, { title: 'мутаторы' })).work.id;
  await updateMap(project, workId, (map) => {
    for (const label of ['a', 'b', 'c']) addSession(map, { provider: 'claude', label, task: 't' });
    for (const session of map.sessions) session.lifecycle = 'active';
    addRoom(map, { title: 'one', creator: 's-01', members: ['s-02', 's-03'], lead: 's-01' });
    addRoom(map, { title: 'two', creator: 's-01', members: ['s-02'], lead: 's-01' });
  });
  const raw = JSON.parse(await readFile(paths().map, 'utf8')) as Record<string, unknown>;
  raw['schemaVersion'] = 3;
  delete raw['messages'];
  delete raw['decisionExports'];
  await writeFile(paths().map, JSON.stringify(raw, null, 2));
  sizes.clear();
});

afterEach(async () => {
  delete process.env.PARLEY_HOME;
  await Promise.all([home, project].map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('план: черновик правки не копирует письма', () => {
  it('reconcileRoomPlans и setRoomMode (оба правят карту через черновик) не читают журналы; setRoomMode отдаёт письмо', async () => {
    await Promise.all([fill('r-01', 600), fill('r-02', 600), fill(null, 600)]);
    resetIo(io);
    let returned: { id: string; roomId: string | null } | undefined;
    await updateMap(project, workId, (map) => {
      reconcileRoomPlans(map);
      returned = setRoomMode(map, 'r-01', HUMAN, 'checklist', 'нужен порядок');
    });
    // Счётчики снимаются до `readMap`: он сам собирает все журналы.
    notWhole('r-01');
    expect(read('r-02')).toBe(0);
    expect(read(null)).toBe(0);
    expect(returned).toMatchObject({ roomId: 'r-01', id: expect.stringMatching(/^m-r01-601$/) });
    expect((await readMap(project, workId)).rooms.find((room) => room.id === 'r-01')?.mode).toBe('checklist');
  });
});

describe('plan-effects на карте-журнале', () => {
  it('capturePlanNotice находит письмо-источник среди добавленных в этом мутаторе, не читая журналы', async () => {
    await Promise.all([fill('r-01', 600), fill('r-02', 600), fill(null, 600)]);
    resetIo(io);
    await updateMap(project, workId, (map) => {
      const source = setRoomMode(map, 'r-01', HUMAN, 'checklist', 'порядок')!;
      capturePlanNotice(map, 'r-01', 'mode', source.id);
    });
    const index = JSON.parse(await readFile(paths().map, 'utf8')) as { planEffects?: { occurrence: string; status: string }[] };
    expect(index.planEffects?.map((effect) => [effect.occurrence, effect.status])).toEqual([['m-r01-601', 'queued']]);
    notWhole('r-01');
    expect(read('r-02')).toBe(0);
    expect(read(null)).toBe(0);
  });

  /** Режим комнаты сменён, уведомление ведущему поставлено в очередь, но не отправлено; в журнале после него ещё письма. */
  async function queuedNotice(): Promise<void> {
    await Promise.all([fill('r-01', 600), fill('r-02', 600), fill(null, 600)]);
    await updateMap(project, workId, (map) => {
      const source = setRoomMode(map, 'r-01', HUMAN, 'checklist', 'порядок')!;
      capturePlanNotice(map, 'r-01', 'mode', source.id);
    });
    for (let i = 0; i < 5; i += 1) await appendMessage(project, workId, 'r-01', { from: 's-02', to: [], text: `после ${i}` });
    sizes.set('r-01', (await stat(file('r-01'))).size);
  }

  it('reservePlanEffects проверяет письмо-источник по id в хвосте журнала, а не собирая карту', async () => {
    await queuedNotice();
    resetIo(io);
    await updateMap(project, workId, (map) => void reservePlanEffects(map, 30));
    const index = JSON.parse(await readFile(paths().map, 'utf8')) as { planEffects?: { status: string; messageId: string | null }[] };
    // Эффект признан действующим (источник найден) и доставлен письмом ведущему.
    expect(index.planEffects?.map((effect) => effect.status)).toEqual(['sent']);
    expect(index.planEffects?.[0]?.messageId).toMatch(/^m-r01-\d+$/);
    notWhole('r-01');
    notWhole('r-02');
    notWhole(null);
  });

  const statuses = async (): Promise<string[]> =>
    ((JSON.parse(await readFile(paths().map, 'utf8')) as { planEffects?: { status: string }[] }).planEffects ?? []).map((effect) => effect.status);

  it('бюджет: свежее письмо Parley в чужом (прямом) журнале занимает место в часе, эффект остаётся в очереди', async () => {
    await queuedNotice();
    await appendMessage(project, workId, null, { from: PARLEY, to: ['s-02'], text: 'недавнее' });
    sizes.set(null, (await stat(file(null))).size);
    resetIo(io);
    await updateMap(project, workId, (map) => void reservePlanEffects(map, 1));
    expect(await statuses()).toEqual(['queued']);
    notWhole('r-01');
    notWhole('r-02');
    notWhole(null);
  });

  it('бюджет: письмо Parley старше часа место не занимает, эффект уходит', async () => {
    await queuedNotice();
    await appendMessage(project, workId, null, { from: PARLEY, to: ['s-02'], text: 'давнее', at: new Date(Date.now() - 2 * 3600_000).toISOString() });
    await appendMessage(project, workId, 'r-02', { from: 's-02', to: [], text: 'после давнего, не от Parley' });
    resetIo(io);
    await updateMap(project, workId, (map) => void reservePlanEffects(map, 1));
    expect(await statuses()).toEqual(['sent']);
  });
});

describe('reopenRoom на карте-журнале', () => {
  it('читает журнал только возвращаемой комнаты (ему нужны все её письма) и не трогает чужие журналы', async () => {
    await Promise.all([fill('r-01', 600), fill('r-02', 600), fill(null, 600)]);
    await appendMessage(project, workId, 'r-01', { from: 's-01', to: ['s-02'], text: 'адресное' });
    await updateMap(project, workId, (map) => void archiveRoom(map, 'r-01'));
    resetIo(io);
    await updateMap(project, workId, (map) => reopenRoom(map, 'r-01'));
    // Участники прочли всё, что лежало в комнате до возврата.
    const cursors = await readCursorFile(project, workId, 's-02');
    expect(cursors['r-01']).toEqual([[1, expect.any(Number)]]);
    expect(read('r-02')).toBe(0);
    expect(read(null)).toBe(0);
  });
});
