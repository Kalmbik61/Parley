// packages/desktop/src/main/browser/element-info.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { selectorTail } from '../../shared/css-selector.js';
import { ELEMENT_INFO_LIMITS, elementInfo, type CdpSender, nodeMatches, withTimeout } from './element-info.js';
import { REACT_INFO_FN } from './react-info.js';

/** Подставной инспектор: ответ по имени метода CDP; Error — отказ; нет ответа — пустой объект. */
function fakeInspector(answers: Record<string, unknown>) {
  const send = vi.fn(async (_id: number, method: string) => {
    const answer = answers[method];
    if (answer instanceof Error) throw answer;
    return answer ?? {};
  });
  return { inspector: { send } as unknown as CdpSender, send };
}

const methods = (send: ReturnType<typeof vi.fn>): unknown[] => send.mock.calls.map((call: unknown[]) => call[1]);

const ANSWERS = {
  'DOM.getNodeForLocation': { backendNodeId: 42 },
  'DOM.describeNode': { node: { localName: 'button', attributes: ['id', 'save', 'class', 'save primary'] } },
  'Accessibility.getPartialAXTree': { nodes: [{ backendDOMNodeId: 42, role: { value: 'button' }, name: { value: 'Save' } }] },
  'DOM.resolveNode': { object: { objectId: 'o1' } },
  'Runtime.callFunctionOn': { result: { value: [{ name: 'SaveButton', source: 'src/SaveButton.tsx:12', approx: false }] } },
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('elementInfo (спека браузера 3.8)', () => {
  it('по точке: роль, имя и React; точка округлена; объект страницы освобождён, доступность выключена', async () => {
    const { inspector, send } = fakeInspector(ANSWERS);
    expect(await elementInfo(inspector, 7, { x: 10.4, y: 20.6 }, 'main > button#save')).toEqual({
      role: 'button',
      name: 'Save',
      react: [{ name: 'SaveButton', source: 'src/SaveButton.tsx:12', approx: false }],
    });
    expect(send).toHaveBeenCalledWith(7, 'DOM.getNodeForLocation', { x: 10, y: 21, includeUserAgentShadowDOM: false });
    expect(send).toHaveBeenCalledWith(7, 'Runtime.callFunctionOn', { objectId: 'o1', functionDeclaration: REACT_INFO_FN, returnByValue: true });
    expect(send).toHaveBeenCalledWith(7, 'Runtime.releaseObject', { objectId: 'o1' });
    expect(methods(send)).toContain('Accessibility.disable');
  });

  it('узел под точкой не тот (тег или классы) — данных нет, React не спрашивается', async () => {
    const { inspector, send } = fakeInspector({ ...ANSWERS, 'DOM.describeNode': { node: { localName: 'span', attributes: [] } } });
    expect(await elementInfo(inspector, 7, { x: 1, y: 1 }, 'main > button.save')).toEqual({});
    expect(methods(send)).not.toContain('Runtime.callFunctionOn');
  });

  it('нет точки — ни одного вызова CDP', async () => {
    const { inspector, send } = fakeInspector(ANSWERS);
    expect(await elementInfo(inspector, 7, null, 'button')).toEqual({});
    expect(send).not.toHaveBeenCalled();
  });

  it('React не вышел — роль и имя есть, React нет, объект освобождён', async () => {
    const { inspector, send } = fakeInspector({ ...ANSWERS, 'Runtime.callFunctionOn': new Error('page busy') });
    expect(await elementInfo(inspector, 7, { x: 1, y: 1 }, 'main > button#save')).toEqual({ role: 'button', name: 'Save' });
    expect(methods(send)).toContain('Runtime.releaseObject');
  });

  it('ответ React не той формы — React нет; длинная роль режется до 100', async () => {
    const { inspector } = fakeInspector({
      ...ANSWERS,
      'Accessibility.getPartialAXTree': { nodes: [{ backendDOMNodeId: 42, role: { value: 'r'.repeat(200) } }] },
      'Runtime.callFunctionOn': { result: { value: 'nope' } },
    });
    expect(await elementInfo(inspector, 7, { x: 1, y: 1 }, 'main > button#save')).toEqual({ role: 'r'.repeat(100) });
  });

  it('имя в дереве доступности в десятки мегабайт (aria-label задаёт страница) режется до 500 за время, не зависящее от длины', async () => {
    const { inspector } = fakeInspector({
      ...ANSWERS,
      'Accessibility.getPartialAXTree': { nodes: [{ backendDOMNodeId: 42, role: { value: 'button' }, name: { value: 'n'.repeat(50_000_000) } }] },
    });
    const started = performance.now();
    const info = await elementInfo(inspector, 7, { x: 1, y: 1 }, 'main > button#save');
    const elapsed = performance.now() - started;
    expect(info).toMatchObject({ role: 'button', name: 'n'.repeat(ELEMENT_INFO_LIMITS.name) });
    // Порог по времени, а не таймаут теста: прежний `Array.from` по имени — секунда с лишним и сотни МБ кучи в main.
    expect(elapsed).toBeLessThan(300);
  });

  it('CDP отказал с первого вызова — пусто, без исключения', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { inspector } = fakeInspector({ 'DOM.enable': new Error('not attached') });
    expect(await elementInfo(inspector, 7, { x: 1, y: 1 }, 'button')).toEqual({});
  });
});

