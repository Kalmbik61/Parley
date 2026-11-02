import { z } from 'zod';
import type { WindowWorkEntry, Work } from '@parley/core';
import type { WorksSnapshot } from './types.js';

// Ограниченная синхронизация снимка работ (спека 2026-11-01 «Bounded window synchronisation»): вместо
// одного глобального снимка >5 МиБ хост отдаёт пагинированные reset/delta-транзакции, а чистый редьюсер
// собирает их в закоммиченный вид — один и тот же в главном процессе окна, renderer и на острове.
// Модуль browser-safe: только чистый TypeScript и zod, никаких API Node.

/**
 * Возможность клиента в `hello.features`: он умеет `works.sync` и событие `works.invalidated`. Клиент
 * без неё получает прежний путь `works.list`/`works.changed`; признак ничего не активирует на стороне
 * хоста до интеграционной задачи.
 */
export const WORKS_SYNC_FEATURE = 'works-sync';

/** Планируемый кандидат бюджета страницы (дизайн, «Prepared wire and cache contract»): полный кадр, включая конверт. */
export const WORKS_SYNC_PAGE_BYTES = 512 * 1024;
/** Запасные 128 КиБ допустимы только после такого же проверенного принятия P7; константа — не разрешение их включить. */
export const WORKS_SYNC_PAGE_BYTES_FALLBACK = 128 * 1024;
/** Одна незавершённая выборка `works.sync` на соединение: вытягивание и IPC с обратным давлением. */
export const WORKS_SYNC_INFLIGHT = 1;
/** Цель кооперативного планирования сборки/кодирования, мс: не жёсткая граница. */
export const WORKS_SYNC_SLICE_MS = 4;
/** Простой закреплённого курсора до уборки, мс; прогресс страницы его обновляет. */
export const WORKS_SYNC_PIN_IDLE_MS = 30_000;
/** Видимое отставание: нет прогресса страниц (bootstrap) или нет коммита при wanted > applied, мс. */
export const WORKS_SYNC_STALE_MS = 2_000;
/** Кэш готовых страниц поверх логической карты, не лимит самой карты. */
export const WORKS_SYNC_ENCODED_CACHE_BYTES = 4 * 1024 * 1024;
/** Журнал структурных ревизий: не больше столько коммитов… */
export const WORKS_SYNC_JOURNAL_COMMITS = 256;
/** …и столько байт метаданных; переполнение подвигает пол reset, а не отказ. */
export const WORKS_SYNC_JOURNAL_BYTES = 4 * 1024 * 1024;

/** Ключ работы: в ключ входит путь проекта — два «w-01» в разных проектах это разные работы. */
export interface WorksSyncWorkKey {
  projectPath: string;
  workId: string;
}

/**
 * Записи страницы. Адрес строки — поле карты плюс (у именованных коллекций) стабильный id сущности;
 * исполняемых JSON-путей нет нигде. Неизвестные поля будущих карт едут теми же записями (значение или
 * секция) и переживают смену схемы.
 */
export type WorksSyncRecord =
  /** Метаданные работы: upsert; архив — не удаление. `version` — версия строки работы-источника для почтовых шлюзов, отдельная от структурной ревизии синхронизации. */
  | { kind: 'work'; key: WorksSyncWorkKey; work: Work; version?: number }
  /** Строка именованной коллекции (`sessions`, `rooms`, `plans`…) с id или значение одиночного поля (`compact`, `resources`, неизвестное будущее поле-объект). */
  | { kind: 'row'; key: WorksSyncWorkKey; field: string; id?: string; row: unknown }
  /** Удаление строки именованной коллекции: надгробие; ревизию удаления держит хост. */
  | { kind: 'row-remove'; key: WorksSyncWorkKey; field: string; id: string }
  /** Удаление поля целиком (present → absent): собственное свойство уходит из карты. Записи того же поля позже в транзакции создают его заново. */
  | { kind: 'field-remove'; key: WorksSyncWorkKey; field: string }
  /** Полный вектор порядка именованной коллекции: без изменений не шлётся; строки вне вектора отбрасываются. */
  | { kind: 'order'; key: WorksSyncWorkKey; field: string; order: string[] }
  /** Ограниченный срез порядка; final задаёт точную длину. Нельзя смешивать с целым order. */
  | { kind: 'order-slice'; key: WorksSyncWorkKey; field: string; start: number; ids: string[]; final: boolean }
  /** Секция без стабильных id (`deletedSessions`, будущие списки): замена по индексам, `final` закрывает пересылку. */
  | { kind: 'section'; key: WorksSyncWorkKey; field: string; start: number; items: unknown[]; final: boolean }
  /** JSON-фрагмент одного элемента секции. final завершает элемент; секцию отдельно закрывает section(final). */
  | { kind: 'section-fragment'; key: WorksSyncWorkKey; field: string; element: number; index: number; text: string; final: boolean }
  /** Удаление работы целиком. */
  | { kind: 'work-remove'; key: WorksSyncWorkKey }
  /** Ветка проекта в `branches`: значение, включая `null` (нет ветки). */
  | { kind: 'branch'; projectPath: string; branch: string | null }
  /** Ключ проекта ушёл из `branches` (проекта больше нет). */
  | { kind: 'branch-remove'; projectPath: string }
  /** Кусок строки, не влезающей в страницу: JSON-текст, UTF-8-безопасные границы режет хост; `final` — последний кусок. Адрес `field: 'work'` без id — фрагментация самих метаданных работы: сборка даёт целый `Work`, без фабрикации и обрезания; `version` на таком адресе — версия строки работы-источника для почтовых шлюзов, все куски одного адреса несут её согласованно (или согласованно не несут). */
  | { kind: 'fragment'; key: WorksSyncWorkKey; field: string; id?: string; index: number; text: string; final: boolean; version?: number };

