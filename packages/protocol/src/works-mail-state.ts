import { z } from 'zod';
import type { MapCompactMail, Message } from '@parley/core';
import type { WorksSyncWorkKey } from './works-sync.js';

/** Отдельный ремонт писем: эти страницы никогда не передаются WorksSyncReducer. */
export type WorksMailStateField = 'mailRooms' | 'unreadRooms' | 'mentionCandidates';
export type WorksMailStateRecord =
  | { kind: 'mail-summary'; key: WorksSyncWorkKey; unreadLetters: number }
  | { kind: 'section'; key: WorksSyncWorkKey; field: WorksMailStateField; start: number; items: unknown[]; final: boolean }
  | { kind: 'section-fragment'; key: WorksSyncWorkKey; field: WorksMailStateField; element: number; index: number; text: string; final: boolean };
export interface WorksMailStateIdentity {
  epoch: string;
  key: WorksSyncWorkKey;
  /** Версия согласованного чтения писем, не глобальная структурная ревизия. */
  sourceVersion: number;
  /** Доказанная достижимая версия структуры этой работы; неизвестное покрытие требует refresh/retry. */
  requiredStructuralVersion: number;
}
export interface WorksMailStatePage extends WorksMailStateIdentity {
  kind: 'mail-page';
  index: number;
  cursor: string;
  next: string | null;
  records: WorksMailStateRecord[];
  commit: boolean;
}
export type WorksMailStateFailureReason = 'busy' | 'retry' | 'not-found' | 'cursor-expired' | 'cursor-unknown' | 'cursor-client' | 'cursor-work';
export type WorksMailStateResult = WorksMailStatePage | { kind: 'mail-unavailable'; reason: WorksMailStateFailureReason };
export interface WorksMailState extends WorksMailStateIdentity {
  mail: Pick<MapCompactMail, 'rooms' | 'unread' | 'mentionCandidates'>;
}

const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const keySchema = z.strictObject({ projectPath: z.string().min(1), workId: z.string().min(1) });
export const worksMailStateRequest = keySchema.extend({ cursor: z.string().min(1).max(512).optional() }).strict();
const fieldSchema = z.enum(['mailRooms', 'unreadRooms', 'mentionCandidates']);
const recordSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('mail-summary'), key: keySchema, unreadLetters: count }),
  z.strictObject({ kind: z.literal('section'), key: keySchema, field: fieldSchema, start: count, items: z.array(z.unknown()), final: z.boolean() }),
  z.strictObject({ kind: z.literal('section-fragment'), key: keySchema, field: fieldSchema, element: count, index: count, text: z.string(), final: z.boolean() }),
]);
const pageSchema = z.strictObject({ kind: z.literal('mail-page'), epoch: z.string().min(1), key: keySchema, sourceVersion: count, requiredStructuralVersion: count, index: count, cursor: z.string().min(1).max(512), next: z.string().min(1).max(512).nullable(), records: z.array(recordSchema), commit: z.boolean() });
const metadataSchema = z.strictObject({ total: count, top: count, lastAt: z.string().nullable(), unread: count, decision: z.enum(['accepted', 'returned']).nullable() });
const roomSchema = z.strictObject({ roomId: z.string(), metadata: metadataSchema });
const unreadSchema = z.strictObject({ roomId: z.string(), count });
const mentionSchema = z.strictObject({
  id: z.string().regex(/^m-\d+$/), roomId: z.string().nullable(), from: z.string(), to: z.array(z.string()), at: z.string(), text: z.string(),
  kind: z.enum(['note', 'question', 'decision']), readBy: z.record(z.string(), z.string()), replyTo: z.string().optional(),
  via: z.enum(['assistant', 'telegram']).optional(), deleted: z.boolean().optional(), textBytes: count.optional(),
});

interface Section {
  values: Map<number, unknown>;
  fragments: Map<number, { next: number; parts: string[] }>;
  covered: Set<number>;
  maxEnd: number;
  length?: number;
}
interface Stage extends WorksMailStateIdentity {
  index: number;
  cursor: string;
  summary?: number;
  sections: Map<WorksMailStateField, Section>;
  rooms: Map<string, MapCompactMail['rooms'][string]>;
  unread: Map<string, number>;
  mentions: Set<string>;
}
const sameKey = (a: WorksSyncWorkKey, b: WorksSyncWorkKey): boolean => a.projectPath === b.projectPath && a.workId === b.workId;
function freeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}
export type WorksMailStateApplied = { state: 'staged' } | { state: 'committed'; value: WorksMailState } | { state: 'rejected'; reason: string };

/**
 * Один экземпляр на одну выборку. До финала не публикует значения; отказ отбрасывает всю staging.
 * Проверка покрытия линейная: индекс резервируется один раз; продолжения фрагмента не сканируют
 * прошлые элементы/куски. Только завершённый элемент разбирается и проверяется по своей схеме.
 * Сравнение с held mail/committed structure, epoch и lifetime после await остаётся обязанностью P6.
 */
