/**
 * Документы палитры ⌘J (кусок 6.2, спека 9.1): вкладки, работы, сессии, комнаты и действия
 * из хранилищ окна — и их ранжирование (спека 9.2). Сборка — чистая над входом; побочные
 * действия живут только в `run` документа, который зовёт выбор строки.
 *
 * Рамка (спека 9.4, 15.1): `run` не создаёт работ и сессий и ничего не пишет в терминал —
 * только открывает вкладку, делает работу активной или зовёт действие реестра, а создание
 * идёт своей формой или диалогом.
 *
 * Подписи строк — по снимку handoff (спека окна 2026-09-29, 1.9): вид строки и работа («Tab · Платежи»),
 * у сессии работа, слово состояния и провайдер, у работы проект, число сессий и ветка, у действия
 * «Action». Поле поиска подписи не читает (`fields`), поэтому ранжирование прежнее.
 */

import type { WorkEntry, WorkSession } from '@parley/core';
import { refKey } from '@parley/protocol';
import { toast } from 'sonner';
import type { ActionDef, ActionId } from '../../shared/keybindings.js';
import type { TabSpec, WorkLayout } from '../../shared/layout-types.js';
import { providerName, S } from '../../shared/strings.js';
import type { WorkAttention } from '../attention/derive.js';
import type { HistoryEntry } from '../layout/history.js';
import { whenShown } from '../attention/focus-target.js';
import { tabId } from '../layout/ids.js';
import { measureGroupSizes } from '../layout/measure.js';
import { useLayoutStore } from '../layout/store.js';
import { tabMeta, type TabMeta } from '../layout/tab-meta.js';
import { groups, openTab, openTerminalSessionIds, splitGroup } from '../layout/tree.js';
import { displayStatus, dotState, stateWord, type DotState } from '../lib/dot-state.js';
import { isoMs } from '../lib/iso-time.js';
import { sessionLabelText, sessionRowLabel, sessionTag, workTitleText } from '../lib/participant.js';
import { treeOrder, workKey } from '../lib/tree-order.js';
import type { ActivityEntry } from '../store/activity.js';
import { terminalSurfaces } from '../terminal/surface-registry.js';
import { recencyBucket, scoreDocument } from './score.js';
import type { PaletteMode } from './store.js';

export type PaletteSection = 'tabs' | 'works' | 'sessions' | 'rooms' | 'actions' | 'files';

/** Строк в секции (спека 9.1); «ещё N» раскрывает секцию. */
export const SECTION_LIMITS: Record<PaletteSection, number> = { tabs: 5, works: 6, sessions: 8, rooms: 4, actions: 6, files: 50 };

/** Порядок секций при равных лучших документах — и в пустом запросе палитры одной работы. */
const SECTION_ORDER: readonly PaletteSection[] = ['tabs', 'works', 'sessions', 'rooms', 'actions', 'files'];

/** Значок строки: вид вкладки, работа или действие. */
export type PaletteIcon = TabMeta['icon'] | 'work' | 'action';

export interface PaletteDoc {
  id: string;
  section: PaletteSection;
  title: string;
  subtitle: string;
  fields: string[];
  recencyAt: number | null;
  order: number;
  state?: DotState; // сессии — их точка; работы — по уровню внимания
  icon: PaletteIcon;
  /** Файл (вкладка файла, ⌘P): путь для значка по имени (спека значков 3.3) — название вкладки бывает обрезано. */
  filePath?: string;
  /** Работы: последний переход к работе в истории — пустой запрос берёт по нему четыре последние. */
  visitedAt?: number | null;
  /** Вес названия в очках; по умолчанию 1.5 (спека 9.2), имя файла — 2 (спека 10.2). */
  titleWeight?: number;
  /** Виден и в пустом запросе палитры «Открыть…»: «+» без набора иначе бесполезен (9.2a). */
  pinned?: true;
  run(mode: 'default' | 'split'): void;
}