/** Идентичность транзакции: режим, эпоха процесса хоста и границы структурных ревизий. */
export interface WorksSyncTransaction {
  mode: 'reset' | 'delta';
  /** Эпоха процесса хоста: reset переключает эпоху клиента, delta обязана совпасть с ней. */
  epoch: string;
  /** Структурная ревизия клиента, от которой собрана транзакция. */
  base: number;
  /** Целевая структурная ревизия: коммит переводит вид точно на неё. */
  target: number;
}

/** Страница транзакции `works.sync`. Курсоры opaque и привязаны к клиенту: чужой курсор хост не обслуживает. */
export interface WorksSyncPage {
  kind: 'page';
  transaction: WorksSyncTransaction;
  /** Номер страницы транзакции с нуля: транзакцию открывает только страница 0, пропущенный префикс отвергается. */
  index: number;
  /** Курсор этой страницы: клиент шлёт его следующим запросом. */
  cursor: string;
  /** Курсор следующей страницы; `null` у коммитной. */
  next: string | null;
  records: WorksSyncRecord[];
  /** Коммитная страница: применить транзакцию атомарно; несёт эпоху и целевую ревизию транзакции. */
  commit: boolean;
}

/** Почему хост требует reset вместо страницы. */
export type WorksSyncResetReason =
  /** Эпоха хоста сменилась — закрепления прошлой эпохи недействительны. */
  | 'epoch'
  /** База клиента ниже пола журнала ревизий или из другой эпохи. */
  | 'base'
  /** Курсор не известен хосту. */
  | 'cursor-unknown'
  /** Курсор выдан другому клиенту. */
  | 'cursor-client'
  /** Курсор истёк по простою (`WORKS_SYNC_PIN_IDLE_MS`). */
  | 'cursor-expired';

/** Типизированный ремонт: клиент сохраняет прежний вид видимым устаревшим и начинает новую пагинацию. */
export interface WorksSyncResetRequired {
  kind: 'reset-required';
  reason: WorksSyncResetReason;
}

/** Ответ `works.sync`: страница транзакции или типизированное требование reset. */
export type WorksSyncResult = WorksSyncPage | WorksSyncResetRequired;

/** Событие `works.invalidated`: объявление более новой структурной версии. Почтовые изменения его не порождают. */
export interface WorksSyncInvalidated {
  epoch: string;
  revision: number;
}

/**
 * Запрос `works.sync`: либо `cursor` продолжения открытой транзакции, либо `base` — применённая
 * структурная ревизия клиента, с которой начать новую. Одновременно их слать нельзя.
 */
export const worksSyncRequest = z
  .strictObject({
    cursor: z.string().min(1).max(512).optional(),
    base: z.number().int().min(0).optional(),
  })
  .refine((value) => (value.cursor !== undefined) !== (value.base !== undefined));

// ─── Внутренний контракт поверхностей (заморожен P1; реализуют P4/P5/P6) ───
//
// Главный процесс окна владеет вытягиванием `works.sync` и пересылает те же ограниченные записи
// поверхностям; глобальный structured clone снимка на каждое изменение запрещён. Поздний
// renderer/остров получает согласованную reset-последовательность пачек, затем дельты. Эпоха и
// ревизия проходят через каждую границу: пачка несёт транзакцию, статус — applied/wanted, roots —
// только закоммиченное. Никакая поверхность не изобретает собственных форм: типы ниже единственные.

/** Пачка записей, пересланная renderer-процессу и острову: та же транзакция, разрезанная по байтам IPC. */
export interface WorksSyncSurfaceBatch {
  kind: 'works-sync-batch';
  transaction: WorksSyncTransaction;
  /** Номер пачки поверхности по порядку от начала транзакции; позднее присоединение начинается с 0. */
  index: number;
  records: WorksSyncRecord[];
  /** `true` только на последней пачке: поверхности применяют транзакцию атомарно тем же редьюсером. */
  commit: boolean;
}

/**
 * Видимое состояние поверхности. `loading` — до первого полного bootstrap, прогресс по страницам и
 * строкам; готовность — полный согласованный bootstrap, а не «пришла первая страница». `catching-up` —
 * после полного bootstrap известна более новая ревизия (wanted > applied). `stale` — нет прогресса
 * страниц (`WORKS_SYNC_STALE_MS`, bootstrap) или нет коммита при wanted > applied (после bootstrap);
 * непрерывные успешные коммиты баннер не перезапускают. `error` — ремонт: прежние данные сохранены,
 * у ошибки заявлено право на повтор.
 */
export type WorksSyncSurfaceStatus =
  | { state: 'loading'; epoch: string | null; wanted: number; applied: number; pages: number; rows: number }
  | { state: 'current'; epoch: string; applied: number }
  | { state: 'catching-up'; epoch: string; wanted: number; applied: number }
  | { state: 'stale'; epoch: string | null; wanted: number; applied: number; reason: 'no-page-progress' | 'no-commit' }
  | { state: 'error'; epoch: string | null; applied: number; error: 'reset-required' | 'epoch' | 'connection' | 'protocol'; retryable: boolean };

/**
 * Вход адаптера roots (P5): только закоммиченный вид. Частичный bootstrap, stale и неудавшийся
 * ремонт корень выдать не могут; пересчитываются корни только изменённых работ, закоммиченное
 * удаление отзывает корень немедленно. `complete` — сам закоммиченный снимок для сверки.
 */
