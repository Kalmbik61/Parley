// packages/desktop/src/main/browser/agent-settle.ts
/**
 * Проба страницы и ожидание затишья после действия агента (спека 2026-11-18, раздел 3.2). Проба живёт в изолированном
 * мире `parley-agent`: страница её не видит и подменить не может. В мире `MutationObserver` считает изменения документа;
 * main зовёт `PROBE_FN` через `Runtime.callFunctionOn` с `executionContextId`. Новый документ — новый мир: по этому
 * и по числу изменений `changeOf` отличает «изменилась» от «ничего». Проба недоступна — `null`, а `null` не значит
 * «ничего не изменилось»: `changeOf` отвечает `unknown`.
 */
import type { WebContents } from 'electron';
import { AGENT_LIMITS } from '@parley/protocol';
import type { BrowserAgentActionResult } from '@parley/protocol';
import type { Inspector } from './inspector.js';
import { PROBE_FN } from './page-fns.js';

/** Имя изолированного мира Parley в странице. */
const WORLD_NAME = 'parley-agent';
/** Нижняя граница шага ожидания: чаще опрашивать страницу незачем. */
const MIN_STEP_MS = 20;

/** Тип `change` ответа действия (индекс протокола `BrowserAgentChange` отдельно не отдаёт). */
export type BrowserAgentChange = NonNullable<BrowserAgentActionResult['change']>;

export interface PageProbe {
  /** Сколько изменений DOM насчитал наблюдатель мира. */
  n: number;
  /** Сколько мс DOM молчит. */
  idle: number;
  /** `document.readyState`. */
  ready: string;
  /** Номер мира: новый документ или пересозданный мир — другой номер. */
  world: number;
}

export interface AgentSettle {
  /** Проба документа; `null` — мира нет и создать не вышло. Не бросает. */
  probe(contents: WebContents): Promise<PageProbe | null>;
  /** Ждёт затишья, не дольше `settleCapMs`; последняя проба или `null`. Обрыв `signal` — отказ с его причиной. */
  quiet(contents: WebContents, signal: AbortSignal): Promise<PageProbe | null>;
}

interface World {
  epoch: number;
  contextId: number;
  /** Порядковый номер создания; в пробе он называется `world`. */
  serial: number;
}

export function createAgentSettle(deps: {
  inspector: Pick<Inspector, 'send' | 'snapshot'>;
  now?(): number;
  /** Сон с обрывом по `signal` (`sleep` из `agent-actions.ts`): сюда не импортируется, чтобы модули не ссылались друг на друга по кругу. */
  sleep(ms: number, signal: AbortSignal): Promise<void>;
}): AgentSettle {
  const { inspector } = deps;
  const now = deps.now ?? Date.now;
  const { sleep } = deps;
  const worlds = new Map<number, World>();
  let serial = 0;

  const epochOf = (id: number): number => inspector.snapshot(id)?.epoch ?? 0;

  async function createWorld(id: number): Promise<World> {
    const tree = await inspector.send<{ frameTree: { frame: { id: string } } }>(id, 'Page.getFrameTree', {});
    const created = await inspector.send<{ executionContextId: number }>(id, 'Page.createIsolatedWorld', { frameId: tree.frameTree.frame.id, worldName: WORLD_NAME });
    serial += 1;
    const world: World = { epoch: epochOf(id), contextId: created.executionContextId, serial };
    worlds.set(id, world);
    return world;
  }

  async function callProbe(id: number, world: World): Promise<PageProbe | null> {
    const reply = await inspector.send<{ result?: { value?: { n?: unknown; idle?: unknown; ready?: unknown } } }>(id, 'Runtime.callFunctionOn', {
      functionDeclaration: PROBE_FN,
      executionContextId: world.contextId,
      returnByValue: true,
    });
    const value = reply.result?.value;
    if (typeof value?.n !== 'number' || typeof value.idle !== 'number' || typeof value.ready !== 'string') return null;
    return { n: value.n, idle: value.idle, ready: value.ready, world: world.serial };
  }

  /** Запрос текущей эпохи журнала без ответа и без отказа, моложе `settleFreshRequestMs`. */
  function requestsInFlight(id: number): boolean {
    const snapshot = inspector.snapshot(id);
    if (snapshot === null) return false;
    const at = now();
    return snapshot.network.some((entry) => entry.epoch === snapshot.epoch && entry.status === null && entry.failure === null && at - entry.ts < AGENT_LIMITS.settleFreshRequestMs);
  }

  async function probe(contents: WebContents): Promise<PageProbe | null> {
    const id = contents.id;
    try {
      const cached = worlds.get(id);
      const world = cached !== undefined && cached.epoch === epochOf(id) ? cached : await createWorld(id);
      try {
        return await callProbe(id, world);
      } catch {
        // Контекст мёртв (новый документ без смены эпохи, пересозданный мир): пересоздать один раз.
        return await callProbe(id, await createWorld(id));
      }
    } catch {
      worlds.delete(id);
      return null;
    }
  }

  return {
    probe,
    async quiet(contents, signal) {
      const started = now();
      for (;;) {
        const last = await probe(contents);
        if (last === null) return null;
        if (last.ready !== 'loading' && last.idle >= AGENT_LIMITS.settleQuietMs && !requestsInFlight(contents.id)) return last;
        const left = AGENT_LIMITS.settleCapMs - (now() - started);
        if (left <= 0) return last;
        await sleep(Math.min(Math.max(MIN_STEP_MS, AGENT_LIMITS.settleQuietMs - last.idle), left), signal);
      }
    },
  };
}

/** Что случилось со страницей: переход; любая проба потеряна — неизвестно; мир или счёт изменений другой — изменилась. */
export function changeOf(before: PageProbe | null, after: PageProbe | null, navigated: boolean): BrowserAgentChange {
  if (navigated) return 'navigated';
  if (before === null || after === null) return 'unknown';
  return before.world !== after.world || before.n !== after.n ? 'changed' : 'none';
}