export function buildDocuments(input: {
  works: WorkEntry[];
  activity: Record<string, ActivityEntry>;
  /** useSidebarAttention() (3.3): lastEventAt и уровень работ — один расчёт внимания (4.2). */
  attention: Record<string, WorkAttention>;
  /** useWorksStore.branches: ветка проекта — поле поиска работ (спека 9.1). */
  branches: Record<string, string | null>;
  /** visibleWorkOrder(useSidebarSectionsStore.getState().sections): последняя ступень ранжирования (спека 9.2, п. 5). */
  order: readonly string[];
  layouts: Record<string, WorkLayout>;
  /** useLayoutStore.getState().entries(): записи { workKey, tabId, at } (2.2). */
  history: readonly HistoryEntry[];
  actions: readonly ActionDef[];
  available(id: ActionId): boolean;
  wakePaused: boolean | null; // заголовок wake.toggle
  providers: Array<{ id: string; label: string }>;
  mode: PaletteMode;
  /** Режимы разделения показывают только активную работу. */
  activeWorkKey: string | null;
  /** Документы файлов корня «Файлов» активной работы (режим files или запрос с /); null — lsFiles ещё идёт. */
  files: PaletteDoc[] | null;
  run(id: ActionId): void; // действия — run из AppShell (6.1b), в 6.3 — runAction
}): PaletteDoc[] {
  const { works, activity, attention, branches, layouts, mode, activeWorkKey } = input;
  // Файлы ищутся отдельно от прочего (спека 9.1): ⌘P и запрос с `/` показывают только их.
  if (mode === 'files') return input.files ?? [];
  const split = mode === 'splitRight' || mode === 'splitDown';
  const direction = mode === 'splitDown' ? 'column' : 'row';

  const orderIndex = new Map(input.order.map((key, index) => [key, index]));
  // Свежесть вкладки — самое позднее `at` её записей; работы — последний переход к ней.
  const tabAt = new Map<string, number>();
  const workAt = new Map<string, number>();
  for (const entry of input.history) {
    workAt.set(entry.workKey, Math.max(workAt.get(entry.workKey) ?? entry.at, entry.at));
    if (entry.tabId === null) continue;
    const key = `${entry.workKey}\n${entry.tabId}`;
    tabAt.set(key, Math.max(tabAt.get(key) ?? entry.at, entry.at));
  }
  const providerLabel = new Map(input.providers.map((provider) => [provider.id, provider.label]));

  const docs: PaletteDoc[] = [];
  for (const entry of works) {
    if (entry.map.work.status === 'archived') continue;
    const key = workKey(entry.projectPath, entry.map.work.id);
    if (split && key !== activeWorkKey) continue;
    const workTitle = workTitleText(entry.map.work.title);
    // Порядок сайдбара — по работам; внутри работы — порядок вкладок и дерева сессий.
    const base = (orderIndex.get(key) ?? input.order.length) * 1000;
    const layout = layouts[key];

    // Вкладка открывается там, где уже есть; ⌘Enter — в новой группе справа. Открытая вкладка
    // получает фокус ввода (ревью 6.2-B, Important 1): набранное после выбора не теряется.
    const open = (tab: TabSpec) => (runMode: 'default' | 'split') => {
      let opened: boolean;
      if (split) opened = splitInto(key, tab, direction);
      else {
        useLayoutStore.getState().setActiveWork(key);
        if (runMode === 'split') opened = splitInto(key, tab, 'row');
        else opened = useLayoutStore.getState().apply(key, (current) => openTab(current, tab)) === null;
      }
      if (opened) void focusOpened(key, tab, entry);
    };

    const sessionState = (session: WorkSession): DotState =>
      dotState(
        displayStatus(session),
        activity[refKey({ projectPath: entry.projectPath, workId: entry.map.work.id, sessionId: session.id })]?.activity.activity ?? null,
      );

    if (layout !== undefined) {
      groups(layout)
        .flatMap((group) => group.tabs)
        .forEach((tab, index) => {
          const meta = tabMeta(tab, entry);
          const session = tab.kind === 'terminal' ? entry.map.sessions.find((candidate) => candidate.id === tab.sessionId) : undefined;
          docs.push({
            id: `tab:${key}\n${tab.id}`,
            section: 'tabs',
            title: meta.title,
            subtitle: meta.icon === 'room' ? S.palette.roomSubtitle(workTitle) : S.palette.tabSubtitle(workTitle),
            fields: [tab.kind, workTitle],
            recencyAt: tabAt.get(`${key}\n${tab.id}`) ?? null,
            order: base + index,
            ...(session === undefined ? {} : { state: sessionState(session) }),
            icon: meta.icon,
            ...(tab.kind === 'file' ? { filePath: tab.path } : {}),
            run: open(tab),
          });
        });
    }

    if (!split) {
      const branch = branches[entry.projectPath] ?? null;
      const projectName = entry.projectPath.slice(entry.projectPath.lastIndexOf('/') + 1);
      const workState = workDot(attention[key]);
      const lastEventAt = attention[key]?.lastEventAt;
      docs.push({
        id: `work:${key}`,
        section: 'works',
        title: workTitle,
        subtitle: S.palette.workSubtitle(projectName, entry.map.sessions.filter((session) => session.lifecycle !== 'closed').length, branch),
        fields: [projectName, entry.projectPath, entry.map.work.id, ...(branch === null ? [] : [branch])],
        recencyAt: lastEventAt === undefined ? null : isoMs(lastEventAt),
        order: base,
        ...(workState === undefined ? {} : { state: workState }),
        icon: 'work',
        visitedAt: workAt.get(key) ?? null,
        run: () => useLayoutStore.getState().setActiveWork(key),
      });
      // Как у прежней команды «вся почта работы»: пустая почта не засоряет список.
      if (entry.map.messages.length > 0) {
        docs.push({
          id: `mail:${key}`,
          section: 'works',
          title: S.cardMenu.openMail,
          subtitle: workTitle,
          fields: ['mail', workTitle],
          recencyAt: null,
          order: base + 1,
          icon: 'mail',
          run: open({ kind: 'mail', id: tabId.mail() }),
        });
      }
    }

    // Сессия с открытой вкладкой в режиме разделения есть только вкладкой — иначе дважды.
    const openIds = split ? new Set(openTerminalSessionIds(layout)) : new Set<string>();
    treeOrder(entry.map.sessions).forEach(({ session }, index) => {
      if (session.lifecycle === 'closed' || openIds.has(session.id)) return;
      const lastEventAt =
        activity[refKey({ projectPath: entry.projectPath, workId: entry.map.work.id, sessionId: session.id })]?.activity.lastEventAt ?? null;
      const provider = providerLabel.get(session.provider);
      docs.push({
        id: `session:${key}\n${session.id}`,
        section: 'sessions',
        title: sessionRowLabel(session.id, session.label),
        subtitle: S.palette.sessionSubtitle(
          workTitle,
          stateWord(sessionState(session), session.lifecycle),
          providerName(session.provider, provider ?? session.provider),
        ),
        fields: [
          sessionTag(session.id),
          sessionLabelText(session.label),
          session.provider,
          ...(provider === undefined ? [] : [provider]),
          ...(session.worktree === null ? [] : [session.worktree.branch]),
          workTitle,
          session.task.slice(0, 200),
        ].filter((field) => field !== ''),
        recencyAt: lastEventAt === null ? null : isoMs(lastEventAt),
        order: base + index,
        state: sessionState(session),
        icon: 'terminal',
        run: open({ kind: 'terminal', id: tabId.terminal(session.id), sessionId: session.id }),
      });
    });

    entry.map.rooms.forEach((room, index) => {
      const members = room.members.map((id) => {
        const member = entry.map.sessions.find((candidate) => candidate.id === id);
        return member === undefined ? sessionTag(id) : sessionRowLabel(member.id, member.label);
      });
      docs.push({
        id: `room:${key}\n${room.id}`,
        section: 'rooms',
        title: room.title,
        subtitle: S.palette.roomSubtitle(workTitle),
        fields: [...members, workTitle],
        recencyAt: null,
        order: base + index,
        icon: 'room',
        run: open({ kind: 'room', id: tabId.room(room.id), roomId: room.id }),
      });
    });
  }

  // Действия — только в обычном режиме: «+» строки вкладок и разделение выбирают содержимое.
  if (mode === 'default') {
    input.actions.forEach((action, index) => {
      if (!action.inPalette || !input.available(action.id)) return;
      docs.push({
        id: `action:${action.id}`,
        section: 'actions',
        title: action.id === 'wake.toggle' && input.wakePaused === true ? S.actions.resumeAutoWake : action.title,
        subtitle: S.palette.actionSubtitle,
        fields: action.keywords,
        recencyAt: null,
        order: index,
        icon: 'action',
        run: () => input.run(action.id),
      });
    });
  }

  // «+» строки вкладок открывает палитру «Открыть…» (спека 5.3, 12.1): из действий в ней — новая
  // вкладка браузера. Она встаёт в активную группу, а «+» её уже сделал активной.
  const newBrowserTab = input.actions.find((action) => action.id === 'browser.newTab');
  if (mode === 'open' && newBrowserTab !== undefined && input.available(newBrowserTab.id)) {
    docs.push({
      id: `action:${newBrowserTab.id}`,
      section: 'actions',
      title: newBrowserTab.title,
      subtitle: S.palette.actionSubtitle,
      fields: newBrowserTab.keywords,
      recencyAt: null,
      order: 0,
      icon: 'browser',
      pinned: true,
      run: () => input.run(newBrowserTab.id),
    });
  }

  return docs;
}