export interface WorksSyncRootsChange {
  epoch: string;
  revision: number;
  changed: WorksSyncWorkKey[];
  deleted: WorksSyncWorkKey[];
  complete: WorksSnapshot;
}

// ─── Чистый поэтапный редьюсер ───

/** Закоммиченный вид: эпоха, структурная ревизия и сам снимок (`WorksSnapshot`). */
export interface WorksSyncView {
  epoch: string | null;
  revision: number;
  snapshot: WorksSnapshot;
}

/** Итог коммита: затронутые и удалённые работы (ключи с путём проекта). */
export interface WorksSyncCommitInfo {
  epoch: string;
  revision: number;
  affected: WorksSyncWorkKey[];
  deleted: WorksSyncWorkKey[];
}

/** Отказ: причина и необходимость ремонта (новой bootstrap-выборки). */
export type WorksSyncRejectReason =
  /** Эпоха транзакции не совпадает с эпохой вида. */
  | 'epoch'
  /** База дельты не равна применённой ревизии (или вид пуст — нужен reset). */
  | 'base'
  /** Разрыв цепочки курсоров или страница чужой транзакции. */
  | 'sequence'
  /** Повтор индекса фрагмента, два значения одного адреса, кусок после закрывающего. */
  | 'conflict'
  /** Транзакция неполна: нет метаданных работы, не хватает фрагмента или куска секции, секция без `final`, неизвестная строка в векторе порядка. */
  | 'incomplete'
  /** Небезопасное имя поля/id или некорректный ключ. */
  | 'key'
  /** Нарушение формы страницы, записи или транзакции. */
  | 'protocol';

export type WorksSyncApplyOutcome =
  | { state: 'staged'; transaction: WorksSyncTransaction; pages: number }
  | { state: 'committed'; commit: WorksSyncCommitInfo }
  | { state: 'rejected'; reason: WorksSyncRejectReason; repair: true };

interface IndexedSlices<T> { slices: Map<number, T[]>; length: number | null; covered: Set<number>; maxEnd: number }
interface ElementFragments { byIndex: Map<number, string>; finalIndex: number | null }
interface RowsStaging {
  kind: 'rows';
  rows: Map<string, unknown>;
  removed: Set<string>;
  order?: string[];
  orderSlices?: IndexedSlices<string> & { ids: Set<string> };
}
interface SectionStaging extends IndexedSlices<unknown> {
  kind: 'section';
  elements: Map<number, ElementFragments>;
}

/** Стадия поля карты: строки, одиночное значение или индексированная секция. */
type FieldStaging = RowsStaging | { kind: 'value'; value: unknown } | SectionStaging;

interface StagedWork {
  key: WorksSyncWorkKey;
  meta: { work: Work; version: number | undefined } | null;
  fields: Map<string, FieldStaging>;
  /** Сборка фрагментов по адресу `field\0id`; `version` — согласованный канал версии источника (null — явно без версии). */
  fragments: Map<string, { field: string; id: string | undefined; byIndex: Map<number, string>; finalIndex: number | null; version: number | null | undefined }>;
  /** Поля, удалённые записью `field-remove` в этой транзакции. */
  fragmentFields: Set<string>;
  removedFields: Set<string>;
  removed: boolean;
}

interface Staged {
  transaction: WorksSyncTransaction;
  /** Ожидаемый курсор следующей страницы; открывается курсором первой. */
  nextCursor: string;
  appliedCursors: Set<string>;
  pages: number;
  works: Map<string, StagedWork>;
  branches: Map<string, string | null>;
  removedBranches: Set<string>;
}

const workKeyString = (key: WorksSyncWorkKey): string => `${key.projectPath}\u0000${key.workId}`;
const fieldKeyString = (field: string, id: string | undefined): string => `${field}\u0000${id ?? ''}`;

/** Имена, через которые нельзя назначать свойства объекта: прототипное заражение. */
const UNSAFE_NAMES = new Set(['__proto__', 'constructor', 'prototype']);
/**
 * Зарезервированные поля карты: `work` — метаданные (записи `work` и фрагменты `field: 'work'`), а не
 * обычное поле; `schemaVersion` фиксирована. Грубые записи с такими полями — ошибка протокола.
 */
const RESERVED_FIELDS = new Set(['work', 'schemaVersion']);

function safeToken(value: string, max: number): boolean {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !value.includes('\0') && !UNSAFE_NAMES.has(value);
}

/** Общая классификация хоста/main: id-подобные данные вне адресного контракта остаются элементами секции. */
export function worksSyncNamedRows(items: readonly unknown[]): items is readonly { id: string }[] {
  if (items.length === 0) return false;
  const seen = new Set<string>();
  for (const item of items) {
    if (typeof item !== 'object' || item === null || !Object.hasOwn(item, 'id')) return false;
    const id = (item as { id?: unknown }).id;
    if (typeof id !== 'string' || !safeToken(id, 128) || seen.has(id)) return false;
    seen.add(id);
  }
  return true;
}

function validRange(start: number, count: number): boolean {
  return Number.isSafeInteger(start) && start >= 0 && Number.isSafeInteger(start + count);
}

/** Проверяется только входящий ограниченный диапазон, а не все ранее принятые срезы. */
function reserveSlice<T>(sliced: IndexedSlices<T>, start: number, count: number): boolean {
  if (sliced.slices.has(start)) return false;
  for (let index = start; index < start + count; index += 1) {
    if (sliced.covered.has(index) || sliced.slices.has(index)) return false;
  }
  // Пустой маркер внутри уже занятого диапазона также конфликтует.
  if (count === 0 && sliced.covered.has(start)) return false;
  for (let index = start; index < start + count; index += 1) sliced.covered.add(index);
  sliced.maxEnd = Math.max(sliced.maxEnd, start + count);
  return true;
}

