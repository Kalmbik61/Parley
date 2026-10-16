/**
 * Реестр страниц панелей для агента (спека 2026-10-07-browser-devtools-agent-design.md, 3.7, 5.2): id агента (`t1`, `t2`…
 * со своим счётом у каждой работы), записи страниц от окна, паузы панелей, доступ к странице (`pageOf`) и список `tabs`.
 */
import type { WebContents } from 'electron';
import type { BrowserAgentOpEvent, BrowserAgentOwner, BrowserAgentTabInfo } from '@parley/protocol';
import { viewportSize } from '../../shared/browser-devtools.js';
import type { AgentPageRegistration } from '../../shared/browser-types.js';
import type { BrowserOwner } from '../../shared/layout-types.js';
import { isLoopbackUrl } from '../../shared/loopback.js';
import { redactUrl } from '../../shared/redact.js';
import { workKey as workKeyOf } from '../../shared/work-keys.js';
import { AgentOpError } from './agent-errors.js';
import type { Emulation } from './emulation.js';
import type { Inspector } from './inspector.js';

/** Ответ `Page.getLayoutMetrics`: нужные поля. */
export interface LayoutMetrics {
  /** Вьюпорт в пикселях устройства: отношение его ширины к CSS-ширине — DPR. */
  layoutViewport: { clientWidth: number; clientHeight: number };
  cssLayoutViewport: { clientWidth: number; clientHeight: number; pageX: number; pageY: number };
  cssContentSize: { x: number; y: number; width: number; height: number };
}

export interface PageRecord {
  agentId: string;
  webContentsId: number | null;
  workKey: string;
  owner: BrowserOwner;
  pageId: string;
  visible: boolean;
  lastUrl: string;
  lastTitle: string;
}

export interface PageRegistry {
  agentIdFor(workKey: string, tabId: string): string;
  /** Запись страницы, её закрытие или пауза панели от окна. */
  register(e: AgentPageRegistration): void;
  /** Окно перезагрузилось: записи и паузы забыты до новой регистрации, id агента сохраняются. */
  reset(): void;
  /** Страница своей работы по id агента и проверки доступа (спека 5.2). */
  pageOf(request: BrowserAgentOpEvent, agentId: string): PageRecord;
  /** Живой гость записи; `null` — гостя нет или он уничтожен. */
  live(record: PageRecord): WebContents | null;
  /** Запись по ключу на сейчас: за время операции окно могло её обновить или убрать. */
  fresh(record: PageRecord): PageRecord | undefined;
  isPaused(workKey: string, owner: BrowserOwner): boolean;
  /** Страницы запроса для `tabs`: своей работы, доступные хозяину, не на паузе, по порядку id; `known` — работа реестру известна. */
  listed(request: BrowserAgentOpEvent): { records: PageRecord[]; known: boolean };
}

/** Длина заголовка страницы в `tabs`. */
const TITLE_LIMIT = 200;

/** Пояснение агенту, когда окно о работе ничего не сообщало: пустой список здесь не значит «страниц нет». */
const UNKNOWN_WORK_NOTE =
  "Parley's window has not reported any browser pages for this workspace. If the human has not opened this workspace in Parley's window yet, its pages are not known; a page you open with browser_open will appear here.";

const ownerId = (owner: BrowserAgentOwner | BrowserOwner): string => (owner.kind === 'session' ? `session:${owner.sessionId}` : `room:${owner.roomId}`);
const pageKey = (workKey: string, pageId: string): string => `${workKey}\n${pageId}`;
const panelKey = (workKey: string, owner: BrowserOwner): string => `${workKey}\n${ownerId(owner)}`;
const entitled = (request: BrowserAgentOpEvent, record: PageRecord): boolean => request.owners.some((owner) => ownerId(owner) === ownerId(record.owner));