/** Точка работы по уровню внимания: `needs-you` — как ждущая сессия, `off` — без точки. */
function workDot(attention: WorkAttention | undefined): DotState | undefined {
  switch (attention?.level) {
    case 'needs-you':
      return 'blocked';
    case 'unseen':
    case 'working':
    case 'idle':
      return attention.level;
    default:
      return undefined;
  }
}

/** Новая группа рядом с активной группой работы; отказ — тостом, как у прежнего выбора сессии. false — отказ. */
function splitInto(key: string, tab: TabSpec, direction: 'row' | 'column'): boolean {
  const error = useLayoutStore
    .getState()
    .apply(key, (layout) => splitGroup(layout, layout.activeGroupId, direction, tab, measureGroupSizes()));
  if (error === 'too-many-groups') toast(S.tabs.tooManyGroups);
  else if (error === 'too-small') toast(S.tabs.tooSmall);
  return error === null;
}

/** Сколько ждём, пока палитра уйдёт из DOM (план, «Переход по уведомлению» — те же 2 с). */
const PALETTE_GONE_TIMEOUT_MS = 2000;
const PALETTE_GONE_POLL_MS = 16;

/**
 * Палитра ушла из DOM. Пока она смонтирована, ловушка фокуса Radix возвращает фокус в её поле:
 * фокус, отданный терминалу раньше, пропал бы вместе с палитрой, и `activeElement` стал бы `body`.
 * Экспорт — для адресной строки новой вкладки браузера (9.2a): её открывает действие палитры.
 */