/** Непрерывное покрытие и точная финальная длина; пустой финальный маркер допустим. */
function completeSlices<T>(sliced: IndexedSlices<T>): boolean {
  if (sliced.length === null) return false;
  let expected = 0;
  for (const start of [...sliced.slices.keys()].sort((a, b) => a - b)) {
    if (start !== expected) return false;
    expected += sliced.slices.get(start)!.length;
  }
  return expected === sliced.length;
}

function validWorkKey(key: WorksSyncWorkKey): boolean {
  return typeof key === 'object' && key !== null && safeToken(key.projectPath, 32768) && safeToken(key.workId, 128);
}

function validTransaction(transaction: WorksSyncTransaction): boolean {
  if (typeof transaction !== 'object' || transaction === null) return false;
  if (transaction.mode !== 'reset' && transaction.mode !== 'delta') return false;
  return (
    typeof transaction.epoch === 'string' && transaction.epoch.length > 0 && transaction.epoch.length <= 256 &&
    Number.isInteger(transaction.base) && transaction.base >= 0 &&
    Number.isInteger(transaction.target) && transaction.target >= transaction.base
  );
}

function sameTransaction(a: WorksSyncTransaction, b: WorksSyncTransaction): boolean {
  return a.mode === b.mode && a.epoch === b.epoch && a.base === b.base && a.target === b.target;
}

/** Сигнал неполноты из сборки порядка: неизвестная строка во векторе. */
class WorksSyncIncompleteError extends Error {}

/**
 * Чистый поэтапный редьюсер `works.sync`: стадии страниц не трогают закоммиченный вид, коммитная
 * страница применяет транзакцию атомарно — либо весь новый снимок, либо прежний вид без изменений.
 * Неизменённые записи и строки сохраняют ссылки; reset не стирает старые данные до готовой замены.
 * Один редьюсер — один потребитель (соединение, renderer, остров); никакого общего состояния.
 */
export class WorksSyncReducer {
  private viewState: WorksSyncView;
  private staged: Staged | null = null;
  private lastCommit: { transaction: WorksSyncTransaction; commit: WorksSyncCommitInfo } | null = null;

  constructor(initial?: WorksSyncView) {
    this.viewState = initial ?? { epoch: null, revision: 0, snapshot: { entries: [], branches: {} } };
  }

  /** Закоммиченный вид; объект снимка меняется только коммитом и целиком. */
  get view(): WorksSyncView {
    return this.viewState;
  }

  /** Открытая транзакция или `null`. */
  get pending(): WorksSyncTransaction | null {
    return this.staged === null ? null : { ...this.staged.transaction };
  }

  /** Сбросить незакрытую транзакцию без применения: вид остаётся прежним (ремонт, уход соединения). */
  abandon(): void {
    this.staged = null;
  }

  /** Применить страницу: стадия, коммит или атомарный отказ с ремонтом. */
  applyPage(page: WorksSyncPage): WorksSyncApplyOutcome {
    if (page === null || typeof page !== 'object' || page.kind !== 'page' || !validTransaction(page.transaction)) {
      return this.reject('protocol');
    }
    if (typeof page.commit !== 'boolean' || !Number.isInteger(page.index) || page.index < 0) return this.reject('protocol');
    if (typeof page.cursor !== 'string' || page.cursor.length === 0 || page.cursor.length > 512) return this.reject('protocol');
    if (page.commit) {
      if (page.next !== null) return this.reject('protocol');
    } else if (typeof page.next !== 'string' || page.next.length === 0 || page.next.length > 512) {
      return this.reject('protocol');
    }
    if (!Array.isArray(page.records)) return this.reject('protocol');

    if (this.staged === null) {
      // Повторно присланный коммит уже применённой транзакции — идемпотентный ответ тем же исходом.
      if (page.commit && this.lastCommit !== null && sameTransaction(this.lastCommit.transaction, page.transaction)) {
        const { commit } = this.lastCommit;
        return { state: 'committed', commit: { ...commit, affected: [...commit.affected], deleted: [...commit.deleted] } };
      }
      if (page.transaction.mode === 'delta') {
        // Дельта требует полного bootstrap той же эпохи и точной базы; иначе ремонт через reset.
        // Пустой вид — «не с чего дельтить» (`base`), чужая эпоха — `epoch`.
        if (this.viewState.epoch === null) return this.reject('base');
        if (page.transaction.epoch !== this.viewState.epoch) return this.reject('epoch');
        if (page.transaction.base !== this.viewState.revision) return this.reject('base');
      }
      // Транзакцию открывает только её первая страница: коммит без префикса отвергается, прежний вид цел.
      if (page.index !== 0) return this.reject('sequence');
      this.staged = {
        transaction: { ...page.transaction },
        nextCursor: page.cursor,
        appliedCursors: new Set(),
        pages: 0,
        works: new Map(),
        branches: new Map(),
        removedBranches: new Set(),
      };
    } else {
      if (!sameTransaction(this.staged.transaction, page.transaction)) return this.reject('sequence');
      if (this.staged.appliedCursors.has(page.cursor)) {
        return { state: 'staged', transaction: { ...this.staged.transaction }, pages: this.staged.pages };
      }
      if (page.cursor !== this.staged.nextCursor) return this.reject('sequence');
      // Страницы нумеруются подряд: дыра означает потерянную страницу, а не «начать с середины».
      if (page.index !== this.staged.pages) return this.reject('sequence');
    }
    const staged = this.staged;

    for (const record of page.records) {
      const error = WorksSyncReducer.stageRecord(staged, record);
      if (error !== null) return this.reject(error);
    }
    staged.appliedCursors.add(page.cursor);
    staged.nextCursor = page.next as string;
    staged.pages += 1;
    if (!page.commit) return { state: 'staged', transaction: { ...staged.transaction }, pages: staged.pages };
    return this.commitStaged(staged);
  }