export function createPageRegistry(deps: { fromId(id: number): WebContents | null }): PageRegistry {
  /** id агента по работе и вкладке; счёт — свой у каждой работы. */
  const ids = new Map<string, string>();
  const counters = new Map<string, number>();
  /** Страницы панелей: ключ — работа и страница (`bp-…` уникален на окно, но счёт `agentIdFor` — на работу). */
  const pages = new Map<string, PageRecord>();
  /** Приостановленные панели: работа и хозяин. */
  const paused = new Set<string>();

  function agentIdFor(workKey: string, tabId: string): string {
    const key = `${workKey}\n${tabId}`;
    const known = ids.get(key);
    if (known !== undefined) return known;
    const next = (counters.get(workKey) ?? 0) + 1;
    counters.set(workKey, next);
    const id = `t${next}`;
    ids.set(key, id);
    return id;
  }

  const isPaused = (workKey: string, owner: BrowserOwner): boolean => paused.has(panelKey(workKey, owner));

  return {
    agentIdFor,
    register(e) {
      if ('gone' in e) {
        pages.delete(pageKey(e.workKey, e.pageId));
        return;
      }
      if ('paused' in e) {
        if (e.paused) paused.add(panelKey(e.workKey, e.owner));
        else paused.delete(panelKey(e.workKey, e.owner));
        return;
      }
      const key = pageKey(e.workKey, e.pageId);
      const previous = pages.get(key);
      const contents = e.webContentsId === null ? null : deps.fromId(e.webContentsId);
      pages.set(key, {
        agentId: agentIdFor(e.workKey, e.pageId),
        webContentsId: e.webContentsId,
        workKey: e.workKey,
        owner: e.owner,
        pageId: e.pageId,
        visible: e.visible,
        lastUrl: contents?.getURL() ?? previous?.lastUrl ?? '',
        lastTitle: contents?.getTitle() ?? previous?.lastTitle ?? '',
      });
    },
    reset() {
      pages.clear();
      paused.clear();
    },
    pageOf(request, agentId) {
      const workKey = workKeyOf(request.ref.projectPath, request.ref.workId);
      const record = [...pages.values()].find((candidate) => candidate.workKey === workKey && candidate.agentId === agentId);
      if (record === undefined) throw new AgentOpError('no_tab', `There is no page ${agentId} in your browsers: call browser_tabs.`);
      if (!entitled(request, record)) throw new AgentOpError('access_denied', `You have no access to page ${agentId}: it belongs to a browser panel that is not your chat's or your rooms'.`);
      if (isPaused(record.workKey, record.owner)) throw new AgentOpError('access_denied', 'The human paused agents in this browser panel (paused by the human).');
      return record;
    },
    live(record) {
      if (record.webContentsId === null) return null;
      const contents = deps.fromId(record.webContentsId);
      return contents === null || contents.isDestroyed() ? null : contents;
    },
    fresh(record) {
      return pages.get(pageKey(record.workKey, record.pageId));
    },
    isPaused,
    listed(request) {
      const workKey = workKeyOf(request.ref.projectPath, request.ref.workId);
      const records = [...pages.values()]
        .filter((record) => record.workKey === workKey && entitled(request, record) && !isPaused(record.workKey, record.owner))
        .sort((a, b) => Number(a.agentId.slice(1)) - Number(b.agentId.slice(1)));
      // Работа известна реестру, если о ней приходила хоть одна запись (страница или пауза); иначе пустой список — не «страниц нет».
      const known = [...pages.values()].some((record) => record.workKey === workKey) || [...paused].some((key) => key.startsWith(`${workKey}\n`));
      return { records, known };
    },
  };
}

export interface ListTabsDeps {
  inspector: Pick<Inspector, 'send'>;
  emulation: Pick<Emulation, 'current'>;
}

async function viewportOf(deps: ListTabsDeps, id: number): Promise<BrowserAgentTabInfo['viewport']> {
  const spec = deps.emulation.current(id);
  if (spec !== null) {
    const { width, height } = viewportSize(spec);
    return { width, height, emulated: true };
  }
  try {
    const metrics = await deps.inspector.send<LayoutMetrics>(id, 'Page.getLayoutMetrics');
    return { width: Math.round(metrics.cssLayoutViewport.clientWidth), height: Math.round(metrics.cssLayoutViewport.clientHeight), emulated: false };
  } catch {
    return null;
  }
}

export async function listTabs(registry: PageRegistry, deps: ListTabsDeps, request: BrowserAgentOpEvent): Promise<{ tabs: BrowserAgentTabInfo[]; notes: string[] }> {
  const { records, known } = registry.listed(request);
  const tabs: BrowserAgentTabInfo[] = [];
  for (const record of records) {
    const contents = registry.live(record);
    const loaded = contents !== null && !contents.isCrashed();
    if (contents !== null) {
      record.lastUrl = contents.getURL();
      record.lastTitle = contents.getTitle();
    }
    tabs.push({
      id: record.agentId,
      owner: record.owner,
      url: redactUrl(record.lastUrl),
      title: record.lastTitle.slice(0, TITLE_LIMIT),
      viewport: loaded && record.webContentsId !== null ? await viewportOf(deps, record.webContentsId) : null,
      loaded,
      // Невыгруженную, но невидимую страницу человек не видит; незагруженную — тем более.
      visible: loaded && record.visible,
      loopback: isLoopbackUrl(record.lastUrl),
    });
  }
  return { tabs, notes: tabs.length === 0 && !known ? [UNKNOWN_WORK_NOTE] : [] };
}
