/**
 * Тексты записанных экспортов и отправленных эффектов планов остаются только в файле и в письме (спека хранилища 6.2):
 * карта хранит путь и sha256.
 */
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeWorkDb, workDb } from './db.js';
import { validDecisionJournalIntent } from './decision-journal.js';
import type { DecisionJournalIntent, DecisionJournalMap } from './decision-journal.js';
import { parseMap } from './map.js';
import { validatePlanEffects } from './plan-effects.js';
import { createWork, readMap, replaceStoredMap, updateMap } from './store.js';
import { compactStoredTexts, effectTextIs, exportSha256 } from './stored-texts.js';
import type { PlanEffect, PlanExportIntent, WorkMap } from './types.js';

const AT = '2026-10-04T01:00:00.000Z';
const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

const PLAN_TEXT = '# Plan pl-01 — revision 0 (accepted)\n\nWork: w-0001; room: r-01\n';
const DECISION_TEXT = '\n# Decision title\n\nAccepted: 2026-10-04T01:00:00.000Z\n';
const LETTER = 'Accepted plan pl-01, revision 0, item 1: Work';

const planExport = (status: 'pending' | 'written', event: PlanExportIntent['event'] = 'accepted'): PlanExportIntent => ({
  file: `w-0001-r-01-pl-01-rev-0-${event}.md`,
  planId: 'pl-01',
  rev: 0,
  event,
  content: PLAN_TEXT,
  status,
});

const decisionExport = (status: 'pending' | 'written'): DecisionJournalIntent => ({
  file: '2026-10-04-w-0001-r-01-p-01-rev-00.md',
  workId: 'w-0001',
  roomId: 'r-01',
  proposalId: 'p-01',
  rev: 0,
  messageId: 'm-01',
  acceptedAt: AT,
  kind: 'decision',
  snapshot: null,
  snapshotSha256: null,
  content: DECISION_TEXT,
  status,
});

/** `occurrence` входит в ключ, поэтому у каждой записи свой: ключи эффектов уникальны. */
const effect = (status: PlanEffect['status'], messageId: string | null, occurrence: string): PlanEffect => ({
  key: `r-01/pl-01/0/1/ready/${occurrence}/s-02`,
  roomId: 'r-01',
  planId: 'pl-01',
  rev: 0,
  item: 1,
  kind: 'ready',
  occurrence,
  target: 's-02',
  text: LETTER,
  createdAt: AT,
  status,
  messageId,
});

function legacyMap(): WorkMap & DecisionJournalMap {
  return {
    schemaVersion: 2,
    work: { id: 'w-0001', title: 'Legacy', goal: '', status: 'active', createdAt: AT, updatedAt: AT },
    sessions: [],
    messages: [],
    rooms: [],
    planExports: [planExport('written'), planExport('pending', 'completed')],
    decisionExports: [decisionExport('written')],
    planEffects: [effect('queued', null, '0'), effect('sent', 'm-01', '1'), effect('cancelled', null, '2')],
  };
}

describe('compactStoredTexts: старый вид карты переводится в сжатый', () => {
  it('записанный экспорт теряет content и получает sha256, bytes и title; ожидающий остаётся с текстом', () => {
    const map = compactStoredTexts(legacyMap());

    expect(map.planExports![0]).toEqual({
      file: 'w-0001-r-01-pl-01-rev-0-accepted.md',
      planId: 'pl-01',
      rev: 0,
      event: 'accepted',
      status: 'written',
      sha256: sha(PLAN_TEXT),
      bytes: Buffer.byteLength(PLAN_TEXT),
      title: 'Plan pl-01 — revision 0 (accepted)',
    });
    expect(map.planExports![1]).toMatchObject({ status: 'pending', content: PLAN_TEXT });
    expect(map.planExports![1]).not.toHaveProperty('sha256');
    const decision = map.decisionExports![0]!;
    expect(decision).not.toHaveProperty('content');
    expect(decision).toMatchObject({ sha256: sha(DECISION_TEXT), bytes: Buffer.byteLength(DECISION_TEXT), title: 'Decision title' });
  });

  it('эффект sent или cancelled меняет text на textSha256, queued держит text', () => {
    const map = compactStoredTexts(legacyMap());

    const [queued, sent, cancelled] = map.planEffects!;
    expect(queued).toMatchObject({ status: 'queued', text: LETTER });
    expect(queued).not.toHaveProperty('textSha256');
    for (const settled of [sent!, cancelled!]) {
      expect(settled).not.toHaveProperty('text');
      expect(settled.textSha256).toBe(sha(LETTER));
    }
  });

  it('возвращает ту же карту и идемпотентна', () => {
    const map = legacyMap();

    const once = compactStoredTexts(map);
    const snapshot = structuredClone(once);

    expect(once).toBe(map);
    expect(compactStoredTexts(once)).toEqual(snapshot);
  });

  it('sha256 готового экспорта и сверка текста эффекта работают и со старым, и с сжатым видом', () => {
    const legacy = legacyMap();
    const before = [exportSha256(legacy.planExports![0]!), effectTextIs(legacy.planEffects![1]!, LETTER)];

    compactStoredTexts(legacy);

    expect(before).toEqual([sha(PLAN_TEXT), true]);
    expect(exportSha256(legacy.planExports![0]!)).toBe(sha(PLAN_TEXT));
    expect(effectTextIs(legacy.planEffects![1]!, LETTER)).toBe(true);
    expect(effectTextIs(legacy.planEffects![1]!, `${LETTER}!`)).toBe(false);
  });
});