  /** Отказ: открытая транзакция сбрасывается, вид нетронут; всегда с ремонтом. */
  private reject(reason: WorksSyncRejectReason): WorksSyncApplyOutcome {
    this.staged = null;
    return { state: 'rejected', reason, repair: true };
  }

  private static stagedWork(staged: Staged, key: WorksSyncWorkKey): StagedWork {
    const id = workKeyString(key);
    let work = staged.works.get(id);
    if (work === undefined) {
      work = { key: { projectPath: key.projectPath, workId: key.workId }, meta: null, fields: new Map(), fragments: new Map(), fragmentFields: new Set(), removedFields: new Set(), removed: false };
      staged.works.set(id, work);
    }
    return work;
  }

  /** Стадия строк именованной коллекции; смешение видов одного поля — конфликт. */
  private static rowsStaging(work: StagedWork, field: string): RowsStaging | 'conflict' {
    const staging = work.fields.get(field);
    if (staging === undefined) {
      const created: FieldStaging = { kind: 'rows', rows: new Map(), removed: new Set() };
      work.fields.set(field, created);
      return created;
    }
    return staging.kind === 'rows' ? staging : 'conflict';
  }

  private static sectionStaging(work: StagedWork, field: string): SectionStaging | 'conflict' {
    if (work.fragmentFields.has(field)) return 'conflict';
    const existing = work.fields.get(field);
    if (existing !== undefined) return existing.kind === 'section' ? existing : 'conflict';
    const created: SectionStaging = { kind: 'section', slices: new Map(), length: null, covered: new Set(), maxEnd: 0, elements: new Map() };
    work.fields.set(field, created);
    return created;
  }

  /** Стадия одиночного значения; повторная прямая запись того же поля перезаписывает стадию. Фрагмент того же адреса — конфликт. */
  private static valueStaging(work: StagedWork, field: string, value: unknown): WorksSyncRejectReason | null {
    if (work.fragments.has(fieldKeyString(field, undefined))) return 'conflict';
    const staging = work.fields.get(field);
    if (staging === undefined) {
      work.fields.set(field, { kind: 'value', value });
      return null;
    }
    if (staging.kind !== 'value') return 'conflict';
    staging.value = value;
    return null;
  }

