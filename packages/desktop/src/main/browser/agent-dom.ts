/**
 * Ссылки `eN`, дерево доступности и ожидание для агента (спека 2026-10-07-browser-devtools-agent-design.md, 5.1):
 * `snapshot` строит дерево и запоминает ссылки страницы, `nodeOf` отдаёт `backendNodeId` по ссылке, `centerOf`/`boxOf` —
 * геометрию, `waitFor` опрашивает дерево. Ссылки живут по странице и эпохе журнала инспектора: новый снимок заменяет
 * карту, другая эпоха (новый документ) делает все прежние ссылки устаревшими — клика по чужому элементу нет.
 */
import type { WebContents } from 'electron';
import { AGENT_LIMITS } from '@parley/protocol';
import type { BrowserAgentArgs, BrowserAgentSnapshotResult, BrowserAgentWaitResult } from '@parley/protocol';
import { sleep } from './agent-actions.js';
import { AgentOpError } from './agent-errors.js';
import type { PageRecord } from './agent-pages.js';
import { urlForAgent } from './agent-url.js';
import { axHasText, axSnapshot, axState } from './ax-snapshot.js';
import type { AxNode } from './ax-snapshot.js';
import type { Inspector } from './inspector.js';

export interface AgentDom {
  snapshotOf(contents: WebContents, record: PageRecord, args: BrowserAgentArgs<'snapshot'>): Promise<BrowserAgentSnapshotResult>;
  /** `backendNodeId` по ссылке; `stale_ref` — ссылки нет в текущем снимке или документ сменился. */
  nodeOf(contents: WebContents, record: PageRecord, ref: string): number;
  /** Центр узла после `DOM.scrollIntoViewIfNeeded`; узла нет — `stale_ref`. */
  centerOf(contents: WebContents, backendNodeId: number): Promise<{ x: number; y: number }>;
  boxOf(contents: WebContents, backendNodeId: number): Promise<{ x: number; y: number; width: number; height: number }>;
  waitFor(contents: WebContents, record: PageRecord, args: BrowserAgentArgs<'wait_for'>, signal: AbortSignal): Promise<BrowserAgentWaitResult>;
  checkedOf(contents: WebContents, backendNodeId: number): Promise<boolean | 'mixed' | null>;
}

const STALE = (what: string): AgentOpError =>
  new AgentOpError('stale_ref', `${what} is no longer on the page: take a new browser_snapshot and use its refs.`);

/** Квад CDP — восемь чисел (четыре угла); рамка по крайним точкам, центр — её середина. */
function boxOfQuad(quad: readonly number[]): { x: number; y: number; width: number; height: number } {
  const xs = [quad[0], quad[2], quad[4], quad[6]] as number[];
  const ys = [quad[1], quad[3], quad[5], quad[7]] as number[];
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

export function createAgentDom(deps: { inspector: Pick<Inspector, 'send' | 'snapshot'>; now?(): number; waitMs?(): number }): AgentDom {
  const { inspector } = deps;
  const now = deps.now ?? Date.now;
  /** Ссылки страницы: ключ — работа и страница, эпоха — журнала инспектора на момент снимка. */
  const maps = new Map<string, { epoch: number; refs: Map<string, number> }>();
  const keyOf = (record: PageRecord): string => `${record.workKey}\n${record.pageId}`;
  const epochOf = (contents: WebContents): number => inspector.snapshot(contents.id)?.epoch ?? 0;

  /** Включение перед каждым деревом: Select выключает Accessibility, отладчик переподключается на навигации (рецензия m5). */
  async function treeOf(contents: WebContents): Promise<AxNode[]> {
    await inspector.send(contents.id, 'DOM.enable');
    await inspector.send(contents.id, 'Accessibility.enable');
    const { nodes } = await inspector.send<{ nodes?: AxNode[] }>(contents.id, 'Accessibility.getFullAXTree');
    return nodes ?? [];
  }

  async function boxModel(contents: WebContents, backendNodeId: number): Promise<{ x: number; y: number; width: number; height: number }> {
    try {
      const { model } = await inspector.send<{ model: { content: number[] } }>(contents.id, 'DOM.getBoxModel', { backendNodeId });
      return boxOfQuad(model.content);
    } catch {
      throw STALE('The element');
    }
  }

  return {
    async snapshotOf(contents, record, args) {
      // Эпоха — до дерева: документ, сменившийся, пока дерево снималось, делает ссылки снимка устаревшими сразу.
      const epoch = epochOf(contents);
      const nodes = await treeOf(contents);
      const snap = axSnapshot(nodes, { interactiveOnly: args.interactiveOnly ?? false, limitBytes: AGENT_LIMITS.snapshotBytes });
      maps.set(keyOf(record), { epoch, refs: snap.refs });
      return { tab: args.tab, url: urlForAgent(contents.getURL()), text: snap.text, refs: snap.refs.size, truncated: snap.truncated };
    },
    nodeOf(contents, record, ref) {
      const entry = maps.get(keyOf(record));
      const node = entry !== undefined && entry.epoch === epochOf(contents) ? entry.refs.get(ref) : undefined;
      if (node === undefined) throw STALE(`The ref ${ref}`);
      return node;
    },
    async centerOf(contents, backendNodeId) {
      try {
        await inspector.send(contents.id, 'DOM.scrollIntoViewIfNeeded', { backendNodeId });
      } catch {
        throw STALE('The element');
      }
      const box = await boxModel(contents, backendNodeId);
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    },
    boxOf: boxModel,
    async checkedOf(contents, backendNodeId) {
      return axState(await treeOf(contents), backendNodeId, 'checked');
    },
    async waitFor(contents, record, args, signal) {
      const started = now();
      const elapsed = (): number => now() - started;
      if (args.ms !== undefined) {
        await sleep(args.ms, signal);
        return { tab: args.tab, url: urlForAgent(contents.getURL()), outcome: 'waited', ms: elapsed() };
      }
      const limit = deps.waitMs?.() ?? AGENT_LIMITS.waitMs;
      const result = (outcome: BrowserAgentWaitResult['outcome']): BrowserAgentWaitResult => ({ tab: args.tab, url: urlForAgent(contents.getURL()), outcome, ms: elapsed() });
      for (;;) {
        signal.throwIfAborted();
        const present = axHasText(await treeOf(contents), (args.text ?? args.gone) as string);
        if (args.text !== undefined && present) return result('found');
        if (args.gone !== undefined && !present) return result('gone');
        const left = limit - elapsed();
        if (left <= 0) return result('timeout');
        await sleep(Math.min(AGENT_LIMITS.pollMs, left), signal);
      }
    },
  };
}
