/**
 * Ссылки `eN`, ожидание и геометрия элемента (задача 16, спека 5.1): дерево доступности перед каждым снимком,
 * ссылки привязаны к эпохе документа, `wait_for` опрашивает дерево.
 */
import { describe, expect, it, vi } from 'vitest';
import type { WebContents } from 'electron';
import { AGENT_LIMITS } from '@parley/protocol';
import { createAgentDom } from './agent-dom.js';
import type { AxNode } from './ax-snapshot.js';
import type { PageRecord } from './agent-pages.js';

const contents = { id: 7, getURL: () => 'http://localhost:5173/settings?token=SECRET' } as unknown as WebContents;
const record = { agentId: 't1', workKey: 'w', pageId: 'bp-aaaaaa' } as unknown as PageRecord;

const ax = (nodeId: string, role: string, name: string, extra: Partial<AxNode> = {}): AxNode => ({
  nodeId,
  ignored: false,
  role: { value: role },
  name: { value: name },
  ...extra,
});

const NODES: AxNode[] = [
  ax('1', 'RootWebArea', 'Settings', { childIds: ['2', '3', '4', '5'] }),
  ax('2', 'button', 'Save', { parentId: '1', backendDOMNodeId: 12 }),
  ax('3', 'link', 'Home', { parentId: '1', backendDOMNodeId: 13 }),
  ax('4', 'textbox', 'Name', { parentId: '1', backendDOMNodeId: 14 }),
  ax('5', 'checkbox', 'Agree', { parentId: '1', backendDOMNodeId: 15, properties: [{ name: 'checked', value: { value: 'true' } }] }),
];

function setup(initial: { nodes?: AxNode[]; box?: { content: number[] } } = {}) {
  const ctx = {
    nodes: initial.nodes ?? [],
    epoch: 1,
    boxFails: false,
    waitLimit: 10_000,
    box: initial.box ?? { content: [0, 0, 10, 0, 10, 10, 0, 10] },
    /** Дерево фреймов `Page.getFrameTree`; пусто — только главный. */
    frameTree: { frame: { id: 'main' } } as { frame: { id: string }; childFrames?: unknown[] },
    /** frameId → `backendNodeId` владельца; нет записи — `DOM.getFrameOwner` отказывает. */
    owners: new Map<string, number>(),
    /** frameId → дерево документа фрейма. */
    frameNodes: new Map<string, AxNode[]>(),
    send: vi.fn(async (_id: number, method: string, params?: { frameId?: string }): Promise<unknown> => {
      if (method === 'Page.getFrameTree') return { frameTree: ctx.frameTree };
      if (method === 'DOM.getFrameOwner') {
        const owner = ctx.owners.get(params?.frameId ?? '');
        if (owner === undefined) throw new Error('Frame with the given id does not belong to the target.');
        return { backendNodeId: owner };
      }
      if (method === 'Accessibility.getFullAXTree' && params?.frameId !== undefined) return { nodes: ctx.frameNodes.get(params.frameId) ?? [] };
      if (method === 'Accessibility.getFullAXTree') return { nodes: ctx.nodes };
      if (method === 'DOM.getBoxModel') {
        if (ctx.boxFails) throw new Error('Could not compute box model.');
        return { model: ctx.box };
      }
      return {};
    }),
    dom: null as unknown as ReturnType<typeof createAgentDom>,
  };
  ctx.dom = createAgentDom({
    inspector: { send: ctx.send as never, snapshot: () => ({ epoch: ctx.epoch, capture: 'on', console: [], network: [] }) },
    waitMs: () => ctx.waitLimit,
  });
  return ctx;
}

const signal = (): AbortSignal => new AbortController().signal;