  /** Стадия одной записи; возвращает причину отказа или `null`. */
  private static stageRecord(staged: Staged, record: WorksSyncRecord): WorksSyncRejectReason | null {
    if (record === null || typeof record !== 'object' || typeof (record as { kind?: unknown }).kind !== 'string') return 'protocol';
    switch (record.kind) {
      case 'work': {
        if (!validWorkKey(record.key)) return 'key';
        if (typeof record.work !== 'object' || record.work === null || (record.work as { id?: unknown }).id !== record.key.workId) return 'protocol';
        if (record.version !== undefined && (!Number.isInteger(record.version) || record.version < 0)) return 'protocol';
        const work = WorksSyncReducer.stagedWork(staged, record.key);
        if (work.removed) return 'conflict';
        // Метаданные уже идут фрагментами того же адреса — два значения одного адреса.
        if (work.fragments.has(fieldKeyString('work', undefined))) return 'conflict';
        work.meta = { work: record.work, version: record.version };
        return null;
      }
      case 'work-remove': {
        if (!validWorkKey(record.key)) return 'key';
        const work = WorksSyncReducer.stagedWork(staged, record.key);
        if (work.removed) return null;
        if (work.meta !== null || work.fields.size > 0 || work.fragments.size > 0) return 'conflict';
        work.removed = true;
        return null;
      }
      case 'row':
      case 'row-remove': {
        if (!validWorkKey(record.key) || !safeToken(record.field, 128)) return 'key';
        if (RESERVED_FIELDS.has(record.field)) return 'protocol';
        if (record.kind === 'row-remove') {
          if (!safeToken(record.id, 128)) return 'key';
          const work = WorksSyncReducer.stagedWork(staged, record.key);
          if (work.removed) return 'conflict';
          const field = WorksSyncReducer.rowsStaging(work, record.field);
          if (field === 'conflict') return field;
          field.removed.add(record.id);
          return null;
        }
        if (record.id !== undefined && !safeToken(record.id, 128)) return 'key';
        // `undefined` не переживает JSON-кодирование и оставило бы свойство без значения: поля удаляют записью `field-remove`.
        if (record.row === undefined) return 'protocol';
        const work = WorksSyncReducer.stagedWork(staged, record.key);
        if (work.removed) return 'conflict';
        if (record.id === undefined) return WorksSyncReducer.valueStaging(work, record.field, record.row);
        if (work.fragments.has(fieldKeyString(record.field, record.id))) return 'conflict';
        const field = WorksSyncReducer.rowsStaging(work, record.field);
        if (field === 'conflict') return field;
        field.rows.set(record.id, record.row);
        return null;
      }
      case 'field-remove': {
        if (!validWorkKey(record.key) || !safeToken(record.field, 128)) return 'key';
        if (RESERVED_FIELDS.has(record.field)) return 'protocol';
        const work = WorksSyncReducer.stagedWork(staged, record.key);
        if (work.removed) return 'conflict';
        // Удаление сбрасывает стадию и фрагменты поля; более поздние записи того же поля создают его заново.
        work.fields.delete(record.field);
        work.fragmentFields.delete(record.field);
        work.removedFields.add(record.field);
        for (const fkey of [...work.fragments.keys()]) {
          if (work.fragments.get(fkey)?.field === record.field) work.fragments.delete(fkey);
        }
        return null;
      }
      case 'order': {
        if (!validWorkKey(record.key) || !safeToken(record.field, 128)) return 'key';
        if (RESERVED_FIELDS.has(record.field)) return 'protocol';
        if (!Array.isArray(record.order) || record.order.some((id) => !safeToken(id, 128))) return 'key';
        const work = WorksSyncReducer.stagedWork(staged, record.key);
        if (work.removed) return 'conflict';
        const field = WorksSyncReducer.rowsStaging(work, record.field);
        if (field === 'conflict') return field;
        if (field.orderSlices !== undefined || new Set(record.order).size !== record.order.length) return 'conflict';
        field.order = [...record.order];
        return null;
      }
      case 'order-slice': {
        if (!validWorkKey(record.key) || !safeToken(record.field, 128)) return 'key';
        if (RESERVED_FIELDS.has(record.field)) return 'protocol';
        if (!Array.isArray(record.ids) || !validRange(record.start, record.ids.length) || typeof record.final !== 'boolean') return 'protocol';
        if (record.ids.some(id => !safeToken(id, 128))) return 'key';
        const work = WorksSyncReducer.stagedWork(staged, record.key);
        if (work.removed) return 'conflict';
        const field = WorksSyncReducer.rowsStaging(work, record.field);
        if (field === 'conflict' || field.order !== undefined) return 'conflict';
        const slices = field.orderSlices ??= { slices: new Map(), length: null, covered: new Set(), maxEnd: 0, ids: new Set() };
        if (!reserveSlice(slices, record.start, record.ids.length)) return 'conflict';
        const end = record.start + record.ids.length;
        if (slices.length !== null && (record.final || end > slices.length)) return 'conflict';
        if (record.final) {
          if (slices.maxEnd > end) return 'conflict';
          slices.length = end;
        }
        for (const id of record.ids) {
          if (slices.ids.has(id)) return 'conflict';
          slices.ids.add(id);
        }
        slices.slices.set(record.start, [...record.ids]);
        return null;
      }
      case 'section': {
        if (!validWorkKey(record.key) || !safeToken(record.field, 128)) return 'key';
        if (RESERVED_FIELDS.has(record.field)) return 'protocol';
        if (!Array.isArray(record.items) || !validRange(record.start, record.items.length) || typeof record.final !== 'boolean') return 'protocol';
        const work = WorksSyncReducer.stagedWork(staged, record.key);
        if (work.removed) return 'conflict';
        const field = WorksSyncReducer.sectionStaging(work, record.field);
        if (field === 'conflict' || field.length !== null || !reserveSlice(field, record.start, record.items.length)) return 'conflict';
        const end = record.start + record.items.length;
        if (record.final) {
          if (field.maxEnd > end) return 'conflict';
          field.length = end;
        }
        field.slices.set(record.start, record.items);
        return null;
      }
      case 'section-fragment': {
        if (!validWorkKey(record.key) || !safeToken(record.field, 128)) return 'key';
        if (RESERVED_FIELDS.has(record.field)) return 'protocol';
        if (!validRange(record.element, 1) || !Number.isSafeInteger(record.index) || record.index < 0 || typeof record.text !== 'string' || typeof record.final !== 'boolean') return 'protocol';
        const work = WorksSyncReducer.stagedWork(staged, record.key);
        if (work.removed) return 'conflict';
        const field = WorksSyncReducer.sectionStaging(work, record.field);
        if (field === 'conflict' || (field.length !== null && record.element >= field.length)) return 'conflict';
        let fragment = field.elements.get(record.element);
        if (fragment === undefined) {
          if (field.covered.has(record.element) || field.slices.has(record.element)) return 'conflict';
          field.covered.add(record.element);
          field.maxEnd = Math.max(field.maxEnd, record.element + 1);
          fragment = { byIndex: new Map(), finalIndex: null };
          field.elements.set(record.element, fragment);
        }
        if (fragment.byIndex.has(record.index) || (fragment.finalIndex !== null && (record.final || record.index > fragment.finalIndex))) return 'conflict';
        if (record.final) {
          for (const index of fragment.byIndex.keys()) if (index > record.index) return 'conflict';
          fragment.finalIndex = record.index;
        }
        fragment.byIndex.set(record.index, record.text);
        return null;
      }
      case 'branch': {
        if (!safeToken(record.projectPath, 32768)) return 'key';
        if (record.branch !== null && (typeof record.branch !== 'string' || record.branch.length > 512)) return 'protocol';
        staged.branches.set(record.projectPath, record.branch);
        staged.removedBranches.delete(record.projectPath);
        return null;
      }
      case 'branch-remove': {
        if (!safeToken(record.projectPath, 32768)) return 'key';
        staged.removedBranches.add(record.projectPath);
        staged.branches.delete(record.projectPath);
        return null;
      }
      case 'fragment': {
        if (!validWorkKey(record.key) || !safeToken(record.field, 128) || (record.id !== undefined && !safeToken(record.id, 128))) return 'key';
        if (!Number.isInteger(record.index) || record.index < 0 || typeof record.text !== 'string' || typeof record.final !== 'boolean') return 'protocol';
        const work = WorksSyncReducer.stagedWork(staged, record.key);
        if (work.removed) return 'conflict';
        // Адрес `work` без id — фрагментация метаданных работы: у метаданных нет строк, id запрещён.
        // Метаданные прямой записью уже пришли — два значения одного адреса.
        if (record.field === 'work') {
          if (record.id !== undefined) return 'protocol';
          if (work.meta !== null) return 'conflict';
        } else if (RESERVED_FIELDS.has(record.field)) {
          return 'protocol';
        }
        const fkey = fieldKeyString(record.field, record.id);
        // Прямая строка того же адреса уже пришла — конфликт двух значений.
        const direct = work.fields.get(record.field);
        if (direct?.kind === 'section') return 'conflict';
        if (direct !== undefined && ((record.id === undefined && direct.kind === 'value') || (record.id !== undefined && direct.kind === 'rows' && direct.rows.has(record.id)))) return 'conflict';
        // Канал версии источника — только у фрагментов метаданных; все куски одного адреса несут его согласованно.
        if (record.version !== undefined) {
          if ((!Number.isInteger(record.version) || record.version < 0)) return 'protocol';
          if (record.field !== 'work' || record.id !== undefined) return 'protocol';
        }
        work.fragmentFields.add(record.field);
        let frag = work.fragments.get(fkey);
        if (frag === undefined) {
          frag = { field: record.field, id: record.id, byIndex: new Map(), finalIndex: null, version: record.version ?? null };
          work.fragments.set(fkey, frag);
        } else if ((record.version ?? null) !== frag.version) {
          return 'conflict';
        }
        if (frag.byIndex.has(record.index)) return 'conflict'; // любой повтор индекса
        if (record.final) {
          if (frag.finalIndex !== null) return 'conflict'; // два «последних»
          frag.finalIndex = record.index;
        }
        frag.byIndex.set(record.index, record.text);
        return null;
      }
      default:
        return 'protocol';
    }
  }