export class WorksMailStateAssembler {
  private stage: Stage | undefined;
  private finished = false;
  private committed?: WorksMailState;
  constructor(private readonly expected: { epoch: string; key: WorksSyncWorkKey }) {}
  get value(): WorksMailState | undefined { return this.committed; }
  applyPage(input: unknown): WorksMailStateApplied {
    try {
      if (this.finished) throw new Error('mail transaction already finished');
      const page = pageSchema.parse(input);
      if (page.epoch !== this.expected.epoch || !sameKey(page.key, this.expected.key)) throw new Error('mail identity differs from requested work/epoch');
      if (page.requiredStructuralVersion > page.sourceVersion || page.commit !== (page.next === null)) throw new Error('mail dependency/completion invalid');
      let s = this.stage;
      if (s === undefined) {
        if (page.index !== 0) throw new Error('mail page prefix missing');
        s = { epoch: page.epoch, key: page.key, sourceVersion: page.sourceVersion, requiredStructuralVersion: page.requiredStructuralVersion, index: 0, cursor: page.cursor, sections: new Map(), rooms: new Map(), unread: new Map(), mentions: new Set() };
        this.stage = s;
      }
      if (page.index !== s.index || page.cursor !== s.cursor || page.epoch !== s.epoch || !sameKey(page.key, s.key) || page.sourceVersion !== s.sourceVersion || page.requiredStructuralVersion !== s.requiredStructuralVersion) throw new Error('mail page sequence/identity changed');
      for (const r of page.records) {
        if (!sameKey(r.key, s.key)) throw new Error('mail record key changed');
        if (r.kind === 'mail-summary') {
          if (s.summary !== undefined) throw new Error('duplicate mail summary');
          s.summary = r.unreadLetters; continue;
        }
        let section = s.sections.get(r.field);
        if (section === undefined) { section = { values: new Map(), fragments: new Map(), covered: new Set(), maxEnd: 0 }; s.sections.set(r.field, section); }
        if (section.length !== undefined) throw new Error('mail section already complete');
        if (r.kind === 'section') {
          if (!Number.isSafeInteger(r.start + r.items.length)) throw new Error('mail section index overflow');
          for (let at = 0; at < r.items.length; at += 1) {
            const index = r.start + at;
            this.reserve(section, index);
            this.element(s, section, r.field, index, r.items[at]);
          }
          if (r.final) {
            const length = r.start + r.items.length;
            if (section.fragments.size !== 0 || section.maxEnd > length || section.covered.size !== length) throw new Error('mail section gap/incomplete fragment');
            section.length = length;
          }
        } else {
          let fragment = section.fragments.get(r.element);
          if (fragment === undefined) {
            if (r.index !== 0) throw new Error('mail fragment prefix missing');
            this.reserve(section, r.element);
            fragment = { next: 0, parts: [] }; section.fragments.set(r.element, fragment);
          }
          if (r.index !== fragment.next) throw new Error('mail fragment sequence changed');
          fragment.parts.push(r.text); fragment.next += 1;
          if (r.final) {
            this.element(s, section, r.field, r.element, JSON.parse(fragment.parts.join('')));
            section.fragments.delete(r.element);
          }
        }
      }
      s.index += 1; s.cursor = page.next ?? '';
      if (!page.commit) return { state: 'staged' };
      if (s.summary === undefined || s.sections.size !== 3 || [...s.sections.values()].some(section => section.length === undefined)) throw new Error('mail replacement incomplete');
      const section = s.sections.get('mentionCandidates')!;
      const mentions: Message[] = [];
      let previous = -1;
      for (let i = 0; i < section.length!; i += 1) {
        const message = section.values.get(i) as Message;
        const seq = Number(message.id.slice(2));
        if (!Number.isSafeInteger(seq) || seq <= previous) throw new Error('mail candidates not canonical');
        previous = seq; mentions.push(message);
      }
      this.committed = freeze({ epoch: s.epoch, key: { ...s.key }, sourceVersion: s.sourceVersion, requiredStructuralVersion: s.requiredStructuralVersion, mail: { rooms: Object.fromEntries(s.rooms), unread: { letters: s.summary, rooms: Object.fromEntries(s.unread) }, mentionCandidates: mentions } });
      this.stage = undefined; this.finished = true;
      return { state: 'committed', value: this.committed };
    } catch (error) {
      this.stage = undefined; this.finished = true;
      return { state: 'rejected', reason: error instanceof Error ? error.message : 'invalid mail page' };
    }
  }
  private reserve(section: Section, index: number): void {
    if (section.covered.has(index)) throw new Error('mail section overlap');
    section.covered.add(index); section.maxEnd = Math.max(section.maxEnd, index + 1);
  }
  private element(s: Stage, section: Section, field: WorksMailStateField, index: number, value: unknown): void {
    if (field === 'mailRooms') {
      const row = roomSchema.parse(value);
      if (s.rooms.has(row.roomId)) throw new Error('duplicate mail room');
      s.rooms.set(row.roomId, row.metadata); section.values.set(index, row);
    } else if (field === 'unreadRooms') {
      const row = unreadSchema.parse(value);
      if (s.unread.has(row.roomId)) throw new Error('duplicate unread key');
      s.unread.set(row.roomId, row.count); section.values.set(index, row);
    } else {
      const message = mentionSchema.parse(value);
      // Тот же предел канонического хвоста, что WINDOW_UNREAD_MAX в core; runtime import core запрещён.
      if (s.mentions.has(message.id) || s.mentions.size >= 200) throw new Error('duplicate/excess mail candidate');
      s.mentions.add(message.id); section.values.set(index, message);
    }
  }
}