describe('ссылки и ожидание (спека 5.1)', () => {
  it('snapshot: DOM.enable, Accessibility.enable, getFullAXTree — включение перед каждым деревом (Select выключает Accessibility); текст и число ссылок; предел snapshotBytes', async () => {
    const { dom, send } = setup({ nodes: NODES });
    const result = await dom.snapshotOf(contents, record, { tab: 't1' });
    expect(send.mock.calls.map(([, method]) => method)).toEqual(['DOM.enable', 'Accessibility.enable', 'Accessibility.getFullAXTree', 'Page.getFrameTree']);
    expect(result).toMatchObject({ tab: 't1', refs: 4, truncated: false });
    expect(result.text).toContain('[ref=e1] button "Save"');
    expect(result.url).not.toContain('SECRET');
    await dom.snapshotOf(contents, record, { tab: 't1' });
    expect(send.mock.calls.filter(([, method]) => method === 'Accessibility.enable')).toHaveLength(2);
  });

  it('nodeOf: ссылка из текущего снимка — backendNodeId; неизвестная или после смены эпохи — stale_ref (Фокус ревью 8)', async () => {
    const ctx = setup({ nodes: NODES });
    const snap = await ctx.dom.snapshotOf(contents, record, { tab: 't1' });
    const ref = /\[ref=(e\d+)\] button "Save"/.exec(snap.text)?.[1] as string;
    expect(ctx.dom.nodeOf(contents, record, ref)).toBe(12);
    expect(() => ctx.dom.nodeOf(contents, record, 'e99')).toThrow(expect.objectContaining({ code: 'stale_ref' }));
    ctx.epoch = 2;
    expect(() => ctx.dom.nodeOf(contents, record, ref)).toThrow(expect.objectContaining({ code: 'stale_ref' }));
  });

  it('документ сменился, пока снималось дерево, — ссылки снимка уже устарели: stale_ref (рецензия пачки 3)', async () => {
    const ctx = setup({ nodes: NODES });
    ctx.send.mockImplementation(async (_id: number, method: string): Promise<unknown> => {
      if (method === 'Accessibility.getFullAXTree') {
        ctx.epoch = 2;
        return { nodes: ctx.nodes };
      }
      return {};
    });
    const snap = await ctx.dom.snapshotOf(contents, record, { tab: 't1' });
    const ref = /\[ref=(e\d+)\] button "Save"/.exec(snap.text)?.[1] as string;
    expect(() => ctx.dom.nodeOf(contents, record, ref)).toThrow(expect.objectContaining({ code: 'stale_ref' }));
  });

  it('новый снимок заменяет карту ссылок', async () => {
    const ctx = setup({ nodes: NODES });
    await ctx.dom.snapshotOf(contents, record, { tab: 't1' });
    ctx.nodes = [ax('1', 'RootWebArea', 'Settings', { childIds: ['9'] }), ax('9', 'button', 'Other', { parentId: '1', backendDOMNodeId: 99 })];
    const snap = await ctx.dom.snapshotOf(contents, record, { tab: 't1' });
    const ref = /\[ref=(e\d+)\] button "Other"/.exec(snap.text)?.[1] as string;
    expect(ctx.dom.nodeOf(contents, record, ref)).toBe(99);
  });

  it('nodeOf без снимка — stale_ref', () => {
    const ctx = setup();
    expect(() => ctx.dom.nodeOf(contents, record, 'e1')).toThrow(expect.objectContaining({ code: 'stale_ref' }));
  });

  it('centerOf: scrollIntoViewIfNeeded, центр content-квада getBoxModel; узел пропал — stale_ref', async () => {
    const ctx = setup({ box: { content: [100, 200, 300, 200, 300, 260, 100, 260] } });
    expect(await ctx.dom.centerOf(contents, 12)).toEqual({ x: 200, y: 230 });
    expect(ctx.send).toHaveBeenCalledWith(7, 'DOM.scrollIntoViewIfNeeded', { backendNodeId: 12 });
    ctx.boxFails = true;
    await expect(ctx.dom.centerOf(contents, 12)).rejects.toMatchObject({ code: 'stale_ref' });
  });

  it('boxOf: рамка content-квада; checkedOf: состояние из дерева', async () => {
    const ctx = setup({ nodes: NODES, box: { content: [100, 200, 300, 200, 300, 260, 100, 260] } });
    expect(await ctx.dom.boxOf(contents, 12)).toEqual({ x: 100, y: 200, width: 200, height: 60 });
    expect(await ctx.dom.checkedOf(contents, 15)).toBe(true);
    expect(await ctx.dom.checkedOf(contents, 12)).toBe(false);
    expect(await ctx.dom.checkedOf(contents, 404)).toBeNull();
  });

  it('waitFor: text — found, как только появился; gone — когда пропал; ms — waited; срок — timeout без ошибки', async () => {
    const ctx = setup({ nodes: [] });
    setTimeout(() => { ctx.nodes = NODES; }, 30);
    expect(await ctx.dom.waitFor(contents, record, { tab: 't1', text: 'Save' }, signal())).toMatchObject({ outcome: 'found' });
    setTimeout(() => { ctx.nodes = []; }, 30);
    expect(await ctx.dom.waitFor(contents, record, { tab: 't1', gone: 'Save' }, signal())).toMatchObject({ outcome: 'gone' });
    expect(await ctx.dom.waitFor(contents, record, { tab: 't1', ms: 20 }, signal())).toMatchObject({ outcome: 'waited' });
    ctx.waitLimit = 60;
    expect(await ctx.dom.waitFor(contents, record, { tab: 't1', text: 'Never' }, signal())).toMatchObject({ outcome: 'timeout' });
  });

  describe('фреймы того же процесса (спека 2026-11-18, раздел 4)', () => {
    const mainNodes = (frameBackendIds: number[]): AxNode[] => [
      ax('1', 'RootWebArea', 'Shop', { childIds: frameBackendIds.map((_, index) => String(index + 2)) }),
      ...frameBackendIds.map((backend, index) => ax(String(index + 2), 'Iframe', `Frame ${index + 1}`, { parentId: '1', backendDOMNodeId: backend })),
    ];
    const frameDoc = (button: string, backend: number): AxNode[] => [ax('1', 'RootWebArea', 'Doc', { childIds: ['2'] }), ax('2', 'button', button, { parentId: '1', backendDOMNodeId: backend })];

    it('два дочерних фрейма — две пары команд с их frameId; карта ссылок — общая, nodeOf отдаёт backendNodeId из фрейма', async () => {
      const ctx = setup({ nodes: mainNodes([101, 102]) });
      ctx.frameTree = { frame: { id: 'main' }, childFrames: [{ frame: { id: 'f1' } }, { frame: { id: 'f2' } }] };
      ctx.owners = new Map([['f1', 101], ['f2', 102]]);
      ctx.frameNodes = new Map([['f1', frameDoc('Pay', 201)], ['f2', frameDoc('Close', 202)]]);
      const snap = await ctx.dom.snapshotOf(contents, record, { tab: 't1' });
      for (const frameId of ['f1', 'f2']) {
        expect(ctx.send).toHaveBeenCalledWith(7, 'DOM.getFrameOwner', { frameId });
        expect(ctx.send).toHaveBeenCalledWith(7, 'Accessibility.getFullAXTree', { frameId });
      }
      const pay = /\[ref=(e\d+)\] button "Pay"/.exec(snap.text)?.[1] as string;
      expect(ctx.dom.nodeOf(contents, record, pay)).toBe(201);
      expect(snap.refs).toBe(4);
    });

    it('отказ DOM.getFrameOwner у одного фрейма — в карте один, у второго пометка «another site»', async () => {
      const ctx = setup({ nodes: mainNodes([101, 102]) });
      ctx.frameTree = { frame: { id: 'main' }, childFrames: [{ frame: { id: 'f1' } }, { frame: { id: 'f2' } }] };
      ctx.owners = new Map([['f1', 101]]);
      ctx.frameNodes = new Map([['f1', frameDoc('Pay', 201)], ['f2', frameDoc('Close', 202)]]);
      const snap = await ctx.dom.snapshotOf(contents, record, { tab: 't1' });
      expect(snap.text).toContain('button "Pay"');
      expect(snap.text).not.toContain('button "Close"');
      expect(snap.text).toContain('iframe "Frame 2" (content not available: another site)');
    });

    it('25 фреймов — запрошено 20; глубина 4 — четвёртый уровень не запрошен', async () => {
      const many = setup({ nodes: [] });
      many.frameTree = { frame: { id: 'main' }, childFrames: Array.from({ length: 25 }, (_, index) => ({ frame: { id: `f${index}` } })) };
      await many.dom.snapshotOf(contents, record, { tab: 't1' });
      expect(many.send.mock.calls.filter(([, method]) => method === 'DOM.getFrameOwner')).toHaveLength(AGENT_LIMITS.frames);
      const deep = setup({ nodes: [] });
      deep.frameTree = { frame: { id: 'main' }, childFrames: [{ frame: { id: 'l1' }, childFrames: [{ frame: { id: 'l2' }, childFrames: [{ frame: { id: 'l3' }, childFrames: [{ frame: { id: 'l4' } }] }] }] }] };
      await deep.dom.snapshotOf(contents, record, { tab: 't1' });
      const asked = deep.send.mock.calls.filter(([, method]) => method === 'DOM.getFrameOwner').map(([, , params]) => (params as { frameId: string }).frameId);
      expect(asked.sort()).toEqual(['l1', 'l2', 'l3']);
    });

    it('waitFor находит текст фрейма; checkedOf видит флажок фрейма', async () => {
      const ctx = setup({ nodes: mainNodes([101]) });
      ctx.frameTree = { frame: { id: 'main' }, childFrames: [{ frame: { id: 'f1' } }] };
      ctx.owners = new Map([['f1', 101]]);
      ctx.frameNodes = new Map([['f1', [ax('1', 'RootWebArea', 'Doc', { childIds: ['2'] }), ax('2', 'checkbox', 'Terms', { parentId: '1', backendDOMNodeId: 301, properties: [{ name: 'checked', value: { value: 'true' } }] })]]]);
      expect(await ctx.dom.waitFor(contents, record, { tab: 't1', text: 'Terms' }, signal())).toMatchObject({ outcome: 'found' });
      expect(await ctx.dom.checkedOf(contents, 301)).toBe(true);
    });
  });

  it('waitFor: обрыв по signal — причина обрыва, не ждёт срока', async () => {
    const ctx = setup({ nodes: [] });
    const control = new AbortController();
    const pending = ctx.dom.waitFor(contents, record, { tab: 't1', text: 'Never' }, control.signal);
    setTimeout(() => control.abort(new Error('stopped')), 10);
    await expect(pending).rejects.toThrow('stopped');
  });
});