  /** Коммит: сборка фрагментов и секций, проверка полноты, атомарная замена вида. */
  private commitStaged(staged: Staged): WorksSyncApplyOutcome {
    // Фрагменты → метаданные или строки: непрерывность 0..N, ровно один последний, разбор JSON.
    // Сборка — не повторный приход: собранный адрес уходит из стадий фрагментов до применения,
    // иначе допустимый одиночный фрагмент конфликтовал бы сам с собой.
    for (const work of staged.works.values()) {
      for (const [fkey, frag] of [...work.fragments]) {
        const indices = [...frag.byIndex.keys()].sort((a, b) => a - b);
        if (indices.length === 0 || frag.finalIndex === null || indices[indices.length - 1] !== frag.finalIndex) return this.reject('incomplete');
        for (let i = 0; i < indices.length; i++) {
          if (indices[i] !== i) return this.reject('incomplete');
        }
        let text = '';
        for (const index of indices) text += frag.byIndex.get(index);
        let value: unknown;
        try {
          value = JSON.parse(text);
        } catch {
          return this.reject('conflict');
        }
        work.fragments.delete(fkey);
        if (frag.field === 'work' && frag.id === undefined) {
          // Ограниченная фрагментация метаданных: целый `Work` без фабрикации и обрезания;
          // версия источника едет каналом фрагмента, отсутствие — явное.
          if (typeof value !== 'object' || value === null || (value as { id?: unknown }).id !== work.key.workId) return this.reject('protocol');
          if (work.meta !== null) return this.reject('conflict');
          work.meta = { work: value as Work, version: frag.version ?? undefined };
          continue;
        }
        if (frag.id === undefined) {
          const conflict = WorksSyncReducer.valueStaging(work, frag.field, value);
          if (conflict !== null) return this.reject(conflict);
        } else {
          const field = WorksSyncReducer.rowsStaging(work, frag.field);
          if (field === 'conflict') return this.reject(field);
          field.rows.set(frag.id, value);
        }
      }
    }
    // Полнота: reset требует метаданные каждой работы; секции закрыты и непрерывны с нуля.
    for (const work of staged.works.values()) {
      if (work.removed) continue;
      if (staged.transaction.mode === 'reset' && work.meta === null) return this.reject('incomplete');
      for (const field of work.fields.values()) {
        if (field.kind === 'rows' && field.orderSlices !== undefined) {
          if (!completeSlices(field.orderSlices)) return this.reject('incomplete');
          field.order = [];
          for (const start of [...field.orderSlices.slices.keys()].sort((a, b) => a - b)) {
            for (const id of field.orderSlices.slices.get(start)!) field.order.push(id);
          }
        }
        if (field.kind !== 'section') continue;
        for (const [element, fragment] of field.elements) {
          const indices = [...fragment.byIndex.keys()].sort((a, b) => a - b);
          if (fragment.finalIndex === null || indices.length !== fragment.finalIndex + 1 || indices.some((index, at) => index !== at)) return this.reject('incomplete');
          let text = '';
          for (const index of indices) text += fragment.byIndex.get(index)!;
          let value: unknown;
          try { value = JSON.parse(text); } catch { return this.reject('conflict'); }
          field.slices.set(element, [value]);
        }
        if (!completeSlices(field)) return this.reject('incomplete');
      }
    }

    const affected: WorksSyncWorkKey[] = [];
    const deleted: WorksSyncWorkKey[] = [];
    const previousById = new Map(this.viewState.snapshot.entries.map((e) => [workKeyString({ projectPath: e.projectPath, workId: e.map.work.id }), e]));
    let entries: WindowWorkEntry[];

    try {
      if (staged.transaction.mode === 'reset') {
        // Каталог перечисляется целиком: прежние записи не переносятся, порядок — по приходу метаданных.
        entries = [];
        for (const work of staged.works.values()) {
          if (work.removed) continue;
          if (work.meta === null) return this.reject('incomplete');
          entries.push(this.buildEntry(undefined, work));
        }
      } else {
        // Дельта: прежний порядок сохраняется, нетронутые записи остаются теми же объектами;
        // затронутые пересобираются на месте, новые работы дописываются в конец.
        entries = [];
        for (const existing of this.viewState.snapshot.entries) {
          const id = workKeyString({ projectPath: existing.projectPath, workId: existing.map.work.id });
          const work = staged.works.get(id);
          if (work === undefined) {
            entries.push(existing);
            continue;
          }
          if (work.removed) {
            deleted.push(work.key);
            continue;
          }
          entries.push(this.buildEntry(existing, work));
          affected.push(work.key);
        }
        for (const work of staged.works.values()) {
          const id = workKeyString(work.key);
          if (previousById.has(id) || work.removed) continue;
          if (work.meta === null) return this.reject('incomplete'); // новая работа требует метаданные
          entries.push(this.buildEntry(undefined, work));
          affected.push(work.key);
        }
      }
    } catch (error) {
      if (error instanceof WorksSyncIncompleteError) return this.reject('incomplete');
      throw error;
    }

    let branches: Record<string, string | null>;
    if (staged.transaction.mode === 'reset') {
      branches = Object.fromEntries(staged.branches);
    } else {
      branches = { ...this.viewState.snapshot.branches };
      for (const [projectPath, branch] of staged.branches) branches[projectPath] = branch;
      for (const projectPath of staged.removedBranches) delete branches[projectPath];
    }

    const snapshot: WorksSnapshot = { entries, branches, revision: staged.transaction.target };
    const commit: WorksSyncCommitInfo = { epoch: staged.transaction.epoch, revision: staged.transaction.target, affected, deleted };
    this.viewState = { epoch: staged.transaction.epoch, revision: staged.transaction.target, snapshot };
    this.lastCommit = { transaction: { ...staged.transaction }, commit };
    this.staged = null;
    return { state: 'committed', commit };
  }