export function paletteGone(): Promise<boolean> {
  return new Promise((resolve) => {
    const started = Date.now();
    const check = (): void => {
      if (document.querySelector('[data-palette]') === null) resolve(true);
      else if (Date.now() - started >= PALETTE_GONE_TIMEOUT_MS) resolve(false);
      else setTimeout(check, PALETTE_GONE_POLL_MS);
    };
    check();
  });
}

/**
 * Фокус ввода — в поверхность открытой вкладки, как у перехода по уведомлению
 * (`applyFocusTarget`, 4.3): дождаться показа (работа могла быть не гидрирована, контейнер —
 * `inert`) и ухода палитры. Терминал — `focus()` его поверхности; комната и почта — их поле
 * ввода, иначе сама вкладка. Фокус, который человек за это время увёл сам (или который забрал
 * открытый действием диалог), не перехватывается.
 */
async function focusOpened(key: string, tab: TabSpec, entry: WorkEntry): Promise<void> {
  if (!(await whenShown(key, tab)) || !(await paletteGone())) return;
  const current = document.activeElement;
  if (current !== null && current !== document.body) return;
  if (tab.kind === 'terminal') {
    terminalSurfaces.get(refKey({ projectPath: entry.projectPath, workId: entry.map.work.id, sessionId: tab.sessionId }))?.focus();
    return;
  }
  const layout = useLayoutStore.getState().layouts[key];
  const groupId = layout === undefined ? undefined : groups(layout).find((group) => group.activeTabId === tab.id)?.id;
  const container = [...document.querySelectorAll<HTMLElement>('[data-work-container]')].find(
    (element) => element.dataset.workContainer === key,
  );
  const body = [...(container?.querySelectorAll<HTMLElement>('[data-group-body]') ?? [])].find(
    (element) => element.dataset.groupBody === groupId,
  );
  const field = body?.querySelector<HTMLElement>('textarea:not([disabled]), input:not([type="hidden"]):not([disabled])');
  const tabElement = [...document.querySelectorAll<HTMLElement>('[role="tab"][data-work-key][data-tab-id]')].find(
    (element) => element.dataset.workKey === key && element.dataset.tabId === tab.id,
  );
  (field ?? tabElement)?.focus();
}

/**
 * Запрос к файлам: в режиме `files` — весь запрос, в обычном — после префикса `/` (спека 9.1);
 * `null` — палитра файлов не ищет. Режимы разделения выбирают содержимое группы — у них префикса нет.
 */
export function filesQuery(mode: PaletteMode, query: string): string | null {
  if (mode === 'files') return query;
  if (mode === 'default' && query.startsWith('/')) return query.slice(1);
  return null;
}