describe('разбор карты: старый вид переводится при чтении', () => {
  it('parseMap отдаёт сжатые экспорты и эффекты старой карты', () => {
    const map = parseMap(JSON.stringify(legacyMap()), 'fixture');

    expect(map.planExports![0]).toMatchObject({ status: 'written', sha256: sha(PLAN_TEXT) });
    expect(map.planExports![0]).not.toHaveProperty('content');
    expect(map.planExports![1]).toMatchObject({ status: 'pending', content: PLAN_TEXT });
    expect((map as DecisionJournalMap).decisionExports![0]).toMatchObject({ sha256: sha(DECISION_TEXT) });
    expect(map.planEffects!.map((row) => row.textSha256 ?? null)).toEqual([null, sha(LETTER), sha(LETTER)]);
  });

  it('сжатая карта проходит разбор без изменений', () => {
    const compact = parseMap(JSON.stringify(legacyMap()), 'fixture');

    expect(parseMap(JSON.stringify(compact), 'fixture')).toEqual(compact);
  });

  it('записанный экспорт без текста и без sha256, а также эффект sent без текста и sha256 карту не проходят', () => {
    const noDigest = legacyMap();
    delete noDigest.planExports![0]!.content;
    expect(() => parseMap(JSON.stringify(noDigest), 'fixture')).toThrow('invalid snapshot intent');

    const noText = legacyMap();
    delete noText.planEffects![1]!.text;
    expect(() => parseMap(JSON.stringify(noText), 'fixture')).toThrow('invalid plan effect');
    expect(() => validatePlanEffects(noText)).toThrow('invalid plan effect');
  });

  it('ожидающий экспорт без текста карту не проходит: текст нужен, чтобы повторить запись файла', () => {
    const map = legacyMap();
    map.planExports = [{ ...compactStoredTexts(legacyMap()).planExports![0]!, status: 'pending' }];

    expect(() => parseMap(JSON.stringify(map), 'fixture')).toThrow('invalid snapshot intent');
  });
});

describe('validDecisionJournalIntent: сжатый вид', () => {
  const compact = (): DecisionJournalIntent => compactStoredTexts({ ...legacyMap(), planExports: [] } as WorkMap).decisionExports![0]!;

  it('принимает записанное решение без текста', () => {
    expect(validDecisionJournalIntent(compact())).toBe(true);
  });

  it('отвергает записанное без sha256 и ожидающее без текста', () => {
    expect(validDecisionJournalIntent({ ...compact(), sha256: undefined })).toBe(false);
    expect(validDecisionJournalIntent({ ...compact(), sha256: 'abc' })).toBe(false);
    expect(validDecisionJournalIntent({ ...compact(), status: 'pending' })).toBe(false);
  });
});

describe('база с прежним видом строк: тексты уходят при чтении, а строки — при первой записи', () => {
  let home = '';
  let project = '';

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), 'parley-stored-texts-'));
    project = path.join(home, 'project');
    process.env.PARLEY_HOME = path.join(home, 'home');
  });

  afterEach(async () => {
    closeWorkDb();
    delete process.env.PARLEY_HOME;
    await rm(home, { recursive: true, force: true });
  });

  /** Строки одного вида, как они лежат в базе. */
  const rows = (workId: string, kind: string): Record<string, unknown>[] =>
    workDb()
      .prepare('SELECT json FROM entries WHERE work_id = ? AND kind = ? ORDER BY ord')
      .all(workId, kind)
      .map((row) => JSON.parse(String(row['json'])) as Record<string, unknown>);
  /** Статусы строк, в которых ещё лежит текст. */
  const withText = (workId: string, kind: string, field: 'content' | 'text'): unknown[] =>
    rows(workId, kind).filter((row) => field in row).map((row) => row['status']);

  it('readMap отдаёт сжатую карту, а первая запись переписывает строки без текстов', async () => {
    const { work } = await createWork(project, { title: 'Legacy' });
    const legacy = legacyMap();
    legacy.work = { ...legacy.work, id: work.id };
    legacy.decisionExports = legacy.decisionExports!.map((row) => ({ ...row, workId: work.id, file: row.file.replace('w-0001', work.id) }));
    replaceStoredMap(project, work.id, legacy);
    // Строки прежней сборки: тексты записанного и отправленного лежат в них.
    expect(withText(work.id, 'planExport', 'content')).toEqual(['written', 'pending']);
    expect(withText(work.id, 'decisionExport', 'content')).toEqual(['written']);
    expect(withText(work.id, 'planEffect', 'text')).toEqual(['queued', 'sent', 'cancelled']);

    const read = await readMap(project, work.id);
    expect(read.planExports![0]).toMatchObject({ status: 'written', sha256: sha(PLAN_TEXT) });
    expect(read.planExports![0]).not.toHaveProperty('content');
    expect(read.planEffects!.map((row) => row.textSha256 ?? null)).toEqual([null, sha(LETTER), sha(LETTER)]);

    await updateMap(project, work.id, () => undefined);

    // Ожидающий экспорт и эффект в очереди сохранили текст: по нему файл пишется и письмо уходит.
    expect(withText(work.id, 'planExport', 'content')).toEqual(['pending']);
    expect(withText(work.id, 'decisionExport', 'content')).toEqual([]);
    expect(withText(work.id, 'planEffect', 'text')).toEqual(['queued']);
  });
});