  /** Сборка записи работы: копия карты с применением стадий; прежние объекты не мутируются. */
  private buildEntry(old: WindowWorkEntry | undefined, work: StagedWork): WindowWorkEntry {
    const map: Record<string, unknown> = old === undefined ? { schemaVersion: 2 } : { ...old.map };
    if (work.meta !== null) map['work'] = work.meta.work;
    // Удаления полей применяются до стадий: поле, удалённое и заново созданное в одной транзакции, в конце содержит только новое.
    for (const field of work.removedFields) {
      if (Object.prototype.hasOwnProperty.call(map, field)) delete map[field];
    }
    for (const [field, staging] of work.fields) {
      if (staging.kind === 'value') {
        map[field] = staging.value;
        continue;
      }
      if (staging.kind === 'section') {
        const items: unknown[] = [];
        for (const start of [...staging.slices.keys()].sort((a, b) => a - b)) for (const item of staging.slices.get(start)!) items.push(item);
        map[field] = items;
        continue;
      }
      const existing = old !== undefined && Object.prototype.hasOwnProperty.call(map, field) ? (map[field] as unknown) : undefined;
      map[field] = applyRows(existing, staging);
    }
    const entry: WindowWorkEntry = { projectPath: work.key.projectPath, map: map as unknown as WindowWorkEntry['map'] };
    if (work.meta !== null && work.meta.version !== undefined) entry.version = work.meta.version;
    else if (work.meta === null && old !== undefined && old.version !== undefined) entry.version = old.version;
    return entry;
  }
}

/** Применяет стадию строк к текущему значению поля: порядок из вектора или прежний, upsert на месте. */
function applyRows(existing: unknown, staging: { rows: Map<string, unknown>; removed: Set<string>; order?: string[] }): unknown[] {
  const current: unknown[] = Array.isArray(existing) ? existing : [];
  const byId = new Map<string, unknown>();
  for (const item of current) {
    if (typeof item === 'object' && item !== null && typeof (item as { id?: unknown }).id === 'string') {
      byId.set((item as { id: string }).id, item);
    }
  }
  for (const [id, row] of staging.rows) byId.set(id, row);
  for (const id of staging.removed) byId.delete(id);
  if (staging.order !== undefined) {
    // Вектор полон: неизвестная строка — неполнота транзакции, строки вне вектора отброшены.
    const ordered: unknown[] = [];
    for (const id of staging.order) {
      const row = byId.get(id);
      if (row === undefined) throw new WorksSyncIncompleteError(id);
      ordered.push(row);
    }
    return ordered;
  }
  // Без вектора порядок прежний: upsert на месте по id, новые строки в конец, удалённые прочь.
  const seen = new Set<string>();
  const out: unknown[] = [];
  for (const item of current) {
    const id = typeof item === 'object' && item !== null && typeof (item as { id?: unknown }).id === 'string' ? (item as { id: string }).id : null;
    if (id === null) {
      out.push(item);
      continue;
    }
    if (staging.removed.has(id)) continue;
    seen.add(id);
    out.push(byId.get(id));
  }
  for (const [id, row] of staging.rows) {
    if (!seen.has(id) && !staging.removed.has(id)) out.push(row);
  }
  return out;
}