export interface RankedSection {
  section: PaletteSection;
  docs: PaletteDoc[];
  more: number;
}

/** Пустой запрос: вкладок и работ из истории (спека 9.3) — эти числа главнее `SECTION_LIMITS`. */
const RECENT_TABS = 6;
const RECENT_WORKS = 4;

function takeSection(section: PaletteSection, sorted: PaletteDoc[], expanded: ReadonlySet<PaletteSection>): RankedSection {
  const limit = expanded.has(section) ? sorted.length : SECTION_LIMITS[section];
  return { section, docs: sorted.slice(0, limit), more: Math.max(0, sorted.length - limit) };
}

/**
 * Пустой запрос. Общая палитра (есть секция работ) — шесть последних вкладок и четыре
 * последние работы из истории, свежие первыми, и закреплённые действия («Открыть…», 9.2a). Палитра
 * одной работы (режимы разделения) —
 * все её секции по свежести и порядку: там выбирают содержимое новой группы, и пустой список
 * без набора был бы бесполезен.
 */
function browse(docs: PaletteDoc[], now: number, expanded: ReadonlySet<PaletteSection>): RankedSection[] {
  if (docs.some((doc) => doc.section === 'works')) {
    const tabs = docs
      .filter((doc): doc is PaletteDoc & { recencyAt: number } => doc.section === 'tabs' && doc.recencyAt !== null)
      .sort((a, b) => b.recencyAt - a.recencyAt)
      .slice(0, RECENT_TABS);
    const works = docs
      .filter((doc): doc is PaletteDoc & { visitedAt: number } => doc.section === 'works' && typeof doc.visitedAt === 'number')
      .sort((a, b) => b.visitedAt - a.visitedAt)
      .slice(0, RECENT_WORKS);
    const pinned = docs.filter((doc) => doc.pinned === true);
    const result: RankedSection[] = [];
    if (tabs.length > 0) result.push({ section: 'tabs', docs: tabs, more: 0 });
    if (works.length > 0) result.push({ section: 'works', docs: works, more: 0 });
    if (pinned.length > 0) result.push({ section: 'actions', docs: pinned, more: 0 });
    return result;
  }
  const bucket = (doc: PaletteDoc): number => recencyBucket(doc.recencyAt === null ? null : now - doc.recencyAt);
  return SECTION_ORDER.flatMap((section) => {
    const sorted = docs.filter((doc) => doc.section === section).sort((a, b) => bucket(a) - bucket(b) || a.order - b.order);
    return sorted.length === 0 ? [] : [takeSection(section, sorted, expanded)];
  });
}

/**
 * Ранжирование спеки 9.2: каждый токен обязан совпасть; очки, затем корзина свежести, затем
 * порядок сайдбара. Секции соперничают лучшим документом. `expanded` — секции, раскрытые
 * строкой «ещё N».
 */
export function rankDocuments(
  query: string,
  docs: PaletteDoc[],
  now: number,
  expanded: ReadonlySet<PaletteSection> = new Set(),
): RankedSection[] {
  const tokens = query.trim().split(/\s+/).filter((token) => token !== '');
  if (tokens.length === 0) return browse(docs, now, expanded);

  const scored: Array<{ doc: PaletteDoc; score: number; bucket: number }> = [];
  for (const doc of docs) {
    const score = scoreDocument(tokens, doc);
    if (score === null) continue;
    scored.push({ doc, score, bucket: recencyBucket(doc.recencyAt === null ? null : now - doc.recencyAt) });
  }
  const compare = (a: (typeof scored)[number], b: (typeof scored)[number]): number =>
    b.score - a.score || a.bucket - b.bucket || a.doc.order - b.doc.order;

  const bySection = new Map<PaletteSection, typeof scored>();
  for (const item of scored) {
    const list = bySection.get(item.doc.section) ?? [];
    list.push(item);
    bySection.set(item.doc.section, list);
  }
  const sections = [...bySection.entries()].map(([section, items]) => ({ section, items: items.sort(compare) }));
  sections.sort((a, b) => {
    const [bestA] = a.items;
    const [bestB] = b.items;
    const byBest = bestA !== undefined && bestB !== undefined ? compare(bestA, bestB) : 0;
    return byBest || SECTION_ORDER.indexOf(a.section) - SECTION_ORDER.indexOf(b.section);
  });
  return sections.map(({ section, items }) => takeSection(section, items.map((item) => item.doc), expanded));
}