describe('withTimeout', () => {
  it('не уложился — запасное значение; отказ — тоже; успел — ответ', async () => {
    vi.useFakeTimers();
    const slow = withTimeout(new Promise<string>(() => undefined), 2000, 'fallback');
    await vi.advanceTimersByTimeAsync(2000);
    await expect(slow).resolves.toBe('fallback');
    vi.useRealTimers();
    await expect(withTimeout(Promise.reject(new Error('x')), 10, 'fallback')).resolves.toBe('fallback');
    await expect(withTimeout(Promise.resolve('ok'), 10, 'fallback')).resolves.toBe('ok');
  });
});

describe('звено селектора guest-dom (id и классы через CSS.escape) доходит до сверки узла', () => {
  it('nodeMatches: id из useId (`:r0:`) и id с первой цифрой (`123`) сверяются со значением атрибута, а не с экранированным видом', () => {
    // guest-dom пишет id через CSS.escape: `:r0:` → `\:r0\:`, `123` → `\31 23`. Узел CDP отдаёт сырое значение атрибута.
    const input = { localName: 'input', attributes: ['type', 'text', 'id', ':r0:'] };
    expect(nodeMatches(input, selectorTail('form > input#\\:r0\\:'))).toBe(true);
    expect(nodeMatches({ localName: 'input', attributes: ['id', ':r1:'] }, selectorTail('form > input#\\:r0\\:'))).toBe(false);
    expect(nodeMatches({ localName: 'div', attributes: ['id', '123'] }, selectorTail('div#\\31 23'))).toBe(true);
    expect(nodeMatches({ localName: 'div', attributes: ['id', '12'] }, selectorTail('div#\\31 23'))).toBe(false);
  });

  it('nodeMatches: классы Tailwind (`md:flex`, `py-1.5`) — в атрибуте class среди других', () => {
    const tail = selectorTail('div.md\\:flex.py-1\\.5');
    expect(nodeMatches({ localName: 'div', attributes: ['class', 'md:flex py-1.5 plain'] }, tail)).toBe(true);
    expect(nodeMatches({ localName: 'div', attributes: ['class', 'md:flex plain'] }, tail)).toBe(false);
  });

  it('nodeMatches: классы делятся по пробелам HTML, как у guest-dom, — неразрывный пробел внутри имени класса его не рвёт', () => {
    // В HTML имена в class разделяют только пробел, табуляция, перевод строки и страницы, возврат каретки; guest-dom делит
    // так же, а CSS.escape неразрывный пробел (U+00A0) не экранирует. Узел `class="a\u00a0b c"` — два класса, а не три.
    const tail = selectorTail('div.a\u00a0b');
    expect(nodeMatches({ localName: 'div', attributes: ['class', 'a\u00a0b c'] }, tail)).toBe(true);
    expect(nodeMatches({ localName: 'div', attributes: ['class', 'a b'] }, tail)).toBe(false);
  });

  it('elementInfo: селектор с экранированным id находит узел — роль и имя на месте, React спрошен', async () => {
    for (const [selector, localName, id] of [
      ['form > input#\\:r0\\:', 'input', ':r0:'],
      ['section > div#\\31 23', 'div', '123'],
    ] as const) {
      const { inspector, send } = fakeInspector({ ...ANSWERS, 'DOM.describeNode': { node: { localName, attributes: ['id', id] } } });
      expect(await elementInfo(inspector, 7, { x: 1, y: 1 }, selector), selector).toMatchObject({ role: 'button', name: 'Save' });
      expect(methods(send), selector).toContain('Runtime.callFunctionOn');
    }
  });
});

describe('elementInfo: сверка тега и выбор узла дерева доступности', () => {
  it('тот же id и классы, но другой тег — данных нет: сверка по тегу не зависит от остальных частей звена', async () => {
    const { inspector, send } = fakeInspector({ ...ANSWERS, 'DOM.describeNode': { node: { localName: 'span', attributes: ['id', 'save', 'class', 'save primary'] } } });
    expect(await elementInfo(inspector, 7, { x: 1, y: 1 }, 'main > button#save')).toEqual({});
    expect(await elementInfo(inspector, 7, { x: 1, y: 1 }, 'main > button.save.primary')).toEqual({});
    expect(methods(send)).not.toContain('Runtime.callFunctionOn');
  });

  it('дерево доступности: берётся узел выбранного (backendDOMNodeId), а не первый в ответе', async () => {
    const wrapper = { backendDOMNodeId: 1, role: { value: 'generic' }, name: { value: 'Wrapper' } };
    const target = ANSWERS['Accessibility.getPartialAXTree'].nodes[0];
    const { inspector } = fakeInspector({ ...ANSWERS, 'Accessibility.getPartialAXTree': { nodes: [wrapper, target] } });
    expect(await elementInfo(inspector, 7, { x: 1, y: 1 }, 'main > button#save')).toMatchObject({ role: 'button', name: 'Save' });
  });

  it('узел дерева доступности скрыт (ignored) — ни роли, ни имени, React при этом есть', async () => {
    const { inspector } = fakeInspector({
      ...ANSWERS,
      'Accessibility.getPartialAXTree': { nodes: [{ backendDOMNodeId: 42, ignored: true, role: { value: 'none' }, name: { value: 'hidden' } }] },
    });
    expect(await elementInfo(inspector, 7, { x: 1, y: 1 }, 'main > button#save')).toEqual({
      react: [{ name: 'SaveButton', source: 'src/SaveButton.tsx:12', approx: false }],
    });
  });
});
